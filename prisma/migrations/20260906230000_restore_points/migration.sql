-- ============================================================================
-- Restore the points economy.
--
-- Undoes 20260906000000_add_contest_lifecycle_statuses,
-- 20260906000100_retire_points and 20260906000200_real_money_wallet, which
-- were applied to the shared Supabase project on 2026-09-06 and then reverted
-- in the app. Those three files stay in this directory because they ARE in
-- the database's migration history; this one is the forward-only reversal.
--
-- Verified on the live data before writing: every money table was empty
-- except the four seeded platform ledger accounts and the settings/fee/stake
-- seed rows, so dropping them loses nothing. The retire_points migration had
-- also flipped every unresolved contest to 'cancelled'; those go back to
-- 'matched' (a match row exists) or 'open' (no match). The app never wrote
-- 'in_progress', so 'matched' is the exact prior state. Points balances and
-- the points ledger were only renamed, never modified, so no points move.
--
-- What is NOT reverted: the enum values 'cancelled', 'expired' and 'voided'
-- on "ChallengeStatus". Postgres cannot drop enum values without rebuilding
-- the type; they are unused and harmless. The write privileges retire_points
-- revoked from authenticated on the points ledger also stay revoked: no
-- client ever wrote that table directly (every row comes from the SECURITY
-- DEFINER functions below), so the app is unaffected and the tighter grant
-- is kept.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Contest statuses back to what they were, while payment_status still exists
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_money_contests integer;
BEGIN
  SELECT count(*) INTO v_money_contests FROM "challenges" WHERE "payment_status" <> 'legacy';
  IF v_money_contests > 0 THEN
    RAISE EXCEPTION 'restore_points: % contest(s) were created with real money; resolve them before reverting', v_money_contests;
  END IF;
END $$;

UPDATE "challenges" c
   SET "status" = CASE
                    WHEN EXISTS (SELECT 1 FROM "matches" m WHERE m."challenge_id" = c."id") THEN 'matched'::"ChallengeStatus"
                    ELSE 'open'::"ChallengeStatus"
                  END
 WHERE c."status" = 'cancelled'
   AND c."payment_status" = 'legacy';

-- ----------------------------------------------------------------------------
-- 2. Drop the money schema: views, then tables (with their triggers and
--    policies), then functions, then types
-- ----------------------------------------------------------------------------

-- CASCADE: get_my_wallet() returns SETOF wallet_balances, so it goes with the view.
DROP VIEW IF EXISTS "wallet_transactions" CASCADE;
DROP VIEW IF EXISTS "wallet_balances" CASCADE;

DROP TABLE IF EXISTS
  "ledger_entries", "ledger_transactions", "contest_settlements", "contest_entries",
  "payment_provider_events", "deposits", "withdrawals", "ledger_accounts", "wallets",
  "compliance_profiles", "fee_schedules", "contest_stake_options", "jurisdiction_rules",
  "platform_settings", "financial_audit_log", "rate_limit_buckets", "admin_users"
CASCADE;

