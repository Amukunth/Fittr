-- Fittr challenge/matchmaking/points models.
--
-- Scope: adds new tables to the `public` schema of the Supabase Postgres
-- database already used by FittrLanding/waitlist-app. Does NOT touch
-- `signups` or anything in the `auth` schema.
--
-- APPLIED 2026-09-02 via `prisma migrate deploy` against the shared
-- Supabase project (bxfonvtmhxjcnmjhcsls). Written by hand for review, not
-- generated from a live connection — see BACKEND.md for why, and for what
-- that caught before this ran (an earlier multiSchema-based schema.prisma
-- would have made `prisma db push`/`migrate dev` compute DROP TABLE for
-- most of Supabase's real auth.* tables and for `signups`; `migrate deploy`
-- itself was never at risk, since it only ever replays this literal file).

-- ============================================================================
-- Enums
-- ============================================================================

CREATE TYPE "StrengthTier" AS ENUM ('beginner', 'intermediate', 'advanced');

CREATE TYPE "ChallengeType" AS ENUM ('pushups', 'plank', 'wallsit', 'race');

CREATE TYPE "ChallengeFormat" AS ENUM ('pooled', '1v1');

CREATE TYPE "ChallengeStatus" AS ENUM ('open', 'matched', 'in_progress', 'completed');

CREATE TYPE "LedgerReason" AS ENUM ('stake', 'payout', 'bonus');

-- ============================================================================
-- Tables
-- ============================================================================

CREATE TABLE "fitness_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "strength_tier" "StrengthTier" NOT NULL DEFAULT 'beginner',
    "points_balance" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fitness_profiles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fitness_profiles_user_id_key" UNIQUE ("user_id"),
    CONSTRAINT "fitness_profiles_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "auth"."users"("id") ON DELETE CASCADE
);

CREATE TABLE "challenges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "ChallengeType" NOT NULL,
    "format" "ChallengeFormat" NOT NULL,
    "stake_points" INTEGER NOT NULL,
    "status" "ChallengeStatus" NOT NULL DEFAULT 'open',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "challenges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "challenges_created_by_fkey" FOREIGN KEY ("created_by")
        REFERENCES "auth"."users"("id") ON DELETE RESTRICT
);

CREATE INDEX "challenges_status_idx" ON "challenges"("status");
CREATE INDEX "challenges_type_idx" ON "challenges"("type");

CREATE TABLE "matches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "challenge_id" UUID NOT NULL,
    "winner_id" UUID,
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "matches_challenge_id_key" UNIQUE ("challenge_id"),
    CONSTRAINT "matches_challenge_id_fkey" FOREIGN KEY ("challenge_id")
        REFERENCES "challenges"("id") ON DELETE CASCADE,
    CONSTRAINT "matches_winner_id_fkey" FOREIGN KEY ("winner_id")
        REFERENCES "auth"."users"("id")
);

CREATE TABLE "match_participants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "match_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "rep_count" INTEGER,
    "hold_duration_seconds" INTEGER,
    "time_seconds" INTEGER,

    CONSTRAINT "match_participants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "match_participants_match_id_user_id_key" UNIQUE ("match_id", "user_id"),
    CONSTRAINT "match_participants_match_id_fkey" FOREIGN KEY ("match_id")
        REFERENCES "matches"("id") ON DELETE CASCADE,
    CONSTRAINT "match_participants_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "auth"."users"("id")
);

CREATE TABLE "verification_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "match_participant_id" UUID NOT NULL,
    "raw_metrics" JSONB NOT NULL,
    "anomaly_flag" BOOLEAN NOT NULL DEFAULT false,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "verification_sessions_match_participant_id_key" UNIQUE ("match_participant_id"),
    CONSTRAINT "verification_sessions_match_participant_id_fkey" FOREIGN KEY ("match_participant_id")
        REFERENCES "match_participants"("id") ON DELETE CASCADE
);

CREATE TABLE "points_ledger_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" "LedgerReason" NOT NULL,
    "match_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_ledger_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "points_ledger_entries_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "auth"."users"("id"),
    CONSTRAINT "points_ledger_entries_match_id_fkey" FOREIGN KEY ("match_id")
        REFERENCES "matches"("id")
);

CREATE INDEX "points_ledger_entries_user_id_idx" ON "points_ledger_entries"("user_id");
CREATE INDEX "points_ledger_entries_match_id_idx" ON "points_ledger_entries"("match_id");

-- ============================================================================
-- Row Level Security
--
-- The RN app talks to Supabase directly with the anon key (see BACKEND.md
-- for why Prisma/DATABASE_URL never ships in the app bundle), so every one
-- of these tables needs RLS or the anon key can read/write everything.
-- Policies below are deliberately narrow for v1: no client-side path can
-- move points or flip challenge/match status — that all happens inside
-- join_challenge() below, which runs as SECURITY DEFINER.
-- ============================================================================

