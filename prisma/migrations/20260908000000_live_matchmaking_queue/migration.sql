-- ============================================================================
-- Live matchmaking queue.
--
-- Replaces browse-and-accept (a client-inserted `challenges` row that other
-- users found on Home and joined with join_challenge()) with a queue: a
-- fighter asks for exercise + format + stake, the server either seats them in
-- a compatible lobby that is already forming or opens a new one, and the
-- moment a lobby is full it becomes a Match for everyone at once.
--
--   challenges.max_participants   seats: 2 for 1v1, 3..6 for a Group Battle
--   matchmaking_queue             one row per fighter in the queue; also the
--                                 realtime channel that tells them they matched
--   matchmaking_presence          heartbeat timestamps, deliberately NOT published
--   enter_matchmaking()           find-or-create a lobby, seat the caller,
--                                 complete the match when the last seat fills
--   matchmaking_heartbeat()       liveness + catch-up + tier-widening retry
--   leave_matchmaking()           cancel; a no-op if the lobby just filled
--   settle_match()                generalised to N seats
--   delete_my_account()           now also leaves the queue
--   join_challenge()              DROPPED, with the client INSERT on challenges
--
-- A lobby IS a `challenges` row with status 'open'. Queue rows point at it via
-- challenge_id. Nothing is staked while a lobby forms; stakes move only inside
-- _mm_try_complete(), in the same transaction that creates the Match, so a
-- cancel is a plain DELETE with nothing to refund.
--
-- ----------------------------------------------------------------------------
-- CONCURRENCY — read this before touching any function below.
--
-- The race that matters: two fighters enter an empty queue at the same
-- instant. Each looks for a lobby, sees none (the other's INSERT is not yet
-- committed), opens its own, and they never meet. No row lock can prevent
-- that, because there is no row yet to lock; SELECT ... FOR UPDATE SKIP LOCKED
-- on its own would make it WORSE (a momentarily locked lobby is skipped and a
-- duplicate is opened). So:
--
--   1. Every mutation of queue membership first takes a transaction-scoped
--      advisory lock on the "domain" it can match within:
--      (exercise_type, format, max_participants). Stake and tier compatibility
--      both live inside one domain, so serialising the domain serialises every
--      pair that could ever be matched. Different exercises/formats proceed
--      in parallel. Transaction-scoped (pg_advisory_xact_lock) so it is safe
--      behind a transaction-mode pooler and can never leak. When one call
--      touches two domains (re-entering with a different request) it takes
--      both keys in ascending order, so two such calls cannot deadlock.
--   2. Inside that lock the code still takes row locks, in one fixed order:
--      lobby `challenges` row  ->  member `matchmaking_queue` rows  ->
--      `fitness_profiles` rows ORDER BY user_id. No function takes any row
--      lock (FOR UPDATE, UPDATE, DELETE) before it holds its advisory lock;
--      the pre-checks at the top of enter_matchmaking() are plain reads. The
--      order is what keeps enter / heartbeat / leave / delete_my_account /
--      settle_match from deadlocking with each other. Do not lock in any
--      other order.
--   3. READ COMMITTED semantics are relied on: a statement that waits on a
--      FOR UPDATE row re-evaluates its WHERE against the committed row when
--      the lock is granted, so a leave that waited behind a completing
--      matcher sees status = 'matched' and returns instead of deleting.
--   4. The sweep of stale rows uses FOR UPDATE SKIP LOCKED — the one place
--      it is right: a stale row that some other transaction is touching is
--      simply left for the next sweep rather than waited on.
--   5. Every write to a queue row is guarded on its current status, so a
--      call that read 'searching' before waiting for the lock cannot revive a
--      row that was matched or expired while it waited.
--
-- What this file cannot prove: the same code paths driven through PostgREST
-- by two real phones. __tests__/matchmaking.db.test.ts races real connections
-- against a real Postgres, which exercises every lock here, but not the wire.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Seats on a challenge
-- ----------------------------------------------------------------------------

ALTER TABLE "challenges"
  ADD COLUMN "max_participants" INTEGER NOT NULL DEFAULT 2;

ALTER TABLE "challenges"
  ADD CONSTRAINT "challenges_max_participants_range"
    CHECK ("max_participants" BETWEEN 2 AND 6),
  ADD CONSTRAINT "challenges_1v1_has_two_seats"
    CHECK ("format" <> '1v1' OR "max_participants" = 2),
  ADD CONSTRAINT "challenges_stake_positive"
    CHECK ("stake_points" > 0);

-- ----------------------------------------------------------------------------
-- 2. Retire browse-and-accept
--
-- Nobody creates a challenge from the client any more; enter_matchmaking()
-- opens lobbies as SECURITY DEFINER. Supabase's default grant gave
-- authenticated every privilege on the table and RLS was the only thing
-- narrowing it, so the write privileges go too — SELECT stays (Home, Results
-- and the realtime subscriptions read it).
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.join_challenge(uuid, uuid);
DROP POLICY IF EXISTS "challenges_insert_own" ON "challenges";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "challenges" FROM anon, authenticated;

-- An unanswered call-out from the old model has nothing staked and no way to
-- be answered now. (0 rows on the live database when this was written.)
DELETE FROM "challenges" c
 WHERE c."status" = 'open'
   AND NOT EXISTS (SELECT 1 FROM "matches" m WHERE m."challenge_id" = c."id");

-- ----------------------------------------------------------------------------
-- 3. The queue
-- ----------------------------------------------------------------------------

CREATE TYPE "MatchmakingStatus" AS ENUM ('searching', 'matched', 'cancelled');

