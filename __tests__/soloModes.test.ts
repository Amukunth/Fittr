/**
 * The display half of Blitz and Streak: multiplier formatting, the stage
 * arithmetic the Streak screens read, and the countdown math both timers
 * share. No database — the calibration itself (rating -> target, target ->
 * rating, the Elo expectations behind the payouts) is asserted against
 * Postgres in soloModes.db.test.ts, and the score arithmetic and the Blitz
 * curve in score.test.ts.
 */
jest.mock('../src/lib/supabase', () => ({ supabase: {} }));

import {
  STREAK_PAYOUT_BP,
  STREAK_STAGE_OFFSETS,
  fmtCountdown,
  fmtMultiplier,
  payoutFor,
  remainingMs,
  soloErrorCopy,
  stageTargetOf,
  streakStagesOf,
  windowProgress,
} from '../src/lib/soloModes';
import type { StreakPreviewRow } from '../src/types/database';

// ── multiplier display ───────────────────────────────────────────────────

describe('fmtMultiplier', () => {
  it('drops trailing zeros so the common multipliers read as whole numbers', () => {
    expect(fmtMultiplier(15000)).toBe('1.5x');
    expect(fmtMultiplier(20000)).toBe('2x');
    expect(fmtMultiplier(25000)).toBe('2.5x');
    expect(fmtMultiplier(40000)).toBe('4x');
    expect(fmtMultiplier(10000)).toBe('1x');
  });

  it('keeps two decimals where the curve lands between tenths', () => {
    expect(fmtMultiplier(11333)).toBe('1.13x');
    expect(fmtMultiplier(10011)).toBe('1x');
    expect(fmtMultiplier(17500)).toBe('1.75x');
    expect(fmtMultiplier(0)).toBe('0x');
  });
});

describe('payoutFor', () => {
  it('truncates rather than rounding, matching the SQL integer division', () => {
    // 100 * 15000 / 10000 = 150 exactly.
    expect(payoutFor(100, 15000)).toBe(150);
    // 33 * 15000 / 10000 = 49.5 -- the server floors this, and so must the
    // client, or the two would show different numbers for the same run.
    expect(payoutFor(33, 15000)).toBe(49);
    // The curve's break-even returns the stake exactly.
    expect(payoutFor(250, 10000)).toBe(250);
  });

  it('matches the Streak payout on a 100-point stake: 40000bp is 4x', () => {
    expect(payoutFor(100, STREAK_PAYOUT_BP)).toBe(400);
  });
});

// ── the Streak stages ─────────────────────────────────────────────────────

function streakPreview(over: Partial<StreakPreviewRow> = {}): StreakPreviewRow {
  return {
    exercise_type: 'pushups',
    mmr: 1000,
    placement_complete: true,
    calibrated_to_me: true,
    stage1_target: 1105,
    stage2_target: 1530,
    stage3_target: 2040,
    stage1_rating: 800,
    stage2_rating: 900,
    stage3_rating: 1000,
    payout_bp: STREAK_PAYOUT_BP,
    state: 'idle',
    run_id: null,
    is_ranked: null,
    stake_points: null,
    stakes_paid: null,
    current_stage: null,
    failed_stage: null,
    failed_at: null,
    buyback_until: null,
    completed_at: null,
    cooldown_until: null,
    payout_points: null,
    pending_match_id: null,
    server_now: '2026-09-16T12:00:00.000Z',
    reference_quality_bp: 8500,
    ...over,
  };
}

describe('streakStagesOf / stageTargetOf', () => {
  it('lists the three stages in order, targets in score units', () => {
    const stages = streakStagesOf(streakPreview());
    expect(stages.map(s => s.stage)).toEqual([1, 2, 3]);
    expect(stages.map(s => s.target)).toEqual([1105, 1530, 2040]);
  });

  it('reads the right target for a stage number, and null outside 1..3', () => {
    const row = streakPreview();
    expect(stageTargetOf(row, 1)).toBe(1105);
    expect(stageTargetOf(row, 2)).toBe(1530);
    expect(stageTargetOf(row, 3)).toBe(2040);
    expect(stageTargetOf(row, 4)).toBeNull();
    expect(stageTargetOf(row, 0)).toBeNull();
  });

  it('mirrors the offsets used for Streak', () => {
    expect(STREAK_STAGE_OFFSETS).toEqual([-200, -100, 0]);
  });
});

// ── countdowns: both Streak timers share this math ───────────────────────

describe('remainingMs', () => {
  const serverNow = '2026-09-16T12:00:00.000Z';

  it('is null-deadline safe: no deadline means no time left', () => {
    expect(remainingMs(null, serverNow)).toBe(0);
  });

  it('is the gap between the deadline and the server clock', () => {
    const deadline = '2026-09-16T13:00:00.000Z'; // one hour later
    expect(remainingMs(deadline, serverNow)).toBe(60 * 60 * 1000);
  });

  it('subtracts elapsed screen time, so a ticking countdown counts down', () => {
    const deadline = '2026-09-16T13:00:00.000Z';
    expect(remainingMs(deadline, serverNow, 10 * 60 * 1000)).toBe(50 * 60 * 1000);
  });

  it('never goes negative once the deadline has passed', () => {
    const deadline = '2026-09-16T11:00:00.000Z'; // an hour ago
    expect(remainingMs(deadline, serverNow)).toBe(0);
    expect(remainingMs(serverNow, serverNow, 5000)).toBe(0);
  });
});

describe('fmtCountdown', () => {
  it('hours and minutes above an hour', () => {
    expect(fmtCountdown(4 * 60 * 60 * 1000 + 58 * 60 * 1000)).toBe('4h 58m');
  });

  it('minutes and seconds under an hour', () => {
    expect(fmtCountdown(58 * 60 * 1000 + 12 * 1000)).toBe('58m 12s');
  });

  it('bare seconds under a minute, and zero at exactly zero', () => {
    expect(fmtCountdown(45 * 1000)).toBe('45s');
    expect(fmtCountdown(0)).toBe('0s');
    expect(fmtCountdown(-500)).toBe('0s');
  });
});

describe('windowProgress', () => {
  it('1 at the start of a window, 0 once it has closed', () => {
    const whole = 5 * 60 * 60 * 1000;
    expect(windowProgress(whole, whole)).toBe(1);
    expect(windowProgress(0, whole)).toBe(0);
    expect(windowProgress(whole / 2, whole)).toBeCloseTo(0.5);
  });

  it('clamps outside 0..1, and treats a zero-length window as closed', () => {
    expect(windowProgress(-100, 1000)).toBe(0);
    expect(windowProgress(2000, 1000)).toBe(1);
    expect(windowProgress(500, 0)).toBe(0);
  });
});

// ── error copy ────────────────────────────────────────────────────────────

describe('soloErrorCopy', () => {
  it('maps every stable code the migration raises', () => {
    expect(soloErrorCopy('streak_run_active')).toMatch(/already have a run/i);
    expect(soloErrorCopy('streak_cooldown')).toMatch(/cooling down/i);
    expect(soloErrorCopy('streak_buyback_expired')).toMatch(/closed/i);
    expect(soloErrorCopy('calibration_unavailable')).toMatch(/targets/i);
  });

  it('shows a novel message verbatim -- a code with no mapping is a bug worth seeing', () => {
    expect(soloErrorCopy('some_new_error_nobody_mapped_yet')).toBe(
      'some_new_error_nobody_mapped_yet',
    );
  });
});
