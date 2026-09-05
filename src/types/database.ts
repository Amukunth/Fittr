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
  | 'tie_refunded'
  | 'needs_review'
  | 'not_ready'
  | 'already_settled';

export type LedgerReason = 'stake' | 'payout' | 'bonus';

export interface FitnessProfileRow {
  id: string;
  user_id: string;
  strength_tier: StrengthTier;
  points_balance: number;
  created_at: string;
}

export interface ChallengeRow {
  id: string;
  type: ChallengeType;
  format: ChallengeFormat;
  stake_points: number;
  status: ChallengeStatus;
  created_by: string;
  created_at: string;
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