CREATE TABLE "matchmaking_queue" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"          UUID NOT NULL,
  "exercise_type"    "ChallengeType" NOT NULL,
  "format"           "ChallengeFormat" NOT NULL,
  "max_participants" INTEGER NOT NULL,
  "stake_points"     INTEGER NOT NULL,
  -- Snapshot at entry. Changing tier mid-search does not move a fighter, and
  -- the client can UPDATE fitness_profiles.strength_tier whenever it likes.
  "strength_tier"    "StrengthTier" NOT NULL,
  "status"           "MatchmakingStatus" NOT NULL DEFAULT 'searching',
  -- The lobby this entry is seated in. Never NULL while searching (CHECK
  -- below): the FK's SET NULL then turns "a lobby was deleted under a live
  -- member" from a silent orphan into a loud transaction failure.
  "challenge_id"     UUID,
  -- Set in the same transaction that creates the Match.
  "match_id"         UUID,
  -- Denormalised so every member's own row (their realtime channel) says
  -- how full the lobby is without being able to read anyone else's row.
  "lobby_size"       INTEGER NOT NULL DEFAULT 1,
  -- 'expired' | 'insufficient_points' | 'replaced'. NULL otherwise.
  "cancel_reason"    TEXT,
  "joined_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- When the row left 'searching' (matched or cancelled). Drives retention.
  "closed_at"        TIMESTAMPTZ,

  CONSTRAINT "matchmaking_queue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "matchmaking_queue_user_id_fkey" FOREIGN KEY ("user_id")
      REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  CONSTRAINT "matchmaking_queue_challenge_id_fkey" FOREIGN KEY ("challenge_id")
      REFERENCES "challenges"("id") ON DELETE SET NULL,
  CONSTRAINT "matchmaking_queue_match_id_fkey" FOREIGN KEY ("match_id")
      REFERENCES "matches"("id") ON DELETE SET NULL,
  CONSTRAINT "matchmaking_queue_stake_positive" CHECK ("stake_points" > 0),
  CONSTRAINT "matchmaking_queue_seats_range" CHECK ("max_participants" BETWEEN 2 AND 6),
  CONSTRAINT "matchmaking_queue_1v1_has_two_seats"
      CHECK ("format" <> '1v1' OR "max_participants" = 2),
  CONSTRAINT "matchmaking_queue_searching_has_lobby"
      CHECK ("status" <> 'searching' OR "challenge_id" IS NOT NULL),
  CONSTRAINT "matchmaking_queue_matched_has_match"
      CHECK ("status" <> 'matched' OR "match_id" IS NOT NULL),
  CONSTRAINT "matchmaking_queue_closed_when_not_searching"
      CHECK (("status" = 'searching') = ("closed_at" IS NULL))
);

-- One live search per fighter. Partial, so the closed rows kept for a few
-- minutes (see _mm_sweep) never block a fresh entry.
CREATE UNIQUE INDEX "matchmaking_queue_one_live_search_per_user"
  ON "matchmaking_queue" ("user_id") WHERE "status" = 'searching';

CREATE INDEX "matchmaking_queue_domain_idx"
  ON "matchmaking_queue" ("exercise_type", "format", "max_participants", "status");
CREATE INDEX "matchmaking_queue_challenge_id_idx" ON "matchmaking_queue" ("challenge_id");
CREATE INDEX "challenges_open_lobbies_idx"
  ON "challenges" ("type", "format", "max_participants", "stake_points", "created_at")
  WHERE "status" = 'open';

ALTER TABLE "matchmaking_queue" ENABLE ROW LEVEL SECURITY;

-- Own row only. This is also exactly the per-subscriber check Supabase
-- Realtime applies to UPDATE events, so a fighter's socket can only ever
-- carry their own entry.
CREATE POLICY "matchmaking_queue_select_own" ON "matchmaking_queue"
  FOR SELECT USING ("user_id" = auth.uid());

-- No client write path at all: every change is one of the functions below.
REVOKE ALL ON "matchmaking_queue" FROM anon, authenticated;
GRANT SELECT ON "matchmaking_queue" TO authenticated;

-- Deliberately left at the default (primary-key) REPLICA IDENTITY, unlike
-- challenges. Realtime cannot apply RLS to DELETE events; with FULL identity
-- every leave/replace/sweep DELETE would broadcast the whole old row to any
-- subscriber, with the default it carries only the id. Nothing reads
-- payload.old here.

-- Heartbeats live in their own table so that "still here" every 5 seconds
-- is not a realtime UPDATE event on the published table: every event on a
-- matchmaking_queue row now means something changed (lobby_size, status).
-- Not published, not readable by clients; only the functions touch it.
CREATE TABLE "matchmaking_presence" (
  "queue_id"     UUID NOT NULL,
  "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "matchmaking_presence_pkey" PRIMARY KEY ("queue_id"),
  CONSTRAINT "matchmaking_presence_queue_id_fkey" FOREIGN KEY ("queue_id")
      REFERENCES "matchmaking_queue"("id") ON DELETE CASCADE
);

ALTER TABLE "matchmaking_presence" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "matchmaking_presence" FROM anon, authenticated;

-- Put the queue on the wire. Guarded the same way as 20260903100000: a plain
-- Postgres (the embedded test database) has no supabase_realtime publication.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'publication supabase_realtime not found - skipping (not a Supabase database?)';
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'matchmaking_queue'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.matchmaking_queue;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4. Open lobbies are private
--
-- Under browse-and-accept an open challenge was a public offer. Now it is a
-- record of who is searching, at what stake, right now — presence data. Only
-- its members can read it; matched and settled challenges stay readable by
-- any signed-in user (Home, Results and the realtime subscriptions need
-- them). The membership lookup is a SECURITY DEFINER helper, per the rule in
-- BACKEND.md that a policy never queries a table with a policy on it.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_lobby_member(p_challenge_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "matchmaking_queue"
     WHERE "challenge_id" = p_challenge_id AND "user_id" = auth.uid()
  );
$$;
REVOKE ALL ON FUNCTION public.is_lobby_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_lobby_member(uuid) TO authenticated;

DROP POLICY IF EXISTS "challenges_select_all" ON "challenges";
CREATE POLICY "challenges_select_visible" ON "challenges"
  FOR SELECT USING (
    auth.role() = 'authenticated'
    AND ("status" <> 'open' OR public.is_lobby_member("id"))
  );

