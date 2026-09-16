import { supabase } from './supabase';
import { formatSeconds } from './format';
import type {
  BlitzPreviewRow,
  BlitzRunRow,
  ChallengeType,
  RankedMode,
  StreakPreviewRow,
} from '../types/database';

/**
 * The client half of Blitz and Streak, and of the ranked/casual switch.
 *
 * Every mutation is one of five SECURITY DEFINER functions (see the
 * 20260916000100 migration and BACKEND.md); nothing here writes a table, and
 * nothing here decides a threshold, a multiplier or a payout -- the server
 * owns all three, and the run row carries the snapshot it was judged
 * against. What this file does own is display: turning basis points into
 * "2.5x", a target into "25 reps" or "1:45", and a deadline into a
 * countdown.
 *
 * The constants mirror the tunables declared at the top of that migration.
 * If one side changes, change the other -- the same arrangement as
 * HEARTBEAT_MS in matchmaking.ts and K_SETTLED in skillRating.ts, and
 * asserted against the database by __tests__/soloModes.db.test.ts so the two
 * cannot drift quietly.
 */

// ── Tunables, mirrored from SQL ─────────────────────────────────────────

/**
 * Rating offsets for the three Blitz tiers, ascending. Tier 1 is the
 * fighter's own rating: by the Elo definition of a rating, the bar they are
 * a coin flip to clear.
 */
export const BLITZ_TIER_OFFSETS: readonly number[] = [0, 150, 320];

/** What each tier pays, in basis points of the stake. 25000 = 2.5x. */
export const BLITZ_TIER_BP: readonly number[] = [15000, 20000, 25000];

/**
 * Rating offsets for the three Streak stages, ascending. Stage 3's offset is
 * zero, so a run ends on the same bar a Blitz opens with.
 */
export const STREAK_STAGE_OFFSETS: readonly number[] = [-200, -100, 0];

/** What clearing all three stages pays, in basis points of the OPENING stake. */
export const STREAK_PAYOUT_BP = 40000;

/** Stages in one run. Fixed by the mode, not a tunable. */
export const STREAK_STAGES = 3;

/**
 * TIMER 1. How long a failed run can be bought back into, from its failure.
 * Server-authoritative: this value is only used to draw the ring/progress on
 * the countdown, never to decide whether the buy-back is still allowed.
 */
export const STREAK_BUYBACK_WINDOW_MS = 5 * 60 * 60 * 1000;

/**
 * TIMER 2. How long Streak is locked after a WIN, from its completion. A
 * failed run has no cooldown at all -- the buy-back window above is the only
 * clock on it.
 */
export const STREAK_WIN_COOLDOWN_MS = 5 * 60 * 60 * 1000;

// ── RPCs ────────────────────────────────────────────────────────────────

export type SoloResult<T> =
  | { data: T; error: null }
  | { data: null; error: string };

async function rpc<T>(
  fn: string,
  args: Record<string, unknown>,
): Promise<SoloResult<T>> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    return { data: null, error: error.message };
  }
  // PostgREST returns a function declared to return a composite type as one
  // JSON object; kept defensive against the SETOF shape (an array) so a
  // later signature change cannot silently break a screen, exactly as
  // matchmaking.ts's firstRow() is.
  const row = Array.isArray(data) ? (data[0] as T | undefined) ?? null : (data as T | null);
  if (row === null || row === undefined) {
    return { data: null, error: `${fn} returned no row` };
  }
  return { data: row, error: null };
}

/** The Blitz ladder for an exercise. Reads only; stakes nothing. */
export function blitzPreview(
  exerciseType: ChallengeType,
): Promise<SoloResult<BlitzPreviewRow>> {
  return rpc<BlitzPreviewRow>('blitz_preview', { p_exercise: exerciseType });
}

/** Stake it and open the round. The returned run carries the match_id. */
export function blitzStart(
  exerciseType: ChallengeType,
  stake: number,
  mode: RankedMode,
): Promise<SoloResult<BlitzRunRow>> {
  return rpc<BlitzRunRow>('blitz_start', {
    p_exercise: exerciseType,
    p_stake: stake,
    p_is_ranked: mode === 'ranked',
  });
}

/** The run's blitz row, for the Results screen. Null for a non-Blitz match. */
export async function blitzRunForMatch(
  matchId: string,
): Promise<BlitzRunRow | null> {
  const { data } = await supabase
    .from('blitz_runs')
    .select('*')
    .eq('match_id', matchId)
    .maybeSingle();
  return (data ?? null) as BlitzRunRow | null;
}

/**
 * Everything the Streak screens need for one exercise: the ladder, whether a
 * run is live, which stage it is on, whether a buy-back is on offer and for
 * how much longer, and whether a win has the mode locked.
 */
