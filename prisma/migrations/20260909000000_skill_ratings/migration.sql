-- ============================================================================
-- Per-exercise skill rating (MMR), derived rank tiers, and MMR-based
-- matchmaking.
--
-- Replaces self-reported `fitness_profiles.strength_tier` as the signal the
-- live queue pairs on. The column and its Bronze/Silver/Gold display stay --
-- it is what a fighter tells us about themselves before they have a record --
-- but nothing in _mm_find_lobby() reads it any more.
--
--   skill_ratings          one row per (user, exercise_type): mmr, matches
--                          played, whether placement is done
--   skill_rating_events    one row per rated participant per settled bout:
--                          the before/after and the K that produced it
--   rank_tier_for()        the ONLY definition of the six tier bands
--   my_skill_ratings       security_invoker view: my ratings + derived tier
--   settle_match()         now writes ratings inside settlement
--   _mm_find_lobby()       pairs on MMR proximity, not on strength_tier
--   matchmaking_queue      snapshots mmr / placement_complete at entry
--
-- Margin of victory is deliberately NOT weighted: a 40-rep win over 39 moves
-- exactly as much as 40 over 5. Documented as a future enhancement in
-- BACKEND.md, not built here.
--
-- ----------------------------------------------------------------------------
-- LOCK ORDER -- read this before touching settle_match() or the queue.
--
-- The 20260908000000 migration fixed one order for every function that can
-- run concurrently:
--
--   lobby `challenges` row -> member `matchmaking_queue` rows
--     -> `fitness_profiles` rows ORDER BY user_id
--
-- `skill_ratings` is appended to the END of that chain: settle_match() takes
-- its rating rows FOR UPDATE ORDER BY user_id only after it has finished with
-- fitness_profiles. Nothing else takes a rating row lock at all --
-- enter_matchmaking() ensures its row with INSERT ... ON CONFLICT DO NOTHING
-- (which never waits on a committed conflicting row) and then reads it
-- unlocked, before it takes the domain advisory lock. So a fighter entering
-- the queue can never block, or be blocked by, a bout settling underneath
-- them. Do not add a FOR UPDATE to that read.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The six tiers, and the bands that produce them
--
-- Six evenly-sized 200-point bands over a nominal 900..1900 range, with the
-- outermost two open-ended because Elo has no ceiling or floor:
--
--   Commoner            mmr <  900
--   Squire              900 .. 1099     <- the 1000 seed sits dead centre
--   Knight             1100 .. 1299
--   Hero               1300 .. 1499
--   Sovereign          1500 .. 1699
--   Ultimate Champion  mmr >= 1700
--
-- The seed is deliberately mid-Squire rather than mid-scale: a fighter with
-- no record should sit low enough that early wins visibly move them, and the
-- band below has to be reachable or Commoner would be a tier nobody is ever
-- in. At K=32 a win over an equal opponent is +16, so ~12 net wins crosses a
-- band -- slow enough to mean something, fast enough to see.
--
-- "Unranked" is NOT a value here. It is the DISPLAY state for a rating whose
-- placement_complete is false, and it lives only in the client (see
-- src/lib/skillRating.ts). Storing it would make the tier a second source of
-- truth about progress that matches_played already owns.
-- ----------------------------------------------------------------------------

CREATE TYPE "RankTier" AS ENUM (
  'commoner',
  'squire',
  'knight',
  'hero',
  'sovereign',
  'ultimate_champion'
);

-- The one definition of the bands. Every other surface -- the view below,
-- BACKEND.md, and the mirrored table in src/lib/skillRating.ts -- follows
-- this function. IMMUTABLE so it can be used in an index later if needed.
CREATE OR REPLACE FUNCTION public.rank_tier_for(p_mmr integer)
RETURNS "RankTier"
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_mmr <  900 THEN 'commoner'
    WHEN p_mmr < 1100 THEN 'squire'
    WHEN p_mmr < 1300 THEN 'knight'
    WHEN p_mmr < 1500 THEN 'hero'
    WHEN p_mmr < 1700 THEN 'sovereign'
    ELSE 'ultimate_champion'
  END::"RankTier"
$$;
GRANT EXECUTE ON FUNCTION public.rank_tier_for(integer) TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. Tunables
--
-- Functions rather than a settings table, matching the _mm_* tunables from
-- 20260908000000: the values stay in version control next to the code that
-- reads them. Mirrored in src/lib/skillRating.ts and src/lib/matchmaking.ts.
-- ----------------------------------------------------------------------------

