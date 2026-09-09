-- ============================================================================
-- Real-world percentile data as the initial MMR seed during placement.
--
-- Placement-only. Standard Elo (E_A, K, the (N-1) group divisor, the floor)
-- is completely unchanged; this migration only changes what a fighter's
-- MMR is BEFORE their very first rated bout in an exercise, in the one case
-- where a better starting point than the flat 1000 seed is available: they
-- told us their age band and gender, and camera verification just produced
-- a real score for that exercise.
--
--   fitness_profiles      + gender, age_band (both optional, both nullable,
--                          neither required to play)
--   performance_norms     seed reference data: exercise x gender x age_band
--                          -> percentile -> raw performance. Not
--                          user-editable -- no client grant at all.
--   race_standards        the same idea for running, shaped for WMA-style
--                          age grading instead of a norms table (see
--                          "Race / WMA age-grading" below -- READ THIS
--                          BEFORE TRUSTING IT, the numbers here are
--                          placeholders, not real WMA data)
--   _mmr_from_percentile() the ONE percentile -> MMR curve, reused by every
--                          exercise type including race's age-graded %
--   _mmr_seed_from_norms() the pushups/plank/wallsit path
--   _mmr_seed_from_race_time()  the race path -- built, unit-tested, but
--                          NOT wired into settlement (race has no
--                          settlement path yet; see settle_match())
--   _mmr_rate_match()      reruns with one addition: a fighter's very
--                          first rated bout in an exercise seeds from
--                          norms instead of the flat 1000, if age_band and
--                          gender are both on file. Every later bout is
--                          untouched by any of this.
--   update_my_profile()    extended to accept p_age_band / p_gender
--
-- Confidence, exactly as graded in BACKEND.md's "Real-world percentile
-- seeding" section (do not read the wall-sit numbers as sourced fact):
--   pushups  -- high           (ACSM norms)
--   plank    -- high-narrow    (Chase et al. 2014, ages 18-25 only)
--   wallsit  -- low            (practitioner-sourced, not a published study)
--   race     -- high           (WMA age-grading is a well-established
--                                method -- but see the loud caveat below:
--                                the standard times and age factor in THIS
--                                migration are placeholders, not WMA's own
--                                published tables)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Optional demographics on the profile
--
-- Both nullable, neither required to use the app (point 3 below: missing
-- either one falls back to the population-median seed, never a block).
-- Client-writable only through update_my_profile() -- see section 7 --
-- exactly like every other identity field on this table since
-- 20260907000000_settings_profile.
-- ----------------------------------------------------------------------------

-- Binary because that is the shape of every source table below: ACSM,
-- Chase et al. and the wall-sit numbers are all published as men's/women's
-- tables, and WMA's age factors are likewise per-event-per-gender with only
-- two categories. This is a limitation of the source data this migration
-- was given, not a claim that only two genders exist -- anyone who does not
-- select one simply gets the population-median seed, the same as anyone who
-- leaves it blank for any other reason.
CREATE TYPE "Gender" AS ENUM ('male', 'female');

-- One unified band set, reused by every exercise's decline model even
-- though each source table's own baseline age range differs slightly
-- (pushups/wallsit: 20-29; plank: 18-25; race: no baseline range, WMA
-- grades every age individually). Representative (midpoint) ages --
-- under_20=17, 20s=25, 30s=35, 40s=45, 50s=55, 60s=65, 70_plus=75 -- are
-- defined once in _age_band_representative_age() below and used by every
-- decline calculation in this file. under_20 has no source data in ANY of
-- the four exercises; every table below defaults it to the same values as
-- the youngest sourced band rather than inventing a youth adjustment.
CREATE TYPE "AgeBand" AS ENUM (
  'under_20', '20s', '30s', '40s', '50s', '60s', '70_plus'
);

ALTER TABLE "fitness_profiles"
  ADD COLUMN "gender" "Gender",
  ADD COLUMN "age_band" "AgeBand";

-- ----------------------------------------------------------------------------
-- 2. The shared percentile -> MMR curve
--
--   MMR(p) = 1000 + 400 * log10( p / (100 - p) )
--
-- The logit of the percentile (p in 0..100), scaled and centred so the
-- population median (p=50) lands exactly on the existing seed (1000). This
-- is not a new curve invented for this feature: it is _mmr_expected()'s own
-- logistic family (base 10, /400) run in reverse, so a fighter seeded this
-- way and paired against a population-average (1000) opponent has an
-- Elo-implied win expectation consistent with the percentile they were
-- seeded from. One function, called by every exercise type -- pushups,
-- plank and wallsit via _mmr_seed_from_norms(), race via
-- _mmr_seed_from_race_time() -- per "define the percentile mapping once and
-- reuse it consistently."
--
-- Every caller clamps its percentile-shaped input to [1, 99] before this
-- runs, which is what keeps p/(100-p) away from 0 and infinity and bounds
-- the output to roughly [202, 1798] -- comfortably inside Commoner through
-- Ultimate Champion, never at a literal floor or an unbounded top.
CREATE OR REPLACE FUNCTION public._mmr_from_percentile(p_percentile numeric)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT round(1000 + 400 * log(10::numeric, p_percentile / (100 - p_percentile)))::integer
$$;
REVOKE ALL ON FUNCTION public._mmr_from_percentile(numeric) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. performance_norms -- the reference table
--
-- One row per (exercise_type, gender, age_band, percentile) anchor point.
-- Not a lookup of a single "your number", but a small ordered set of
-- (raw_value, percentile) anchors per combination that
-- _perf_percentile_from_anchors() (section 5) interpolates between and
-- extrapolates beyond -- the same piecewise-linear algorithm for all three
-- exercises, seeded with different anchors of differing genuine precision
-- (see the `confidence` column, and BACKEND.md for what each one means).
--
-- HOW ORDINAL CATEGORIES BECOME PERCENTILES. Chase et al. (plank) publishes
-- real percentiles (P25/P50/P75) -- those rows use them directly, no
-- assumption layered on. ACSM's push-up categories and the wall-sit skill
-- labels are ORDINAL with no published percentile cutpoints in the source
-- data given for this migration; both are converted the same documented
-- way -- N ordinal labels are assumed to be N EVEN population bands (each
-- 100/N% wide) -- but anchored differently depending on what the source
-- actually gives:
--   * push-ups' bands are RANGES (e.g. "17-29 = average"), so the natural
--     anchors are the BOUNDARIES between bands: 4 bands -> 3 boundaries at
--     25/50/75; 5 bands (women) -> 4 boundaries at 20/40/60/80.
--   * wall-sit's labels are single REPRESENTATIVE times ("Novice ~45s"),
--     not ranges, so the natural anchor is the CENTRE of each assumed
--     25%-wide band: 4 labels -> centres at 12.5/37.5/62.5/87.5.
-- This is one assumption (even population splits) applied to two
-- differently-shaped inputs, not two different assumptions.
--
-- AGE DECLINE, precomputed into raw_value per age_band (not applied at
-- read time) so the table is literally the data, inspectable and auditable
-- as-is:
--   * push-ups: -4 reps/decade beyond the 20-29 baseline (task's own
--     "roughly -3 to -5", midpoint used -- an approximation, not sourced
--     per-decade data). Every boundary is floored at 1 rep and then, where
--     that floor would make two boundaries collide or invert (this
--     happens in the women's table from the 50s onward, where the
--     baseline is already low), nudged to stay at least 1 rep above the
--     previous boundary. That compression at the older women's bands is a
--     visible sign the flat-rate model is being pushed well past where
--     it's trustworthy.
--   * plank: -10%/decade beyond the 18-25 baseline. This rate is an
--     ANALYST ESTIMATE -- Chase et al. covers ages 18-25 only and gives no
--     decline rate at all; -10%/decade is a round, conservative
--     approximation in line with general muscular-endurance aging
--     literature, NOT a number from the cited paper or any other source.
--     Needs real sourcing before being trusted past a rough seed.
--   * wall-sit: NO decline applied. Neither a rate nor an instruction to
--     estimate one was given for wall-sit (unlike push-ups and plank);
--     every age_band reuses the 20-29 numbers verbatim. This is a
--     documented GAP, not a finding that wall-sit performance doesn't
--     decline with age.
-- ----------------------------------------------------------------------------

