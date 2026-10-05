/**
 * Score-based settlement, the Blitz curve and the featured pooled
 * competition, against a real Postgres.
 *
 * What this file proves that score.test.ts (pure logic) cannot: that
 * submit_verification_session writes the score the client mirror predicts,
 * that a 1v1 is decided on score and not on raw reps, that a pooled bout
 * pays 50 / 30 / 20 by place with dead heats shared, that the pooled
 * competition opens, fills and settles through the same settle_match() as
 * everything else, and that the client's constants equal the SQL tunables.
 */
import {
  BLITZ_BENCHMARK_OFFSET,
  BLITZ_BREAKEVEN_BP,
  BLITZ_MAX_BP,
  REFERENCE_QUALITY_BP,
  blitzMultiplierBp,
  scoreAtReference,
  scoreFor,
} from '../src/lib/score';
import { POOL_ENTRY_FEE, POOL_MAX_ENTRIES, POOL_PRIZE_SHARES_BP } from '../src/lib/pooled';
import {
  asUser,
  balance,
  createRatedUser,
  createUser,
  rpcAsUser,
  rpcRow,
  startTestDb,
  type TestDb,
} from '../test/dbHarness';

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

async function submit(
  user: string,
  matchId: string,
  opts: { reps?: number; hold?: number; quality?: number | null; anomaly?: boolean },
) {
  const { rows } = await db.pool.query<{ id: string }>(
    'SELECT id FROM match_participants WHERE match_id = $1 AND user_id = $2',
    [matchId, user],
  );
  return rpcAsUser<string>(
    db,
    user,
    'SELECT submit_verification_session($1, $2, $3::jsonb, $4, $5, $6)',
    [
      rows[0]!.id,
      opts.reps ?? null,
      JSON.stringify({ test: true }),
      opts.anomaly ?? false,
      opts.hold ?? null,
      opts.quality === undefined ? 10000 : opts.quality,
    ],
  );
}

async function enter1v1(user: string, stake = 100) {
  return rpcRow<{ match_id: string | null; status: string }>(
    db,
    user,
    'SELECT * FROM enter_matchmaking($1, $2, $3, $4, $5)',
    ['pushups', '1v1', stake, 2, false],
  );
}

async function fight(stake = 100) {
  const a = await createUser(db, { points: 1000 });
  const b = await createUser(db, { points: 1000 });
  await enter1v1(a, stake);
  const second = await enter1v1(b, stake);
  return { a, b, matchId: second.match_id! };
}

async function participant(matchId: string, user: string) {
  const { rows } = await db.pool.query<{
    rep_count: number | null;
    hold_duration_seconds: number | null;
    score: number | null;
    place: number | null;
  }>(
    'SELECT rep_count, hold_duration_seconds, score, place FROM match_participants WHERE match_id = $1 AND user_id = $2',
    [matchId, user],
  );
  return rows[0]!;
}

async function sessionOf(matchId: string, user: string) {
  const { rows } = await db.pool.query<{ form_quality_bp: number | null; score: number | null }>(
    `SELECT vs.form_quality_bp, vs.score
       FROM verification_sessions vs
       JOIN match_participants mp ON mp.id = vs.match_participant_id
      WHERE mp.match_id = $1 AND mp.user_id = $2`,
    [matchId, user],
  );
  return rows[0]!;
}

async function winnerOf(matchId: string) {
  const { rows } = await db.pool.query<{ winner_id: string | null; settled_at: string | null }>(
    'SELECT winner_id, settled_at FROM matches WHERE id = $1',
    [matchId],
  );
  return rows[0]!;
}

interface PoolRow {
  id: string;
  exercise_type: string;
  title: string;
  entry_fee: number;
  max_entries: number;
  entries: number;
  pool_points: number;
  max_pool_points: number;
  match_id: string;
  entered: boolean;
  played: boolean;
  filled_at: string | null;
  settled_at: string | null;
  prize_shares_bp: number[];
}

function featured(user: string) {
  return rpcRow<PoolRow>(db, user, 'SELECT * FROM pooled_featured()');
}

function enterPool(user: string) {
  return rpcRow<PoolRow>(db, user, 'SELECT * FROM pooled_enter()');
}

// ── the tunables agree with the client ──────────────────────────────────