DROP FUNCTION IF EXISTS public._account_balance CASCADE;
DROP FUNCTION IF EXISTS public._actor_role CASCADE;
DROP FUNCTION IF EXISTS public._audit CASCADE;
DROP FUNCTION IF EXISTS public._calculate_settlement CASCADE;
DROP FUNCTION IF EXISTS public._caller_is_service CASCADE;
DROP FUNCTION IF EXISTS public._consume_rate_limit CASCADE;
DROP FUNCTION IF EXISTS public._eligibility CASCADE;
DROP FUNCTION IF EXISTS public._ensure_wallet CASCADE;
DROP FUNCTION IF EXISTS public._ledger_accounts_guard CASCADE;
DROP FUNCTION IF EXISTS public._ledger_apply_entry CASCADE;
DROP FUNCTION IF EXISTS public._ledger_check_balanced CASCADE;
DROP FUNCTION IF EXISTS public._ledger_immutable CASCADE;
DROP FUNCTION IF EXISTS public._lock_contest_entry CASCADE;
DROP FUNCTION IF EXISTS public._platform_account CASCADE;
DROP FUNCTION IF EXISTS public._post_ledger_transaction CASCADE;
DROP FUNCTION IF EXISTS public._refund_contest_entry CASCADE;
DROP FUNCTION IF EXISTS public._require_admin CASCADE;
DROP FUNCTION IF EXISTS public._require_service CASCADE;
DROP FUNCTION IF EXISTS public._settings CASCADE;
DROP FUNCTION IF EXISTS public._user_account CASCADE;
DROP FUNCTION IF EXISTS public.admin_adjust_wallet CASCADE;
DROP FUNCTION IF EXISTS public.admin_grant_promo CASCADE;
DROP FUNCTION IF EXISTS public.admin_set_compliance CASCADE;
DROP FUNCTION IF EXISTS public.admin_set_fee_schedule CASCADE;
DROP FUNCTION IF EXISTS public.admin_set_jurisdiction CASCADE;
DROP FUNCTION IF EXISTS public.admin_set_platform_settings CASCADE;
DROP FUNCTION IF EXISTS public.admin_set_wallet_status CASCADE;
DROP FUNCTION IF EXISTS public.apply_payment_event CASCADE;
DROP FUNCTION IF EXISTS public.attach_deposit_provider_ref CASCADE;
DROP FUNCTION IF EXISTS public.can_user_enter_paid_contest CASCADE;
DROP FUNCTION IF EXISTS public.cancel_contest CASCADE;
DROP FUNCTION IF EXISTS public.cancel_deposit CASCADE;
DROP FUNCTION IF EXISTS public.cancel_withdrawal CASCADE;
DROP FUNCTION IF EXISTS public.clear_verification_review CASCADE;
DROP FUNCTION IF EXISTS public.create_contest CASCADE;
DROP FUNCTION IF EXISTS public.enter_contest CASCADE;
DROP FUNCTION IF EXISTS public.expire_open_contests CASCADE;
DROP FUNCTION IF EXISTS public.get_my_eligibility CASCADE;
DROP FUNCTION IF EXISTS public.get_my_wallet CASCADE;
DROP FUNCTION IF EXISTS public.initiate_deposit CASCADE;
DROP FUNCTION IF EXISTS public.is_admin CASCADE;
DROP FUNCTION IF EXISTS public.ledger_totals CASCADE;
DROP FUNCTION IF EXISTS public.mark_withdrawal_processing CASCADE;
DROP FUNCTION IF EXISTS public.reconcile_ledger CASCADE;
DROP FUNCTION IF EXISTS public.record_identity_verification CASCADE;
DROP FUNCTION IF EXISTS public.record_location_check CASCADE;
DROP FUNCTION IF EXISTS public.request_withdrawal CASCADE;
DROP FUNCTION IF EXISTS public.review_withdrawal CASCADE;
DROP FUNCTION IF EXISTS public.set_my_play_limits CASCADE;
DROP FUNCTION IF EXISTS public.settle_contest CASCADE;
DROP FUNCTION IF EXISTS public.settlement_preview CASCADE;
DROP FUNCTION IF EXISTS public.void_contest CASCADE;

DROP TYPE IF EXISTS "WalletStatus";
DROP TYPE IF EXISTS "LedgerAccountKind";
DROP TYPE IF EXISTS "LedgerTransactionType";
DROP TYPE IF EXISTS "DepositStatus";
DROP TYPE IF EXISTS "WithdrawalStatus";
DROP TYPE IF EXISTS "ContestEntryStatus";
DROP TYPE IF EXISTS "ContestSettlementOutcome";
DROP TYPE IF EXISTS "ComplianceStatus";
DROP TYPE IF EXISTS "RiskStatus";

-- ----------------------------------------------------------------------------
-- 3. challenges: money columns off, stake_points back, client INSERT back
-- ----------------------------------------------------------------------------

ALTER TABLE "challenges"
  DROP COLUMN "entry_fee_cents",
  DROP COLUMN "currency",
  DROP COLUMN "payment_status",
  DROP COLUMN "expires_at";

DROP TYPE IF EXISTS "ContestPaymentStatus";

-- retire_points made the column nullable. Nothing is NULL on the live data
-- (checked: 0 rows), but SET NOT NULL below must not be able to fail.
UPDATE "challenges" SET "legacy_stake_points" = 0 WHERE "legacy_stake_points" IS NULL;

ALTER TABLE "challenges" RENAME COLUMN "legacy_stake_points" TO "stake_points";
ALTER TABLE "challenges"
  ALTER COLUMN "stake_points" DROP DEFAULT,
  ALTER COLUMN "stake_points" SET NOT NULL;
COMMENT ON COLUMN "challenges"."stake_points" IS NULL;

-- Verbatim from 20260902000000_add_fittr_challenge_models.
CREATE POLICY "challenges_insert_own" ON "challenges"
    FOR INSERT WITH CHECK (auth.uid() = created_by AND status = 'open');