CREATE TABLE "performance_norms" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "exercise_type" "ChallengeType" NOT NULL,
  "gender"        "Gender" NOT NULL,
  "age_band"      "AgeBand" NOT NULL,
  -- 0..100, exclusive of the ends (an anchor AT 0 or 100 would break the
  -- logit in _mmr_from_percentile(); no source data here needs one).
  "percentile"    NUMERIC NOT NULL,
  -- Reps (pushups) or seconds (plank, wallsit), already age-adjusted for
  -- this age_band per the decline notes above.
  "raw_value"     NUMERIC NOT NULL,
  "confidence"    TEXT NOT NULL,
  "source"        TEXT NOT NULL,
  CONSTRAINT "performance_norms_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "performance_norms_unique_anchor"
      UNIQUE ("exercise_type", "gender", "age_band", "percentile"),
  CONSTRAINT "performance_norms_percentile_range"
      CHECK ("percentile" > 0 AND "percentile" < 100),
  CONSTRAINT "performance_norms_raw_value_nonnegative"
      CHECK ("raw_value" >= 0)
);

CREATE INDEX "performance_norms_lookup_idx"
  ON "performance_norms" ("exercise_type", "gender", "age_band");

ALTER TABLE "performance_norms" ENABLE ROW LEVEL SECURITY;
-- No policies at all: deny-all, even to a role that somehow held a grant.
-- Seed data, not user data. Consulted only from inside the functions in
-- this file, which -- like every other internal _mmr_* helper -- run
-- (transitively, via settle_match()'s SECURITY DEFINER) as the table
-- owner and are unaffected by RLS on tables that owner owns. Nothing in
-- the app reads this table directly; there is no product need to.
REVOKE ALL ON "performance_norms" FROM anon, authenticated;

-- -- Push-ups: men, ACSM, high confidence -----------------------------------
-- Baseline (20-29): below-avg <17, avg 17-29, above-avg 30-46, excellent
-- 47+. Boundaries [17, 30, 47] at assumed percentiles [25, 50, 75].
-- -4 reps/decade beyond age 25 (the 20-29 midpoint), floored at 1 rep.
INSERT INTO "performance_norms"
  ("exercise_type", "gender", "age_band", "percentile", "raw_value", "confidence", "source")
VALUES
  ('pushups', 'male', 'under_20', 25, 17, 'high',
   'ACSM push-up norms, ages 20-29 (no younger band sourced; reused as-is). Percentile boundary between ACSM''s "below average" and "average" categories -- an assumed even quartile split, not a published cutpoint.'),
  ('pushups', 'male', 'under_20', 50, 30, 'high',
   'ACSM push-up norms, ages 20-29. "Average"/"above average" boundary, assumed even quartile split.'),
  ('pushups', 'male', 'under_20', 75, 47, 'high',
   'ACSM push-up norms, ages 20-29. "Above average"/"excellent" boundary, assumed even quartile split.'),
  ('pushups', 'male', '20s', 25, 17, 'high', 'ACSM push-up norms, ages 20-29, sourced baseline.'),
  ('pushups', 'male', '20s', 50, 30, 'high', 'ACSM push-up norms, ages 20-29, sourced baseline.'),
  ('pushups', 'male', '20s', 75, 47, 'high', 'ACSM push-up norms, ages 20-29, sourced baseline.'),
  ('pushups', 'male', '30s', 25, 13, 'high',
   'ACSM 20-29 baseline (17) minus an estimated 4 reps/decade x 1 decade -- approximation, not sourced per-decade data.'),
  ('pushups', 'male', '30s', 50, 26, 'high',
   'ACSM 20-29 baseline (30) minus an estimated 4 reps/decade x 1 decade -- approximation.'),
  ('pushups', 'male', '30s', 75, 43, 'high',
   'ACSM 20-29 baseline (47) minus an estimated 4 reps/decade x 1 decade -- approximation.'),
  ('pushups', 'male', '40s', 25, 9, 'high',
   'ACSM 20-29 baseline (17) minus an estimated 4 reps/decade x 2 decades -- approximation.'),
  ('pushups', 'male', '40s', 50, 22, 'high',
   'ACSM 20-29 baseline (30) minus an estimated 4 reps/decade x 2 decades -- approximation.'),
  ('pushups', 'male', '40s', 75, 39, 'high',
   'ACSM 20-29 baseline (47) minus an estimated 4 reps/decade x 2 decades -- approximation.'),
  ('pushups', 'male', '50s', 25, 5, 'high',
   'ACSM 20-29 baseline (17) minus an estimated 4 reps/decade x 3 decades -- approximation.'),
  ('pushups', 'male', '50s', 50, 18, 'high',
   'ACSM 20-29 baseline (30) minus an estimated 4 reps/decade x 3 decades -- approximation.'),
  ('pushups', 'male', '50s', 75, 35, 'high',
   'ACSM 20-29 baseline (47) minus an estimated 4 reps/decade x 3 decades -- approximation.'),
  ('pushups', 'male', '60s', 25, 1, 'high',
   'ACSM 20-29 baseline (17) minus an estimated 4 reps/decade x 4 decades, floored at 1 rep -- approximation, at the edge of where this model is trustworthy.'),
  ('pushups', 'male', '60s', 50, 14, 'high',
   'ACSM 20-29 baseline (30) minus an estimated 4 reps/decade x 4 decades -- approximation.'),
  ('pushups', 'male', '60s', 75, 31, 'high',
   'ACSM 20-29 baseline (47) minus an estimated 4 reps/decade x 4 decades -- approximation.'),
  ('pushups', 'male', '70_plus', 25, 1, 'high',
   'ACSM 20-29 baseline (17) minus an estimated 4 reps/decade x 5 decades, floored at 1 rep -- approximation, well past where this linear model should be trusted.'),
  ('pushups', 'male', '70_plus', 50, 10, 'high',
   'ACSM 20-29 baseline (30) minus an estimated 4 reps/decade x 5 decades -- approximation, well past where this linear model should be trusted.'),
  ('pushups', 'male', '70_plus', 75, 27, 'high',
   'ACSM 20-29 baseline (47) minus an estimated 4 reps/decade x 5 decades -- approximation, well past where this linear model should be trusted.');

-- -- Push-ups: women, ACSM, high confidence ---------------------------------
-- Baseline (20-29): below-avg <9, avg 9-13, above-avg 14-22, above-avg
-- 23-31, excellent 32+ -- five bands EXACTLY as given (the source lists
-- "above avg" twice, at 14-22 and 23-31; reproduced as-is rather than
-- relabelled, since only the ordinal rank of the boundaries matters here).
-- Boundaries [9, 14, 23, 32] at assumed percentiles [20, 40, 60, 80].
-- Same -4 reps/decade rate as men (the source did not give a separate
-- rate by gender), floored at 1 rep and then nudged to stay strictly
-- increasing where the floor would otherwise collide two boundaries.
INSERT INTO "performance_norms"
  ("exercise_type", "gender", "age_band", "percentile", "raw_value", "confidence", "source")
VALUES
  ('pushups', 'female', 'under_20', 20, 9, 'high', 'ACSM push-up norms, ages 20-29 (no younger band sourced; reused as-is). Quintile-boundary assumption, not a published cutpoint.'),
  ('pushups', 'female', 'under_20', 40, 14, 'high', 'ACSM push-up norms, ages 20-29. Quintile-boundary assumption.'),
  ('pushups', 'female', 'under_20', 60, 23, 'high', 'ACSM push-up norms, ages 20-29. Quintile-boundary assumption.'),
  ('pushups', 'female', 'under_20', 80, 32, 'high', 'ACSM push-up norms, ages 20-29. Quintile-boundary assumption.'),
  ('pushups', 'female', '20s', 20, 9, 'high', 'ACSM push-up norms, ages 20-29, sourced baseline.'),
  ('pushups', 'female', '20s', 40, 14, 'high', 'ACSM push-up norms, ages 20-29, sourced baseline.'),
  ('pushups', 'female', '20s', 60, 23, 'high', 'ACSM push-up norms, ages 20-29, sourced baseline.'),
  ('pushups', 'female', '20s', 80, 32, 'high', 'ACSM push-up norms, ages 20-29, sourced baseline.'),
  ('pushups', 'female', '30s', 20, 5, 'high', 'ACSM 20-29 baseline (9) minus an estimated 4 reps/decade x 1 decade -- approximation.'),
  ('pushups', 'female', '30s', 40, 10, 'high', 'ACSM 20-29 baseline (14) minus an estimated 4 reps/decade x 1 decade -- approximation.'),
  ('pushups', 'female', '30s', 60, 19, 'high', 'ACSM 20-29 baseline (23) minus an estimated 4 reps/decade x 1 decade -- approximation.'),
  ('pushups', 'female', '30s', 80, 28, 'high', 'ACSM 20-29 baseline (32) minus an estimated 4 reps/decade x 1 decade -- approximation.'),
  ('pushups', 'female', '40s', 20, 1, 'high', 'ACSM 20-29 baseline (9) minus an estimated 4 reps/decade x 2 decades, floored at 1 rep -- approximation.'),
  ('pushups', 'female', '40s', 40, 6, 'high', 'ACSM 20-29 baseline (14) minus an estimated 4 reps/decade x 2 decades -- approximation.'),
  ('pushups', 'female', '40s', 60, 15, 'high', 'ACSM 20-29 baseline (23) minus an estimated 4 reps/decade x 2 decades -- approximation.'),
  ('pushups', 'female', '40s', 80, 24, 'high', 'ACSM 20-29 baseline (32) minus an estimated 4 reps/decade x 2 decades -- approximation.'),
  ('pushups', 'female', '50s', 20, 1, 'high', 'ACSM 20-29 baseline (9) minus an estimated 4 reps/decade x 3 decades, floored at 1 rep, nudged to stay below the next boundary -- the flat-rate model is visibly straining here.'),
  ('pushups', 'female', '50s', 40, 2, 'high', 'ACSM 20-29 baseline (14) minus an estimated 4 reps/decade x 3 decades, floored and nudged -- see above.'),
  ('pushups', 'female', '50s', 60, 11, 'high', 'ACSM 20-29 baseline (23) minus an estimated 4 reps/decade x 3 decades -- approximation.'),
  ('pushups', 'female', '50s', 80, 20, 'high', 'ACSM 20-29 baseline (32) minus an estimated 4 reps/decade x 3 decades -- approximation.'),
  ('pushups', 'female', '60s', 20, 1, 'high', 'ACSM 20-29 baseline (9) minus an estimated 4 reps/decade x 4 decades, floored and nudged -- this age band is past where the linear model should be trusted for women.'),
  ('pushups', 'female', '60s', 40, 2, 'high', 'ACSM 20-29 baseline (14) minus an estimated 4 reps/decade x 4 decades, floored and nudged -- see above.'),
  ('pushups', 'female', '60s', 60, 7, 'high', 'ACSM 20-29 baseline (23) minus an estimated 4 reps/decade x 4 decades -- approximation.'),
  ('pushups', 'female', '60s', 80, 16, 'high', 'ACSM 20-29 baseline (32) minus an estimated 4 reps/decade x 4 decades -- approximation.'),
  ('pushups', 'female', '70_plus', 20, 1, 'high', 'ACSM 20-29 baseline (9) minus an estimated 4 reps/decade x 5 decades, floored and nudged -- well past where this model should be trusted.'),
  ('pushups', 'female', '70_plus', 40, 2, 'high', 'ACSM 20-29 baseline (14) minus an estimated 4 reps/decade x 5 decades, floored and nudged -- see above.'),
  ('pushups', 'female', '70_plus', 60, 3, 'high', 'ACSM 20-29 baseline (23) minus an estimated 4 reps/decade x 5 decades, floored and nudged -- see above.'),
  ('pushups', 'female', '70_plus', 80, 12, 'high', 'ACSM 20-29 baseline (32) minus an estimated 4 reps/decade x 5 decades -- approximation.');

-- -- Plank: men, Chase et al. 2014, high-narrow confidence ------------------
-- P25=84s, P50=110s, P75=135s, sourced directly for ages 18-25 -- the
-- narrow part of "high-narrow". Beyond 18-25, an ANALYST-ESTIMATED
-- -10%/decade multiplicative decline from age 21.5 (the 18-25 midpoint):
-- multiplier = 0.9 ^ max(0, (representative_age - 21.5) / 10), rounded to
-- the nearest second. under_20 (age 17) and 20s (age 25) both round to
-- effectively no decline or a very small one; 20s in particular sits at a
-- ~3.6% decline despite age 25 technically still being inside the sourced
-- 18-25 range -- a small, acknowledged side-effect of reusing one
-- age-band scheme across every exercise (see the header note above)
-- rather than shaping bands per exercise.
INSERT INTO "performance_norms"
  ("exercise_type", "gender", "age_band", "percentile", "raw_value", "confidence", "source")
VALUES
  ('plank', 'male', 'under_20', 25, 84, 'high-narrow', 'Chase et al. 2014, ages 18-25, P25 -- sourced directly. No decline applied (representative age below the 18-25 baseline).'),
  ('plank', 'male', 'under_20', 50, 110, 'high-narrow', 'Chase et al. 2014, ages 18-25, P50 -- sourced directly.'),
  ('plank', 'male', 'under_20', 75, 135, 'high-narrow', 'Chase et al. 2014, ages 18-25, P75 -- sourced directly.'),
  ('plank', 'male', '20s', 25, 81, 'high-narrow', 'Chase et al. 2014 P25 (84s) with an estimated -10%/decade decline (ANALYST ESTIMATE, not from the source) applied from age 25 -- ~3.6% decline.'),
  ('plank', 'male', '20s', 50, 106, 'high-narrow', 'Chase et al. 2014 P50 (110s) with an estimated -10%/decade decline applied from age 25 -- ANALYST ESTIMATE.'),
  ('plank', 'male', '20s', 75, 130, 'high-narrow', 'Chase et al. 2014 P75 (135s) with an estimated -10%/decade decline applied from age 25 -- ANALYST ESTIMATE.'),
  ('plank', 'male', '30s', 25, 73, 'high-narrow', 'Chase et al. 2014 P25 (84s), estimated -10%/decade decline from age 35 (~13.5% total) -- ANALYST ESTIMATE, not sourced.'),
  ('plank', 'male', '30s', 50, 95, 'high-narrow', 'Chase et al. 2014 P50 (110s), estimated -10%/decade decline from age 35 -- ANALYST ESTIMATE.'),
  ('plank', 'male', '30s', 75, 117, 'high-narrow', 'Chase et al. 2014 P75 (135s), estimated -10%/decade decline from age 35 -- ANALYST ESTIMATE.'),
  ('plank', 'male', '40s', 25, 66, 'high-narrow', 'Chase et al. 2014 P25 (84s), estimated -10%/decade decline from age 45 (~23.5% total) -- ANALYST ESTIMATE, not sourced.'),
  ('plank', 'male', '40s', 50, 86, 'high-narrow', 'Chase et al. 2014 P50 (110s), estimated -10%/decade decline from age 45 -- ANALYST ESTIMATE.'),
  ('plank', 'male', '40s', 75, 105, 'high-narrow', 'Chase et al. 2014 P75 (135s), estimated -10%/decade decline from age 45 -- ANALYST ESTIMATE.'),
  ('plank', 'male', '50s', 25, 59, 'high-narrow', 'Chase et al. 2014 P25 (84s), estimated -10%/decade decline from age 55 (~33.5% total) -- ANALYST ESTIMATE, not sourced.'),
  ('plank', 'male', '50s', 50, 77, 'high-narrow', 'Chase et al. 2014 P50 (110s), estimated -10%/decade decline from age 55 -- ANALYST ESTIMATE.'),
  ('plank', 'male', '50s', 75, 95, 'high-narrow', 'Chase et al. 2014 P75 (135s), estimated -10%/decade decline from age 55 -- ANALYST ESTIMATE.'),
  ('plank', 'male', '60s', 25, 53, 'high-narrow', 'Chase et al. 2014 P25 (84s), estimated -10%/decade decline from age 65 (~43.5% total) -- ANALYST ESTIMATE, needs real sourcing for this age range.'),
  ('plank', 'male', '60s', 50, 70, 'high-narrow', 'Chase et al. 2014 P50 (110s), estimated -10%/decade decline from age 65 -- ANALYST ESTIMATE, needs real sourcing.'),
  ('plank', 'male', '60s', 75, 85, 'high-narrow', 'Chase et al. 2014 P75 (135s), estimated -10%/decade decline from age 65 -- ANALYST ESTIMATE, needs real sourcing.'),
  ('plank', 'male', '70_plus', 25, 48, 'high-narrow', 'Chase et al. 2014 P25 (84s), estimated -10%/decade decline from age 75 (~43% remaining) -- ANALYST ESTIMATE, well outside the sourced range, needs real sourcing.'),
  ('plank', 'male', '70_plus', 50, 63, 'high-narrow', 'Chase et al. 2014 P50 (110s), estimated -10%/decade decline from age 75 -- ANALYST ESTIMATE, needs real sourcing.'),
  ('plank', 'male', '70_plus', 75, 77, 'high-narrow', 'Chase et al. 2014 P75 (135s), estimated -10%/decade decline from age 75 -- ANALYST ESTIMATE, needs real sourcing.');

-- -- Plank: women, Chase et al. 2014, high-narrow confidence ----------------
INSERT INTO "performance_norms"
  ("exercise_type", "gender", "age_band", "percentile", "raw_value", "confidence", "source")
VALUES
  ('plank', 'female', 'under_20', 25, 73.5, 'high-narrow', 'Chase et al. 2014, ages 18-25, P25 -- sourced directly. No decline applied.'),
  ('plank', 'female', 'under_20', 50, 95, 'high-narrow', 'Chase et al. 2014, ages 18-25, P50 -- sourced directly.'),
  ('plank', 'female', 'under_20', 75, 122.5, 'high-narrow', 'Chase et al. 2014, ages 18-25, P75 -- sourced directly.'),
  ('plank', 'female', '20s', 25, 71, 'high-narrow', 'Chase et al. 2014 P25 (73.5s) with an estimated -10%/decade decline from age 25 -- ANALYST ESTIMATE, not sourced.'),
  ('plank', 'female', '20s', 50, 92, 'high-narrow', 'Chase et al. 2014 P50 (95s) with an estimated -10%/decade decline from age 25 -- ANALYST ESTIMATE.'),
  ('plank', 'female', '20s', 75, 118, 'high-narrow', 'Chase et al. 2014 P75 (122.5s) with an estimated -10%/decade decline from age 25 -- ANALYST ESTIMATE.'),
  ('plank', 'female', '30s', 25, 64, 'high-narrow', 'Chase et al. 2014 P25 (73.5s), estimated -10%/decade decline from age 35 -- ANALYST ESTIMATE, not sourced.'),
  ('plank', 'female', '30s', 50, 82, 'high-narrow', 'Chase et al. 2014 P50 (95s), estimated -10%/decade decline from age 35 -- ANALYST ESTIMATE.'),
  ('plank', 'female', '30s', 75, 106, 'high-narrow', 'Chase et al. 2014 P75 (122.5s), estimated -10%/decade decline from age 35 -- ANALYST ESTIMATE.'),
  ('plank', 'female', '40s', 25, 57, 'high-narrow', 'Chase et al. 2014 P25 (73.5s), estimated -10%/decade decline from age 45 -- ANALYST ESTIMATE, not sourced.'),
  ('plank', 'female', '40s', 50, 74, 'high-narrow', 'Chase et al. 2014 P50 (95s), estimated -10%/decade decline from age 45 -- ANALYST ESTIMATE.'),
  ('plank', 'female', '40s', 75, 96, 'high-narrow', 'Chase et al. 2014 P75 (122.5s), estimated -10%/decade decline from age 45 -- ANALYST ESTIMATE.'),
  ('plank', 'female', '50s', 25, 52, 'high-narrow', 'Chase et al. 2014 P25 (73.5s), estimated -10%/decade decline from age 55 -- ANALYST ESTIMATE, not sourced.'),
  ('plank', 'female', '50s', 50, 67, 'high-narrow', 'Chase et al. 2014 P50 (95s), estimated -10%/decade decline from age 55 -- ANALYST ESTIMATE.'),
  ('plank', 'female', '50s', 75, 86, 'high-narrow', 'Chase et al. 2014 P75 (122.5s), estimated -10%/decade decline from age 55 -- ANALYST ESTIMATE.'),
  ('plank', 'female', '60s', 25, 46, 'high-narrow', 'Chase et al. 2014 P25 (73.5s), estimated -10%/decade decline from age 65 -- ANALYST ESTIMATE, needs real sourcing for this age range.'),
  ('plank', 'female', '60s', 50, 60, 'high-narrow', 'Chase et al. 2014 P50 (95s), estimated -10%/decade decline from age 65 -- ANALYST ESTIMATE, needs real sourcing.'),
  ('plank', 'female', '60s', 75, 77, 'high-narrow', 'Chase et al. 2014 P75 (122.5s), estimated -10%/decade decline from age 65 -- ANALYST ESTIMATE, needs real sourcing.'),
  ('plank', 'female', '70_plus', 25, 42, 'high-narrow', 'Chase et al. 2014 P25 (73.5s), estimated -10%/decade decline from age 75 -- ANALYST ESTIMATE, well outside the sourced range, needs real sourcing.'),
  ('plank', 'female', '70_plus', 50, 54, 'high-narrow', 'Chase et al. 2014 P50 (95s), estimated -10%/decade decline from age 75 -- ANALYST ESTIMATE, needs real sourcing.'),
  ('plank', 'female', '70_plus', 75, 70, 'high-narrow', 'Chase et al. 2014 P75 (122.5s), estimated -10%/decade decline from age 75 -- ANALYST ESTIMATE, needs real sourcing.');

-- -- Wall-sit: men and women, practitioner-sourced, LOW confidence ----------
-- Novice/Intermediate/Advanced/Elite treated as four EVEN 25%-wide bands,
-- each anchored at its CENTRE (12.5/37.5/62.5/87.5) because the source
-- gives one representative time per label, not a boundary between labels
-- -- see the "HOW ORDINAL CATEGORIES BECOME PERCENTILES" note above.
-- IDENTICAL across every age_band: no decline rate or instruction was
-- given for wall-sit, so none is estimated here. This is a known gap, not
-- a finding that wall-sit endurance doesn't decline with age -- flagged
-- prominently in BACKEND.md.
INSERT INTO "performance_norms"
  ("exercise_type", "gender", "age_band", "percentile", "raw_value", "confidence", "source")
SELECT 'wallsit', 'male', b.age_band, a.pct, a.secs, 'low',
       'Practitioner-sourced (LOW confidence, not a published study). ' || a.label || ' (~' || a.secs || 's) treated as the centre of an assumed even 25%-wide population band. No age-decline data or instruction provided -- every age band reuses these 20-29 values unmodified, a documented gap.'
  FROM (VALUES (12.5, 45, 'Novice'), (37.5, 90, 'Intermediate'), (62.5, 150, 'Advanced'), (87.5, 240, 'Elite')) AS a(pct, secs, label)
  CROSS JOIN (VALUES ('under_20'::"AgeBand"), ('20s'), ('30s'), ('40s'), ('50s'), ('60s'), ('70_plus')) AS b(age_band);

INSERT INTO "performance_norms"
  ("exercise_type", "gender", "age_band", "percentile", "raw_value", "confidence", "source")
SELECT 'wallsit', 'female', b.age_band, a.pct, a.secs, 'low',
       'Practitioner-sourced (LOW confidence, not a published study). ' || a.label || ' (~' || a.secs || 's) treated as the centre of an assumed even 25%-wide population band. No age-decline data or instruction provided -- every age band reuses these 20-29 values unmodified, a documented gap.'
  FROM (VALUES (12.5, 40, 'Novice'), (37.5, 70, 'Intermediate'), (62.5, 110, 'Advanced'), (87.5, 210, 'Elite')) AS a(pct, secs, label)
  CROSS JOIN (VALUES ('under_20'::"AgeBand"), ('20s'), ('30s'), ('40s'), ('50s'), ('60s'), ('70_plus')) AS b(age_band);

-- ----------------------------------------------------------------------------
-- 4. race_standards -- Race / WMA age-grading
--
-- ============================================================================
-- READ THIS BEFORE TRUSTING ANY NUMBER IN THIS SECTION.
--
-- WMA (World Masters Athletics) age-grading is a real, well-established
-- method -- that part is genuinely "high confidence." What it needs is a
-- large published table of per-age, per-event, per-gender factors (and an
-- "open standard" time per event) that WMA/Alan Jones publish to several
-- decimal places. This migration was NOT given that table as source data,
-- and does not have it memorized precisely enough to reproduce without
-- risking fabrication -- doing so would be exactly the "invent additional
-- precision that isn't in the source data" this task says not to do.
--
-- So instead: the PIPELINE below (time -> age-graded % -> MMR) is built and
-- implements the real WMA formula shape, using two placeholder inputs that
-- are clearly named and documented as placeholders:
--   1. race_standards.standard_seconds -- a rounded, approximate
--      open-class (roughly world-record-level) mile time, not WMA's own
--      published age-standard table.
--   2. _race_age_factor_APPROXIMATE() -- a single flat +1%/year adjustment
--      past age 30, applied identically to every event and gender. Real
--      WMA age factors are nonlinear and vary by event; this does not
--      attempt to reproduce that curve.
-- Both are named and commented so this is unmistakable in any later
-- review. NEITHER SHOULD BE TRUSTED FOR ANYTHING BEYOND A ROUGH PLACEMENT
-- SEED until replaced with WMA's actual published tables (available from
-- World Masters Athletics / mastersathletics.net, or Alan Jones' age-
-- grading calculators). See BACKEND.md, "Race / WMA age-grading."
--
-- Only 'mile' is seeded: EXERCISE_LABEL.race is "1-Mile Race" in
-- src/theme/copy.ts -- the only race distance FittrApp defines. Adding a
-- second distance later is a new row here, not a schema change.
--
-- Not wired into settle_match() / _mmr_rate_match(): race has no
-- verification or settlement path yet (settle_match() still raises for
-- challenge type 'race'; see BACKEND.md, "Winner rules"). This section
-- exists so the pipeline is complete and independently testable ahead of
-- that work, per "for all four exercise types" -- and so that when race
-- verification IS built, wiring it in is "call this function," not
-- "design this function."
-- ============================================================================

