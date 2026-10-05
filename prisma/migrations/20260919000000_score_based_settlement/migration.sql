-- ============================================================================
-- Score-based settlement, the Blitz payout curve, and the featured pooled
-- competition.
--
-- Until now every contest was decided on a RAW number: the rep count, or the
-- seconds held. From this migration on it is decided on a SCORE:
--
--   score = round(valid_raw * form_quality_bp / 100)
--
-- where valid_raw is the rep count (or hold seconds) that already cleared
-- the existing validity bar -- the 0.6 / 0.3 hysteresis the SDK's rep
-- counter and src/lib/holdTracker.ts both apply, so a half-rep or a
-- jittery hold is not in it -- and form_quality_bp is the average pose
-- probability across THE VALID PORTION of the session, in basis points
-- (10000 = every valid rep hit probability 1.0). So 30 reps at 85% form
-- score 2550, and 26 reps at 100% form score 2600 and beat them.
--
-- The raw number is kept. match_participants.rep_count /
-- hold_duration_seconds and verification_sessions.raw_metrics are exactly
-- what they were; the norms-based MMR placement seed still reads the raw
-- count (the reference tables are in reps and seconds, not in scores), and
-- the Results screen still prints "34 reps". What changes is the column
-- every comparison reads.
--
-- WHO COMPUTES WHAT. The client is the only place per-frame probabilities
-- exist, so it reports form_quality_bp alongside the raw count. The
-- SERVER turns the two into the score, inside submit_verification_session,
-- and writes it in two places:
--
--   verification_sessions.form_quality_bp / .score   the record
--   match_participants.score                          the read model
--
-- The second copy exists because verification_sessions is select-own (its
-- raw_metrics are one fighter's telemetry) while every screen that draws a
-- tale of the tape reads the whole field off match_participants, which
-- participants can already read for each other. Same value, written in the
-- same statement, never updated afterwards.
--
-- THE TRUST BOUNDARY IS UNCHANGED. The rep count was already self-reported
-- from the device; form quality is too. This migration does not make a
-- score any more verifiable than a count was -- see BACKEND.md, "Camera
-- verification -- what it does and doesn't prove".
--
-- ----------------------------------------------------------------------------
-- THRESHOLDS: STILL CALIBRATED IN RAW UNITS, THEN CONVERTED
--
-- performance_norms is in reps and seconds. A rating still maps to a raw
-- target through _solo_target_for_rating() exactly as before; the target
-- is then converted to a score at a REFERENCE form quality:
--
--   threshold_score = round(raw_target * _score_reference_quality_bp() / 100)
--
-- _score_reference_quality_bp() is 8500. It says: a fighter at this rating
-- is expected to clear the calibrated rep count at 85% form. Better form
-- means fewer reps clear the bar; sloppier form means more are needed.
--
-- (!) 85% IS A PLACEHOLDER UNTIL REAL SESSIONS SAY OTHERWISE. Nobody has
-- yet measured what QuickPose's fitness.* probability averages over a
-- real, honest set. If real form quality clusters at 92%, every threshold
-- in Blitz and Streak is ~8% easier than its rating implies; at 78%, ~8%
-- harder. It is a single tunable function precisely so it can be moved the
-- moment there is data. A submission that carries NO form-quality reading
-- (an older client, or a test helper) is scored at this same reference, so
-- "no reading" means "the expected form", never "perfect form".
--
-- ----------------------------------------------------------------------------
-- BLITZ: ONE THRESHOLD AND A CURVE, NOT THREE TIERS
--
-- Blitz had three calibrated bars paying 1.5x / 2x / 2.5x. It now has:
--
--   threshold_score   the score at the fighter's OWN rating (offset 0)
--   benchmark_score   the score at rating + _solo_blitz_benchmark_offset()
--                     (+320, the old top tier's offset)
--
-- and the payout multiplier, in basis points of the stake, is
--
--   score <  threshold           ->  0          (stake lost)
--   score =  threshold           ->  10000      (break even: stake returned)
--   threshold < score < benchmark -> 10000 + 15000 * (score - threshold)
--                                                  / (benchmark - threshold)
--                                    truncated to an integer
--   score >= benchmark           ->  25000      (the 2.5x cap)
--
-- i.e. LINEAR from break-even at the threshold to 2.5x at the benchmark,
-- capped there. Clearing the threshold is the win for rating purposes
-- (one Elo update against a virtual opponent at threshold_rating, exactly
-- as tier 1 was); the margin above it only moves the payout, never the
-- rating, so Blitz still does not weight margin of victory anywhere the
-- rest of the rating system does not.
--
-- Expected value, on the same Elo model the old tiers were graded on
-- (P(clear) at offsets 0 / +150 / +320 = 0.500 / 0.297 / 0.137, with the
-- curve taken as linear in rating space between them):
--
--   below threshold          p = 0.500   pays 0
--   threshold .. +150        p = 0.203   pays ~1.0x .. ~1.7x, mean ~1.35x
--   +150 .. +320             p = 0.160   pays ~1.7x .. 2.5x,  mean ~2.1x
--   at or past the benchmark p = 0.137   pays 2.5x
--   EV per stake  ~ 0.203*1.35 + 0.160*2.10 + 0.137*2.5  ~ 0.95
--
-- Just under parity, as before (the tiers were ~0.97). (!) The curve is
-- linear in SCORE, and score-vs-rating is not linear -- the norms
-- percentile curve is logistic in rating and piecewise-linear in raw
-- terms -- so the true EV depends on where on that curve a fighter sits.
-- The estimate above is a model of a model; see BACKEND.md for what is
-- and is not verified.
--
-- ----------------------------------------------------------------------------
-- POOLED: ONE FEATURED COMPETITION, PLAY ON ENTRY, TOP THREE PAID
--
-- The queue-based Group Battle (3-6 seats, 20-second heartbeats) is left
-- in place server-side but is no longer what "pooled" means on the Compete
-- screen. The featured pooled competition is:
--
--   * ONE open pooled_competitions row at a time. pooled_featured() returns
--     it, opening the next one (rotating push-ups -> plank -> wall-sit) the
--     first time nobody is in it.
--   * Its Challenge + Match exist from the moment it opens, with
--     max_participants = _pool_max_entries(). Entering (pooled_enter())
--     adds a match_participants row and debits _pool_entry_fee() -- the
--     stake IS the entry fee -- and the fighter plays their round right
--     then, through the ordinary camera screen. There is no lobby, no
--     heartbeat, and no "everyone shows up at once": a fighter's round is
--     played when they enter, and their score waits on the board.
--   * The competition FILLS when the last seat is taken. It SETTLES when
--     the last entrant's score lands -- the same settle_match() the 1v1
--     path runs, inline in submit_verification_session -- ranking every
--     entrant by score and paying _pool_prize_shares_bp() = 50% / 30% /
--     20% of the pot to first, second and third. Everyone else gets
--     nothing. Ties share: fighters on the same score occupy consecutive
--     places and split the sum of those places' prizes evenly, remainder to
--     the lowest user_id (the same remainder rule the old group split had).
--   * It is casual (is_ranked = false): a shared competition cannot be
--     half-rated, and the ranked/casual switch is per attempt. Trophies
--     still move, for first place only, as they do for any other bout.
--
-- Known limitations, deliberately not solved here and written up in
-- BACKEND.md: an entrant who never plays their round strands the pot (no
-- forfeit rule exists anywhere in this schema), the competition has no
-- time-box (it lives until it fills), and joining it blocks
-- delete_my_account() until it settles, the way any unsettled bout does.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The score columns
-- ----------------------------------------------------------------------------

ALTER TABLE "verification_sessions"
  ADD COLUMN "form_quality_bp" INTEGER,
  ADD COLUMN "score" INTEGER;

ALTER TABLE "verification_sessions"
  ADD CONSTRAINT "verification_sessions_form_quality_range"
    CHECK ("form_quality_bp" IS NULL OR "form_quality_bp" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "verification_sessions_score_nonnegative"
    CHECK ("score" IS NULL OR "score" >= 0);

COMMENT ON COLUMN "verification_sessions"."form_quality_bp" IS
  'Mean pose probability across the valid portion of the session, in basis points (0..10000). Client-reported.';
COMMENT ON COLUMN "verification_sessions"."score" IS
  'round(valid_raw * form_quality_bp / 100). What every contest is decided on since 20260919000000.';

-- "place", not "placing": PLACING is a reserved word in Postgres (OVERLAY ...
-- PLACING ...), and a column that has to be quoted in every ad-hoc query is
-- a trap for whoever inspects the live database next.
ALTER TABLE "match_participants"
  ADD COLUMN "score" INTEGER,
  ADD COLUMN "place" INTEGER;

ALTER TABLE "match_participants"
  ADD CONSTRAINT "match_participants_score_nonnegative"
    CHECK ("score" IS NULL OR "score" >= 0),
  ADD CONSTRAINT "match_participants_place_positive"
    CHECK ("place" IS NULL OR "place" >= 1);

COMMENT ON COLUMN "match_participants"."score" IS
  'Copy of verification_sessions.score, written in the same statement, so the whole field can read it.';
COMMENT ON COLUMN "match_participants"."place" IS
  'Finishing position by score at settlement, ties sharing the best place (1,1,3). NULL until settled.';

-- ----------------------------------------------------------------------------
-- 2. Tunables
-- ----------------------------------------------------------------------------

-- The form quality a calibrated raw target is converted to a score at, and
-- the quality a submission with no reading is scored at. See the header.
CREATE OR REPLACE FUNCTION public._score_reference_quality_bp() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 8500 $$;

-- THE SCORE. Integer in, integer out; numeric in between so 30 * 8537 / 100
-- rounds to 2561 rather than truncating twice on the way.
CREATE OR REPLACE FUNCTION public._score_for(p_raw integer, p_quality_bp integer)
RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_raw IS NULL OR p_quality_bp IS NULL THEN NULL
    ELSE round(p_raw::numeric * p_quality_bp / 100)::integer
  END
$$;

-- A raw target, as the score a fighter at the reference form quality would
-- put up for it. Strictly increasing in p_raw (each rep is worth
-- reference/100 points), which is what keeps a nudged ladder ascending
-- after conversion.
CREATE OR REPLACE FUNCTION public._score_at_reference(p_raw integer) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT public._score_for(p_raw, public._score_reference_quality_bp())
$$;

-- Blitz. Break-even at the threshold, the cap at the benchmark.
CREATE OR REPLACE FUNCTION public._blitz_breakeven_bp() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 10000 $$;

CREATE OR REPLACE FUNCTION public._blitz_max_bp() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 25000 $$;

-- The rating offset of the benchmark above the fighter's own rating. +320
-- is the old top tier's offset: E(clear) = 0.137, a once-in-seven event
-- for a fighter at their rating.
CREATE OR REPLACE FUNCTION public._solo_blitz_benchmark_offset() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 320 $$;

-- THE CURVE. Basis points of the stake for a score against a threshold and
-- a benchmark. Integer division truncates, so a payout is never rounded UP
-- into points nobody staked -- the same rule every payout here follows.
CREATE OR REPLACE FUNCTION public._blitz_multiplier_bp(
  p_score integer, p_threshold integer, p_benchmark integer
) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_score IS NULL OR p_threshold IS NULL OR p_score < p_threshold THEN 0
    WHEN p_benchmark IS NULL OR p_benchmark <= p_threshold OR p_score >= p_benchmark
      THEN public._blitz_max_bp()
    ELSE public._blitz_breakeven_bp()
       + ((public._blitz_max_bp() - public._blitz_breakeven_bp())::bigint
          * (p_score - p_threshold) / (p_benchmark - p_threshold))::integer
  END
$$;

-- The featured pooled competition. One of the four offered stakes, so the
-- shared guard (_solo_start_guard) accepts it and a points balance keeps
-- meaning one thing across every mode.
CREATE OR REPLACE FUNCTION public._pool_entry_fee() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 100 $$;

-- Seats. Six is the old Group Battle maximum; on a pilot-sized user base
-- this is the number most worth revisiting, and it is one function.
CREATE OR REPLACE FUNCTION public._pool_max_entries() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 6 $$;

-- 50 / 30 / 20 of the pot to first, second, third. Sums to 10000.
CREATE OR REPLACE FUNCTION public._pool_prize_shares_bp() RETURNS integer[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[5000, 3000, 2000] $$;

-- The old three-tier Blitz tunables and ladder. Nothing reads them once the
-- functions in section 7 replace theirs; dropped so nothing can start to.
DROP FUNCTION IF EXISTS public._blitz_ladder("ChallengeType", integer, "Gender", "AgeBand");
DROP FUNCTION IF EXISTS public.blitz_preview("ChallengeType");
DROP FUNCTION IF EXISTS public.blitz_start("ChallengeType", integer, boolean);
DROP TYPE IF EXISTS public.blitz_preview_row;
DROP FUNCTION IF EXISTS public._solo_blitz_tier_offsets();
DROP FUNCTION IF EXISTS public._solo_blitz_tier_bp();

-- ----------------------------------------------------------------------------
-- 3. Backfill
--
-- Every recorded result gets a score at the reference quality, so a bout
-- fought last week and one fought tomorrow read off the same column. This
-- does NOT re-settle anything: settled_at, winner_id and every ledger row
-- stay exactly as they are. place is derived from the backfilled scores
-- for bouts already settled, which for a bout decided on raw counts at a
-- flat reference quality is the same ordering.
-- ----------------------------------------------------------------------------

UPDATE "match_participants" mp
   SET "score" = public._score_at_reference(
         CASE WHEN c."type" = 'pushups' THEN mp."rep_count"
              WHEN c."type" IN ('plank', 'wallsit') THEN mp."hold_duration_seconds"
              ELSE NULL END)
  FROM "matches" m
  JOIN "challenges" c ON c."id" = m."challenge_id"
 WHERE m."id" = mp."match_id"
   AND mp."score" IS NULL
   AND (mp."rep_count" IS NOT NULL OR mp."hold_duration_seconds" IS NOT NULL);

UPDATE "verification_sessions" vs
   SET "form_quality_bp" = public._score_reference_quality_bp(),
       "score" = mp."score"
  FROM "match_participants" mp
 WHERE mp."id" = vs."match_participant_id"
   AND vs."score" IS NULL
   AND mp."score" IS NOT NULL;

WITH ranked AS (
  SELECT mp."id",
         rank() OVER (PARTITION BY mp."match_id" ORDER BY mp."score" DESC) AS "r"
    FROM "match_participants" mp
    JOIN "matches" m ON m."id" = mp."match_id"
   WHERE m."settled_at" IS NOT NULL
     AND mp."score" IS NOT NULL
)
UPDATE "match_participants" mp
   SET "place" = ranked."r"
  FROM ranked
 WHERE ranked."id" = mp."id"
   AND mp."place" IS NULL;

-- ----------------------------------------------------------------------------
-- 4. submit_verification_session(): now takes the form quality
--
-- The old five-argument signature is DROPPED rather than left beside the
-- new one -- the rule every signature change in this project has followed
-- since 20260903300000: two overloads reachable over PostgREST is an
-- ambiguity waiting for a caller that omits the argument. The DEFAULT NULL
-- is what lets a caller that predates form quality still submit; NULL is
-- scored at the reference quality, per the header.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.submit_verification_session(uuid, integer, jsonb, boolean, integer);

CREATE OR REPLACE FUNCTION public.submit_verification_session(
  p_match_participant_id uuid,
  p_rep_count integer,
  p_raw_metrics jsonb,
  p_anomaly_flag boolean,
  p_hold_duration_seconds integer DEFAULT NULL,
  p_form_quality_bp integer DEFAULT NULL
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
  v_quality integer := coalesce(p_form_quality_bp, public._score_reference_quality_bp());
  v_raw integer;
  v_score integer;
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

  IF v_quality < 0 OR v_quality > 10000 THEN
    RAISE EXCEPTION 'form_quality_invalid';
  END IF;

  SELECT c.type INTO v_challenge_type
    FROM "matches" m
    JOIN "challenges" c ON c.id = m.challenge_id
    WHERE m.id = v_participant.match_id;

  -- Each type accepts exactly one raw measure and rejects the other outright.
  -- A rep count on a plank (or vice versa) means the client ran the wrong
  -- pose model, which must not be recorded as a valid result.
  IF v_challenge_type = 'pushups' THEN
    IF p_rep_count IS NULL OR p_rep_count < 0 THEN
      RAISE EXCEPTION 'rep count must be zero or greater for a pushups challenge';
    END IF;
    IF p_hold_duration_seconds IS NOT NULL THEN
      RAISE EXCEPTION 'hold duration is not a valid result for a pushups challenge';
    END IF;
    v_raw := p_rep_count;
  ELSIF v_challenge_type IN ('plank', 'wallsit') THEN
    IF p_hold_duration_seconds IS NULL OR p_hold_duration_seconds < 0 THEN
      RAISE EXCEPTION 'hold duration must be zero or greater for a % challenge', v_challenge_type;
    END IF;
    IF p_rep_count IS NOT NULL THEN
      RAISE EXCEPTION 'rep count is not a valid result for a % challenge', v_challenge_type;
    END IF;
    v_raw := p_hold_duration_seconds;
  ELSE
    RAISE EXCEPTION 'camera verification is not implemented for % yet', v_challenge_type;
  END IF;

  v_score := public._score_for(v_raw, v_quality);

  INSERT INTO "verification_sessions"
    ("id", "match_participant_id", "raw_metrics", "anomaly_flag", "reviewed",
     "form_quality_bp", "score")
    VALUES (gen_random_uuid(), p_match_participant_id, p_raw_metrics,
            COALESCE(p_anomaly_flag, false), false, v_quality, v_score)
    RETURNING id INTO v_session_id;

  UPDATE "match_participants"
    SET rep_count = p_rep_count,
        hold_duration_seconds = p_hold_duration_seconds,
        score = v_score
    WHERE id = p_match_participant_id;

  -- Settle inline, in this same transaction, the moment the last result
  -- lands. Deliberately not left to the client: a client that submits and then
  -- dies (or a modified build that simply never calls settle_match) would
  -- otherwise strand the match unsettled forever. Returns 'not_ready'
  -- harmlessly for anyone but the last submitter.
  --
  -- Letting a settlement failure roll this INSERT back is intentional. Every
  -- RAISE inside settle_match is a real inconsistency, and recording a result
  -- that provably cannot be settled is worse than rejecting the submission.
  PERFORM public.settle_match(v_participant.match_id);

  RETURN v_session_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_verification_session(uuid, integer, jsonb, boolean, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_verification_session(uuid, integer, jsonb, boolean, integer, integer)
  TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. The featured pooled competition
-- ----------------------------------------------------------------------------

-- Seats: a queue-formed Group Battle is 3..6 and a solo bout is 1, as
-- before; a pooled competition may seat up to 32. The lower bound for
-- 'pooled' is 2 rather than 3 only because bouts predating 20260908000000
-- were backfilled to two seats whatever their format said, and a CHECK that
-- fails to apply is a migration that fails to apply.
ALTER TABLE "challenges"
  DROP CONSTRAINT IF EXISTS "challenges_max_participants_range";

ALTER TABLE "challenges"
  ADD CONSTRAINT "challenges_max_participants_range" CHECK (
    ("format" = 'pooled' AND "max_participants" BETWEEN 2 AND 32)
    OR ("format" <> 'pooled' AND "max_participants" BETWEEN 1 AND 6)
  );

CREATE TABLE "pooled_competitions" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "exercise_type" "ChallengeType" NOT NULL,
  "title"         TEXT NOT NULL,
  "description"   TEXT NOT NULL,
  -- The stake, as challenges.stake_points also records it.
  "entry_fee"     INTEGER NOT NULL,
  -- Seats, as challenges.max_participants also records it.
  "max_entries"   INTEGER NOT NULL,
  -- Both exist from the moment the competition opens: a competition IS a
  -- pooled match that fills one entrant at a time.
  "challenge_id"  UUID NOT NULL,
  "match_id"      UUID NOT NULL,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The last seat was taken. Set by pooled_enter(); from here on the next
  -- competition is the featured one, and this one settles when its last
  -- score lands.
  "filled_at"     TIMESTAMPTZ,
  -- Mirrors matches.settled_at, set by settle_match().
  "settled_at"    TIMESTAMPTZ,

  CONSTRAINT "pooled_competitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pooled_competitions_challenge_id_key" UNIQUE ("challenge_id"),
  CONSTRAINT "pooled_competitions_match_id_key" UNIQUE ("match_id"),
  CONSTRAINT "pooled_competitions_challenge_id_fkey" FOREIGN KEY ("challenge_id")
      REFERENCES "challenges"("id") ON DELETE CASCADE,
  CONSTRAINT "pooled_competitions_match_id_fkey" FOREIGN KEY ("match_id")
      REFERENCES "matches"("id") ON DELETE CASCADE,
  CONSTRAINT "pooled_competitions_fee_positive" CHECK ("entry_fee" > 0),
  CONSTRAINT "pooled_competitions_seats_range" CHECK ("max_entries" BETWEEN 3 AND 32),
  CONSTRAINT "pooled_competitions_settled_after_filled"
    CHECK ("settled_at" IS NULL OR "filled_at" IS NOT NULL)
);

CREATE INDEX "pooled_competitions_open_idx"
  ON "pooled_competitions" ("created_at", "id")
  WHERE "filled_at" IS NULL;

-- Readable by any signed-in fighter: the title, the pot and the seat count
-- are the card on the Compete screen, and there is nothing private on the
-- row. Written only by the functions below.
ALTER TABLE "pooled_competitions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pooled_competitions_select_authenticated" ON "pooled_competitions"
  FOR SELECT USING (auth.role() = 'authenticated');

REVOKE ALL ON "pooled_competitions" FROM anon, authenticated;
GRANT SELECT ON "pooled_competitions" TO authenticated;

-- What the Compete screen and the Pooled screen draw. One composite so the
-- card and the detail screen can never disagree about the same competition.
CREATE TYPE public.pooled_featured_row AS (
  "id"               UUID,
  "exercise_type"    "ChallengeType",
  "title"            TEXT,
  "description"      TEXT,
  "entry_fee"        INTEGER,
  "max_entries"      INTEGER,
  -- Seats taken so far, including the caller's.
  "entries"          INTEGER,
  -- entry_fee * entries: what is in the pot right now.
  "pool_points"      INTEGER,
  -- entry_fee * max_entries: what the pot is when it fills.
  "max_pool_points"  INTEGER,
  "match_id"         UUID,
  -- Whether the caller holds a seat, and whether they have played it.
  "entered"          BOOLEAN,
  "played"           BOOLEAN,
  "filled_at"        TIMESTAMPTZ,
  "settled_at"       TIMESTAMPTZ,
  "created_at"       TIMESTAMPTZ,
  "prize_shares_bp"  INTEGER[],
  "server_now"       TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION public._pool_view(p_user uuid, p_id uuid)
RETURNS public.pooled_featured_row
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_comp "pooled_competitions"%ROWTYPE;
  v_out  public.pooled_featured_row;
  v_mine "match_participants"%ROWTYPE;
BEGIN
  SELECT * INTO v_comp FROM "pooled_competitions" WHERE "id" = p_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_out."id"              := v_comp."id";
  v_out."exercise_type"   := v_comp."exercise_type";
  v_out."title"           := v_comp."title";
  v_out."description"     := v_comp."description";
  v_out."entry_fee"       := v_comp."entry_fee";
  v_out."max_entries"     := v_comp."max_entries";
  v_out."match_id"        := v_comp."match_id";
  v_out."filled_at"       := v_comp."filled_at";
  v_out."settled_at"      := v_comp."settled_at";
  v_out."created_at"      := v_comp."created_at";
  v_out."prize_shares_bp" := public._pool_prize_shares_bp();
  v_out."server_now"      := now();

  SELECT count(*)::integer INTO v_out."entries"
    FROM "match_participants" mp WHERE mp."match_id" = v_comp."match_id";
  v_out."pool_points"     := v_comp."entry_fee" * v_out."entries";
  v_out."max_pool_points" := v_comp."entry_fee" * v_comp."max_entries";

  SELECT * INTO v_mine FROM "match_participants" mp
   WHERE mp."match_id" = v_comp."match_id" AND mp."user_id" = p_user;
  v_out."entered" := FOUND;
  v_out."played"  := FOUND AND EXISTS (
    SELECT 1 FROM "verification_sessions" vs WHERE vs."match_participant_id" = v_mine."id");

  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public._pool_view(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Open the next competition. The exercise rotates through the three the
-- camera verifies, in order, so every exercise gets its turn regardless of
-- how quickly any one of them fills. created_by is the caller who happened
-- to look first: challenges.created_by is NOT NULL and references
-- auth.users, and a competition has no other author.
CREATE OR REPLACE FUNCTION public._pool_open(p_user uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_n         integer;
  v_exercise  "ChallengeType";
  v_title     text;
  v_desc      text;
  v_challenge uuid;
  v_match     uuid;
  v_id        uuid;
BEGIN
  SELECT count(*)::integer INTO v_n FROM "pooled_competitions";
  v_exercise := (ARRAY['pushups', 'plank', 'wallsit']::"ChallengeType"[])[1 + (v_n % 3)];
  v_title := CASE v_exercise
    WHEN 'pushups' THEN 'Pooled Push-ups'
    WHEN 'plank'   THEN 'Pooled Plank'
    ELSE                'Pooled Wall-sit' END;
  v_desc := CASE v_exercise
    WHEN 'pushups' THEN 'One max set of push-ups. Enter, play your round on the spot, and your score sits on the board until the last seat fills. Top three split the pot.'
    WHEN 'plank'   THEN 'One max plank hold. Enter, play your round on the spot, and your score sits on the board until the last seat fills. Top three split the pot.'
    ELSE                'One max wall-sit hold. Enter, play your round on the spot, and your score sits on the board until the last seat fills. Top three split the pot.' END;

  INSERT INTO "challenges"
    ("id", "type", "format", "stake_points", "max_participants", "status",
     "created_by", "is_ranked")
    VALUES (gen_random_uuid(), v_exercise, 'pooled', public._pool_entry_fee(),
            public._pool_max_entries(), 'matched', p_user, false)
    RETURNING "id" INTO v_challenge;

  INSERT INTO "matches" ("id", "challenge_id")
    VALUES (gen_random_uuid(), v_challenge)
    RETURNING "id" INTO v_match;

  INSERT INTO "pooled_competitions"
    ("exercise_type", "title", "description", "entry_fee", "max_entries",
     "challenge_id", "match_id")
    VALUES (v_exercise, v_title, v_desc, public._pool_entry_fee(),
            public._pool_max_entries(), v_challenge, v_match)
    RETURNING "id" INTO v_id;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public._pool_open(uuid) FROM PUBLIC, anon, authenticated;

-- The competition on the card: the oldest one with a seat left, opened on
-- demand. A plain read on the common path; the advisory lock is taken only
-- when there is nothing open, so two fighters looking at an empty card in
-- the same instant open one competition rather than two.
CREATE OR REPLACE FUNCTION public.pooled_featured()
RETURNS public.pooled_featured_row
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_id   uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;

  SELECT "id" INTO v_id FROM "pooled_competitions"
   WHERE "filled_at" IS NULL
   ORDER BY "created_at", "id"
   LIMIT 1;

  IF NOT FOUND THEN
    PERFORM pg_advisory_xact_lock(hashtext('pooled:featured'));
    SELECT "id" INTO v_id FROM "pooled_competitions"
     WHERE "filled_at" IS NULL
     ORDER BY "created_at", "id"
     LIMIT 1;
    IF NOT FOUND THEN
      v_id := public._pool_open(v_user);
    END IF;
  END IF;

  RETURN public._pool_view(v_user, v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.pooled_featured() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pooled_featured() TO authenticated;

-- Take a seat and pay the fee. Returns the competition as it stands, with
-- match_id: the client pushes the camera with it, because the round is
-- played now.
--
-- Lock order: the competition row, then the caller's fitness_profiles row.
-- settle_match() touches pooled_competitions only after every other lock
-- it takes and only for a FILLED competition, which this function never
-- holds, so the two cannot meet.
CREATE OR REPLACE FUNCTION public.pooled_enter()
RETURNS public.pooled_featured_row
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_comp    "pooled_competitions"%ROWTYPE;
  v_n       integer;
  v_balance integer;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;

  SELECT * INTO v_comp FROM "pooled_competitions"
   WHERE "filled_at" IS NULL
   ORDER BY "created_at", "id"
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pool_not_open';
  END IF;

  -- Profile, offered stake, and the shared open-round rule: a staked round
  -- you have not played blocks starting any other, this one included.
  PERFORM public._solo_start_guard(v_user, v_comp."exercise_type", v_comp."entry_fee");

  IF EXISTS (
    SELECT 1 FROM "match_participants" mp
     WHERE mp."match_id" = v_comp."match_id" AND mp."user_id" = v_user
  ) THEN
    RAISE EXCEPTION 'pool_already_entered';
  END IF;

  SELECT count(*)::integer INTO v_n
    FROM "match_participants" mp WHERE mp."match_id" = v_comp."match_id";
  IF v_n >= v_comp."max_entries" THEN
    RAISE EXCEPTION 'pool_full';
  END IF;

  SELECT "points_balance" INTO v_balance
    FROM "fitness_profiles" WHERE "user_id" = v_user FOR UPDATE;
  IF v_balance < v_comp."entry_fee" THEN
    RAISE EXCEPTION 'insufficient_points';
  END IF;

  INSERT INTO "match_participants" ("id", "match_id", "user_id")
    VALUES (gen_random_uuid(), v_comp."match_id", v_user);

  UPDATE "fitness_profiles"
     SET "points_balance" = "points_balance" - v_comp."entry_fee"
   WHERE "user_id" = v_user;
  INSERT INTO "points_ledger_entries" ("id", "user_id", "amount", "reason", "match_id")
    VALUES (gen_random_uuid(), v_user, -v_comp."entry_fee", 'stake', v_comp."match_id");

  IF v_n + 1 >= v_comp."max_entries" THEN
    UPDATE "pooled_competitions" SET "filled_at" = now() WHERE "id" = v_comp."id";
  END IF;

  RETURN public._pool_view(v_user, v_comp."id");
END;
$$;
REVOKE ALL ON FUNCTION public.pooled_enter() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pooled_enter() TO authenticated;

-- ----------------------------------------------------------------------------
-- 6. _mmr_rate_match(): pairwise on score, seeded on raw
--
-- Verbatim from 20260910000000 apart from the two things the header says:
-- S_ij is decided by match_participants.score, so the rating agrees with
-- the money about who beat whom; the first-bout norms seed still reads the
-- raw count, because performance_norms is in reps and seconds.
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
  v_users        uuid[];
  v_scores       integer[];
  v_raws         integer[];
  v_mmr          integer[];
  v_k            integer[];
  v_played       integer[];
  v_gender       "Gender"[];
  v_age_band     "AgeBand"[];
  v_norms_seeded boolean[];
  v_raw          numeric[];
  v_n            integer;
  i              integer;
  j              integer;
  v_s            numeric;
  v_delta        integer;
  v_after        integer;
  v_norm_mmr     integer;
BEGIN
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
         array_agg(t."raw"     ORDER BY t."user_id"),
         array_agg(t."mmr"     ORDER BY t."user_id"),
         array_agg(CASE WHEN t."placement_complete"
                        THEN public._mmr_k_settled()
                        ELSE public._mmr_k_placement() END ORDER BY t."user_id"),
         array_agg(t."matches_played" ORDER BY t."user_id"),
         array_agg(t."gender" ORDER BY t."user_id"),
         array_agg(t."age_band" ORDER BY t."user_id")
    INTO v_users, v_scores, v_raws, v_mmr, v_k, v_played, v_gender, v_age_band
    FROM (
      SELECT mp."user_id",
             mp."score",
             CASE WHEN p_exercise = 'pushups'
                  THEN mp."rep_count" ELSE mp."hold_duration_seconds" END AS "raw",
             r."mmr", r."placement_complete", r."matches_played",
             fp."gender", fp."age_band"
        FROM "match_participants" mp
        JOIN "skill_ratings" r
          ON r."user_id" = mp."user_id" AND r."exercise_type" = p_exercise
        JOIN "fitness_profiles" fp
          ON fp."user_id" = mp."user_id"
       WHERE mp."match_id" = p_match_id
    ) t;

  v_n := coalesce(cardinality(v_users), 0);
  IF v_n < 2 THEN
    RETURN;
  END IF;

  -- Norms-based seed, first rated bout only, from the RAW count.
  v_norms_seeded := array_fill(false, ARRAY[v_n]);
  FOR i IN 1 .. v_n LOOP
    IF v_played[i] = 0 AND v_gender[i] IS NOT NULL AND v_age_band[i] IS NOT NULL
       AND v_raws[i] IS NOT NULL THEN
      v_norm_mmr := public._mmr_seed_from_norms(p_exercise, v_gender[i], v_age_band[i], v_raws[i]);
      IF v_norm_mmr IS NOT NULL THEN
        v_mmr[i] := v_norm_mmr;
        v_norms_seeded[i] := true;
      END IF;
    END IF;
  END LOOP;

  v_raw := array_fill(0::numeric, ARRAY[v_n]);

  FOR i IN 1 .. v_n LOOP
    FOR j IN 1 .. v_n LOOP
      CONTINUE WHEN i = j;
      -- Higher SCORE wins, for every exercise that reaches settlement.
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
    v_delta := round(v_raw[i] / (v_n - 1))::integer;
    v_after := greatest(public._mmr_floor(), v_mmr[i] + v_delta);
    v_delta := v_after - v_mmr[i];

    UPDATE "skill_ratings"
       SET "mmr" = v_after,
           "matches_played" = "matches_played" + 1,
           "updated_at" = now()
     WHERE "user_id" = v_users[i] AND "exercise_type" = p_exercise;

    INSERT INTO "skill_rating_events"
      ("user_id", "match_id", "exercise_type", "mmr_before", "mmr_after",
       "delta", "k_factor", "was_placement", "matches_played", "participants",
       "norms_seeded")
      VALUES (
        v_users[i], p_match_id, p_exercise, v_mmr[i], v_after,
        v_delta, v_k[i],
        v_played[i] < public._mmr_placement_bouts(),
        v_played[i] + 1,
        p_seats,
        v_norms_seeded[i]
      );
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public._mmr_rate_match(uuid, "ChallengeType", integer)
  FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7. Blitz: the run row, the preview, the start
-- ----------------------------------------------------------------------------

ALTER TABLE "blitz_runs"
  ADD COLUMN "threshold_raw"    INTEGER,
  ADD COLUMN "benchmark_raw"    INTEGER,
  ADD COLUMN "threshold_score"  INTEGER,
  ADD COLUMN "benchmark_score"  INTEGER,
  ADD COLUMN "threshold_rating" INTEGER,
  ADD COLUMN "benchmark_rating" INTEGER,
  ADD COLUMN "breakeven_bp"     INTEGER,
  ADD COLUMN "max_bp"           INTEGER,
  ADD COLUMN "cleared"          BOOLEAN;

-- Any run already on file (none are expected on the live project -- no
-- build carrying Blitz had shipped when this was written) maps tier 1 to
-- the threshold and tier 3 to the benchmark.
UPDATE "blitz_runs"
   SET "threshold_raw"    = "tier1_target",
       "benchmark_raw"    = "tier3_target",
       "threshold_score"  = public._score_at_reference("tier1_target"),
       "benchmark_score"  = public._score_at_reference("tier3_target"),
       "threshold_rating" = "tier1_rating",
       "benchmark_rating" = "tier3_rating",
       "breakeven_bp"     = public._blitz_breakeven_bp(),
       "max_bp"           = "tier3_bp",
       "score"            = CASE WHEN "score" IS NULL THEN NULL
                                 ELSE public._score_at_reference("score") END,
       "cleared"          = CASE WHEN "tier_reached" IS NULL THEN NULL
                                 ELSE "tier_reached" >= 1 END;

ALTER TABLE "blitz_runs"
  DROP CONSTRAINT IF EXISTS "blitz_runs_targets_ascending",
  DROP CONSTRAINT IF EXISTS "blitz_runs_tier_reached_range",
  DROP CONSTRAINT IF EXISTS "blitz_runs_settled_is_complete",
  DROP COLUMN "tier1_target",
  DROP COLUMN "tier2_target",
  DROP COLUMN "tier3_target",
  DROP COLUMN "tier1_rating",
  DROP COLUMN "tier2_rating",
  DROP COLUMN "tier3_rating",
  DROP COLUMN "tier1_bp",
  DROP COLUMN "tier2_bp",
  DROP COLUMN "tier3_bp",
  DROP COLUMN "tier_reached";

ALTER TABLE "blitz_runs"
  ALTER COLUMN "threshold_raw"    SET NOT NULL,
  ALTER COLUMN "benchmark_raw"    SET NOT NULL,
  ALTER COLUMN "threshold_score"  SET NOT NULL,
  ALTER COLUMN "benchmark_score"  SET NOT NULL,
  ALTER COLUMN "threshold_rating" SET NOT NULL,
  ALTER COLUMN "benchmark_rating" SET NOT NULL,
  ALTER COLUMN "breakeven_bp"     SET NOT NULL,
  ALTER COLUMN "max_bp"           SET NOT NULL,
  ADD CONSTRAINT "blitz_runs_benchmark_above_threshold"
    CHECK ("benchmark_score" > "threshold_score"),
  ADD CONSTRAINT "blitz_runs_settled_is_complete" CHECK (
    ("settled_at" IS NULL
      AND "score" IS NULL AND "cleared" IS NULL
      AND "multiplier_bp" IS NULL AND "payout_points" IS NULL)
    OR
    ("settled_at" IS NOT NULL
      AND "score" IS NOT NULL AND "cleared" IS NOT NULL
      AND "multiplier_bp" IS NOT NULL AND "payout_points" IS NOT NULL)
  );

COMMENT ON COLUMN "blitz_runs"."threshold_score" IS
  'Break-even bar, in score units: the calibrated raw target at the reference form quality.';
COMMENT ON COLUMN "blitz_runs"."benchmark_score" IS
  'Where the multiplier reaches max_bp. Strictly above the threshold.';

CREATE TYPE public.blitz_preview_row AS (
  "exercise_type"        "ChallengeType",
  "mmr"                  INTEGER,
  "placement_complete"   BOOLEAN,
  "calibrated_to_me"     BOOLEAN,
  -- The raw counts behind the two bars, for the "about 30 reps at 85% form"
  -- caption. The score is what is compared; the raw count is what a fighter
  -- can picture.
  "threshold_raw"        INTEGER,
  "benchmark_raw"        INTEGER,
  "threshold_score"      INTEGER,
  "benchmark_score"      INTEGER,
  "threshold_rating"     INTEGER,
  "benchmark_rating"     INTEGER,
  "breakeven_bp"         INTEGER,
  "max_bp"               INTEGER,
  "reference_quality_bp" INTEGER
);

-- The two bars, in raw units: [threshold_raw, benchmark_raw]. The benchmark
-- is forced at least one step above the threshold, for the same reason the
-- old ladder nudged adjacent tiers apart: two equal bars would pay 2.5x for
-- clearing 1.0x's bar.
CREATE OR REPLACE FUNCTION public._blitz_bars(
  p_exercise "ChallengeType", p_mmr integer, p_gender "Gender", p_age_band "AgeBand"
) RETURNS integer[]
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_t integer;
  v_b integer;
BEGIN
  v_t := public._solo_target_for_rating(p_exercise, p_mmr, p_gender, p_age_band);
  v_b := public._solo_target_for_rating(
    p_exercise, p_mmr + public._solo_blitz_benchmark_offset(), p_gender, p_age_band);
  IF v_t IS NULL OR v_b IS NULL THEN
    RETURN NULL;
  END IF;
  v_b := greatest(v_b, v_t + public._solo_round_step(p_exercise));
  RETURN ARRAY[v_t, v_b];
END;
$$;
REVOKE ALL ON FUNCTION public._blitz_bars("ChallengeType", integer, "Gender", "AgeBand")
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.blitz_preview(p_exercise "ChallengeType")
RETURNS public.blitz_preview_row
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user   uuid := auth.uid();
  v_gender "Gender";
  v_band   "AgeBand";
  v_rating "skill_ratings"%ROWTYPE;
  v_bars   integer[];
  v_out    public.blitz_preview_row;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  IF p_exercise NOT IN ('pushups', 'plank', 'wallsit') THEN
    RAISE EXCEPTION 'exercise_not_available';
  END IF;

  SELECT "gender", "age_band" INTO v_gender, v_band
    FROM "fitness_profiles" WHERE "user_id" = v_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_required';
  END IF;

  v_rating := public._mmr_ensure(v_user, p_exercise);

  v_bars := public._blitz_bars(p_exercise, v_rating."mmr", v_gender, v_band);
  IF v_bars IS NULL THEN
    RAISE EXCEPTION 'calibration_unavailable';
  END IF;

  v_out."exercise_type"        := p_exercise;
  v_out."mmr"                  := v_rating."mmr";
  v_out."placement_complete"   := v_rating."placement_complete";
  v_out."calibrated_to_me"     := v_gender IS NOT NULL AND v_band IS NOT NULL;
  v_out."threshold_raw"        := v_bars[1];
  v_out."benchmark_raw"        := v_bars[2];
  v_out."threshold_score"      := public._score_at_reference(v_bars[1]);
  v_out."benchmark_score"      := public._score_at_reference(v_bars[2]);
  v_out."threshold_rating"     := v_rating."mmr";
  v_out."benchmark_rating"     := v_rating."mmr" + public._solo_blitz_benchmark_offset();
  v_out."breakeven_bp"         := public._blitz_breakeven_bp();
  v_out."max_bp"               := public._blitz_max_bp();
  v_out."reference_quality_bp" := public._score_reference_quality_bp();
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.blitz_preview("ChallengeType") FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.blitz_preview("ChallengeType") TO authenticated;

CREATE OR REPLACE FUNCTION public.blitz_start(
  p_exercise "ChallengeType",
  p_stake integer,
  p_is_ranked boolean DEFAULT false
) RETURNS "blitz_runs"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_gender  "Gender";
  v_band    "AgeBand";
  v_balance integer;
  v_rating  "skill_ratings"%ROWTYPE;
  v_bars    integer[];
  v_match   uuid;
  v_run     "blitz_runs"%ROWTYPE;
BEGIN
  PERFORM public._solo_start_guard(v_user, p_exercise, p_stake);

  SELECT "points_balance", "gender", "age_band"
    INTO v_balance, v_gender, v_band
    FROM "fitness_profiles" WHERE "user_id" = v_user FOR UPDATE;
  IF v_balance < p_stake THEN
    RAISE EXCEPTION 'insufficient_points';
  END IF;

  v_rating := public._mmr_ensure(v_user, p_exercise);
  v_bars := public._blitz_bars(p_exercise, v_rating."mmr", v_gender, v_band);
  IF v_bars IS NULL THEN
    RAISE EXCEPTION 'calibration_unavailable';
  END IF;

  v_match := public._solo_open_match(
    v_user, p_exercise, 'blitz', p_stake, coalesce(p_is_ranked, false), true);

  INSERT INTO "blitz_runs"
    ("user_id", "match_id", "exercise_type", "stake_points", "is_ranked",
     "mmr_at_start",
     "threshold_raw", "benchmark_raw", "threshold_score", "benchmark_score",
     "threshold_rating", "benchmark_rating", "breakeven_bp", "max_bp")
    VALUES (v_user, v_match, p_exercise, p_stake, coalesce(p_is_ranked, false),
            v_rating."mmr",
            v_bars[1], v_bars[2],
            public._score_at_reference(v_bars[1]), public._score_at_reference(v_bars[2]),
            v_rating."mmr", v_rating."mmr" + public._solo_blitz_benchmark_offset(),
            public._blitz_breakeven_bp(), public._blitz_max_bp())
    RETURNING * INTO v_run;

  RETURN v_run;
END;
$$;
REVOKE ALL ON FUNCTION public.blitz_start("ChallengeType", integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.blitz_start("ChallengeType", integer, boolean) TO authenticated;

-- ----------------------------------------------------------------------------
-- 8. Streak: stage targets become scores
--
-- The columns keep their names (stage1_target ...) and change their UNIT:
-- from 20260919000000 on, a stage target is a score, calibrated in raw
-- units and converted at the reference quality exactly as a Blitz bar is.
-- Every function that writes one is replaced below; the view gains the
-- reference quality so a screen can print "about 24 reps" next to it.
-- ----------------------------------------------------------------------------

COMMENT ON COLUMN "streak_runs"."stage1_target" IS 'SCORE units since 20260919000000 (was reps/seconds).';
COMMENT ON COLUMN "streak_runs"."stage2_target" IS 'SCORE units since 20260919000000 (was reps/seconds).';
COMMENT ON COLUMN "streak_runs"."stage3_target" IS 'SCORE units since 20260919000000 (was reps/seconds).';
COMMENT ON COLUMN "streak_stage_attempts"."score" IS 'SCORE units since 20260919000000 (was reps/seconds).';

UPDATE "streak_runs"
   SET "stage1_target" = public._score_at_reference("stage1_target"),
       "stage2_target" = public._score_at_reference("stage2_target"),
       "stage3_target" = public._score_at_reference("stage3_target");

UPDATE "streak_stage_attempts"
   SET "score" = public._score_at_reference("score")
 WHERE "score" IS NOT NULL;

ALTER TYPE public.streak_preview_row ADD ATTRIBUTE "reference_quality_bp" INTEGER;

CREATE OR REPLACE FUNCTION public._streak_view(
  p_user uuid, p_exercise "ChallengeType"
) RETURNS public.streak_preview_row
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_gender  "Gender";
  v_band    "AgeBand";
  v_rating  "skill_ratings"%ROWTYPE;
  v_off     integer[] := public._solo_streak_stage_offsets();
  v_step    integer   := public._solo_round_step(p_exercise);
  v_t       integer[];
  v_run     "streak_runs"%ROWTYPE;
  v_out     public.streak_preview_row;
  i         integer;
BEGIN
  SELECT "gender", "age_band" INTO v_gender, v_band
    FROM "fitness_profiles" WHERE "user_id" = p_user;

  SELECT * INTO v_rating FROM "skill_ratings"
   WHERE "user_id" = p_user AND "exercise_type" = p_exercise;

  v_out."exercise_type"        := p_exercise;
  v_out."mmr"                  := coalesce(v_rating."mmr", public._mmr_seed());
  v_out."placement_complete"   := coalesce(v_rating."placement_complete", false);
  v_out."calibrated_to_me"     := v_gender IS NOT NULL AND v_band IS NOT NULL;
  v_out."payout_bp"            := public._solo_streak_payout_bp();
  v_out."reference_quality_bp" := public._score_reference_quality_bp();
  v_out."server_now"           := now();

  -- A fresh ladder, calibrated in raw units and nudged apart there, then
  -- converted. Overwritten below by the snapshot if a run is live.
  FOR i IN 1 .. 3 LOOP
    v_t[i] := public._solo_target_for_rating(
      p_exercise, v_out."mmr" + v_off[i], v_gender, v_band);
    IF v_t[i] IS NULL THEN
      RETURN NULL;
    END IF;
    IF i > 1 THEN
      v_t[i] := greatest(v_t[i], v_t[i - 1] + v_step);
    END IF;
  END LOOP;

  v_out."stage1_target" := public._score_at_reference(v_t[1]);
  v_out."stage2_target" := public._score_at_reference(v_t[2]);
  v_out."stage3_target" := public._score_at_reference(v_t[3]);
  v_out."stage1_rating" := v_out."mmr" + v_off[1];
  v_out."stage2_rating" := v_out."mmr" + v_off[2];
  v_out."stage3_rating" := v_out."mmr" + v_off[3];

  SELECT * INTO v_run FROM "streak_runs"
   WHERE "user_id" = p_user AND "exercise_type" = p_exercise
   ORDER BY "created_at" DESC, "id" DESC
   LIMIT 1;

  IF NOT FOUND THEN
    v_out."state" := 'idle';
    RETURN v_out;
  END IF;

  IF v_run."status" IN ('active', 'failed') THEN
    v_out."stage1_target" := v_run."stage1_target";
    v_out."stage2_target" := v_run."stage2_target";
    v_out."stage3_target" := v_run."stage3_target";
    v_out."stage1_rating" := v_run."stage1_rating";
    v_out."stage2_rating" := v_run."stage2_rating";
    v_out."stage3_rating" := v_run."stage3_rating";
    v_out."payout_bp"     := v_run."payout_bp";
  END IF;

  v_out."run_id"        := v_run."id";
  v_out."is_ranked"     := v_run."is_ranked";
  v_out."stake_points"  := v_run."stake_points";
  v_out."stakes_paid"   := v_run."stakes_paid";
  v_out."current_stage" := v_run."current_stage";
  v_out."failed_stage"  := v_run."failed_stage";
  v_out."failed_at"     := v_run."failed_at";
  v_out."completed_at"  := v_run."completed_at";
  v_out."payout_points" := v_run."payout_points";

  IF v_run."failed_at" IS NOT NULL THEN
    v_out."buyback_until" := v_run."failed_at" + public._streak_buyback_window();
  END IF;
  IF v_run."completed_at" IS NOT NULL THEN
    v_out."cooldown_until" := v_run."completed_at" + public._streak_win_cooldown();
  END IF;

  IF v_run."status" = 'active' THEN
    v_out."state" := 'active';
    SELECT a."match_id" INTO v_out."pending_match_id"
      FROM "streak_stage_attempts" a
     WHERE a."run_id" = v_run."id" AND a."settled_at" IS NULL
     LIMIT 1;
  ELSIF v_run."status" = 'failed' THEN
    v_out."state" := CASE
      WHEN now() <= v_out."buyback_until" THEN 'failed' ELSE 'expired' END;
  ELSE
    v_out."state" := CASE
      WHEN now() < v_out."cooldown_until" THEN 'cooldown' ELSE 'idle' END;
  END IF;

  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public._streak_view(uuid, "ChallengeType")
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.streak_start(
  p_exercise "ChallengeType",
  p_stake integer,
  p_is_ranked boolean DEFAULT false
) RETURNS public.streak_preview_row
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_gender  "Gender";
  v_band    "AgeBand";
  v_balance integer;
  v_rating  "skill_ratings"%ROWTYPE;
  v_off     integer[] := public._solo_streak_stage_offsets();
  v_step    integer;
  v_t       integer[];
  v_run     "streak_runs"%ROWTYPE;
  v_match   uuid;
  v_cool    timestamptz;
  i         integer;
BEGIN
  PERFORM public._solo_start_guard(v_user, p_exercise, p_stake);

  IF EXISTS (
    SELECT 1 FROM "streak_runs"
     WHERE "user_id" = v_user AND "exercise_type" = p_exercise AND "status" = 'active'
  ) THEN
    RAISE EXCEPTION 'streak_run_active';
  END IF;

  SELECT max(r."completed_at" + public._streak_win_cooldown()) INTO v_cool
    FROM "streak_runs" r
   WHERE r."user_id" = v_user AND r."exercise_type" = p_exercise AND r."status" = 'won';
  IF v_cool IS NOT NULL AND now() < v_cool THEN
    RAISE EXCEPTION 'streak_cooldown';
  END IF;

  SELECT "points_balance", "gender", "age_band"
    INTO v_balance, v_gender, v_band
    FROM "fitness_profiles" WHERE "user_id" = v_user FOR UPDATE;
  IF v_balance < p_stake THEN
    RAISE EXCEPTION 'insufficient_points';
  END IF;

  v_rating := public._mmr_ensure(v_user, p_exercise);
  v_step := public._solo_round_step(p_exercise);
  FOR i IN 1 .. 3 LOOP
    v_t[i] := public._solo_target_for_rating(
      p_exercise, v_rating."mmr" + v_off[i], v_gender, v_band);
    IF v_t[i] IS NULL THEN
      RAISE EXCEPTION 'calibration_unavailable';
    END IF;
    IF i > 1 THEN
      v_t[i] := greatest(v_t[i], v_t[i - 1] + v_step);
    END IF;
  END LOOP;

  INSERT INTO "streak_runs"
    ("user_id", "exercise_type", "stake_points", "is_ranked", "mmr_at_start",
     "stage1_target", "stage2_target", "stage3_target",
     "stage1_rating", "stage2_rating", "stage3_rating",
     "payout_bp", "status", "current_stage", "stakes_paid")
    VALUES (v_user, p_exercise, p_stake, coalesce(p_is_ranked, false), v_rating."mmr",
            public._score_at_reference(v_t[1]),
            public._score_at_reference(v_t[2]),
            public._score_at_reference(v_t[3]),
            v_rating."mmr" + v_off[1], v_rating."mmr" + v_off[2], v_rating."mmr" + v_off[3],
            public._solo_streak_payout_bp(), 'active', 1, 1)
    RETURNING * INTO v_run;

  v_match := public._solo_open_match(
    v_user, p_exercise, 'streak', p_stake, v_run."is_ranked", true);

  INSERT INTO "streak_stage_attempts"
    ("run_id", "stage", "attempt_no", "match_id", "is_buy_back")
    VALUES (v_run."id", 1, 1, v_match, false);

  RETURN public._streak_view(v_user, p_exercise);
END;
$$;
REVOKE ALL ON FUNCTION public.streak_start("ChallengeType", integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.streak_start("ChallengeType", integer, boolean) TO authenticated;

-- ----------------------------------------------------------------------------
-- 9. Solo settlement on score
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._solo_settle(
  p_match_id uuid,
  p_challenge "challenges"
) RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_user      uuid;
  v_score     integer;
  v_blocked   boolean;
  v_run       "blitz_runs"%ROWTYPE;
  v_srun      "streak_runs"%ROWTYPE;
  v_attempt   "streak_stage_attempts"%ROWTYPE;
  v_bp        integer;
  v_payout    integer := 0;
  v_target    integer;
  v_rating    integer;
  v_cleared   boolean;
  v_winner    uuid;
BEGIN
  SELECT mp."user_id", mp."score"
    INTO v_user, v_score
    FROM "match_participants" mp
   WHERE mp."match_id" = p_match_id;

  SELECT bool_or(vs."anomaly_flag" AND NOT vs."reviewed") INTO v_blocked
    FROM "match_participants" mp
    JOIN "verification_sessions" vs ON vs."match_participant_id" = mp."id"
   WHERE mp."match_id" = p_match_id;

  IF coalesce(v_blocked, false) THEN
    UPDATE "challenges" SET "status" = 'needs_review' WHERE "id" = p_challenge."id";
    RETURN 'needs_review';
  END IF;

  PERFORM 1 FROM "fitness_profiles" WHERE "user_id" = v_user FOR UPDATE;

  IF p_challenge."format" = 'blitz' THEN
    SELECT * INTO v_run FROM "blitz_runs" WHERE "match_id" = p_match_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'blitz match % has no run row', p_match_id;
    END IF;

    -- The curve, against the snapshot the fighter was shown.
    v_bp := public._blitz_multiplier_bp(
      v_score, v_run."threshold_score", v_run."benchmark_score");
    v_payout := (v_run."stake_points"::bigint * v_bp / 10000)::integer;
    v_cleared := v_score >= v_run."threshold_score";

    IF v_payout > 0 THEN
      UPDATE "fitness_profiles"
         SET "points_balance" = "points_balance" + v_payout
       WHERE "user_id" = v_user;
      INSERT INTO "points_ledger_entries"
        ("id", "user_id", "amount", "reason", "match_id")
        VALUES (gen_random_uuid(), v_user, v_payout, 'payout', p_match_id);
    END IF;

    -- Rated against the threshold's virtual opponent whatever the margin:
    -- margin moves the payout, never the rating.
    v_rating := v_run."threshold_rating";

    UPDATE "blitz_runs"
       SET "score" = v_score,
           "cleared" = v_cleared,
           "multiplier_bp" = v_bp,
           "payout_points" = v_payout,
           "settled_at" = now()
     WHERE "id" = v_run."id";

  ELSE
    SELECT * INTO v_attempt FROM "streak_stage_attempts"
     WHERE "match_id" = p_match_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'streak match % has no stage attempt row', p_match_id;
    END IF;
    SELECT * INTO v_srun FROM "streak_runs" WHERE "id" = v_attempt."run_id" FOR UPDATE;

    v_target := CASE v_attempt."stage"
      WHEN 1 THEN v_srun."stage1_target"
      WHEN 2 THEN v_srun."stage2_target"
      ELSE v_srun."stage3_target" END;
    v_rating := CASE v_attempt."stage"
      WHEN 1 THEN v_srun."stage1_rating"
      WHEN 2 THEN v_srun."stage2_rating"
      ELSE v_srun."stage3_rating" END;
    v_cleared := v_score >= v_target;

    UPDATE "streak_stage_attempts"
       SET "score" = v_score, "passed" = v_cleared, "settled_at" = now()
     WHERE "id" = v_attempt."id";

    IF v_cleared AND v_attempt."stage" >= 3 THEN
      v_payout := (v_srun."stake_points"::bigint * v_srun."payout_bp" / 10000)::integer;
      UPDATE "fitness_profiles"
         SET "points_balance" = "points_balance" + v_payout
       WHERE "user_id" = v_user;
      INSERT INTO "points_ledger_entries"
        ("id", "user_id", "amount", "reason", "match_id")
        VALUES (gen_random_uuid(), v_user, v_payout, 'payout', p_match_id);
      UPDATE "streak_runs"
         SET "status" = 'won',
             "completed_at" = now(),
             "payout_points" = v_payout,
             "updated_at" = now()
       WHERE "id" = v_srun."id";
    ELSIF v_cleared THEN
      UPDATE "streak_runs"
         SET "current_stage" = v_attempt."stage" + 1,
             "updated_at" = now()
       WHERE "id" = v_srun."id";
    ELSE
      UPDATE "streak_runs"
         SET "status" = 'failed',
             "failed_stage" = v_attempt."stage",
             "failed_at" = now(),
             "updated_at" = now()
       WHERE "id" = v_srun."id";
    END IF;
  END IF;

  IF p_challenge."is_ranked" THEN
    PERFORM public._mmr_rate_solo(
      p_match_id, v_user, p_challenge."type", v_rating, v_cleared);
  END IF;

  v_winner := CASE WHEN v_cleared THEN v_user ELSE NULL END;

  UPDATE "match_participants" SET "place" = 1 WHERE "match_id" = p_match_id;
  UPDATE "matches" SET "winner_id" = v_winner, "settled_at" = now()
   WHERE "id" = p_match_id;
  UPDATE "challenges" SET "status" = 'completed' WHERE "id" = p_challenge."id";

  RETURN 'settled';
END;
$fn$;
REVOKE ALL ON FUNCTION public._solo_settle(uuid, "challenges") FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 10. settle_match(): head-to-head on score, pooled paid 50 / 30 / 20
--
-- Verbatim from 20260916000100 above the fork. Below it:
--
--   * v_best / v_winners come from match_participants.score.
--   * A 1v1 (max_participants = 2, format '1v1') keeps the whole-pot rule:
--     winner takes both stakes; a tie refunds both.
--   * A pooled bout -- the featured competition, or a queue-formed Group
--     Battle -- ranks every fighter, writes their place, and pays the
--     prize table. Fighters sharing a score share the prizes of the places
--     they occupy; the remainder rule is the old one (lowest user_id).
--   * A pooled competition with seats still open returns 'not_ready' rather
--     than raising: its participant count grows one entrant at a time.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.settle_match(p_match_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
  -- Pooled prize distribution.
  v_shares integer[];
  v_users uuid[];
  v_places integer[];
  v_n integer;
  v_group uuid[];
  v_group_place integer;
  v_group_prize integer;
  v_prizes integer[];
  v_groups integer[][];
  v_total_paid integer := 0;
  v_each integer;
  v_left integer;
  i integer;
  k integer;
  pos integer;
BEGIN
  IF auth.uid() IS NULL AND auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not signed in';
  END IF;

  SELECT * INTO v_match FROM "matches" WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'match % not found', p_match_id;
  END IF;

  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "match_participants"
    WHERE match_id = p_match_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'you are not a participant in this match';
  END IF;

  IF v_match.settled_at IS NOT NULL THEN
    RETURN 'already_settled';
  END IF;

  SELECT * INTO v_challenge FROM "challenges"
    WHERE id = v_match.challenge_id FOR UPDATE;

  SELECT count(*) INTO v_participants
    FROM "match_participants" WHERE match_id = p_match_id;

  -- A pooled competition fills one entrant at a time; until the last seat
  -- is taken there is nothing to decide. Every other format is seated all
  -- at once, so a count that disagrees with the header is an inconsistency.
  IF v_challenge.format = 'pooled' AND v_participants < v_challenge.max_participants THEN
    RETURN 'not_ready';
  END IF;
  IF v_participants <> v_challenge.max_participants THEN
    RAISE EXCEPTION 'settle_match expects % participants, found % on match %',
      v_challenge.max_participants, v_participants, p_match_id;
  END IF;

  SELECT count(*) INTO v_submitted
    FROM "match_participants" mp
    JOIN "verification_sessions" vs ON vs.match_participant_id = mp.id
    WHERE mp.match_id = p_match_id;

  IF v_submitted < v_participants THEN
    RETURN 'not_ready';
  END IF;

  IF v_challenge.type NOT IN ('pushups', 'plank', 'wallsit') THEN
    RAISE EXCEPTION 'settlement is not implemented for % challenges', v_challenge.type;
  END IF;

  -- A session exists but its score is NULL: submit_verification_session and
  -- settle_match disagree about what was recorded. Refuse rather than
  -- silently treat NULL as a loss.
  SELECT count(*) INTO v_null_scores
    FROM "match_participants" mp
   WHERE mp.match_id = p_match_id
     AND (mp."score" IS NULL
          OR CASE WHEN v_challenge.type = 'pushups' THEN mp.rep_count ELSE mp.hold_duration_seconds END IS NULL);
  IF v_null_scores > 0 THEN
    RAISE EXCEPTION 'match % has a verification session with no % score recorded',
      p_match_id, v_challenge.type;
  END IF;

  IF v_challenge.format IN ('blitz', 'streak') THEN
    RETURN public._solo_settle(p_match_id, v_challenge);
  END IF;

  SELECT max(mp."score") INTO v_best
    FROM "match_participants" mp WHERE mp.match_id = p_match_id;

  -- Ordered by user_id purely so the remainder rule below is deterministic.
  SELECT array_agg(mp.user_id ORDER BY mp.user_id) INTO v_winners
    FROM "match_participants" mp
   WHERE mp.match_id = p_match_id AND mp."score" = v_best;

  SELECT bool_or(vs.anomaly_flag AND NOT vs.reviewed) INTO v_blocked
    FROM "match_participants" mp
    JOIN "verification_sessions" vs ON vs.match_participant_id = mp.id
   WHERE mp.match_id = p_match_id AND mp.user_id = ANY (v_winners);

  IF coalesce(v_blocked, false) THEN
    UPDATE "challenges" SET status = 'needs_review' WHERE id = v_challenge.id;
    RETURN 'needs_review';
  END IF;

  v_pot := v_challenge.stake_points * v_challenge.max_participants;

  -- The whole field, in user_id order, before any skill_ratings lock. See
  -- LOCK ORDER in 20260913000000.
  PERFORM 1 FROM "fitness_profiles"
    WHERE user_id IN (
      SELECT mp.user_id FROM "match_participants" mp WHERE mp.match_id = p_match_id
    )
    ORDER BY user_id FOR UPDATE;

  -- Placings for everyone, "1224" style: ties share the best place.
  UPDATE "match_participants" mp
     SET "place" = t."place"
    FROM (
      SELECT mp2."id", rank() OVER (ORDER BY mp2."score" DESC) AS "place"
        FROM "match_participants" mp2
       WHERE mp2."match_id" = p_match_id
    ) t
   WHERE t."id" = mp."id";

  IF v_challenge.format = 'pooled' THEN
    -- Group the field by place, best first.
    SELECT array_agg(t."user_id" ORDER BY t."place", t."user_id"),
           array_agg(t."place" ORDER BY t."place", t."user_id")
      INTO v_users, v_places
      FROM "match_participants" t
     WHERE t."match_id" = p_match_id;
    v_n := cardinality(v_users);
    v_shares := public._pool_prize_shares_bp();

    -- Pass 1: each place group's prize is the sum of the shares for the
    -- places it occupies. Truncated per share, never rounded up.
    v_prizes := '{}';
    v_groups := '{}';
    i := 1;
    WHILE i <= v_n LOOP
      v_group_place := v_places[i];
      v_group := '{}';
      k := i;
      WHILE k <= v_n AND v_places[k] = v_group_place LOOP
        v_group := v_group || v_users[k];
        k := k + 1;
      END LOOP;
      v_group_prize := 0;
      FOR pos IN v_group_place .. v_group_place + cardinality(v_group) - 1 LOOP
        IF pos <= cardinality(v_shares) THEN
          v_group_prize := v_group_prize + (v_pot::bigint * v_shares[pos] / 10000)::integer;
        END IF;
      END LOOP;
      v_prizes := v_prizes || v_group_prize;
      v_total_paid := v_total_paid + v_group_prize;
      -- Store the group boundaries as (start, end) offsets into v_users.
      v_groups := v_groups || ARRAY[ARRAY[i, k - 1]];
      i := k;
    END LOOP;

    -- Whatever truncation left over goes to the top group, so the pot is
    -- paid out in full and the ledger stays zero-sum.
    v_left := v_pot - v_total_paid;
    IF v_left > 0 THEN
      v_prizes[1] := v_prizes[1] + v_left;
    END IF;

    -- Pass 2: pay each group, evenly, remainder to the lowest user_id.
    FOR i IN 1 .. array_length(v_groups, 1) LOOP
      IF v_prizes[i] > 0 THEN
        v_group := v_users[v_groups[i][1] : v_groups[i][2]];
        v_each := v_prizes[i] / cardinality(v_group);
        v_remainder := v_prizes[i] - v_each * cardinality(v_group);
        UPDATE "fitness_profiles" fp
           SET points_balance = points_balance + v_each
                                + CASE WHEN fp.user_id = v_group[1] THEN v_remainder ELSE 0 END
          WHERE fp.user_id = ANY (v_group);
        INSERT INTO "points_ledger_entries" ("id", "user_id", "amount", "reason", "match_id")
          SELECT gen_random_uuid(), w,
                 v_each + CASE WHEN w = v_group[1] THEN v_remainder ELSE 0 END,
                 'payout', p_match_id
            FROM unnest(v_group) AS w;
      END IF;
    END LOOP;

    v_winner := CASE WHEN cardinality(v_winners) = 1 THEN v_winners[1] ELSE NULL END;

    UPDATE "pooled_competitions" SET "settled_at" = now() WHERE "match_id" = p_match_id;
  ELSE
    -- Head-to-head: best score takes the whole pot; tied for best share it.
    v_share := v_pot / cardinality(v_winners);
    v_remainder := v_pot - v_share * cardinality(v_winners);

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
  END IF;

  IF v_challenge.is_ranked THEN
    PERFORM public._mmr_rate_match(p_match_id, v_challenge.type, v_challenge.max_participants);
  END IF;

  -- Trophies for the top score only. Second and third in a pooled bout are
  -- paid but are not, on the trophy ladder, a win -- see BACKEND.md.
  PERFORM public._rank_apply_match(p_match_id, v_winners, NULL);

  UPDATE "matches" SET winner_id = v_winner, settled_at = now() WHERE id = p_match_id;
  UPDATE "challenges" SET status = 'completed' WHERE id = v_challenge.id;

  RETURN CASE
    WHEN v_winner IS NOT NULL THEN 'settled'
    WHEN cardinality(v_winners) = v_participants THEN 'tie_refunded'
    ELSE 'tie_split'
  END;
END;
$fn$;

REVOKE ALL ON FUNCTION public.settle_match(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settle_match(uuid) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 11. Make PostgREST pick up the new columns, table, types and signatures
-- ----------------------------------------------------------------------------

NOTIFY pgrst, 'reload schema';
