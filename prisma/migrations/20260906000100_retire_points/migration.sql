-- Retire the fake points economy.
--
-- STRATEGY (deliberate, not a conversion): points were play money with no
-- cash value, so nothing is converted at an exchange rate. Every legacy row
-- is kept, renamed with a `legacy_` prefix so the history stays auditable,
-- and every contest that was still unresolved on points is closed out —
-- it can never be settled because the functions that moved points are
-- removed below. The app no longer reads any of the legacy columns.
--
-- Drop the legacy columns/tables in a later release once nothing needs
-- them for support queries. Dropping them here would destroy data with no
-- upside.

-- ----------------------------------------------------------------------------
-- Contests: from stake_points to a cash entry fee in integer cents.
-- ----------------------------------------------------------------------------

-- payment_status is the money state of a contest, independent of the play
-- state in `status`. Set only by SECURITY DEFINER functions.
--   legacy       created under the points system; no money was ever involved
--   funded       the creator's entry fee is locked in escrow; open for a taker
--   locked       both entry fees are locked; the bout is matched/in progress
--   review_hold  results are in but a flagged session holds the pot
--   settled      the pot was paid out (or refunded on a tie)
--   refunded     the creator's fee was returned (cancelled / expired)
--   voided       both fees were returned by an admin/system void
CREATE TYPE "ContestPaymentStatus" AS ENUM (
  'legacy', 'funded', 'locked', 'review_hold', 'settled', 'refunded', 'voided'
);

ALTER TABLE "challenges" RENAME COLUMN "stake_points" TO "legacy_stake_points";
ALTER TABLE "challenges" ALTER COLUMN "legacy_stake_points" DROP NOT NULL;
ALTER TABLE "challenges" ALTER COLUMN "legacy_stake_points" SET DEFAULT NULL;

ALTER TABLE "challenges"
  ADD COLUMN "entry_fee_cents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "currency" CHAR(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN "payment_status" "ContestPaymentStatus" NOT NULL DEFAULT 'legacy',
  ADD COLUMN "expires_at" TIMESTAMPTZ;

ALTER TABLE "challenges"
  ADD CONSTRAINT "challenges_entry_fee_cents_nonneg" CHECK ("entry_fee_cents" >= 0);

COMMENT ON COLUMN "challenges"."legacy_stake_points" IS
  'Points stake from before 2026-09-06. Never converted to money. Kept for audit; drop in a later release.';

-- Points-era contests that never resolved cannot resolve now (no points
-- functions remain). Close them out explicitly rather than leaving them
-- looking joinable.
UPDATE "challenges"
   SET "status" = 'cancelled'
 WHERE "payment_status" = 'legacy'
   AND "status" IN ('open', 'matched', 'in_progress', 'needs_review');

-- Creation now goes through create_contest(), which locks the creator's
-- entry fee in the same transaction. A bare INSERT could create an unfunded
-- contest, so the client-side insert path is closed.
DROP POLICY IF EXISTS "challenges_insert_own" ON "challenges";
REVOKE INSERT ON "challenges" FROM authenticated;

-- ----------------------------------------------------------------------------
-- Profiles: the balance column is retired (the wallet ledger replaces it).
-- ----------------------------------------------------------------------------
ALTER TABLE "fitness_profiles" RENAME COLUMN "points_balance" TO "legacy_points_balance";
COMMENT ON COLUMN "fitness_profiles"."legacy_points_balance" IS
  'Final points balance from before 2026-09-06. Never converted to money. Kept for audit; drop in a later release.';

-- ----------------------------------------------------------------------------
-- Points ledger: archived in place.
-- ----------------------------------------------------------------------------
ALTER TABLE "points_ledger_entries" RENAME TO "legacy_points_ledger_entries";
ALTER INDEX IF EXISTS "points_ledger_entries_user_id_idx" RENAME TO "legacy_points_ledger_entries_user_id_idx";
ALTER INDEX IF EXISTS "points_ledger_entries_match_id_idx" RENAME TO "legacy_points_ledger_entries_match_id_idx";
COMMENT ON TABLE "legacy_points_ledger_entries" IS
  'Points ledger from before 2026-09-06. Read-only archive; the money ledger is ledger_transactions/ledger_entries.';
REVOKE INSERT, UPDATE, DELETE ON "legacy_points_ledger_entries" FROM authenticated;

-- ----------------------------------------------------------------------------
-- Points functions: gone. join_challenge -> enter_contest, settle_match ->
-- settle_contest (both in the wallet migration). grant_starter_bonus has no
-- replacement: nobody is handed free money.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.join_challenge(uuid, uuid);
DROP FUNCTION IF EXISTS public.grant_starter_bonus(uuid);
-- settle_match is dropped by the wallet migration, after
-- submit_verification_session has been repointed at settle_contest.
