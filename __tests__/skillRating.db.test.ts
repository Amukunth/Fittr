/**
 * Per-exercise MMR against a real Postgres: the Elo arithmetic, the K
 * schedule, the group-battle decomposition, and the MMR pairing rule that
 * replaced strength_tier in the queue.
 *
 * The arithmetic assertions are written against hand-computed expectations
 * (shown in each test), not against whatever the function happens to
 * return, so a change in the formula fails here rather than silently
 * re-baselining.
 *
 * What this cannot prove: that a real bout, fought on two phones and
 * settled through PostgREST, moves these numbers. See BACKEND.md.
 */
import {
  createRatedUser,
  createUser,
  ratingOf,
  rpcAsUser,
  rpcRow,
  setRating,
  startTestDb,
  type TestDb,
} from '../test/dbHarness';
import {
  K_PLACEMENT,
  K_SETTLED,
  MMR_SEED,
  PLACEMENT_BOUTS,
  rankTierOf,
} from '../src/lib/skillRating';
import {
  MMR_WINDOW,
  MMR_WINDOW_WIDE,
  RANK_WIDEN_AFTER_SECONDS,
} from '../src/lib/matchmaking';
import type { MatchmakingQueueRow } from '../src/types/database';

let db: TestDb;

beforeAll(async () => {
  db = await startTestDb();
}, 120000);

afterAll(async () => {
  await db.stop();
});

afterEach(async () => {
  await db.pool.query('DELETE FROM matchmaking_queue');
  await db.pool.query(
    "DELETE FROM challenges c WHERE c.status = 'open' AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.challenge_id = c.id)",
  );
});

// ── helpers ─────────────────────────────────────────────────────────────

type Exercise = 'pushups' | 'plank' | 'wallsit';

function enter(
  user: string,
  r: { exercise?: Exercise; format?: '1v1' | 'pooled'; stake?: number; seats?: number } = {},
) {
  const format = r.format ?? '1v1';
  return rpcRow<MatchmakingQueueRow>(
    db,
    user,
    'SELECT * FROM enter_matchmaking($1, $2, $3, $4)',
    [r.exercise ?? 'pushups', format, r.stake ?? 100, r.seats ?? (format === '1v1' ? 2 : 4)],
  );
}

function beat(user: string, queueId: string) {
  return rpcRow<MatchmakingQueueRow>(db, user, 'SELECT * FROM matchmaking_heartbeat($1)', [queueId]);
}

function leave(user: string, queueId: string) {
  return rpcRow<MatchmakingQueueRow>(db, user, 'SELECT * FROM leave_matchmaking($1)', [queueId]);
}

async function ageLobby(challengeId: string, seconds: number) {
  await db.pool.query(
    'UPDATE challenges SET created_at = created_at - make_interval(secs => $2) WHERE id = $1',
    [challengeId, seconds],
  );
  await db.pool.query(
    'UPDATE matchmaking_queue SET joined_at = joined_at - make_interval(secs => $2) WHERE challenge_id = $1',
    [challengeId, seconds],
  );
}

async function submit(
  user: string,
  matchId: string,
  opts: { reps?: number; hold?: number; anomaly?: boolean },
) {
  const { rows } = await db.pool.query<{ id: string }>(
    'SELECT id FROM match_participants WHERE match_id = $1 AND user_id = $2',
    [matchId, user],
  );
  return rpcAsUser<string>(
    db,
    user,
    'SELECT submit_verification_session($1, $2, $3::jsonb, $4, $5)',
    [rows[0]!.id, opts.reps ?? null, JSON.stringify({ test: true }), opts.anomaly ?? false, opts.hold ?? null],
  );
}

async function participantsOf(matchId: string): Promise<string[]> {
  const { rows } = await db.pool.query<{ user_id: string }>(
    'SELECT user_id FROM match_participants WHERE match_id = $1 ORDER BY user_id',
    [matchId],
  );
  return rows.map(r => r.user_id);
}

interface RatingEvent {
  mmr_before: number;
  mmr_after: number;
  delta: number;
  k_factor: number;
  was_placement: boolean;
  matches_played: number;
  participants: number;
}

async function eventFor(user: string, matchId: string): Promise<RatingEvent | null> {
  const { rows } = await db.pool.query<RatingEvent>(
    `SELECT mmr_before, mmr_after, delta, k_factor, was_placement, matches_played, participants
       FROM skill_rating_events WHERE user_id = $1 AND match_id = $2`,
    [user, matchId],
  );
  return rows[0] ?? null;
}