-- Where a fighter's first rating in an exercise starts.
CREATE OR REPLACE FUNCTION public._mmr_seed() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 1000 $$;

-- Rated bouts in one exercise before that exercise's rating is "placed".
CREATE OR REPLACE FUNCTION public._mmr_placement_bouts() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 5 $$;

-- K while placing (a fast, deliberately volatile search for the right band)
-- and K afterwards (the standard chess-club value).
CREATE OR REPLACE FUNCTION public._mmr_k_placement() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 100 $$;
CREATE OR REPLACE FUNCTION public._mmr_k_settled() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 32 $$;

-- A rating never goes below this. Standard Elo is unbounded downward; from
-- the seed at K=32 this is unreachable in practice, and it exists only so a
-- pathological run of losses cannot produce a negative rating that the tier
-- bands and the UI have no sensible reading for. The clamp is applied AFTER
-- the delta, and skill_rating_events records the effective (clamped) delta,
-- so what the Results screen shows is always the real change.
CREATE OR REPLACE FUNCTION public._mmr_floor() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 100 $$;

-- Two PLACED fighters may share a lobby while their ratings are within this
-- much. Roughly three-quarters of a band: close enough that the bout is a
-- real test, wide enough that a live queue on a small user base still fills.
CREATE OR REPLACE FUNCTION public._mm_mmr_window() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 150 $$;

-- ...widening to this once BOTH the lobby and the fighter have waited
-- _mm_mmr_widen_after(). Two bands apart, and it stops there: it never
-- becomes unbounded, exactly as tier widening never went two tiers. See
-- BACKEND.md, "Known limitations".
CREATE OR REPLACE FUNCTION public._mm_mmr_window_wide() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 400 $$;

-- Same 45 seconds the tier rule used, and symmetric in the same way: both
-- sides must have waited it out. Replaces _mm_tier_widen_after().
CREATE OR REPLACE FUNCTION public._mm_mmr_widen_after() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '45 seconds' $$;

-- ----------------------------------------------------------------------------
-- 3. skill_ratings
--
-- One row per (user, exercise_type). Created on demand -- by
-- enter_matchmaking() when a fighter queues, and by settle_match() for
-- anyone who somehow reaches settlement without one -- never by the client.
-- ----------------------------------------------------------------------------

CREATE TABLE "skill_ratings" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"            UUID NOT NULL,
  "exercise_type"      "ChallengeType" NOT NULL,
  "mmr"                INTEGER NOT NULL DEFAULT 1000,
  "matches_played"     INTEGER NOT NULL DEFAULT 0,
  -- Derived from matches_played, not independent of it: the trigger below
  -- keeps it equal to (matches_played >= _mmr_placement_bouts()). It is
  -- stored rather than computed on read purely so the matchmaking predicate
  -- and the queue snapshot can be plain column reads.
  "placement_complete" BOOLEAN NOT NULL DEFAULT false,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "skill_ratings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "skill_ratings_user_id_fkey" FOREIGN KEY ("user_id")
      REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  CONSTRAINT "skill_ratings_user_exercise_key" UNIQUE ("user_id", "exercise_type"),
  CONSTRAINT "skill_ratings_mmr_nonnegative" CHECK ("mmr" >= 0),
  CONSTRAINT "skill_ratings_matches_played_nonnegative" CHECK ("matches_played" >= 0)
);

CREATE INDEX "skill_ratings_user_id_idx" ON "skill_ratings" ("user_id");

-- placement_complete can never disagree with matches_played, whichever path
-- wrote the row. Cheaper to enforce here than to remember in three places.
CREATE OR REPLACE FUNCTION public._skill_ratings_sync_placement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW."placement_complete" := NEW."matches_played" >= public._mmr_placement_bouts();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "skill_ratings_sync_placement"
  BEFORE INSERT OR UPDATE ON "skill_ratings"
  FOR EACH ROW EXECUTE FUNCTION public._skill_ratings_sync_placement();

ALTER TABLE "skill_ratings" ENABLE ROW LEVEL SECURITY;

