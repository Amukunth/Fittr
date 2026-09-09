// Hand-written mirror of prisma/schema.prisma, in the shape Supabase's
// PostgREST API actually returns rows: snake_case DB column names, not
// Prisma's camelCase client field names (the app never imports
// @prisma/client — see BACKEND.md for why). Keep this in sync by hand
// whenever the schema changes.

/**
 * Self-reported, client-writable, and no longer what matchmaking pairs on
 * (see RankTier / skill_ratings below). Kept as a display and onboarding
 * field: what a fighter says about themselves before they have a record.
 */
export type StrengthTier = 'beginner' | 'intermediate' | 'advanced';

/**
 * Derived from skill_ratings.mmr by rank_tier_for() -- never stored as an
 * independent value. Ascending. "Unranked" is not one of these: it is how
 * the client renders a rating whose placement_complete is false.
 */
export type RankTier =
  | 'commoner'
  | 'squire'
  | 'knight'
  | 'hero'
  | 'sovereign'
  | 'ultimate_champion';

export type ChallengeType = 'pushups' | 'plank' | 'wallsit' | 'race';

/**
 * Optional, self-reported. Binary because that is the shape of every
 * source table the MMR placement seed draws on (ACSM, Chase et al., the
 * wall-sit numbers, WMA's age factors) -- a limitation of the source data,
 * not a claim that only two genders exist. Missing it just means the
 * population-median seed is used during placement instead. See
 * src/lib/skillRating.ts and BACKEND.md, "Real-world percentile seeding".
 */
export type Gender = 'male' | 'female';

/**
 * Optional, self-reported. One age-band scheme reused by every exercise's
 * decline model in the placement seed, even though each source table's own
 * baseline age range differs slightly. under_20 has no source data in any
 * exercise and is treated as the youngest sourced band.
 */
export type AgeBand =
  | 'under_20'
  | '20s'
  | '30s'
  | '40s'
  | '50s'
  | '60s'
  | '70_plus';

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
  /**
   * Optional. Neither this nor age_band is required to play; missing
   * either falls back to the population-median MMR seed during placement
   * rather than blocking anything. Set only through update_my_profile().
   */
  gender: Gender | null;
  age_band: AgeBand | null;
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
  /** Tier at the moment of entry. Display only; nothing pairs on it. */
  strength_tier: StrengthTier;
  /** MMR for this exercise at the moment of entry. What pairing reads. */
  mmr: number;
  /** Whether that rating was placed at entry. False widens pairing fully. */
  placement_complete: boolean;
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

// ── Skill rating ────────────────────────────────────────────────────────

/**
 * One row per (user, exercise_type). Written only by settle_match() and
 * enter_matchmaking(), both SECURITY DEFINER; readable by its owner alone.
 * The app reads the `my_skill_ratings` view rather than this table, so it
 * gets the derived tier from the same place the database defines it.
 */
export interface SkillRatingRow {
  id: string;
  user_id: string;
  exercise_type: ChallengeType;
  mmr: number;
  matches_played: number;
  /** matches_played >= 5. Kept in step by a trigger, not by the caller. */
  placement_complete: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * `my_skill_ratings`: skill_ratings plus the tier the database derives from
 * the MMR. security_invoker, so the base table's select-own policy scopes
 * it -- despite the name there is no user filter to apply on the client.
 */
export interface MySkillRatingRow {
  user_id: string;
  exercise_type: ChallengeType;
  mmr: number;
  matches_played: number;
  placement_complete: boolean;
  /** rank_tier_for(mmr). Meaningful only once placement_complete. */
  rank_tier: RankTier;
  /** How many bouts placement takes. Server-owned, so the copy can't drift. */
  placement_bouts: number;
  updated_at: string;
}

/**
 * What one settled bout did to one fighter's rating. Written inside
 * settle_match(); readable by its owner. The Results screen's source for
 * "+18" / "-24", and the audit trail that makes seed + sum(delta) = mmr.
 */
export interface SkillRatingEventRow {
  id: string;
  user_id: string;
  match_id: string;
  exercise_type: ChallengeType;
  mmr_before: number;
  mmr_after: number;
  /** mmr_after - mmr_before, i.e. after the rating floor is applied. */
  delta: number;
  /** 100 during placement, 32 after. */
  k_factor: number;
  /** Was the rating still placing when this bout STARTED? */
  was_placement: boolean;
  /** matches_played after this bout. "3 of 5" during placement. */
  matches_played: number;
  /** Seats on the bout. */
  participants: number;
  /**
   * True only on a fighter's first-ever rated bout in this exercise, and
   * only when it actually used the real-world percentile seed (both
   * gender and age_band were on file) instead of the flat 1000 default.
   * See BACKEND.md, "Real-world percentile seeding".
   */
  norms_seeded: boolean;
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
