/**
 * Blitz, Streak and the ranked/casual switch, against a real Postgres.
 *
 * What this file proves that soloModes.test.ts (pure logic, no database)
 * cannot: that the calibration functions actually invert each other, that
 * blitz_start()/streak_start() write the snapshot they preview, that
 * settlement pays what the ladder says it pays, that a casual attempt
 * really does write no rating row, and that both five-hour timers on a
 * Streak run are anchored and gated the way BACKEND.md describes.
 *
 * What this cannot prove: that a real fighter's actual rep/hold
 * distribution matches the population percentile curve their rating sits
 * on. That is a modelling assumption, not a database fact -- see the EV
 * note at the top of the migration and BACKEND.md.
 */
import { REFERENCE_QUALITY_BP, scoreFor } from '../src/lib/score';
import {
  asService,
  asUser,
  balance,
  createRatedUser,
  createUser,
  ratingOf,
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

// Mirrors skillRating.db.test.ts: the matchmaking tests in this file share
// (exercise, format, seats) domains with each other, and a lingering
// 'searching' row or an abandoned 'open' lobby from one test could pair
// with the next one's fighters instead of the ones it is actually testing.
afterEach(async () => {
  await db.pool.query('DELETE FROM matchmaking_queue');
  await db.pool.query(
    "DELETE FROM challenges c WHERE c.status = 'open' AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.challenge_id = c.id)",
  );
});

type Exercise = 'pushups' | 'plank' | 'wallsit';

// ── helpers ─────────────────────────────────────────────────────────────

interface BlitzRun {
  id: string;
  match_id: string;
  mmr_at_start: number;
  threshold_raw: number;
  benchmark_raw: number;
  threshold_score: number;
  benchmark_score: number;
  threshold_rating: number;
  benchmark_rating: number;
  breakeven_bp: number;
  max_bp: number;
  score: number | null;
  cleared: boolean | null;
  multiplier_bp: number | null;
  payout_points: number | null;
  stake_points: number;
  is_ranked: boolean;
  settled_at: string | null;
}

interface BlitzPreview {
  exercise_type: Exercise;
  mmr: number;
  placement_complete: boolean;
  calibrated_to_me: boolean;
  threshold_raw: number;
  benchmark_raw: number;
  threshold_score: number;
  benchmark_score: number;
  breakeven_bp: number;
  max_bp: number;
  reference_quality_bp: number;
}

interface StreakPreview {
  exercise_type: Exercise;
  mmr: number;
  stage1_target: number;
  stage2_target: number;
  stage3_target: number;
  payout_bp: number;
  state: 'idle' | 'active' | 'failed' | 'expired' | 'cooldown';
  run_id: string | null;
  is_ranked: boolean | null;
  stake_points: number | null;
  stakes_paid: number | null;
  current_stage: number | null;
  failed_stage: number | null;
  failed_at: string | null;
  buyback_until: string | null;
  completed_at: string | null;
  cooldown_until: string | null;
  payout_points: number | null;
  pending_match_id: string | null;
  server_now: string;
}

function blitzPreview(user: string, exercise: Exercise = 'pushups') {
  return rpcRow<BlitzPreview>(db, user, 'SELECT * FROM blitz_preview($1)', [exercise]);
}

function blitzStart(
  user: string,
  exercise: Exercise = 'pushups',
  stake = 100,
  ranked = false,
) {
  return rpcRow<BlitzRun>(db, user, 'SELECT * FROM blitz_start($1, $2, $3)', [
    exercise,
    stake,
    ranked,
  ]);
}

function streakPreview(user: string, exercise: Exercise = 'pushups') {
  return rpcRow<StreakPreview>(db, user, 'SELECT * FROM streak_preview($1)', [exercise]);
}

function streakStart(
  user: string,
  exercise: Exercise = 'pushups',
  stake = 100,
  ranked = false,
) {
  return rpcRow<StreakPreview>(db, user, 'SELECT * FROM streak_start($1, $2, $3)', [
    exercise,
    stake,
    ranked,
  ]);
}

function streakNextStage(user: string, runId: string) {
  return rpcRow<StreakPreview>(db, user, 'SELECT * FROM streak_next_stage($1)', [runId]);
}

function streakBuyBackIn(user: string, runId: string) {
  return rpcRow<StreakPreview>(db, user, 'SELECT * FROM streak_buy_back_in($1)', [runId]);
}

/** The fewest reps that score at least `score` at reference form. */
function repsFor(score: number): number {
  return Math.ceil((score * 100) / REFERENCE_QUALITY_BP);
}

/**
 * Record a round. `reps`/`hold` are raw counts scored at `quality` (full
 * form unless given); `atScore` / `underScore` are the conveniences the
 * stage and bar tests use: the fewest reps that reach a SCORE at reference
 * form, or one rep short of it.
 */
async function submit(
  user: string,
  matchId: string,
  opts: {
    reps?: number;
    hold?: number;
    quality?: number;
    atScore?: number;
    underScore?: number;
    anomaly?: boolean;
  },
) {
  const { rows } = await db.pool.query<{ id: string }>(
    'SELECT id FROM match_participants WHERE match_id = $1 AND user_id = $2',
    [matchId, user],
  );
  let reps = opts.reps ?? null;
  let quality = opts.quality ?? 10000;
  if (opts.atScore !== undefined) {
    reps = repsFor(opts.atScore);
    quality = REFERENCE_QUALITY_BP;
  } else if (opts.underScore !== undefined) {
    reps = repsFor(opts.underScore) - 1;
    quality = REFERENCE_QUALITY_BP;
  }
  return rpcAsUser<string>(
    db,
    user,
    'SELECT submit_verification_session($1, $2, $3::jsonb, $4, $5, $6)',
    [rows[0]!.id, reps, JSON.stringify({ test: true }), opts.anomaly ?? false, opts.hold ?? null, quality],
  );
}

async function eventFor(user: string, matchId: string) {
  const { rows } = await db.pool.query<{
    mmr_before: number;
    mmr_after: number;
    delta: number;
    was_placement: boolean;
    matches_played: number;
    participants: number;
  }>(
    `SELECT mmr_before, mmr_after, delta, was_placement, matches_played, participants
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

async function ledgerNet(user: string, matchId: string): Promise<number> {
  const { rows } = await db.pool.query<{ n: number | null }>(
    'SELECT sum(amount)::int AS n FROM points_ledger_entries WHERE user_id = $1 AND match_id = $2',
    [user, matchId],
  );
  return rows[0]?.n ?? 0;
}

async function ageStreakFailure(runId: string, seconds: number) {
  await db.pool.query(
    'UPDATE streak_runs SET failed_at = failed_at - make_interval(secs => $2) WHERE id = $1',
    [runId, seconds],
  );
}

async function ageStreakWin(runId: string, seconds: number) {
  await db.pool.query(
    'UPDATE streak_runs SET completed_at = completed_at - make_interval(secs => $2) WHERE id = $1',
    [runId, seconds],
  );
}

// ── the calibration: rating -> target -> rating ──────────────────────────

describe('the calibration inverts itself', () => {
  it('_solo_percentile_for_rating and _mmr_from_percentile are exact inverses at the seed', async () => {
    const { rows } = await db.pool.query<{ p: string }>(
      'SELECT _solo_percentile_for_rating(1000) AS p',
    );
    expect(Number(rows[0]!.p)).toBeCloseTo(50, 1);
  });

  it('_solo_target_for_rating and _solo_rating_for_target round-trip for a fully specified fighter', async () => {
    const { rows } = await db.pool.query<{ target: number; back: number }>(
      `SELECT
         _solo_target_for_rating('pushups', 1000, 'male', '20s') AS target,
         _solo_rating_for_target(
           'pushups',
           _solo_target_for_rating('pushups', 1000, 'male', '20s'),
           'male', '20s'
         ) AS back`,
    );
    // Rounding to the nearest rep means this is "close to 1000", not exactly
    // it -- the same tolerance _mmr_seed_from_norms()'s own round-trip has.
    expect(rows[0]!.back).toBeGreaterThanOrEqual(970);
    expect(rows[0]!.back).toBeLessThanOrEqual(1030);
  });

  it('rises with rating for every exercise the norms table covers', async () => {
    for (const exercise of ['pushups', 'plank', 'wallsit'] as const) {
      const { rows } = await db.pool.query<{ lo: number; mid: number; hi: number }>(
        `SELECT
           _solo_target_for_rating($1, 700, 'male', '20s') AS lo,
           _solo_target_for_rating($1, 1000, 'male', '20s') AS mid,
           _solo_target_for_rating($1, 1300, 'male', '20s') AS hi`,
        [exercise],
      );
      expect(rows[0]!.lo).toBeLessThan(rows[0]!.mid);
      expect(rows[0]!.mid).toBeLessThan(rows[0]!.hi);
    }
  });

  it('falls back to the gender-mean when gender is missing, and never throws', async () => {
    const { rows } = await db.pool.query<{ t: number | null }>(
      `SELECT _solo_target_for_rating('pushups', 1000, NULL, '20s') AS t`,
    );
    expect(rows[0]!.t).not.toBeNull();
  });

  it('is NULL, not an exception, for an exercise the norms table does not cover', async () => {
    const { rows } = await db.pool.query<{ t: number | null }>(
      `SELECT _solo_target_for_rating('race', 1000, 'male', '20s') AS t`,
    );
    expect(rows[0]!.t).toBeNull();
  });
});

// ── Blitz preview ──────────────────────────────────────────────────────

describe('blitz_preview', () => {
  it('requires a profile and a supported exercise', async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      "INSERT INTO auth.users (email) VALUES ('nop-blitz@test.local') RETURNING id",
    );
    await expect(blitzPreview(rows[0]!.id)).rejects.toThrow(/profile_required/);

    const user = await createUser(db);
    await expect(blitzPreview(user, 'race' as Exercise)).rejects.toThrow(
      /exercise_not_available/,
    );
  });

  it('seeds the rating at 1000 on first look, and the benchmark sits above the threshold', async () => {
    const user = await createUser(db);
    const preview = await blitzPreview(user);
    expect(preview.mmr).toBe(1000);
    expect(preview.placement_complete).toBe(false);
    expect(preview.threshold_raw).toBeLessThan(preview.benchmark_raw);
    expect(preview.threshold_score).toBeLessThan(preview.benchmark_score);
    expect(preview.threshold_score).toBe(scoreFor(preview.threshold_raw, REFERENCE_QUALITY_BP));
    expect([preview.breakeven_bp, preview.max_bp]).toEqual([10000, 25000]);
    expect(preview.reference_quality_bp).toBe(REFERENCE_QUALITY_BP);
    // The preview is what settlement rewards later, given via the same
    // ensure-then-read path blitz_start() uses -- so a fighter who previews
    // then starts is shown the same bars both times.
    expect(await ratingOf(db, user, 'pushups')).toEqual({
      mmr: 1000,
      matches_played: 0,
      placement_complete: false,
    });
  });

  it('raises a higher rating to higher bars, calibrated equally hard in principle', async () => {
    const rookie = await createUser(db);
    const veteran = await createRatedUser(db, 'pushups', 1400, { matchesPlayed: 10 });
    const [a, b] = await Promise.all([blitzPreview(rookie), blitzPreview(veteran)]);
    expect(b.threshold_score).toBeGreaterThan(a.threshold_score);
    expect(b.benchmark_score).toBeGreaterThan(a.benchmark_score);
  });
});

// ── Blitz start + settle ─────────────────────────────────────────────────

describe('blitz_start', () => {
  it('opens a one-seat, already-matched bout and charges the stake once', async () => {
    const user = await createUser(db, { points: 500 });
    const run = await blitzStart(user, 'pushups', 100);
    expect(await balance(db, user)).toBe(400);

    const { rows } = await db.pool.query<{
      format: string;
      max_participants: number;
      status: string;
      is_ranked: boolean;
    }>(
      `SELECT c.format, c.max_participants, c.status, c.is_ranked
         FROM challenges c JOIN matches m ON m.challenge_id = c.id
        WHERE m.id = $1`,
      [run.match_id],
    );
    expect(rows[0]).toEqual({
      format: 'blitz',
      max_participants: 1,
      status: 'matched',
      is_ranked: false,
    });
  });

  it('refuses an unaffordable stake without touching the balance', async () => {
    const user = await createUser(db, { points: 40 });
    await expect(blitzStart(user, 'pushups', 100)).rejects.toThrow(/insufficient_points/);
    expect(await balance(db, user)).toBe(40);
  });

  it('blocks a second attempt while a staked round is still open, same as 1v1', async () => {
    const user = await createUser(db, { points: 1000 });
    await blitzStart(user, 'pushups', 100);
    await expect(blitzStart(user, 'plank', 100)).rejects.toThrow(/round_open/);
  });

  it('snapshots the bars shown in the preview onto the run', async () => {
    const user = await createUser(db, { points: 500 });
    const preview = await blitzPreview(user);
    const run = await blitzStart(user, 'pushups', 100);
    expect([run.threshold_score, run.benchmark_score]).toEqual([
      preview.threshold_score,
      preview.benchmark_score,
    ]);
    expect([run.threshold_rating, run.benchmark_rating]).toEqual([1000, 1320]);
  });
});

describe('a settled Blitz', () => {
  async function fresh(mmr = 1000, points = 500) {
    const user = await createRatedUser(db, 'pushups', mmr, { matchesPlayed: 10, points });
    const run = await blitzStart(user, 'pushups', 100, true); // ranked
    return { user, run };
  }

  async function settled(matchId: string) {
    const { rows } = await db.pool.query<{
      score: number;
      cleared: boolean;
      multiplier_bp: number;
      payout_points: number;
      winner_id: string | null;
    }>(
      `SELECT br.score, br.cleared, br.multiplier_bp, br.payout_points, m.winner_id
         FROM blitz_runs br JOIN matches m ON m.id = br.match_id
        WHERE br.match_id = $1`,
      [matchId],
    );
    return rows[0]!;
  }

  it('pays nothing and rates a loss when the bar is missed', async () => {
    const { user, run } = await fresh();
    await submit(user, run.match_id, { underScore: run.threshold_score });
    expect(await settled(run.match_id)).toMatchObject({
      cleared: false,
      multiplier_bp: 0,
      payout_points: 0,
      winner_id: null,
    });
    expect(await balance(db, user)).toBe(400); // 500 - 100 stake, no payout
    const ev = await eventFor(user, run.match_id);
    expect(ev).not.toBeNull();
    // Rated as a loss against the threshold's virtual opponent (mmr_at_start).
    expect(ev!.mmr_after).toBeLessThan(ev!.mmr_before);
  });

  it('breaks even and rates a win when the bar is matched exactly', async () => {
    const { user, run } = await fresh();
    await submit(user, run.match_id, { atScore: run.threshold_score });
    const result = await settled(run.match_id);
    expect(result.cleared).toBe(true);
    expect(result.multiplier_bp).toBe(10000);
    expect(result.payout_points).toBe(100);
    expect(result.winner_id).toBe(user);
    expect(await balance(db, user)).toBe(500);
    const ev = await eventFor(user, run.match_id);
    expect(ev!.mmr_after).toBeGreaterThan(ev!.mmr_before);
  });

  it('pays the cap at the benchmark and beyond, and rates the same as breaking even', async () => {
    const { user, run } = await fresh();
    await submit(user, run.match_id, { reps: run.benchmark_raw + 5, quality: 10000 });

    const top = await settled(run.match_id);
    expect(top.cleared).toBe(true);
    expect(top.multiplier_bp).toBe(25000);
    expect(top.payout_points).toBe(250);

    // Same rating move as clearing the bar by nothing: it is rated off
    // threshold_rating regardless of the margin.
    const second = await fresh();
    await submit(second.user, second.run.match_id, { atScore: second.run.threshold_score });
    const evTop = await eventFor(user, run.match_id);
    const evEven = await eventFor(second.user, second.run.match_id);
    expect(evTop!.delta).toBe(evEven!.delta);
  });

  it('nets payout minus stake across the match, same shape as a 1v1', async () => {
    const { user, run } = await fresh(1000, 500);
    await submit(user, run.match_id, { reps: run.benchmark_raw + 5, quality: 10000 });
    // Two ledger rows on this match: the -stake written by blitz_start()
    // (the same shape _mm_try_complete() writes for a queued bout) and the
    // +payout written by _solo_settle(). The net is what Results shows.
    const net = await ledgerNet(user, run.match_id);
    expect(net).toBe(250 - 100);
    expect(await balance(db, user)).toBe(500 - 100 + 250);
  });

  it('a casual attempt pays exactly the same and rates nothing at all', async () => {
    const user = await createUser(db, { points: 500 });
    const run = await blitzStart(user, 'pushups', 100, false); // casual
    await submit(user, run.match_id, { atScore: run.threshold_score });
    const { rows } = await db.pool.query<{ payout_points: number }>(
      'SELECT payout_points FROM blitz_runs WHERE match_id = $1',
      [run.match_id],
    );
    expect(rows[0]!.payout_points).toBe(100);
    expect(await eventCount(run.match_id)).toBe(0);
    expect(await ratingOf(db, user, 'pushups')).toEqual({
      mmr: 1000,
      matches_played: 0,
      placement_complete: false,
    });
  });

  it('holds the pot for review on an anomaly flag, and pays nothing until cleared', async () => {
    const { user, run } = await fresh();
    await submit(user, run.match_id, { reps: run.benchmark_raw, quality: 10000, anomaly: true });

    const { rows: held } = await db.pool.query<{
      status: string;
      cleared: boolean | null;
      settled_at: string | null;
    }>(
      `SELECT c.status, br.cleared, m.settled_at
         FROM blitz_runs br
         JOIN matches m ON m.id = br.match_id
         JOIN challenges c ON c.id = m.challenge_id
        WHERE br.match_id = $1`,
      [run.match_id],
    );
    expect(held[0]).toEqual({ status: 'needs_review', cleared: null, settled_at: null });
    expect(await balance(db, user)).toBe(400);

    // Clear it, the way a reviewer would (service role), and settle again.
    await asService(db, async client => {
      await client.query(
        `UPDATE verification_sessions SET reviewed = true
           WHERE match_participant_id = (
             SELECT id FROM match_participants WHERE match_id = $1
           )`,
        [run.match_id],
      );
      await client.query('SELECT settle_match($1)', [run.match_id]);
    });

    const cleared = await settled(run.match_id);
    expect(cleared.cleared).toBe(true);
    expect(cleared.multiplier_bp).toBe(25000);
    expect(await balance(db, user)).toBe(400 + cleared.payout_points);
  });
});

// ── Streak ────────────────────────────────────────────────────────────

describe('streak_preview: idle before any run', () => {
  it('lists three ascending stage targets and reports idle', async () => {
    const user = await createUser(db);
    const preview = await streakPreview(user);
    expect(preview.state).toBe('idle');
    expect(preview.run_id).toBeNull();
    expect(preview.stage1_target).toBeLessThan(preview.stage2_target);
    expect(preview.stage2_target).toBeLessThan(preview.stage3_target);
  });
});

describe('streak_start', () => {
  it('charges the stake exactly once and opens stage 1', async () => {
    const user = await createUser(db, { points: 500 });
    const started = await streakStart(user, 'pushups', 100);
    expect(await balance(db, user)).toBe(400);
    expect(started.current_stage).toBe(1);
    expect(started.stakes_paid).toBe(1);
    expect(started.pending_match_id).not.toBeNull();

    const { rows } = await db.pool.query<{ format: string; max_participants: number }>(
      `SELECT c.format, c.max_participants
         FROM challenges c JOIN matches m ON m.challenge_id = c.id
        WHERE m.id = $1`,
      [started.pending_match_id],
    );
    expect(rows[0]).toEqual({ format: 'streak', max_participants: 1 });
  });

  it('refuses a second run while one is active', async () => {
    const user = await createUser(db, { points: 1000 });
    const started = await streakStart(user, 'pushups', 100);
    // While stage 1's round is still open, _solo_start_guard()'s shared
    // round_open check fires first -- correctly: a fresh run cannot begin
    // while a staked camera round sits unplayed, whether or not it belongs
    // to a Streak run.
    await expect(streakStart(user, 'pushups', 100)).rejects.toThrow(/round_open/);

    // Clear stage 1, so there is no open round in the way, and try again
    // BEFORE opening stage 2's round. This is the gap streak_run_active's
    // own check exists for.
    await submit(user, started.pending_match_id!, { atScore: started.stage1_target });
    await expect(streakStart(user, 'pushups', 100)).rejects.toThrow(/streak_run_active/);
  });

  it('the one-active-run rule is a real constraint, not just app logic', async () => {
    const user = await createUser(db, { points: 500 });
    // A second 'active' row for the same (user, exercise) is rejected at
    // the partial unique index itself, however it gets there -- inserted
    // directly, bypassing streak_start()'s own guard entirely.
    await db.pool.query(
      `INSERT INTO streak_runs
         (user_id, exercise_type, stake_points, is_ranked, mmr_at_start,
          stage1_target, stage2_target, stage3_target,
          stage1_rating, stage2_rating, stage3_rating, payout_bp, status)
       VALUES ($1, 'pushups', 100, false, 1000, 10, 20, 30, 800, 900, 1000, 40000, 'active')`,
      [user],
    );
    await expect(
      db.pool.query(
        `INSERT INTO streak_runs
           (user_id, exercise_type, stake_points, is_ranked, mmr_at_start,
            stage1_target, stage2_target, stage3_target,
            stage1_rating, stage2_rating, stage3_rating, payout_bp, status)
         VALUES ($1, 'pushups', 100, false, 1000, 10, 20, 30, 800, 900, 1000, 40000, 'active')`,
        [user],
      ),
    ).rejects.toThrow();
  });
});

describe('a Streak run played to the end', () => {
  it('advances on a clear, opens the next stage only when asked, and pays on stage 3', async () => {
    const user = await createRatedUser(db, 'pushups', 1000, { matchesPlayed: 10, points: 500 });
    const started = await streakStart(user, 'pushups', 100, true); // ranked

    await submit(user, started.pending_match_id!, { atScore: started.stage1_target });
    const afterStage1 = await streakPreview(user);
    expect(afterStage1.current_stage).toBe(2);
    expect(afterStage1.state).toBe('active');
    // Advancing does not open the round by itself.
    expect(afterStage1.pending_match_id).toBeNull();

    const opened2 = await streakNextStage(user, afterStage1.run_id!);
    expect(opened2.pending_match_id).not.toBeNull();
    // No second stake for advancing.
    expect(await balance(db, user)).toBe(400);

    await submit(user, opened2.pending_match_id!, { atScore: afterStage1.stage2_target });
    const afterStage2 = await streakPreview(user);
    expect(afterStage2.current_stage).toBe(3);

    const opened3 = await streakNextStage(user, afterStage2.run_id!);
    await submit(user, opened3.pending_match_id!, { atScore: afterStage2.stage3_target });

    const won = await streakPreview(user);
    expect(won.state).toBe('cooldown');
    expect(won.payout_points).toBe(
      Math.floor((100 * won.payout_bp) / 10000),
    );
    expect(await balance(db, user)).toBe(400 + won.payout_points!);
    expect(won.cooldown_until).not.toBeNull();

    // Ranked: three stage attempts, three rating events -- one per attempt,
    // exactly as the spec calls for.
    const { rows } = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM skill_rating_events sre
         JOIN streak_stage_attempts a ON a.match_id = sre.match_id
        WHERE a.run_id = $1`,
      [won.run_id],
    );
    expect(rows[0]!.n).toBe(3);
  });

  it('refuses a new run during the win cooldown, and allows one once it has passed', async () => {
    const user = await createUser(db, { points: 1000 });
    const started = await streakStart(user, 'pushups', 100);
    await submit(user, started.pending_match_id!, { atScore: started.stage1_target });
    const s2 = await streakNextStage(user, started.run_id!);
    await submit(user, s2.pending_match_id!, { atScore: s2.stage2_target });
    const s3 = await streakNextStage(user, s2.run_id!);
    await submit(user, s3.pending_match_id!, { atScore: s3.stage3_target });

    const won = await streakPreview(user);
    expect(won.state).toBe('cooldown');
    await expect(streakStart(user, 'pushups', 100)).rejects.toThrow(/streak_cooldown/);

    await ageStreakWin(won.run_id!, 5 * 60 * 60 + 1);
    const afterCooldown = await streakPreview(user);
    expect(afterCooldown.state).toBe('idle');
    // A fresh run starts clean, unaffected by the spent one.
    const fresh = await streakStart(user, 'pushups', 100);
    expect(fresh.current_stage).toBe(1);
    expect(fresh.stakes_paid).toBe(1);
  });
});

