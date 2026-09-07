-- ============================================================================
-- Real-money wallet: double-entry ledger, escrowed contest entries,
-- deposits, withdrawals, provider events, compliance hooks, admin tooling.
--
-- DESIGN RULES (every function below follows them):
--   * Money is BIGINT cents. No floats, no numeric division on money.
--   * The ledger is the source of truth. ledger_transactions and
--     ledger_entries are append-only (triggers refuse UPDATE/DELETE). Every
--     transaction's entries sum to zero (deferred constraint trigger).
--     ledger_accounts.balance_cents is a cache maintained by trigger and can
--     be checked at any time with reconcile_ledger().
--   * Every balance change goes through _post_ledger_transaction(), which
--     locks the affected accounts in a deterministic order (SELECT ... FOR
--     UPDATE ORDER BY id) and refuses to take a user account negative unless
--     the caller explicitly allows it (only reversals do).
--   * Every money-moving function is idempotent: contest settlement is
--     keyed on the match, provider events on (provider, provider_event_id),
--     everything else on a caller-supplied idempotency key.
--   * No client-side write path exists. Tables get SELECT for the owning
--     user only; all mutation is through SECURITY DEFINER functions with a
--     pinned search_path, exactly like join_challenge() was.
--   * The client never decides an amount that matters: entry fees must be
--     an active stake option, payouts come from the active fee schedule,
--     deposits are credited only from a verified provider event whose
--     amount matches our own record.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
CREATE TYPE "WalletStatus" AS ENUM ('active', 'frozen', 'closed');

CREATE TYPE "LedgerAccountKind" AS ENUM (
  'user_available',           -- spendable and withdrawable cash
  'user_locked',              -- in escrow for contests the user is in
  'user_pending_withdrawal',  -- reserved for a withdrawal in flight
  'user_promo',               -- promotional credit: spendable, never withdrawable
  'platform_clearing',        -- external money in/out (the payment provider side)
  'platform_revenue',         -- platform fees earned
  'platform_promo_funding',   -- source of promotional credit
  'platform_adjustments'      -- counterpart of admin adjustments
);

CREATE TYPE "LedgerTransactionType" AS ENUM (
  'deposit', 'deposit_reversal', 'withdrawal', 'withdrawal_release',
  'contest_entry', 'contest_win', 'contest_refund', 'platform_fee',
  'reversal', 'promo_credit', 'admin_adjustment'
);

CREATE TYPE "DepositStatus" AS ENUM (
  'initiated', 'pending', 'succeeded', 'failed', 'cancelled', 'reversed'
);

CREATE TYPE "WithdrawalStatus" AS ENUM (
  'requested', 'under_review', 'processing', 'completed', 'failed', 'reversed', 'cancelled'
);

CREATE TYPE "ContestEntryStatus" AS ENUM (
  'locked', 'settled_won', 'settled_lost', 'settled_tie', 'refunded', 'voided'
);

CREATE TYPE "ContestSettlementOutcome" AS ENUM ('won', 'tie', 'refunded', 'voided');

CREATE TYPE "ComplianceStatus" AS ENUM ('unverified', 'pending', 'verified', 'restricted', 'rejected');

CREATE TYPE "RiskStatus" AS ENUM ('normal', 'review', 'blocked');

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------

CREATE TABLE "wallets" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    UUID NOT NULL,
  "currency"   CHAR(3) NOT NULL DEFAULT 'USD',
  "status"     "WalletStatus" NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "wallets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallets_user_id_key" UNIQUE ("user_id"),
  CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT
);

CREATE TABLE "ledger_accounts" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "kind"          "LedgerAccountKind" NOT NULL,
  "wallet_id"     UUID,
  "user_id"       UUID,               -- denormalised from wallets for RLS and realtime filters
  "currency"      CHAR(3) NOT NULL DEFAULT 'USD',
  "balance_cents" BIGINT NOT NULL DEFAULT 0,   -- cache; see reconcile_ledger()
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ledger_accounts_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT,
  CONSTRAINT "ledger_accounts_wallet_kind_key" UNIQUE ("wallet_id", "kind"),
  CONSTRAINT "ledger_accounts_owner_matches_kind" CHECK (
    ("kind"::text LIKE 'user_%' AND "wallet_id" IS NOT NULL AND "user_id" IS NOT NULL) OR
    ("kind"::text LIKE 'platform_%' AND "wallet_id" IS NULL AND "user_id" IS NULL)
  )
);
CREATE UNIQUE INDEX "ledger_accounts_platform_kind_key" ON "ledger_accounts" ("kind", "currency") WHERE "wallet_id" IS NULL;
CREATE INDEX "ledger_accounts_user_id_idx" ON "ledger_accounts" ("user_id");

CREATE TABLE "payment_provider_events" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "provider"           TEXT NOT NULL,
  "provider_event_id"  TEXT NOT NULL,
  "event_type"         TEXT NOT NULL,
  "payload"            JSONB NOT NULL,
  "signature_verified" BOOLEAN NOT NULL DEFAULT false,
  "received_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "processed_at"       TIMESTAMPTZ,
  "processing_status"  TEXT NOT NULL DEFAULT 'received',   -- received | processed | ignored | failed
  "processing_error"   TEXT,
  CONSTRAINT "payment_provider_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_provider_events_provider_event_key" UNIQUE ("provider", "provider_event_id")
);

CREATE TABLE "deposits" (
  "id"                      UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"                 UUID NOT NULL,
  "wallet_id"               UUID NOT NULL,
  "amount_cents"            BIGINT NOT NULL,
  "currency"                CHAR(3) NOT NULL DEFAULT 'USD',
  "provider"                TEXT NOT NULL,
  "provider_ref"            TEXT,                -- e.g. a PaymentIntent id
  "status"                  "DepositStatus" NOT NULL DEFAULT 'initiated',
  "idempotency_key"         TEXT NOT NULL,
  "failure_reason"          TEXT,
  "credited_transaction_id" UUID,
  "reversal_transaction_id" UUID,
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  "succeeded_at"            TIMESTAMPTZ,
  "reversed_at"             TIMESTAMPTZ,
  CONSTRAINT "deposits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "deposits_amount_positive" CHECK ("amount_cents" > 0),
  CONSTRAINT "deposits_idempotency_key_key" UNIQUE ("idempotency_key"),
  CONSTRAINT "deposits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id"),
  CONSTRAINT "deposits_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id")
);
CREATE UNIQUE INDEX "deposits_provider_ref_key" ON "deposits" ("provider", "provider_ref") WHERE "provider_ref" IS NOT NULL;
CREATE INDEX "deposits_user_id_idx" ON "deposits" ("user_id", "created_at");

CREATE TABLE "withdrawals" (
  "id"                        UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"                   UUID NOT NULL,
  "wallet_id"                 UUID NOT NULL,
  "amount_cents"              BIGINT NOT NULL,
  "currency"                  CHAR(3) NOT NULL DEFAULT 'USD',
  "status"                    "WithdrawalStatus" NOT NULL DEFAULT 'requested',
  "destination_type"          TEXT NOT NULL,      -- 'sandbox' | 'bank_account' | 'connected_account' ...
  "destination_ref"           TEXT,               -- provider token only; never raw bank details
  "provider"                  TEXT,
  "provider_ref"              TEXT,               -- e.g. a transfer/payout id
  "idempotency_key"           TEXT NOT NULL,
  "lock_transaction_id"       UUID,
  "completion_transaction_id" UUID,
  "release_transaction_id"    UUID,
  "failure_reason"            TEXT,
  "review_notes"              TEXT,
  "reviewed_by"               UUID,
  "requested_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"                TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completed_at"              TIMESTAMPTZ,
  CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "withdrawals_amount_positive" CHECK ("amount_cents" > 0),
  CONSTRAINT "withdrawals_idempotency_key_key" UNIQUE ("idempotency_key"),
  CONSTRAINT "withdrawals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id"),
  CONSTRAINT "withdrawals_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id")
);
CREATE UNIQUE INDEX "withdrawals_provider_ref_key" ON "withdrawals" ("provider", "provider_ref") WHERE "provider_ref" IS NOT NULL;
CREATE INDEX "withdrawals_user_id_idx" ON "withdrawals" ("user_id", "requested_at");

CREATE TABLE "ledger_transactions" (
  "id"                      UUID NOT NULL DEFAULT gen_random_uuid(),
  "type"                    "LedgerTransactionType" NOT NULL,
  "idempotency_key"         TEXT NOT NULL,
  "description"             TEXT,
  "currency"                CHAR(3) NOT NULL DEFAULT 'USD',
  "contest_id"              UUID,
  "match_id"                UUID,
  "deposit_id"              UUID,
  "withdrawal_id"           UUID,
  "provider_event_id"       UUID,
  "reverses_transaction_id" UUID,
  "created_by"              UUID,               -- acting user/admin; NULL = system/provider event
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ledger_transactions_idempotency_key_key" UNIQUE ("idempotency_key"),
  CONSTRAINT "ledger_transactions_contest_id_fkey" FOREIGN KEY ("contest_id") REFERENCES "challenges"("id"),
  CONSTRAINT "ledger_transactions_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id"),
  CONSTRAINT "ledger_transactions_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "deposits"("id"),
  CONSTRAINT "ledger_transactions_withdrawal_id_fkey" FOREIGN KEY ("withdrawal_id") REFERENCES "withdrawals"("id"),
  CONSTRAINT "ledger_transactions_provider_event_id_fkey" FOREIGN KEY ("provider_event_id") REFERENCES "payment_provider_events"("id"),
  CONSTRAINT "ledger_transactions_reverses_fkey" FOREIGN KEY ("reverses_transaction_id") REFERENCES "ledger_transactions"("id")
);
CREATE INDEX "ledger_transactions_contest_id_idx" ON "ledger_transactions" ("contest_id");
CREATE INDEX "ledger_transactions_match_id_idx" ON "ledger_transactions" ("match_id");
CREATE INDEX "ledger_transactions_created_at_idx" ON "ledger_transactions" ("created_at");

CREATE TABLE "ledger_entries" (
  "id"             BIGSERIAL NOT NULL,
  "transaction_id" UUID NOT NULL,
  "account_id"     UUID NOT NULL,
  "amount_cents"   BIGINT NOT NULL,     -- positive = credit to the account, negative = debit
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ledger_entries_amount_nonzero" CHECK ("amount_cents" <> 0),
  CONSTRAINT "ledger_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "ledger_transactions"("id"),
  CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id")
);
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries" ("transaction_id");
CREATE INDEX "ledger_entries_account_id_idx" ON "ledger_entries" ("account_id", "id");

ALTER TABLE "deposits"
  ADD CONSTRAINT "deposits_credited_transaction_id_fkey" FOREIGN KEY ("credited_transaction_id") REFERENCES "ledger_transactions"("id"),
  ADD CONSTRAINT "deposits_reversal_transaction_id_fkey" FOREIGN KEY ("reversal_transaction_id") REFERENCES "ledger_transactions"("id");
ALTER TABLE "withdrawals"
  ADD CONSTRAINT "withdrawals_lock_transaction_id_fkey" FOREIGN KEY ("lock_transaction_id") REFERENCES "ledger_transactions"("id"),
  ADD CONSTRAINT "withdrawals_completion_transaction_id_fkey" FOREIGN KEY ("completion_transaction_id") REFERENCES "ledger_transactions"("id"),
  ADD CONSTRAINT "withdrawals_release_transaction_id_fkey" FOREIGN KEY ("release_transaction_id") REFERENCES "ledger_transactions"("id");

CREATE TABLE "contest_entries" (
  "id"                        UUID NOT NULL DEFAULT gen_random_uuid(),
  "challenge_id"              UUID NOT NULL,
  "match_id"                  UUID,
  "user_id"                   UUID NOT NULL,
  "wallet_id"                 UUID NOT NULL,
  "amount_cents"              BIGINT NOT NULL,
  "currency"                  CHAR(3) NOT NULL DEFAULT 'USD',
  "status"                    "ContestEntryStatus" NOT NULL DEFAULT 'locked',
  "lock_transaction_id"       UUID NOT NULL,
  "settlement_transaction_id" UUID,
  "created_at"                TIMESTAMPTZ NOT NULL DEFAULT now(),
  "settled_at"                TIMESTAMPTZ,
  CONSTRAINT "contest_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contest_entries_amount_nonneg" CHECK ("amount_cents" >= 0),
  CONSTRAINT "contest_entries_challenge_user_key" UNIQUE ("challenge_id", "user_id"),
  CONSTRAINT "contest_entries_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "challenges"("id"),
  CONSTRAINT "contest_entries_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id"),
  CONSTRAINT "contest_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id"),
  CONSTRAINT "contest_entries_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id"),
  CONSTRAINT "contest_entries_lock_transaction_id_fkey" FOREIGN KEY ("lock_transaction_id") REFERENCES "ledger_transactions"("id"),
  CONSTRAINT "contest_entries_settlement_transaction_id_fkey" FOREIGN KEY ("settlement_transaction_id") REFERENCES "ledger_transactions"("id")
);
CREATE INDEX "contest_entries_user_id_idx" ON "contest_entries" ("user_id");
CREATE INDEX "contest_entries_match_id_idx" ON "contest_entries" ("match_id");

CREATE TABLE "fee_schedules" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "name"           TEXT NOT NULL,
  "rake_bps"       INTEGER NOT NULL,           -- basis points of the gross pool, e.g. 1000 = 10%
  "min_fee_cents"  BIGINT NOT NULL DEFAULT 0,
  "max_fee_cents"  BIGINT,
  "active"         BOOLEAN NOT NULL DEFAULT false,
  "effective_from" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_by"     UUID,
  CONSTRAINT "fee_schedules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fee_schedules_rake_bps_range" CHECK ("rake_bps" >= 0 AND "rake_bps" <= 5000),
  CONSTRAINT "fee_schedules_min_fee_nonneg" CHECK ("min_fee_cents" >= 0)
);
CREATE UNIQUE INDEX "fee_schedules_one_active" ON "fee_schedules" ("active") WHERE "active";