-- Own ratings only. An opponent's MMR is not shown anywhere in the app and
-- is not the client's business: matchmaking compares ratings server-side,
-- inside SECURITY DEFINER functions that do not go through this policy.
CREATE POLICY "skill_ratings_select_own" ON "skill_ratings"
  FOR SELECT USING ("user_id" = auth.uid());

REVOKE ALL ON "skill_ratings" FROM anon, authenticated;
GRANT SELECT ON "skill_ratings" TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. skill_rating_events
--
-- The audit trail, and the only place the Results screen can learn what a
-- bout did to a rating. settle_match() writes the current value into
-- skill_ratings and the change into here, in one transaction; the pair is
-- the same shape as fitness_profiles.points_balance + points_ledger_entries,
-- and reconciles the same way (seed + sum(delta) = mmr).
-- ----------------------------------------------------------------------------

CREATE TABLE "skill_rating_events" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"         UUID NOT NULL,
  "match_id"        UUID NOT NULL,
  "exercise_type"   "ChallengeType" NOT NULL,
  "mmr_before"      INTEGER NOT NULL,
  "mmr_after"       INTEGER NOT NULL,
  -- Always mmr_after - mmr_before, i.e. AFTER the _mmr_floor() clamp.
  "delta"           INTEGER NOT NULL,
  "k_factor"        INTEGER NOT NULL,
  -- Was this rating still in placement when the bout started? Drives both
  -- the K above and whether the Results screen shows a number at all.
  "was_placement"   BOOLEAN NOT NULL,
  -- matches_played AFTER this bout. "3 of 5" on the Results screen.
  "matches_played"  INTEGER NOT NULL,
  -- Seats on the bout. 2 for a 1v1; the group divisor is this minus one.
  "participants"    INTEGER NOT NULL,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "skill_rating_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "skill_rating_events_user_id_fkey" FOREIGN KEY ("user_id")
      REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  CONSTRAINT "skill_rating_events_match_id_fkey" FOREIGN KEY ("match_id")
      REFERENCES "matches"("id") ON DELETE CASCADE,
  -- settle_match() is idempotent on settled_at, but this makes a double
  -- rating write impossible even if that guard were ever weakened.
  CONSTRAINT "skill_rating_events_user_match_key" UNIQUE ("user_id", "match_id"),
  CONSTRAINT "skill_rating_events_delta_consistent"
      CHECK ("delta" = "mmr_after" - "mmr_before")
);

CREATE INDEX "skill_rating_events_user_id_idx" ON "skill_rating_events" ("user_id");
CREATE INDEX "skill_rating_events_match_id_idx" ON "skill_rating_events" ("match_id");

ALTER TABLE "skill_rating_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "skill_rating_events_select_own" ON "skill_rating_events"
  FOR SELECT USING ("user_id" = auth.uid());

REVOKE ALL ON "skill_rating_events" FROM anon, authenticated;
GRANT SELECT ON "skill_rating_events" TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. my_skill_ratings
--
-- What the Profile screen reads. security_invoker so the base table's
-- select-own policy is what scopes it -- a plain view would run as its owner
-- and hand every fighter the whole table.
--
-- rank_tier is present for every row, placed or not; "Unranked" is the
-- client's rendering of placement_complete = false, and the tier underneath
-- it is what they WILL be shown when placement ends.
-- ----------------------------------------------------------------------------

CREATE VIEW "my_skill_ratings" WITH (security_invoker = true) AS
  SELECT
    r."user_id",
    r."exercise_type",
    r."mmr",
    r."matches_played",
    r."placement_complete",
    public.rank_tier_for(r."mmr") AS "rank_tier",
    public._mmr_placement_bouts() AS "placement_bouts",
    r."updated_at"
  FROM "skill_ratings" r;

REVOKE ALL ON "my_skill_ratings" FROM anon, authenticated;
GRANT SELECT ON "my_skill_ratings" TO authenticated;

