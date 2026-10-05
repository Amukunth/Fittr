import { fmtPoints, formatSeconds } from './format';
import type { ChallengeType } from '../types/database';

/**
 * The score, and the client half of everything that reads it.
 *
 *   score = round(valid_raw * form_quality_bp / 100)
 *
 * valid_raw is the rep count or hold seconds that already cleared the
 * validity bar (the 0.6 / 0.3 hysteresis in the SDK's rep counter and in
 * holdTracker.ts); form_quality_bp is the mean pose probability across the
 * valid portion of the set, in basis points. So 30 reps at 85% form score
 * 2550, and 26 reps at 100% form score 2600 and beat them.
 *
 * The SERVER computes the stored score inside submit_verification_session
 * from the raw count and the quality the client reports; this file mirrors
 * the arithmetic so the live HUD, the pre-bout screens and the Results tape
 * show the same number settlement will use. The constants mirror the
 * tunables declared at the top of the 20260919000000 migration and are
 * asserted equal to the SQL in __tests__/score.db.test.ts, so the two
 * cannot drift quietly.
 */

/** Basis points: 10000 = every valid rep hit pose probability 1.0. */
export const QUALITY_SCALE_BP = 10000;

/**
 * Mirrors _score_reference_quality_bp(). The form quality a calibrated raw
 * target is converted to a score at, and what a submission without a
 * reading is scored at. A placeholder until real sessions say otherwise --
 * see BACKEND.md, "Score-based settlement".
 */
export const REFERENCE_QUALITY_BP = 8500;

/** Mirrors _blitz_breakeven_bp() / _blitz_max_bp(): 1.0x at the threshold, 2.5x at the benchmark. */
export const BLITZ_BREAKEVEN_BP = 10000;
export const BLITZ_MAX_BP = 25000;

/** Mirrors _solo_blitz_benchmark_offset(): the benchmark's rating offset above the fighter's own. */
export const BLITZ_BENCHMARK_OFFSET = 320;

// ── The arithmetic ─────────────────────────────────────────────────────

/** Mirrors _score_for(). round(), not floor(): 30 * 8537 / 100 = 2561.1 -> 2561. */
export function scoreFor(raw: number, qualityBp: number): number {
  return Math.round((raw * qualityBp) / 100);
}

/** Mirrors _score_at_reference(): a raw target as the score it is worth at reference form. */
export function scoreAtReference(raw: number, referenceBp: number = REFERENCE_QUALITY_BP): number {
  return scoreFor(raw, referenceBp);
}

/**
 * The raw count a score amounts to at reference form, rounded UP: "about
 * 30 reps" for 2550 at 85%. Display only -- the comparison is on the score.
 */
export function rawAtReference(score: number, referenceBp: number = REFERENCE_QUALITY_BP): number {
  if (referenceBp <= 0) {
    return 0;
  }
  return Math.ceil((score * 100) / referenceBp);
}

/**
 * The form quality a recorded (raw, score) pair implies, as a whole
 * percentage: score / raw, since score = raw * quality% by construction.
 * Null for an empty set, where there was no form to have.
 */
export function formPctOf(raw: number | null, score: number | null): number | null {
  if (raw === null || score === null || raw <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(score / raw)));
}

// ── Display ────────────────────────────────────────────────────────────

/** "2,550", or "—" for nothing yet. Same grouping as points. */
export function fmtScore(score: number | null): string {
  return score === null ? '—' : fmtPoints(score);
}

/** "85%", or "—". */
export function fmtQuality(bp: number | null): string {
  return bp === null ? '—' : `${Math.round(bp / 100)}%`;
}

/** A raw count in the exercise's own units: "34" reps, "1:32" for a hold. */
export function fmtRaw(raw: number | null, type: ChallengeType): string {
  if (raw === null) {
    return '—';
  }
  return type === 'pushups' ? String(raw) : formatSeconds(raw);
}

/** "REPS" / "HOLD", the unit beside a raw count. */
export function rawUnit(type: ChallengeType): string {
  return type === 'pushups' ? 'REPS' : 'HOLD';
}

// ── The Blitz curve ────────────────────────────────────────────────────

/**
 * Mirrors _blitz_multiplier_bp() exactly, truncation included:
 *
 *   score <  threshold            -> 0
 *   score >= benchmark            -> maxBp
 *   otherwise                     -> breakevenBp + floor((maxBp - breakevenBp)
 *                                       * (score - threshold) / (benchmark - threshold))
 */