CREATE TABLE "race_standards" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "distance"           TEXT NOT NULL,
  "gender"             "Gender" NOT NULL,
  "standard_seconds"   NUMERIC NOT NULL,
  "confidence"         TEXT NOT NULL,
  "source"             TEXT NOT NULL,
  CONSTRAINT "race_standards_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "race_standards_distance_gender_key" UNIQUE ("distance", "gender"),
  CONSTRAINT "race_standards_seconds_positive" CHECK ("standard_seconds" > 0)
);

ALTER TABLE "race_standards" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "race_standards" FROM anon, authenticated;

INSERT INTO "race_standards" ("distance", "gender", "standard_seconds", "confidence", "source") VALUES
  ('mile', 'male', 225, 'low',
   'PLACEHOLDER, not WMA''s published open standard. Deliberately rounded to a 5-second increment (roughly 3:45) rather than stating a specific record time as if precisely sourced. Replace with WMA''s actual age-standard table before trusting this beyond a rough seed.'),
  ('mile', 'female', 250, 'low',
   'PLACEHOLDER, not WMA''s published open standard. Deliberately rounded to a 5-second increment (roughly 4:10) rather than stating a specific record time as if precisely sourced. Replace with WMA''s actual age-standard table before trusting this beyond a rough seed.');

-- ----------------------------------------------------------------------------
-- 5. The generic interpolator
--
-- Piecewise-linear percentile from 2+ (raw_value, percentile) anchors,
-- sorted ascending by raw_value. Within the anchor range: interpolates
-- between the bracketing pair. Beyond either end: extrapolates using the
-- nearest segment's slope, then clamps to [1, 99] -- a single sourced or
-- estimated data point should never be read as "the 0th percentile of
-- anyone who has ever lived," and the clamp is what stops it being read
-- that way. NULLIF guards every division so two anchors that happen to
-- share a raw_value (none do in the seed data above -- see the monotonicity
-- db test) degrade to that anchor's flat percentile instead of dividing by
-- zero.
--
-- Fewer than two anchors (including a NULL array, which is what array_agg
-- returns for zero matching rows) returns NULL rather than raising: a
-- caller with an incomplete or missing norms row degrades to "no seed
-- available" -- i.e. the population-median default -- not a failed
-- settlement.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._perf_percentile_from_anchors(
  p_raw numeric, p_anchors_raw numeric[], p_anchors_pct numeric[]
) RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_n integer := coalesce(cardinality(p_anchors_raw), 0);
  v_pct numeric;
  v_slope numeric;
  k integer;