-- ----------------------------------------------------------------------------
-- 6. Ensuring a rating row exists
--
-- ON CONFLICT DO NOTHING rather than a read-then-insert: two callers racing
-- the first bout of an exercise would otherwise both see nothing and both
-- insert. DO NOTHING also never waits on a committed conflicting row, which
-- is what keeps this safe to call before taking the queue's advisory lock
-- (see LOCK ORDER at the top).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._mmr_ensure(p_user_id uuid, p_exercise "ChallengeType")
RETURNS "skill_ratings"
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row "skill_ratings"%ROWTYPE;
BEGIN
  INSERT INTO "skill_ratings" ("user_id", "exercise_type", "mmr")
    VALUES (p_user_id, p_exercise, public._mmr_seed())
    ON CONFLICT ("user_id", "exercise_type") DO NOTHING;
  SELECT * INTO v_row FROM "skill_ratings"
    WHERE "user_id" = p_user_id AND "exercise_type" = p_exercise;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public._mmr_ensure(uuid, "ChallengeType") FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7. The Elo expectation
--
--   E_A = 1 / (1 + 10 ^ ((R_B - R_A) / 400))
--
-- numeric throughout, so the pairwise sums in a six-seat bout are exact
-- until the single round() at the end. The exponent is clamped to +/-10
-- (a 4000-point gap, far beyond anything reachable) because power() on
-- numeric raises rather than saturating, and a rating table corrupted by
-- some future bug must not be able to make settlement itself throw.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._mmr_expected(p_self integer, p_other integer)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 1::numeric / (1::numeric + power(
    10::numeric,
    greatest(-10::numeric, least(10::numeric, (p_other - p_self)::numeric / 400))
  ))
$$;
REVOKE ALL ON FUNCTION public._mmr_expected(integer, integer) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 8. Rating one settled match
--
-- Called from settle_match() only, once, after the anomaly gate has passed
-- and the pot has moved -- a bout that pays nothing rates nothing, and a
-- bout held for review rates nothing until the review clears it and
-- settlement runs to the end.
--
-- THE GROUP RULE. A bout with N seats is decomposed into all N*(N-1)/2
-- pairwise comparisons of the final ranking. For each ordered pair (i, j):
--
--   S_ij = 1 if i outscored j, 0.5 if they tied, 0 if j outscored i
--   raw_i += K_i * (S_ij - E_ij)
--
-- and then every fighter's total is divided by (N - 1) before rounding, so
-- a six-seat bout moves a rating about as far as one 1v1 does rather than
-- five times as far. Every E_ij uses the ratings as they were when the bout
-- STARTED -- the arrays are read once, up front, and never updated inside
-- the loop -- so the result does not depend on the order pairs are visited.
--
-- K is per fighter, not per bout: a fighter in placement moves at K=100
-- against an opponent moving at K=32 in the same bout. This is why MMR is
-- not zero-sum and is not reconciled the way the points ledger is.
--
-- Rounding is round-half-away-from-zero (Postgres numeric round()), applied
-- once to the divided total. Two fighters in a 1v1 with equal K therefore
-- get exactly equal and opposite deltas.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._mmr_rate_match(
  p_match_id uuid,
  p_exercise "ChallengeType",
  p_seats integer
) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_users    uuid[];
  v_scores   integer[];
  v_mmr      integer[];
  v_k        integer[];
  v_played   integer[];
  v_raw      numeric[];
  v_n        integer;
  i          integer;
  j          integer;
  v_s        numeric;
  v_delta    integer;
  v_after    integer;
