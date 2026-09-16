-- ============================================================================
-- Blitz, Streak, and the ranked / casual switch.
--
-- Three features that share one idea: a bout does not need a second person
-- to be a real, staked, camera-verified contest, and a real contest does not
-- have to touch your rating.
--
--   blitz_runs             one solo set against three ascending thresholds
--                          calibrated to the fighter's MMR. Highest cleared
--                          threshold pays its multiplier on the stake.
--   streak_runs            up to three stages, staked once, each stage its
--                          own calibrated target and its own camera round.
--   streak_stage_attempts  one row per stage attempt, INCLUDING buy-backs.
--   challenges.is_ranked   whether this bout moves skill_ratings at all.
--   _solo_target_for_rating()  the calibration: rating -> percentile ->
--                          raw score, per exercise, from performance_norms.
--   _mmr_rate_solo()       one Elo update against a VIRTUAL opponent whose
--                          rating is the rating the threshold was
--                          calibrated to.
--   settle_match()         forks to the solo path, and skips the rating
--                          entirely for a casual bout.
--
-- ----------------------------------------------------------------------------
-- WHY THE THRESHOLDS ARE RATING OFFSETS AND NOT MULTIPLES OF A BASE
--
-- The obvious calibration is "tier 2 is 1.4x your expected score". It is
-- also wrong, and measurably so, because the three exercises have wildly
-- different spreads. From the seeded norms (see 20260910000000):
--
--   pushups, male 20s   P25=17  P50=30  P75=47   -> sigma_log ~ 0.75
--   plank,   male 20s   P25=81  P50=106 P75=130  -> sigma_log ~ 0.19
--
-- A flat "1.75x your median" is a ~1-sigma stretch on push-ups and a
-- ~2.9-sigma stretch on a plank. The same printed multiplier would be a
-- coin flip in one exercise and a once-a-year event in another.
--
-- So every threshold is defined in RATING space instead, and converted to a
-- score through the norms table:
--
--   threshold(offset) = the raw score whose population percentile maps back
--                       to (my rating + offset)
--
-- That makes the difficulty of a tier identical across exercises by
-- construction, because the percentile curve absorbs each exercise's own
-- spread. It also makes the virtual opponent exact rather than invented:
-- the implied rating of a threshold IS the rating it was calibrated from,
-- so the Elo expectation against it is, by definition, the probability a
-- fighter at that rating clears it.
--
--   Blitz offsets  {0, +150, +320}  ->  E = 0.500 / 0.297 / 0.137
--                  multipliers      ->  1.5x     / 2.0x   / 2.5x
--                  EV per stake = 0.203*1.5 + 0.160*2.0 + 0.137*2.5 = 0.97
--
--   Streak offsets {-200, -100, 0}  ->  E = 0.760 / 0.640 / 0.500
--                  chain = 0.243, payout 4.0x  ->  EV per stake = 0.97
--
-- Both land just under 1.0 on purpose: a solo mode that paid out at or above
-- parity would inflate the points economy with no opponent's stake feeding
-- the pot. The ~3% house edge is the whole reason a wager against yourself
-- can exist at all.
--
-- (!) EV IS A MODEL, NOT A MEASUREMENT. The numbers above assume a fighter's
-- score distribution matches the population percentile curve their rating
-- sits on. That is the same assumption the placement seed already makes
-- (20260910000000, "What's NOT verified"), and it has never been checked
-- against a real set. See BACKEND.md.
--
-- ----------------------------------------------------------------------------
-- THE TWO STREAK TIMERS ARE NOT THE SAME TIMER
--
-- Both are five hours. They measure different things from different anchors
-- and gate different functions, and conflating them would be a bug:
--
--   _streak_buyback_window()  from streak_runs.failed_at. While it is open,
--                             streak_buy_back_in() may retry THE FAILED
--                             STAGE for another stake. When it closes the
--                             run is spent; the next attempt starts at
--                             stage 1.
--   _streak_win_cooldown()    from streak_runs.completed_at. While it is
--                             open, streak_start() refuses. Nothing about a
--                             failed run is cooled down -- only a win.
--
-- Neither is stored as a deadline. Both are computed from their anchor at
-- read time, so changing the tunable changes every live run, and a clock
-- skew on one phone cannot bank a longer window.
--
-- ----------------------------------------------------------------------------
-- LOCK ORDER -- unchanged, and extended at the same end as before.
--
--   lobby `challenges` row -> member `matchmaking_queue` rows
--     -> `fitness_profiles` rows ORDER BY user_id
--     -> `skill_ratings` rows ORDER BY user_id
--
-- A solo mode has exactly one of each, so it cannot deadlock against
-- itself. blitz_start(), streak_start() and streak_buy_back_in() take the
-- one fitness_profiles row FOR UPDATE (they debit a stake) and nothing
-- else; the solo settlement path takes fitness_profiles then skill_ratings,
-- in that order, exactly as the 1v1 path does. blitz_runs / streak_runs /
-- streak_stage_attempts are appended AFTER skill_ratings in the order --
-- nothing else locks them, and nothing they lock is taken again later.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Ranked / casual on the existing pipeline
--
-- One boolean on the challenge, snapshotted onto the queue entry so pairing
-- can read it without a join. Casual is the default EVERYWHERE -- the column
-- default, the RPC default, and the client's initial state -- because
-- "ranked" is a thing a fighter opts into for one attempt, never a mode they
-- are left in.
--
-- The backfill is deliberately status-aware rather than a blanket `true`.
-- Every bout that has already been matched or settled DID move ratings, so
-- it was ranked and must read as ranked forever (the Results screen shows a
-- badge off this column). An `open` lobby, though, is a live search: at
-- deploy time it has no is_ranked of its own, so it becomes casual, which is
-- also what every queue row it holds becomes. The alternative -- open
-- lobbies true, queue rows false -- would strand those searches against a
-- pairing predicate they could never satisfy. As it is they either fill
-- normally or expire on the 20-second TTL like any other stale search.
-- ----------------------------------------------------------------------------

ALTER TABLE "challenges"
  ADD COLUMN "is_ranked" BOOLEAN NOT NULL DEFAULT false;

UPDATE "challenges" SET "is_ranked" = true WHERE "status" <> 'open';

ALTER TABLE "matchmaking_queue"
  ADD COLUMN "is_ranked" BOOLEAN NOT NULL DEFAULT false;

-- Pairing now separates the ranked and casual pools, so both indexes the
-- queue and the lobby search scan are widened to carry the flag.
DROP INDEX IF EXISTS "matchmaking_queue_domain_idx";
CREATE INDEX "matchmaking_queue_domain_idx"
  ON "matchmaking_queue" ("exercise_type", "format", "max_participants", "is_ranked", "status");

DROP INDEX IF EXISTS "challenges_open_lobbies_idx";
CREATE INDEX "challenges_open_lobbies_idx"
  ON "challenges" ("type", "format", "max_participants", "is_ranked", "stake_points", "created_at")
  WHERE "status" = 'open';

-- ----------------------------------------------------------------------------
-- 2. One seat is now a legal bout
--
-- max_participants was 2..6. A solo format is one seat, and the two new
-- formats are the only things allowed to use it -- a one-seat '1v1' would be
-- a bout with nobody in the other corner, which is a bug, not a mode. The
-- constraint is an equivalence in both directions for that reason.
-- ----------------------------------------------------------------------------

ALTER TABLE "challenges"
  DROP CONSTRAINT IF EXISTS "challenges_max_participants_range";

ALTER TABLE "challenges"
  ADD CONSTRAINT "challenges_max_participants_range"
    CHECK ("max_participants" BETWEEN 1 AND 6),
  ADD CONSTRAINT "challenges_solo_has_one_seat"
    CHECK (("format" IN ('blitz', 'streak')) = ("max_participants" = 1));

-- The queue never carries a solo format: nothing is matched, so nothing
-- queues. Stated as a constraint so a future caller cannot quietly try.
ALTER TABLE "matchmaking_queue"
  ADD CONSTRAINT "matchmaking_queue_no_solo_formats"
    CHECK ("format" NOT IN ('blitz', 'streak'));

-- ----------------------------------------------------------------------------
-- 3. Tunables
--
-- Functions rather than a settings table, matching every tunable since
-- 20260908000000: the values stay in version control next to the code that
-- reads them. Mirrored in src/lib/soloModes.ts and asserted equal by
-- __tests__/soloModes.db.test.ts, so the two cannot drift silently.
-- ----------------------------------------------------------------------------

