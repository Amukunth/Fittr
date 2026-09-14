/**
 * The trophy ladder against a real Postgres: the award schedule, the streak
 * rule, the league boundaries, the history timeline, and the three read
 * functions that widen fitness_profiles_select_own for the leaderboard.
 *
 * Every arithmetic assertion is written against a hand-computed
 * expectation, shown next to it, rather than against whatever the function
 * happens to return -- so changing an award fails here instead of silently
 * re-baselining.
 *
 * What this cannot prove: PostgREST, Supabase Realtime, and two phones. See
 * BACKEND.md.
 */
import {
  asUser,
  createRatedUser,
  createUser,
  rpcAsUser,
  rpcRow,
  startTestDb,
  type TestDb,
} from '../test/dbHarness';
import {
  LEAGUES,
  LEAGUE_COLOR,
  LEAGUE_MAX_WAGER_CENTS,
  LEAGUE_MIN_TROPHIES,
  TROPHY_LOSS_PENALTY,
  TROPHY_STREAK_BONUS_CAP,
  TROPHY_TIE_AWARD,
  TROPHY_WIN_BASE,
  leagueOf,
  trophyWinAward,
} from '../src/lib/league';
import type {
  LeaderboardRow,
  LeagueTier,
  MatchmakingQueueRow,
  RankEventType,
  RankStandingRow,
} from '../src/types/database';

let db: TestDb;

beforeAll(async () => {
  db = await startTestDb();
}, 120000);

