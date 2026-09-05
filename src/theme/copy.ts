import type {
  ChallengeFormat,
  ChallengeStatus,
  ChallengeType,
  LedgerReason,
  StrengthTier,
} from '../types/database';
import type { IconName } from './icons';

/**
 * Display copy for enum values. Copy only: the underlying values are the
 * database enums and never change here. Voice follows the design canvas: a
 * challenge is a bout, the comparison is the tale of the tape, the money is
 * the pot.
 */

export const EXERCISE_LABEL: Record<ChallengeType, string> = {
  pushups: 'Push-ups',
  plank: 'Plank',
  wallsit: 'Wall-sit',
  race: '1-Mile Race',
};

/** What the score is, for "BEST REPS" / "BEST HOLD" style labels. */
export const EXERCISE_SCORE: Record<ChallengeType, string> = {
  pushups: 'REPS',
  plank: 'HOLD',
  wallsit: 'HOLD',
  race: 'TIME',
};

export const EXERCISE_RULES: Record<ChallengeType, string> = {
  pushups: 'One set, full range only.',
  plank: 'Max hold. Hips drop, clock stops.',
  wallsit: 'Max hold at 90°. Knees rise, clock stops.',
  race: 'Watch-verified pace.',
};

export const EXERCISE_ICON: Record<ChallengeType, IconName> = {
  pushups: 'barbell',
  plank: 'timer',
  wallsit: 'wall',
  race: 'run',
};

/**
 * Camera verification exists for these three. Race needs a watch and a
 * settlement rule that doesn't exist yet (settle_match raises on it), so it
 * stays visible but can't be posted.
 */
export const VERIFIABLE_TYPES: ReadonlySet<ChallengeType> = new Set([
  'pushups',
  'plank',
  'wallsit',
]);

export const FORMAT_LABEL: Record<ChallengeFormat, string> = {
  '1v1': '1V1',
  pooled: 'GROUP',
};

export const FORMAT_NOTE: Record<ChallengeFormat, string> = {
  '1v1': 'Head-to-head. Winner takes both stakes.',
  pooled:
    'Open table. The first fighter at your level to answer takes the seat and the pot goes to the winner.',
};

/**
 * Both formats resolve to a two-seat match in v1 (BACKEND.md, assumption
 * 4): a challenge is the offer, the first same-tier taker completes it.
 */
export const SEATS = 2;

export const STATUS_LABEL: Record<ChallengeStatus, string> = {
  open: 'OPEN',
  matched: 'MATCHED',
  in_progress: 'LIVE',
  completed: 'SETTLED',
  needs_review: 'UNDER REVIEW',
};

/**
 * The design names tiers Bronze / Silver / Gold / Elite. The database enum
 * has three values, so Elite is not reachable until the enum grows; the
 * three that exist map onto the first three medals.
 */
export const TIER_LABEL: Record<StrengthTier, string> = {
  beginner: 'Bronze',
  intermediate: 'Silver',
  advanced: 'Gold',
};

export const TIER_COLOR: Record<StrengthTier, string> = {
  beginner: '#C48A5A',
  intermediate: '#B8BCC6',
  advanced: '#E3B341',
};

export const TIER_DESC: Record<StrengthTier, string> = {
  beginner: 'Under 20 push-ups · plank under 1:00',
  intermediate: '20–35 push-ups · plank 1:00–2:00',
  advanced: '35+ push-ups · plank over 2:00',
};

export const TIERS: readonly StrengthTier[] = [
  'beginner',
  'intermediate',
  'advanced',
];

export const LEDGER_LABEL: Record<LedgerReason, string> = {
  stake: 'Stake',
  payout: 'Payout',
  bonus: 'Opening purse',
};

/** The four stake presets. Points-only pilot: 50 to 500. */
export const STAKE_OPTIONS: readonly number[] = [50, 100, 250, 500];

/** grant_starter_bonus() credits this on first login. */
export const STARTER_PURSE = 500;

export const UNIT = 'PTS';
export const UNIT_LONG = 'POINTS';