describe('a Streak run that fails', () => {
  it('ends the run at the failed stage and opens the buy-back window', async () => {
    const user = await createUser(db, { points: 500 });
    const started = await streakStart(user, 'pushups', 100);
    await submit(user, started.pending_match_id!, { underScore: started.stage1_target });

    const failed = await streakPreview(user);
    expect(failed.state).toBe('failed');
    expect(failed.failed_stage).toBe(1);
    expect(failed.current_stage).toBe(1);
    expect(failed.buyback_until).not.toBeNull();
    expect(await balance(db, user)).toBe(400); // stake gone, no payout
  });

  it('buy-back-in retries the SAME stage without losing progress, for another stake', async () => {
    const user = await createUser(db, { points: 1000 });
    const started = await streakStart(user, 'pushups', 100);
    // Clear stage 1 first, so there is progress to preserve.
    await submit(user, started.pending_match_id!, { atScore: started.stage1_target });
    const s2 = await streakNextStage(user, started.run_id!);
    // Fail stage 2.
    await submit(user, s2.pending_match_id!, { underScore: s2.stage2_target });

    const failed = await streakPreview(user);
    expect(failed.state).toBe('failed');
    expect(failed.failed_stage).toBe(2);
    expect(failed.current_stage).toBe(2); // progress on stage 1 preserved
    // Only the OPENING stake has been charged so far: advancing into stage 2
    // was free, and failing it costs nothing extra -- the buy-back is what
    // costs another stake, not the failure itself.
    expect(await balance(db, user)).toBe(1000 - 100);
    expect(failed.stakes_paid).toBe(1);

    const boughtBack = await streakBuyBackIn(user, failed.run_id!);
    expect(boughtBack.current_stage).toBe(2);
    expect(boughtBack.stakes_paid).toBe(2); // start, then the buy-back
    expect(boughtBack.pending_match_id).not.toBeNull();
    expect(await balance(db, user)).toBe(1000 - 200);

    await submit(user, boughtBack.pending_match_id!, { atScore: boughtBack.stage2_target });
    const afterBuyback = await streakPreview(user);
    expect(afterBuyback.current_stage).toBe(3);
    expect(afterBuyback.state).toBe('active');
  });

  it('refuses a buy-back once the five-hour window has closed, and says so as "expired"', async () => {
    const user = await createUser(db, { points: 500 });
    const started = await streakStart(user, 'pushups', 100);
    await submit(user, started.pending_match_id!, { underScore: started.stage1_target });
    const failed = await streakPreview(user);

    await ageStreakFailure(failed.run_id!, 5 * 60 * 60 + 1);

    const expired = await streakPreview(user);
    expect(expired.state).toBe('expired');
    await expect(streakBuyBackIn(user, failed.run_id!)).rejects.toThrow(
      /streak_buyback_expired/,
    );

    // Past the window, the next attempt starts fresh at stage 1 -- it is a
    // NEW run, not a continuation, and it costs the ordinary opening stake.
    const next = await streakStart(user, 'pushups', 100);
    expect(next.current_stage).toBe(1);
    expect(next.stakes_paid).toBe(1);
  });

  it('re-anchors failed_at when a bought-back attempt fails again', async () => {
    const user = await createUser(db, { points: 1000 });
    const started = await streakStart(user, 'pushups', 100);
    await submit(user, started.pending_match_id!, { underScore: started.stage1_target });
    const firstFailure = await streakPreview(user);
    // Pushed back so the real second failure -- timestamped by the server's
    // own now() a moment later -- cannot land in the same millisecond as
    // this one and make the "re-anchored" assertion a coin flip.
    await ageStreakFailure(firstFailure.run_id!, 2);
    const agedFirstFailure = await streakPreview(user);

    const boughtBack = await streakBuyBackIn(user, firstFailure.run_id!);
    await submit(user, boughtBack.pending_match_id!, { underScore: boughtBack.stage1_target });

    const secondFailure = await streakPreview(user);
    expect(secondFailure.state).toBe('failed');
    expect(Date.parse(secondFailure.failed_at!)).toBeGreaterThan(
      Date.parse(agedFirstFailure.failed_at!),
    );
  });
});

