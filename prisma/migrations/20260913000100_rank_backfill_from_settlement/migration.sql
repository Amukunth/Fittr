-- ============================================================================
-- Rebuild the trophy backfill from what settlement actually decided.
--
-- WHAT WAS WRONG
--
-- 20260913000000's replay recomputed each historical bout's winners from the
-- recorded scores, with settle_match()'s own max() rule. That is right for a
-- bout settling now -- settle_match passes the winners it just paid the pot
-- to -- but it is wrong looking backwards, because a score column and a
-- settlement outcome can disagree about a bout that is already over.
--
-- On the live project they did. Every one of the eleven settled bouts there
-- ended with winner_id NULL and every fighter refunded (a tie), but two of
-- them have a score recorded for one fighter and NULL for the other. max()
-- ignores NULLs, so the replay elected the scored fighter as a sole winner
-- and charged the other a loss -- awarding trophies against the money, and
-- disagreeing with the Profile screen, which reads the same bouts as ties
-- off the ledger (deriveBoutStats / outcomeOf).
--
-- Those rows predate the null-score guard settle_match() has carried since
-- 20260908000000, so nothing can create that shape again. The history it
-- left behind still has to be read correctly.
--
-- THE RULE, FOR ANY BOUT THAT IS ALREADY SETTLED
--
--   winner_id IS NOT NULL  -> that one fighter won
--   winner_id IS NULL      -> everyone who received a payout shared it
--   no payout at all       -> nothing can be said; skip the bout
--
-- which is exactly how outcomeOf() in src/lib/boutStats.ts has always told a
-- shared win from a loss, and exactly what settle_match() writes. Deriving
-- from it makes the ladder agree with the money and with the Profile screen
-- by construction, for every bout, however its score columns were filled.
--
-- settle_match() itself is NOT touched: it still passes the winners it paid,
-- which is the same set this function would derive. This migration only
-- rebuilds history.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Who won a bout that is already over
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._rank_winners_of_settled(p_match_id uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT CASE
    WHEN (SELECT m."winner_id" FROM "matches" m WHERE m."id" = p_match_id) IS NOT NULL
      THEN ARRAY[(SELECT m."winner_id" FROM "matches" m WHERE m."id" = p_match_id)]
    ELSE (
      -- A tie: settle_match() credits a payout entry to each fighter who
      -- shared the pot and to nobody else.
      SELECT array_agg(DISTINCT l."user_id" ORDER BY l."user_id")
        FROM "points_ledger_entries" l
       WHERE l."match_id" = p_match_id AND l."reason" = 'payout'
    )
  END
$fn$;

REVOKE ALL ON FUNCTION public._rank_winners_of_settled(uuid)
  FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. Rebuild
--
-- The whole ladder, not a patch over the wrong rows: clear it and replay
-- every settled bout through _rank_apply_match() in order. That keeps one
-- code path producing every trophy in the database, and makes this migration
-- idempotent -- running it twice leaves the same ladder, and any bout that
-- settled between 20260913000000 and this migration is replayed by the same
-- corrected rule rather than being left half-right.
--
-- Safe to clear: rank_history is three hours old, derived in full from
-- matches and the ledger, and nothing else references it.
-- ----------------------------------------------------------------------------

DELETE FROM "rank_history";

UPDATE "fitness_profiles"
   SET "trophies" = 0,
       "current_league" = 'bronze',
       "total_wins" = 0,
       "total_losses" = 0,
       "total_ties" = 0,
       "current_streak" = 0
 WHERE "trophies" <> 0
    OR "current_league" <> 'bronze'
    OR "total_wins" <> 0
    OR "total_losses" <> 0
    OR "total_ties" <> 0
    OR "current_streak" <> 0;

DO $replay$
DECLARE
  r RECORD;
  v_winners uuid[];
BEGIN
  FOR r IN
    SELECT m."id" AS match_id, m."settled_at" AS settled_at
      FROM "matches" m
      JOIN "challenges" c ON c."id" = m."challenge_id"
     WHERE m."settled_at" IS NOT NULL
     ORDER BY m."settled_at" ASC, m."id" ASC
  LOOP
    v_winners := public._rank_winners_of_settled(r.match_id);

    -- A settled bout that paid nobody and named no winner. Nothing here can
    -- say who won it, and inventing an answer is how this migration came to
    -- exist. Leave it off the ladder.
    IF v_winners IS NULL OR cardinality(v_winners) = 0 THEN
      CONTINUE;
    END IF;

    PERFORM public._rank_apply_match(r.match_id, v_winners, r.settled_at);
  END LOOP;
END
$replay$;

NOTIFY pgrst, 'reload schema';