export function streakPreview(
  exerciseType: ChallengeType,
): Promise<SoloResult<StreakPreviewRow>> {
  return rpc<StreakPreviewRow>('streak_preview', { p_exercise: exerciseType });
}

export function streakStart(
  exerciseType: ChallengeType,
  stake: number,
  mode: RankedMode,
): Promise<SoloResult<StreakPreviewRow>> {
  return rpc<StreakPreviewRow>('streak_start', {
    p_exercise: exerciseType,
    p_stake: stake,
    p_is_ranked: mode === 'ranked',
  });
}

/** Open the camera round for the stage the run is already on. No stake. */
export function streakNextStage(
  runId: string,
): Promise<SoloResult<StreakPreviewRow>> {
  return rpc<StreakPreviewRow>('streak_next_stage', { p_run_id: runId });
}

/** Pay another stake to retry the stage that was just failed. */
export function streakBuyBackIn(
  runId: string,
): Promise<SoloResult<StreakPreviewRow>> {
  return rpc<StreakPreviewRow>('streak_buy_back_in', { p_run_id: runId });
}

/**
 * The run behind one stage match, for a screen that arrived with a match id
 * and needs the run. Two reads rather than a nested select: the attempt and
 * the run have separate select-own policies, and a PostgREST embed across
 * them would depend on the FK being exposed.
 */
export async function streakRunIdForMatch(
  matchId: string,
): Promise<{ runId: string; stage: number; attemptNo: number } | null> {
  const { data } = await supabase
    .from('streak_stage_attempts')
    .select('run_id, stage, attempt_no')
    .eq('match_id', matchId)
    .maybeSingle();
  if (!data) {
    return null;
  }
  const row = data as { run_id: string; stage: number; attempt_no: number };
  return { runId: row.run_id, stage: row.stage, attemptNo: row.attempt_no };
}

// ── Error copy ──────────────────────────────────────────────────────────

/**
 * The stable error codes the solo RPCs raise, mapped to copy. Anything else
 * is shown verbatim -- a novel message is a bug worth seeing -- which is the
 * same bargain enterErrorCopy() makes.
 */
export function soloErrorCopy(error: string): string {
  if (error.includes('round_open')) {
    return 'You still have a round to fight. Finish it from In the ring first.';
  }
  if (error.includes('insufficient_points')) {
    return "You don't have that stake. Pick a smaller one.";
  }
  if (error.includes('streak_run_active')) {
    return 'You already have a run going in this exercise.';
  }
  if (error.includes('streak_cooldown')) {
    return 'Streak is cooling down after your win. Come back when the clock runs out.';
  }
  if (error.includes('streak_buyback_expired')) {
    return 'That buy-back window has closed. The next run starts at stage 1.';
  }
  if (error.includes('streak_run_not_failed')) {
    return "That run isn't waiting on a buy-back.";
  }
  if (error.includes('streak_run_not_active')) {
    return 'That run is over.';
  }
  if (error.includes('streak_run_not_found')) {
    return "That run isn't yours, or it's gone.";
  }
  if (error.includes('calibration_unavailable')) {
    return "We can't set your targets for this exercise yet.";
  }
  if (error.includes('exercise_not_available')) {
    return "That exercise isn't on the card yet.";
  }
  if (error.includes('stake_invalid')) {
    return 'Pick one of the offered stakes.';
  }
  if (error.includes('profile_required')) {
    return 'Set up your profile before your first bout.';
  }
  return error;
}

// ── Display ─────────────────────────────────────────────────────────────

/**
 * 25000 -> "2.5x", 20000 -> "2x". Trailing ".0" is dropped so the common
 * multipliers read as whole numbers, which is how the design prints them.
 */
export function fmtMultiplier(basisPoints: number): string {
  const times = basisPoints / 10000;
  const one = times.toFixed(1);
  return `${one.endsWith('.0') ? one.slice(0, -2) : one}x`;
}

/** What a payout of `bp` on `stake` comes to. Mirrors the SQL truncation. */
export function payoutFor(stake: number, basisPoints: number): number {
  return Math.floor((stake * basisPoints) / 10000);
}

/**
 * A target in the exercise's own units: "25" reps, "1:45" for a hold. Same
 * split formatScore() makes, but for a threshold rather than a result -- and
 * without the "—" case, because a threshold is never absent.
 */
export function fmtTarget(target: number, type: ChallengeType): string {
  return type === 'pushups' ? String(target) : formatSeconds(target);
}

/** "REPS" / "SEC" for the unit beside a target. */
export function targetUnit(type: ChallengeType): string {
  return type === 'pushups' ? 'REPS' : 'HOLD';
}