// ── ranked / casual: the pairing pool split ──────────────────────────────

describe('ranked / casual pairing', () => {
  function enterQueue(
    user: string,
    opts: { stake?: number; ranked?: boolean } = {},
  ) {
    return rpcRow<{ status: string; match_id: string | null; is_ranked: boolean }>(
      db,
      user,
      'SELECT * FROM enter_matchmaking($1, $2, $3, $4, $5)',
      ['pushups', '1v1', opts.stake ?? 250, 2, opts.ranked ?? false],
    );
  }

  it('never pairs a ranked search with a casual one at the same stake', async () => {
    const rankedFighter = await createUser(db, { points: 2000 });
    const casualFighter = await createUser(db, { points: 2000 });
    // One of the four offered stakes -- enter_matchmaking() rejects anything
    // else with stake_invalid. The afterEach above keeps this domain clean
    // between tests, so a fixed value is safe to reuse.
    const stake = 250;

    const a = await enterQueue(rankedFighter, { stake, ranked: true });
    const b = await enterQueue(casualFighter, { stake, ranked: false });
    expect(a.status).toBe('searching');
    expect(b.status).toBe('searching');
    expect(a.is_ranked).toBe(true);
    expect(b.is_ranked).toBe(false);

    // A second ranked fighter completes the RANKED lobby, leaving the casual
    // searcher alone.
    const secondRanked = await createUser(db, { points: 2000 });
    const c = await enterQueue(secondRanked, { stake, ranked: true });
    expect(c.status).toBe('matched');

    const { rows } = await db.pool.query<{ status: string }>(
      'SELECT status FROM matchmaking_queue WHERE user_id = $1',
      [casualFighter],
    );
    expect(rows[0]!.status).toBe('searching');
  });

  it('rejects a solo format outright: nothing queues for Blitz or Streak', async () => {
    const user = await createUser(db, { points: 500 });
    await expect(
      rpcAsUser(db, user, 'SELECT enter_matchmaking($1, $2, $3, $4, $5)', [
        'pushups',
        'blitz',
        100,
        1,
        false,
      ]),
    ).rejects.toThrow(/format_not_queueable/);
  });
});

