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

/**
 * The trophy ladder, ascending. A second, separate ranking from RankTier
 * above: that one is per exercise and pairs matchmaking, this one is one
 * number across every exercise and decides the wager ceiling and the
 * leaderboard. Thresholds live in the `league_tiers` table; league_for()
 * in SQL is the only thing that turns a trophy count into one of these.
 */
export type LeagueTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';

/** What one `rank_history` row records. */
export type RankEventType =
  | 'win'
  | 'loss'
  /** Shared first place in a group battle. */
  | 'tie'
  | 'promotion'
  | 'demotion';

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

/**
 * `blitz` and `streak` are SOLO formats: one seat, no opponent, the fighter
 * wagers against a threshold calibrated to their own MMR for the exercise.
 * They ride the whole existing bout pipeline with max_participants = 1, so
 * everything written against a ChallengeRow works for them unchanged -- but
 * anything that assumes an opponent exists has to check the seat count.
 */
export type ChallengeFormat = 'pooled' | '1v1' | 'blitz' | 'streak';

/** The two solo formats, as a narrowing of the above. */
export type SoloFormat = Extract<ChallengeFormat, 'blitz' | 'streak'>;

/**
 * Chosen per attempt and never remembered: every screen that starts one
 * defaults to 'casual' on mount, and only an explicit tap switches it.
 *
 * A casual attempt is a completely real bout -- the stake moves, the camera
 * verifies, the anomaly gate applies, the pot pays -- that writes no
 * skill_ratings row. That single omission is also what keeps it out of the
 * five-bout placement requirement, because placement is counted off
 * matches_played.
 */
export type RankedMode = 'ranked' | 'casual';

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
  /**
   * The trophy ladder. Written only by _rank_apply_match() inside
   * settlement, and carried on the same realtime UPDATE payload as
   * points_balance -- which is why the Rank screen needs no channel of its
   * own. current_league is league_for(trophies), kept in step by the same
   * function rather than derived on the client.
   */
  trophies: number;
  current_league: LeagueTier;
  total_wins: number;
  total_losses: number;
  /**
   * Shared first place in a group battle: neither a win nor a loss, and in
   * the denominator of the win rate. See deriveBoutStats(), which has always
   * counted them the same way.
   */
  total_ties: number;
  /** Consecutive wins. A loss resets it; a tie leaves it alone. */
  current_streak: number;
  created_at: string;
  updated_at: string;
}

// ── League and trophies ─────────────────────────────────────────────────

/**
 * Reference data, readable by any signed-in user: the five rows that define
 * where a league starts and what it unlocks. Seeded by the
 * 20260913000000_league_rank migration and never written at runtime.
 */
export interface LeagueTierRow {
  id: string;
  name: LeagueTier;
  min_trophies: number;
  /**
   * The wager ceiling this league unlocks, in cents. Forward-looking:
   * nothing in matchmaking reads it while the pilot stakes points.
   */
  max_wager_cents: number;
  color_hex: string;
}

/**
 * One entry in a fighter's rank timeline. A settled bout writes one row per
 * fighter, plus a second `promotion` / `demotion` row for anyone it moved a
 * league. Readable by its owner alone.
 */
export interface RankHistoryRow {
  id: string;
  user_id: string;
  event_type: RankEventType;
  /** Signed, and already floored: a loss at zero trophies records 0. */
  trophy_delta: number;
  /** The balance after this event. */
  trophy_balance: number;
  /** Set only for a two-seat bout; a group battle has no one opponent. */
  opponent_id: string | null;
  match_id: string | null;
  created_at: string;
}

/** One row of `leaderboard_page()` / `leaderboard_self()`. */
export interface LeaderboardRow {
  /** 1-based, within the requested scope. */
  rank: number;
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  trophies: number;
  league: LeagueTier;
  is_me: boolean;
}

/**
 * `rank_standing()`: the caller's own counters plus the one number their
 * profile row cannot carry. global_rank is counted at read time, not stored
 * -- see the migration header for why.
 */