ALTER TABLE "fitness_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "challenges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "matches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "match_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verification_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "points_ledger_entries" ENABLE ROW LEVEL SECURITY;

-- fitness_profiles: a user can see, create, and partially update only their
-- own row.
--
-- INSERT is constrained (via WITH CHECK) to always start at points_balance
-- = 0 — otherwise a client could insert their own profile with an arbitrary
-- balance. UPDATE is restricted at the column-privilege level to
-- strength_tier only (Postgres column-level GRANT), because RLS alone
-- cannot express "this column may change, that one may not" on an UPDATE —
-- WITH CHECK only sees the new row, not a diff against the old one. Every
-- other balance change goes through a SECURITY DEFINER function
-- (join_challenge, grant_starter_bonus below).
CREATE POLICY "fitness_profiles_select_own" ON "fitness_profiles"
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "fitness_profiles_insert_own" ON "fitness_profiles"
    FOR INSERT WITH CHECK (auth.uid() = user_id AND points_balance = 0);

CREATE POLICY "fitness_profiles_update_own" ON "fitness_profiles"
    FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Supabase's default privileges grant broad table-level DML to
-- `authenticated` when a table is created; RLS restricts which *rows* that
-- applies to, but not which *columns* an UPDATE can touch. Narrow that
-- explicitly so a client-side UPDATE can only ever change strength_tier.
REVOKE UPDATE ON "fitness_profiles" FROM authenticated;
GRANT UPDATE ("strength_tier") ON "fitness_profiles" TO authenticated;

-- challenges: open marketplace is readable by any signed-in user; you can
-- only create challenges as yourself, and every new challenge is forced to
-- start life as 'open' (WITH CHECK) regardless of what a client sends —
-- status otherwise only moves via join_challenge(). No UPDATE policy at
-- all, so no client can flip a challenge's status directly.
CREATE POLICY "challenges_select_all" ON "challenges"
    FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "challenges_insert_own" ON "challenges"
    FOR INSERT WITH CHECK (auth.uid() = created_by AND status = 'open');

-- matches / match_participants: visible only to participants.
CREATE POLICY "matches_select_participant" ON "matches"
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM "match_participants" mp
            WHERE mp.match_id = matches.id AND mp.user_id = auth.uid()
        )
    );

CREATE POLICY "match_participants_select_participant" ON "match_participants"
    FOR SELECT USING (
        user_id = auth.uid()
        OR EXISTS (
            SELECT 1 FROM "match_participants" mp2
            WHERE mp2.match_id = match_participants.match_id AND mp2.user_id = auth.uid()
        )
    );

-- verification_sessions: a participant can see only their own session. No
-- client INSERT/UPDATE policy — the (future) verification pipeline writes
-- these with a service role, bypassing RLS.
CREATE POLICY "verification_sessions_select_own" ON "verification_sessions"
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM "match_participants" mp
            WHERE mp.id = verification_sessions.match_participant_id AND mp.user_id = auth.uid()
        )
    );

-- points_ledger_entries: a user can see only their own entries. No client
-- INSERT/UPDATE policy anywhere — every row is written by join_challenge()
-- (or, later, the settlement function), never directly by a client.
CREATE POLICY "points_ledger_entries_select_own" ON "points_ledger_entries"
    FOR SELECT USING (user_id = auth.uid());

-- ============================================================================
-- Matchmaking: join_challenge()
--
-- Single atomic entry point for "accept a 1v1" / "join a pooled challenge".
-- v1 matchmaking is deliberately naive: a Challenge IS the pool/offer, and
-- the first same-tier joiner completes it into a 2-participant Match. There
-- is no separate "pool size" concept yet (not in the brief's Challenge
-- fields) — pooled vs. 1v1 differ only in how the Home screen presents them,
-- not in backend mechanics. See BACKEND.md.
--
-- Runs SECURITY DEFINER so it can move points_balance and flip status even
-- though no client-side RLS policy allows either — this is the only place
-- either happens. search_path is pinned to block search_path hijacking.
-- ============================================================================

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

-- ============================================================================
-- Starter bonus
--
-- v1 has no payments, so there's no top-up path — without some starting
-- balance the app is unusable end-to-end. ASSUMED a one-time 500pt grant on
-- profile creation; adjust v_bonus_amount (or remove this entirely) once
-- product decides real starting economics. Idempotent: a user can only ever
-- receive one 'bonus' ledger entry.
-- ============================================================================

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

-- ============================================================================
-- Settlement stub — intentionally NOT implemented.
--
-- Crediting the winner depends on verified results that don't exist until
-- camera verification (next pass) lands. When that's built, settlement
-- should be a second SECURITY DEFINER function (e.g. settle_match(uuid))
-- so the same "no client-side ledger writes" rule holds for payouts too.
-- ============================================================================
