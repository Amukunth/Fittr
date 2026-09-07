-- Contest lifecycle statuses needed by the real-money escrow rules.
--
-- DELIBERATELY ALONE IN ITS OWN MIGRATION, for the same reason as
-- 20260903200000_add_needs_review_status: Postgres refuses to *use* an enum
-- value in the transaction that adds it, and the wallet migration that
-- follows uses these in UPDATE statements and function bodies.
--
--   cancelled  the creator withdrew an open contest before anyone joined;
--              their entry fee was returned.
--   expired    nobody joined before expires_at; the entry fee was returned
--              by expire_open_contests().
--   voided     an admin or the system voided a matched contest (dispute,
--              verification failure, server error); every entry refunded.
ALTER TYPE "ChallengeStatus" ADD VALUE IF NOT EXISTS 'cancelled';
ALTER TYPE "ChallengeStatus" ADD VALUE IF NOT EXISTS 'expired';
ALTER TYPE "ChallengeStatus" ADD VALUE IF NOT EXISTS 'voided';