BEGIN
  -- Everyone gets a rating row before anything is read, so a fighter whose
  -- first ever bout is this one rates from the seed.
  PERFORM public._mmr_ensure(mp."user_id", p_exercise)
    FROM "match_participants" mp
   WHERE mp."match_id" = p_match_id;

  -- Locked in user_id order -- the same order settle_match() locked
  -- fitness_profiles in, immediately above this call. See LOCK ORDER.
  PERFORM 1 FROM "skill_ratings" r
    WHERE r."exercise_type" = p_exercise
      AND r."user_id" IN (SELECT mp."user_id" FROM "match_participants" mp
                           WHERE mp."match_id" = p_match_id)
    ORDER BY r."user_id"
    FOR UPDATE;

  SELECT array_agg(t."user_id" ORDER BY t."user_id"),
         array_agg(t."score"   ORDER BY t."user_id"),
         array_agg(t."mmr"     ORDER BY t."user_id"),
         array_agg(CASE WHEN t."placement_complete"
                        THEN public._mmr_k_settled()
                        ELSE public._mmr_k_placement() END ORDER BY t."user_id"),
         array_agg(t."matches_played" ORDER BY t."user_id")
    INTO v_users, v_scores, v_mmr, v_k, v_played
    FROM (
      SELECT mp."user_id",
             CASE WHEN p_exercise = 'pushups'
                  THEN mp."rep_count" ELSE mp."hold_duration_seconds" END AS "score",
             r."mmr", r."placement_complete", r."matches_played"
        FROM "match_participants" mp
        JOIN "skill_ratings" r
          ON r."user_id" = mp."user_id" AND r."exercise_type" = p_exercise
       WHERE mp."match_id" = p_match_id
    ) t;

  v_n := coalesce(cardinality(v_users), 0);

  -- Defensive: settle_match() has already checked the seat count and that no
  -- score is NULL. A single seat has nobody to be compared against.
  IF v_n < 2 THEN
    RETURN;
  END IF;

  v_raw := array_fill(0::numeric, ARRAY[v_n]);

  FOR i IN 1 .. v_n LOOP
    FOR j IN 1 .. v_n LOOP
      CONTINUE WHEN i = j;
      -- Higher score wins for all three rated exercises (reps, seconds
      -- held). `race`, where lower would win, never reaches settlement.
      v_s := CASE
               WHEN v_scores[i] > v_scores[j] THEN 1::numeric
               WHEN v_scores[i] = v_scores[j] THEN 0.5::numeric
               ELSE 0::numeric
             END;
      v_raw[i] := v_raw[i]
                + v_k[i]::numeric * (v_s - public._mmr_expected(v_mmr[i], v_mmr[j]));
    END LOOP;
  END LOOP;

  FOR i IN 1 .. v_n LOOP
    -- The (N-1) divisor. Every fighter met exactly N-1 opponents, so this is
    -- their average pairwise move, and a 1v1 (N-1 = 1) is untouched by it.
    v_delta := round(v_raw[i] / (v_n - 1))::integer;
    v_after := greatest(public._mmr_floor(), v_mmr[i] + v_delta);
    -- Re-derive the delta from the clamp so the event row always describes
    -- the change that actually happened.
    v_delta := v_after - v_mmr[i];

    UPDATE "skill_ratings"
       SET "mmr" = v_after,
           "matches_played" = "matches_played" + 1,
           "updated_at" = now()
     WHERE "user_id" = v_users[i] AND "exercise_type" = p_exercise;

    INSERT INTO "skill_rating_events"
      ("user_id", "match_id", "exercise_type", "mmr_before", "mmr_after",
       "delta", "k_factor", "was_placement", "matches_played", "participants")
      VALUES (
        v_users[i], p_match_id, p_exercise, v_mmr[i], v_after,
        v_delta, v_k[i],
        v_played[i] < public._mmr_placement_bouts(),
        v_played[i] + 1,
        p_seats
      );
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public._mmr_rate_match(uuid, "ChallengeType", integer) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 9. settle_match(), with rating folded in
--
-- Verbatim from 20260908000000 except for the single _mmr_rate_match() call
-- near the end. It sits AFTER the anomaly gate and AFTER the payout, and
-- before settled_at is stamped, so:
--
--   * a bout that returns needs_review rates nothing, and rates normally on
--     the later call that clears it;
--   * a bout that returns already_settled rates nothing, because it returns
--     before reaching here;
--   * a rating write that fails takes the whole settlement down with it,
--     which is the same bargain submit_verification_session() already makes
--     with settlement itself. A paid-out bout with no rating would be
--     silently wrong and unrecoverable without knowing the pre-bout ratings.
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
  -- race here. It is also what makes the rating write exactly-once.
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
    -- No ledger entry, no balance change, NO RATING CHANGE, and settled_at
    -- stays NULL so a later call (after reviewed = true) can still settle
    -- this match properly -- rating it then, from the ratings as they stand
    -- at that moment rather than as they stood before the review.
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

  -- The rating, from the same scores the pot was just decided on. Every
  -- fighter is rated, not just the winners: an Elo update is a statement
  -- about the whole field.
  PERFORM public._mmr_rate_match(p_match_id, v_challenge.type, v_challenge.max_participants);

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
-- 10. The queue snapshots the rating
--
-- Same reasoning as strength_tier before it: the pairing predicate must not
-- read a value that can move under a search. Unlike strength_tier the client
-- cannot write this one at all, but a bout settling elsewhere can, and a
-- fighter whose rating changed mid-search should not be silently re-banded.
--
-- strength_tier STAYS on the queue row. It is no longer read by any
-- matchmaking predicate; it is kept because it is still the fighter's
-- self-declared level, and because dropping a NOT NULL column the shipping
-- build's realtime payloads carry buys nothing.
-- ----------------------------------------------------------------------------