CREATE TABLE "contest_settlements" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "match_id"            UUID NOT NULL,
  "challenge_id"        UUID NOT NULL,
  "outcome"             "ContestSettlementOutcome" NOT NULL,
  "winner_id"           UUID,
  "gross_pool_cents"    BIGINT NOT NULL,
  "platform_fee_cents"  BIGINT NOT NULL,
  "winner_payout_cents" BIGINT NOT NULL,
  "fee_schedule_id"     UUID,
  "transaction_id"      UUID,
  "reason"              TEXT,
  "settled_by"          UUID,          -- admin for voids; NULL for automatic settlement
  "settled_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "contest_settlements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contest_settlements_match_id_key" UNIQUE ("match_id"),
  CONSTRAINT "contest_settlements_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id"),
  CONSTRAINT "contest_settlements_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "challenges"("id"),
  CONSTRAINT "contest_settlements_fee_schedule_id_fkey" FOREIGN KEY ("fee_schedule_id") REFERENCES "fee_schedules"("id"),
  CONSTRAINT "contest_settlements_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "ledger_transactions"("id"),
  CONSTRAINT "contest_settlements_sums" CHECK ("platform_fee_cents" + "winner_payout_cents" <= "gross_pool_cents")
);

CREATE TABLE "contest_stake_options" (
  "amount_cents" BIGINT NOT NULL,
  "active"       BOOLEAN NOT NULL DEFAULT true,
  "sort_order"   INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "contest_stake_options_pkey" PRIMARY KEY ("amount_cents"),
  CONSTRAINT "contest_stake_options_positive" CHECK ("amount_cents" > 0)
);

-- One row. Anything an operator may tune lives here, changed only through
-- admin_set_platform_settings() so the change is audited.
CREATE TABLE "platform_settings" (
  "id"                                SMALLINT NOT NULL DEFAULT 1,
  "environment"                       TEXT NOT NULL DEFAULT 'development',   -- development | staging | production
  "real_money_enabled"                BOOLEAN NOT NULL DEFAULT false,
  "payment_provider"                  TEXT NOT NULL DEFAULT 'sandbox',       -- sandbox | stripe
  "kyc_provider"                      TEXT,                                  -- NULL until a provider is wired in
  "location_provider"                 TEXT,                                  -- NULL until a provider is wired in
  "min_age"                           INTEGER NOT NULL DEFAULT 18,
  "min_deposit_cents"                 BIGINT NOT NULL DEFAULT 500,
  "max_deposit_cents"                 BIGINT NOT NULL DEFAULT 50000,
  "default_daily_deposit_limit_cents" BIGINT NOT NULL DEFAULT 50000,
  "default_monthly_deposit_limit_cents" BIGINT NOT NULL DEFAULT 200000,
  "min_withdrawal_cents"              BIGINT NOT NULL DEFAULT 1000,
  "max_withdrawal_cents"              BIGINT NOT NULL DEFAULT 100000,
  "withdrawal_review_threshold_cents" BIGINT NOT NULL DEFAULT 20000,
  "open_contest_ttl_minutes"          INTEGER NOT NULL DEFAULT 60,
  "location_check_ttl_minutes"        INTEGER NOT NULL DEFAULT 30,
  "updated_at"                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_by"                        UUID,
  CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_settings_singleton" CHECK ("id" = 1),
  CONSTRAINT "platform_settings_environment" CHECK ("environment" IN ('development', 'staging', 'production'))
);

CREATE TABLE "compliance_profiles" (
  "user_id"                     UUID NOT NULL,
  "status"                      "ComplianceStatus" NOT NULL DEFAULT 'unverified',
  "date_of_birth"               DATE,
  "age_verified_at"             TIMESTAMPTZ,
  "kyc_provider"                TEXT,
  "kyc_reference"               TEXT,
  "kyc_verified_at"             TIMESTAMPTZ,
  "sanctions_status"            TEXT NOT NULL DEFAULT 'unchecked',   -- unchecked | clear | hit
  "sanctions_checked_at"        TIMESTAMPTZ,
  "jurisdiction_code"           TEXT,                                 -- e.g. US-TX, from the last location check
  "location_provider"           TEXT,
  "location_reference"          TEXT,
  "location_verified_at"        TIMESTAMPTZ,
  "self_excluded_until"         TIMESTAMPTZ,
  "deposit_limit_daily_cents"   BIGINT,       -- NULL = platform default
  "deposit_limit_monthly_cents" BIGINT,
  "risk_status"                 "RiskStatus" NOT NULL DEFAULT 'normal',
  "risk_notes"                  TEXT,
  "created_at"                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "compliance_profiles_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "compliance_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE
);

-- Default deny: a jurisdiction with no row cannot play for money.
CREATE TABLE "jurisdiction_rules" (
  "code"                  TEXT NOT NULL,           -- ISO 3166-2, e.g. US-TX
  "paid_contests_allowed" BOOLEAN NOT NULL DEFAULT false,
  "min_age"               INTEGER NOT NULL DEFAULT 18,
  "notes"                 TEXT,
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_by"            UUID,
  CONSTRAINT "jurisdiction_rules_pkey" PRIMARY KEY ("code")
);

CREATE TABLE "admin_users" (
  "user_id"    UUID NOT NULL,
  "granted_by" UUID,
  "granted_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "admin_users_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "admin_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE
);