GRANT INSERT ON "challenges" TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. fitness_profiles.points_balance and the points ledger, names restored
-- ----------------------------------------------------------------------------

ALTER TABLE "fitness_profiles" RENAME COLUMN "legacy_points_balance" TO "points_balance";
COMMENT ON COLUMN "fitness_profiles"."points_balance" IS NULL;

ALTER TABLE "legacy_points_ledger_entries" RENAME TO "points_ledger_entries";
ALTER INDEX IF EXISTS "legacy_points_ledger_entries_user_id_idx" RENAME TO "points_ledger_entries_user_id_idx";
ALTER INDEX IF EXISTS "legacy_points_ledger_entries_match_id_idx" RENAME TO "points_ledger_entries_match_id_idx";
COMMENT ON TABLE "points_ledger_entries" IS NULL;

-- ----------------------------------------------------------------------------
-- 5. The points functions, verbatim from the migrations that introduced them
--    (join_challenge / grant_starter_bonus: 20260902000000;
--     settle_match / submit_verification_session: 20260903300000)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.join_challenge(p_challenge_id uuid, p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_challenge "challenges"%ROWTYPE;
  v_creator_tier "StrengthTier";
  v_creator_balance INTEGER;
  v_joiner_tier "StrengthTier";
  v_joiner_balance INTEGER;
  v_match_id UUID;
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'p_user_id must match the calling user';
  END IF;

  SELECT * INTO v_challenge FROM "challenges" WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'challenge % not found', p_challenge_id;
  END IF;

  IF v_challenge.status <> 'open' THEN
    RAISE EXCEPTION 'challenge % is not open', p_challenge_id;
  END IF;

  IF v_challenge.created_by = p_user_id THEN
    RAISE EXCEPTION 'cannot join your own challenge';
  END IF;

  SELECT strength_tier, points_balance INTO v_creator_tier, v_creator_balance
    FROM "fitness_profiles" WHERE user_id = v_challenge.created_by FOR UPDATE;
  SELECT strength_tier, points_balance INTO v_joiner_tier, v_joiner_balance
    FROM "fitness_profiles" WHERE user_id = p_user_id FOR UPDATE;

  IF v_creator_tier IS NULL OR v_joiner_tier IS NULL THEN
    RAISE EXCEPTION 'both users need a fitness profile before joining a challenge';
  END IF;

  IF v_creator_tier <> v_joiner_tier THEN
    RAISE EXCEPTION 'strength tier mismatch: challenge is %, you are %', v_creator_tier, v_joiner_tier;
  END IF;

  IF v_creator_balance < v_challenge.stake_points THEN
    RAISE EXCEPTION 'challenge creator no longer has enough points to stake';
  END IF;

  IF v_joiner_balance < v_challenge.stake_points THEN
    RAISE EXCEPTION 'insufficient points balance to stake this challenge';
  END IF;

  INSERT INTO "matches" ("id", "challenge_id")
    VALUES (gen_random_uuid(), v_challenge.id)
    RETURNING id INTO v_match_id;

  INSERT INTO "match_participants" ("id", "match_id", "user_id") VALUES
    (gen_random_uuid(), v_match_id, v_challenge.created_by),
    (gen_random_uuid(), v_match_id, p_user_id);

  UPDATE "fitness_profiles" SET points_balance = points_balance - v_challenge.stake_points
    WHERE user_id = v_challenge.created_by;
  UPDATE "fitness_profiles" SET points_balance = points_balance - v_challenge.stake_points
    WHERE user_id = p_user_id;

  INSERT INTO "points_ledger_entries" ("id", "user_id", "amount", "reason", "match_id") VALUES
    (gen_random_uuid(), v_challenge.created_by, -v_challenge.stake_points, 'stake', v_match_id),
    (gen_random_uuid(), p_user_id, -v_challenge.stake_points, 'stake', v_match_id);

  UPDATE "challenges" SET status = 'matched' WHERE id = v_challenge.id;

  RETURN v_match_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_challenge(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.grant_starter_bonus(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bonus_amount CONSTANT INTEGER := 500;
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'p_user_id must match the calling user';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "points_ledger_entries"
    WHERE user_id = p_user_id AND reason = 'bonus'
  ) THEN
    RETURN;
  END IF;

  UPDATE "fitness_profiles" SET points_balance = points_balance + v_bonus_amount
    WHERE user_id = p_user_id;

  INSERT INTO "points_ledger_entries" ("id", "user_id", "amount", "reason")
    VALUES (gen_random_uuid(), p_user_id, v_bonus_amount, 'bonus');
END;
$$;

GRANT EXECUTE ON FUNCTION public.grant_starter_bonus(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.settle_match(p_match_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  v_blocked BOOLEAN;
  v_stake INTEGER;
BEGIN
  SELECT * INTO v_match FROM "matches" WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'match % not found', p_match_id;
  END IF;

  -- Callable by a participant, or by a service role (auth.uid() IS NULL) for
  -- back-office re-settlement after a manual review. Not by arbitrary signed-
  -- in users: harmless in practice, but there is no reason to expose it.
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "match_participants"
    WHERE match_id = p_match_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'you are not a participant in this match';
  END IF;

  -- The one guard that makes a double payout impossible, however many callers
  -- race here.
  IF v_match.settled_at IS NOT NULL THEN
    RETURN 'already_settled';
  END IF;

  SELECT * INTO v_challenge FROM "challenges"
    WHERE id = v_match.challenge_id FOR UPDATE;

  SELECT count(*) INTO v_participants
    FROM "match_participants" WHERE match_id = p_match_id;
  IF v_participants <> 2 THEN
    RAISE EXCEPTION 'settle_match expects exactly 2 participants, found % on match %',
      v_participants, p_match_id;
  END IF;

  SELECT count(*) INTO v_submitted
    FROM "match_participants" mp
    JOIN "verification_sessions" vs ON vs.match_participant_id = mp.id
    WHERE mp.match_id = p_match_id;

  -- The normal "first participant finished" case. Not an error.
  IF v_submitted < 2 THEN
    RETURN 'not_ready';
  END IF;

  -- Ordered by user_id purely so a/b are deterministic across calls.
  SELECT mp.user_id, mp.rep_count, mp.hold_duration_seconds,
         vs.anomaly_flag, vs.reviewed
    INTO v_a
    FROM "match_participants" mp
    JOIN "verification_sessions" vs ON vs.match_participant_id = mp.id
    WHERE mp.match_id = p_match_id
    ORDER BY mp.user_id OFFSET 0 LIMIT 1;

  SELECT mp.user_id, mp.rep_count, mp.hold_duration_seconds,
         vs.anomaly_flag, vs.reviewed
    INTO v_b
    FROM "match_participants" mp
    JOIN "verification_sessions" vs ON vs.match_participant_id = mp.id
    WHERE mp.match_id = p_match_id
    ORDER BY mp.user_id OFFSET 1 LIMIT 1;

  IF v_challenge.type = 'pushups' THEN
    v_score_a := v_a.rep_count;
    v_score_b := v_b.rep_count;
  ELSIF v_challenge.type IN ('plank', 'wallsit') THEN
    v_score_a := v_a.hold_duration_seconds;
    v_score_b := v_b.hold_duration_seconds;
  ELSE
    RAISE EXCEPTION 'settlement is not implemented for % challenges', v_challenge.type;
  END IF;

  -- A session exists but its score column is NULL: submit_verification_session
  -- and settle_match disagree about which column this type uses. Refuse rather
  -- than silently treat NULL as a loss.
  IF v_score_a IS NULL OR v_score_b IS NULL THEN
    RAISE EXCEPTION 'match % has a verification session with no % score recorded',
      p_match_id, v_challenge.type;
  END IF;

  IF v_score_a > v_score_b THEN
    v_winner := v_a.user_id;
  ELSIF v_score_b > v_score_a THEN
    v_winner := v_b.user_id;
  ELSE
    v_winner := NULL; -- tie, see TIE RULE above
  END IF;

  IF v_winner IS NULL THEN
    v_blocked := (v_a.anomaly_flag AND NOT v_a.reviewed)
              OR (v_b.anomaly_flag AND NOT v_b.reviewed);
  ELSIF v_winner = v_a.user_id THEN
    v_blocked := v_a.anomaly_flag AND NOT v_a.reviewed;
  ELSE
    v_blocked := v_b.anomaly_flag AND NOT v_b.reviewed;
  END IF;

  IF v_blocked THEN
    -- No ledger entry, no balance change, settled_at stays NULL so a later
    -- call (after reviewed = true) can still settle this match properly.
    UPDATE "challenges" SET status = 'needs_review' WHERE id = v_challenge.id;
    RETURN 'needs_review';
  END IF;

  v_stake := v_challenge.stake_points;

  IF v_winner IS NULL THEN
    UPDATE "fitness_profiles" SET points_balance = points_balance + v_stake
      WHERE user_id IN (v_a.user_id, v_b.user_id);

    INSERT INTO "points_ledger_entries" ("id", "user_id", "amount", "reason", "match_id") VALUES
      (gen_random_uuid(), v_a.user_id, v_stake, 'payout', p_match_id),
      (gen_random_uuid(), v_b.user_id, v_stake, 'payout', p_match_id);
  ELSE
    UPDATE "fitness_profiles" SET points_balance = points_balance + (v_stake * 2)
      WHERE user_id = v_winner;

    INSERT INTO "points_ledger_entries" ("id", "user_id", "amount", "reason", "match_id")
      VALUES (gen_random_uuid(), v_winner, v_stake * 2, 'payout', p_match_id);
  END IF;

  UPDATE "matches" SET winner_id = v_winner, settled_at = now() WHERE id = p_match_id;
  UPDATE "challenges" SET status = 'completed' WHERE id = v_challenge.id;

  RETURN CASE WHEN v_winner IS NULL THEN 'tie_refunded' ELSE 'settled' END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.settle_match(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_verification_session(
  p_match_participant_id uuid,
  p_rep_count integer,
  p_raw_metrics jsonb,
  p_anomaly_flag boolean,
  p_hold_duration_seconds integer DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_participant "match_participants"%ROWTYPE;
  v_challenge_type "ChallengeType";
  v_session_id UUID;
BEGIN
  SELECT * INTO v_participant FROM "match_participants"
    WHERE id = p_match_participant_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'match participant % not found', p_match_participant_id;
  END IF;

  IF v_participant.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'you can only submit a verification session for yourself';
  END IF;

  -- Results are single-submission on purpose. Allowing a re-submit would let
  -- someone retry until they liked their own score.
  IF EXISTS (
    SELECT 1 FROM "verification_sessions"
    WHERE match_participant_id = p_match_participant_id
  ) THEN
    RAISE EXCEPTION 'a verification session has already been submitted for this participant';
  END IF;

  SELECT c.type INTO v_challenge_type
    FROM "matches" m
    JOIN "challenges" c ON c.id = m.challenge_id
    WHERE m.id = v_participant.match_id;

  -- Each type accepts exactly one score and rejects the other outright. A rep
  -- count on a plank (or vice versa) means the client ran the wrong pose
  -- model, which must not be recorded as a valid result.
  IF v_challenge_type = 'pushups' THEN
    IF p_rep_count IS NULL OR p_rep_count < 0 THEN
      RAISE EXCEPTION 'rep count must be zero or greater for a pushups challenge';
    END IF;
    IF p_hold_duration_seconds IS NOT NULL THEN
      RAISE EXCEPTION 'hold duration is not a valid result for a pushups challenge';
    END IF;
  ELSIF v_challenge_type IN ('plank', 'wallsit') THEN
    IF p_hold_duration_seconds IS NULL OR p_hold_duration_seconds < 0 THEN
      RAISE EXCEPTION 'hold duration must be zero or greater for a % challenge', v_challenge_type;
    END IF;
    IF p_rep_count IS NOT NULL THEN
      RAISE EXCEPTION 'rep count is not a valid result for a % challenge', v_challenge_type;
    END IF;
  ELSE
    RAISE EXCEPTION 'camera verification is not implemented for % yet', v_challenge_type;
  END IF;

  INSERT INTO "verification_sessions"
    ("id", "match_participant_id", "raw_metrics", "anomaly_flag", "reviewed")
    VALUES (gen_random_uuid(), p_match_participant_id, p_raw_metrics,
            COALESCE(p_anomaly_flag, false), false)
    RETURNING id INTO v_session_id;

  UPDATE "match_participants"
    SET rep_count = p_rep_count,
        hold_duration_seconds = p_hold_duration_seconds
    WHERE id = p_match_participant_id;

  -- Settle inline, in this same transaction, the moment the second result
  -- lands. Deliberately not left to the client: a client that submits and then
  -- dies (or a modified build that simply never calls settle_match) would
  -- otherwise strand the match unsettled forever. Returns 'not_ready'
  -- harmlessly for the first submitter.
  --
  -- Letting a settlement failure roll this INSERT back is intentional. Every
  -- RAISE inside settle_match is a real inconsistency, and recording a result
  -- that provably cannot be settled is worse than rejecting the submission.
  PERFORM public.settle_match(v_participant.match_id);

  RETURN v_session_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_verification_session(uuid, integer, jsonb, boolean, integer) TO authenticated;

-- ----------------------------------------------------------------------------
-- 6. Make PostgREST pick up the restored columns immediately
-- ----------------------------------------------------------------------------

NOTIFY pgrst, 'reload schema';
