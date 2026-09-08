// Hand-written mirror of prisma/schema.prisma, in the shape Supabase's
// PostgREST API actually returns rows: snake_case DB column names, not
// Prisma's camelCase client field names (the app never imports
// @prisma/client — see BACKEND.md for why). Keep this in sync by hand
// whenever the schema changes.

export type StrengthTier = 'beginner' | 'intermediate' | 'advanced';

export type ChallengeType = 'pushups' | 'plank' | 'wallsit' | 'race';

export type ChallengeFormat = 'pooled' | '1v1';

export type ChallengeStatus =
  | 'open'
  | 'matched'
  | 'in_progress'
  | 'completed'
  // Settlement found an anomaly_flag on the session that decided the outcome.
  // No payout happened and matches.settled_at is still null.
  | 'needs_review';

/** Return values of the settle_match() RPC. */
export type SettlementOutcome =
  | 'settled'
  /** Everyone tied for best: each stake refunded (the only tie a 1v1 can have). */
  | 'tie_refunded'
  /** Some fighters tied for best and shared the pot; the rest lost their stake. */
  | 'tie_split'
  | 'needs_review'
  | 'not_ready'
  | 'already_settled';

export type LedgerReason = 'stake' | 'payout' | 'bonus';

export interface FitnessProfileRow {
  id: string;
  user_id: string;
  strength_tier: StrengthTier;
  points_balance: number;
  /** Free-form name shown on the profile. Null until the user sets one. */
  display_name: string | null;
  /** Unique, lower-case, without the '@'. Backfilled from the sign-up handle. */
  username: string | null;
  /** Public URL in the `avatars` bucket, cache-busted with ?v=. */
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A challenge is a lobby while `open` (queue entries point at it via
 * matchmaking_queue.challenge_id) and a match's header once `matched`.
 * Nobody browses them any more; enter_matchmaking() creates them.
 */
export interface ChallengeRow {
  id: string;
  type: ChallengeType;
  format: ChallengeFormat;
  stake_points: number;
  /** Seats: 2 for 1v1, 3..6 for a Group Battle. */
  max_participants: number;
  status: ChallengeStatus;
  /** Whoever opened the lobby. Not special once the bout is on. */
  created_by: string;
  created_at: string;
}

// ── Matchmaking ─────────────────────────────────────────────────────────

export type MatchmakingStatus = 'searching' | 'matched' | 'cancelled';

/** Why a queue entry was closed without a match. `null` while searching. */
export type MatchmakingCancelReason =
  /** No heartbeat inside the TTL: the app was killed, backgrounded or offline. */
  | 'expired'
  /** The lobby filled but this fighter no longer had the stake. */
  | 'insufficient_points'
  /** The same account started a different search (usually another device). */
  | 'replaced';

/**
 * One row per fighter in the queue. Written only by enter_matchmaking(),
 * matchmaking_heartbeat() and leave_matchmaking(); readable by its owner,
 * which is also what the Searching screen's realtime filter relies on.
 * Heartbeats live in a separate, unpublished table, so every UPDATE event
 * on this row means the status or the lobby size changed.
 */
export interface MatchmakingQueueRow {
  id: string;
  user_id: string;
  exercise_type: ChallengeType;
  format: ChallengeFormat;
  max_participants: number;
  stake_points: number;
  /** Tier at the moment of entry. */
  strength_tier: StrengthTier;
  status: MatchmakingStatus;
  /** The lobby this entry is seated in. Never null while searching. */
  challenge_id: string | null;
  /** Set the instant the lobby fills. */
  match_id: string | null;
  /** How many fighters are in the lobby right now, pushed to every member. */
  lobby_size: number;
  cancel_reason: MatchmakingCancelReason | null;
  joined_at: string;
  /** When the row left `searching`, whichever way. */
  closed_at: string | null;
}

export interface MatchRow {
  id: string;
  challenge_id: string;
  winner_id: string | null;
  settled_at: string | null;
  created_at: string;
}

export interface MatchParticipantRow {
  id: string;
  match_id: string;
  user_id: string;
  rep_count: number | null;
  hold_duration_seconds: number | null;
  time_seconds: number | null;
}

export interface VerificationSessionRow {
  id: string;
  match_participant_id: string;
  raw_metrics: Record<string, unknown>;
  anomaly_flag: boolean;
  reviewed: boolean;
  created_at: string;
}

export interface PointsLedgerEntryRow {
  id: string;
  user_id: string;
  amount: number;
  reason: LedgerReason;
  match_id: string | null;
  created_at: string;
}

// ── Settings ────────────────────────────────────────────────────────────

/** Keys of user_settings.notifications. Missing keys mean "on". */
export interface NotificationPrefs {
  /** Someone takes your bout or challenges you directly. */
  callouts: boolean;
  /** Settlement and rank moves. */
  results: boolean;
  /** A bout is waiting on your round. */
  reminders: boolean;
}

export interface UserSettingsRow {
  user_id: string;
  notifications: Partial<NotificationPrefs>;
  updated_at: string;
}

/** A device that has opened Fittr with this account (see src/lib/device.ts). */
export interface UserDeviceRow {
  id: string;
  user_id: string;
  device_id: string;
  name: string;
  platform: string;
  app_version: string | null;
  created_at: string;
  last_seen_at: string;
}