afterAll(async () => {
  await db.stop();
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

async function submit(
  user: string,
  matchId: string,
  opts: { reps?: number; anomaly?: boolean } = {},
) {
  const { rows } = await db.pool.query<{ id: string }>(
    'SELECT id FROM match_participants WHERE match_id = $1 AND user_id = $2',
    [matchId, user],
  );
  return rpcAsUser<string>(
    db,
    user,
    'SELECT submit_verification_session($1, $2, $3::jsonb, $4, $5)',
    [rows[0]!.id, opts.reps ?? 0, JSON.stringify({ test: true }), opts.anomaly ?? false, null],
  );
}

/** Two fighters, matched on a 1v1, with `winner` scoring higher. */
async function fight(
  winner: string,
  loser: string,
  opts: { winnerReps?: number; loserReps?: number; anomaly?: boolean } = {},
): Promise<string> {
  const a = await enter(winner);
  const b = await enter(loser);
  const matchId = b.match_id ?? a.match_id;
  if (!matchId) {
    throw new Error('the lobby did not fill');
  }
  await submit(winner, matchId, { reps: opts.winnerReps ?? 40, anomaly: opts.anomaly });
  await submit(loser, matchId, { reps: opts.loserReps ?? 10 });
  return matchId;
}

interface Standing {
  trophies: number;
  current_league: LeagueTier;
  total_wins: number;
  total_losses: number;
  total_ties: number;
  current_streak: number;
}

async function standingOf(userId: string): Promise<Standing> {
  const { rows } = await db.pool.query<Standing>(
    `SELECT trophies, current_league, total_wins, total_losses, total_ties, current_streak
       FROM fitness_profiles WHERE user_id = $1`,
    [userId],
  );
  return rows[0]!;
}

interface HistoryRow {
  event_type: RankEventType;
  trophy_delta: number;
  trophy_balance: number;
  opponent_id: string | null;
  match_id: string | null;
}

/** A fighter's timeline, newest first, exactly as the screen reads it. */
async function historyOf(userId: string): Promise<HistoryRow[]> {
  const { rows } = await db.pool.query<HistoryRow>(
    `SELECT event_type, trophy_delta, trophy_balance, opponent_id, match_id
       FROM rank_history WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

/** Force a trophy count, the way setRating() forces an MMR. */
async function setTrophies(userId: string, trophies: number): Promise<void> {
  await db.pool.query(
    `UPDATE fitness_profiles
        SET trophies = $2, current_league = league_for($2)
      WHERE user_id = $1`,
    [userId, trophies],
  );
}

/** A fighter with a placed rating, so nothing here is a placement bout. */
function newFighter(points = 5000) {
  return createRatedUser(db, 'pushups', 1000, { points, matchesPlayed: 5 });
}

// ── the seed and the mirrors ────────────────────────────────────────────

describe('league_tiers', () => {
  it('seeds the five leagues in ascending order', async () => {
    const { rows } = await db.pool.query<{ name: LeagueTier; min_trophies: number }>(
      'SELECT name, min_trophies FROM league_tiers ORDER BY min_trophies',
    );
    expect(rows.map(r => r.name)).toEqual([...LEAGUES]);
    expect(rows.map(r => r.min_trophies)).toEqual([0, 50, 150, 300, 500]);
  });

  it('agrees with the thresholds, ceilings and colours mirrored in src/lib/league.ts', async () => {
    const { rows } = await db.pool.query<{
      name: LeagueTier;
      min_trophies: number;
      max_wager_cents: number;
      color_hex: string;
    }>('SELECT name, min_trophies, max_wager_cents, color_hex FROM league_tiers');
    expect(rows).toHaveLength(LEAGUES.length);
    for (const row of rows) {
      expect(row.min_trophies).toBe(LEAGUE_MIN_TROPHIES[row.name]);
      expect(row.max_wager_cents).toBe(LEAGUE_MAX_WAGER_CENTS[row.name]);
      expect(row.color_hex).toBe(LEAGUE_COLOR[row.name].toUpperCase());
    }
  });

  it('is readable by any signed-in fighter and writable by none', async () => {
    const me = await createUser(db);
    const visible = await rpcAsUser<string>(
      db,
      me,
      'SELECT count(*)::text FROM league_tiers',
    );
    expect(visible).toBe('5');

    await expect(
      asUser(db, me, client =>
        client.query("UPDATE league_tiers SET min_trophies = 0 WHERE name = 'diamond'"),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('league_for', () => {
  it('bands the five leagues at their thresholds', async () => {
    const cases: Array<[number, LeagueTier]> = [
      [0, 'bronze'],
      [49, 'bronze'],
      [50, 'silver'],
      [149, 'silver'],
      [150, 'gold'],
      [299, 'gold'],
      [300, 'platinum'],
      [499, 'platinum'],
      [500, 'diamond'],
      [99999, 'diamond'],
    ];
    for (const [trophies, expected] of cases) {
      const league = await rpcAsUser<LeagueTier>(
        db,
        await createUser(db),
        'SELECT league_for($1)',
        [trophies],
      );
      expect([trophies, league]).toEqual([trophies, expected]);
    }
  });

  it('agrees with leagueOf() in src/lib/league.ts at every boundary', async () => {
    for (const tier of LEAGUES) {
      const floor = LEAGUE_MIN_TROPHIES[tier];
      for (const trophies of [floor - 1, floor, floor + 1]) {
        if (trophies < 0) {
          continue;
        }
        const sql = await rpcAsUser<LeagueTier>(
          db,
          await createUser(db),
          'SELECT league_for($1)',
          [trophies],
        );
        expect([trophies, sql]).toEqual([trophies, leagueOf(trophies)]);
      }
    }
  });
});

describe('the award schedule', () => {
  it('matches the constants the client mirrors', async () => {
    const me = await createUser(db);
    const row = await rpcRow<{
      base: number;
      penalty: number;
      tie: number;
      cap: number;
    }>(
      db,
      me,
      `SELECT _trophy_win_base() AS base, _trophy_loss_penalty() AS penalty,
              _trophy_tie_award() AS tie, _trophy_streak_bonus_cap() AS cap`,
    );
    expect(row).toEqual({
      base: TROPHY_WIN_BASE,
      penalty: TROPHY_LOSS_PENALTY,
      tie: TROPHY_TIE_AWARD,
      cap: TROPHY_STREAK_BONUS_CAP,
    });
  });

  it('pays the base for a first win and one more per straight win, to the cap', async () => {
    const me = await createUser(db);
    for (let streak = 1; streak <= 10; streak += 1) {
      const award = await rpcAsUser<number>(
        db,
        me,
        'SELECT _trophy_win_award($1)',
        [streak],
      );
      // 12, 13, 14, 15, 16, 17, then 17 forever: base + min(streak-1, 5).
      const expected = TROPHY_WIN_BASE + Math.min(streak - 1, TROPHY_STREAK_BONUS_CAP);
      expect([streak, award]).toEqual([streak, expected]);
      expect(award).toBe(trophyWinAward(streak));
    }
  });
});

// ── settlement ──────────────────────────────────────────────────────────

describe('a settled 1v1', () => {
  it('pays the winner the base and charges the loser the penalty', async () => {
    const winner = await newFighter();
    const loser = await newFighter();
    await fight(winner, loser);

    // First win of a run: 12. Loser: -6, but they were on 0, so it floors.
    expect(await standingOf(winner)).toMatchObject({
      trophies: 12,
      current_league: 'bronze',
      total_wins: 1,
      total_losses: 0,
      total_ties: 0,
      current_streak: 1,
    });
    expect(await standingOf(loser)).toMatchObject({
      trophies: 0,
      total_wins: 0,
      total_losses: 1,
      current_streak: 0,
    });
  });

  it('writes one history row for each fighter, naming the other', async () => {
    const winner = await newFighter();
    const loser = await newFighter();
    const matchId = await fight(winner, loser);

    expect(await historyOf(winner)).toEqual([
      {
        event_type: 'win',
        trophy_delta: 12,
        trophy_balance: 12,
        opponent_id: loser,
        match_id: matchId,
      },
    ]);
    expect(await historyOf(loser)).toEqual([
      {
        event_type: 'loss',
        // Floored at zero, and the row records what actually happened.
        trophy_delta: 0,
        trophy_balance: 0,
        opponent_id: winner,
        match_id: matchId,
      },
    ]);
  });

  it('takes the penalty off a fighter who has trophies to lose', async () => {
    const winner = await newFighter();
    const loser = await newFighter();
    await setTrophies(loser, 40);
    await fight(winner, loser);

    expect((await standingOf(loser)).trophies).toBe(34); // 40 - 6
    expect((await historyOf(loser))[0]).toMatchObject({
      trophy_delta: -6,
      trophy_balance: 34,
    });
  });

  it('compounds the streak bonus over a run and resets it on a loss', async () => {
    const me = await newFighter(20000);
    const foes = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => newFighter()));

    // 12 + 13 + 14 + 15 + 16 + 17 = 87 over six straight wins.
    let expected = 0;
    for (let i = 0; i < 6; i += 1) {
      await fight(me, foes[i]!);
      expected += TROPHY_WIN_BASE + Math.min(i, TROPHY_STREAK_BONUS_CAP);
      const now = await standingOf(me);
      expect([i, now.trophies, now.current_streak]).toEqual([i, expected, i + 1]);
    }
    expect(expected).toBe(87);

    // A loss takes six off and puts the run back to zero, so the next win
    // pays the base again rather than resuming at the cap.
    await fight(foes[6]!, me);
    expect(await standingOf(me)).toMatchObject({
      trophies: 81,
      current_streak: 0,
      total_wins: 6,
      total_losses: 1,
    });
  });

  it('moves nothing until a needs_review bout is cleared', async () => {
    const winner = await newFighter();
    const loser = await newFighter();
    const matchId = await fight(winner, loser, { anomaly: true });

    expect(await standingOf(winner)).toMatchObject({ trophies: 0, total_wins: 0 });
    expect(await historyOf(winner)).toEqual([]);

    // A reviewer clears the flag and settlement runs again.
    await db.pool.query(
      `UPDATE verification_sessions SET reviewed = true
        WHERE match_participant_id IN (
          SELECT id FROM match_participants WHERE match_id = $1
        )`,
      [matchId],
    );
    const outcome = await rpcAsUser<string>(db, winner, 'SELECT settle_match($1)', [matchId]);
    expect(outcome).toBe('settled');
    expect(await standingOf(winner)).toMatchObject({ trophies: 12, total_wins: 1 });
  });

  it('awards exactly once however many times settlement is called', async () => {
    const winner = await newFighter();
    const loser = await newFighter();
    const matchId = await fight(winner, loser);

    expect(await rpcAsUser<string>(db, winner, 'SELECT settle_match($1)', [matchId]))
      .toBe('already_settled');
    expect(await rpcAsUser<string>(db, loser, 'SELECT settle_match($1)', [matchId]))
      .toBe('already_settled');

    expect((await standingOf(winner)).trophies).toBe(12);
    expect(await historyOf(winner)).toHaveLength(1);
  });
});

describe('leagues moving', () => {
  it('writes a promotion row above the win that earned it', async () => {
    const me = await newFighter();
    const foe = await newFighter();
    await setTrophies(me, 44); // 44 + 12 = 56, over Silver's 50.
    await fight(me, foe);

    expect((await standingOf(me)).current_league).toBe('silver');
    const timeline = await historyOf(me);
    // Newest first: the promotion is the consequence, so it sits on top.
    expect(timeline.map(e => e.event_type)).toEqual(['promotion', 'win']);
    expect(timeline[0]).toMatchObject({
      trophy_delta: 0,
      trophy_balance: 56,
      opponent_id: null,
    });
  });

  it('writes a demotion row when a loss drops a league', async () => {
    const me = await newFighter();
    const foe = await newFighter();
    await setTrophies(me, 52); // 52 - 6 = 46, back under Silver.
    await fight(foe, me);

    expect((await standingOf(me)).current_league).toBe('bronze');
    const timeline = await historyOf(me);
    expect(timeline.map(e => e.event_type)).toEqual(['demotion', 'loss']);
    expect(timeline[0]).toMatchObject({ trophy_delta: 0, trophy_balance: 46 });
  });

  it('leaves the league alone when a bout does not cross a threshold', async () => {
    const me = await newFighter();
    const foe = await newFighter();
    await setTrophies(me, 60);
    await fight(me, foe);

    expect((await standingOf(me)).current_league).toBe('silver');
    expect((await historyOf(me)).map(e => e.event_type)).toEqual(['win']);
  });
});

describe('a group battle', () => {
  it('splits first place as a tie, and a tie moves no streak', async () => {
    const fighters = await Promise.all([0, 1, 2, 3].map(() => newFighter()));
    // Give one of the tied fighters a run going, to prove a tie does not
    // break it and does not extend it either.
    const [a, b, c, d] = fighters as [string, string, string, string];
    await db.pool.query(
      'UPDATE fitness_profiles SET current_streak = 3 WHERE user_id = $1',
      [a],
    );

    const entries = [];
    for (const f of [a, b, c, d]) {
      entries.push(await enter(f, { format: 'pooled', seats: 4 }));
    }
    const matchId = entries[3]!.match_id!;
    expect(matchId).toBeTruthy();

    await submit(a, matchId, { reps: 50 });
    await submit(b, matchId, { reps: 50 });
    await submit(c, matchId, { reps: 20 });
    await submit(d, matchId, { reps: 10 });

    expect(await standingOf(a)).toMatchObject({
      trophies: TROPHY_TIE_AWARD,
      total_wins: 0,
      total_ties: 1,
      current_streak: 3,
    });
    expect(await standingOf(b)).toMatchObject({
      trophies: TROPHY_TIE_AWARD,
      total_ties: 1,
      current_streak: 0,
    });
    expect(await standingOf(c)).toMatchObject({ total_losses: 1, current_streak: 0 });
    expect(await standingOf(d)).toMatchObject({ total_losses: 1 });

    // No single opponent to name in a four-seat bout.
    expect((await historyOf(a))[0]).toMatchObject({
      event_type: 'tie',
      opponent_id: null,
    });
  });

  it('pays a sole winner of a group battle the full win award', async () => {
    const fighters = await Promise.all([0, 1, 2].map(() => newFighter()));
    const [a, b, c] = fighters as [string, string, string];
    const entries = [];
    for (const f of [a, b, c]) {
      entries.push(await enter(f, { format: 'pooled', seats: 3 }));
    }
    const matchId = entries[2]!.match_id!;
    await submit(a, matchId, { reps: 60 });
    await submit(b, matchId, { reps: 30 });
    await submit(c, matchId, { reps: 10 });

    expect(await standingOf(a)).toMatchObject({
      trophies: TROPHY_WIN_BASE,
      total_wins: 1,
      current_streak: 1,
    });
    expect((await historyOf(a))[0]).toMatchObject({ opponent_id: null });
  });
});

// ── reading the ladder ──────────────────────────────────────────────────

describe('_rank_winners_of_settled', () => {
  it('names the sole winner settlement recorded', async () => {
    const winner = await newFighter();
    const loser = await newFighter();
    const matchId = await fight(winner, loser);

    const { rows } = await db.pool.query<{ winners: string[] }>(
      'SELECT _rank_winners_of_settled($1) AS winners',
      [matchId],
    );
    expect(rows[0]!.winners).toEqual([winner]);
  });

  it('reads a tie off the payouts, not off the scores', async () => {
    // The shape that broke the first backfill: a bout settlement called a
    // tie, with a score on one side and none on the other. max() would
    // elect the scored fighter; the ledger says they shared it.
    const a = await newFighter();
    const b = await newFighter();
    const matchId = await fight(a, b, { winnerReps: 30, loserReps: 30 });

    const { rows } = await db.pool.query<{ winners: string[] }>(
      'SELECT _rank_winners_of_settled($1) AS winners',
      [matchId],
    );
    expect([...rows[0]!.winners].sort()).toEqual([a, b].sort());

    // And the ladder read it the same way when settlement wrote it.
    expect(await standingOf(a)).toMatchObject({ total_ties: 1, total_wins: 0 });
    expect((await historyOf(a))[0]).toMatchObject({ event_type: 'tie' });
  });

  it('agrees with what settlement paid, for every settled bout on the database', async () => {
    // The invariant the 20260913000100 rebuild exists to hold: nobody is on
    // the ladder for a bout the money says they did not win.
    const { rows } = await db.pool.query<{ wrong: number }>(
      `SELECT count(*)::int AS wrong
         FROM "rank_history" h
         JOIN "matches" m ON m.id = h.match_id
        WHERE h.event_type IN ('win', 'tie')
          AND NOT (h.user_id = ANY (public._rank_winners_of_settled(m.id)))`,
    );
    expect(rows[0]!.wrong).toBe(0);
  });

  it('keeps sum(trophy_delta) equal to the stored count, bout after bout', async () => {
    // The audit the timeline exists to make possible. Scoped to two fresh
    // fighters: much of this suite forces a count with setTrophies() to
    // reach a threshold, which is deliberately a write history knows
    // nothing about.
    const me = await newFighter(20000);
    const foe = await newFighter(20000);
    await fight(me, foe);
    await fight(me, foe);
    await fight(foe, me);

    for (const fighter of [me, foe]) {
      const { rows } = await db.pool.query<{ stored: number; summed: number }>(
        `SELECT p.trophies AS stored,
                coalesce((SELECT sum(h.trophy_delta) FROM "rank_history" h
                           WHERE h.user_id = p.user_id), 0)::int AS summed
           FROM "fitness_profiles" p WHERE p.user_id = $1`,
        [fighter],
      );
      expect(Number(rows[0]!.summed)).toBe(rows[0]!.stored);
    }
  });
});

describe('rank_history RLS', () => {
  it('shows a fighter their own timeline and nobody else\'s', async () => {
    const me = await newFighter();
    const foe = await newFighter();
    await fight(me, foe);

    const mine = await rpcAsUser<string>(
      db,
      me,
      'SELECT count(*)::text FROM rank_history',
    );
    expect(mine).toBe('1');

    const theirs = await rpcAsUser<string>(
      db,
      me,
      'SELECT count(*)::text FROM rank_history WHERE user_id = $1',
      [foe],
    );
    expect(theirs).toBe('0');
  });
});

describe('leaderboard_page', () => {
  it('ranks by trophies, marks the caller, and pages without gaps', async () => {
    const players: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await createUser(db, { email: `board-${i}-${Date.now()}@test.local` });
      await setTrophies(id, 900 - i * 10); // 900, 890, 880, 870, 860
      players.push(id);
    }
    const me = players[2]!;

    const first = await asUser(db, me, async client => {
      const { rows } = await client.query<LeaderboardRow>(
        'SELECT * FROM leaderboard_page($1, $2, $3)',
        ['global', 3, 0],
      );
      return rows;
    });
    expect(first).toHaveLength(3);
    expect(first.map(r => Number(r.rank))).toEqual([1, 2, 3]);
    expect(first.map(r => r.trophies)).toEqual([900, 890, 880]);
    expect(first.map(r => r.is_me)).toEqual([false, false, true]);
    expect(first[0]!.league).toBe('diamond');

    const second = await asUser(db, me, async client => {
      const { rows } = await client.query<LeaderboardRow>(
        'SELECT * FROM leaderboard_page($1, $2, $3)',
        ['global', 3, 3],
      );
      return rows;
    });
    // Only the first two are this test's players: every fighter the suite
    // has created before now is also on the global board, below them.
    expect(second.slice(0, 2).map(r => Number(r.rank))).toEqual([4, 5]);
    expect(second.slice(0, 2).map(r => r.trophies)).toEqual([870, 860]);
    expect(second.slice(0, 2).map(r => r.user_id)).toEqual([players[3], players[4]]);
  });

  it('returns a handle and a picture and nothing else about a stranger', async () => {
    const me = await createUser(db);
    const row = await rpcRow<LeaderboardRow>(
      db,
      me,
      'SELECT * FROM leaderboard_page($1, $2, $3)',
      ['global', 1, 0],
    );
    expect(Object.keys(row).sort()).toEqual([
      'avatar_url',
      'display_name',
      'is_me',
      'league',
      'rank',
      'trophies',
      'user_id',
      'username',
    ]);
  });

  it('refuses a scope it does not know', async () => {
    const me = await createUser(db);
    await expect(
      rpcAsUser(db, me, 'SELECT * FROM leaderboard_page($1)', ['everyone']),
    ).rejects.toThrow(/unknown leaderboard scope/);
  });

  it('leaves out an account that has been deleted', async () => {
    const me = await createUser(db);
    const quitter = await createUser(db);
    await setTrophies(quitter, 5000);

    const before = await rpcRow<LeaderboardRow>(
      db,
      me,
      'SELECT * FROM leaderboard_page($1, $2, $3)',
      ['global', 1, 0],
    );
    expect(before.user_id).toBe(quitter);

    await rpcAsUser(db, quitter, 'SELECT delete_my_account()');

    const after = await rpcRow<LeaderboardRow>(
      db,
      me,
      'SELECT * FROM leaderboard_page($1, $2, $3)',
      ['global', 1, 0],
    );
    expect(after.user_id).not.toBe(quitter);
  });

  it('scopes friends to the fighters you have actually met, plus yourself', async () => {
    const me = await newFighter();
    const sparred = await newFighter();
    const stranger = await createUser(db);
    await setTrophies(stranger, 9000);
    await fight(me, sparred);

    const friends = await asUser(db, me, async client => {
      const { rows } = await client.query<LeaderboardRow>(
        'SELECT * FROM leaderboard_page($1, $2, $3)',
        ['friends', 50, 0],
      );
      return rows;
    });
    const ids = friends.map(r => r.user_id);
    expect(ids).toContain(me);
    expect(ids).toContain(sparred);
    expect(ids).not.toContain(stranger);
    // Ranked within the scope, so the board reads 1, 2 rather than the two
    // places these fighters hold globally.
    expect(friends.map(r => Number(r.rank))).toEqual([1, 2]);
  });
});

describe('leaderboard_self and rank_standing', () => {
  it('agree with each other and with the page the board would draw', async () => {
    const players: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const id = await createUser(db, { email: `standing-${i}-${Date.now()}@test.local` });
      await setTrophies(id, 2000 - i * 100);
      players.push(id);
    }
    const me = players[3]!; // last of the four, and behind everyone seeded earlier

    const self = await rpcRow<LeaderboardRow>(
      db,
      me,
      'SELECT * FROM leaderboard_self($1)',
      ['global'],
    );
    const standing = await rpcRow<RankStandingRow>(db, me, 'SELECT * FROM rank_standing()');

    expect(self.is_me).toBe(true);
    expect(self.user_id).toBe(me);
    expect(Number(standing.global_rank)).toBe(Number(self.rank));

    // And that rank is the row the page actually puts there.
    const page = await asUser(db, me, async client => {
      const { rows } = await client.query<LeaderboardRow>(
        'SELECT * FROM leaderboard_page($1, $2, $3)',
        ['global', 1, Number(self.rank) - 1],
      );
      return rows;
    });
    expect(page[0]!.user_id).toBe(me);
  });

  it('reports the record settlement wrote', async () => {
    const me = await newFighter();
    const foe = await newFighter();
    await fight(me, foe);
    await fight(me, await newFighter());

    const standing = await rpcRow<RankStandingRow>(db, me, 'SELECT * FROM rank_standing()');
    expect(standing).toMatchObject({
      trophies: 25, // 12 + 13
      current_league: 'bronze',
      total_wins: 2,
      total_losses: 0,
      total_ties: 0,
      current_streak: 2,
    });
  });

  it('returns nothing, not a row of nulls, for a caller with no profile', async () => {
    // Reachable: the app creates a fitness_profiles row lazily, and nothing
    // on the Rank screen creates one. A row of nulls would be pinned to the
    // board as if it were a real standing.
    const { rows } = await db.pool.query<{ id: string }>(
      'INSERT INTO auth.users (email) VALUES ($1) RETURNING id',
      [`profileless-${Date.now()}@test.local`],
    );
    const stranger = rows[0]!.id;

    expect(await rpcAsUser(db, stranger, 'SELECT leaderboard_self($1)', ['global'])).toBeNull();
    expect(await rpcAsUser(db, stranger, 'SELECT rank_standing()')).toBeNull();
  });

  it('refuses both when nobody is signed in', async () => {
    await expect(
      db.pool.query("SELECT set_config('request.jwt.claim.sub', '', true); SELECT rank_standing()"),
    ).rejects.toThrow(/not signed in/);
  });
});