-- ----------------------------------------------------------------------------
-- 5. Tunables
--
-- Mirrored in src/lib/matchmaking.ts and src/theme/copy.ts. Functions rather
-- than a settings table so the values are in version control next to the
-- code that uses them.
-- ----------------------------------------------------------------------------

-- A fighter whose app has not heartbeat for this long is treated as gone.
-- The client beats every 5 s, so this is four missed beats: long enough to
-- ride out a slow cell handoff, short enough that a killed app does not sit
-- in the queue looking available to the next person.
CREATE OR REPLACE FUNCTION public._mm_ttl() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '20 seconds' $$;

-- Once BOTH a lobby and a fighter have waited this long, they may be paired
-- one tier apart. Never two tiers apart (beginner never meets advanced).
CREATE OR REPLACE FUNCTION public._mm_tier_widen_after() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '45 seconds' $$;

-- Matched / cancelled rows stay this long so a client that was offline when
-- the event fired can still learn what happened from a heartbeat.
CREATE OR REPLACE FUNCTION public._mm_closed_row_retention() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '10 minutes' $$;

-- A fighter may not start a new search within this long of their last one
-- (identical repeat requests are answered with the existing row instead).
-- Bounds how fast one modified client can churn a domain's lobbies.
CREATE OR REPLACE FUNCTION public._mm_reentry_floor() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '3 seconds' $$;

-- A fighter with a round still open (matched, not yet submitted) in a bout
-- younger than this cannot queue again. Older abandoned bouts do not block:
-- until a forfeit rule exists this is the only bound on "start a bout, never
-- play it" — see BACKEND.md.
CREATE OR REPLACE FUNCTION public._mm_open_round_blocks_for() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '24 hours' $$;

-- The stakes Find a Bout offers (STAKE_OPTIONS). Anything else would form a
-- private domain no honest client can ever match into.
CREATE OR REPLACE FUNCTION public._mm_stake_options() RETURNS integer[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[50, 100, 250, 500] $$;

CREATE OR REPLACE FUNCTION public._mm_tier_rank(p_tier "StrengthTier") RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_tier WHEN 'beginner' THEN 1 WHEN 'intermediate' THEN 2 ELSE 3 END
$$;

-- ----------------------------------------------------------------------------
-- 6. Internal helpers
--
-- Not callable by clients: Postgres grants EXECUTE on a new function to
-- PUBLIC, so each one is revoked explicitly. They are only reached from the
-- SECURITY DEFINER entry points.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._mm_domain_key(
  p_exercise "ChallengeType", p_format "ChallengeFormat", p_max integer
) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtext('matchmaking:' || p_exercise::text || ':' || p_format::text || ':' || p_max::text)::bigint
$$;
REVOKE ALL ON FUNCTION public._mm_domain_key("ChallengeType", "ChallengeFormat", integer) FROM PUBLIC, anon, authenticated;

-- Serialise one matchable domain. See CONCURRENCY above.
CREATE OR REPLACE FUNCTION public._mm_domain_lock(
  p_exercise "ChallengeType", p_format "ChallengeFormat", p_max integer
) RETURNS void
LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(public._mm_domain_key(p_exercise, p_format, p_max))
$$;
REVOKE ALL ON FUNCTION public._mm_domain_lock("ChallengeType", "ChallengeFormat", integer) FROM PUBLIC, anon, authenticated;

-- Keep lobby_size honest for one lobby and drop it if nobody is left. The
-- caller must already hold the lobby's challenges row FOR UPDATE.
CREATE OR REPLACE FUNCTION public._mm_fix_lobby(p_lobby_id uuid) RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_lobby_id IS NULL THEN
    RETURN 0;
  END IF;
  SELECT count(*) INTO v_n
    FROM "matchmaking_queue" WHERE "challenge_id" = p_lobby_id AND "status" = 'searching';
  IF v_n = 0 THEN
    DELETE FROM "challenges" c
     WHERE c."id" = p_lobby_id
       AND c."status" = 'open'
       AND NOT EXISTS (SELECT 1 FROM "matches" m WHERE m."challenge_id" = c."id");
  ELSE
    UPDATE "matchmaking_queue"
       SET "lobby_size" = v_n
     WHERE "challenge_id" = p_lobby_id AND "status" = 'searching' AND "lobby_size" <> v_n;
  END IF;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public._mm_fix_lobby(uuid) FROM PUBLIC, anon, authenticated;

-- Is there anything in this domain the sweep would change? A plain read, so
-- heartbeats can decide whether the domain lock is worth taking.
CREATE OR REPLACE FUNCTION public._mm_sweep_needed(
  p_exercise "ChallengeType", p_format "ChallengeFormat", p_max integer
) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "matchmaking_queue" q
      LEFT JOIN "matchmaking_presence" p ON p."queue_id" = q."id"
     WHERE q."status" = 'searching'
       AND q."exercise_type" = p_exercise
       AND q."format" = p_format
       AND q."max_participants" = p_max
       AND coalesce(p."last_seen_at", q."joined_at") < now() - public._mm_ttl()
  )
$$;
REVOKE ALL ON FUNCTION public._mm_sweep_needed("ChallengeType", "ChallengeFormat", integer) FROM PUBLIC, anon, authenticated;