describe('tunables mirror the client', () => {
  it('reference quality, curve ends, benchmark offset, pool fee / seats / shares', async () => {
    const { rows } = await db.pool.query<{
      ref: number;
      be: number;
      mx: number;
      off: number;
      fee: number;
      seats: number;
      shares: number[];
    }>(
      `SELECT _score_reference_quality_bp() AS ref,
              _blitz_breakeven_bp() AS be,
              _blitz_max_bp() AS mx,
              _solo_blitz_benchmark_offset() AS off,
              _pool_entry_fee() AS fee,
              _pool_max_entries() AS seats,
              _pool_prize_shares_bp() AS shares`,
    );
    expect(rows[0]).toEqual({
      ref: REFERENCE_QUALITY_BP,
      be: BLITZ_BREAKEVEN_BP,
      mx: BLITZ_MAX_BP,
      off: BLITZ_BENCHMARK_OFFSET,
      fee: POOL_ENTRY_FEE,
      seats: POOL_MAX_ENTRIES,
      shares: [...POOL_PRIZE_SHARES_BP],
    });
  });

  it('_score_for and _blitz_multiplier_bp agree with the client mirrors point for point', async () => {
    const cases = [
      [30, 8500],
      [30, 8537],
      [7, 8550],
      [0, 9000],
      [106, 9120],
    ];
    for (const [raw, q] of cases) {
      const { rows } = await db.pool.query<{ s: number }>('SELECT _score_for($1, $2) AS s', [raw, q]);
      expect(rows[0]!.s).toBe(scoreFor(raw!, q!));
    }
    const T = 2550;
    const B = 3825;
    for (const s of [0, T - 1, T, T + 1, T + 637, T + 638, B - 1, B, B + 999]) {
      const { rows } = await db.pool.query<{ m: number }>(
        'SELECT _blitz_multiplier_bp($1, $2, $3) AS m',
        [s, T, B],
      );
      expect(rows[0]!.m).toBe(blitzMultiplierBp(s, T, B));
    }
  });
});

// ── submit writes the score ─────────────────────────────────────────────

describe('submit_verification_session with form quality', () => {
  it('stores quality and score on the session and mirrors the score onto the participant', async () => {
    const { a, b, matchId } = await fight();
    await submit(a, matchId, { reps: 30, quality: 8537 });
    expect(await sessionOf(matchId, a)).toEqual({ form_quality_bp: 8537, score: 2561 });
    expect(await participant(matchId, a)).toMatchObject({ rep_count: 30, score: 2561, place: null });
    // Not settled yet: the other corner has not recorded.
    expect((await winnerOf(matchId)).settled_at).toBeNull();
    await submit(b, matchId, { reps: 10 });
    expect((await winnerOf(matchId)).winner_id).toBe(a);
  });

  it('scores a submission with no quality reading at the reference quality', async () => {
    const { a, b, matchId } = await fight();
    await submit(a, matchId, { reps: 30, quality: null });
    expect(await sessionOf(matchId, a)).toEqual({
      form_quality_bp: REFERENCE_QUALITY_BP,
      score: scoreAtReference(30),
    });
    await submit(b, matchId, { reps: 1 });
  });

  it('rejects a quality outside basis points', async () => {
    const { a, matchId } = await fight();
    await expect(submit(a, matchId, { reps: 30, quality: 10001 })).rejects.toThrow(/form_quality_invalid/);
    await expect(submit(a, matchId, { reps: 30, quality: -1 })).rejects.toThrow(/form_quality_invalid/);
  });
});

// ── a 1v1 is decided on score, not reps ─────────────────────────────────

