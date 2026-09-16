import type {
  AgeBand,
  ChallengeFormat,
  ChallengeStatus,
  ChallengeType,
  Gender,
  LedgerReason,
  NotificationPrefs,
  RankedMode,
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
  blitz: 'BLITZ',
  streak: 'STREAK',
};

export const FORMAT_NOTE: Record<ChallengeFormat, string> = {
  '1v1': 'Head-to-head. Matched live with a fighter at your level. Winner takes both stakes.',
  pooled:
    'Group Battle. The lobby fills live, the bout opens for everyone at once, top finisher takes the pot.',
  blitz:
    'Solo. One set against three bars set to your level. Clear the highest one you can and take the multiplier.',
  streak:
    'Solo. Three stages, one stake. Clear all three in a row for the payout — miss one and you have five hours to buy back in.',
};

/** What the format is called on a card. */
export const FORMAT_NAME: Record<ChallengeFormat, string> = {
  '1v1': '1v1',
  pooled: 'Group Battle',
  blitz: 'Blitz',
  streak: 'Streak',
};

/**
 * The two solo formats, in the order Find a Bout offers them. Neither takes
 * a player count or an opponent, and both are set up on their own pre-bout
 * screen rather than on Find a Bout, because a stake is only half of what
 * they need — the other half is seeing the bar before agreeing to it.
 */
export const SOLO_FORMATS: readonly ChallengeFormat[] = ['blitz', 'streak'];

export function isSoloFormat(format: ChallengeFormat): boolean {
  return format === 'blitz' || format === 'streak';
}

// ── Ranked / casual ─────────────────────────────────────────────────────

/**
 * Chosen per attempt, defaulted to Casual every single time, and never
 * remembered. The copy has one job: make it impossible to think a casual
 * bout is a practice bout. It is not — the stake really moves.
 */
export const RANKED_LABEL: Record<RankedMode, string> = {
  ranked: 'RANKED',
  casual: 'CASUAL',
};

export const RANKED_NOTE: Record<RankedMode, string> = {
  ranked: 'This one counts. Win or lose, your rank moves and it counts toward placement.',
  casual: 'Real stake, real payout, no rank. Nothing here touches your MMR or your placement.',
};

/** The one-line explanation under the toggle, whichever way it is set. */
export const RANKED_TOGGLE_HELP =
  'Casual bouts are fully real — the stake moves either way. They just leave your rank alone.';

// ── Solo modes ──────────────────────────────────────────────────────────

/** Shown on both pre-bout screens: where the numbers came from. */
export const SOLO_CALIBRATION_NOTE =
  'Your targets are set from your rank in this exercise. Climb, and they climb with you.';

/**
 * Shown when gender or age band is missing, because the targets are then the
 * midpoint of the two populations the reference data covers rather than the
 * fighter's own. Says what to do about it without making it a blocker.
 */
export const SOLO_CALIBRATION_ROUGH =
  'These targets are a population average. Add your age band and gender in Settings to have them set to you.';

export const BLITZ_RULES =
  'One set. The highest bar you clear pays its multiplier on your stake. Miss the first one and the stake is gone.';

export const STREAK_RULES =
  'Stake once. Clear all three stages in a row to take the payout. Miss one and the run ends there — with five hours to buy back in at the same stage.';

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
 * Exercises that carry a skill rating: the three camera verification (and
 * therefore settlement, and therefore MMR) supports. Same set as
 * VERIFIABLE_TYPES, as an ordered list for the Profile screen's rank rows.
 */
export const RANKED_TYPES: readonly ChallengeType[] = [
  'pushups',
  'plank',
  'wallsit',
];

/**
 * The SELF-REPORTED tier, named Bronze / Silver / Gold. The database enum
 * has three values, so the design's Elite is not reachable until it grows.
 *
 * This is no longer what matchmaking pairs on -- see src/lib/skillRating.ts
 * and the six earned RankTier bands. It stays as what a fighter says about
 * themselves before they have a record, and it is still what onboarding
 * asks for.
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

export const GENDER_LABEL: Record<Gender, string> = {
  male: 'Male',
  female: 'Female',
};

export const GENDERS: readonly Gender[] = ['male', 'female'];

export const AGE_BAND_LABEL: Record<AgeBand, string> = {
  under_20: 'Under 20',
  '20s': '20s',
  '30s': '30s',
  '40s': '40s',
  '50s': '50s',
  '60s': '60s',
  '70_plus': '70+',
};

export const AGE_BANDS: readonly AgeBand[] = [
  'under_20', '20s', '30s', '40s', '50s', '60s', '70_plus',
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