// ── Pure logic (unit-tested in __tests__/soloModes.test.ts) ─────────────

/** One rung of a Blitz ladder, in the order they are shown and cleared. */
export interface BlitzTier {
  /** 1-based, matching blitz_runs' column names and tier_reached. */
  tier: number;
  target: number;
  /** Basis points of the stake. */
  bp: number;
  /** The virtual opponent's rating for this rung. */
  rating: number;
}

/** The three rungs of a preview or a run, as a list. */
export function blitzTiersOf(
  row: Pick<
    BlitzPreviewRow,
    | 'tier1_target'
    | 'tier2_target'
    | 'tier3_target'
    | 'tier1_bp'
    | 'tier2_bp'
    | 'tier3_bp'
    | 'tier1_rating'
    | 'tier2_rating'
    | 'tier3_rating'
  >,
): BlitzTier[] {
  return [
    { tier: 1, target: row.tier1_target, bp: row.tier1_bp, rating: row.tier1_rating },
    { tier: 2, target: row.tier2_target, bp: row.tier2_bp, rating: row.tier2_rating },
    { tier: 3, target: row.tier3_target, bp: row.tier3_bp, rating: row.tier3_rating },
  ];
}

/**
 * Which tier a score has reached: 0 for "not even the first bar". Mirrors
 * _solo_settle()'s CASE exactly, and is what the live counter on the camera
 * screen reads -- so the number on screen mid-set and the number settlement
 * writes come from the same rule stated twice, once per language.
 */
export function tierReachedFor(score: number, tiers: readonly BlitzTier[]): number {
  let reached = 0;
  for (const t of tiers) {
    if (score >= t.target) {
      reached = t.tier;
    }
  }
  return reached;
}

/** The next rung up, or null once the top one is cleared. */
export function nextTierFor(
  score: number,
  tiers: readonly BlitzTier[],
): BlitzTier | null {
  return tiers.find(t => score < t.target) ?? null;
}

/** One stage of a Streak run, in order. */
export interface StreakStage {
  /** 1-based. */
  stage: number;
  target: number;
  rating: number;
}

export function streakStagesOf(
  row: Pick<
    StreakPreviewRow,
    | 'stage1_target'
    | 'stage2_target'
    | 'stage3_target'
    | 'stage1_rating'
    | 'stage2_rating'
    | 'stage3_rating'
  >,
): StreakStage[] {
  return [
    { stage: 1, target: row.stage1_target, rating: row.stage1_rating },
    { stage: 2, target: row.stage2_target, rating: row.stage2_rating },
    { stage: 3, target: row.stage3_target, rating: row.stage3_rating },
  ];
}

/** The target for one stage, or null for a stage number out of range. */
export function stageTargetOf(
  row: Pick<
    StreakPreviewRow,
    'stage1_target' | 'stage2_target' | 'stage3_target'
  >,
  stage: number,
): number | null {
  switch (stage) {
    case 1:
      return row.stage1_target;
    case 2:
      return row.stage2_target;
    case 3:
      return row.stage3_target;
    default:
      return null;
  }
}

/**
 * Milliseconds left on a deadline, measured against the SERVER's clock.
 *
 * Both Streak countdowns are server-decided, and a phone's clock can be
 * minutes out. So the remaining time is (deadline - server_now) at the
 * moment of the read, and the screen's own ticker counts DOWN from that
 * rather than recomputing against Date.now() -- which would show a fighter
 * with a fast clock a window that had already closed, or worse, one that had
 * not. `elapsedMs` is how long the screen has been ticking since the read.
 *
 * Never negative: a closed window is zero, not a negative number some caller
 * has to remember to clamp.
 */
export function remainingMs(
  deadlineIso: string | null,
  serverNowIso: string,
  elapsedMs = 0,
): number {
  if (!deadlineIso) {
    return 0;
  }
  const deadline = Date.parse(deadlineIso);
  const now = Date.parse(serverNowIso);
  if (Number.isNaN(deadline) || Number.isNaN(now)) {
    return 0;
  }
  return Math.max(0, deadline - now - elapsedMs);
}

/**
 * "4h 58m" / "58m 12s" / "0s". Hours and minutes while there is more than an
 * hour to go, minutes and seconds under it: a five-hour window needs no
 * second hand, and the last minute of one needs nothing else.
 */
export function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

/**
 * 0..1 of a window still to run, for a progress ring. Returns 0 for a
 * window that has closed and 1 for one that has only just opened.
 */
export function windowProgress(remaining: number, whole: number): number {
  if (whole <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, remaining / whole));
}