async function eventCount(matchId: string): Promise<number> {
  const { rows } = await db.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM skill_rating_events WHERE match_id = $1',
    [matchId],
  );
  return rows[0]!.n;
}

/**
 * A filled bout at exactly these ratings, staged the way _mm_try_complete()
 * stages one: a matched challenge, a match, participant rows, and the
 * stakes debited with their ledger entries.
 *
 * Deliberately NOT built through enter_matchmaking(). The rating arithmetic
 * has to be testable at spreads the queue would never pair (that is the
 * whole point of the pairing window), and a test of the Elo maths should
 * not fail because the matchmaker's opinion of a fair fight changed. The
 * queue path is covered by the pairing tests below, and end to end by the
 * K-schedule test, which fights every one of its bouts through the queue.
 *
 * `null` means no rating row at all -- an untouched fighter whom settlement
 * has to seed itself.
 */
async function stage(
  ratings: Array<number | null>,
  exercise: Exercise = 'pushups',
  stake = 100,
): Promise<{ members: string[]; matchId: string }> {
  const seats = ratings.length;
  const members: string[] = [];
  for (const m of ratings) {
    members.push(
      m === null ? await createUser(db, {}) : await createRatedUser(db, exercise, m),
    );
  }

  const { rows: challengeRows } = await db.pool.query<{ id: string }>(
    `INSERT INTO challenges (type, format, stake_points, max_participants, status, created_by)
     VALUES ($1, $2, $3, $4, 'matched', $5) RETURNING id`,
    [exercise, seats === 2 ? '1v1' : 'pooled', stake, seats, members[0]],
  );
  const { rows: matchRows } = await db.pool.query<{ id: string }>(
    'INSERT INTO matches (challenge_id) VALUES ($1) RETURNING id',
    [challengeRows[0]!.id],
  );
  const matchId = matchRows[0]!.id;

  await db.pool.query(
    'INSERT INTO match_participants (match_id, user_id) SELECT $1, u FROM unnest($2::uuid[]) AS u',
    [matchId, members],
  );
  await db.pool.query(
    'UPDATE fitness_profiles SET points_balance = points_balance - $2::int WHERE user_id = ANY($1)',
    [members, stake],
  );
  await db.pool.query(
    `INSERT INTO points_ledger_entries (user_id, amount, reason, match_id)
     SELECT u, -($2::int), 'stake', $3 FROM unnest($1::uuid[]) AS u`,
    [members, stake, matchId],
  );

  return { members, matchId };
}

/** Two staged fighters. Shorthand for the 1v1 cases. */
async function duel(
  aMmr: number | null,
  bMmr: number | null,
  exercise: Exercise = 'pushups',
): Promise<{ a: string; b: string; matchId: string }> {
  const { members, matchId } = await stage([aMmr, bMmr], exercise);
  return { a: members[0]!, b: members[1]!, matchId };
}

// ── the tier bands ──────────────────────────────────────────────────────

describe('rank_tier_for', () => {
  it('bands six tiers every 200 points from 900, with open ends', async () => {
    const probes = [
      [0, 'commoner'],
      [899, 'commoner'],
      [900, 'squire'],
      [1000, 'squire'],
      [1099, 'squire'],
      [1100, 'knight'],
      [1299, 'knight'],
      [1300, 'hero'],
      [1499, 'hero'],
      [1500, 'sovereign'],
      [1699, 'sovereign'],
      [1700, 'ultimate_champion'],
      [9000, 'ultimate_champion'],
    ] as const;
    for (const [mmr, tier] of probes) {
      const { rows } = await db.pool.query<{ t: string }>('SELECT rank_tier_for($1) AS t', [mmr]);
      expect([mmr, rows[0]!.t]).toEqual([mmr, tier]);
    }
  });

  it('agrees with the band table mirrored in src/lib/skillRating.ts', async () => {
    // The client derives a tier from an MMR in exactly one place: a
    // skill_rating_events row, which carries the number but not the band.
    // This is the check that keeps that mirror honest.
    for (let mmr = 0; mmr <= 2200; mmr += 25) {
      const { rows } = await db.pool.query<{ t: string }>('SELECT rank_tier_for($1) AS t', [mmr]);
      expect([mmr, rankTierOf(mmr)]).toEqual([mmr, rows[0]!.t]);
    }
  });

  it('matches the K, seed and placement constants the client mirrors', async () => {
    const { rows } = await db.pool.query<{
      seed: number; bouts: number; kp: number; ks: number;
    }>('SELECT _mmr_seed() AS seed, _mmr_placement_bouts() AS bouts, _mmr_k_placement() AS kp, _mmr_k_settled() AS ks');
    expect(rows[0]).toEqual({
      seed: MMR_SEED, bouts: PLACEMENT_BOUTS, kp: K_PLACEMENT, ks: K_SETTLED,
    });
  });

  it('matches the matchmaking windows the client mirrors', async () => {
    const { rows } = await db.pool.query<{ w: number; wide: number; secs: number }>(
      "SELECT _mm_mmr_window() AS w, _mm_mmr_window_wide() AS wide, extract(epoch FROM _mm_mmr_widen_after())::int AS secs",
    );
    expect(rows[0]).toEqual({
      w: MMR_WINDOW, wide: MMR_WINDOW_WIDE, secs: RANK_WIDEN_AFTER_SECONDS,
    });
  });

  it('puts the seed in the middle of Squire, so Commoner is reachable', async () => {
    const { rows } = await db.pool.query<{ seed: number; t: string }>(
      'SELECT _mmr_seed() AS seed, rank_tier_for(_mmr_seed()) AS t',
    );
    expect(rows[0]).toEqual({ seed: 1000, t: 'squire' });
  });
});