describe('head-to-head settlement on score', () => {
  it('fewer reps at better form beats more reps at worse form', async () => {
    const { a, b, matchId } = await fight(100);
    await submit(a, matchId, { reps: 26, quality: 10000 }); // 2600
    await submit(b, matchId, { reps: 30, quality: 8500 }); // 2550
    const m = await winnerOf(matchId);
    expect(m.winner_id).toBe(a);
    expect(await balance(db, a)).toBe(1000 - 100 + 200);
    expect(await balance(db, b)).toBe(900);
    expect((await participant(matchId, a)).place).toBe(1);
    expect((await participant(matchId, b)).place).toBe(2);
  });

  it('a dead heat on score refunds both, however the raw counts compare', async () => {
    const { a, b, matchId } = await fight(100);
    await submit(a, matchId, { reps: 30, quality: 8500 }); // 2550
    await submit(b, matchId, { reps: 34, quality: 7500 }); // 2550
    const m = await winnerOf(matchId);
    expect(m.winner_id).toBeNull();
    expect(m.settled_at).not.toBeNull();
    expect(await balance(db, a)).toBe(1000);
    expect(await balance(db, b)).toBe(1000);
    expect((await participant(matchId, a)).place).toBe(1);
    expect((await participant(matchId, b)).place).toBe(1);
  });

  it('rates the bout on score too, so the money and the rating agree', async () => {
    const a = await createRatedUser(db, 'pushups', 1000, { points: 1000, matchesPlayed: 10 });
    const b = await createRatedUser(db, 'pushups', 1000, { points: 1000, matchesPlayed: 10 });
    const enter = (u: string) =>
      rpcRow<{ match_id: string | null }>(
        db,
        u,
        'SELECT * FROM enter_matchmaking($1, $2, $3, $4, $5)',
        ['pushups', '1v1', 100, 2, true],
      );
    await enter(a);
    const { match_id } = await enter(b);
    // b has more reps, a has the higher score.
    await submit(a, match_id!, { reps: 26, quality: 10000 });
    await submit(b, match_id!, { reps: 30, quality: 8000 });
    const { rows } = await db.pool.query<{ user_id: string; delta: number }>(
      'SELECT user_id, delta FROM skill_rating_events WHERE match_id = $1',
      [match_id],
    );
    const byUser = new Map(rows.map(r => [r.user_id, r.delta]));
    expect(byUser.get(a)).toBeGreaterThan(0);
    expect(byUser.get(b)).toBeLessThan(0);
  });
});

// ── Blitz on the curve ──────────────────────────────────────────────────

describe('Blitz', () => {
  interface Run {
    match_id: string;
    threshold_score: number;
    benchmark_score: number;
    threshold_raw: number;
    benchmark_raw: number;
    breakeven_bp: number;
    max_bp: number;
    stake_points: number;
  }

  function start(user: string, ranked = false) {
    return rpcRow<Run>(db, user, 'SELECT * FROM blitz_start($1, $2, $3)', ['pushups', 100, ranked]);
  }

  async function settled(matchId: string) {
    const { rows } = await db.pool.query<{
      score: number;
      cleared: boolean;
      multiplier_bp: number;
      payout_points: number;
    }>('SELECT score, cleared, multiplier_bp, payout_points FROM blitz_runs WHERE match_id = $1', [
      matchId,
    ]);
    return rows[0]!;
  }

  it('previews two bars in score units, the benchmark strictly above the threshold', async () => {
    const user = await createUser(db, { points: 500 });
    const preview = await rpcRow<Run & { reference_quality_bp: number }>(
      db,
      user,
      'SELECT * FROM blitz_preview($1)',
      ['pushups'],
    );
    expect(preview.threshold_score).toBe(scoreAtReference(preview.threshold_raw));
    expect(preview.benchmark_score).toBe(scoreAtReference(preview.benchmark_raw));
    expect(preview.benchmark_score).toBeGreaterThan(preview.threshold_score);
    expect(preview.reference_quality_bp).toBe(REFERENCE_QUALITY_BP);
    expect([preview.breakeven_bp, preview.max_bp]).toEqual([BLITZ_BREAKEVEN_BP, BLITZ_MAX_BP]);
  });

  it('pays nothing under the bar, the stake back on it, and 2.5x at the benchmark', async () => {
    const miss = await createUser(db, { points: 500 });
    const runMiss = await start(miss);
    await submit(miss, runMiss.match_id, { reps: runMiss.threshold_raw - 1, quality: REFERENCE_QUALITY_BP });
    expect(await settled(runMiss.match_id)).toMatchObject({ cleared: false, multiplier_bp: 0, payout_points: 0 });
    expect(await balance(db, miss)).toBe(400);

    const even = await createUser(db, { points: 500 });
    const runEven = await start(even);
    await submit(even, runEven.match_id, { reps: runEven.threshold_raw, quality: REFERENCE_QUALITY_BP });
    expect(await settled(runEven.match_id)).toMatchObject({ cleared: true, multiplier_bp: 10000, payout_points: 100 });
    expect(await balance(db, even)).toBe(500);

    const top = await createUser(db, { points: 500 });
    const runTop = await start(top);
    await submit(top, runTop.match_id, { reps: runTop.benchmark_raw + 10, quality: 10000 });
    expect(await settled(runTop.match_id)).toMatchObject({ cleared: true, multiplier_bp: 25000, payout_points: 250 });
    expect(await balance(db, top)).toBe(650);
  });

  it('pays the curve between the bars, exactly as the client mirror predicts', async () => {
    const user = await createUser(db, { points: 500 });
    const run = await start(user);
    // Halfway between the bars in score: the benchmark's rep count at a form
    // quality below the reference, so the quality stays inside 0..10000.
    const targetScore = Math.round((run.threshold_score + run.benchmark_score) / 2);
    const reps = run.benchmark_raw;
    const quality = Math.round((targetScore * 100) / reps);
    await submit(user, run.match_id, { reps, quality });
    const result = await settled(run.match_id);
    expect(result.score).toBe(scoreFor(reps, quality));
    expect(result.multiplier_bp).toBe(
      blitzMultiplierBp(result.score, run.threshold_score, run.benchmark_score),
    );
    expect(result.payout_points).toBe(Math.floor((100 * result.multiplier_bp) / 10000));
  });

  it('rates the bar, not the margin: clearing by a mile moves the rating like clearing by a rep', async () => {
    const a = await createRatedUser(db, 'pushups', 1000, { points: 500, matchesPlayed: 10 });
    const b = await createRatedUser(db, 'pushups', 1000, { points: 500, matchesPlayed: 10 });
    const ra = await start(a, true);
    const rb = await start(b, true);
    await submit(a, ra.match_id, { reps: ra.threshold_raw, quality: REFERENCE_QUALITY_BP });
    await submit(b, rb.match_id, { reps: rb.benchmark_raw + 20, quality: 10000 });
    const { rows } = await db.pool.query<{ user_id: string; delta: number }>(
      'SELECT user_id, delta FROM skill_rating_events WHERE match_id = ANY($1)',
      [[ra.match_id, rb.match_id]],
    );
    const byUser = new Map(rows.map(r => [r.user_id, r.delta]));
    expect(byUser.get(a)).toBe(byUser.get(b));
    expect(byUser.get(a)).toBeGreaterThan(0);
  });
});