BEGIN
  IF v_n < 2 OR coalesce(cardinality(p_anchors_pct), 0) <> v_n OR p_raw IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_raw <= p_anchors_raw[1] THEN
    v_slope := (p_anchors_pct[2] - p_anchors_pct[1]) / NULLIF(p_anchors_raw[2] - p_anchors_raw[1], 0);
    v_pct := coalesce(p_anchors_pct[1] + v_slope * (p_raw - p_anchors_raw[1]), p_anchors_pct[1]);
  ELSIF p_raw >= p_anchors_raw[v_n] THEN
    v_slope := (p_anchors_pct[v_n] - p_anchors_pct[v_n - 1]) / NULLIF(p_anchors_raw[v_n] - p_anchors_raw[v_n - 1], 0);
    v_pct := coalesce(p_anchors_pct[v_n] + v_slope * (p_raw - p_anchors_raw[v_n]), p_anchors_pct[v_n]);
  ELSE
    FOR k IN 1 .. v_n - 1 LOOP
      IF p_raw >= p_anchors_raw[k] AND p_raw <= p_anchors_raw[k + 1] THEN
        v_slope := (p_anchors_pct[k + 1] - p_anchors_pct[k]) / NULLIF(p_anchors_raw[k + 1] - p_anchors_raw[k], 0);
        v_pct := coalesce(p_anchors_pct[k] + v_slope * (p_raw - p_anchors_raw[k]), p_anchors_pct[k]);
        EXIT;
      END IF;
    END LOOP;
  END IF;

  IF v_pct IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN greatest(1::numeric, least(99::numeric, v_pct));