ALTER TABLE "matchmaking_queue"
  ADD COLUMN "mmr" INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN "placement_complete" BOOLEAN NOT NULL DEFAULT false;

-- Existing live searches (if any) keep the seed defaults, which is the right
-- answer: an unplaced entry matches broadly, so nobody in the queue at
-- deploy time is stranded by a rating they never had.

CREATE INDEX "matchmaking_queue_mmr_idx"
  ON "matchmaking_queue" ("exercise_type", "format", "max_participants", "mmr")
  WHERE "status" = 'searching';

-- ----------------------------------------------------------------------------
-- 11. _mm_find_lobby(), on MMR instead of tier
--
-- THE RULE, in full:
--
--   A lobby fits a fighter when it is in the same domain (exercise, format,
--   seats) at the same stake and has a free seat, AND for every member m
--   currently seated in it:
--
--     * if EITHER m or the arriving fighter is still in placement
--       (placement_complete = false), that pair is compatible, full stop --
--       no rating comparison is made at all;
--     * otherwise abs(m.mmr - fighter.mmr) must be within the window:
--       _mm_mmr_window() (150), or _mm_mmr_window_wide() (400) once BOTH the
--       lobby and the fighter have waited _mm_mmr_widen_after() (45s).
--
-- WHY PLACEMENT MATCHES BROADLY. An unplaced rating is a seed, not a
-- measurement: it says "1000" about someone we have never seen lift. Gating
-- on it would be gating on a number that does not exist yet, and worse, it
-- would herd every new fighter into the same narrow band as every other new
-- fighter regardless of actual ability. So during placement the queue falls
-- back to availability alone -- exercise, format, seats and stake, which are
-- what the fighter explicitly asked for and cannot be wrong about. K=100 is
-- the other half of the trade: five bouts against a wide field move a
-- placing rating far enough to land near the truth, which is what makes the
-- narrow window meaningful once it does apply.
--
-- Note this is deliberately asymmetric-tolerant: ONE unplaced fighter opens
-- the pair up even if the other is placed. A placed Sovereign can therefore
-- be handed an unplaced newcomer. That is the intended direction -- the
-- newcomer needs a hard reference point to place against, and the veteran's
-- rating barely moves for a win they were expected to take.
--
-- The pairwise (rather than lobby-wide) shape of the check is kept from the
-- tier version, and matters more here: without it a six-seat lobby could
-- accumulate a 900 and a 1500 by admitting each of them next to a 1200.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public._mm_find_lobby(
  "ChallengeType", "ChallengeFormat", integer, integer, "StrengthTier", timestamptz, uuid);

CREATE OR REPLACE FUNCTION public._mm_find_lobby(
  p_exercise "ChallengeType", p_format "ChallengeFormat", p_max integer,
  p_stake integer, p_mmr integer, p_placed boolean,
  p_waiting_since timestamptz, p_exclude uuid
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_lobby uuid;
  v_widen boolean := p_waiting_since <= now() - public._mm_mmr_widen_after();
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
            WHERE q."challenge_id" = c."id"
              AND q."status" = 'searching'
              -- Only PLACED-vs-PLACED pairs are rating-gated at all.
              AND q."placement_complete"
              AND p_placed
              AND abs(q."mmr" - p_mmr)
                  > CASE WHEN v_widen AND c."created_at" <= now() - public._mm_mmr_widen_after()
                         THEN public._mm_mmr_window_wide()
                         ELSE public._mm_mmr_window() END)
   ORDER BY c."created_at", c."id"
   LIMIT 1
   FOR UPDATE OF c;
  RETURN v_lobby;