export function blitzMultiplierBp(
  score: number,
  threshold: number,
  benchmark: number,
  breakevenBp: number = BLITZ_BREAKEVEN_BP,
  maxBp: number = BLITZ_MAX_BP,
): number {
  if (score < threshold) {
    return 0;
  }
  if (benchmark <= threshold || score >= benchmark) {
    return maxBp;
  }
  return (
    breakevenBp +
    Math.floor(((maxBp - breakevenBp) * (score - threshold)) / (benchmark - threshold))
  );
}

/**
 * The inverse, for the graph's labels: the lowest score at which the
 * multiplier reaches `bp`. Clamped to the two ends of the curve.
 */
export function blitzScoreForMultiplier(
  bp: number,
  threshold: number,
  benchmark: number,
  breakevenBp: number = BLITZ_BREAKEVEN_BP,
  maxBp: number = BLITZ_MAX_BP,
): number {
  if (bp <= breakevenBp) {
    return threshold;
  }
  if (bp >= maxBp || benchmark <= threshold) {
    return benchmark;
  }
  return threshold + Math.ceil(((bp - breakevenBp) * (benchmark - threshold)) / (maxBp - breakevenBp));
}

// ── The meter ──────────────────────────────────────────────────────────

export type ScoringMode = 'reps' | 'hold';

export interface FormQualitySnapshot {
  /** 0..10000. Zero when nothing valid has been recorded yet. */
  readonly qualityBp: number;
  /** Reps: the peak probability of each counted rep. Holds: frames observed in position. */
  readonly samples: number;
}

/**
 * Accumulates form quality over one set, one probability per camera frame,
 * across the VALID portion only:
 *
 *   reps   the peak pose probability inside each COUNTED rep. A rep that has
 *          not completed when the set ends is not in it, exactly as it is
 *          not in the count.
 *   hold   the mean probability over the frames the hold tracker says are
 *          in position. Frames outside a segment are threshold noise and
 *          are not in it, exactly as they are not in the held time.
 *
 * Same shape as QuickPoseHoldTracker: fed per frame, reset per set, no
 * clock of its own, so it can be unit-tested without a camera
 * (__tests__/score.test.ts).
 */
export class FormQualityMeter {
  readonly mode: ScoringMode;

  private peak = 0;
  private repPeaks: number[] = [];
  private holdSum = 0;
  private holdFrames = 0;

  constructor(mode: ScoringMode) {
    this.mode = mode;
  }

  /**
   * One frame. `inPose` is the hold tracker's `isHolding` for a hold and is
   * ignored for reps, where the counter's own hysteresis decides what a rep
   * is and the peak since the last completed rep is what gets banked.
   */
  observe(probability: number, inPose = true): void {
    const p = clamp01(probability);
    if (this.mode === 'reps') {
      if (p > this.peak) {
        this.peak = p;
      }
      return;
    }
    if (inPose) {
      this.holdSum += p;
      this.holdFrames += 1;
    }
  }

  /** The rep counter fired: bank this rep's peak and start the next. */
  completeRep(): void {
    if (this.mode !== 'reps') {
      return;
    }
    this.repPeaks.push(this.peak);
    this.peak = 0;
  }

  snapshot(): FormQualitySnapshot {
    if (this.mode === 'reps') {
      const n = this.repPeaks.length;
      const mean = n ? this.repPeaks.reduce((a, b) => a + b, 0) / n : 0;
      return { qualityBp: toBp(mean), samples: n };
    }
    const mean = this.holdFrames ? this.holdSum / this.holdFrames : 0;
    return { qualityBp: toBp(mean), samples: this.holdFrames };
  }

  /** The per-rep peaks, for raw_metrics. Empty for a hold. */
  repPeakList(): readonly number[] {
    return this.repPeaks;
  }

  reset(): void {
    this.peak = 0;
    this.repPeaks = [];
    this.holdSum = 0;
    this.holdFrames = 0;
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) {
    return 0;
  }
  return Math.max(0, Math.min(1, n));
}

function toBp(fraction: number): number {
  return Math.max(0, Math.min(QUALITY_SCALE_BP, Math.round(fraction * QUALITY_SCALE_BP)));
}