export interface RankStandingRow {
  user_id: string;
  trophies: number;
  current_league: LeagueTier;
  total_wins: number;
  total_losses: number;
  total_ties: number;
  current_streak: number;
  global_rank: number;
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
  /** Seats: 1 for Blitz/Streak, 2 for 1v1, 3..6 for a Group Battle. */
  max_participants: number;
  /**
   * Whether this bout moved skill_ratings. The Results screen badges off
   * this, so it has to stay true of a bout forever -- which is why the
   * migration backfilled every already-matched bout to `true` rather than
   * to the new column default.
   */
  is_ranked: boolean;
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
  /**
   * Ranked and casual are two separate pools: a lobby only admits fighters
   * who asked for the same thing, because a bout cannot be half-rated.
   */
  is_ranked: boolean;
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

// ── Solo modes: Blitz and Streak ────────────────────────────────────────

/**
 * One Blitz attempt. Readable by its owner; written only by blitz_start()
 * and settlement. Every target, virtual-opponent rating and multiplier is a
 * SNAPSHOT taken when the run started, so the bar shown on the pre-bout
 * screen is the bar settlement judges against even if a bout settling
 * elsewhere moved the rating in between.
 */
export interface BlitzRunRow {
  id: string;
  user_id: string;
  match_id: string;
  exercise_type: ChallengeType;
  stake_points: number;
  is_ranked: boolean;
  /** The rating the ladder was calibrated from, and tier 1's virtual opponent. */
  mmr_at_start: number;
  /** Strictly ascending. Reps for pushups, seconds for a hold. */
  tier1_target: number;
  tier2_target: number;
  tier3_target: number;
  /** mmr_at_start + the tier's rating offset. */
  tier1_rating: number;
  tier2_rating: number;
  tier3_rating: number;
  /** Basis points of the stake: 15000 / 20000 / 25000. */
  tier1_bp: number;
  tier2_bp: number;
  tier3_bp: number;
  /** All four null until settled, all four set after it. */
  score: number | null;
  /** 0..3. Zero means the first threshold was missed and nothing paid. */
  tier_reached: number | null;
  multiplier_bp: number | null;
  payout_points: number | null;
  created_at: string;
  settled_at: string | null;
}

export type StreakRunStatus = 'active' | 'failed' | 'won';

/**
 * What `streak_preview()` (and `streak_start()`, `streak_next_stage()`,
 * `streak_buy_back_in()` — they all return this same shape) says about the
 * mode for one exercise. One composite answers every question the screens
 * ask, so they can never render two inconsistent halves of one state.
 */
export interface StreakPreviewRow {
  exercise_type: ChallengeType;
  mmr: number;
  placement_complete: boolean;
  /**
   * True when gender AND age_band are both on file. False means the ladder
   * was calibrated against the mean of the two sourced populations in the
   * default age band rather than against the fighter's own.
   */
  calibrated_to_me: boolean;
  /** The run's snapshot while one is live, a fresh calibration otherwise. */
  stage1_target: number;
  stage2_target: number;
  stage3_target: number;
  stage1_rating: number;
  stage2_rating: number;
  stage3_rating: number;
  /** Basis points of the opening stake paid for clearing all three. */
  payout_bp: number;
  /**
   * `expired` and `cooldown` are derived from the timestamps below at read
   * time, not stored: a failed run past its buy-back window is `expired`, a
   * won run inside its cooldown is `cooldown`.
   */
  state: 'idle' | 'active' | 'failed' | 'expired' | 'cooldown';
  run_id: string | null;
  is_ranked: boolean | null;
  stake_points: number | null;
  /** Opening stake plus one per buy-back; total cost is stake * this. */
  stakes_paid: number | null;
  current_stage: number | null;
  failed_stage: number | null;
  failed_at: string | null;
  /** failed_at + the five-hour buy-back window. TIMER 1. */
  buyback_until: string | null;
  completed_at: string | null;
  /** completed_at + the five-hour win cooldown. TIMER 2. */
  cooldown_until: string | null;
  payout_points: number | null;
  /** The open camera round for the current stage, if one has been opened. */
  pending_match_id: string | null;
  /**
   * now() as the SERVER sees it. Both countdowns are rendered against this
   * rather than against Date.now(), so a phone with a skewed clock shows the
   * real remaining time instead of its own idea of it.
   */
  server_now: string;
}

/** `blitz_preview()`: the ladder, before anything is staked. */
export interface BlitzPreviewRow {
  exercise_type: ChallengeType;
  mmr: number;
  placement_complete: boolean;
  /** See StreakPreviewRow.calibrated_to_me. */
  calibrated_to_me: boolean;
  tier1_target: number;
  tier2_target: number;
  tier3_target: number;
  tier1_rating: number;
  tier2_rating: number;
  tier3_rating: number;
  tier1_bp: number;
  tier2_bp: number;
  tier3_bp: number;
}

/** One go at one Streak stage, including every buy-back. */
export interface StreakStageAttemptRow {
  id: string;
  run_id: string;
  stage: number;
  attempt_no: number;
  match_id: string;
  is_buy_back: boolean;
  score: number | null;
  passed: boolean | null;
  created_at: string;
  settled_at: string | null;
}

/** The full `streak_runs` row, for the screens that need more than the view. */
export interface StreakRunRow {
  id: string;
  user_id: string;
  exercise_type: ChallengeType;
  stake_points: number;
  is_ranked: boolean;
  mmr_at_start: number;
  stage1_target: number;
  stage2_target: number;
  stage3_target: number;
  stage1_rating: number;
  stage2_rating: number;
  stage3_rating: number;
  payout_bp: number;
  status: StreakRunStatus;
  current_stage: number;
  stakes_paid: number;
  failed_stage: number | null;
  failed_at: string | null;
  completed_at: string | null;
  payout_points: number | null;
  created_at: string;
  updated_at: string;
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