CREATE TABLE "financial_audit_log" (
  "id"           BIGSERIAL NOT NULL,
  "actor_id"     UUID,
  "actor_role"   TEXT NOT NULL,          -- user | admin | service | system
  "action"       TEXT NOT NULL,
  "target_type"  TEXT,
  "target_id"    TEXT,
  "amount_cents" BIGINT,
  "details"      JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "financial_audit_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "financial_audit_log_target_idx" ON "financial_audit_log" ("target_type", "target_id");
CREATE INDEX "financial_audit_log_actor_idx" ON "financial_audit_log" ("actor_id", "created_at");

CREATE TABLE "rate_limit_buckets" (
  "key"    TEXT NOT NULL,
  "bucket" BIGINT NOT NULL,
  "count"  INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key", "bucket")
);

-- ----------------------------------------------------------------------------
-- Seed data
-- ----------------------------------------------------------------------------
INSERT INTO "ledger_accounts" ("kind", "currency") VALUES
  ('platform_clearing', 'USD'),
  ('platform_revenue', 'USD'),
  ('platform_promo_funding', 'USD'),
  ('platform_adjustments', 'USD');

INSERT INTO "platform_settings" ("id") VALUES (1);

-- 10% rake, from the pitch deck's business model. Change with a new active
-- schedule, never by editing this row: settlements reference their schedule.
INSERT INTO "fee_schedules" ("name", "rake_bps", "min_fee_cents", "active")
  VALUES ('launch-10pct', 1000, 0, true);

INSERT INTO "contest_stake_options" ("amount_cents", "sort_order") VALUES
  (100, 1), (200, 2), (500, 3), (1000, 4), (2000, 5);

-- Every jurisdiction is closed until counsel clears it. Rows exist for the
-- pilot market so the switch is explicit rather than a missing row.
INSERT INTO "jurisdiction_rules" ("code", "paid_contests_allowed", "notes") VALUES
  ('US-TX', false, 'Pilot market (DFW). Awaiting skill-game opinion from counsel before enabling.');

-- ----------------------------------------------------------------------------
-- Ledger integrity triggers
-- ----------------------------------------------------------------------------

-- Balance cache: the only thing allowed to change ledger_accounts.balance_cents
-- is this trigger, and it flags itself via a transaction-local setting so the
-- guard below can tell it apart from a direct UPDATE.
CREATE OR REPLACE FUNCTION public._ledger_apply_entry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM set_config('fittr.ledger_apply', 'on', true);
  UPDATE "ledger_accounts" SET "balance_cents" = "balance_cents" + NEW."amount_cents" WHERE "id" = NEW."account_id";
  PERFORM set_config('fittr.ledger_apply', 'off', true);
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ledger_entries_apply" AFTER INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION public._ledger_apply_entry();

CREATE OR REPLACE FUNCTION public._ledger_accounts_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW."balance_cents" IS DISTINCT FROM OLD."balance_cents"
     AND current_setting('fittr.ledger_apply', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'ledger_accounts.balance_cents is derived from ledger_entries and cannot be set directly';
  END IF;
  IF NEW."kind" <> OLD."kind" OR NEW."wallet_id" IS DISTINCT FROM OLD."wallet_id" OR NEW."currency" <> OLD."currency" THEN
    RAISE EXCEPTION 'ledger account identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ledger_accounts_guard" BEFORE UPDATE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION public._ledger_accounts_guard();

CREATE OR REPLACE FUNCTION public._ledger_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are immutable: % on % refused', TG_OP, TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER "ledger_entries_immutable" BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION public._ledger_immutable();
CREATE TRIGGER "ledger_transactions_immutable" BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION public._ledger_immutable();
CREATE TRIGGER "financial_audit_log_immutable" BEFORE UPDATE OR DELETE ON "financial_audit_log"
  FOR EACH ROW EXECUTE FUNCTION public._ledger_immutable();

-- Double entry: at commit, every transaction's entries must sum to zero.
CREATE OR REPLACE FUNCTION public._ledger_check_balanced()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_sum BIGINT;
BEGIN
  SELECT COALESCE(SUM("amount_cents"), 0) INTO v_sum FROM "ledger_entries" WHERE "transaction_id" = NEW."transaction_id";
  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'unbalanced ledger transaction %: entries sum to %', NEW."transaction_id", v_sum;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "ledger_entries_balanced" AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public._ledger_check_balanced();

-- ----------------------------------------------------------------------------
-- Internal helpers (no EXECUTE for clients; see the grants at the bottom)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._settings()
RETURNS "platform_settings" LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT * FROM "platform_settings" WHERE "id" = 1;
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (SELECT 1 FROM "admin_users" WHERE "user_id" = auth.uid());
$$;

CREATE OR REPLACE FUNCTION public._caller_is_service()
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT auth.role() = 'service_role';
$$;

CREATE OR REPLACE FUNCTION public._require_admin()
RETURNS void LANGUAGE plpgsql STABLE SET search_path = public AS $$
BEGIN
  IF NOT (public.is_admin() OR public._caller_is_service()) THEN
    RAISE EXCEPTION 'admin permission required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._require_service()
RETURNS void LANGUAGE plpgsql STABLE SET search_path = public AS $$
BEGIN
  IF NOT public._caller_is_service() THEN
    RAISE EXCEPTION 'service role required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._actor_role()
RETURNS text LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE
    WHEN public._caller_is_service() THEN 'service'
    WHEN public.is_admin() THEN 'admin'
    WHEN auth.uid() IS NOT NULL THEN 'user'
    ELSE 'system'
  END;
$$;

CREATE OR REPLACE FUNCTION public._audit(
  p_action text, p_target_type text, p_target_id text, p_amount_cents bigint DEFAULT NULL, p_details jsonb DEFAULT '{}'::jsonb
) RETURNS void LANGUAGE sql SET search_path = public AS $$
  INSERT INTO "financial_audit_log" ("actor_id", "actor_role", "action", "target_type", "target_id", "amount_cents", "details")
  VALUES (auth.uid(), public._actor_role(), p_action, p_target_type, p_target_id, p_amount_cents, COALESCE(p_details, '{}'::jsonb));
$$;

-- Counts successful operations per key per window. Failed calls roll their
-- increment back with the rest of the transaction, so this bounds how many
-- times something *succeeds*, which is what matters for money endpoints.
CREATE OR REPLACE FUNCTION public._consume_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_bucket BIGINT := floor(extract(epoch FROM now()) / p_window_seconds)::bigint;
  v_count INTEGER;
BEGIN
  INSERT INTO "rate_limit_buckets" ("key", "bucket", "count") VALUES (p_key, v_bucket, 1)
  ON CONFLICT ("key", "bucket") DO UPDATE SET "count" = "rate_limit_buckets"."count" + 1
  RETURNING "count" INTO v_count;
  IF v_count > p_limit THEN
    RAISE EXCEPTION 'rate limit exceeded for %', split_part(p_key, ':', 1);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._platform_account(p_kind "LedgerAccountKind", p_currency char(3) DEFAULT 'USD')
RETURNS uuid LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT "id" FROM "ledger_accounts" WHERE "kind" = p_kind AND "currency" = p_currency AND "wallet_id" IS NULL;
$$;

-- Creates the wallet, its four accounts and the compliance profile on first
-- touch. Safe to call repeatedly.
CREATE OR REPLACE FUNCTION public._ensure_wallet(p_user_id uuid)
RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_wallet_id UUID;
  v_kind "LedgerAccountKind";
BEGIN
  INSERT INTO "wallets" ("user_id") VALUES (p_user_id)
  ON CONFLICT ("user_id") DO NOTHING;
  SELECT "id" INTO v_wallet_id FROM "wallets" WHERE "user_id" = p_user_id;

  FOREACH v_kind IN ARRAY ARRAY['user_available', 'user_locked', 'user_pending_withdrawal', 'user_promo']::"LedgerAccountKind"[] LOOP
    INSERT INTO "ledger_accounts" ("kind", "wallet_id", "user_id") VALUES (v_kind, v_wallet_id, p_user_id)
    ON CONFLICT ("wallet_id", "kind") DO NOTHING;
  END LOOP;

  INSERT INTO "compliance_profiles" ("user_id") VALUES (p_user_id)
  ON CONFLICT ("user_id") DO NOTHING;

  RETURN v_wallet_id;
END;
$$;

CREATE OR REPLACE FUNCTION public._user_account(p_user_id uuid, p_kind "LedgerAccountKind")
RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_wallet_id UUID := public._ensure_wallet(p_user_id);
  v_id UUID;
BEGIN
  SELECT "id" INTO v_id FROM "ledger_accounts" WHERE "wallet_id" = v_wallet_id AND "kind" = p_kind;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public._account_balance(p_account_id uuid)
RETURNS bigint LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT "balance_cents" FROM "ledger_accounts" WHERE "id" = p_account_id;
$$;

-- THE ONLY WAY MONEY MOVES.
--
-- p_entries: JSON array of {"account_id": uuid, "amount_cents": bigint}. The
-- amounts must sum to zero (the deferred trigger enforces it too). Accounts
-- are locked in id order so two concurrent postings touching the same
-- accounts serialise instead of deadlocking. After posting, every user
-- account touched must be >= 0 unless p_allow_negative (reversals only).
-- Re-posting an idempotency key returns the original transaction id.
CREATE OR REPLACE FUNCTION public._post_ledger_transaction(
  p_type "LedgerTransactionType",
  p_idempotency_key text,
  p_entries jsonb,
  p_description text DEFAULT NULL,
  p_contest_id uuid DEFAULT NULL,
  p_match_id uuid DEFAULT NULL,
  p_deposit_id uuid DEFAULT NULL,
  p_withdrawal_id uuid DEFAULT NULL,
  p_provider_event_id uuid DEFAULT NULL,
  p_reverses_transaction_id uuid DEFAULT NULL,
  p_actor uuid DEFAULT NULL,
  p_allow_negative boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_existing UUID;
  v_tx_id UUID;
  v_sum BIGINT;
  v_entry RECORD;
  v_acct RECORD;
  v_ids UUID[];
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'idempotency key required';
  END IF;

  SELECT "id" INTO v_existing FROM "ledger_transactions" WHERE "idempotency_key" = p_idempotency_key;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) < 2 THEN
    RAISE EXCEPTION 'a ledger transaction needs at least two entries';
  END IF;

  SELECT COALESCE(SUM((e->>'amount_cents')::bigint), 0), array_agg(DISTINCT (e->>'account_id')::uuid)
    INTO v_sum, v_ids
    FROM jsonb_array_elements(p_entries) e;
  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'unbalanced ledger transaction: entries sum to %', v_sum;
  END IF;

  -- Deterministic lock order.
  PERFORM 1 FROM "ledger_accounts" WHERE "id" = ANY (v_ids) ORDER BY "id" FOR UPDATE;
  IF (SELECT count(*) FROM "ledger_accounts" WHERE "id" = ANY (v_ids)) <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'unknown ledger account in transaction';
  END IF;
  IF (SELECT count(DISTINCT "currency") FROM "ledger_accounts" WHERE "id" = ANY (v_ids)) <> 1 THEN
    RAISE EXCEPTION 'ledger transactions cannot mix currencies';
  END IF;

  BEGIN
    INSERT INTO "ledger_transactions"
      ("type", "idempotency_key", "description", "contest_id", "match_id", "deposit_id", "withdrawal_id",
       "provider_event_id", "reverses_transaction_id", "created_by")
    VALUES
      (p_type, p_idempotency_key, p_description, p_contest_id, p_match_id, p_deposit_id, p_withdrawal_id,
       p_provider_event_id, p_reverses_transaction_id, p_actor)
    RETURNING "id" INTO v_tx_id;
  EXCEPTION WHEN unique_violation THEN
    -- Lost a race on the same key: the other posting is authoritative.
    SELECT "id" INTO v_existing FROM "ledger_transactions" WHERE "idempotency_key" = p_idempotency_key;
    RETURN v_existing;
  END;

  FOR v_entry IN SELECT (e->>'account_id')::uuid AS account_id, (e->>'amount_cents')::bigint AS amount_cents
                 FROM jsonb_array_elements(p_entries) e LOOP
    IF v_entry.amount_cents IS NULL OR v_entry.amount_cents = 0 THEN
      RAISE EXCEPTION 'ledger entries must be non-zero';
    END IF;
    INSERT INTO "ledger_entries" ("transaction_id", "account_id", "amount_cents")
    VALUES (v_tx_id, v_entry.account_id, v_entry.amount_cents);
  END LOOP;

  IF NOT p_allow_negative THEN
    FOR v_acct IN SELECT "id", "kind", "balance_cents" FROM "ledger_accounts" WHERE "id" = ANY (v_ids) LOOP
      IF v_acct."kind"::text LIKE 'user_%' AND v_acct."balance_cents" < 0 THEN
        RAISE EXCEPTION 'insufficient funds';
      END IF;
    END LOOP;
  END IF;

  RETURN v_tx_id;
END;
$$;

-- Integer-only fee maths. fee = round-half-up(gross * bps / 10000), then
-- clamped to the schedule's min/max and never above the gross pool.
CREATE OR REPLACE FUNCTION public._calculate_settlement(p_entry_fee_cents bigint, p_seats integer)
RETURNS TABLE (
  gross_pool_cents bigint, platform_fee_cents bigint, winner_payout_cents bigint,
  fee_schedule_id uuid, rake_bps integer
) LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_fs "fee_schedules"%ROWTYPE;
  v_gross BIGINT;
  v_fee BIGINT;
BEGIN
  SELECT * INTO v_fs FROM "fee_schedules" WHERE "active" LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no active fee schedule';
  END IF;
  IF p_entry_fee_cents < 0 OR p_seats < 1 THEN
    RAISE EXCEPTION 'invalid settlement inputs';
  END IF;

  v_gross := p_entry_fee_cents * p_seats;
  v_fee := (v_gross * v_fs."rake_bps" + 5000) / 10000;
  IF v_fee < v_fs."min_fee_cents" THEN v_fee := v_fs."min_fee_cents"; END IF;
  IF v_fs."max_fee_cents" IS NOT NULL AND v_fee > v_fs."max_fee_cents" THEN v_fee := v_fs."max_fee_cents"; END IF;
  IF v_fee > v_gross THEN v_fee := v_gross; END IF;

  gross_pool_cents := v_gross;
  platform_fee_cents := v_fee;
  winner_payout_cents := v_gross - v_fee;
  fee_schedule_id := v_fs."id";
  rake_bps := v_fs."rake_bps";
  RETURN NEXT;
END;
$$;

-- Eligibility engine. Returns reason codes; an empty array means eligible.
-- p_purpose: 'enter' | 'deposit' | 'withdraw'. Rules that only bite in
-- production are gated on platform_settings.environment so sandbox play
-- works without a KYC/location provider — but nothing here can be made
-- to pass in production without those providers having written the
-- verification rows.
CREATE OR REPLACE FUNCTION public._eligibility(p_user_id uuid, p_purpose text, p_amount_cents bigint DEFAULT 0)
RETURNS text[] LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  s "platform_settings"%ROWTYPE := public._settings();
  c "compliance_profiles"%ROWTYPE;
  w "wallets"%ROWTYPE;
  j "jurisdiction_rules"%ROWTYPE;
  v_reasons TEXT[] := ARRAY[]::TEXT[];
  v_prod BOOLEAN := (s."environment" = 'production');
  v_age INTEGER;
BEGIN
  IF NOT s."real_money_enabled" THEN
    v_reasons := array_append(v_reasons, 'real_money_disabled');
  END IF;

  SELECT * INTO w FROM "wallets" WHERE "user_id" = p_user_id;
  IF FOUND AND w."status" <> 'active' THEN
    v_reasons := array_append(v_reasons, ('wallet_' || w."status"::text));
  END IF;

  SELECT * INTO c FROM "compliance_profiles" WHERE "user_id" = p_user_id;
  IF NOT FOUND THEN
    c."status" := 'unverified';
    c."risk_status" := 'normal';
    c."sanctions_status" := 'unchecked';
  END IF;

  -- Hard stops in every environment.
  IF c."status" IN ('restricted', 'rejected') THEN
    v_reasons := array_append(v_reasons, ('compliance_' || c."status"::text));
  END IF;
  IF c."risk_status" = 'blocked' THEN
    v_reasons := array_append(v_reasons, 'risk_blocked');
  END IF;
  IF c."self_excluded_until" IS NOT NULL AND c."self_excluded_until" > now() THEN
    v_reasons := array_append(v_reasons, 'self_excluded');
  END IF;
  IF c."sanctions_status" = 'hit' THEN
    v_reasons := array_append(v_reasons, 'sanctions_hit');
  END IF;
  IF p_purpose = 'withdraw' AND c."risk_status" = 'review' THEN
    v_reasons := array_append(v_reasons, 'risk_review');
  END IF;

  -- Identity, age, location: mandatory for real money in production.
  IF v_prod OR p_purpose = 'withdraw' THEN
    IF c."status" <> 'verified' THEN
      v_reasons := array_append(v_reasons, 'kyc_required');
    END IF;
  END IF;
  IF v_prod THEN
    IF c."age_verified_at" IS NULL OR c."date_of_birth" IS NULL THEN
      v_reasons := array_append(v_reasons, 'age_unverified');
    ELSE
      v_age := date_part('year', age(c."date_of_birth"))::integer;
      IF v_age < s."min_age" THEN
        v_reasons := array_append(v_reasons, 'underage');
      END IF;
    END IF;
    IF c."sanctions_status" <> 'clear' THEN
      v_reasons := array_append(v_reasons, 'sanctions_unchecked');
    END IF;
    IF p_purpose IN ('enter', 'deposit') THEN
      IF c."location_verified_at" IS NULL OR c."jurisdiction_code" IS NULL THEN
        v_reasons := array_append(v_reasons, 'location_unverified');
      ELSIF c."location_verified_at" < now() - make_interval(mins => s."location_check_ttl_minutes") THEN
        v_reasons := array_append(v_reasons, 'location_stale');
      ELSE
        SELECT * INTO j FROM "jurisdiction_rules" WHERE "code" = c."jurisdiction_code";
        IF NOT FOUND THEN
          v_reasons := array_append(v_reasons, 'jurisdiction_unknown');
        ELSIF NOT j."paid_contests_allowed" THEN
          v_reasons := array_append(v_reasons, 'jurisdiction_blocked');
        ELSIF v_age IS NOT NULL AND v_age < j."min_age" THEN
          v_reasons := array_append(v_reasons, 'underage_in_jurisdiction');
        END IF;
      END IF;
    END IF;
  END IF;

  -- Deposit limits (user override, else platform default).
  IF p_purpose = 'deposit' AND p_amount_cents > 0 THEN
    IF p_amount_cents < s."min_deposit_cents" THEN
      v_reasons := array_append(v_reasons, 'below_min_deposit');
    END IF;
    IF p_amount_cents > s."max_deposit_cents" THEN
      v_reasons := array_append(v_reasons, 'above_max_deposit');
    END IF;
    IF (SELECT COALESCE(SUM("amount_cents"), 0) FROM "deposits"
         WHERE "user_id" = p_user_id AND "status" IN ('initiated', 'pending', 'succeeded')
           AND "created_at" > now() - interval '1 day') + p_amount_cents
       > COALESCE(c."deposit_limit_daily_cents", s."default_daily_deposit_limit_cents") THEN
      v_reasons := array_append(v_reasons, 'daily_deposit_limit');
    END IF;
    IF (SELECT COALESCE(SUM("amount_cents"), 0) FROM "deposits"
         WHERE "user_id" = p_user_id AND "status" IN ('initiated', 'pending', 'succeeded')
           AND "created_at" > now() - interval '30 days') + p_amount_cents
       > COALESCE(c."deposit_limit_monthly_cents", s."default_monthly_deposit_limit_cents") THEN
      v_reasons := array_append(v_reasons, 'monthly_deposit_limit');
    END IF;
  END IF;

  RETURN v_reasons;
END;
$$;

-- ----------------------------------------------------------------------------
-- Views (security_invoker: RLS of the underlying tables applies to the caller)
-- ----------------------------------------------------------------------------

CREATE VIEW "wallet_balances" WITH (security_invoker = true) AS
SELECT
  w."id"        AS wallet_id,
  w."user_id",
  w."currency",
  w."status",
  COALESCE(SUM(a."balance_cents") FILTER (WHERE a."kind" = 'user_available'), 0)          AS available_cents,
  COALESCE(SUM(a."balance_cents") FILTER (WHERE a."kind" = 'user_locked'), 0)             AS locked_cents,
  COALESCE(SUM(a."balance_cents") FILTER (WHERE a."kind" = 'user_pending_withdrawal'), 0) AS pending_withdrawal_cents,
  COALESCE(SUM(a."balance_cents") FILTER (WHERE a."kind" = 'user_promo'), 0)              AS promo_cents,
  COALESCE(SUM(a."balance_cents") FILTER (WHERE a."kind" IN ('user_available', 'user_promo')), 0) AS spendable_cents,
  GREATEST(COALESCE(SUM(a."balance_cents") FILTER (WHERE a."kind" = 'user_available'), 0), 0) AS withdrawable_cents,
  COALESCE(SUM(a."balance_cents"), 0) AS total_cents
FROM "wallets" w
LEFT JOIN "ledger_accounts" a ON a."wallet_id" = w."id"
GROUP BY w."id";

-- One row per ledger transaction that changed a user's spendable money, from
-- that user's point of view. Internal legs (locked -> released on a loss,
-- pending -> clearing on a completed withdrawal) net to zero and are hidden.
CREATE VIEW "wallet_transactions" WITH (security_invoker = true) AS
SELECT
  t."id",
  a."user_id",
  t."type",
  t."created_at",
  SUM(e."amount_cents") FILTER (WHERE a."kind" IN ('user_available', 'user_promo')) AS amount_cents,
  t."description",
  t."contest_id",
  t."match_id",
  c."type"        AS contest_type,
  t."deposit_id",
  t."withdrawal_id",
  COALESCE(d."status"::text, wd."status"::text, 'posted') AS status,
  COALESCE(d."provider_ref", wd."provider_ref")            AS payment_reference,
  t."reverses_transaction_id"
FROM "ledger_transactions" t
JOIN "ledger_entries" e ON e."transaction_id" = t."id"
JOIN "ledger_accounts" a ON a."id" = e."account_id" AND a."user_id" IS NOT NULL
LEFT JOIN "challenges" c ON c."id" = t."contest_id"
LEFT JOIN "deposits" d ON d."id" = t."deposit_id"
LEFT JOIN "withdrawals" wd ON wd."id" = t."withdrawal_id"
GROUP BY t."id", a."user_id", c."type", d."status", wd."status", d."provider_ref", wd."provider_ref"
HAVING SUM(e."amount_cents") FILTER (WHERE a."kind" IN ('user_available', 'user_promo')) <> 0;

-- ----------------------------------------------------------------------------
-- Wallet: read
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_my_wallet()
RETURNS SETOF "wallet_balances" LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  PERFORM public._ensure_wallet(auth.uid());
  RETURN QUERY SELECT * FROM "wallet_balances" WHERE "user_id" = auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_eligibility()
RETURNS TABLE (
  compliance_status "ComplianceStatus", risk_status "RiskStatus", jurisdiction_code text,
  location_verified_at timestamptz, self_excluded_until timestamptz,
  real_money_enabled boolean, environment text,
  can_enter boolean, enter_reasons text[],
  can_deposit boolean, deposit_reasons text[],
  can_withdraw boolean, withdraw_reasons text[]
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s "platform_settings"%ROWTYPE := public._settings();
  c "compliance_profiles"%ROWTYPE;
  v_enter TEXT[];
  v_deposit TEXT[];
  v_withdraw TEXT[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  PERFORM public._ensure_wallet(auth.uid());
  SELECT * INTO c FROM "compliance_profiles" WHERE "user_id" = auth.uid();
  v_enter := public._eligibility(auth.uid(), 'enter', 0);
  v_deposit := public._eligibility(auth.uid(), 'deposit', 0);
  v_withdraw := public._eligibility(auth.uid(), 'withdraw', 0);
  compliance_status := c."status";
  risk_status := c."risk_status";
  jurisdiction_code := c."jurisdiction_code";
  location_verified_at := c."location_verified_at";
  self_excluded_until := c."self_excluded_until";
  real_money_enabled := s."real_money_enabled";
  environment := s."environment";
  can_enter := array_length(v_enter, 1) IS NULL;
  enter_reasons := v_enter;
  can_deposit := array_length(v_deposit, 1) IS NULL;
  deposit_reasons := v_deposit;
  can_withdraw := array_length(v_withdraw, 1) IS NULL;
  withdraw_reasons := v_withdraw;
  RETURN NEXT;
END;
$$;

-- Server-side eligibility check a client may ask about itself. Admins and
-- the service role may ask about anyone.
CREATE OR REPLACE FUNCTION public.can_user_enter_paid_contest(p_user_id uuid, p_entry_fee_cents bigint)
RETURNS TABLE (eligible boolean, reasons text[]) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_reasons TEXT[];
  v_available BIGINT;
BEGIN
  IF NOT (p_user_id = auth.uid() OR public.is_admin() OR public._caller_is_service()) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  v_reasons := public._eligibility(p_user_id, 'enter', p_entry_fee_cents);
  IF NOT EXISTS (SELECT 1 FROM "contest_stake_options" WHERE "amount_cents" = p_entry_fee_cents AND "active") THEN
    v_reasons := array_append(v_reasons, 'stake_not_offered');
  END IF;
  SELECT COALESCE(SUM("balance_cents"), 0) INTO v_available FROM "ledger_accounts"
   WHERE "user_id" = p_user_id AND "kind" IN ('user_available', 'user_promo');
  IF v_available < p_entry_fee_cents THEN
    v_reasons := array_append(v_reasons, 'insufficient_funds');
  END IF;
  eligible := array_length(v_reasons, 1) IS NULL;
  reasons := v_reasons;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.settlement_preview(p_entry_fee_cents bigint)
RETURNS TABLE (
  entry_fee_cents bigint, gross_pool_cents bigint, platform_fee_cents bigint, winner_payout_cents bigint, rake_bps integer
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r RECORD;
BEGIN
  IF p_entry_fee_cents IS NULL OR p_entry_fee_cents <= 0 THEN
    RAISE EXCEPTION 'entry fee must be positive';
  END IF;
  SELECT * INTO r FROM public._calculate_settlement(p_entry_fee_cents, 2);
  entry_fee_cents := p_entry_fee_cents;
  gross_pool_cents := r.gross_pool_cents;
  platform_fee_cents := r.platform_fee_cents;
  winner_payout_cents := r.winner_payout_cents;
  rake_bps := r.rake_bps;
  RETURN NEXT;
END;
$$;

-- ----------------------------------------------------------------------------
-- Deposits
-- ----------------------------------------------------------------------------

-- Called by the deposit-initiate edge function (service role) AFTER it has
-- derived p_user_id from the caller's JWT. Never callable by a client.
CREATE OR REPLACE FUNCTION public.initiate_deposit(
  p_user_id uuid, p_amount_cents bigint, p_idempotency_key text, p_provider text
) RETURNS "deposits" LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s "platform_settings"%ROWTYPE := public._settings();
  v_wallet_id UUID;
  v_reasons TEXT[];
  d "deposits"%ROWTYPE;
BEGIN
  PERFORM public._require_service();
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'deposit amount must be positive';
  END IF;
  IF p_provider IS DISTINCT FROM s."payment_provider" THEN
    RAISE EXCEPTION 'payment provider % is not the configured provider', p_provider;
  END IF;

  SELECT * INTO d FROM "deposits" WHERE "idempotency_key" = p_idempotency_key;
  IF FOUND THEN
    IF d."user_id" <> p_user_id THEN
      RAISE EXCEPTION 'idempotency key belongs to another user';
    END IF;
    RETURN d;
  END IF;

  v_wallet_id := public._ensure_wallet(p_user_id);
  v_reasons := public._eligibility(p_user_id, 'deposit', p_amount_cents);
  IF array_length(v_reasons, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'deposit not allowed: %', array_to_string(v_reasons, ',');
  END IF;
  PERFORM public._consume_rate_limit('deposit:' || p_user_id::text, 10, 3600);

  INSERT INTO "deposits" ("user_id", "wallet_id", "amount_cents", "provider", "idempotency_key")
  VALUES (p_user_id, v_wallet_id, p_amount_cents, p_provider, p_idempotency_key)
  RETURNING * INTO d;

  PERFORM public._audit('deposit.initiated', 'deposit', d."id"::text, p_amount_cents,
                        jsonb_build_object('user_id', p_user_id, 'provider', p_provider));
  RETURN d;
END;
$$;

-- The edge function records the provider's reference once the provider has
-- accepted the deposit (e.g. a PaymentIntent id). Service role only.
CREATE OR REPLACE FUNCTION public.attach_deposit_provider_ref(p_deposit_id uuid, p_provider_ref text)
RETURNS "deposits" LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d "deposits"%ROWTYPE;
BEGIN
  PERFORM public._require_service();
  SELECT * INTO d FROM "deposits" WHERE "id" = p_deposit_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deposit % not found', p_deposit_id;
  END IF;
  IF d."provider_ref" IS NOT NULL AND d."provider_ref" <> p_provider_ref THEN
    RAISE EXCEPTION 'deposit % already has a provider reference', p_deposit_id;
  END IF;
  UPDATE "deposits" SET "provider_ref" = p_provider_ref, "status" = 'pending', "updated_at" = now()
   WHERE "id" = p_deposit_id AND "status" = 'initiated'
  RETURNING * INTO d;
  RETURN d;
END;
$$;

-- A user may abandon a deposit that never reached the provider.
CREATE OR REPLACE FUNCTION public.cancel_deposit(p_deposit_id uuid)
RETURNS "deposits" LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d "deposits"%ROWTYPE;
BEGIN
  SELECT * INTO d FROM "deposits" WHERE "id" = p_deposit_id AND "user_id" = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deposit not found';
  END IF;
  IF d."status" NOT IN ('initiated', 'pending') THEN
    RAISE EXCEPTION 'deposit is %; it can no longer be cancelled', d."status";
  END IF;
  UPDATE "deposits" SET "status" = 'cancelled', "updated_at" = now() WHERE "id" = p_deposit_id RETURNING * INTO d;
  PERFORM public._audit('deposit.cancelled', 'deposit', d."id"::text, d."amount_cents");
  RETURN d;
END;
$$;

-- ----------------------------------------------------------------------------
-- Provider events: the ONLY path that credits a deposit or completes a
-- withdrawal. Idempotent on (provider, provider_event_id). Amounts in the
-- event are checked against our own record; a mismatch never credits.
--
-- p_payload is the edge function's NORMALISED event:
--   { "kind": "deposit.succeeded" | "deposit.failed" | "deposit.reversed"
--             | "withdrawal.completed" | "withdrawal.failed",
--     "provider_ref": "...", "amount_cents": 500, "currency": "USD",
--     "reason": "...", "raw": { ...provider payload... } }
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_payment_event(
  p_provider text, p_provider_event_id text, p_event_type text, p_payload jsonb, p_signature_verified boolean
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_event_id UUID;
  v_kind TEXT := p_payload->>'kind';
  v_ref TEXT := p_payload->>'provider_ref';
  v_amount BIGINT := NULLIF(p_payload->>'amount_cents', '')::bigint;
  v_currency TEXT := COALESCE(p_payload->>'currency', 'USD');
  v_reason TEXT := p_payload->>'reason';
  d "deposits"%ROWTYPE;
  wd "withdrawals"%ROWTYPE;
  v_tx UUID;
  v_result TEXT := 'ignored';
BEGIN
  PERFORM public._require_service();
  IF NOT p_signature_verified THEN
    RAISE EXCEPTION 'refusing unverified provider event';
  END IF;

  INSERT INTO "payment_provider_events" ("provider", "provider_event_id", "event_type", "payload", "signature_verified")
  VALUES (p_provider, p_provider_event_id, p_event_type, p_payload, true)
  ON CONFLICT ("provider", "provider_event_id") DO NOTHING
  RETURNING "id" INTO v_event_id;
  IF v_event_id IS NULL THEN
    RETURN 'duplicate';
  END IF;

  BEGIN
    IF v_kind LIKE 'deposit.%' THEN
      SELECT * INTO d FROM "deposits" WHERE "provider" = p_provider AND "provider_ref" = v_ref FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'no deposit with provider ref %', v_ref;
      END IF;

      IF v_kind = 'deposit.succeeded' THEN
        IF d."status" = 'succeeded' THEN
          v_result := 'already_applied';
        ELSIF d."status" NOT IN ('initiated', 'pending') THEN
          RAISE EXCEPTION 'deposit % is %, cannot succeed', d."id", d."status";
        ELSIF v_amount IS NULL OR v_amount <> d."amount_cents" OR upper(v_currency) <> d."currency" THEN
          UPDATE "deposits" SET "status" = 'failed', "failure_reason" = 'amount_mismatch', "updated_at" = now() WHERE "id" = d."id";
          PERFORM public._audit('deposit.amount_mismatch', 'deposit', d."id"::text, v_amount,
                                jsonb_build_object('expected_cents', d."amount_cents", 'event', p_provider_event_id));
          v_result := 'amount_mismatch';
        ELSE
          v_tx := public._post_ledger_transaction(
            'deposit', 'deposit:' || d."id"::text,
            jsonb_build_array(
              jsonb_build_object('account_id', public._platform_account('platform_clearing'), 'amount_cents', -d."amount_cents"),
              jsonb_build_object('account_id', public._user_account(d."user_id", 'user_available'), 'amount_cents', d."amount_cents")
            ),
            'Deposit', NULL, NULL, d."id", NULL, v_event_id, NULL, NULL, false);
          UPDATE "deposits" SET "status" = 'succeeded', "credited_transaction_id" = v_tx, "succeeded_at" = now(), "updated_at" = now()
           WHERE "id" = d."id";
          v_result := 'credited';
        END IF;

      ELSIF v_kind = 'deposit.failed' THEN
        IF d."status" IN ('initiated', 'pending') THEN
          UPDATE "deposits" SET "status" = 'failed', "failure_reason" = COALESCE(v_reason, 'provider_failed'), "updated_at" = now() WHERE "id" = d."id";
          v_result := 'failed';
        ELSE
          v_result := 'already_' || d."status"::text;
        END IF;

      ELSIF v_kind = 'deposit.reversed' THEN
        -- Chargeback / dispute: take the money back even if it has been
        -- spent (balance may go negative) and put the account under review.
        IF d."status" = 'reversed' THEN
          v_result := 'already_applied';
        ELSIF d."status" <> 'succeeded' THEN
          RAISE EXCEPTION 'deposit % is %, cannot reverse', d."id", d."status";
        ELSE
          v_tx := public._post_ledger_transaction(
            'deposit_reversal', 'deposit_reversal:' || d."id"::text,
            jsonb_build_array(
              jsonb_build_object('account_id', public._user_account(d."user_id", 'user_available'), 'amount_cents', -d."amount_cents"),
              jsonb_build_object('account_id', public._platform_account('platform_clearing'), 'amount_cents', d."amount_cents")
            ),
            COALESCE(v_reason, 'Deposit reversed'), NULL, NULL, d."id", NULL, v_event_id, d."credited_transaction_id", NULL, true);
          UPDATE "deposits" SET "status" = 'reversed', "reversal_transaction_id" = v_tx, "reversed_at" = now(), "updated_at" = now()
           WHERE "id" = d."id";
          UPDATE "compliance_profiles" SET "risk_status" = 'review',
                 "risk_notes" = concat_ws(E'\n', "risk_notes", 'deposit ' || d."id"::text || ' reversed'), "updated_at" = now()
           WHERE "user_id" = d."user_id" AND "risk_status" = 'normal';
          PERFORM public._audit('deposit.reversed', 'deposit', d."id"::text, d."amount_cents", jsonb_build_object('reason', v_reason));
          v_result := 'reversed';
        END IF;
      ELSE
        RAISE EXCEPTION 'unknown deposit event kind %', v_kind;
      END IF;

    ELSIF v_kind LIKE 'withdrawal.%' THEN
      SELECT * INTO wd FROM "withdrawals" WHERE "provider" = p_provider AND "provider_ref" = v_ref FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'no withdrawal with provider ref %', v_ref;
      END IF;

      IF v_kind = 'withdrawal.completed' THEN
        IF wd."status" = 'completed' THEN
          v_result := 'already_applied';
        ELSIF wd."status" <> 'processing' THEN
          RAISE EXCEPTION 'withdrawal % is %, cannot complete', wd."id", wd."status";
        ELSIF v_amount IS NOT NULL AND v_amount <> wd."amount_cents" THEN
          RAISE EXCEPTION 'withdrawal % amount mismatch (% vs %)', wd."id", v_amount, wd."amount_cents";
        ELSE
          v_tx := public._post_ledger_transaction(
            'withdrawal', 'withdrawal_complete:' || wd."id"::text,
            jsonb_build_array(
              jsonb_build_object('account_id', public._user_account(wd."user_id", 'user_pending_withdrawal'), 'amount_cents', -wd."amount_cents"),
              jsonb_build_object('account_id', public._platform_account('platform_clearing'), 'amount_cents', wd."amount_cents")
            ),
            'Withdrawal sent', NULL, NULL, NULL, wd."id", v_event_id, NULL, NULL, false);
          UPDATE "withdrawals" SET "status" = 'completed', "completion_transaction_id" = v_tx, "completed_at" = now(), "updated_at" = now()
           WHERE "id" = wd."id";
          v_result := 'completed';
        END IF;

      ELSIF v_kind = 'withdrawal.failed' THEN
        IF wd."status" IN ('failed', 'cancelled') THEN
          v_result := 'already_applied';
        ELSIF wd."status" NOT IN ('processing', 'requested', 'under_review') THEN
          RAISE EXCEPTION 'withdrawal % is %, cannot fail', wd."id", wd."status";
        ELSE
          v_tx := public._post_ledger_transaction(
            'withdrawal_release', 'withdrawal_release:' || wd."id"::text,
            jsonb_build_array(
              jsonb_build_object('account_id', public._user_account(wd."user_id", 'user_pending_withdrawal'), 'amount_cents', -wd."amount_cents"),
              jsonb_build_object('account_id', public._user_account(wd."user_id", 'user_available'), 'amount_cents', wd."amount_cents")
            ),
            'Withdrawal failed, funds returned', NULL, NULL, NULL, wd."id", v_event_id, wd."lock_transaction_id", NULL, false);
          UPDATE "withdrawals" SET "status" = 'failed', "release_transaction_id" = v_tx,
                 "failure_reason" = COALESCE(v_reason, 'provider_failed'), "updated_at" = now()
           WHERE "id" = wd."id";
          v_result := 'failed';
        END IF;
      ELSE
        RAISE EXCEPTION 'unknown withdrawal event kind %', v_kind;
      END IF;
    ELSE
      v_result := 'ignored';
    END IF;

    UPDATE "payment_provider_events" SET "processing_status" = CASE WHEN v_result = 'ignored' THEN 'ignored' ELSE 'processed' END,
           "processed_at" = now()
     WHERE "id" = v_event_id;
    RETURN v_result;
  EXCEPTION WHEN OTHERS THEN
    -- The inner block's writes are rolled back; the event row (inserted
    -- outside the block) survives, marked failed, so the provider is not
    -- retried into the same failure forever and an operator can see it.
    UPDATE "payment_provider_events" SET "processing_status" = 'failed', "processing_error" = SQLERRM, "processed_at" = now()
     WHERE "id" = v_event_id;
    RETURN 'failed: ' || SQLERRM;
  END;
END;
$$;

-- ----------------------------------------------------------------------------
-- Withdrawals
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.request_withdrawal(
  p_amount_cents bigint, p_idempotency_key text, p_destination_type text, p_destination_ref text DEFAULT NULL
) RETURNS "withdrawals" LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s "platform_settings"%ROWTYPE := public._settings();
  c "compliance_profiles"%ROWTYPE;
  v_user UUID := auth.uid();
  v_wallet_id UUID;
  v_reasons TEXT[];
  v_available UUID;
  v_pending UUID;
  v_tx UUID;
  wd "withdrawals"%ROWTYPE;
  v_status "WithdrawalStatus" := 'requested';
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'withdrawal amount must be positive';
  END IF;

  SELECT * INTO wd FROM "withdrawals" WHERE "idempotency_key" = p_idempotency_key;
  IF FOUND THEN
    IF wd."user_id" <> v_user THEN
      RAISE EXCEPTION 'idempotency key belongs to another user';
    END IF;
    RETURN wd;
  END IF;

  v_wallet_id := public._ensure_wallet(v_user);
  v_reasons := public._eligibility(v_user, 'withdraw', p_amount_cents);
  IF array_length(v_reasons, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'withdrawal not allowed: %', array_to_string(v_reasons, ',');
  END IF;
  IF p_amount_cents < s."min_withdrawal_cents" THEN
    RAISE EXCEPTION 'withdrawal not allowed: below_min_withdrawal';
  END IF;
  IF p_amount_cents > s."max_withdrawal_cents" THEN
    RAISE EXCEPTION 'withdrawal not allowed: above_max_withdrawal';
  END IF;
  IF EXISTS (SELECT 1 FROM "withdrawals" WHERE "user_id" = v_user AND "status" IN ('requested', 'under_review', 'processing')) THEN
    RAISE EXCEPTION 'withdrawal not allowed: withdrawal_pending';
  END IF;
  PERFORM public._consume_rate_limit('withdraw:' || v_user::text, 5, 3600);

  v_available := public._user_account(v_user, 'user_available');
  v_pending := public._user_account(v_user, 'user_pending_withdrawal');

  INSERT INTO "withdrawals" ("user_id", "wallet_id", "amount_cents", "destination_type", "destination_ref", "provider", "idempotency_key")
  VALUES (v_user, v_wallet_id, p_amount_cents, p_destination_type, p_destination_ref, s."payment_provider", p_idempotency_key)
  RETURNING * INTO wd;

  -- Raises 'insufficient funds' if available would go negative.
  v_tx := public._post_ledger_transaction(
    'withdrawal', 'withdrawal_lock:' || wd."id"::text,
    jsonb_build_array(
      jsonb_build_object('account_id', v_available, 'amount_cents', -p_amount_cents),
      jsonb_build_object('account_id', v_pending, 'amount_cents', p_amount_cents)
    ),
    'Withdrawal', NULL, NULL, NULL, wd."id", NULL, NULL, v_user, false);

  SELECT * INTO c FROM "compliance_profiles" WHERE "user_id" = v_user;
  IF p_amount_cents >= s."withdrawal_review_threshold_cents" OR c."risk_status" = 'review' THEN
    v_status := 'under_review';
  END IF;

  UPDATE "withdrawals" SET "lock_transaction_id" = v_tx, "status" = v_status, "updated_at" = now()
   WHERE "id" = wd."id" RETURNING * INTO wd;
  PERFORM public._audit('withdrawal.requested', 'withdrawal', wd."id"::text, p_amount_cents,
                        jsonb_build_object('status', v_status, 'destination_type', p_destination_type));
  RETURN wd;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_withdrawal(p_withdrawal_id uuid)
RETURNS "withdrawals" LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  wd "withdrawals"%ROWTYPE;
  v_tx UUID;
BEGIN
  SELECT * INTO wd FROM "withdrawals" WHERE "id" = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND OR NOT (wd."user_id" = auth.uid() OR public.is_admin() OR public._caller_is_service()) THEN
    RAISE EXCEPTION 'withdrawal not found';
  END IF;
  IF wd."status" NOT IN ('requested', 'under_review') THEN
    RAISE EXCEPTION 'withdrawal is %; it can no longer be cancelled', wd."status";
  END IF;
  v_tx := public._post_ledger_transaction(
    'withdrawal_release', 'withdrawal_release:' || wd."id"::text,
    jsonb_build_array(
      jsonb_build_object('account_id', public._user_account(wd."user_id", 'user_pending_withdrawal'), 'amount_cents', -wd."amount_cents"),
      jsonb_build_object('account_id', public._user_account(wd."user_id", 'user_available'), 'amount_cents', wd."amount_cents")
    ),
    'Withdrawal cancelled, funds returned', NULL, NULL, NULL, wd."id", NULL, wd."lock_transaction_id", auth.uid(), false);
  UPDATE "withdrawals" SET "status" = 'cancelled', "release_transaction_id" = v_tx, "updated_at" = now()
   WHERE "id" = wd."id" RETURNING * INTO wd;
  PERFORM public._audit('withdrawal.cancelled', 'withdrawal', wd."id"::text, wd."amount_cents");
  RETURN wd;
END;
$$;

-- Ops decision on a withdrawal held for review. Rejecting returns the funds.
CREATE OR REPLACE FUNCTION public.review_withdrawal(p_withdrawal_id uuid, p_approve boolean, p_notes text DEFAULT NULL)
RETURNS "withdrawals" LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  wd "withdrawals"%ROWTYPE;
BEGIN
  PERFORM public._require_admin();
  SELECT * INTO wd FROM "withdrawals" WHERE "id" = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND OR wd."status" <> 'under_review' THEN
    RAISE EXCEPTION 'withdrawal is not under review';
  END IF;
  IF p_approve THEN
    UPDATE "withdrawals" SET "status" = 'requested', "review_notes" = p_notes, "reviewed_by" = auth.uid(), "updated_at" = now()
     WHERE "id" = wd."id" RETURNING * INTO wd;
    PERFORM public._audit('withdrawal.review_approved', 'withdrawal', wd."id"::text, wd."amount_cents", jsonb_build_object('notes', p_notes));
    RETURN wd;
  ELSE
    UPDATE "withdrawals" SET "review_notes" = p_notes, "reviewed_by" = auth.uid(), "updated_at" = now() WHERE "id" = wd."id";
    PERFORM public._audit('withdrawal.review_rejected', 'withdrawal', wd."id"::text, wd."amount_cents", jsonb_build_object('notes', p_notes));
    RETURN public.cancel_withdrawal(wd."id");
  END IF;
END;
$$;

-- The withdrawal-process edge function calls this once the provider has
-- accepted the transfer. Completion/failure arrive later as provider events.
CREATE OR REPLACE FUNCTION public.mark_withdrawal_processing(p_withdrawal_id uuid, p_provider text, p_provider_ref text)
RETURNS "withdrawals" LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  wd "withdrawals"%ROWTYPE;
BEGIN
  PERFORM public._require_service();
  SELECT * INTO wd FROM "withdrawals" WHERE "id" = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'withdrawal % not found', p_withdrawal_id;
  END IF;
  IF wd."status" = 'processing' AND wd."provider_ref" = p_provider_ref THEN
    RETURN wd;
  END IF;
  IF wd."status" <> 'requested' THEN
    RAISE EXCEPTION 'withdrawal % is %, cannot start processing', wd."id", wd."status";
  END IF;
  UPDATE "withdrawals" SET "status" = 'processing', "provider" = p_provider, "provider_ref" = p_provider_ref, "updated_at" = now()
   WHERE "id" = wd."id" RETURNING * INTO wd;
  PERFORM public._audit('withdrawal.processing', 'withdrawal', wd."id"::text, wd."amount_cents", jsonb_build_object('provider_ref', p_provider_ref));
  RETURN wd;
END;
$$;

-- ----------------------------------------------------------------------------
-- Contests: create / enter / cancel / expire / settle / void
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._lock_contest_entry(
  p_user_id uuid, p_challenge_id uuid, p_amount_cents bigint, p_idempotency_key text
) RETURNS "contest_entries" LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_wallet_id UUID := public._ensure_wallet(p_user_id);
  v_tx UUID;
  e "contest_entries"%ROWTYPE;
BEGIN
  -- Raises 'insufficient funds' when available would go negative.
  v_tx := public._post_ledger_transaction(
    'contest_entry', p_idempotency_key,
    jsonb_build_array(
      jsonb_build_object('account_id', public._user_account(p_user_id, 'user_available'), 'amount_cents', -p_amount_cents),
      jsonb_build_object('account_id', public._user_account(p_user_id, 'user_locked'), 'amount_cents', p_amount_cents)
    ),
    'Contest entry', p_challenge_id, NULL, NULL, NULL, NULL, NULL, p_user_id, false);

  INSERT INTO "contest_entries" ("challenge_id", "user_id", "wallet_id", "amount_cents", "lock_transaction_id")
  VALUES (p_challenge_id, p_user_id, v_wallet_id, p_amount_cents, v_tx)
  RETURNING * INTO e;
  RETURN e;
END;
$$;

CREATE OR REPLACE FUNCTION public._refund_contest_entry(
  p_entry_id uuid, p_type "LedgerTransactionType", p_status "ContestEntryStatus", p_description text, p_match_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  e "contest_entries"%ROWTYPE;
  v_tx UUID;
BEGIN
  SELECT * INTO e FROM "contest_entries" WHERE "id" = p_entry_id FOR UPDATE;
  IF e."status" <> 'locked' THEN
    RETURN e."settlement_transaction_id";
  END IF;
  v_tx := public._post_ledger_transaction(
    p_type, 'refund:' || e."id"::text,
    jsonb_build_array(
      jsonb_build_object('account_id', public._user_account(e."user_id", 'user_locked'), 'amount_cents', -e."amount_cents"),
      jsonb_build_object('account_id', public._user_account(e."user_id", 'user_available'), 'amount_cents', e."amount_cents")
    ),
    p_description, e."challenge_id", p_match_id, NULL, NULL, NULL, e."lock_transaction_id", auth.uid(), false);
  UPDATE "contest_entries" SET "status" = p_status, "settlement_transaction_id" = v_tx, "settled_at" = now() WHERE "id" = e."id";
  RETURN v_tx;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_contest(
  p_type "ChallengeType", p_format "ChallengeFormat", p_entry_fee_cents bigint, p_idempotency_key text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s "platform_settings"%ROWTYPE := public._settings();
  v_user UUID := auth.uid();
  v_reasons TEXT[];
  v_challenge_id UUID;
  v_existing UUID;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'idempotency key required';
  END IF;
  SELECT "contest_id" INTO v_existing FROM "ledger_transactions" WHERE "idempotency_key" = 'entry:create:' || p_idempotency_key;
  IF FOUND THEN
    RETURN v_existing;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "contest_stake_options" WHERE "amount_cents" = p_entry_fee_cents AND "active") THEN
    RAISE EXCEPTION 'contest not allowed: stake_not_offered';
  END IF;
  v_reasons := public._eligibility(v_user, 'enter', p_entry_fee_cents);
  IF array_length(v_reasons, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'contest not allowed: %', array_to_string(v_reasons, ',');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "fitness_profiles" WHERE "user_id" = v_user) THEN
    RAISE EXCEPTION 'contest not allowed: no_fitness_profile';
  END IF;
  PERFORM public._consume_rate_limit('create_contest:' || v_user::text, 20, 3600);

  INSERT INTO "challenges" ("type", "format", "entry_fee_cents", "payment_status", "created_by", "expires_at")
  VALUES (p_type, p_format, p_entry_fee_cents, 'funded', v_user, now() + make_interval(mins => s."open_contest_ttl_minutes"))
  RETURNING "id" INTO v_challenge_id;

  PERFORM public._lock_contest_entry(v_user, v_challenge_id, p_entry_fee_cents, 'entry:create:' || p_idempotency_key);
  PERFORM public._audit('contest.created', 'challenge', v_challenge_id::text, p_entry_fee_cents,
                        jsonb_build_object('type', p_type, 'format', p_format));
  RETURN v_challenge_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.enter_contest(p_challenge_id uuid, p_idempotency_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user UUID := auth.uid();
  v_challenge "challenges"%ROWTYPE;
  v_creator_tier "StrengthTier";
  v_joiner_tier "StrengthTier";
  v_reasons TEXT[];
  v_match_id UUID;
  v_existing UUID;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'idempotency key required';
  END IF;
  SELECT "match_id" INTO v_existing FROM "contest_entries"
   WHERE "user_id" = v_user AND "lock_transaction_id" = (SELECT "id" FROM "ledger_transactions" WHERE "idempotency_key" = 'entry:join:' || p_idempotency_key);
  IF FOUND AND v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- Serialises every joiner on this contest: the first commit wins the seat.
  SELECT * INTO v_challenge FROM "challenges" WHERE "id" = p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contest % not found', p_challenge_id;
  END IF;
  IF v_challenge."status" <> 'open' OR v_challenge."payment_status" <> 'funded' THEN
    RAISE EXCEPTION 'contest % is not open', p_challenge_id;
  END IF;
  IF v_challenge."expires_at" IS NOT NULL AND v_challenge."expires_at" < now() THEN
    RAISE EXCEPTION 'contest % has expired', p_challenge_id;
  END IF;
  IF v_challenge."created_by" = v_user THEN
    RAISE EXCEPTION 'cannot enter your own contest';
  END IF;

  v_reasons := public._eligibility(v_user, 'enter', v_challenge."entry_fee_cents");
  IF array_length(v_reasons, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'contest not allowed: %', array_to_string(v_reasons, ',');
  END IF;

  SELECT "strength_tier" INTO v_creator_tier FROM "fitness_profiles" WHERE "user_id" = v_challenge."created_by";
  SELECT "strength_tier" INTO v_joiner_tier FROM "fitness_profiles" WHERE "user_id" = v_user;
  IF v_creator_tier IS NULL OR v_joiner_tier IS NULL THEN
    RAISE EXCEPTION 'both users need a fitness profile before entering a contest';
  END IF;
  IF v_creator_tier <> v_joiner_tier THEN
    RAISE EXCEPTION 'strength tier mismatch: contest is %, you are %', v_creator_tier, v_joiner_tier;
  END IF;
  PERFORM public._consume_rate_limit('enter_contest:' || v_user::text, 30, 3600);

  -- Lock the joiner's fee (raises 'insufficient funds' if short).
  PERFORM public._lock_contest_entry(v_user, p_challenge_id, v_challenge."entry_fee_cents", 'entry:join:' || p_idempotency_key);

  INSERT INTO "matches" ("challenge_id") VALUES (p_challenge_id) RETURNING "id" INTO v_match_id;
  INSERT INTO "match_participants" ("match_id", "user_id") VALUES (v_match_id, v_challenge."created_by"), (v_match_id, v_user);
  UPDATE "contest_entries" SET "match_id" = v_match_id WHERE "challenge_id" = p_challenge_id;
  UPDATE "challenges" SET "status" = 'matched', "payment_status" = 'locked' WHERE "id" = p_challenge_id;

  PERFORM public._audit('contest.entered', 'challenge', p_challenge_id::text, v_challenge."entry_fee_cents",
                        jsonb_build_object('match_id', v_match_id));
  RETURN v_match_id;
END;
$$;

-- The creator takes an unanswered contest down; the fee goes back.
CREATE OR REPLACE FUNCTION public.cancel_contest(p_challenge_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_challenge "challenges"%ROWTYPE;
  e "contest_entries"%ROWTYPE;
BEGIN
  SELECT * INTO v_challenge FROM "challenges" WHERE "id" = p_challenge_id FOR UPDATE;
  IF NOT FOUND OR NOT (v_challenge."created_by" = auth.uid() OR public.is_admin() OR public._caller_is_service()) THEN
    RAISE EXCEPTION 'contest not found';
  END IF;
  IF v_challenge."status" <> 'open' THEN
    RAISE EXCEPTION 'only an open contest can be cancelled';
  END IF;
  FOR e IN SELECT * FROM "contest_entries" WHERE "challenge_id" = p_challenge_id LOOP
    PERFORM public._refund_contest_entry(e."id", 'contest_refund', 'refunded', 'Contest cancelled');
  END LOOP;
  UPDATE "challenges" SET "status" = 'cancelled', "payment_status" = 'refunded' WHERE "id" = p_challenge_id;
  PERFORM public._audit('contest.cancelled', 'challenge', p_challenge_id::text, v_challenge."entry_fee_cents");
END;
$$;

-- Run on a schedule (pg_cron or an edge cron). Returns how many expired.
CREATE OR REPLACE FUNCTION public.expire_open_contests(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_challenge RECORD;
  e "contest_entries"%ROWTYPE;
  v_count INTEGER := 0;
BEGIN
  PERFORM public._require_admin();
  FOR v_challenge IN
    SELECT "id", "entry_fee_cents" FROM "challenges"
     WHERE "status" = 'open' AND "payment_status" = 'funded' AND "expires_at" < now()
     ORDER BY "expires_at" LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    FOR e IN SELECT * FROM "contest_entries" WHERE "challenge_id" = v_challenge."id" LOOP
      PERFORM public._refund_contest_entry(e."id", 'contest_refund', 'refunded', 'Contest expired');
    END LOOP;
    UPDATE "challenges" SET "status" = 'expired', "payment_status" = 'refunded' WHERE "id" = v_challenge."id";
    PERFORM public._audit('contest.expired', 'challenge', v_challenge."id"::text, v_challenge."entry_fee_cents");
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Settlement. Same winner/tie/anomaly rules as the retired settle_match(),
-- now paying real money through the ledger.
--
--   * Idempotent: contest_settlements(match_id) is unique and matches.settled_at
--     is checked under the row lock, so a second call (from the second
--     submitter, a retry, or an operator) returns 'already_settled' and
--     moves nothing.
--   * Winner: both locked entries -> winner available (gross minus fee) and
--     platform revenue (fee), in ONE ledger transaction, so the books can
--     never show the pot half-paid.
--   * Tie: each entry returned to its owner.
--   * Anomaly on the decisive session: nothing moves; the challenge goes to
--     needs_review / review_hold. Once a reviewer clears the session,
--     calling this again settles normally.
CREATE OR REPLACE FUNCTION public.settle_contest(p_match_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_match "matches"%ROWTYPE;
  v_challenge "challenges"%ROWTYPE;
  v_a RECORD;
  v_b RECORD;
  v_participants INTEGER;
  v_submitted INTEGER;
  v_score_a INTEGER;
  v_score_b INTEGER;
  v_winner UUID;
  v_loser UUID;
  v_blocked BOOLEAN;
  v_calc RECORD;
  v_tx UUID;
  v_entries JSONB;
  e "contest_entries"%ROWTYPE;
  v_seats INTEGER;
BEGIN
  SELECT * INTO v_match FROM "matches" WHERE "id" = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'match % not found', p_match_id;
  END IF;
  IF NOT (public._caller_is_service() OR public.is_admin() OR EXISTS (
        SELECT 1 FROM "match_participants" WHERE "match_id" = p_match_id AND "user_id" = auth.uid())) THEN
    RAISE EXCEPTION 'you are not a participant in this match';
  END IF;
  IF v_match."settled_at" IS NOT NULL OR EXISTS (SELECT 1 FROM "contest_settlements" WHERE "match_id" = p_match_id) THEN
    RETURN 'already_settled';
  END IF;

  SELECT * INTO v_challenge FROM "challenges" WHERE "id" = v_match."challenge_id" FOR UPDATE;
  IF v_challenge."payment_status" NOT IN ('locked', 'review_hold') THEN
    RAISE EXCEPTION 'contest % is not in escrow (%)', v_challenge."id", v_challenge."payment_status";
  END IF;

  SELECT count(*) INTO v_participants FROM "match_participants" WHERE "match_id" = p_match_id;
  IF v_participants <> 2 THEN
    RAISE EXCEPTION 'settle_contest expects exactly 2 participants, found % on match %', v_participants, p_match_id;
  END IF;
  SELECT count(*) INTO v_seats FROM "contest_entries" WHERE "match_id" = p_match_id AND "status" = 'locked';
  IF v_seats <> 2 THEN
    RAISE EXCEPTION 'contest % has % locked entries, expected 2', v_challenge."id", v_seats;
  END IF;

  SELECT count(*) INTO v_submitted
    FROM "match_participants" mp JOIN "verification_sessions" vs ON vs."match_participant_id" = mp."id"
   WHERE mp."match_id" = p_match_id;
  IF v_submitted < 2 THEN
    RETURN 'not_ready';
  END IF;

  SELECT mp."user_id", mp."rep_count", mp."hold_duration_seconds", vs."anomaly_flag", vs."reviewed" INTO v_a
    FROM "match_participants" mp JOIN "verification_sessions" vs ON vs."match_participant_id" = mp."id"
   WHERE mp."match_id" = p_match_id ORDER BY mp."user_id" OFFSET 0 LIMIT 1;
  SELECT mp."user_id", mp."rep_count", mp."hold_duration_seconds", vs."anomaly_flag", vs."reviewed" INTO v_b
    FROM "match_participants" mp JOIN "verification_sessions" vs ON vs."match_participant_id" = mp."id"
   WHERE mp."match_id" = p_match_id ORDER BY mp."user_id" OFFSET 1 LIMIT 1;

  IF v_challenge."type" = 'pushups' THEN
    v_score_a := v_a.rep_count; v_score_b := v_b.rep_count;
  ELSIF v_challenge."type" IN ('plank', 'wallsit') THEN
    v_score_a := v_a.hold_duration_seconds; v_score_b := v_b.hold_duration_seconds;
  ELSE
    RAISE EXCEPTION 'settlement is not implemented for % contests', v_challenge."type";
  END IF;
  IF v_score_a IS NULL OR v_score_b IS NULL THEN
    RAISE EXCEPTION 'match % has a verification session with no % score recorded', p_match_id, v_challenge."type";
  END IF;

  IF v_score_a > v_score_b THEN v_winner := v_a.user_id; v_loser := v_b.user_id;
  ELSIF v_score_b > v_score_a THEN v_winner := v_b.user_id; v_loser := v_a.user_id;
  ELSE v_winner := NULL;
  END IF;

  IF v_winner IS NULL THEN
    v_blocked := (v_a.anomaly_flag AND NOT v_a.reviewed) OR (v_b.anomaly_flag AND NOT v_b.reviewed);
  ELSIF v_winner = v_a.user_id THEN
    v_blocked := v_a.anomaly_flag AND NOT v_a.reviewed;
  ELSE
    v_blocked := v_b.anomaly_flag AND NOT v_b.reviewed;
  END IF;

  IF v_blocked THEN
    UPDATE "challenges" SET "status" = 'needs_review', "payment_status" = 'review_hold' WHERE "id" = v_challenge."id";
    PERFORM public._audit('contest.review_hold', 'match', p_match_id::text, v_challenge."entry_fee_cents" * 2);
    RETURN 'needs_review';
  END IF;

  IF v_winner IS NULL THEN
    FOR e IN SELECT * FROM "contest_entries" WHERE "match_id" = p_match_id LOOP
      PERFORM public._refund_contest_entry(e."id", 'contest_refund', 'settled_tie', 'Contest tied, entry fee returned', p_match_id);
    END LOOP;
    INSERT INTO "contest_settlements" ("match_id", "challenge_id", "outcome", "gross_pool_cents", "platform_fee_cents", "winner_payout_cents")
    VALUES (p_match_id, v_challenge."id", 'tie', v_challenge."entry_fee_cents" * 2, 0, 0);
    UPDATE "matches" SET "winner_id" = NULL, "settled_at" = now() WHERE "id" = p_match_id;
    UPDATE "challenges" SET "status" = 'completed', "payment_status" = 'settled' WHERE "id" = v_challenge."id";
    PERFORM public._audit('contest.settled_tie', 'match', p_match_id::text, v_challenge."entry_fee_cents" * 2);
    RETURN 'tie_refunded';
  END IF;

  SELECT * INTO v_calc FROM public._calculate_settlement(v_challenge."entry_fee_cents", 2);

  -- One transaction: both escrows out, winner paid, fee booked. A zero fee
  -- (a 0 bps schedule) simply has no revenue leg.
  v_entries := jsonb_build_array(
    jsonb_build_object('account_id', public._user_account(v_winner, 'user_locked'), 'amount_cents', -v_challenge."entry_fee_cents"),
    jsonb_build_object('account_id', public._user_account(v_loser, 'user_locked'), 'amount_cents', -v_challenge."entry_fee_cents"),
    jsonb_build_object('account_id', public._user_account(v_winner, 'user_available'), 'amount_cents', v_calc.winner_payout_cents)
  );
  IF v_calc.platform_fee_cents > 0 THEN
    v_entries := v_entries || jsonb_build_object('account_id', public._platform_account('platform_revenue'), 'amount_cents', v_calc.platform_fee_cents);
  END IF;

  v_tx := public._post_ledger_transaction(
    'contest_win', 'settlement:' || p_match_id::text, v_entries,
    'Contest winnings', v_challenge."id", p_match_id, NULL, NULL, NULL, NULL, NULL, false);

  UPDATE "contest_entries" SET "status" = CASE WHEN "user_id" = v_winner THEN 'settled_won' ELSE 'settled_lost' END::"ContestEntryStatus",
         "settlement_transaction_id" = v_tx, "settled_at" = now()
   WHERE "match_id" = p_match_id;
  INSERT INTO "contest_settlements"
    ("match_id", "challenge_id", "outcome", "winner_id", "gross_pool_cents", "platform_fee_cents", "winner_payout_cents", "fee_schedule_id", "transaction_id")
  VALUES
    (p_match_id, v_challenge."id", 'won', v_winner, v_calc.gross_pool_cents, v_calc.platform_fee_cents, v_calc.winner_payout_cents, v_calc.fee_schedule_id, v_tx);
  UPDATE "matches" SET "winner_id" = v_winner, "settled_at" = now() WHERE "id" = p_match_id;
  UPDATE "challenges" SET "status" = 'completed', "payment_status" = 'settled' WHERE "id" = v_challenge."id";
  PERFORM public._audit('contest.settled', 'match', p_match_id::text, v_calc.winner_payout_cents,
                        jsonb_build_object('winner_id', v_winner, 'platform_fee_cents', v_calc.platform_fee_cents, 'rake_bps', v_calc.rake_bps));
  RETURN 'settled';
END;
$$;

-- Admin / system void of a matched contest that cannot be settled fairly
-- (dispute, verification failure, server error). Both fees go back.
CREATE OR REPLACE FUNCTION public.void_contest(p_match_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_match "matches"%ROWTYPE;
  v_challenge "challenges"%ROWTYPE;
  e "contest_entries"%ROWTYPE;
BEGIN
  PERFORM public._require_admin();
  SELECT * INTO v_match FROM "matches" WHERE "id" = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'match % not found', p_match_id;
  END IF;
  IF v_match."settled_at" IS NOT NULL OR EXISTS (SELECT 1 FROM "contest_settlements" WHERE "match_id" = p_match_id) THEN
    RAISE EXCEPTION 'match % is already settled', p_match_id;
  END IF;
  SELECT * INTO v_challenge FROM "challenges" WHERE "id" = v_match."challenge_id" FOR UPDATE;
  FOR e IN SELECT * FROM "contest_entries" WHERE "match_id" = p_match_id LOOP
    PERFORM public._refund_contest_entry(e."id", 'contest_refund', 'voided', 'Contest voided: ' || COALESCE(p_reason, 'unspecified'), p_match_id);
  END LOOP;
  INSERT INTO "contest_settlements" ("match_id", "challenge_id", "outcome", "gross_pool_cents", "platform_fee_cents", "winner_payout_cents", "reason", "settled_by")
  VALUES (p_match_id, v_challenge."id", 'voided', v_challenge."entry_fee_cents" * 2, 0, 0, p_reason, auth.uid());
  UPDATE "matches" SET "winner_id" = NULL, "settled_at" = now() WHERE "id" = p_match_id;
  UPDATE "challenges" SET "status" = 'voided', "payment_status" = 'voided' WHERE "id" = v_challenge."id";
  PERFORM public._audit('contest.voided', 'match', p_match_id::text, v_challenge."entry_fee_cents" * 2, jsonb_build_object('reason', p_reason));
END;
$$;

-- Reviewer clears a flagged session, then settlement runs normally.
CREATE OR REPLACE FUNCTION public.clear_verification_review(p_match_id uuid, p_notes text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._require_admin();
  UPDATE "verification_sessions" vs SET "reviewed" = true
    FROM "match_participants" mp WHERE mp."id" = vs."match_participant_id" AND mp."match_id" = p_match_id;
  UPDATE "challenges" c SET "payment_status" = 'locked', "status" = 'matched'
    FROM "matches" m WHERE m."id" = p_match_id AND c."id" = m."challenge_id" AND c."payment_status" = 'review_hold';
  PERFORM public._audit('contest.review_cleared', 'match', p_match_id::text, NULL, jsonb_build_object('notes', p_notes));
  RETURN public.settle_contest(p_match_id);
END;
$$;

-- ----------------------------------------------------------------------------
-- Verification results now settle real money.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_verification_session(
  p_match_participant_id uuid,
  p_rep_count integer,
  p_raw_metrics jsonb,
  p_anomaly_flag boolean,
  p_hold_duration_seconds integer DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_participant "match_participants"%ROWTYPE;
  v_challenge "challenges"%ROWTYPE;
  v_session_id UUID;
BEGIN
  SELECT * INTO v_participant FROM "match_participants" WHERE "id" = p_match_participant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'match participant % not found', p_match_participant_id;
  END IF;
  IF v_participant."user_id" IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'you can only submit a verification session for yourself';
  END IF;
  IF EXISTS (SELECT 1 FROM "verification_sessions" WHERE "match_participant_id" = p_match_participant_id) THEN
    RAISE EXCEPTION 'a verification session has already been submitted for this participant';
  END IF;

  SELECT c.* INTO v_challenge FROM "matches" m JOIN "challenges" c ON c."id" = m."challenge_id" WHERE m."id" = v_participant."match_id";
  IF v_challenge."payment_status" NOT IN ('locked', 'review_hold') THEN
    RAISE EXCEPTION 'contest % is not in play (%)', v_challenge."id", v_challenge."payment_status";
  END IF;

  IF v_challenge."type" = 'pushups' THEN
    IF p_rep_count IS NULL OR p_rep_count < 0 THEN
      RAISE EXCEPTION 'rep count must be zero or greater for a pushups challenge';
    END IF;
    IF p_hold_duration_seconds IS NOT NULL THEN
      RAISE EXCEPTION 'hold duration is not a valid result for a pushups challenge';
    END IF;
  ELSIF v_challenge."type" IN ('plank', 'wallsit') THEN
    IF p_hold_duration_seconds IS NULL OR p_hold_duration_seconds < 0 THEN
      RAISE EXCEPTION 'hold duration must be zero or greater for a % challenge', v_challenge."type";
    END IF;
    IF p_rep_count IS NOT NULL THEN
      RAISE EXCEPTION 'rep count is not a valid result for a % challenge', v_challenge."type";
    END IF;
  ELSE
    RAISE EXCEPTION 'camera verification is not implemented for % yet', v_challenge."type";
  END IF;

  INSERT INTO "verification_sessions" ("match_participant_id", "raw_metrics", "anomaly_flag", "reviewed")
  VALUES (p_match_participant_id, p_raw_metrics, COALESCE(p_anomaly_flag, false), false)
  RETURNING "id" INTO v_session_id;

  UPDATE "match_participants" SET "rep_count" = p_rep_count, "hold_duration_seconds" = p_hold_duration_seconds
   WHERE "id" = p_match_participant_id;

  -- Settle inline the moment the second result lands (returns 'not_ready'
  -- harmlessly for the first submitter). A settlement failure rolls the
  -- result back on purpose: recording a result that provably cannot settle
  -- is worse than rejecting the submission.
  PERFORM public.settle_contest(v_participant."match_id");
  RETURN v_session_id;
END;
$$;

DROP FUNCTION IF EXISTS public.settle_match(uuid);

-- ----------------------------------------------------------------------------
-- Compliance hooks (providers write through these; nothing else may)
-- ----------------------------------------------------------------------------

-- KYC provider webhook result, applied by an edge function (service role).
CREATE OR REPLACE FUNCTION public.record_identity_verification(
  p_user_id uuid, p_provider text, p_reference text, p_status "ComplianceStatus", p_date_of_birth date DEFAULT NULL,
  p_sanctions_status text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._require_service();
  PERFORM public._ensure_wallet(p_user_id);
  UPDATE "compliance_profiles" SET
    "status" = p_status,
    "kyc_provider" = p_provider,
    "kyc_reference" = p_reference,
    "kyc_verified_at" = CASE WHEN p_status = 'verified' THEN now() ELSE "kyc_verified_at" END,
    "date_of_birth" = COALESCE(p_date_of_birth, "date_of_birth"),
    "age_verified_at" = CASE WHEN p_status = 'verified' AND COALESCE(p_date_of_birth, "date_of_birth") IS NOT NULL THEN now() ELSE "age_verified_at" END,
    "sanctions_status" = COALESCE(p_sanctions_status, "sanctions_status"),
    "sanctions_checked_at" = CASE WHEN p_sanctions_status IS NOT NULL THEN now() ELSE "sanctions_checked_at" END,
    "updated_at" = now()
  WHERE "user_id" = p_user_id;
  PERFORM public._audit('compliance.identity', 'user', p_user_id::text, NULL,
                        jsonb_build_object('provider', p_provider, 'status', p_status, 'reference', p_reference));
END;
$$;

-- Geolocation provider result, applied by an edge function (service role).
CREATE OR REPLACE FUNCTION public.record_location_check(p_user_id uuid, p_provider text, p_jurisdiction_code text, p_reference text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._require_service();
  PERFORM public._ensure_wallet(p_user_id);
  UPDATE "compliance_profiles" SET
    "jurisdiction_code" = p_jurisdiction_code, "location_provider" = p_provider,
    "location_reference" = p_reference, "location_verified_at" = now(), "updated_at" = now()
  WHERE "user_id" = p_user_id;
  PERFORM public._audit('compliance.location', 'user', p_user_id::text, NULL,
                        jsonb_build_object('provider', p_provider, 'jurisdiction', p_jurisdiction_code));
END;
$$;

-- The user's own responsible-play controls. Limits can only be lowered by
-- the user; raising them and lifting self-exclusion is an admin decision.
CREATE OR REPLACE FUNCTION public.set_my_play_limits(p_daily_deposit_limit_cents bigint DEFAULT NULL, p_monthly_deposit_limit_cents bigint DEFAULT NULL, p_self_exclude_days integer DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c "compliance_profiles"%ROWTYPE;
  s "platform_settings"%ROWTYPE := public._settings();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  PERFORM public._ensure_wallet(auth.uid());
  SELECT * INTO c FROM "compliance_profiles" WHERE "user_id" = auth.uid() FOR UPDATE;
  IF p_daily_deposit_limit_cents IS NOT NULL THEN
    IF p_daily_deposit_limit_cents < 0 OR p_daily_deposit_limit_cents > COALESCE(c."deposit_limit_daily_cents", s."default_daily_deposit_limit_cents") THEN
      RAISE EXCEPTION 'deposit limits can only be lowered here';
    END IF;
    UPDATE "compliance_profiles" SET "deposit_limit_daily_cents" = p_daily_deposit_limit_cents, "updated_at" = now() WHERE "user_id" = auth.uid();
  END IF;
  IF p_monthly_deposit_limit_cents IS NOT NULL THEN
    IF p_monthly_deposit_limit_cents < 0 OR p_monthly_deposit_limit_cents > COALESCE(c."deposit_limit_monthly_cents", s."default_monthly_deposit_limit_cents") THEN
      RAISE EXCEPTION 'deposit limits can only be lowered here';
    END IF;
    UPDATE "compliance_profiles" SET "deposit_limit_monthly_cents" = p_monthly_deposit_limit_cents, "updated_at" = now() WHERE "user_id" = auth.uid();
  END IF;
  IF p_self_exclude_days IS NOT NULL THEN
    IF p_self_exclude_days < 1 THEN
      RAISE EXCEPTION 'self-exclusion must be at least one day';
    END IF;
    UPDATE "compliance_profiles" SET "self_excluded_until" = GREATEST(COALESCE("self_excluded_until", now()), now() + make_interval(days => p_self_exclude_days)), "updated_at" = now()
     WHERE "user_id" = auth.uid();
  END IF;
  PERFORM public._audit('compliance.self_limits', 'user', auth.uid()::text, NULL,
                        jsonb_build_object('daily', p_daily_deposit_limit_cents, 'monthly', p_monthly_deposit_limit_cents, 'self_exclude_days', p_self_exclude_days));
END;
$$;

-- ----------------------------------------------------------------------------
-- Admin operations (every one audited)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_adjust_wallet(
  p_user_id uuid, p_amount_cents bigint, p_reason text, p_idempotency_key text, p_allow_negative boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx UUID;
BEGIN
  PERFORM public._require_admin();
  IF p_amount_cents IS NULL OR p_amount_cents = 0 THEN
    RAISE EXCEPTION 'adjustment amount must be non-zero';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a reason is required for a wallet adjustment';
  END IF;
  PERFORM public._ensure_wallet(p_user_id);
  v_tx := public._post_ledger_transaction(
    'admin_adjustment', 'admin_adjustment:' || p_idempotency_key,
    jsonb_build_array(
      jsonb_build_object('account_id', public._platform_account('platform_adjustments'), 'amount_cents', -p_amount_cents),
      jsonb_build_object('account_id', public._user_account(p_user_id, 'user_available'), 'amount_cents', p_amount_cents)
    ),
    p_reason, NULL, NULL, NULL, NULL, NULL, NULL, auth.uid(), p_allow_negative);
  PERFORM public._audit('wallet.admin_adjustment', 'user', p_user_id::text, p_amount_cents,
                        jsonb_build_object('reason', p_reason, 'transaction_id', v_tx));
  RETURN v_tx;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_grant_promo(p_user_id uuid, p_amount_cents bigint, p_reason text, p_idempotency_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx UUID;
BEGIN
  PERFORM public._require_admin();
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'promo amount must be positive';
  END IF;
  PERFORM public._ensure_wallet(p_user_id);
  v_tx := public._post_ledger_transaction(
    'promo_credit', 'promo:' || p_idempotency_key,
    jsonb_build_array(
      jsonb_build_object('account_id', public._platform_account('platform_promo_funding'), 'amount_cents', -p_amount_cents),
      jsonb_build_object('account_id', public._user_account(p_user_id, 'user_promo'), 'amount_cents', p_amount_cents)
    ),
    p_reason, NULL, NULL, NULL, NULL, NULL, NULL, auth.uid(), true);
  PERFORM public._audit('wallet.promo_credit', 'user', p_user_id::text, p_amount_cents, jsonb_build_object('reason', p_reason));
  RETURN v_tx;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_compliance(
  p_user_id uuid, p_status "ComplianceStatus" DEFAULT NULL, p_risk_status "RiskStatus" DEFAULT NULL,
  p_jurisdiction_code text DEFAULT NULL, p_date_of_birth date DEFAULT NULL, p_self_excluded_until timestamptz DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._require_admin();
  PERFORM public._ensure_wallet(p_user_id);
  UPDATE "compliance_profiles" SET
    "status" = COALESCE(p_status, "status"),
    "risk_status" = COALESCE(p_risk_status, "risk_status"),
    "jurisdiction_code" = COALESCE(p_jurisdiction_code, "jurisdiction_code"),
    "location_verified_at" = CASE WHEN p_jurisdiction_code IS NOT NULL THEN now() ELSE "location_verified_at" END,
    "location_provider" = CASE WHEN p_jurisdiction_code IS NOT NULL THEN 'admin' ELSE "location_provider" END,
    "date_of_birth" = COALESCE(p_date_of_birth, "date_of_birth"),
    "age_verified_at" = CASE WHEN p_date_of_birth IS NOT NULL THEN now() ELSE "age_verified_at" END,
    "self_excluded_until" = COALESCE(p_self_excluded_until, "self_excluded_until"),
    "risk_notes" = CASE WHEN p_notes IS NOT NULL THEN concat_ws(E'\n', "risk_notes", p_notes) ELSE "risk_notes" END,
    "updated_at" = now()
  WHERE "user_id" = p_user_id;
  PERFORM public._audit('compliance.admin_set', 'user', p_user_id::text, NULL,
                        jsonb_build_object('status', p_status, 'risk_status', p_risk_status, 'jurisdiction', p_jurisdiction_code, 'notes', p_notes));
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_wallet_status(p_user_id uuid, p_status "WalletStatus", p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._require_admin();
  PERFORM public._ensure_wallet(p_user_id);
  UPDATE "wallets" SET "status" = p_status, "updated_at" = now() WHERE "user_id" = p_user_id;
  PERFORM public._audit('wallet.status', 'user', p_user_id::text, NULL, jsonb_build_object('status', p_status, 'reason', p_reason));
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_jurisdiction(p_code text, p_allowed boolean, p_min_age integer DEFAULT 18, p_notes text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._require_admin();
  INSERT INTO "jurisdiction_rules" ("code", "paid_contests_allowed", "min_age", "notes", "updated_by")
  VALUES (p_code, p_allowed, p_min_age, p_notes, auth.uid())
  ON CONFLICT ("code") DO UPDATE SET "paid_contests_allowed" = EXCLUDED."paid_contests_allowed", "min_age" = EXCLUDED."min_age",
    "notes" = EXCLUDED."notes", "updated_at" = now(), "updated_by" = auth.uid();
  PERFORM public._audit('jurisdiction.set', 'jurisdiction', p_code, NULL, jsonb_build_object('allowed', p_allowed, 'min_age', p_min_age));
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_fee_schedule(p_name text, p_rake_bps integer, p_min_fee_cents bigint DEFAULT 0, p_max_fee_cents bigint DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id UUID;
BEGIN
  PERFORM public._require_admin();
  UPDATE "fee_schedules" SET "active" = false WHERE "active";
  INSERT INTO "fee_schedules" ("name", "rake_bps", "min_fee_cents", "max_fee_cents", "active", "created_by")
  VALUES (p_name, p_rake_bps, p_min_fee_cents, p_max_fee_cents, true, auth.uid()) RETURNING "id" INTO v_id;
  PERFORM public._audit('fee_schedule.set', 'fee_schedule', v_id::text, NULL, jsonb_build_object('rake_bps', p_rake_bps, 'min', p_min_fee_cents, 'max', p_max_fee_cents));
  RETURN v_id;
END;
$$;

-- Guarded: real money cannot be switched on in production without a
-- non-sandbox payment provider, a KYC provider and a location provider.
CREATE OR REPLACE FUNCTION public.admin_set_platform_settings(p_patch jsonb)
RETURNS "platform_settings" LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s "platform_settings"%ROWTYPE;
BEGIN
  PERFORM public._require_admin();
  SELECT * INTO s FROM "platform_settings" WHERE "id" = 1 FOR UPDATE;
  s."environment" := COALESCE(p_patch->>'environment', s."environment");
  s."real_money_enabled" := COALESCE((p_patch->>'real_money_enabled')::boolean, s."real_money_enabled");
  s."payment_provider" := COALESCE(p_patch->>'payment_provider', s."payment_provider");
  s."kyc_provider" := CASE WHEN p_patch ? 'kyc_provider' THEN p_patch->>'kyc_provider' ELSE s."kyc_provider" END;
  s."location_provider" := CASE WHEN p_patch ? 'location_provider' THEN p_patch->>'location_provider' ELSE s."location_provider" END;
  s."min_age" := COALESCE((p_patch->>'min_age')::integer, s."min_age");
  s."min_deposit_cents" := COALESCE((p_patch->>'min_deposit_cents')::bigint, s."min_deposit_cents");
  s."max_deposit_cents" := COALESCE((p_patch->>'max_deposit_cents')::bigint, s."max_deposit_cents");
  s."default_daily_deposit_limit_cents" := COALESCE((p_patch->>'default_daily_deposit_limit_cents')::bigint, s."default_daily_deposit_limit_cents");
  s."default_monthly_deposit_limit_cents" := COALESCE((p_patch->>'default_monthly_deposit_limit_cents')::bigint, s."default_monthly_deposit_limit_cents");
  s."min_withdrawal_cents" := COALESCE((p_patch->>'min_withdrawal_cents')::bigint, s."min_withdrawal_cents");
  s."max_withdrawal_cents" := COALESCE((p_patch->>'max_withdrawal_cents')::bigint, s."max_withdrawal_cents");
  s."withdrawal_review_threshold_cents" := COALESCE((p_patch->>'withdrawal_review_threshold_cents')::bigint, s."withdrawal_review_threshold_cents");
  s."open_contest_ttl_minutes" := COALESCE((p_patch->>'open_contest_ttl_minutes')::integer, s."open_contest_ttl_minutes");
  s."location_check_ttl_minutes" := COALESCE((p_patch->>'location_check_ttl_minutes')::integer, s."location_check_ttl_minutes");

  IF s."real_money_enabled" AND s."environment" = 'production' THEN
    IF s."payment_provider" = 'sandbox' THEN
      RAISE EXCEPTION 'real money cannot be enabled in production with the sandbox payment provider';
    END IF;
    IF s."kyc_provider" IS NULL THEN
      RAISE EXCEPTION 'real money cannot be enabled in production without a KYC provider';
    END IF;
    IF s."location_provider" IS NULL THEN
      RAISE EXCEPTION 'real money cannot be enabled in production without a location provider';
    END IF;
  END IF;

  UPDATE "platform_settings" SET
    "environment" = s."environment", "real_money_enabled" = s."real_money_enabled", "payment_provider" = s."payment_provider",
    "kyc_provider" = s."kyc_provider", "location_provider" = s."location_provider", "min_age" = s."min_age",
    "min_deposit_cents" = s."min_deposit_cents", "max_deposit_cents" = s."max_deposit_cents",
    "default_daily_deposit_limit_cents" = s."default_daily_deposit_limit_cents",
    "default_monthly_deposit_limit_cents" = s."default_monthly_deposit_limit_cents",
    "min_withdrawal_cents" = s."min_withdrawal_cents", "max_withdrawal_cents" = s."max_withdrawal_cents",
    "withdrawal_review_threshold_cents" = s."withdrawal_review_threshold_cents",
    "open_contest_ttl_minutes" = s."open_contest_ttl_minutes", "location_check_ttl_minutes" = s."location_check_ttl_minutes",
    "updated_at" = now(), "updated_by" = auth.uid()
  WHERE "id" = 1 RETURNING * INTO s;
  PERFORM public._audit('platform_settings.set', 'platform_settings', '1', NULL, p_patch);
  RETURN s;
END;
$$;

-- Ledger health: every account's cached balance against the sum of its
-- entries, plus the global invariant that all balances sum to zero.
CREATE OR REPLACE FUNCTION public.reconcile_ledger()
RETURNS TABLE (account_id uuid, kind "LedgerAccountKind", user_id uuid, cached_cents bigint, computed_cents bigint, drift_cents bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._require_admin();
  RETURN QUERY
    SELECT a."id", a."kind", a."user_id", a."balance_cents", COALESCE(SUM(e."amount_cents"), 0)::bigint,
           (a."balance_cents" - COALESCE(SUM(e."amount_cents"), 0))::bigint
      FROM "ledger_accounts" a LEFT JOIN "ledger_entries" e ON e."account_id" = a."id"
     GROUP BY a."id"
    HAVING a."balance_cents" <> COALESCE(SUM(e."amount_cents"), 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.ledger_totals()
RETURNS TABLE (kind "LedgerAccountKind", total_cents bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._require_admin();
  RETURN QUERY SELECT a."kind", SUM(a."balance_cents")::bigint FROM "ledger_accounts" a GROUP BY a."kind" ORDER BY a."kind";
END;
$$;

-- ----------------------------------------------------------------------------
-- Row Level Security: owners read their own rows; nothing is writable.
-- ----------------------------------------------------------------------------
ALTER TABLE "wallets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deposits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "withdrawals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_provider_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contest_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contest_settlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fee_schedules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contest_stake_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "compliance_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "jurisdiction_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "financial_audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_limit_buckets" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wallets_select_own" ON "wallets" FOR SELECT USING ("user_id" = auth.uid());
CREATE POLICY "ledger_accounts_select_own" ON "ledger_accounts" FOR SELECT USING ("user_id" = auth.uid());
CREATE POLICY "ledger_entries_select_own" ON "ledger_entries" FOR SELECT USING (
  EXISTS (SELECT 1 FROM "ledger_accounts" a WHERE a."id" = "ledger_entries"."account_id" AND a."user_id" = auth.uid())
);
CREATE POLICY "ledger_transactions_select_own" ON "ledger_transactions" FOR SELECT USING (
  EXISTS (SELECT 1 FROM "ledger_entries" e JOIN "ledger_accounts" a ON a."id" = e."account_id"
           WHERE e."transaction_id" = "ledger_transactions"."id" AND a."user_id" = auth.uid())
);
CREATE POLICY "deposits_select_own" ON "deposits" FOR SELECT USING ("user_id" = auth.uid());
CREATE POLICY "withdrawals_select_own" ON "withdrawals" FOR SELECT USING ("user_id" = auth.uid());
CREATE POLICY "contest_entries_select_own" ON "contest_entries" FOR SELECT USING ("user_id" = auth.uid());
CREATE POLICY "contest_settlements_select_participant" ON "contest_settlements" FOR SELECT USING (public.is_match_participant("match_id"));
CREATE POLICY "fee_schedules_select_all" ON "fee_schedules" FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "contest_stake_options_select_all" ON "contest_stake_options" FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "platform_settings_select_all" ON "platform_settings" FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "compliance_profiles_select_own" ON "compliance_profiles" FOR SELECT USING ("user_id" = auth.uid());
CREATE POLICY "jurisdiction_rules_select_all" ON "jurisdiction_rules" FOR SELECT USING (auth.role() = 'authenticated');
-- payment_provider_events, admin_users, financial_audit_log, rate_limit_buckets:
-- no policies at all, so only the service role and SECURITY DEFINER functions can touch them.

-- Belt and braces on top of RLS: no client role gets a write privilege on
-- any money table, and the internal/service functions are not executable
-- by clients. (Supabase grants broad table/function access to
-- authenticated/anon by default; revoke it here.)
REVOKE ALL ON
  "wallets", "ledger_accounts", "ledger_transactions", "ledger_entries", "deposits", "withdrawals",
  "payment_provider_events", "contest_entries", "contest_settlements", "fee_schedules", "contest_stake_options",
  "platform_settings", "compliance_profiles", "jurisdiction_rules", "admin_users", "financial_audit_log", "rate_limit_buckets"
  FROM authenticated, anon;
GRANT SELECT ON
  "wallets", "ledger_accounts", "ledger_transactions", "ledger_entries", "deposits", "withdrawals",
  "contest_entries", "contest_settlements", "fee_schedules", "contest_stake_options", "platform_settings",
  "compliance_profiles", "jurisdiction_rules"
  TO authenticated;
GRANT SELECT ON "wallet_balances", "wallet_transactions" TO authenticated;
REVOKE ALL ON "wallet_balances", "wallet_transactions" FROM anon;

REVOKE EXECUTE ON FUNCTION
  public._ledger_apply_entry(), public._ledger_accounts_guard(), public._ledger_immutable(), public._ledger_check_balanced(),
  public._settings(), public._caller_is_service(), public._require_admin(), public._require_service(), public._actor_role(),
  public._audit(text, text, text, bigint, jsonb), public._consume_rate_limit(text, integer, integer),
  public._platform_account("LedgerAccountKind", char), public._ensure_wallet(uuid), public._user_account(uuid, "LedgerAccountKind"),
  public._account_balance(uuid),
  public._post_ledger_transaction("LedgerTransactionType", text, jsonb, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, boolean),
  public._calculate_settlement(bigint, integer), public._eligibility(uuid, text, bigint),
  public._lock_contest_entry(uuid, uuid, bigint, text),
  public._refund_contest_entry(uuid, "LedgerTransactionType", "ContestEntryStatus", text, uuid),
  public.initiate_deposit(uuid, bigint, text, text), public.attach_deposit_provider_ref(uuid, text),
  public.apply_payment_event(text, text, text, jsonb, boolean),
  public.mark_withdrawal_processing(uuid, text, text),
  public.record_identity_verification(uuid, text, text, "ComplianceStatus", date, text),
  public.record_location_check(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.initiate_deposit(uuid, bigint, text, text), public.attach_deposit_provider_ref(uuid, text),
  public.apply_payment_event(text, text, text, jsonb, boolean), public.mark_withdrawal_processing(uuid, text, text),
  public.record_identity_verification(uuid, text, text, "ComplianceStatus", date, text),
  public.record_location_check(uuid, text, text, text)
  TO service_role;

GRANT EXECUTE ON FUNCTION
  public.is_admin(), public.get_my_wallet(), public.get_my_eligibility(), public.can_user_enter_paid_contest(uuid, bigint),
  public.settlement_preview(bigint), public.cancel_deposit(uuid),
  public.request_withdrawal(bigint, text, text, text), public.cancel_withdrawal(uuid), public.review_withdrawal(uuid, boolean, text),
  public.create_contest("ChallengeType", "ChallengeFormat", bigint, text), public.enter_contest(uuid, text),
  public.cancel_contest(uuid), public.expire_open_contests(integer), public.settle_contest(uuid), public.void_contest(uuid, text),
  public.clear_verification_review(uuid, text),
  public.submit_verification_session(uuid, integer, jsonb, boolean, integer),
  public.set_my_play_limits(bigint, bigint, integer),
  public.admin_adjust_wallet(uuid, bigint, text, text, boolean), public.admin_grant_promo(uuid, bigint, text, text),
  public.admin_set_compliance(uuid, "ComplianceStatus", "RiskStatus", text, date, timestamptz, text),
  public.admin_set_wallet_status(uuid, "WalletStatus", text), public.admin_set_jurisdiction(text, boolean, integer, text),
  public.admin_set_fee_schedule(text, integer, bigint, bigint), public.admin_set_platform_settings(jsonb),
  public.reconcile_ledger(), public.ledger_totals()
  TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Realtime: live balances and deposit/withdrawal status for the owner.
-- Same guarded pattern as 20260903100000_enable_realtime.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_table TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'publication supabase_realtime not found - skipping (not a Supabase database?)';
    RETURN;
  END IF;
  FOREACH v_table IN ARRAY ARRAY['ledger_accounts', 'deposits', 'withdrawals'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = v_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
    END IF;
  END LOOP;
END
$$;