END;
$$;
REVOKE ALL ON FUNCTION public._mm_find_lobby(
  "ChallengeType", "ChallengeFormat", integer, integer, integer, boolean, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;

-- The tier predicate is now unreferenced. Dropped rather than left lying
-- around to be picked up by a future function that thinks it still means
-- something.
DROP FUNCTION IF EXISTS public._mm_tier_rank("StrengthTier");
DROP FUNCTION IF EXISTS public._mm_tier_widen_after();

-- ----------------------------------------------------------------------------
-- 12. enter_matchmaking(): snapshot the rating, pair on it
--
-- Verbatim from 20260908000000 apart from the rating: _mmr_ensure() joins
-- the plain pre-lock reads at the top (see LOCK ORDER for why that is safe
-- there), the snapshot goes onto the queue row, and _mm_find_lobby() is
-- called with it. strength_tier is still snapshotted, and still unread by
-- anything that matches.
-- ----------------------------------------------------------------------------

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
  v_rating "skill_ratings"%ROWTYPE;
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

  -- Plain reads only before the lock (see CONCURRENCY in 20260908000000,
  -- rule 2). The authoritative balance check is the FOR UPDATE one in
  -- _mm_try_complete.
  SELECT "strength_tier", "points_balance" INTO v_tier, v_balance
    FROM "fitness_profiles" WHERE "user_id" = v_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_required';
  END IF;
  IF v_balance < p_stake_points THEN
    RAISE EXCEPTION 'insufficient_points';
  END IF;

  -- The rating for THIS exercise, created at the seed on a fighter's first
  -- ever search in it. Unlocked by design -- see LOCK ORDER at the top.
  v_rating := public._mmr_ensure(v_user, p_exercise_type);

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
    p_exercise_type, p_format, p_max_participants, p_stake_points,
    v_rating."mmr", v_rating."placement_complete", now(), NULL);

  IF v_lobby IS NULL THEN
    INSERT INTO "challenges" ("id", "type", "format", "stake_points", "status", "created_by", "max_participants")
      VALUES (gen_random_uuid(), p_exercise_type, p_format, p_stake_points, 'open', v_user, p_max_participants)
      RETURNING "id" INTO v_lobby;
  END IF;

  INSERT INTO "matchmaking_queue"
    ("user_id", "exercise_type", "format", "max_participants", "stake_points",
     "strength_tier", "mmr", "placement_complete", "challenge_id")
    VALUES (v_user, p_exercise_type, p_format, p_max_participants, p_stake_points,
            v_tier, v_rating."mmr", v_rating."placement_complete", v_lobby)
    RETURNING * INTO v_row;
  INSERT INTO "matchmaking_presence" ("queue_id") VALUES (v_row."id");

  PERFORM public._mm_try_complete(v_lobby);

  SELECT * INTO v_row FROM "matchmaking_queue" WHERE "id" = v_row."id";
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.enter_matchmaking("ChallengeType", "ChallengeFormat", integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enter_matchmaking("ChallengeType", "ChallengeFormat", integer, integer) TO authenticated;

-- ----------------------------------------------------------------------------
-- 13. matchmaking_heartbeat(): widening is now an MMR window, not a tier step
--
-- Verbatim from 20260908000000 apart from the two tunable names and the
-- _mm_find_lobby() argument list, which now carries the row's rating
-- snapshot. The "only a fighter who is alone may move" rule is unchanged:
-- moving a member out of a part-filled lobby would break it up for everyone
-- else in it.
-- ----------------------------------------------------------------------------

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

  v_can_widen := v_row."joined_at" <= now() - public._mm_mmr_widen_after();

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

    -- A move can only ever succeed through widening (a lobby inside the
    -- narrow window that appeared later would have joined ours instead), and
    -- only a fighter who is alone can move without breaking up a lobby.
    IF v_can_widen THEN
      SELECT count(*) = 1 INTO v_alone
        FROM "matchmaking_queue"
       WHERE "challenge_id" = v_row."challenge_id" AND "status" = 'searching';
      IF v_alone THEN
        v_lobby := public._mm_find_lobby(
          v_row."exercise_type", v_row."format", v_row."max_participants",
          v_row."stake_points", v_row."mmr", v_row."placement_complete",
          v_row."joined_at", v_row."challenge_id");
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

-- ----------------------------------------------------------------------------
-- 14. Account deletion
--
-- skill_ratings and skill_rating_events both cascade from auth.users, and
-- delete_my_account() does not delete the auth row (it anonymises and bans
-- it), so ratings survive deletion exactly the way match history and the
-- points ledger do. Nothing to change there -- noted so the omission reads
-- as a decision rather than an oversight.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 15. Make PostgREST pick up the new tables, view and functions immediately
-- ----------------------------------------------------------------------------

NOTIFY pgrst, 'reload schema';