-- Expire silent fighters in one domain and tidy up. Runs under the domain
-- lock inside enter (always) and heartbeat (when needed), so no cron is
-- required: the queue is cleaned exactly when someone is about to read it.
CREATE OR REPLACE FUNCTION public._mm_sweep(
  p_exercise "ChallengeType", p_format "ChallengeFormat", p_max integer
) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_lobby uuid;
BEGIN
  -- Stale searching rows -> cancelled/'expired'. SKIP LOCKED: a row another
  -- transaction is touching right now is left for the next sweep.
  WITH stale AS (
    SELECT q."id"
      FROM "matchmaking_queue" q
      LEFT JOIN "matchmaking_presence" p ON p."queue_id" = q."id"
     WHERE q."status" = 'searching'
       AND q."exercise_type" = p_exercise
       AND q."format" = p_format
       AND q."max_participants" = p_max
       AND coalesce(p."last_seen_at", q."joined_at") < now() - public._mm_ttl()
     FOR UPDATE OF q SKIP LOCKED
  ),
  expired AS (
    UPDATE "matchmaking_queue" q
       SET "status" = 'cancelled', "cancel_reason" = 'expired', "closed_at" = now()
      FROM stale
     WHERE q."id" = stale."id"
     RETURNING q."id"
  )
  DELETE FROM "matchmaking_presence" p USING expired WHERE p."queue_id" = expired."id";

  -- Every open lobby in the domain: recount, and drop the empty ones.
  FOR v_lobby IN
    SELECT c."id" FROM "challenges" c
     WHERE c."status" = 'open'
       AND c."type" = p_exercise AND c."format" = p_format AND c."max_participants" = p_max
     ORDER BY c."created_at"
     FOR UPDATE
  LOOP
    PERFORM public._mm_fix_lobby(v_lobby);
  END LOOP;

  -- Closed rows past their retention, in any domain. Nobody locks these.
  DELETE FROM "matchmaking_queue"
   WHERE "status" IN ('matched', 'cancelled')
     AND "closed_at" < now() - public._mm_closed_row_retention();
END;
$$;
REVOKE ALL ON FUNCTION public._mm_sweep("ChallengeType", "ChallengeFormat", integer) FROM PUBLIC, anon, authenticated;