// ── seeding and placement ───────────────────────────────────────────────

describe('skill_ratings rows', () => {
  it('is created at the seed, unplaced, the first time a fighter queues an exercise', async () => {
    const u = await createUser(db, {});
    expect(await ratingOf(db, u, 'pushups')).toBeNull();

    const row = await enter(u, { exercise: 'pushups' });
    expect(await ratingOf(db, u, 'pushups')).toEqual({
      mmr: 1000,
      matches_played: 0,
      placement_complete: false,
    });
    // ...and the queue row carries the snapshot the pairing rule reads.
    expect(row.mmr).toBe(1000);
    expect(row.placement_complete).toBe(false);
    // Queueing pushups says nothing about plank.
    expect(await ratingOf(db, u, 'plank')).toBeNull();
    await leave(u, row.id);
  });

  it('is per exercise type, not per user', async () => {
    const u = await createUser(db, {});
    const a = await enter(u, { exercise: 'pushups' });
    await leave(u, a.id);
    await db.pool.query('UPDATE matchmaking_queue SET joined_at = joined_at - interval \'10 seconds\' WHERE user_id = $1', [u]);
    const b = await enter(u, { exercise: 'plank' });
    await leave(u, b.id);
    const { rows } = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM skill_ratings WHERE user_id = $1',
      [u],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it('keeps placement_complete pinned to matches_played, whatever writes the row', async () => {
    const u = await createUser(db, {});
    await setRating(db, u, 'pushups', 1200, 4);
    expect((await ratingOf(db, u, 'pushups'))!.placement_complete).toBe(false);
    await setRating(db, u, 'pushups', 1200, 5);
    expect((await ratingOf(db, u, 'pushups'))!.placement_complete).toBe(true);
    // Even a write that tries to lie about it.
    await db.pool.query(
      'UPDATE skill_ratings SET placement_complete = false WHERE user_id = $1',
      [u],
    );
    expect((await ratingOf(db, u, 'pushups'))!.placement_complete).toBe(true);
  });
});

// ── the Elo arithmetic ──────────────────────────────────────────────────

describe('1v1 rating', () => {
  it('moves two equal placed fighters by exactly K/2', async () => {
    // E = 0.5 for both. K = 32 (placed). Winner +32*(1-0.5) = +16.
    const { a, b, matchId } = await duel(1200, 1200);
    await submit(a, matchId, { reps: 40 });
    await submit(b, matchId, { reps: 30 });

    expect((await ratingOf(db, a, 'pushups'))!.mmr).toBe(1216);
    expect((await ratingOf(db, b, 'pushups'))!.mmr).toBe(1184);
    expect(await eventFor(a, matchId)).toMatchObject({
      mmr_before: 1200, mmr_after: 1216, delta: 16, k_factor: 32,
      was_placement: false, matches_played: 6, participants: 2,
    });
    expect(await eventFor(b, matchId)).toMatchObject({ delta: -16, k_factor: 32 });
  });

  it('pays an underdog more than a favourite for the same win', async () => {
    // 1100 vs 1300. E(underdog) = 1/(1+10^(200/400)) = 0.2402...
    // K=32 -> +32*(1-0.2402) = +24.31 -> +24, and -24 for the favourite.
    const { a, b, matchId } = await duel(1100, 1300);
    await submit(a, matchId, { reps: 50 });
    await submit(b, matchId, { reps: 20 });
    expect((await eventFor(a, matchId))!.delta).toBe(24);
    expect((await eventFor(b, matchId))!.delta).toBe(-24);

    // ...and the favourite winning the same matchup barely moves.
    // E(favourite) = 0.7597 -> +32*(1-0.7597) = +7.69 -> +8.
    const second = await duel(1100, 1300);
    await submit(second.a, second.matchId, { reps: 20 });
    await submit(second.b, second.matchId, { reps: 50 });
    expect((await eventFor(second.b, second.matchId))!.delta).toBe(8);
    expect((await eventFor(second.a, second.matchId))!.delta).toBe(-8);
  });

  it('splits a tie down the middle between equals and pays the underdog for one', async () => {
    // Equal ratings, S = 0.5, E = 0.5 -> zero movement, but the bout counts.
    const level = await duel(1200, 1200);
    await submit(level.a, level.matchId, { reps: 33 });
    await submit(level.b, level.matchId, { reps: 33 });
    expect((await eventFor(level.a, level.matchId))!.delta).toBe(0);
    expect((await eventFor(level.b, level.matchId))!.delta).toBe(0);
    expect((await ratingOf(db, level.a, 'pushups'))!.matches_played).toBe(6);

    // A draw against a stronger fighter is a gain. E = 0.2402,
    // 32*(0.5-0.2402) = +8.31 -> +8.
    const upset = await duel(1100, 1300);
    await submit(upset.a, upset.matchId, { reps: 33 });
    await submit(upset.b, upset.matchId, { reps: 33 });
    expect((await eventFor(upset.a, upset.matchId))!.delta).toBe(8);
    expect((await eventFor(upset.b, upset.matchId))!.delta).toBe(-8);
  });

  it('rates a hold exercise off hold_duration_seconds', async () => {
    const { a, b, matchId } = await duel(1200, 1200, 'plank');
    await submit(a, matchId, { hold: 95 });
    await submit(b, matchId, { hold: 140 });
    expect((await eventFor(b, matchId))!.delta).toBe(16);
    expect((await eventFor(a, matchId))!.delta).toBe(-16);
    // ...and it is the plank rating that moved, not a shared one.
    expect(await ratingOf(db, a, 'pushups')).toBeNull();
  });
});

// ── K schedule ──────────────────────────────────────────────────────────

describe('the K schedule', () => {
  it('uses K=100 for the first five bouts in an exercise and K=32 after', async () => {
    const seen: Array<{ k: number; placement: boolean; played: number }> = [];
    const me = await createUser(db, {});

    for (let i = 0; i < 6; i += 1) {
      // A fresh, equally rated opponent each time, so E is always 0.5 and
      // the only thing moving the delta is my own K.
      const mine = (await ratingOf(db, me, 'pushups'))?.mmr ?? 1000;
      const foe = await createRatedUser(db, 'pushups', mine);
      await enter(me, { exercise: 'pushups' });
      const row = await enter(foe, { exercise: 'pushups' });
      expect(row.status).toBe('matched');
      await submit(me, row.match_id!, { reps: 50 });
      await submit(foe, row.match_id!, { reps: 10 });
      const ev = (await eventFor(me, row.match_id!))!;
      seen.push({ k: ev.k_factor, placement: ev.was_placement, played: ev.matches_played });
      await db.pool.query('DELETE FROM matchmaking_queue');
    }

    expect(seen.map(s => s.k)).toEqual([100, 100, 100, 100, 100, 32]);
    // The fifth bout is still a placement bout; the sixth is the first rated
    // one. was_placement describes the state the bout STARTED in.
    expect(seen.map(s => s.placement)).toEqual([true, true, true, true, true, false]);
    expect(seen.map(s => s.played)).toEqual([1, 2, 3, 4, 5, 6]);

    // Five wins at K=100 against an equal each time: +50 a bout.
    expect((await ratingOf(db, me, 'pushups'))!.mmr).toBe(1000 + 50 * 5 + 16);
    expect((await ratingOf(db, me, 'pushups'))!.placement_complete).toBe(true);
  });

  it('lets one fighter place at K=100 while their opponent moves at K=32', async () => {
    // The asymmetry is the point: MMR is not zero-sum across a bout.
    const rookie = await createUser(db, {});
    const veteran = await createRatedUser(db, 'pushups', 1000);
    await enter(rookie, { exercise: 'pushups' });
    const row = await enter(veteran, { exercise: 'pushups' });
    await submit(rookie, row.match_id!, { reps: 60 });
    await submit(veteran, row.match_id!, { reps: 20 });

    expect((await eventFor(rookie, row.match_id!))!).toMatchObject({
      k_factor: 100, delta: 50, was_placement: true,
    });
    expect((await eventFor(veteran, row.match_id!))!).toMatchObject({
      k_factor: 32, delta: -16, was_placement: false,
    });
  });
});

// ── group battles ───────────────────────────────────────────────────────

describe('group battles', () => {
  it('divides the pairwise total by (N-1) so a group does not swing harder than a 1v1', async () => {
    // Four equal placed fighters, clean ranking 1-2-3-4. Against three
    // opponents at E = 0.5 each, K = 32:
    //   1st: 32*(1+1+1 - 1.5)/3 = +16
    //   2nd: 32*(1+1+0 - 1.5)/3 = +5.33 -> +5
    //   3rd: 32*(1+0+0 - 1.5)/3 = -5.33 -> -5
    //   4th: 32*(0+0+0 - 1.5)/3 = -16
    const { members, matchId } = await stage([1200, 1200, 1200, 1200]);
    const reps = [40, 30, 20, 10];
    for (let i = 0; i < members.length; i += 1) {
      await submit(members[i]!, matchId, { reps: reps[i] });
    }
    const deltas = [];
    for (const m of members) {
      deltas.push((await eventFor(m, matchId))!.delta);
    }
    expect(deltas).toEqual([16, 5, -5, -16]);

    // The top and bottom of a four-way move exactly as far as a 1v1 winner
    // and loser do -- that is what the divisor buys.
    expect(Math.max(...deltas)).toBe(16);
    expect(Math.min(...deltas)).toBe(-16);
  });

  it('scores every pairwise comparison, not just first place', async () => {
    // Second of four still beat two people: they gain. Third still lost to
    // two: they drop. Neither is treated as a plain "not the winner".
    const { members, matchId } = await stage([1200, 1200, 1200, 1200]);
    const reps = [40, 30, 20, 10];
    for (let i = 0; i < members.length; i += 1) {
      await submit(members[i]!, matchId, { reps: reps[i] });
    }
    expect((await eventFor(members[1]!, matchId))!.delta).toBeGreaterThan(0);
    expect((await eventFor(members[2]!, matchId))!.delta).toBeLessThan(0);
  });

  it('handles a tie inside the field as half a win against each other', async () => {
    // Three equal fighters; the top two tie. For a tied fighter:
    //   32*(0.5 + 1 - 1.0)/2 = +8. For the last: 32*(0 + 0 - 1.0)/2 = -16.
    const { members, matchId } = await stage([1200, 1200, 1200], 'wallsit');
    await submit(members[0]!, matchId, { hold: 90 });
    await submit(members[1]!, matchId, { hold: 90 });
    await submit(members[2]!, matchId, { hold: 40 });
    expect((await eventFor(members[0]!, matchId))!.delta).toBe(8);
    expect((await eventFor(members[1]!, matchId))!.delta).toBe(8);
    expect((await eventFor(members[2]!, matchId))!.delta).toBe(-16);
  });

  it('does not depend on the order pairs are visited: every E uses pre-bout ratings', async () => {
    // Mixed ratings, so a sequentially-updating implementation would give a
    // different answer than a batch one. Expectations computed against the
    // starting ratings only.
    //   A=1000, B=1200, C=1400, final order A > B > C.
    //   E(A|B)=0.2402 E(A|C)=0.0909 -> A: 32*(2 - 0.3311)/2 = +26.70 -> +27
    //   E(B|A)=0.7597 E(B|C)=0.2402 -> B: 32*(1 - 0.9999)/2 = +0.0009 -> +0
    //   E(C|A)=0.9091 E(C|B)=0.7597 -> C: 32*(0 - 1.6688)/2 = -26.70 -> -27
    const { members, matchId } = await stage([1000, 1200, 1400]);
    await submit(members[0]!, matchId, { reps: 50 });
    await submit(members[1]!, matchId, { reps: 40 });
    await submit(members[2]!, matchId, { reps: 30 });
    expect((await eventFor(members[0]!, matchId))!.delta).toBe(27);
    expect((await eventFor(members[1]!, matchId))!.delta).toBe(0);
    expect((await eventFor(members[2]!, matchId))!.delta).toBe(-27);
    expect((await eventFor(members[0]!, matchId))!.participants).toBe(3);
  });

  it('rates all six seats of a full Group Battle exactly once', async () => {
    const { members, matchId } = await stage([null, null, null, null, null, null], 'plank');
    for (let i = 0; i < members.length; i += 1) {
      await submit(members[i]!, matchId, { hold: 100 - i * 10 });
    }
    expect(await eventCount(matchId)).toBe(6);
    for (const m of members) {
      expect((await ratingOf(db, m, 'plank'))!.matches_played).toBe(1);
    }
  });
});

// ── settlement integration ──────────────────────────────────────────────

describe('rating inside settlement', () => {
  it('rates exactly once however many times settlement is called', async () => {
    const { a, b, matchId } = await duel(1200, 1200);
    await submit(a, matchId, { reps: 40 });
    await submit(b, matchId, { reps: 30 });
    // submit_verification_session already settled inline; these are the
    // Results screen's safety-net calls.
    expect(await rpcAsUser<string>(db, a, 'SELECT settle_match($1)', [matchId])).toBe('already_settled');
    expect(await rpcAsUser<string>(db, b, 'SELECT settle_match($1)', [matchId])).toBe('already_settled');
    expect(await eventCount(matchId)).toBe(2);
    expect((await ratingOf(db, a, 'pushups'))!.mmr).toBe(1216);
    expect((await ratingOf(db, a, 'pushups'))!.matches_played).toBe(1 + 5);
  });

  it('rates nothing while a flagged bout is held for review, and rates when it clears', async () => {
    const { a, b, matchId } = await duel(1200, 1200);
    await submit(a, matchId, { reps: 40, anomaly: true });
    await submit(b, matchId, { reps: 30 });

    const { rows } = await db.pool.query<{ status: string }>(
      'SELECT c.status FROM challenges c JOIN matches m ON m.challenge_id = c.id WHERE m.id = $1',
      [matchId],
    );
    expect(rows[0]!.status).toBe('needs_review');
    expect(await eventCount(matchId)).toBe(0);
    expect((await ratingOf(db, a, 'pushups'))!.mmr).toBe(1200);
    expect((await ratingOf(db, a, 'pushups'))!.matches_played).toBe(5);

    // A reviewer clears the flag; the next settle pays and rates together.
    await db.pool.query(
      `UPDATE verification_sessions SET reviewed = true
        WHERE match_participant_id IN (SELECT id FROM match_participants WHERE match_id = $1)`,
      [matchId],
    );
    expect(await rpcAsUser<string>(db, a, 'SELECT settle_match($1)', [matchId])).toBe('settled');
    expect(await eventCount(matchId)).toBe(2);
    expect((await ratingOf(db, a, 'pushups'))!.mmr).toBe(1216);
  });

  it('rates a bout that settles as a tie, and one that settles as a split', async () => {
    const tie = await duel(1200, 1200);
    await submit(tie.a, tie.matchId, { reps: 25 });
    await submit(tie.b, tie.matchId, { reps: 25 });
    expect(await eventCount(tie.matchId)).toBe(2);

    // Two of three tie for best: tie_split. Everyone is still rated.
    const split = await stage([1200, 1200, 1200]);
    await submit(split.members[0]!, split.matchId, { reps: 40 });
    await submit(split.members[1]!, split.matchId, { reps: 40 });
    await submit(split.members[2]!, split.matchId, { reps: 10 });
    expect(await eventCount(split.matchId)).toBe(3);
  });

  it('leaves the points arithmetic exactly as it was', async () => {
    // MMR is bolted onto settlement; it must not have changed a single
    // point of the payout.
    const { a, b, matchId } = await duel(1200, 1200);
    await submit(a, matchId, { reps: 40 });
    await submit(b, matchId, { reps: 30 });
    const { rows } = await db.pool.query<{ user_id: string; points_balance: number }>(
      'SELECT user_id, points_balance FROM fitness_profiles WHERE user_id = ANY($1) ORDER BY user_id',
      [[a, b].sort()],
    );
    const byUser = new Map(rows.map(r => [r.user_id, r.points_balance]));
    expect(byUser.get(a)).toBe(600); // 500 - 100 stake + 200 pot
    expect(byUser.get(b)).toBe(400);
  });

  it('rates a fighter whose very first bout is this one, from the seed', async () => {
    // Nobody queued to create the row -- _mmr_rate_match seeds it itself.
    const { a, b, matchId } = await duel(null, null);
    await db.pool.query('DELETE FROM skill_ratings WHERE user_id = ANY($1)', [[a, b]]);
    await submit(a, matchId, { reps: 40 });
    await submit(b, matchId, { reps: 30 });
    expect((await eventFor(a, matchId))!.mmr_before).toBe(1000);
    expect((await ratingOf(db, a, 'pushups'))!.mmr).toBe(1050);
  });

  it('never lets a rating fall below the floor, and records the clamped delta', async () => {
    const { a, b, matchId } = await duel(100, 100);
    await submit(a, matchId, { reps: 40 });
    await submit(b, matchId, { reps: 10 });
    const loser = (await eventFor(b, matchId))!;
    expect(loser.mmr_after).toBe(100);
    expect(loser.delta).toBe(0);
    expect(loser.mmr_after - loser.mmr_before).toBe(loser.delta);
  });
});

// ── matchmaking on MMR ──────────────────────────────────────────────────

describe('pairing on MMR', () => {
  it('pairs two placed fighters inside the 150-point window', async () => {
    const a = await createRatedUser(db, 'pushups', 1200);
    const b = await createRatedUser(db, 'pushups', 1340);
    await enter(a, { exercise: 'pushups', stake: 250 });
    const row = await enter(b, { exercise: 'pushups', stake: 250 });
    expect(row.status).toBe('matched');
  });

  it('keeps two placed fighters outside the window in separate lobbies', async () => {
    const a = await createRatedUser(db, 'pushups', 1000);
    const b = await createRatedUser(db, 'pushups', 1400);
    const first = await enter(a, { exercise: 'pushups', stake: 250 });
    const second = await enter(b, { exercise: 'pushups', stake: 250 });
    expect(second.status).toBe('searching');
    expect(second.challenge_id).not.toBe(first.challenge_id);
  });

  it('ignores rating entirely while either side is still placing', async () => {
    // A Commoner-range rookie and an Ultimate Champion, 900 apart: they
    // would never meet if both were placed, and must meet while one is not.
    const rookie = await createUser(db, {});
    const champion = await createRatedUser(db, 'pushups', 1800);
    await enter(champion, { exercise: 'pushups', stake: 50 });
    const row = await enter(rookie, { exercise: 'pushups', stake: 50 });
    expect(row.status).toBe('matched');
    expect(await participantsOf(row.match_id!)).toEqual([rookie, champion].sort());
  });

  it('still separates lobbies by exercise, stake and seats, whatever the ratings', async () => {
    // Rating proximity is the only thing that changed; the domain and the
    // stake are still exact matches.
    const a = await createRatedUser(db, 'pushups', 1200);
    const b = await createRatedUser(db, 'pushups', 1200);
    const c = await createRatedUser(db, 'plank', 1200);
    const d = await createRatedUser(db, 'pushups', 1200);
    const base = await enter(a, { exercise: 'pushups', stake: 100 });
    const otherStake = await enter(b, { exercise: 'pushups', stake: 250 });
    const otherExercise = await enter(c, { exercise: 'plank', stake: 100 });
    const otherSize = await enter(d, { exercise: 'pushups', stake: 100, format: 'pooled', seats: 4 });
    for (const row of [base, otherStake, otherExercise, otherSize]) {
      expect(row.status).toBe('searching');
    }
    expect(new Set([base, otherStake, otherExercise, otherSize].map(r => r.challenge_id)).size).toBe(4);
  });

  it('checks the arriving fighter against every member of a group lobby, not just one', async () => {
    // 1150 and 1300 are both within 150 of 1250 -- but not of each other.
    // A lobby-wide average would admit the third; the pairwise rule must not.
    const anchor = await createRatedUser(db, 'wallsit', 1250);
    const low = await createRatedUser(db, 'wallsit', 1150);
    const high = await createRatedUser(db, 'wallsit', 1320);
    const lobby = await enter(anchor, { exercise: 'wallsit', format: 'pooled', seats: 4, stake: 500 });
    const second = await enter(low, { exercise: 'wallsit', format: 'pooled', seats: 4, stake: 500 });
    expect(second.challenge_id).toBe(lobby.challenge_id);

    const third = await enter(high, { exercise: 'wallsit', format: 'pooled', seats: 4, stake: 500 });
    expect(third.challenge_id).not.toBe(lobby.challenge_id);
  });

  it('rates the exercise being queued, not some other one', async () => {
    // Placed hard in pushups, untouched in plank: the plank queue must
    // treat them as unplaced and match broadly.
    const specialist = await createRatedUser(db, 'pushups', 1800);
    const other = await createRatedUser(db, 'plank', 1000);
    await enter(other, { exercise: 'plank', stake: 100 });
    const row = await enter(specialist, { exercise: 'plank', stake: 100 });
    expect(row.mmr).toBe(1000);
    expect(row.placement_complete).toBe(false);
    expect(row.status).toBe('matched');
  });
});

// ── widening ────────────────────────────────────────────────────────────

describe('MMR widening', () => {
  it('opens to 400 points once both sides have waited, via the heartbeat, and no further', async () => {
    const near = await createRatedUser(db, 'plank', 1000);
    const far = await createRatedUser(db, 'plank', 1350); // 350 apart: needs widening
    const tooFar = await createRatedUser(db, 'plank', 1600); // 600 apart: never

    const rn = await enter(near, { exercise: 'plank', stake: 100 });
    await ageLobby(rn.challenge_id!, 60);

    // A fresh arrival is not dropped into the aged lobby: they have not
    // waited themselves. Symmetric, exactly as tier widening was.
    const rf = await enter(far, { exercise: 'plank', stake: 100 });
    expect(rf.status).toBe('searching');
    expect(rf.challenge_id).not.toBe(rn.challenge_id);
    expect((await beat(far, rf.id)).challenge_id).toBe(rf.challenge_id);

    // 600 apart is outside even the wide window, however long they wait.
    const rt = await enter(tooFar, { exercise: 'plank', stake: 100 });
    await ageLobby(rt.challenge_id!, 60);
    expect((await beat(tooFar, rt.id)).status).toBe('searching');

    // Once the 350-apart fighter has waited too, their beat moves them in.
    await ageLobby(rf.challenge_id!, 60);
    const moved = await beat(far, rf.id);
    expect(moved.status).toBe('matched');
    expect(await participantsOf(moved.match_id!)).toEqual([near, far].sort());
    await leave(tooFar, rt.id);
  });

  it('keeps a widened group lobby inside the wide window of every member', async () => {
    const low = await createRatedUser(db, 'wallsit', 1000);
    const low2 = await createRatedUser(db, 'wallsit', 1050);
    const mid = await createRatedUser(db, 'wallsit', 1380); // within 400 of both
    const high = await createRatedUser(db, 'wallsit', 1500); // 500 from low

    const lobby = await enter(low, { exercise: 'wallsit', format: 'pooled', seats: 4, stake: 250 });
    await enter(low2, { exercise: 'wallsit', format: 'pooled', seats: 4, stake: 250 });
    await ageLobby(lobby.challenge_id!, 60);

    const rm = await enter(mid, { exercise: 'wallsit', format: 'pooled', seats: 4, stake: 250 });
    await ageLobby(rm.challenge_id!, 60);
    const movedIn = await beat(mid, rm.id);
    expect(movedIn.challenge_id).toBe(lobby.challenge_id);
    expect(movedIn.lobby_size).toBe(3);

    // Within 400 of the mid fighter but 500 from the two low ones.
    const rh = await enter(high, { exercise: 'wallsit', format: 'pooled', seats: 4, stake: 250 });
    await ageLobby(rh.challenge_id!, 60);
    const stayed = await beat(high, rh.id);
    expect(stayed.challenge_id).toBe(rh.challenge_id);
    expect(stayed.status).toBe('searching');
  });
});

// ── security ────────────────────────────────────────────────────────────

describe('grants and row security', () => {
  it('gives clients no write path to ratings and no view of anyone else', async () => {
    const mine = await createRatedUser(db, 'pushups', 1250);
    const theirs = await createRatedUser(db, 'pushups', 1250);

    const visible = await rpcAsUser<number>(
      db, mine, 'SELECT count(*)::int FROM skill_ratings',
    );
    expect(visible).toBe(1);

    const throughView = await rpcRow<{ user_id: string; rank_tier: string; placement_bouts: number }>(
      db, mine, 'SELECT user_id, rank_tier, placement_bouts FROM my_skill_ratings',
    );
    expect(throughView).toMatchObject({ user_id: mine, rank_tier: 'knight', placement_bouts: 5 });

    await expect(
      rpcAsUser(db, mine, 'UPDATE skill_ratings SET mmr = 1900 WHERE user_id = $1', [mine]),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      rpcAsUser(db, mine, 'INSERT INTO skill_ratings (user_id, exercise_type) VALUES ($1, $2)', [mine, 'plank']),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      rpcAsUser(db, mine, 'INSERT INTO skill_rating_events (user_id, match_id, exercise_type, mmr_before, mmr_after, delta, k_factor, was_placement, matches_played, participants) VALUES ($1, gen_random_uuid(), $2, 1, 2, 1, 32, false, 1, 2)', [mine, 'pushups']),
    ).rejects.toThrow(/permission denied/i);

    expect(theirs).toBeDefined();
  });

  it('scopes rating events to their owner', async () => {
    const { a, b, matchId } = await duel(1200, 1200);
    await submit(a, matchId, { reps: 40 });
    await submit(b, matchId, { reps: 30 });
    expect(
      await rpcAsUser<number>(db, a, 'SELECT count(*)::int FROM skill_rating_events WHERE match_id = $1', [matchId]),
    ).toBe(1);
  });
});