END;
$$;
REVOKE ALL ON FUNCTION public._perf_percentile_from_anchors(numeric, numeric[], numeric[]) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6. _mmr_seed_from_norms() -- the pushups/plank/wallsit path
--
-- NULL (never an exception) whenever a seed cannot be produced: exercise
-- outside the three the norms table covers, or no anchors found for the
-- combination. A caller must never be able to make settlement raise over
-- missing or incomplete norms data -- only fall back silently to the
-- population-median seed, exactly as "if age/gender isn't provided" does.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._mmr_seed_from_norms(
  p_exercise "ChallengeType", p_gender "Gender", p_age_band "AgeBand", p_raw_score integer
) RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_pct numeric;
BEGIN
  IF p_exercise NOT IN ('pushups', 'plank', 'wallsit') THEN
    RETURN NULL;
  END IF;

  SELECT public._perf_percentile_from_anchors(
           p_raw_score::numeric,
           array_agg(n."raw_value" ORDER BY n."percentile"),
           array_agg(n."percentile" ORDER BY n."percentile")
         )
    INTO v_pct
    FROM "performance_norms" n
   WHERE n."exercise_type" = p_exercise
     AND n."gender" = p_gender
     AND n."age_band" = p_age_band;

  IF v_pct IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN public._mmr_from_percentile(v_pct);
