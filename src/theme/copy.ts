import type {
  ChallengeFormat,
  ChallengeStatus,
  ChallengeType,
  LedgerReason,
  NotificationPrefs,
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
  '1v1': 'Head-to-head. Matched live with a fighter at your level. Winner takes both stakes.',
  pooled:
    'Group Battle. The lobby fills live, the bout opens for everyone at once, top finisher takes the pot.',
};

/** What the format is called on a card. */
export const FORMAT_NAME: Record<ChallengeFormat, string> = {
  '1v1': '1v1',
  pooled: 'Group Battle',
};

/**
 * Group Battle sizes offered by Find a Bout. The database allows 2..6 on
 * challenges.max_participants; 2 is always a 1v1.
 */
export const GROUP_SIZES: readonly number[] = [3, 4, 5, 6];

export const STATUS_LABEL: Record<ChallengeStatus, string> = {
  open: 'FORMING',
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

// ── Settings ────────────────────────────────────────────────────────────

export interface NotificationPrefDef {
  key: keyof NotificationPrefs;
  label: string;
  desc: string;
}

/** Notification toggles, in the order the design lists them. */
export const NOTIFICATION_PREFS: readonly NotificationPrefDef[] = [
  { key: 'callouts', label: 'Call-outs', desc: 'Someone takes your bout or challenges you directly' },
  { key: 'results', label: 'Bout results', desc: 'Settlement and rank moves' },
  { key: 'reminders', label: 'Reminders', desc: 'A bout is waiting on your round' },
];

/** Transaction-history vocabulary for the points ledger. */
export const TRANSACTION_LABEL: Record<LedgerReason, string> = {
  bonus: 'Bonus credit',
  stake: 'Wager',
  payout: 'Win',
};

export interface CashoutMethodDef {
  key: 'venmo' | 'paypal' | 'debit' | 'ach';
  label: string;
  /** Typical processing time, shown per method. */
  time: string;
}

export const CASHOUT_METHODS: readonly CashoutMethodDef[] = [
  { key: 'venmo', label: 'Venmo', time: 'Instant to 1 business day' },
  { key: 'paypal', label: 'PayPal', time: 'Instant to 1 business day' },
  { key: 'debit', label: 'Debit card', time: 'Usually under 30 minutes' },
  { key: 'ach', label: 'Bank transfer (ACH)', time: '1–3 business days' },
];

export interface DepositMethodDef {
  key: 'card' | 'applepay' | 'paypal' | 'venmo';
  label: string;
}

export const DEPOSIT_METHODS: readonly DepositMethodDef[] = [
  { key: 'card', label: 'Debit or credit card' },
  { key: 'applepay', label: 'Apple Pay' },
  { key: 'paypal', label: 'PayPal' },
  { key: 'venmo', label: 'Venmo' },
];

/** Whole dollars, for the deposit amount grid. */
export const DEPOSIT_PRESETS_USD: readonly number[] = [5, 10, 20, 50, 100];

/**
 * Shown on every money screen while the app runs on points. Real-money
 * play is a server-side decision; nothing on the client can switch it on.
 */
export const REAL_MONEY_NOTICE =
  'Real-money play is not switched on yet. Points are free during the pilot and have no cash value.';