// ── Streak stages are scores ────────────────────────────────────────────

describe('Streak', () => {
  it('sets stage targets in score units and judges the stage on score', async () => {
    const user = await createUser(db, { points: 500 });
    const started = await rpcRow<{
      pending_match_id: string;
      stage1_target: number;
      reference_quality_bp: number;
      run_id: string;
    }>(db, user, 'SELECT * FROM streak_start($1, $2, $3)', ['pushups', 100, false]);
    expect(started.reference_quality_bp).toBe(REFERENCE_QUALITY_BP);
    // Enough reps at reference form to score the target exactly.
    const reps = Math.ceil((started.stage1_target * 100) / REFERENCE_QUALITY_BP);
    await submit(user, started.pending_match_id, { reps, quality: REFERENCE_QUALITY_BP });
    const view = await rpcRow<{ current_stage: number; state: string }>(
      db,
      user,
      'SELECT * FROM streak_preview($1)',
      ['pushups'],
    );
    expect(view.state).toBe('active');
    expect(view.current_stage).toBe(2);
  });
});

// ── the featured pooled competition ─────────────────────────────────────

describe('pooled competition', () => {
  it('opens one on first look, and every look sees the same one until it fills', async () => {
    const a = await createUser(db, { points: 500 });
    const b = await createUser(db, { points: 500 });
    const first = await featured(a);
    expect(first.entries).toBe(0);
    expect(first.entry_fee).toBe(POOL_ENTRY_FEE);
    expect(first.max_entries).toBe(POOL_MAX_ENTRIES);
    expect(first.pool_points).toBe(0);
    expect(first.max_pool_points).toBe(POOL_ENTRY_FEE * POOL_MAX_ENTRIES);
    expect(first.entered).toBe(false);
    expect(first.prize_shares_bp).toEqual([...POOL_PRIZE_SHARES_BP]);
    const again = await featured(b);
    expect(again.id).toBe(first.id);

    const { rows } = await db.pool.query<{ format: string; max_participants: number; status: string; is_ranked: boolean }>(
      'SELECT c.format, c.max_participants, c.status, c.is_ranked FROM challenges c WHERE c.id = (SELECT challenge_id FROM pooled_competitions WHERE id = $1)',
      [first.id],
    );
    expect(rows[0]).toEqual({ format: 'pooled', max_participants: POOL_MAX_ENTRIES, status: 'matched', is_ranked: false });
  });

  it('entering pays the fee, takes a seat, opens the round, and refuses a second seat', async () => {
    const user = await createUser(db, { points: 500 });
    const before = await featured(user);
    const entered = await enterPool(user);
    expect(entered.id).toBe(before.id);
    expect(entered.entries).toBe(before.entries + 1);
    expect(entered.entered).toBe(true);
    expect(entered.played).toBe(false);
    expect(entered.pool_points).toBe(entered.entries * POOL_ENTRY_FEE);
    expect(await balance(db, user)).toBe(400);
    await expect(enterPool(user)).rejects.toThrow(/round_open|pool_already_entered/);
    // Play the round: the seat is now played, and the entry stands.
    await submit(user, entered.match_id, { reps: 20 });
    const after = await featured(user);
    expect(after.id).toBe(before.id);
    expect(after.played).toBe(true);
  });

  it('fills, settles on the last score, pays 50 / 30 / 20 by place, and moves on to the next', async () => {
    // Drain whatever seats earlier tests took, with fighters who play at once.
    let comp = await featured(await createUser(db, { points: 500 }));
    const fillers: string[] = [];
    while (comp.entries < comp.max_entries - 3) {
      const u = await createUser(db, { points: 500 });
      const e = await enterPool(u);
      await submit(u, e.match_id, { reps: 1 });
      fillers.push(u);
      comp = await featured(u);
    }
    expect(comp.entries).toBe(comp.max_entries - 3);

    // The three who matter: gold, silver, bronze by score.
    const gold = await createUser(db, { points: 500 });
    const silver = await createUser(db, { points: 500 });
    const bronze = await createUser(db, { points: 500 });
    const eg = await enterPool(gold);
    await submit(gold, eg.match_id, { reps: 50, quality: 10000 });
    const es = await enterPool(silver);
    await submit(silver, es.match_id, { reps: 40, quality: 10000 });
    const eb = await enterPool(bronze);
    expect(eb.entries).toBe(eb.max_entries);
    expect(eb.filled_at).not.toBeNull();
    // Filled but the last score is not in: not settled.
    expect((await winnerOf(eb.match_id)).settled_at).toBeNull();
    // The card has moved on to the next competition already.
    const next = await featured(bronze);
    expect(next.id).not.toBe(eb.id);
    expect(next.entries).toBe(0);

    await submit(bronze, eb.match_id, { reps: 30, quality: 10000 });
    const m = await winnerOf(eb.match_id);
    expect(m.settled_at).not.toBeNull();
    expect(m.winner_id).toBe(gold);

    const pot = POOL_ENTRY_FEE * POOL_MAX_ENTRIES;
    expect(await balance(db, gold)).toBe(400 + Math.floor(pot * 0.5));
    expect(await balance(db, silver)).toBe(400 + Math.floor(pot * 0.3));
    expect(await balance(db, bronze)).toBe(400 + Math.floor(pot * 0.2));
    for (const u of fillers) {
      expect(await balance(db, u)).toBe(400);
    }
    expect((await participant(eb.match_id, gold)).place).toBe(1);
    expect((await participant(eb.match_id, silver)).place).toBe(2);
    expect((await participant(eb.match_id, bronze)).place).toBe(3);

    const { rows } = await db.pool.query<{ settled_at: string | null }>(
      'SELECT settled_at FROM pooled_competitions WHERE id = $1',
      [eb.id],
    );
    expect(rows[0]!.settled_at).not.toBeNull();

    // The ledger over the whole competition is zero-sum.
    const { rows: net } = await db.pool.query<{ n: number }>(
      'SELECT sum(amount)::int AS n FROM points_ledger_entries WHERE match_id = $1',
      [eb.match_id],
    );
    expect(net[0]!.n).toBe(0);
  });

  it('refuses entry without the fee, and refuses a fighter with a round still open', async () => {
    const broke = await createUser(db, { points: 40 });
    await expect(enterPool(broke)).rejects.toThrow(/insufficient_points/);
    expect(await balance(db, broke)).toBe(40);

    const busy = await createUser(db, { points: 500 });
    await rpcRow(db, busy, 'SELECT * FROM blitz_start($1, $2, $3)', ['pushups', 100, false]);
    await expect(enterPool(busy)).rejects.toThrow(/round_open/);
  });

  it('is readable by any signed-in fighter and writable by none', async () => {
    const user = await createUser(db, { points: 500 });
    await featured(user);
    const { rows } = await asUser(db, user, client =>
      client.query('SELECT id FROM pooled_competitions'),
    );
    expect(rows.length).toBeGreaterThan(0);
    await expect(
      asUser(db, user, client =>
        client.query(
          `INSERT INTO pooled_competitions
             (exercise_type, title, description, entry_fee, max_entries, challenge_id, match_id)
           VALUES ('pushups', 'x', 'x', 100, 6, gen_random_uuid(), gen_random_uuid())`,
        ),
      ),
    ).rejects.toThrow();
  });
});