END;
$$;
REVOKE ALL ON FUNCTION public._mmr_seed_from_norms("ChallengeType", "Gender", "AgeBand", integer) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7. Race pipeline: age factor, representative age, the seed function
-- ----------------------------------------------------------------------------

-- Representative (midpoint) age per age_band. The same table this file's
-- header describes, used wherever a formula needs a single age rather than
-- a band -- today, only the race pipeline (WMA grades individual ages, not
-- bands). under_20 -> 17 is itself an approximation (the band has no lower
-- bound); every other value is the literal band midpoint.
CREATE OR REPLACE FUNCTION public._age_band_representative_age(p_age_band "AgeBand")
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_age_band
    WHEN 'under_20' THEN 17
    WHEN '20s' THEN 25
    WHEN '30s' THEN 35
    WHEN '40s' THEN 45
    WHEN '50s' THEN 55
    WHEN '60s' THEN 65
    WHEN '70_plus' THEN 75
  END
$$;
REVOKE ALL ON FUNCTION public._age_band_representative_age("AgeBand") FROM PUBLIC, anon, authenticated;

-- APPROXIMATE placeholder age-adjustment -- NOT WMA's published per-age
-- factor table. See the loud caveat in section 4 above. Flat 1.0 (no
-- adjustment) through age 30, then +1%/year beyond it, identically for
-- every event and both genders. The function name says APPROXIMATE
-- deliberately: this exists to make the age-grading PIPELINE complete and
-- testable end to end, not because these numbers are trustworthy on their
-- own.
CREATE OR REPLACE FUNCTION public._race_age_factor_APPROXIMATE(p_age integer)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_age <= 30 THEN 1.0::numeric
              ELSE 1.0::numeric + 0.01::numeric * (p_age - 30)
         END
