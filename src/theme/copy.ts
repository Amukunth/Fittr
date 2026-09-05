import type {
  ChallengeFormat,
  ChallengeStatus,
  ChallengeType,
  LedgerReason,
  StrengthTier,
} from '../types/database';

/**
 * Display labels for enum values. Copy only — the underlying values are the
 * database enums and never change here. Voice follows fittr.io: a challenge is
 * a bout, the comparison is the tale of the tape, the money is the purse.
 */

export const EXERCISE_LABEL: Record<ChallengeType, string> = {
  pushups: 'Push-ups',
  plank: 'Plank',
  wallsit: 'Wall sit',
  race: 'Race',
};

export const FORMAT_LABEL: Record<ChallengeFormat, string> = {
  '1v1': '1v1',
  pooled: 'Pooled',
};

export const STATUS_LABEL: Record<ChallengeStatus, string> = {
  open: 'Open',
  matched: 'Matched',
  in_progress: 'Live',
  completed: 'Decided',
  needs_review: 'Under review',
};

export const TIER_LABEL: Record<StrengthTier, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
};

export const LEDGER_LABEL: Record<LedgerReason, string> = {
  stake: 'Stake',
  payout: 'Payout',
  bonus: 'Signing bonus',
};
