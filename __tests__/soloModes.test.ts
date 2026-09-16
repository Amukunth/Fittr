/**
 * The display half of Blitz and Streak: multiplier and target formatting,
 * the tier/stage arithmetic the live camera HUD reads, and the countdown
 * math both timers share. No database — the calibration itself (rating ->
 * target, target -> rating, the Elo expectations behind the multipliers) is
 * asserted against Postgres in soloModes.db.test.ts.
 */
jest.mock('../src/lib/supabase', () => ({ supabase: {} }));

import {
  BLITZ_TIER_BP,
  BLITZ_TIER_OFFSETS,
  STREAK_PAYOUT_BP,
  STREAK_STAGE_OFFSETS,
  blitzTiersOf,
  fmtCountdown,
  fmtMultiplier,
  fmtTarget,
  nextTierFor,
  payoutFor,
  remainingMs,
  soloErrorCopy,
  stageTargetOf,
  streakStagesOf,
  targetUnit,
  tierReachedFor,
  windowProgress,
  type BlitzTier,
} from '../src/lib/soloModes';
import type { BlitzPreviewRow, StreakPreviewRow } from '../src/types/database';

// ── multiplier / target display ──────────────────────────────────────────

describe('fmtMultiplier', () => {
  it('drops a trailing .0 so the common tiers read as whole numbers', () => {
    expect(fmtMultiplier(15000)).toBe('1.5x');
    expect(fmtMultiplier(20000)).toBe('2x');
    expect(fmtMultiplier(25000)).toBe('2.5x');
    expect(fmtMultiplier(40000)).toBe('4x');
  });
});

describe('payoutFor', () => {
  it('truncates rather than rounding, matching the SQL integer division', () => {
    // 100 * 15000 / 10000 = 150 exactly.
    expect(payoutFor(100, 15000)).toBe(150);
    // 33 * 15000 / 10000 = 49.5 -- the server floors this, and so must the
    // client, or the two would show different numbers for the same run.
    expect(payoutFor(33, 15000)).toBe(49);
  });

  it('matches the Streak payout on a 100-point stake: 40000bp is 4x', () => {
    expect(payoutFor(100, STREAK_PAYOUT_BP)).toBe(400);
  });
});

describe('fmtTarget / targetUnit', () => {
  it('reps are bare numbers, holds are minute:second', () => {
    expect(fmtTarget(24, 'pushups')).toBe('24');
    expect(fmtTarget(105, 'plank')).toBe('1:45');
    expect(fmtTarget(65, 'wallsit')).toBe('1:05');
  });

  it('units follow the same split', () => {
    expect(targetUnit('pushups')).toBe('REPS');
    expect(targetUnit('plank')).toBe('HOLD');
  });
});

// ── the Blitz ladder ──────────────────────────────────────────────────────

function blitzPreview(over: Partial<BlitzPreviewRow> = {}): BlitzPreviewRow {
  return {
    exercise_type: 'pushups',
    mmr: 1000,
    placement_complete: true,
    calibrated_to_me: true,
    tier1_target: 24,
    tier2_target: 36,
    tier3_target: 45,
    tier1_rating: 1000,
    tier2_rating: 1150,
    tier3_rating: 1320,
    tier1_bp: BLITZ_TIER_BP[0]!,
    tier2_bp: BLITZ_TIER_BP[1]!,
    tier3_bp: BLITZ_TIER_BP[2]!,
    ...over,
  };
}

describe('blitzTiersOf', () => {
  it('lists all three rungs in order, tier numbers 1..3', () => {
    const tiers = blitzTiersOf(blitzPreview());
    expect(tiers.map(t => t.tier)).toEqual([1, 2, 3]);
    expect(tiers.map(t => t.target)).toEqual([24, 36, 45]);
    expect(tiers.map(t => t.bp)).toEqual(BLITZ_TIER_BP);
  });
});

describe('tierReachedFor', () => {
  const tiers = blitzTiersOf(blitzPreview());

  it('is 0 below the first bar', () => {
    expect(tierReachedFor(23, tiers)).toBe(0);
  });

  it('is the highest bar cleared, not merely the last one crossed', () => {
    expect(tierReachedFor(24, tiers)).toBe(1);
    expect(tierReachedFor(35, tiers)).toBe(1);
    expect(tierReachedFor(36, tiers)).toBe(2);
    expect(tierReachedFor(44, tiers)).toBe(2);
    expect(tierReachedFor(45, tiers)).toBe(3);
    expect(tierReachedFor(99, tiers)).toBe(3);
  });

  it('agrees with the offsets and bp tables actually shipped', () => {
    // A sanity check that the mirrored constants have not drifted apart from
    // each other within this file -- the db test asserts them against SQL.
    expect(BLITZ_TIER_OFFSETS).toEqual([0, 150, 320]);
    expect(BLITZ_TIER_BP).toEqual([15000, 20000, 25000]);
  });
});

describe('nextTierFor', () => {
  const tiers = blitzTiersOf(blitzPreview());

  it('points at the next uncleared bar', () => {
    expect(nextTierFor(0, tiers)?.tier).toBe(1);
    expect(nextTierFor(24, tiers)?.tier).toBe(2);
    expect(nextTierFor(36, tiers)?.tier).toBe(3);
  });

  it('is null once the top bar is cleared', () => {
    expect(nextTierFor(45, tiers)).toBeNull();
    expect(nextTierFor(999, tiers)).toBeNull();
  });
});

// ── the Streak stages ─────────────────────────────────────────────────────

function streakPreview(over: Partial<StreakPreviewRow> = {}): StreakPreviewRow {
  return {
    exercise_type: 'pushups',
    mmr: 1000,
    placement_complete: true,
    calibrated_to_me: true,
    stage1_target: 13,
    stage2_target: 18,
    stage3_target: 24,
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
    ...over,
  };
}

describe('streakStagesOf / stageTargetOf', () => {
  it('lists the three stages in order', () => {
    const stages = streakStagesOf(streakPreview());
    expect(stages.map(s => s.stage)).toEqual([1, 2, 3]);
    expect(stages.map(s => s.target)).toEqual([13, 18, 24]);
  });

  it('reads the right target for a stage number, and null outside 1..3', () => {
    const row = streakPreview();
    expect(stageTargetOf(row, 1)).toBe(13);
    expect(stageTargetOf(row, 2)).toBe(18);
    expect(stageTargetOf(row, 3)).toBe(24);
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

// ── a note on what "tier"/"stage" numbering agrees with ──────────────────

describe('tier and stage numbering agree with settlement', () => {
  it('a Blitz tier list built from any preview always numbers 1..3 ascending', () => {
    const tiers: BlitzTier[] = blitzTiersOf(
      blitzPreview({ tier1_target: 5, tier2_target: 10, tier3_target: 15 }),
    );
    expect(tiers.every((t, i) => t.tier === i + 1)).toBe(true);
    // Ascending targets is a DB constraint (blitz_runs_targets_ascending);
    // this just asserts the client list preserves that order rather than
    // silently re-sorting it.
    expect(tiers.map(t => t.target)).toEqual([5, 10, 15]);
  });
});