$$;
REVOKE ALL ON FUNCTION public._race_age_factor_APPROXIMATE(integer) FROM PUBLIC, anon, authenticated;

-- Standalone: a verified race time -> a seed MMR via WMA-style age
-- grading. NOT called from _mmr_rate_match() / settle_match() -- see the
-- section 4 header for why. NULL (never an exception) if the time is
-- missing/non-positive or the distance/gender has no standard on file.
--
--   AG% = standard / (actual / age_factor) * 100
--
-- age_factor > 1 for an older runner shrinks the age-adjusted-equivalent
-- time below their raw actual time before comparing to the open standard
-- -- i.e. the same actual clock time earns a HIGHER age grade the older
-- the runner is, which is the whole point of age grading. The result is
-- clamped to [1, 99] and fed through the SAME _mmr_from_percentile() the
-- other three exercises use, per the instruction to map the percentage to
-- MMR "the same way the other three map percentile to MMR" -- stated
-- explicitly because an age-graded % is not itself a population
-- percentile; this function follows that instruction rather than
-- asserting the two are the same statistic.
CREATE OR REPLACE FUNCTION public._mmr_seed_from_race_time(
  p_gender "Gender", p_distance text, p_time_seconds numeric, p_age_band "AgeBand"
) RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_standard numeric;
  v_factor numeric;
  v_age_graded numeric;
BEGIN
  IF p_time_seconds IS NULL OR p_time_seconds <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT "standard_seconds" INTO v_standard
    FROM "race_standards" WHERE "distance" = p_distance AND "gender" = p_gender;
  IF v_standard IS NULL THEN
    RETURN NULL;
  END IF;

  v_factor := public._race_age_factor_APPROXIMATE(public._age_band_representative_age(p_age_band));
  v_age_graded := v_standard / (p_time_seconds / v_factor) * 100;

  RETURN public._mmr_from_percentile(greatest(1::numeric, least(99::numeric, v_age_graded)));
END;
$$;
REVOKE ALL ON FUNCTION public._mmr_seed_from_race_time("Gender", text, numeric, "AgeBand") FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 8. skill_rating_events: was this bout's seed norms-based?
--
-- Independently verifiable audit trail for the one behaviour this whole
-- migration adds: "which bouts actually got the percentile-based seed,
-- versus which used the flat 1000 default because age/gender wasn't on
-- file." Set only by _mmr_rate_match() below, only on a fighter's first
-- rated bout in an exercise, only when a norms-based seed was actually
-- available and used.
-- ----------------------------------------------------------------------------

ALTER TABLE "skill_rating_events"
  ADD COLUMN "norms_seeded" BOOLEAN NOT NULL DEFAULT false;