-- Rating offsets for the three Blitz tiers, ascending. Tier 1 is the
-- fighter's own rating: the bar they are, by the Elo definition of their
-- rating, a coin flip to clear.
CREATE OR REPLACE FUNCTION public._solo_blitz_tier_offsets() RETURNS integer[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[0, 150, 320] $$;

-- The multiplier each tier pays, in basis points of the stake. 25000 = 2.5x,
-- the ceiling the product spec fixes. Integer basis points, not numeric,
-- so a payout is stake * bp / 10000 in integer arithmetic and there is no
-- float anywhere near the points balance.
CREATE OR REPLACE FUNCTION public._solo_blitz_tier_bp() RETURNS integer[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[15000, 20000, 25000] $$;

-- Rating offsets for the three Streak stages, ascending. Stage 3 is the
-- fighter's own rating, so the run ends on the same bar a Blitz opens with:
-- the last stage of a streak is a fight against yourself.
CREATE OR REPLACE FUNCTION public._solo_streak_stage_offsets() RETURNS integer[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[-200, -100, 0] $$;

-- What clearing all three stages pays, in basis points of the INITIAL stake
-- -- not of everything staked. A buy-back does not raise the payout, so
-- every retry is paid for out of the same purse. That is the difference
-- between a rescue and a martingale.
CREATE OR REPLACE FUNCTION public._solo_streak_payout_bp() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 40000 $$;

-- TIMER 1. From streak_runs.failed_at: how long streak_buy_back_in() stays
-- available on a failed run.
CREATE OR REPLACE FUNCTION public._streak_buyback_window() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '5 hours' $$;

-- TIMER 2. From streak_runs.completed_at: how long streak_start() refuses
-- after a WON run. A failed run has no cooldown at all -- the buy-back
-- window above is the only clock on it.
CREATE OR REPLACE FUNCTION public._streak_win_cooldown() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '5 hours' $$;

-- Which age band a fighter who has not told us one is calibrated against.
-- '20s' rather than a population average: it is the band every source table
-- in performance_norms is actually anchored at (ACSM 20-29, Chase 18-25),
-- so it is the one band whose numbers are sourced rather than modelled. It
-- is also what 'under_20' already defaults to, for the same reason.
CREATE OR REPLACE FUNCTION public._solo_default_age_band() RETURNS "AgeBand"
LANGUAGE sql IMMUTABLE AS $$ SELECT '20s'::"AgeBand" $$;

-- What a threshold is rounded to, per exercise. Reps land on whole reps;
-- holds land on 5-second marks, because "hold it for 106 seconds" reads as
-- a calculation and "hold it for 1:45" reads as a target. The rounding is
-- applied AFTER the percentile lookup, so it never changes which percentile
-- was asked for -- only how the answer is printed and compared.
CREATE OR REPLACE FUNCTION public._solo_round_step(p_exercise "ChallengeType")
RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_exercise = 'pushups' THEN 1 ELSE 5 END
$$;

-- The floor a threshold can never round below. One rep, or five seconds:
-- a "target" of zero would be cleared by standing still.
CREATE OR REPLACE FUNCTION public._solo_min_target(p_exercise "ChallengeType")
RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_exercise = 'pushups' THEN 1 ELSE 5 END
$$;

-- ----------------------------------------------------------------------------
-- 4. The calibration, both directions
--
-- 20260910000000 built the forward half of this pipeline for the placement
-- seed: raw score -> percentile (interpolated between the norms anchors) ->
-- MMR. The solo modes need the same pipeline run BACKWARDS -- rating ->
-- percentile -> raw score -- so every function below is the mirror of one
-- that already exists, and the two are asserted to invert each other in
-- __tests__/soloModes.db.test.ts rather than merely believed to.
-- ----------------------------------------------------------------------------

-- The exact inverse of _mmr_from_percentile():
--
--   MMR(p) = 1000 + 400 * log10(p / (100 - p))
--   p(MMR) = 100 / (1 + 10 ^ ((1000 - MMR) / 400))
--
-- Clamped to [1, 99] at the output, which is the same band the forward
-- function's callers clamp their input to, and the exponent clamped to
-- +/-10 for the same reason _mmr_expected() clamps its: power() on numeric
-- raises rather than saturating, and a corrupted rating must not be able to
-- make a preview -- let alone a settlement -- throw.
CREATE OR REPLACE FUNCTION public._solo_percentile_for_rating(p_rating integer)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT greatest(1::numeric, least(99::numeric,
    100::numeric / (1::numeric + power(
      10::numeric,
      greatest(-10::numeric, least(10::numeric, (1000 - p_rating)::numeric / 400))
    ))
  ))
$$;
REVOKE ALL ON FUNCTION public._solo_percentile_for_rating(integer) FROM PUBLIC, anon, authenticated;

-- The mirror of _perf_percentile_from_anchors(): same piecewise-linear
-- algorithm, same slope-extrapolation beyond either end, same NULLIF guard
-- on every division -- with raw and percentile swapped. Both anchor arrays
-- arrive sorted ascending by percentile, and the norms data is strictly
-- increasing in raw_value as percentile rises (asserted by the monotonicity
-- test in performanceNorms.db.test.ts), so interpolating on either axis
-- walks the same brackets in the same order.
--
-- No clamp on the OUTPUT here, unlike its mirror: a percentile clamps to a
-- real population range, but there is no defensible ceiling on a rep count.
-- The caller applies _solo_min_target() as the only floor.
CREATE OR REPLACE FUNCTION public._perf_raw_from_anchors(
  p_pct numeric, p_anchors_raw numeric[], p_anchors_pct numeric[]
) RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_n integer := coalesce(cardinality(p_anchors_raw), 0);
  v_raw numeric;
  v_slope numeric;
  k integer;
BEGIN
  IF v_n < 2 OR coalesce(cardinality(p_anchors_pct), 0) <> v_n OR p_pct IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_pct <= p_anchors_pct[1] THEN
    v_slope := (p_anchors_raw[2] - p_anchors_raw[1]) / NULLIF(p_anchors_pct[2] - p_anchors_pct[1], 0);
    v_raw := coalesce(p_anchors_raw[1] + v_slope * (p_pct - p_anchors_pct[1]), p_anchors_raw[1]);
  ELSIF p_pct >= p_anchors_pct[v_n] THEN
    v_slope := (p_anchors_raw[v_n] - p_anchors_raw[v_n - 1]) / NULLIF(p_anchors_pct[v_n] - p_anchors_pct[v_n - 1], 0);
    v_raw := coalesce(p_anchors_raw[v_n] + v_slope * (p_pct - p_anchors_pct[v_n]), p_anchors_raw[v_n]);
  ELSE
    FOR k IN 1 .. v_n - 1 LOOP
      IF p_pct >= p_anchors_pct[k] AND p_pct <= p_anchors_pct[k + 1] THEN
        v_slope := (p_anchors_raw[k + 1] - p_anchors_raw[k]) / NULLIF(p_anchors_pct[k + 1] - p_anchors_pct[k], 0);
        v_raw := coalesce(p_anchors_raw[k] + v_slope * (p_pct - p_anchors_pct[k]), p_anchors_raw[k]);
        EXIT;
      END IF;
    END LOOP;
  END IF;

  RETURN v_raw;
END;
$$;
REVOKE ALL ON FUNCTION public._perf_raw_from_anchors(numeric, numeric[], numeric[]) FROM PUBLIC, anon, authenticated;

-- The raw score at one percentile for one fully-specified population.
-- NULL (never an exception) when that combination has no anchors, exactly
-- as _mmr_seed_from_norms() returns NULL rather than raising.
CREATE OR REPLACE FUNCTION public._solo_raw_at_percentile(
  p_exercise "ChallengeType", p_gender "Gender", p_age_band "AgeBand", p_pct numeric
) RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_raw numeric;
BEGIN
  SELECT public._perf_raw_from_anchors(
           p_pct,
           array_agg(n."raw_value" ORDER BY n."percentile"),
           array_agg(n."percentile" ORDER BY n."percentile")
         )
    INTO v_raw
    FROM "performance_norms" n
   WHERE n."exercise_type" = p_exercise
     AND n."gender" = p_gender
     AND n."age_band" = p_age_band;
  RETURN v_raw;
END;
$$;
REVOKE ALL ON FUNCTION public._solo_raw_at_percentile("ChallengeType", "Gender", "AgeBand", numeric)
  FROM PUBLIC, anon, authenticated;

-- THE CALIBRATION. The raw score a fighter at p_rating is expected to
-- produce in p_exercise, rounded to the exercise's step and floored.
--
-- MISSING DEMOGRAPHICS. gender and age_band are optional on
-- fitness_profiles and always will be (20260910000000, "Optional
-- demographics"), so this has to answer without them:
--
--   * no age_band -> _solo_default_age_band(), i.e. the band the source
--     data is actually anchored at.
--   * no gender   -> the MEAN of the two sourced populations at the same
--     percentile. Not a default sex, and not "whichever is easier": the
--     midpoint of the two curves the data gives, which is the most that can
--     honestly be said about someone who did not say. The consequence is
--     stated plainly on the pre-bout screen, which tells anyone without
--     demographics on file that filling them in sharpens their targets.
--
-- NULL when the exercise is outside the three the norms table covers, or
-- when no anchors exist for the combination. Callers treat NULL as
-- "calibration_unavailable" and refuse to start a run -- a solo mode with
-- an uncalibrated bar is not a mode, it is a coin flip with a number on it.
CREATE OR REPLACE FUNCTION public._solo_target_for_rating(
  p_exercise "ChallengeType", p_rating integer, p_gender "Gender", p_age_band "AgeBand"
) RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_band "AgeBand" := coalesce(p_age_band, public._solo_default_age_band());
  v_pct  numeric;
  v_raw  numeric;
  v_step integer;
BEGIN
  IF p_exercise NOT IN ('pushups', 'plank', 'wallsit') OR p_rating IS NULL THEN
    RETURN NULL;
  END IF;

  v_pct := public._solo_percentile_for_rating(p_rating);

  IF p_gender IS NOT NULL THEN
    v_raw := public._solo_raw_at_percentile(p_exercise, p_gender, v_band, v_pct);
  ELSE
    SELECT avg(t."raw") INTO v_raw
      FROM (
        SELECT public._solo_raw_at_percentile(p_exercise, g, v_band, v_pct) AS "raw"
          FROM unnest(ARRAY['male', 'female']::"Gender"[]) AS g
      ) t
     WHERE t."raw" IS NOT NULL;
  END IF;

  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  v_step := public._solo_round_step(p_exercise);
  RETURN greatest(
    public._solo_min_target(p_exercise),
    (round(v_raw / v_step) * v_step)::integer
  );
END;
$$;
REVOKE ALL ON FUNCTION public._solo_target_for_rating("ChallengeType", integer, "Gender", "AgeBand")
  FROM PUBLIC, anon, authenticated;

-- The forward direction, for the same population model as above: what
-- rating a raw score implies. _mmr_seed_from_norms() already does this for
-- a fully-specified fighter; this adds the same gender-mean fallback so the
-- two directions are inverses over the SAME domain and can be asserted
-- against each other.
--
-- Nothing in settlement calls this. The virtual opponent's rating is the
-- NOMINAL rating a threshold was calibrated from (stored on the run row),
-- not a rating re-derived from the rounded threshold -- see section 9. This
-- exists so the claim "the threshold's implied rating is the rating it was
-- calibrated to" is checkable rather than asserted.
CREATE OR REPLACE FUNCTION public._solo_rating_for_target(
  p_exercise "ChallengeType", p_target integer, p_gender "Gender", p_age_band "AgeBand"
) RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_band "AgeBand" := coalesce(p_age_band, public._solo_default_age_band());
  v_pct  numeric;
BEGIN
  IF p_exercise NOT IN ('pushups', 'plank', 'wallsit') OR p_target IS NULL THEN
    RETURN NULL;
  END IF;

  -- _mmr_seed_from_norms() already IS this whole chain (anchors ->
  -- percentile -> MMR) for a fighter who told us both, so the specified case
  -- reuses it verbatim rather than restating it. It returns a rating, not a
  -- percentile.
  IF p_gender IS NOT NULL THEN
    RETURN public._mmr_seed_from_norms(p_exercise, p_gender, v_band, p_target);
  END IF;

  SELECT avg(t."pct") INTO v_pct
    FROM (
      SELECT public._perf_percentile_from_anchors(
               p_target::numeric,
               array_agg(n."raw_value" ORDER BY n."percentile"),
               array_agg(n."percentile" ORDER BY n."percentile")
             ) AS "pct"
        FROM "performance_norms" n
       WHERE n."exercise_type" = p_exercise
         AND n."age_band" = v_band
       GROUP BY n."gender"
    ) t
   WHERE t."pct" IS NOT NULL;

  IF v_pct IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN public._mmr_from_percentile(v_pct);
END;
$$;
REVOKE ALL ON FUNCTION public._solo_rating_for_target("ChallengeType", integer, "Gender", "AgeBand")
  FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5. The tables
--
-- Both run tables are WRITTEN ONLY by the SECURITY DEFINER functions below
-- and READ ONLY by their owner. There is no client grant to insert or update
-- either one: a client that could write its own thresholds could set them to
-- one rep.
--
-- Every threshold and every virtual-opponent rating is SNAPSHOTTED onto the
-- run at the moment it starts, and settlement reads the snapshot rather than
-- recalibrating. Three reasons, all of them real:
--   * a bout settling elsewhere can move the fighter's MMR mid-run, and the
--     bar must be the one they were shown;
--   * the tunables above can change between a run starting and finishing;
--   * the norms table can be re-seeded.
-- The same reasoning matchmaking_queue already applies to its mmr column.
-- ----------------------------------------------------------------------------

CREATE TYPE "StreakRunStatus" AS ENUM (
  -- A stage is in flight, or waiting for the fighter to start the next one.
  'active',
  -- A stage was failed. failed_at anchors the buy-back window; past it the
  -- run is spent, which is a DERIVED state and not a fourth status -- see
  -- streak_preview().
  'failed',
  -- All three stages cleared and the payout paid. completed_at anchors the
  -- win cooldown.
  'won'
);

CREATE TABLE "blitz_runs" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"       UUID NOT NULL,
  -- One run per match, and a match per run: the camera round, the
  -- verification session, the ledger entries and the anomaly gate are all
  -- the existing ones, reached through this id.
  "match_id"      UUID NOT NULL,
  "exercise_type" "ChallengeType" NOT NULL,
  "stake_points"  INTEGER NOT NULL,
  "is_ranked"     BOOLEAN NOT NULL,
  -- The rating the whole ladder was calibrated from, and the rating tier 1's
  -- virtual opponent is.
  "mmr_at_start"  INTEGER NOT NULL,

  "tier1_target"  INTEGER NOT NULL,
  "tier2_target"  INTEGER NOT NULL,
  "tier3_target"  INTEGER NOT NULL,
  -- mmr_at_start + _solo_blitz_tier_offsets()[i], stored so a later change
  -- to the offsets cannot re-rate a run that is already in flight.
  "tier1_rating"  INTEGER NOT NULL,
  "tier2_rating"  INTEGER NOT NULL,
  "tier3_rating"  INTEGER NOT NULL,
  "tier1_bp"      INTEGER NOT NULL,
  "tier2_bp"      INTEGER NOT NULL,
  "tier3_bp"      INTEGER NOT NULL,

  -- All four NULL until settlement.
  "score"          INTEGER,
  -- 0..3. Zero means the first threshold was not reached: the stake is gone
  -- and there is no payout row at all.
  "tier_reached"   INTEGER,
  "multiplier_bp"  INTEGER,
  "payout_points"  INTEGER,

  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "settled_at"    TIMESTAMPTZ,

  CONSTRAINT "blitz_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "blitz_runs_match_id_key" UNIQUE ("match_id"),
  CONSTRAINT "blitz_runs_user_id_fkey" FOREIGN KEY ("user_id")
      REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  CONSTRAINT "blitz_runs_match_id_fkey" FOREIGN KEY ("match_id")
      REFERENCES "matches"("id") ON DELETE CASCADE,
  CONSTRAINT "blitz_runs_stake_positive" CHECK ("stake_points" > 0),
  CONSTRAINT "blitz_runs_targets_ascending"
    CHECK ("tier1_target" < "tier2_target" AND "tier2_target" < "tier3_target"),
  CONSTRAINT "blitz_runs_tier_reached_range"
    CHECK ("tier_reached" IS NULL OR "tier_reached" BETWEEN 0 AND 3),
  -- Settled means all four result columns are populated, and unsettled means
  -- none of them are. Stated once here so no reader has to check four.
  CONSTRAINT "blitz_runs_settled_is_complete" CHECK (
    ("settled_at" IS NULL
      AND "score" IS NULL AND "tier_reached" IS NULL
      AND "multiplier_bp" IS NULL AND "payout_points" IS NULL)
    OR
    ("settled_at" IS NOT NULL
      AND "score" IS NOT NULL AND "tier_reached" IS NOT NULL
      AND "multiplier_bp" IS NOT NULL AND "payout_points" IS NOT NULL)
  )
);

CREATE INDEX "blitz_runs_user_id_created_at_idx"
  ON "blitz_runs" ("user_id", "created_at" DESC);

CREATE TABLE "streak_runs" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"       UUID NOT NULL,
  "exercise_type" "ChallengeType" NOT NULL,
  -- What one attempt costs: the initial stake, and what a buy-back costs
  -- again. Fixed for the life of the run.
  "stake_points"  INTEGER NOT NULL,
  "is_ranked"     BOOLEAN NOT NULL,
  "mmr_at_start"  INTEGER NOT NULL,

  "stage1_target" INTEGER NOT NULL,
  "stage2_target" INTEGER NOT NULL,
  "stage3_target" INTEGER NOT NULL,
  "stage1_rating" INTEGER NOT NULL,
  "stage2_rating" INTEGER NOT NULL,
  "stage3_rating" INTEGER NOT NULL,
  "payout_bp"     INTEGER NOT NULL,

  "status"        "StreakRunStatus" NOT NULL DEFAULT 'active',
  -- The stage a buy-back would retry and the stage streak_next_stage() will
  -- open. NOT advanced past 3: a won run stays at 3.
  "current_stage" INTEGER NOT NULL DEFAULT 1,
  -- Initial stake plus one per buy-back. The run's total cost is
  -- stake_points * stakes_paid, which is what the UI shows against the
  -- payout so the net is never a surprise.
  "stakes_paid"   INTEGER NOT NULL DEFAULT 1,

  -- TIMER 1's anchor. Set on every failure, and deliberately NOT cleared by
  -- a buy-back: the attempts table is the history, and leaving the last
  -- failure's timestamp in place means a run that fails again re-anchors the
  -- window rather than inheriting the old one.
  "failed_stage"  INTEGER,
  "failed_at"     TIMESTAMPTZ,
  -- TIMER 2's anchor.
  "completed_at"  TIMESTAMPTZ,
  "payout_points" INTEGER,

  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "streak_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "streak_runs_user_id_fkey" FOREIGN KEY ("user_id")
      REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  CONSTRAINT "streak_runs_stake_positive" CHECK ("stake_points" > 0),
  CONSTRAINT "streak_runs_stakes_paid_positive" CHECK ("stakes_paid" >= 1),
  CONSTRAINT "streak_runs_targets_ascending"
    CHECK ("stage1_target" < "stage2_target" AND "stage2_target" < "stage3_target"),
  CONSTRAINT "streak_runs_current_stage_range" CHECK ("current_stage" BETWEEN 1 AND 3),
  CONSTRAINT "streak_runs_failed_stage_range"
    CHECK ("failed_stage" IS NULL OR "failed_stage" BETWEEN 1 AND 3),
  -- A failure has both a stage and a timestamp or neither.
  CONSTRAINT "streak_runs_failure_is_complete"
    CHECK (("failed_stage" IS NULL) = ("failed_at" IS NULL)),
  -- 'failed' always carries its failure. The reverse is NOT asserted: a run
  -- bought back into is 'active' and still carries the failure that was
  -- paid for.
  CONSTRAINT "streak_runs_failed_has_failure"
    CHECK ("status" <> 'failed' OR "failed_at" IS NOT NULL),
  -- A win carries its timestamp and its payout, and nothing else may.
  CONSTRAINT "streak_runs_won_is_complete" CHECK (
    ("status" = 'won' AND "completed_at" IS NOT NULL AND "payout_points" IS NOT NULL)
    OR
    ("status" <> 'won' AND "completed_at" IS NULL AND "payout_points" IS NULL)
  )
);

CREATE INDEX "streak_runs_user_exercise_created_at_idx"
  ON "streak_runs" ("user_id", "exercise_type", "created_at" DESC);

-- At most one active run per (user, exercise). This is what makes "the run
-- that matters" a well-defined question at every moment, and it is enforced
-- by the database rather than by streak_start()'s guard alone, because the
-- guard runs before an INSERT that two callers could race.
CREATE UNIQUE INDEX "streak_runs_one_active_per_exercise"
  ON "streak_runs" ("user_id", "exercise_type")
  WHERE "status" = 'active';

CREATE TABLE "streak_stage_attempts" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id"     UUID NOT NULL,
  "stage"      INTEGER NOT NULL,
  -- 1 for the first go at this stage, 2+ for each buy-back into it. Makes
  -- "how many times did you pay for stage 3" a read rather than a count.
  "attempt_no" INTEGER NOT NULL,
  "match_id"   UUID NOT NULL,
  -- Whether a stake was charged for this attempt. True for every buy-back,
  -- false for stage 1 of a run (covered by the initial stake) and for
  -- advancing into stages 2 and 3.
  "is_buy_back" BOOLEAN NOT NULL DEFAULT false,

  "score"      INTEGER,
  "passed"     BOOLEAN,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "settled_at" TIMESTAMPTZ,

  CONSTRAINT "streak_stage_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "streak_stage_attempts_match_id_key" UNIQUE ("match_id"),
  CONSTRAINT "streak_stage_attempts_run_stage_attempt_key"
    UNIQUE ("run_id", "stage", "attempt_no"),
  CONSTRAINT "streak_stage_attempts_run_id_fkey" FOREIGN KEY ("run_id")
      REFERENCES "streak_runs"("id") ON DELETE CASCADE,
  CONSTRAINT "streak_stage_attempts_match_id_fkey" FOREIGN KEY ("match_id")
      REFERENCES "matches"("id") ON DELETE CASCADE,
  CONSTRAINT "streak_stage_attempts_stage_range" CHECK ("stage" BETWEEN 1 AND 3),
  CONSTRAINT "streak_stage_attempts_attempt_no_positive" CHECK ("attempt_no" >= 1),
  CONSTRAINT "streak_stage_attempts_settled_is_complete" CHECK (
    ("settled_at" IS NULL AND "score" IS NULL AND "passed" IS NULL)
    OR
    ("settled_at" IS NOT NULL AND "score" IS NOT NULL AND "passed" IS NOT NULL)
  )
);

CREATE INDEX "streak_stage_attempts_run_id_idx" ON "streak_stage_attempts" ("run_id");

-- One unsettled attempt per run at a time. Without this a client that called
-- streak_next_stage() twice would open two camera rounds against one stage,
-- and the second would settle against a run that had already moved on.
CREATE UNIQUE INDEX "streak_stage_attempts_one_open_per_run"
  ON "streak_stage_attempts" ("run_id")
  WHERE "settled_at" IS NULL;

-- ----------------------------------------------------------------------------
-- 6. RLS: read your own runs, write nothing
-- ----------------------------------------------------------------------------

ALTER TABLE "blitz_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "streak_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "streak_stage_attempts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "blitz_runs_select_own" ON "blitz_runs"
  FOR SELECT USING ("user_id" = auth.uid());

CREATE POLICY "streak_runs_select_own" ON "streak_runs"
  FOR SELECT USING ("user_id" = auth.uid());

-- Via the run's owner, not via the match: the same SECURITY DEFINER-helper
-- shape the 20260904000000 fix established, so the policy never queries a
-- table that has a policy on it. streak_runs does have one, so the lookup
-- goes through a definer function.
CREATE OR REPLACE FUNCTION public.owns_streak_run(p_run_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "streak_runs" WHERE "id" = p_run_id AND "user_id" = auth.uid()
  );
$$;
REVOKE ALL ON FUNCTION public.owns_streak_run(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owns_streak_run(uuid) TO authenticated;

CREATE POLICY "streak_stage_attempts_select_own" ON "streak_stage_attempts"
  FOR SELECT USING (public.owns_streak_run("run_id"));

-- Supabase's default privileges hand `authenticated` full DML on a new
-- table; RLS with no INSERT/UPDATE/DELETE policy already blocks all three,
-- but the grants are revoked as well so the intent is visible in \dp rather
-- than inferred from the absence of a policy.
REVOKE INSERT, UPDATE, DELETE ON "blitz_runs" FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON "streak_runs" FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON "streak_stage_attempts" FROM anon, authenticated;
REVOKE ALL ON "blitz_runs" FROM anon;
REVOKE ALL ON "streak_runs" FROM anon;
REVOKE ALL ON "streak_stage_attempts" FROM anon;

-- ----------------------------------------------------------------------------
-- 7. Opening a solo bout
--
-- A solo mode reuses the ENTIRE existing bout pipeline -- challenge, match,
-- participant, verification session, anomaly gate, points ledger, Results
-- screen, bout history -- with one seat instead of two. That is the whole
-- design decision, and it is worth being explicit about why, because a pair
-- of dedicated tables would have been less coupled:
--
--   * submit_verification_session() is the ONLY path a camera result can
--     reach the database by, and it takes a match_participant_id. A solo
--     mode that did not create one would need a second verification entry
--     point, a second anomaly gate, and a second thing to keep in step with
--     the first.
--   * points_ledger_entries.match_id is how every existing surface (the
--     Results screen, Transactions, deriveBoutStats) attributes a stake and
--     a payout to a contest.
--   * the open-round guard, which stops a fighter abandoning a staked round
--     and starting another, is written over matches / match_participants.
--     Solo rounds get it for free, in both directions.
--
-- The challenge is created already `matched` rather than `open`: there is no
-- lobby, nothing to search, and an `open` one-seat challenge would be
-- visible to _mm_find_lobby()'s status filter. It is also why
-- challenges_select_visible (status <> 'open' OR is_lobby_member) does not
-- need touching.
-- ----------------------------------------------------------------------------

-- Everything a solo start must be true of before any row is written, and
-- before the profile row is locked. Plain reads only, matching
-- enter_matchmaking()'s pre-lock section.
CREATE OR REPLACE FUNCTION public._solo_start_guard(
  p_user uuid, p_exercise "ChallengeType", p_stake integer
) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  IF p_exercise NOT IN ('pushups', 'plank', 'wallsit') THEN
    RAISE EXCEPTION 'exercise_not_available';
  END IF;
  -- The same four presets the queue accepts. A solo mode has no lobby to be
  -- unmatchable in, but keeping one stake ladder across every mode is what
  -- makes a points balance mean one thing.
  IF p_stake IS NULL OR NOT (p_stake = ANY (public._mm_stake_options())) THEN
    RAISE EXCEPTION 'stake_invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "fitness_profiles" WHERE "user_id" = p_user) THEN
    RAISE EXCEPTION 'profile_required';
  END IF;
  -- Identical to enter_matchmaking()'s guard, and deliberately shared with
  -- it: a staked round you have not played blocks starting ANY new bout,
  -- solo or not. Without this, Blitz would be the way to hold six open
  -- stakes at once.
  IF EXISTS (
    SELECT 1
      FROM "match_participants" mp
      JOIN "matches" m ON m."id" = mp."match_id"
     WHERE mp."user_id" = p_user
       AND m."settled_at" IS NULL
       AND m."created_at" > now() - public._mm_open_round_blocks_for()
       AND NOT EXISTS (
         SELECT 1 FROM "verification_sessions" vs
          WHERE vs."match_participant_id" = mp."id")
  ) THEN
    RAISE EXCEPTION 'round_open';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._solo_start_guard(uuid, "ChallengeType", integer)
  FROM PUBLIC, anon, authenticated;

-- Create the one-seat challenge, its match and its participant, debit the
-- stake and write the ledger entry. Returns the match id.
--
-- The caller MUST already hold the fighter's fitness_profiles row FOR UPDATE
-- and have checked the balance under that lock -- this function debits
-- without re-checking, exactly as _mm_try_complete() debits after its own
-- locked check. p_charge exists for advancing a streak into stage 2 or 3,
-- which opens a round without taking another stake.
CREATE OR REPLACE FUNCTION public._solo_open_match(
  p_user uuid,
  p_exercise "ChallengeType",
  p_format "ChallengeFormat",
  p_stake integer,
  p_is_ranked boolean,
  p_charge boolean
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_challenge uuid;
  v_match uuid;
BEGIN
  IF p_format NOT IN ('blitz', 'streak') THEN
    RAISE EXCEPTION '_solo_open_match called with non-solo format %', p_format;
  END IF;

  INSERT INTO "challenges"
    ("id", "type", "format", "stake_points", "max_participants", "status",
     "created_by", "is_ranked")
    VALUES (gen_random_uuid(), p_exercise, p_format, p_stake, 1, 'matched',
            p_user, p_is_ranked)
    RETURNING "id" INTO v_challenge;

  INSERT INTO "matches" ("id", "challenge_id")
    VALUES (gen_random_uuid(), v_challenge)
    RETURNING "id" INTO v_match;

  INSERT INTO "match_participants" ("id", "match_id", "user_id")
    VALUES (gen_random_uuid(), v_match, p_user);

  IF p_charge THEN
    UPDATE "fitness_profiles"
       SET "points_balance" = "points_balance" - p_stake
     WHERE "user_id" = p_user;
    INSERT INTO "points_ledger_entries"
      ("id", "user_id", "amount", "reason", "match_id")
      VALUES (gen_random_uuid(), p_user, -p_stake, 'stake', v_match);
  END IF;

  RETURN v_match;
END;
$$;
REVOKE ALL ON FUNCTION public._solo_open_match(
  uuid, "ChallengeType", "ChallengeFormat", integer, boolean, boolean)
  FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 8. Blitz
--
-- The preview is a separate read from the start, and has to be: the pre-bout
-- screen shows the ladder BEFORE a stake is committed, which is the entire
-- point of it. Nothing is written, nothing is locked, and calling it a
-- hundred times costs a hundred percentile lookups and no rows.
-- ----------------------------------------------------------------------------

CREATE TYPE public.blitz_preview_row AS (
  "exercise_type"      "ChallengeType",
  "mmr"                INTEGER,
  "placement_complete" BOOLEAN,
  -- True when gender AND age_band are both on file, i.e. when the ladder was
  -- calibrated against the fighter's own population rather than the
  -- gender-mean of the default band. The pre-bout screen says so.
  "calibrated_to_me"   BOOLEAN,
  "tier1_target"       INTEGER,
  "tier2_target"       INTEGER,
  "tier3_target"       INTEGER,
  "tier1_rating"       INTEGER,
  "tier2_rating"       INTEGER,
  "tier3_rating"       INTEGER,
  "tier1_bp"           INTEGER,
  "tier2_bp"           INTEGER,
  "tier3_bp"           INTEGER
);

-- The ladder, and the ratings behind it. Shared by blitz_preview() and
-- blitz_start() so the screen and the row can never disagree about what was
-- offered.
--
-- ROUNDING CAN COLLIDE. Two adjacent tiers can round to the same number --
-- most easily on a hold, where the step is 5 seconds, at a low rating where
-- the percentile curve is flat. A ladder with two equal rungs would pay 2x
-- for clearing the 1.5x bar, so each tier is forced at least one step above
-- the one below it. That makes the printed ladder strictly ascending
-- (blitz_runs_targets_ascending) at the cost of making the nudged tier
-- very slightly harder than its nominal rating -- which is the right way
-- round: the fighter is never paid more than the bar they cleared.
CREATE OR REPLACE FUNCTION public._blitz_ladder(
  p_exercise "ChallengeType", p_mmr integer, p_gender "Gender", p_age_band "AgeBand"
) RETURNS integer[]
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_off  integer[] := public._solo_blitz_tier_offsets();
  v_step integer   := public._solo_round_step(p_exercise);
  v_t    integer[];
  i      integer;
BEGIN
  FOR i IN 1 .. 3 LOOP
    v_t[i] := public._solo_target_for_rating(
      p_exercise, p_mmr + v_off[i], p_gender, p_age_band);
    IF v_t[i] IS NULL THEN
      RETURN NULL;
    END IF;
    IF i > 1 THEN
      v_t[i] := greatest(v_t[i], v_t[i - 1] + v_step);
    END IF;
  END LOOP;
  RETURN v_t;
END;
$$;
REVOKE ALL ON FUNCTION public._blitz_ladder("ChallengeType", integer, "Gender", "AgeBand")
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
  v_off    integer[] := public._solo_blitz_tier_offsets();
  v_bp     integer[] := public._solo_blitz_tier_bp();
  v_t      integer[];
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

  -- Creating the rating row here rather than at start time means the ladder
  -- a first-timer is shown is the same ladder they will be started on: the
  -- seed, 1000, and not a rating that springs into existence between the
  -- preview and the tap.
  v_rating := public._mmr_ensure(v_user, p_exercise);

  v_t := public._blitz_ladder(p_exercise, v_rating."mmr", v_gender, v_band);
  IF v_t IS NULL THEN
    RAISE EXCEPTION 'calibration_unavailable';
  END IF;

  v_out."exercise_type"      := p_exercise;
  v_out."mmr"                := v_rating."mmr";
  v_out."placement_complete" := v_rating."placement_complete";
  v_out."calibrated_to_me"   := v_gender IS NOT NULL AND v_band IS NOT NULL;
  v_out."tier1_target" := v_t[1];
  v_out."tier2_target" := v_t[2];
  v_out."tier3_target" := v_t[3];
  v_out."tier1_rating" := v_rating."mmr" + v_off[1];
  v_out."tier2_rating" := v_rating."mmr" + v_off[2];
  v_out."tier3_rating" := v_rating."mmr" + v_off[3];
  v_out."tier1_bp" := v_bp[1];
  v_out."tier2_bp" := v_bp[2];
  v_out."tier3_bp" := v_bp[3];
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.blitz_preview("ChallengeType") FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.blitz_preview("ChallengeType") TO authenticated;

-- Stake it and open the round. Returns the run, which carries the match_id
-- the client pushes MatchInProgress with.
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
  v_off     integer[] := public._solo_blitz_tier_offsets();
  v_bp      integer[] := public._solo_blitz_tier_bp();
  v_t       integer[];
  v_match   uuid;
  v_run     "blitz_runs"%ROWTYPE;
BEGIN
  PERFORM public._solo_start_guard(v_user, p_exercise, p_stake);

  -- The one lock this function takes, and the authoritative balance check.
  SELECT "points_balance", "gender", "age_band"
    INTO v_balance, v_gender, v_band
    FROM "fitness_profiles" WHERE "user_id" = v_user FOR UPDATE;
  IF v_balance < p_stake THEN
    RAISE EXCEPTION 'insufficient_points';
  END IF;

  v_rating := public._mmr_ensure(v_user, p_exercise);
  v_t := public._blitz_ladder(p_exercise, v_rating."mmr", v_gender, v_band);
  IF v_t IS NULL THEN
    RAISE EXCEPTION 'calibration_unavailable';
  END IF;

  v_match := public._solo_open_match(
    v_user, p_exercise, 'blitz', p_stake, coalesce(p_is_ranked, false), true);

  INSERT INTO "blitz_runs"
    ("user_id", "match_id", "exercise_type", "stake_points", "is_ranked",
     "mmr_at_start",
     "tier1_target", "tier2_target", "tier3_target",
     "tier1_rating", "tier2_rating", "tier3_rating",
     "tier1_bp", "tier2_bp", "tier3_bp")
    VALUES (v_user, v_match, p_exercise, p_stake, coalesce(p_is_ranked, false),
            v_rating."mmr",
            v_t[1], v_t[2], v_t[3],
            v_rating."mmr" + v_off[1], v_rating."mmr" + v_off[2], v_rating."mmr" + v_off[3],
            v_bp[1], v_bp[2], v_bp[3])
    RETURNING * INTO v_run;

  RETURN v_run;
END;
$$;
REVOKE ALL ON FUNCTION public.blitz_start("ChallengeType", integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.blitz_start("ChallengeType", integer, boolean) TO authenticated;

-- ----------------------------------------------------------------------------
-- 9. Streak
--
-- One composite shape answers every question the mode's screens ask --
-- "what are the targets", "am I mid-run", "can I buy back in and for how
-- long", "am I cooled down and until when" -- because they are all the same
-- question about the same row and splitting them would let the screen render
-- two inconsistent halves of one state.
--
-- THE RUN THAT MATTERS is defined as the most recent run for (user,
-- exercise), and every state below is derived from it:
--
--   no run at all                          -> 'idle'
--   status active                          -> 'active'  (+ pending_match_id
--                                             when a round is open)
--   status failed, inside the window       -> 'failed'   (buy-back offered)
--   status failed, past the window          -> 'expired'  (start over at 1)
--   status won,   inside the cooldown      -> 'cooldown' (mode locked)
--   status won,   past the cooldown        -> 'idle'
--
-- 'expired' and 'cooldown' are DERIVED, never stored. A stored deadline
-- would have to be migrated every time a tunable moved, and a stored
-- "expired" status would need a cron to set it.
-- ----------------------------------------------------------------------------

CREATE TYPE public.streak_preview_row AS (
  "exercise_type"      "ChallengeType",
  "mmr"                INTEGER,
  "placement_complete" BOOLEAN,
  "calibrated_to_me"   BOOLEAN,
  -- The ladder. For an active/failed run these are the run's SNAPSHOT, not a
  -- fresh calibration -- the screen must show the bar that was agreed to.
  "stage1_target"      INTEGER,
  "stage2_target"      INTEGER,
  "stage3_target"      INTEGER,
  "stage1_rating"      INTEGER,
  "stage2_rating"      INTEGER,
  "stage3_rating"      INTEGER,
  "payout_bp"          INTEGER,
  -- 'idle' | 'active' | 'failed' | 'expired' | 'cooldown'
  "state"              TEXT,
  "run_id"             UUID,
  "is_ranked"          BOOLEAN,
  "stake_points"       INTEGER,
  "stakes_paid"        INTEGER,
  "current_stage"      INTEGER,
  "failed_stage"       INTEGER,
  "failed_at"          TIMESTAMPTZ,
  -- failed_at + _streak_buyback_window(), for the countdown. Set whenever
  -- failed_at is, including on a run that has already been bought back into,
  -- so the client can always show which failure the clock belongs to.
  "buyback_until"      TIMESTAMPTZ,
  "completed_at"       TIMESTAMPTZ,
  -- completed_at + _streak_win_cooldown().
  "cooldown_until"     TIMESTAMPTZ,
  "payout_points"      INTEGER,
  -- The open camera round for the current stage, if one has been opened.
  "pending_match_id"   UUID,
  -- now() as the server sees it. Both countdowns are rendered against this
  -- rather than against the phone's clock, so a device with a skewed clock
  -- shows the real remaining time instead of its own idea of it.
  "server_now"         TIMESTAMPTZ
);

-- Turn one (optional) run row plus a fresh calibration into the shape above.
-- Shared by every streak RPC so "what state am I in" is decided in exactly
-- one place.
CREATE OR REPLACE FUNCTION public._streak_view(
  p_user uuid, p_exercise "ChallengeType"
) RETURNS public.streak_preview_row
-- Deliberately VOLATILE (the default), unlike the calibration helpers it
-- calls. streak_start(), streak_next_stage() and streak_buy_back_in() all
-- return this view of the state they have just written, in the same
-- transaction; a VOLATILE function takes a fresh snapshot on every call, so
-- it cannot possibly answer with the state as it was before the write.
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

  v_out."exercise_type"      := p_exercise;
  v_out."mmr"                := coalesce(v_rating."mmr", public._mmr_seed());
  v_out."placement_complete" := coalesce(v_rating."placement_complete", false);
  v_out."calibrated_to_me"   := v_gender IS NOT NULL AND v_band IS NOT NULL;
  v_out."payout_bp"          := public._solo_streak_payout_bp();
  v_out."server_now"         := now();

  -- A fresh ladder. Overwritten below by the snapshot if a run is live.
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

  v_out."stage1_target" := v_t[1];
  v_out."stage2_target" := v_t[2];
  v_out."stage3_target" := v_t[3];
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

  -- The snapshot wins for anything still in play. A won or expired run is
  -- history, so the fresh ladder above is what the next attempt would face.
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

CREATE OR REPLACE FUNCTION public.streak_preview(p_exercise "ChallengeType")
RETURNS public.streak_preview_row
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_out  public.streak_preview_row;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  IF p_exercise NOT IN ('pushups', 'plank', 'wallsit') THEN
    RAISE EXCEPTION 'exercise_not_available';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "fitness_profiles" WHERE "user_id" = v_user) THEN
    RAISE EXCEPTION 'profile_required';
  END IF;

  PERFORM public._mmr_ensure(v_user, p_exercise);

  v_out := public._streak_view(v_user, p_exercise);
  IF v_out IS NULL THEN
    RAISE EXCEPTION 'calibration_unavailable';
  END IF;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.streak_preview("ChallengeType") FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.streak_preview("ChallengeType") TO authenticated;

-- Stake once, open stage 1.
--
-- A failed run inside its buy-back window does NOT block this. Starting over
-- is always allowed; the window is an offer, not an obligation, and the new
-- run becomes "the run that matters" the instant it is inserted, so the old
-- offer simply stops being made. What DOES block:
--   * an active run in this exercise (the partial unique index enforces it
--     even against a race the guard below loses);
--   * a won run still inside its cooldown.
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
            v_t[1], v_t[2], v_t[3],
            v_rating."mmr" + v_off[1], v_rating."mmr" + v_off[2], v_rating."mmr" + v_off[3],
            public._solo_streak_payout_bp(), 'active', 1, 1)
    RETURNING * INTO v_run;

  -- The stake is charged here, once, for the whole run.
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

-- Open the camera round for the stage the run is already on. No stake: the
-- run was paid for at the start. This is what the "next stage" button on the
-- stage-cleared screen calls, and it is a separate RPC from settlement on
-- purpose -- settlement advancing the stage AND opening the next round would
-- put a fighter into an open staked round without them tapping anything,
-- while they were still reading the number they had just hit.
CREATE OR REPLACE FUNCTION public.streak_next_stage(p_run_id uuid)
RETURNS public.streak_preview_row
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_run   "streak_runs"%ROWTYPE;
  v_next  integer;
  v_match uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;

  SELECT * INTO v_run FROM "streak_runs"
   WHERE "id" = p_run_id AND "user_id" = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'streak_run_not_found';
  END IF;
  IF v_run."status" <> 'active' THEN
    RAISE EXCEPTION 'streak_run_not_active';
  END IF;

  -- Idempotent: a double tap, or a screen remounting, finds the round it
  -- already opened rather than opening a second one (which the partial
  -- unique index would reject anyway).
  IF EXISTS (
    SELECT 1 FROM "streak_stage_attempts"
     WHERE "run_id" = v_run."id" AND "settled_at" IS NULL
  ) THEN
    RETURN public._streak_view(v_user, v_run."exercise_type");
  END IF;

  SELECT coalesce(max(a."attempt_no"), 0) + 1 INTO v_next
    FROM "streak_stage_attempts" a
   WHERE a."run_id" = v_run."id" AND a."stage" = v_run."current_stage";

  v_match := public._solo_open_match(
    v_user, v_run."exercise_type", 'streak', v_run."stake_points",
    v_run."is_ranked", false);

  INSERT INTO "streak_stage_attempts"
    ("run_id", "stage", "attempt_no", "match_id", "is_buy_back")
    VALUES (v_run."id", v_run."current_stage", v_next, v_match, false);

  RETURN public._streak_view(v_user, v_run."exercise_type");
END;
$$;
REVOKE ALL ON FUNCTION public.streak_next_stage(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.streak_next_stage(uuid) TO authenticated;

-- Pay another stake to retry the stage that was just failed, keeping every
-- stage already cleared. Only inside _streak_buyback_window() of failed_at.
--
-- The window is checked against now() on the SERVER, under the run's row
-- lock, so two devices racing the last second of it cannot both get in.
CREATE OR REPLACE FUNCTION public.streak_buy_back_in(p_run_id uuid)
RETURNS public.streak_preview_row
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_run     "streak_runs"%ROWTYPE;
  v_balance integer;
  v_next    integer;
  v_match   uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;

  SELECT * INTO v_run FROM "streak_runs"
   WHERE "id" = p_run_id AND "user_id" = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'streak_run_not_found';
  END IF;
  IF v_run."status" <> 'failed' THEN
    RAISE EXCEPTION 'streak_run_not_failed';
  END IF;
  IF now() > v_run."failed_at" + public._streak_buyback_window() THEN
    RAISE EXCEPTION 'streak_buyback_expired';
  END IF;

  -- Same guard as a fresh start: a staked round you have not played blocks
  -- opening another one, even your own.
  PERFORM public._solo_start_guard(v_user, v_run."exercise_type", v_run."stake_points");

  SELECT "points_balance" INTO v_balance
    FROM "fitness_profiles" WHERE "user_id" = v_user FOR UPDATE;
  IF v_balance < v_run."stake_points" THEN
    RAISE EXCEPTION 'insufficient_points';
  END IF;

  -- current_stage is left exactly where it was -- that is what "without
  -- losing progress" means -- and failed_at / failed_stage are left in place
  -- as the record of what was bought back into.
  UPDATE "streak_runs"
     SET "status" = 'active',
         "stakes_paid" = "stakes_paid" + 1,
         "updated_at" = now()
   WHERE "id" = v_run."id";

  SELECT coalesce(max(a."attempt_no"), 0) + 1 INTO v_next
    FROM "streak_stage_attempts" a
   WHERE a."run_id" = v_run."id" AND a."stage" = v_run."current_stage";

  v_match := public._solo_open_match(
    v_user, v_run."exercise_type", 'streak', v_run."stake_points",
    v_run."is_ranked", true);

  INSERT INTO "streak_stage_attempts"
    ("run_id", "stage", "attempt_no", "match_id", "is_buy_back")
    VALUES (v_run."id", v_run."current_stage", v_next, v_match, true);

  RETURN public._streak_view(v_user, v_run."exercise_type");
END;
$$;
REVOKE ALL ON FUNCTION public.streak_buy_back_in(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.streak_buy_back_in(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- 10. Rating a solo attempt: the virtual opponent
--
-- _mmr_rate_match() decomposes a bout into pairwise comparisons of the
-- fighters in it. A solo attempt has exactly one comparison, and the other
-- side of it is a number rather than a person: the rating the threshold was
-- calibrated from.
--
-- Everything else is the SAME Elo as a 1v1 -- literally the same
-- _mmr_expected(), the same K schedule, the same floor, the same
-- skill_rating_events row -- because the point of the virtual opponent is
-- that a solo result is commensurable with a head-to-head one. A fighter who
-- clears their own bar gains what beating an equal opponent gains. A fighter
-- who misses it loses what losing to an equal opponent loses.
--
-- WHAT IS DIFFERENT, and deliberately:
--   * participants = 1 on the event row. There is no (N-1) divisor to apply
--     (one comparison, so it would be division by 1 in any case), and the
--     column records the truth about the bout rather than being padded to 2.
--   * MMR is not conserved. It already was not -- K is per fighter, so a
--     placement bout against a settled one moves the two by different
--     amounts -- but a solo attempt has nobody on the other side to take the
--     other half at all. The virtual opponent's rating does not move,
--     because it is not a rating, it is a bar.
--
-- Called ONLY for a ranked attempt. A casual one never reaches here, so it
-- writes no skill_ratings row, no event, and does not increment
-- matches_played -- which is what makes "only ranked attempts count toward
-- placement" true by construction rather than by a second rule somewhere.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._mmr_rate_solo(
  p_match_id uuid,
  p_user_id uuid,
  p_exercise "ChallengeType",
  p_opponent_rating integer,
  p_cleared boolean
) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_rating "skill_ratings"%ROWTYPE;
  v_k      integer;
  v_s      numeric;
  v_delta  integer;
  v_after  integer;
BEGIN
  PERFORM public._mmr_ensure(p_user_id, p_exercise);

  -- Last in the lock order, exactly as _mmr_rate_match() takes it.
  SELECT * INTO v_rating FROM "skill_ratings"
   WHERE "user_id" = p_user_id AND "exercise_type" = p_exercise
   FOR UPDATE;

  v_k := CASE WHEN v_rating."placement_complete"
              THEN public._mmr_k_settled()
              ELSE public._mmr_k_placement() END;
  v_s := CASE WHEN p_cleared THEN 1::numeric ELSE 0::numeric END;

  v_delta := round(
    v_k::numeric * (v_s - public._mmr_expected(v_rating."mmr", p_opponent_rating))
  )::integer;
  v_after := greatest(public._mmr_floor(), v_rating."mmr" + v_delta);
  -- Re-derive from the clamp so the event row always describes the change
  -- that actually happened.
  v_delta := v_after - v_rating."mmr";

  UPDATE "skill_ratings"
     SET "mmr" = v_after,
         "matches_played" = "matches_played" + 1,
         "updated_at" = now()
   WHERE "user_id" = p_user_id AND "exercise_type" = p_exercise;

  INSERT INTO "skill_rating_events"
    ("user_id", "match_id", "exercise_type", "mmr_before", "mmr_after",
     "delta", "k_factor", "was_placement", "matches_played", "participants")
    VALUES (
      p_user_id, p_match_id, p_exercise, v_rating."mmr", v_after,
      v_delta, v_k,
      v_rating."matches_played" < public._mmr_placement_bouts(),
      v_rating."matches_played" + 1,
      1
    );
END;
$$;
REVOKE ALL ON FUNCTION public._mmr_rate_solo(uuid, uuid, "ChallengeType", integer, boolean)
  FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 11. Solo settlement
--
-- Reached from settle_match() once every shared guard has passed (see
-- section 12). By the time this runs it is already known that: the caller is
-- the participant or the service role, the match is unsettled, the seat count
-- matches, a verification session exists, the exercise is one of the three,
-- and the score column for that exercise is not NULL.
--
-- What it does NOT do, in both modes, and on purpose:
--
--   * no trophies, no total_wins / total_losses / total_ties, no
--     current_streak, no rank_history row. _rank_apply_match() is not
--     called. The trophy ladder is the record of beating PEOPLE -- it feeds
--     the public leaderboard and the wager ceiling -- and a bar you set for
--     yourself is not a person. This is a product decision, stated here
--     because its absence would otherwise read as an oversight; flipping it
--     would be one _rank_apply_match() call, and would need a winners array
--     that makes sense for one seat.
--   * no rating at all unless the challenge is ranked.
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
  v_tier      integer;
  v_bp        integer;
  v_payout    integer := 0;
  v_target    integer;
  v_rating    integer;
  v_cleared   boolean;
  v_winner    uuid;
BEGIN
  SELECT mp."user_id",
         CASE WHEN p_challenge."type" = 'pushups'
              THEN mp."rep_count" ELSE mp."hold_duration_seconds" END
    INTO v_user, v_score
    FROM "match_participants" mp
   WHERE mp."match_id" = p_match_id;

  -- The same anomaly gate the head-to-head path applies to its winners,
  -- applied to the only fighter there is. No payout, no rating, and
  -- settled_at stays NULL so a later call after `reviewed` can settle this
  -- properly. A streak run stays 'active' at the same stage while that is
  -- true, and its open attempt keeps the run's one open-attempt slot -- i.e.
  -- a fighter under review is stuck on that stage until it clears, which is
  -- the same bargain a held 1v1 pot makes.
  SELECT bool_or(vs."anomaly_flag" AND NOT vs."reviewed") INTO v_blocked
    FROM "match_participants" mp
    JOIN "verification_sessions" vs ON vs."match_participant_id" = mp."id"
   WHERE mp."match_id" = p_match_id;

  IF coalesce(v_blocked, false) THEN
    UPDATE "challenges" SET "status" = 'needs_review' WHERE "id" = p_challenge."id";
    RETURN 'needs_review';
  END IF;

  -- The payout target, locked before anything is credited. One row, so the
  -- ORDER BY user_id the lock order calls for is trivially satisfied.
  PERFORM 1 FROM "fitness_profiles" WHERE "user_id" = v_user FOR UPDATE;

  IF p_challenge."format" = 'blitz' THEN
    SELECT * INTO v_run FROM "blitz_runs" WHERE "match_id" = p_match_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'blitz match % has no run row', p_match_id;
    END IF;

    -- Highest threshold cleared wins; the ladder is strictly ascending, so
    -- this is an ordered chain and not three independent tests.
    v_tier := CASE
      WHEN v_score >= v_run."tier3_target" THEN 3
      WHEN v_score >= v_run."tier2_target" THEN 2
      WHEN v_score >= v_run."tier1_target" THEN 1
      ELSE 0 END;
    v_bp := CASE v_tier
      WHEN 3 THEN v_run."tier3_bp"
      WHEN 2 THEN v_run."tier2_bp"
      WHEN 1 THEN v_run."tier1_bp"
      ELSE 0 END;
    -- Integer arithmetic throughout, and the division truncates: a payout is
    -- never rounded UP into points that were not staked by anyone.
    v_payout := (v_run."stake_points"::bigint * v_bp / 10000)::integer;

    IF v_payout > 0 THEN
      UPDATE "fitness_profiles"
         SET "points_balance" = "points_balance" + v_payout
       WHERE "user_id" = v_user;
      INSERT INTO "points_ledger_entries"
        ("id", "user_id", "amount", "reason", "match_id")
        VALUES (gen_random_uuid(), v_user, v_payout, 'payout', p_match_id);
    END IF;

    v_cleared := v_tier >= 1;
    -- Tier 1 is the rated bar. Tiers 2 and 3 pay more but rate the same, for
    -- exactly the reason a 40-29 win rates the same as 40-5 in a 1v1: this
    -- system does not weight margin of victory (20260909000000, and
    -- BACKEND.md "Deliberately not built"). Rating the top tier cleared
    -- instead would make Blitz the one place margin counted.
    v_rating := v_run."tier1_rating";

    UPDATE "blitz_runs"
       SET "score" = v_score,
           "tier_reached" = v_tier,
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
      -- Advance, but do NOT open the next round: streak_next_stage() does
      -- that, when the fighter asks for it.
      UPDATE "streak_runs"
         SET "current_stage" = v_attempt."stage" + 1,
             "updated_at" = now()
       WHERE "id" = v_srun."id";
    ELSE
      -- TIMER 1 starts here, and nowhere else.
      UPDATE "streak_runs"
         SET "status" = 'failed',
             "failed_stage" = v_attempt."stage",
             "failed_at" = now(),
             "updated_at" = now()
       WHERE "id" = v_srun."id";
    END IF;
  END IF;

  -- One Elo update per attempt, against the bar's rating. A streak stage
  -- attempt is an attempt, so a buy-back into the same stage rates again --
  -- the spec's "one per stage attempt, including retries" is this line
  -- sitting inside a function that runs once per stage match.
  IF p_challenge."is_ranked" THEN
    PERFORM public._mmr_rate_solo(
      p_match_id, v_user, p_challenge."type", v_rating, v_cleared);
  END IF;

  -- Clearing the bar is the win. For Blitz that is tier 1 or better; for
  -- Streak it is the stage's own target, whether or not it was the last one.
  -- The client reads solo outcomes off this column alone rather than off the
  -- ledger, because an advancing stage moves no points at all.
  v_winner := CASE WHEN v_cleared THEN v_user ELSE NULL END;

  UPDATE "matches" SET "winner_id" = v_winner, "settled_at" = now()
   WHERE "id" = p_match_id;
  UPDATE "challenges" SET "status" = 'completed' WHERE "id" = p_challenge."id";

  RETURN 'settled';
END;
$fn$;
REVOKE ALL ON FUNCTION public._solo_settle(uuid, "challenges") FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 12. settle_match(), with the solo fork and the casual skip
--
-- Verbatim from 20260913000000 apart from two changes, both marked below:
--
--   * a fork to _solo_settle() placed AFTER every shared guard (auth, the
--     settled_at latch, the seat count, the submitted count, the exercise
--     check and the NULL-score check) and BEFORE the head-to-head-specific
--     work of finding v_best and v_winners. Everything above the fork is
--     equally true of one seat; everything below it assumes at least two.
--   * the _mmr_rate_match() call is now conditional on is_ranked.
--     _rank_apply_match() is NOT -- see below.
--
-- WHY CASUAL SKIPS THE RATING AND NOT THE TROPHIES. The spec for casual is
-- precise: a casual bout "does not affect MMR, matches_played, or
-- placement". Those three are exactly the three columns of skill_ratings, so
-- casual is implemented as exactly one thing: skill_ratings is not written.
-- Trophies, the W/L record and the streak live on fitness_profiles and are
-- the OTHER ladder (20260913000000, "Why two ladders is not one ladder too
-- many"); they are not in that list and they still move.
--
-- That is a defensible reading and it is not the only one -- "casual"
-- arguably ought to keep a bout off the public leaderboard too. FLIPPING IT
-- IS ONE LINE: wrap the _rank_apply_match() call in the same
-- `IF v_challenge.is_ranked` as the rating. It is called out in BACKEND.md
-- under "What casual does and does not touch" so the decision is visible
-- rather than buried here.
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
  -- race here. It is also what makes the rating and trophy writes exactly-once.
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

  -- The normal "someone finished first" case. Not an error. For a solo mode
  -- it means the camera round has not been recorded yet.
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

  -- ADDED IN 20260916000100: the solo fork. Everything above is shared;
  -- everything below assumes an opponent exists.
  IF v_challenge.format IN ('blitz', 'streak') THEN
    RETURN public._solo_settle(p_match_id, v_challenge);
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
    -- No ledger entry, no balance change, NO RATING CHANGE, NO TROPHIES, and
    -- settled_at stays NULL so a later call (after reviewed = true) can still
    -- settle this match properly -- rating and crediting it then, from the
    -- standings as they are at that moment rather than as they were before
    -- the review.
    UPDATE "challenges" SET status = 'needs_review' WHERE id = v_challenge.id;
    RETURN 'needs_review';
  END IF;

  v_pot := v_challenge.stake_points * v_challenge.max_participants;
  v_share := v_pot / cardinality(v_winners);
  v_remainder := v_pot - v_share * cardinality(v_winners);

  -- The whole field, not just the winners: the trophy step at the end writes
  -- a fitness_profiles row for every fighter, and every lock it needs has to
  -- be taken here, in user_id order, before the skill_ratings locks further
  -- down.
  PERFORM 1 FROM "fitness_profiles"
    WHERE user_id IN (
      SELECT mp.user_id FROM "match_participants" mp WHERE mp.match_id = p_match_id
    )
    ORDER BY user_id FOR UPDATE;

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

  -- CHANGED IN 20260916000100: only a ranked bout moves ratings. A casual
  -- bout is otherwise identical -- same stakes, same pot, same camera, same
  -- anomaly gate -- and writes no skill_ratings row, no
  -- skill_rating_events row, and no matches_played increment, which is what
  -- keeps it out of placement too.
  IF v_challenge.is_ranked THEN
    PERFORM public._mmr_rate_match(p_match_id, v_challenge.type, v_challenge.max_participants);
  END IF;

  -- Trophies, streak, record and league, from the same winners the pot was
  -- paid to. Deliberately NOT gated on is_ranked -- see the header above.
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
-- 13. Pairing respects the switch
--
-- Ranked and casual are two separate pools. A lobby carries its own
-- is_ranked and only admits fighters who asked for the same thing, because a
-- bout cannot be half-rated: it moves both ratings or neither.
--
-- The DOMAIN KEY is deliberately left alone. It still hashes (exercise,
-- format, seats), so the ranked and casual pools for one exercise serialise
-- against the same advisory lock. That is slightly more contention than
-- splitting it would be, and it is the right trade: the key is recomputed
-- from a queue row in four places (_mm_leave, the heartbeat, and twice in
-- enter_matchmaking), and a key that disagreed with itself across those
-- call sites would be a silent correctness bug, not a slow one. The lock has
-- only ever needed to COVER the lobbies being touched, never to be minimal.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public._mm_find_lobby(
  "ChallengeType", "ChallengeFormat", integer, integer, integer, boolean, timestamptz, uuid);

CREATE OR REPLACE FUNCTION public._mm_find_lobby(
  p_exercise "ChallengeType", p_format "ChallengeFormat", p_max integer,
  p_stake integer, p_is_ranked boolean, p_mmr integer, p_placed boolean,
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
     AND c."is_ranked" = p_is_ranked
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
  "ChallengeType", "ChallengeFormat", integer, integer, boolean, integer, boolean, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;

-- enter_matchmaking() gains p_is_ranked. The old four-argument version is
-- DROPPED rather than left beside it: two overloads reachable over PostgREST
-- is an ambiguity waiting for a client that omits the argument, and the
-- whole point of the switch is that no call site is allowed to be vague
-- about it. The DEFAULT stays casual for the same reason it does everywhere
-- else.
DROP FUNCTION IF EXISTS public.enter_matchmaking(
  "ChallengeType", "ChallengeFormat", integer, integer);

CREATE OR REPLACE FUNCTION public.enter_matchmaking(
  p_exercise_type "ChallengeType",
  p_format "ChallengeFormat",
  p_stake_points integer,
  p_max_participants integer DEFAULT 2,
  p_is_ranked boolean DEFAULT false
) RETURNS "matchmaking_queue"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_ranked boolean := coalesce(p_is_ranked, false);
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
  -- The solo formats never queue: there is nobody to pair with.
  IF p_format NOT IN ('1v1', 'pooled') THEN
    RAISE EXCEPTION 'format_not_queueable';
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
  -- ever search in it. Ensured even for a casual search: the row is what
  -- matchmaking pairs on, and a casual bout is still paired by level. What
  -- casual skips is the UPDATE at settlement, not the existence of a rating.
  v_rating := public._mmr_ensure(v_user, p_exercise_type);

  -- A round of yours is still open in a recent bout: play it first. Solo
  -- rounds count -- they are matches with a stake in them like any other.
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
       AND v_existing."stake_points" = p_stake_points
       AND v_existing."is_ranked" = v_ranked THEN
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
    -- Flipping ranked/casual on the same exercise, format, seats and stake
    -- lands here rather than on the fast path above: it is a DIFFERENT
    -- search, so it replaces the old one and is held to the re-entry floor
    -- exactly as changing the stake is.
    IF v_existing."joined_at" > now() - public._mm_reentry_floor() THEN
      RAISE EXCEPTION 'too_fast';
    END IF;
    PERFORM public._mm_leave(v_existing."id", 'replaced');
  END IF;

  PERFORM public._mm_sweep(p_exercise_type, p_format, p_max_participants);

  v_lobby := public._mm_find_lobby(
    p_exercise_type, p_format, p_max_participants, p_stake_points, v_ranked,
    v_rating."mmr", v_rating."placement_complete", now(), NULL);

  IF v_lobby IS NULL THEN
    INSERT INTO "challenges" ("id", "type", "format", "stake_points", "status", "created_by", "max_participants", "is_ranked")
      VALUES (gen_random_uuid(), p_exercise_type, p_format, p_stake_points, 'open', v_user, p_max_participants, v_ranked)
      RETURNING "id" INTO v_lobby;
  END IF;

  INSERT INTO "matchmaking_queue"
    ("user_id", "exercise_type", "format", "max_participants", "stake_points",
     "strength_tier", "mmr", "placement_complete", "challenge_id", "is_ranked")
    VALUES (v_user, p_exercise_type, p_format, p_max_participants, p_stake_points,
            v_tier, v_rating."mmr", v_rating."placement_complete", v_lobby, v_ranked)
    RETURNING * INTO v_row;
  INSERT INTO "matchmaking_presence" ("queue_id") VALUES (v_row."id");

  PERFORM public._mm_try_complete(v_lobby);

  SELECT * INTO v_row FROM "matchmaking_queue" WHERE "id" = v_row."id";
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.enter_matchmaking("ChallengeType", "ChallengeFormat", integer, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enter_matchmaking("ChallengeType", "ChallengeFormat", integer, integer, boolean) TO authenticated;

-- Verbatim from 20260909000000 apart from the is_ranked argument threaded
-- into the _mm_find_lobby() call: a widening entry may only move into a
-- lobby in its own pool.
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
          v_row."stake_points", v_row."is_ranked", v_row."mmr",
          v_row."placement_complete", v_row."joined_at", v_row."challenge_id");
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
-- blitz_runs and streak_runs cascade from auth.users, and
-- delete_my_account() anonymises and bans the auth row rather than deleting
-- it, so solo run history survives deletion exactly the way match history,
-- the points ledger and skill ratings already do. Nothing to change --
-- noted so the omission reads as a decision rather than an oversight.
--
-- One thing DOES need saying: delete_my_account() leaves an ACTIVE streak
-- run active. It cannot be played (no session), it blocks nothing (the
-- account is banned), and it will never be settled. Harmless, and cheaper
-- than a cleanup path that would have to decide whether to refund.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 15. Make PostgREST pick up the new tables, types and functions immediately
-- ----------------------------------------------------------------------------

NOTIFY pgrst, 'reload schema';