-- The compatibility rule, in one place. A lobby fits a fighter when it is in
-- the same domain at the same stake, has a free seat, and every current
-- member is in the fighter's tier — or within one tier once BOTH the lobby
-- and the fighter (p_waiting_since) have waited _mm_tier_widen_after(). A
-- brand-new entrant passes now(), so nobody is ever widened before they have
-- waited themselves; the heartbeat retry is what pairs two patient
-- neighbours. Oldest lobby first, and the row comes back locked FOR UPDATE
-- (not SKIP LOCKED: under the domain lock the only other holders are short
-- row-level transactions, and skipping would open a duplicate lobby — the
-- exact miss this design exists to prevent).
CREATE OR REPLACE FUNCTION public._mm_find_lobby(
  p_exercise "ChallengeType", p_format "ChallengeFormat", p_max integer,
  p_stake integer, p_tier "StrengthTier", p_waiting_since timestamptz, p_exclude uuid
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_lobby uuid;
  v_widen boolean := p_waiting_since <= now() - public._mm_tier_widen_after();
BEGIN
  SELECT c."id" INTO v_lobby
    FROM "challenges" c
   WHERE c."status" = 'open'
     AND c."type" = p_exercise
     AND c."format" = p_format
     AND c."max_participants" = p_max
     AND c."stake_points" = p_stake
     AND (p_exclude IS NULL OR c."id" <> p_exclude)
     AND EXISTS (
           SELECT 1 FROM "matchmaking_queue" q
            WHERE q."challenge_id" = c."id" AND q."status" = 'searching')
     AND (SELECT count(*) FROM "matchmaking_queue" q
           WHERE q."challenge_id" = c."id" AND q."status" = 'searching') < c."max_participants"
     AND NOT EXISTS (
           SELECT 1 FROM "matchmaking_queue" q
            WHERE q."challenge_id" = c."id" AND q."status" = 'searching'
              AND abs(public._mm_tier_rank(q."strength_tier") - public._mm_tier_rank(p_tier))
                  > CASE WHEN v_widen AND c."created_at" <= now() - public._mm_tier_widen_after()
                         THEN 1 ELSE 0 END)
   ORDER BY c."created_at", c."id"
   LIMIT 1
   FOR UPDATE OF c;
  RETURN v_lobby;
END;
$$;
REVOKE ALL ON FUNCTION public._mm_find_lobby("ChallengeType", "ChallengeFormat", integer, integer, "StrengthTier", timestamptz, uuid) FROM PUBLIC, anon, authenticated;

-- Turn a full lobby into a Match. The caller holds the domain lock and the
-- lobby's challenges row FOR UPDATE. Returns the match id, or NULL if the
-- lobby is not full (or a member could no longer cover the stake, in which
-- case that member is evicted and everyone else keeps waiting).
CREATE OR REPLACE FUNCTION public._mm_try_complete(p_lobby_id uuid) RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_lobby "challenges"%ROWTYPE;
  v_member_ids uuid[];
  v_user_ids uuid[];
  v_short uuid[];
  v_match_id uuid;
BEGIN
  SELECT * INTO v_lobby FROM "challenges" WHERE "id" = p_lobby_id;
  IF NOT FOUND OR v_lobby."status" <> 'open' THEN
    RETURN NULL;
  END IF;

  -- Lock every member row. A leave_matchmaking() racing us blocks here and,
  -- once we commit, re-reads its row as 'matched'.
  SELECT coalesce(array_agg(m."id" ORDER BY m."joined_at", m."id"), '{}'),
         coalesce(array_agg(m."user_id" ORDER BY m."joined_at", m."id"), '{}')
    INTO v_member_ids, v_user_ids
    FROM (
      SELECT q."id", q."user_id", q."joined_at"
        FROM "matchmaking_queue" q
       WHERE q."challenge_id" = p_lobby_id AND q."status" = 'searching'
       FOR UPDATE
    ) m;

  IF cardinality(v_member_ids) < v_lobby."max_participants" THEN
    PERFORM public._mm_fix_lobby(p_lobby_id);
    RETURN NULL;
  END IF;

  -- Profiles in user_id order: the same order settle_match() uses, so the two
  -- can never deadlock on a fighter who is settling one bout while another
  -- fills. Balances are re-checked here, not trusted from entry time.
  SELECT coalesce(array_agg(p."user_id"), '{}') INTO v_short
    FROM (
      SELECT fp."user_id", fp."points_balance"
        FROM "fitness_profiles" fp
       WHERE fp."user_id" = ANY (v_user_ids)
       ORDER BY fp."user_id"
       FOR UPDATE
    ) p
   WHERE p."points_balance" < v_lobby."stake_points";

  IF cardinality(v_short) > 0 THEN
    WITH evicted AS (
      UPDATE "matchmaking_queue"
         SET "status" = 'cancelled', "cancel_reason" = 'insufficient_points', "closed_at" = now()
       WHERE "challenge_id" = p_lobby_id
         AND "status" = 'searching'
         AND "user_id" = ANY (v_short)
       RETURNING "id"
    )
    DELETE FROM "matchmaking_presence" p USING evicted WHERE p."queue_id" = evicted."id";
    PERFORM public._mm_fix_lobby(p_lobby_id);
    RETURN NULL;
  END IF;

  INSERT INTO "matches" ("id", "challenge_id")
    VALUES (gen_random_uuid(), p_lobby_id)
    RETURNING "id" INTO v_match_id;

  INSERT INTO "match_participants" ("id", "match_id", "user_id")
    SELECT gen_random_uuid(), v_match_id, u FROM unnest(v_user_ids) AS u;

  UPDATE "fitness_profiles"
     SET "points_balance" = "points_balance" - v_lobby."stake_points"
   WHERE "user_id" = ANY (v_user_ids);

  INSERT INTO "points_ledger_entries" ("id", "user_id", "amount", "reason", "match_id")
    SELECT gen_random_uuid(), u, -v_lobby."stake_points", 'stake', v_match_id
      FROM unnest(v_user_ids) AS u;

  UPDATE "challenges" SET "status" = 'matched' WHERE "id" = p_lobby_id;

  DELETE FROM "matchmaking_presence" WHERE "queue_id" = ANY (v_member_ids);

  -- The UPDATE below is the realtime event every member's Searching screen
  -- is waiting for: status 'matched' plus the match_id, in one row.
  UPDATE "matchmaking_queue"
     SET "status" = 'matched',
         "match_id" = v_match_id,
         "closed_at" = now(),
         "lobby_size" = v_lobby."max_participants"
   WHERE "id" = ANY (v_member_ids);

  RETURN v_match_id;
END;
$$;
REVOKE ALL ON FUNCTION public._mm_try_complete(uuid) FROM PUBLIC, anon, authenticated;

-- Remove one searching entry and repair its lobby. Shared by
-- leave_matchmaking(), enter_matchmaking() (re-entry) and delete_my_account().
-- Takes the domain lock itself. With p_reason NULL the row is deleted (a
-- plain cancel); with a reason it is closed as 'cancelled' so the owner's
-- other device sees why over realtime. Returns the row as it was, with
-- status 'cancelled' if it was removed, or unchanged if it had already
-- matched / closed.
CREATE OR REPLACE FUNCTION public._mm_leave(p_queue_id uuid, p_reason text DEFAULT NULL)
RETURNS "matchmaking_queue"
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row "matchmaking_queue"%ROWTYPE;
BEGIN
  -- Domain fields never change on a row, so reading them unlocked is safe.
  SELECT * INTO v_row FROM "matchmaking_queue" WHERE "id" = p_queue_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'queue_entry_not_found';
  END IF;
  IF v_row."status" <> 'searching' THEN
    RETURN v_row;
  END IF;

  PERFORM public._mm_domain_lock(v_row."exercise_type", v_row."format", v_row."max_participants");

  -- Under the domain lock challenge_id is stable; re-read, then lock in the
  -- fixed order: lobby row, then the member row.
  SELECT * INTO v_row FROM "matchmaking_queue" WHERE "id" = p_queue_id;
  IF NOT FOUND OR v_row."status" <> 'searching' THEN
    RETURN v_row;
  END IF;
  PERFORM 1 FROM "challenges" WHERE "id" = v_row."challenge_id" FOR UPDATE;
  SELECT * INTO v_row FROM "matchmaking_queue" WHERE "id" = p_queue_id FOR UPDATE;
  IF v_row."status" <> 'searching' THEN
    -- The lobby filled while we waited for the row lock: the fighter is in.
    RETURN v_row;
  END IF;

  IF p_reason IS NULL THEN
    DELETE FROM "matchmaking_queue" WHERE "id" = p_queue_id;
  ELSE
    UPDATE "matchmaking_queue"
       SET "status" = 'cancelled', "cancel_reason" = p_reason, "closed_at" = now()
     WHERE "id" = p_queue_id;
    DELETE FROM "matchmaking_presence" WHERE "queue_id" = p_queue_id;
  END IF;
  PERFORM public._mm_fix_lobby(v_row."challenge_id");

  v_row."status" := 'cancelled';
  v_row."cancel_reason" := p_reason;
  v_row."closed_at" := now();
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public._mm_leave(uuid, text) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7. Entry points
-- ----------------------------------------------------------------------------

-- Join the queue. Returns the caller's row: status 'matched' with match_id
-- when this very call filled the lobby, otherwise 'searching'. Calling again
-- with the same request returns the existing entry; a different request
-- replaces it (closing the old row as 'replaced' so another device learns).
-- Errors are stable codes: exercise_not_available, stake_invalid,
-- seats_invalid, profile_required, insufficient_points, round_open, too_fast,
-- search_in_flight.
CREATE OR REPLACE FUNCTION public.enter_matchmaking(
  p_exercise_type "ChallengeType",
  p_format "ChallengeFormat",
  p_stake_points integer,
  p_max_participants integer DEFAULT 2
) RETURNS "matchmaking_queue"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_tier "StrengthTier";
  v_balance integer;
  v_existing "matchmaking_queue"%ROWTYPE;
  v_new_key bigint;
  v_old_key bigint;
  v_lobby uuid;
  v_row "matchmaking_queue"%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  IF p_exercise_type NOT IN ('pushups', 'plank', 'wallsit') THEN
    RAISE EXCEPTION 'exercise_not_available';
  END IF;
  IF p_stake_points IS NULL OR NOT (p_stake_points = ANY (public._mm_stake_options())) THEN
    RAISE EXCEPTION 'stake_invalid';
  END IF;
  IF p_max_participants IS NULL OR p_max_participants NOT BETWEEN 2 AND 6
     OR (p_format = '1v1' AND p_max_participants <> 2)
     OR (p_format = 'pooled' AND p_max_participants < 3) THEN
    RAISE EXCEPTION 'seats_invalid';
  END IF;

  -- Plain reads only before the lock (see CONCURRENCY, rule 2). The
  -- authoritative balance check is the FOR UPDATE one in _mm_try_complete.
  SELECT "strength_tier", "points_balance" INTO v_tier, v_balance
    FROM "fitness_profiles" WHERE "user_id" = v_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_required';
  END IF;
  IF v_balance < p_stake_points THEN
    RAISE EXCEPTION 'insufficient_points';
  END IF;

  -- A round of yours is still open in a recent bout: play it first.
  IF EXISTS (
    SELECT 1
      FROM "match_participants" mp
      JOIN "matches" m ON m."id" = mp."match_id"
     WHERE mp."user_id" = v_user
       AND m."settled_at" IS NULL
       AND m."created_at" > now() - public._mm_open_round_blocks_for()
       AND NOT EXISTS (SELECT 1 FROM "verification_sessions" vs WHERE vs."match_participant_id" = mp."id")
  ) THEN
    RAISE EXCEPTION 'round_open';
  END IF;

  -- Which domains does this call touch? The new one, plus the old one if a
  -- search is already running somewhere else. Both keys, ascending, so two
  -- callers moving in opposite directions cannot deadlock on each other.
  v_new_key := public._mm_domain_key(p_exercise_type, p_format, p_max_participants);
  SELECT * INTO v_existing
    FROM "matchmaking_queue" WHERE "user_id" = v_user AND "status" = 'searching';
  IF FOUND THEN
    v_old_key := public._mm_domain_key(v_existing."exercise_type", v_existing."format", v_existing."max_participants");
  END IF;
  IF v_old_key IS NOT NULL AND v_old_key < v_new_key THEN
    PERFORM pg_advisory_xact_lock(v_old_key);
  END IF;
  PERFORM pg_advisory_xact_lock(v_new_key);
  IF v_old_key IS NOT NULL AND v_old_key > v_new_key THEN
    PERFORM pg_advisory_xact_lock(v_old_key);
  END IF;

  -- Re-read under the locks: the row may have matched, expired or been
  -- replaced from another device while we waited.
  SELECT * INTO v_existing
    FROM "matchmaking_queue" WHERE "user_id" = v_user AND "status" = 'searching';
  IF FOUND THEN
    IF v_existing."exercise_type" = p_exercise_type
       AND v_existing."format" = p_format
       AND v_existing."max_participants" = p_max_participants
       AND v_existing."stake_points" = p_stake_points THEN
      -- Same request (double tap, remounted screen): it is still theirs.
      UPDATE "matchmaking_presence" SET "last_seen_at" = now() WHERE "queue_id" = v_existing."id";
      RETURN v_existing;
    END IF;
    IF public._mm_domain_key(v_existing."exercise_type", v_existing."format", v_existing."max_participants")
       NOT IN (v_new_key, coalesce(v_old_key, v_new_key)) THEN
      -- Another device replaced the search in a third domain between our
      -- first read and the lock. Rare; the client simply retries.
      RAISE EXCEPTION 'search_in_flight';
    END IF;
    IF v_existing."joined_at" > now() - public._mm_reentry_floor() THEN
      RAISE EXCEPTION 'too_fast';
    END IF;
    PERFORM public._mm_leave(v_existing."id", 'replaced');
  END IF;

  PERFORM public._mm_sweep(p_exercise_type, p_format, p_max_participants);

  v_lobby := public._mm_find_lobby(
    p_exercise_type, p_format, p_max_participants, p_stake_points, v_tier, now(), NULL);

  IF v_lobby IS NULL THEN
    INSERT INTO "challenges" ("id", "type", "format", "stake_points", "status", "created_by", "max_participants")
      VALUES (gen_random_uuid(), p_exercise_type, p_format, p_stake_points, 'open', v_user, p_max_participants)
      RETURNING "id" INTO v_lobby;
  END IF;

  INSERT INTO "matchmaking_queue"
    ("user_id", "exercise_type", "format", "max_participants", "stake_points", "strength_tier", "challenge_id")
    VALUES (v_user, p_exercise_type, p_format, p_max_participants, p_stake_points, v_tier, v_lobby)
    RETURNING * INTO v_row;
  INSERT INTO "matchmaking_presence" ("queue_id") VALUES (v_row."id");

  PERFORM public._mm_try_complete(v_lobby);

  SELECT * INTO v_row FROM "matchmaking_queue" WHERE "id" = v_row."id";
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.enter_matchmaking("ChallengeType", "ChallengeFormat", integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enter_matchmaking("ChallengeType", "ChallengeFormat", integer, integer) TO authenticated;

-- "Still here." Refreshes presence and returns the entry as it is now, so a
-- realtime event missed while the socket was down is never fatal. The plain
-- beat takes no lock at all; the domain lock is taken only when there is
-- something to sweep or when the caller has waited long enough that tier
-- widening could move them into a neighbouring lobby.
CREATE OR REPLACE FUNCTION public.matchmaking_heartbeat(p_queue_id uuid)
RETURNS "matchmaking_queue"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_row "matchmaking_queue"%ROWTYPE;
  v_alone boolean;
  v_lobby uuid;
  v_old_lobby uuid;
  v_can_widen boolean;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;

  SELECT * INTO v_row FROM "matchmaking_queue" WHERE "id" = p_queue_id AND "user_id" = v_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'queue_entry_not_found';
  END IF;
  IF v_row."status" <> 'searching' THEN
    RETURN v_row;
  END IF;

  -- The beat itself: presence only, no membership change, no domain lock.
  INSERT INTO "matchmaking_presence" ("queue_id", "last_seen_at")
    VALUES (p_queue_id, now())
    ON CONFLICT ("queue_id") DO UPDATE SET "last_seen_at" = now();

  v_can_widen := v_row."joined_at" <= now() - public._mm_tier_widen_after();

  IF v_can_widen
     OR public._mm_sweep_needed(v_row."exercise_type", v_row."format", v_row."max_participants") THEN
    PERFORM public._mm_domain_lock(v_row."exercise_type", v_row."format", v_row."max_participants");

    -- Fresh read under the lock: a fill or a sweep may have closed the row
    -- while we waited. Nothing below may touch a row that is not searching.
    SELECT * INTO v_row FROM "matchmaking_queue" WHERE "id" = p_queue_id;
    IF NOT FOUND OR v_row."status" <> 'searching' THEN
      RETURN v_row;
    END IF;

    PERFORM public._mm_sweep(v_row."exercise_type", v_row."format", v_row."max_participants");

    -- A move can only ever succeed through widening (a same-tier lobby that
    -- appeared later would have joined ours instead), and only a fighter who
    -- is alone can move without breaking up a lobby.
    IF v_can_widen THEN
      SELECT count(*) = 1 INTO v_alone
        FROM "matchmaking_queue"
       WHERE "challenge_id" = v_row."challenge_id" AND "status" = 'searching';
      IF v_alone THEN
        v_lobby := public._mm_find_lobby(
          v_row."exercise_type", v_row."format", v_row."max_participants",
          v_row."stake_points", v_row."strength_tier", v_row."joined_at", v_row."challenge_id");
        IF v_lobby IS NOT NULL THEN
          v_old_lobby := v_row."challenge_id";
          -- Destination already locked by _mm_find_lobby; the old lobby holds
          -- nobody but us. Re-point first, then let _mm_fix_lobby drop the
          -- empty one, so the row is never searching without a lobby.
          PERFORM 1 FROM "challenges" WHERE "id" = v_old_lobby FOR UPDATE;
          UPDATE "matchmaking_queue" SET "challenge_id" = v_lobby
           WHERE "id" = p_queue_id AND "status" = 'searching';
          PERFORM public._mm_fix_lobby(v_old_lobby);
          PERFORM public._mm_try_complete(v_lobby);
        END IF;
      END IF;
    END IF;
  END IF;

  SELECT * INTO v_row FROM "matchmaking_queue" WHERE "id" = p_queue_id;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.matchmaking_heartbeat(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.matchmaking_heartbeat(uuid) TO authenticated;

-- Cancel. If the lobby filled in the same instant the row comes back as
-- 'matched': the stakes have already moved and the fighter is in the bout.
CREATE OR REPLACE FUNCTION public.leave_matchmaking(p_queue_id uuid)
RETURNS "matchmaking_queue"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "matchmaking_queue" WHERE "id" = p_queue_id AND "user_id" = v_user) THEN
    RAISE EXCEPTION 'queue_entry_not_found';
  END IF;
  RETURN public._mm_leave(p_queue_id, NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.leave_matchmaking(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leave_matchmaking(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- 8. Settlement for N seats
--
-- Same rules as before, stated for a field instead of a pair:
--   * everyone must have submitted, else 'not_ready';
--   * best score wins the whole pot (stake x seats) -> 'settled';
--   * fighters tied for best split the pot equally; winner_id stays NULL.
--     Everyone tied -> 'tie_refunded' (each gets their stake back; with two
--     seats that is exactly the old tie). Some tied, some not -> 'tie_split'.
--     Integer points cannot always split evenly (pot 200, three tied -> 66
--     each, 2 left), so the remainder goes to the tied fighter with the
--     lowest user_id, folded into their single payout row — a deterministic
--     rule rather than points evaporating;
--   * if any fighter in the winning set has an unreviewed anomaly flag the
--     bout goes to needs_review and nothing is paid, exactly as before.
-- Profiles are locked FOR UPDATE ORDER BY user_id before paying, the same
-- order _mm_try_complete() uses. The back-office path now requires the
-- service role explicitly instead of inferring it from a missing uid.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.settle_match(p_match_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match "matches"%ROWTYPE;
  v_challenge "challenges"%ROWTYPE;
  v_participants integer;
  v_submitted integer;
  v_null_scores integer;
  v_best integer;
  v_winners uuid[];
  v_blocked boolean;
  v_pot integer;
  v_share integer;
  v_remainder integer;
  v_winner uuid;
BEGIN
  IF auth.uid() IS NULL AND auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not signed in';
  END IF;

  SELECT * INTO v_match FROM "matches" WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'match % not found', p_match_id;
  END IF;

  -- Callable by a participant, or by the service role for back-office
  -- re-settlement after a manual review.
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
  IF v_participants <> v_challenge.max_participants THEN
    RAISE EXCEPTION 'settle_match expects % participants, found % on match %',
      v_challenge.max_participants, v_participants, p_match_id;
  END IF;

  SELECT count(*) INTO v_submitted
    FROM "match_participants" mp
    JOIN "verification_sessions" vs ON vs.match_participant_id = mp.id
    WHERE mp.match_id = p_match_id;

  -- The normal "someone finished first" case. Not an error.
  IF v_submitted < v_participants THEN
    RETURN 'not_ready';
  END IF;

  IF v_challenge.type NOT IN ('pushups', 'plank', 'wallsit') THEN
    RAISE EXCEPTION 'settlement is not implemented for % challenges', v_challenge.type;
  END IF;

  -- A session exists but its score column is NULL: submit_verification_session
  -- and settle_match disagree about which column this type uses. Refuse rather
  -- than silently treat NULL as a loss.
  SELECT count(*) INTO v_null_scores
    FROM "match_participants" mp
   WHERE mp.match_id = p_match_id
     AND CASE WHEN v_challenge.type = 'pushups' THEN mp.rep_count ELSE mp.hold_duration_seconds END IS NULL;
  IF v_null_scores > 0 THEN
    RAISE EXCEPTION 'match % has a verification session with no % score recorded',
      p_match_id, v_challenge.type;
  END IF;

  SELECT max(CASE WHEN v_challenge.type = 'pushups' THEN mp.rep_count ELSE mp.hold_duration_seconds END)
    INTO v_best
    FROM "match_participants" mp WHERE mp.match_id = p_match_id;

  -- Ordered by user_id purely so the remainder rule below is deterministic.
  SELECT array_agg(mp.user_id ORDER BY mp.user_id) INTO v_winners
    FROM "match_participants" mp
   WHERE mp.match_id = p_match_id
     AND CASE WHEN v_challenge.type = 'pushups' THEN mp.rep_count ELSE mp.hold_duration_seconds END = v_best;

  SELECT bool_or(vs.anomaly_flag AND NOT vs.reviewed) INTO v_blocked
    FROM "match_participants" mp
    JOIN "verification_sessions" vs ON vs.match_participant_id = mp.id
   WHERE mp.match_id = p_match_id AND mp.user_id = ANY (v_winners);

  IF coalesce(v_blocked, false) THEN
    -- No ledger entry, no balance change, settled_at stays NULL so a later
    -- call (after reviewed = true) can still settle this match properly.
    UPDATE "challenges" SET status = 'needs_review' WHERE id = v_challenge.id;
    RETURN 'needs_review';
  END IF;

  v_pot := v_challenge.stake_points * v_challenge.max_participants;
  v_share := v_pot / cardinality(v_winners);
  v_remainder := v_pot - v_share * cardinality(v_winners);

  PERFORM 1 FROM "fitness_profiles"
    WHERE user_id = ANY (v_winners) ORDER BY user_id FOR UPDATE;

  IF cardinality(v_winners) = 1 THEN
    v_winner := v_winners[1];
    UPDATE "fitness_profiles" SET points_balance = points_balance + v_pot
      WHERE user_id = v_winner;
    INSERT INTO "points_ledger_entries" ("id", "user_id", "amount", "reason", "match_id")
      VALUES (gen_random_uuid(), v_winner, v_pot, 'payout', p_match_id);
  ELSE
    v_winner := NULL;
    UPDATE "fitness_profiles" fp
       SET points_balance = points_balance + v_share
                            + CASE WHEN fp.user_id = v_winners[1] THEN v_remainder ELSE 0 END
      WHERE fp.user_id = ANY (v_winners);
    INSERT INTO "points_ledger_entries" ("id", "user_id", "amount", "reason", "match_id")
      SELECT gen_random_uuid(), w, v_share + CASE WHEN w = v_winners[1] THEN v_remainder ELSE 0 END,
             'payout', p_match_id
        FROM unnest(v_winners) AS w;
  END IF;

  UPDATE "matches" SET winner_id = v_winner, settled_at = now() WHERE id = p_match_id;
  UPDATE "challenges" SET status = 'completed' WHERE id = v_challenge.id;

  RETURN CASE
    WHEN v_winner IS NOT NULL THEN 'settled'
    WHEN cardinality(v_winners) = v_participants THEN 'tie_refunded'
    ELSE 'tie_split'
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_match(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settle_match(uuid) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 9. Account deletion leaves the queue first
--
-- From 20260907000000_settings_profile with three changes: the caller's
-- searches are closed through _mm_leave() (under the domain lock, repairing
-- their lobbies); the "delete my open challenges" statement is gone, because
-- an open challenge is now a lobby other people may be sitting in and the
-- queue functions own its lifetime; and a bout counts as live only if the
-- caller is a PARTICIPANT — created_by just records who opened a lobby, and
-- someone who opened one and left must not be refused for a bout they are
-- not in.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_my_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_live integer;
  v_entry uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;

  -- Out of the queue, repairing whatever lobby they were in. If the lobby
  -- fills in this same instant the entry comes back 'matched' and the
  -- live_bouts check below refuses the deletion, which is the right answer.
  FOR v_entry IN
    SELECT "id" FROM "matchmaking_queue" WHERE "user_id" = v_user AND "status" = 'searching'
  LOOP
    PERFORM public._mm_leave(v_entry, NULL);
  END LOOP;

  SELECT count(*) INTO v_live
    FROM "matches" m
    JOIN "match_participants" p ON p."match_id" = m."id"
    JOIN "challenges" c ON c."id" = m."challenge_id"
   WHERE p."user_id" = v_user
     AND c."status" IN ('matched', 'in_progress', 'needs_review');
  IF v_live > 0 THEN
    RAISE EXCEPTION 'live_bouts';
  END IF;

  DELETE FROM "matchmaking_queue" WHERE "user_id" = v_user;
  DELETE FROM "user_devices" WHERE "user_id" = v_user;
  DELETE FROM "user_settings" WHERE "user_id" = v_user;
  UPDATE "fitness_profiles"
     SET "display_name" = NULL, "username" = NULL, "avatar_url" = NULL, "updated_at" = now()
   WHERE "user_id" = v_user;

  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage') THEN
    DELETE FROM storage.objects
     WHERE bucket_id = 'avatars' AND (storage.foldername(name))[1] = v_user::text;
  END IF;

  DELETE FROM auth.mfa_factors WHERE user_id = v_user;
  DELETE FROM auth.identities WHERE user_id = v_user;
  DELETE FROM auth.refresh_tokens WHERE user_id = v_user::text;
  DELETE FROM auth.sessions WHERE user_id = v_user;
  UPDATE auth.users
     SET email = v_user::text || '@deleted.fittr.invalid',
         phone = NULL,
         raw_user_meta_data = jsonb_build_object('deleted', true),
         banned_until = 'infinity'::timestamptz,
         updated_at = now()
   WHERE id = v_user;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_my_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_my_account() TO authenticated;

-- ----------------------------------------------------------------------------
-- 10. Make PostgREST pick up the new table and functions immediately
-- ----------------------------------------------------------------------------

NOTIFY pgrst, 'reload schema';