-- ----------------------------------------------------------------------------
-- 9. _mmr_rate_match(), with norms-seeding on the first rated bout
--
-- Identical to 20260909000000's version except for one insertion, placed
-- exactly where the header of that migration's LOCK ORDER note says a plain
-- read is safe: gender/age_band are pulled alongside the rating snapshot in
-- the same query (an added JOIN, not a new lock -- fitness_profiles is read
-- here without FOR UPDATE, so this cannot introduce a new deadlock
-- ordering), and then, for any participant whose matches_played is exactly
-- 0 -- this bout IS their first rated bout in this exercise, which is what
-- "before their first placement match's Elo update is even calculated"
-- means -- v_mmr[i] is overridden with the norms-based seed before the
-- pairwise E_ij loop runs, so every expectation calculation in this bout
-- (both this fighter's own, and every opponent's expectation AGAINST them)
-- uses the adjusted number, not the stale flat seed. Every later placement
-- bout (matches_played 1-4) leaves v_mmr[i] untouched by any of this --
-- "before their FIRST placement match," singular, not every one.
--
-- Their own verified score for THIS bout (v_scores[i]) is always present
-- by the time this function runs: settle_match() already refused to reach
-- here with a NULL score. So the only real gate on norms-seeding is
-- gender/age_band being on file -- exactly "if their verified performance
-- data is available ... and they've provided age/gender."
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

  -- fitness_profiles.gender / age_band, read here unlocked alongside the
  -- rating snapshot -- see LOCK ORDER above this function for why an added
  -- plain read (no FOR UPDATE) cannot change the deadlock ordering.
  SELECT array_agg(t."user_id" ORDER BY t."user_id"),
         array_agg(t."score"   ORDER BY t."user_id"),
         array_agg(t."mmr"     ORDER BY t."user_id"),
         array_agg(CASE WHEN t."placement_complete"
                        THEN public._mmr_k_settled()
                        ELSE public._mmr_k_placement() END ORDER BY t."user_id"),
         array_agg(t."matches_played" ORDER BY t."user_id"),
         array_agg(t."gender" ORDER BY t."user_id"),
         array_agg(t."age_band" ORDER BY t."user_id")
    INTO v_users, v_scores, v_mmr, v_k, v_played, v_gender, v_age_band
    FROM (
      SELECT mp."user_id",
             CASE WHEN p_exercise = 'pushups'
                  THEN mp."rep_count" ELSE mp."hold_duration_seconds" END AS "score",
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

  -- Defensive: settle_match() has already checked the seat count and that no
  -- score is NULL. A single seat has nobody to be compared against.
  IF v_n < 2 THEN
    RETURN;
  END IF;

  -- Norms-based seed, first rated bout only. See the header note above.
  v_norms_seeded := array_fill(false, ARRAY[v_n]);
  FOR i IN 1 .. v_n LOOP
    IF v_played[i] = 0 AND v_gender[i] IS NOT NULL AND v_age_band[i] IS NOT NULL THEN
      v_norm_mmr := public._mmr_seed_from_norms(p_exercise, v_gender[i], v_age_band[i], v_scores[i]);
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

-- ----------------------------------------------------------------------------
-- 10. update_my_profile(): accepts age_band / gender
--
-- The old 3-arg signature is DROPPED, not left alongside -- the same rule
-- 20260903300000 established for submit_verification_session(): adding
-- trailing DEFAULT-valued parameters still creates a second overload that
-- PostgREST cannot resolve a 3-arg call against unambiguously.
--
-- Both new parameters follow the same "NULL leaves it alone" convention as
-- every existing one. Neither needs a validation branch the way username
-- and display_name do -- they are enum-typed, so Postgres itself rejects
-- anything outside 'male'/'female' or the seven age bands at the call
-- boundary, before this function body even runs.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.update_my_profile(text, text, text);

CREATE OR REPLACE FUNCTION public.update_my_profile(
  p_display_name text DEFAULT NULL,
  p_username text DEFAULT NULL,
  p_avatar_url text DEFAULT NULL,
  p_age_band "AgeBand" DEFAULT NULL,
  p_gender "Gender" DEFAULT NULL
)
RETURNS "fitness_profiles"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_username text;
  v_row "fitness_profiles"%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;

  IF p_username IS NOT NULL THEN
    v_username := public.normalize_username(p_username);
    IF v_username !~ '^[a-z0-9][a-z0-9._]{2,19}$' THEN
      RAISE EXCEPTION 'username_invalid';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "fitness_profiles"
      WHERE "username" = v_username::citext AND "user_id" <> v_user
    ) THEN
      RAISE EXCEPTION 'username_taken';
    END IF;
  END IF;

  IF p_display_name IS NOT NULL AND btrim(p_display_name) <> ''
     AND length(btrim(p_display_name)) > 40 THEN
    RAISE EXCEPTION 'display_name_invalid';
  END IF;

  -- Only a file in this user's own folder of the avatars bucket may be
  -- recorded, so a profile can never point at someone else's picture or an
  -- arbitrary URL.
  IF p_avatar_url IS NOT NULL AND p_avatar_url <> ''
     AND p_avatar_url NOT LIKE '%/storage/v1/object/public/avatars/' || v_user::text || '/%' THEN
    RAISE EXCEPTION 'avatar_url_invalid';
  END IF;

  UPDATE "fitness_profiles"
     SET "display_name" = CASE
                            WHEN p_display_name IS NULL THEN "display_name"
                            WHEN btrim(p_display_name) = '' THEN NULL
                            ELSE btrim(p_display_name)
                          END,
         "username"     = CASE WHEN p_username IS NULL THEN "username" ELSE v_username::citext END,
         "avatar_url"   = CASE
                            WHEN p_avatar_url IS NULL THEN "avatar_url"
                            WHEN p_avatar_url = '' THEN NULL
                            ELSE p_avatar_url
                          END,
         "age_band"     = coalesce(p_age_band, "age_band"),
         "gender"       = coalesce(p_gender, "gender"),
         "updated_at"   = now()
   WHERE "user_id" = v_user
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found';
  END IF;
  RETURN v_row;
EXCEPTION
  WHEN unique_violation THEN
    -- Two people took the same name in the same instant; the loser sees the
    -- same message as if it had been taken earlier.
    RAISE EXCEPTION 'username_taken';
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_my_profile(text, text, text, "AgeBand", "Gender") TO authenticated;

-- ----------------------------------------------------------------------------
-- 11. Make PostgREST pick up the new columns, tables and functions
-- ----------------------------------------------------------------------------

NOTIFY pgrst, 'reload schema';