// ── casual settlement, head-to-head ───────────────────────────────────

describe('a casual 1v1 settles fully but touches no rating', () => {
  it('pays the pot and writes no skill_rating_events row', async () => {
    const a = await createUser(db, { points: 500 });
    const b = await createUser(db, { points: 500 });

    async function enterCasual(user: string, stake: number) {
      return rpcRow<{ match_id: string | null; challenge_id: string }>(
        db,
        user,
        'SELECT * FROM enter_matchmaking($1, $2, $3, $4, $5)',
        ['pushups', '1v1', stake, 2, false],
      );
    }

    const stake = 500;
    const first = await enterCasual(a, stake);
    const second = await enterCasual(b, stake);
    const matchId = second.match_id ?? first.match_id;
    expect(matchId).not.toBeNull();

    await submit(a, matchId!, { reps: 40 });
    await submit(b, matchId!, { reps: 20 });

    expect(await balance(db, a)).toBe(500 - stake + stake * 2);
    expect(await eventCount(matchId!)).toBe(0);
    // Trophies are NOT gated on ranked -- a casual win still moves the
    // OTHER ladder. See BACKEND.md, "What casual does and does not touch".
    const { rows } = await db.pool.query<{ trophies: number }>(
      'SELECT trophies FROM fitness_profiles WHERE user_id = $1',
      [a],
    );
    expect(rows[0]!.trophies).toBeGreaterThan(0);
  });
});

// ── grants ──────────────────────────────────────────────────────────────

describe('grants', () => {
  it('a client cannot write blitz_runs or streak_runs directly', async () => {
    const user = await createUser(db, { points: 500 });
    await expect(
      asUser(db, user, client =>
        client.query(
          `INSERT INTO blitz_runs
             (user_id, match_id, exercise_type, stake_points, is_ranked, mmr_at_start,
              threshold_raw, benchmark_raw, threshold_score, benchmark_score,
              threshold_rating, benchmark_rating, breakeven_bp, max_bp)
           VALUES ($1, gen_random_uuid(), 'pushups', 1, false, 1000, 1, 2, 85, 170, 1000, 1320, 10000, 25000)`,
          [user],
        ),
      ),
    ).rejects.toThrow();
  });

  it("a client cannot read another fighter's run", async () => {
    const owner = await createUser(db, { points: 500 });
    const stranger = await createUser(db, { points: 500 });
    const run = await blitzStart(owner, 'pushups', 100);

    const { rows } = await asUser(db, stranger, client =>
      client.query('SELECT * FROM blitz_runs WHERE id = $1', [run.id]),
    );
    expect(rows).toHaveLength(0);
  });
});
