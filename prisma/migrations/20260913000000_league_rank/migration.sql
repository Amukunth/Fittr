-- ============================================================================
-- Leagues, trophies, and the Rank screen.
--
-- A second ladder, and deliberately not the one 20260909000000 already
-- built. MMR answers "who should this fighter meet?" -- it is per exercise,
-- it is zero-sum, and it is allowed to fall as far as the arithmetic says.
-- Trophies answer "what has this fighter done?" -- one number across every
-- exercise, floored at zero, and the thing the wager ceiling and the public
-- leaderboard are keyed to. Neither is derivable from the other, so both
-- are stored.
--
--   league_tiers        five rows: threshold, wager ceiling, colour. The
--                       ONE definition of where a league starts.
--   league_for()        trophies -> LeagueTier, reading that table
--   fitness_profiles    + trophies, current_league, total_wins,
--                       total_losses, total_ties, current_streak
--   rank_history        one row per settled bout per fighter, plus a row
--                       for each promotion or demotion it caused
--   _rank_apply_match() the whole trophy consequence of one settled bout
--   settle_match()      now awards trophies inside settlement
--   rank_standing()     my counters + my global rank, in one round trip
--   leaderboard_page()  the ranked table, global or friends, paginated
--
-- ----------------------------------------------------------------------------
-- GLOBAL RANK IS COMPUTED, NOT STORED.
--
-- A cached `global_rank` column would have to be rewritten for every player
-- ranked below whoever just won -- an O(n) write on a table that is already
-- the write-hot one (every stake and every payout touches it) and is in the
-- realtime publication, so each of those writes would also be a broadcast.
-- rank_standing() counts the profiles ahead of the caller instead, off the
-- (trophies DESC, created_at) index added below. One count per screen open
-- beats a fan-out per bout.
--
-- ----------------------------------------------------------------------------
-- LOCK ORDER -- read 20260909000000's header first.
--
-- The chain is: lobby `challenges` -> member `matchmaking_queue`
--   -> `fitness_profiles` ORDER BY user_id -> `skill_ratings` ORDER BY user_id.
--
-- Trophies are a fitness_profiles write for EVERY fighter on the bout, not
-- just the winners, so settle_match()'s existing pre-lock is widened below
-- from the winners to the whole field. That is a superset taken at the same
-- point in the same order, so the chain is unchanged -- and it is why the
-- trophy step, which runs last, never acquires a lock it does not already
-- hold. Taking those locks late (after skill_ratings) instead would invert
-- the chain and deadlock two bouts settling over an overlapping field.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The five leagues
--
-- A table rather than a function (the MMR bands are a function) because
-- three of these four facts are shown to the user on the Rank screen's tier
-- cards -- threshold, wager ceiling, colour -- and reference rows the client
-- can read beat three parallel CASE expressions it would otherwise have to
-- mirror. league_for() below is the only thing that reads min_trophies to
-- decide a league, so the table stays the single source of truth.
--
-- Thresholds are set against the award schedule in section 2: at +12 a win,
-- Silver is about five clean wins away, Gold about thirteen, Platinum
-- twenty-five and Diamond forty. Slow enough that a league means a record,
-- fast enough that the first one arrives inside a week of real play.
-- ----------------------------------------------------------------------------

CREATE TYPE "LeagueTier" AS ENUM (
  'bronze',
  'silver',
  'gold',
  'platinum',
  'diamond'
);

CREATE TABLE "league_tiers" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"            "LeagueTier" NOT NULL,
  "min_trophies"    INTEGER NOT NULL,
  -- In cents, and forward-looking: the pilot stakes points, and nothing in
  -- matchmaking reads this yet. It is the ceiling that applies the day
  -- real-money play is switched on, which is a server-side decision (see
  -- REAL_MONEY_NOTICE in src/theme/copy.ts). Stored in cents so no money
  -- value in this schema is ever a float.
  "max_wager_cents" INTEGER NOT NULL,
  "color_hex"       TEXT NOT NULL,
  CONSTRAINT "league_tiers_name_key" UNIQUE ("name"),
  CONSTRAINT "league_tiers_min_trophies_key" UNIQUE ("min_trophies"),
  CONSTRAINT "league_tiers_min_trophies_nonneg" CHECK ("min_trophies" >= 0),
  CONSTRAINT "league_tiers_max_wager_positive" CHECK ("max_wager_cents" > 0),
  CONSTRAINT "league_tiers_color_hex_format" CHECK ("color_hex" ~ '^#[0-9A-F]{6}$')
);

INSERT INTO "league_tiers" ("name", "min_trophies", "max_wager_cents", "color_hex") VALUES
  ('bronze',     0,  1000, '#CD7F32'),
  ('silver',    50,  2500, '#C0C0C0'),
  ('gold',     150,  5000, '#FFD700'),
  ('platinum', 300, 10000, '#00CFCF'),
  ('diamond',  500, 25000, '#B9F2FF');

ALTER TABLE "league_tiers" ENABLE ROW LEVEL SECURITY;

-- Reference data, not user data: every signed-in client reads all five rows
-- to draw the tier cards. Nobody writes it but a migration.
CREATE POLICY "league_tiers_select_all" ON "league_tiers"
  FOR SELECT USING (auth.role() = 'authenticated');

REVOKE ALL ON "league_tiers" FROM anon, authenticated;
GRANT SELECT ON "league_tiers" TO authenticated;

-- The one definition of which league a trophy count is in. STABLE rather
-- than IMMUTABLE because it reads a table; the coalesce is there so a league
-- is still returned if the seed above is ever emptied by hand.
CREATE OR REPLACE FUNCTION public.league_for(p_trophies integer)
RETURNS "LeagueTier"
LANGUAGE sql
STABLE
AS $fn$
  SELECT coalesce(
    (
      SELECT t."name"
        FROM "league_tiers" t
       WHERE t."min_trophies" <= greatest(coalesce(p_trophies, 0), 0)
       ORDER BY t."min_trophies" DESC
       LIMIT 1
    ),
    'bronze'::"LeagueTier"
  )
$fn$;

GRANT EXECUTE ON FUNCTION public.league_for(integer) TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. The award schedule
--
-- Functions, not a settings table, matching the _mm_* and _mmr_* tunables
-- before them: the values stay in version control next to the code that
-- reads them. Mirrored in src/lib/league.ts and asserted against these
-- functions in __tests__/rank.db.test.ts, so the two cannot drift.
--
-- A win is worth twice what a loss costs. That asymmetry is deliberate:
-- trophies are a record of what someone has done, so a fighter who plays a
-- lot and wins half should climb. MMR is where the zero-sum accounting
-- lives, and it is the number matchmaking actually pairs on, so nothing is
-- lost by letting this ladder be generous.
--
-- The streak bonus is capped so the top of the ladder cannot be sprinted:
-- an unbroken run is worth at most +5 a bout over the base, which is a
-- meaningful nudge and not a second scoring system.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._trophy_win_base() RETURNS integer
LANGUAGE sql IMMUTABLE AS $fn$ SELECT 12 $fn$;

CREATE OR REPLACE FUNCTION public._trophy_loss_penalty() RETURNS integer
LANGUAGE sql IMMUTABLE AS $fn$ SELECT 6 $fn$;

-- Shared first place in a group battle. Half a win, and it neither extends
-- nor breaks a streak: nobody beat this fighter, and nobody was beaten.
CREATE OR REPLACE FUNCTION public._trophy_tie_award() RETURNS integer
LANGUAGE sql IMMUTABLE AS $fn$ SELECT 6 $fn$;

CREATE OR REPLACE FUNCTION public._trophy_streak_bonus_cap() RETURNS integer
LANGUAGE sql IMMUTABLE AS $fn$ SELECT 5 $fn$;

-- What a win is worth to a fighter it leaves on p_streak_after straight
-- wins. The first win of a run is the base; each one after adds a trophy,
-- to the cap.
CREATE OR REPLACE FUNCTION public._trophy_win_award(p_streak_after integer)
RETURNS integer
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT public._trophy_win_base()
       + least(
           greatest(coalesce(p_streak_after, 1) - 1, 0),
           public._trophy_streak_bonus_cap()
         )
$fn$;

REVOKE ALL ON FUNCTION public._trophy_win_base() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._trophy_loss_penalty() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._trophy_tie_award() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._trophy_streak_bonus_cap() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._trophy_win_award(integer) FROM PUBLIC, anon;

-- ----------------------------------------------------------------------------
-- 3. The standing, on the profile
--
-- These six live on fitness_profiles rather than in a table of their own for
-- one reason: fitness_profiles is already in the supabase_realtime
-- publication, filtered per-subscriber by fitness_profiles_select_own. A
-- trophy award therefore reaches the fighter's own phone with no new
-- subscription, no new policy, and no second source of truth about who they
-- are. The Rank screen's live counter is that existing channel.
--
-- total_ties is not next to wins and losses by accident. A group battle can
-- end with two fighters sharing first, which is neither a win nor a loss,
-- and src/lib/boutStats.ts has always counted it in the denominator of the
-- win rate. Without this column the Rank screen's win rate and the Profile
-- screen's would differ by exactly the ties.
--
-- No client grant is added: REVOKE UPDATE / GRANT UPDATE(strength_tier)
-- from 20260902000000 still stands, so the only writer is section 5, which
-- is SECURITY DEFINER.
-- ----------------------------------------------------------------------------

ALTER TABLE "fitness_profiles"
  ADD COLUMN "trophies"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "current_league" "LeagueTier" NOT NULL DEFAULT 'bronze',
  ADD COLUMN "total_wins"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "total_losses"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "total_ties"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "current_streak" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "fitness_profiles"
  ADD CONSTRAINT "fitness_profiles_trophies_nonneg" CHECK ("trophies" >= 0),
  ADD CONSTRAINT "fitness_profiles_record_nonneg"
    CHECK ("total_wins" >= 0 AND "total_losses" >= 0 AND "total_ties" >= 0
           AND "current_streak" >= 0);

-- The leaderboard's ordering and rank_standing()'s "how many are ahead of
-- me" count, in one index. created_at is the tiebreak so two fighters on
-- equal trophies are ordered by who has been here longer -- stable, and it
-- cannot flip under a page boundary the way an arbitrary order would.
CREATE INDEX "fitness_profiles_trophies_idx"
  ON "fitness_profiles" ("trophies" DESC, "created_at" ASC);

-- ----------------------------------------------------------------------------
-- 4. Rank history
--
-- One row per fighter per settled bout, plus a row for each promotion or
-- demotion that bout caused. The bout row carries the delta and the balance
-- it left behind, so the Rank screen's timeline is a straight read rather
-- than a running sum the client has to keep -- and so a trophy count can
-- always be audited against sum(trophy_delta).
--
-- Deliberately NOT added to the realtime publication. The profile row
-- already broadcasts the consequence of an award (the count and the league);
-- the timeline entry is read the next time the screen opens, and publishing
-- a second table to say the same thing would double the WAL for it.
-- ----------------------------------------------------------------------------

CREATE TYPE "RankEventType" AS ENUM (
  'win',
  'loss',
  'tie',
  'promotion',
  'demotion'
);

CREATE TABLE "rank_history" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  "event_type"     "RankEventType" NOT NULL,
  -- Signed, and already floored: a loss at zero trophies records a delta of
  -- 0, not -6, because that is what happened to the balance.
  "trophy_delta"   INTEGER NOT NULL,
  -- The balance AFTER this event.
  "trophy_balance" INTEGER NOT NULL,
  -- The other fighter, and only in a two-seat bout. A group battle has no
  -- single opponent to name, so it stays null and the copy says so.
  "opponent_id"    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- The bout behind the event. Null is reserved for awards that are not a
  -- bout result; nothing writes one yet.
  "match_id"       UUID REFERENCES "matches"("id") ON DELETE CASCADE,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "rank_history_balance_nonneg" CHECK ("trophy_balance" >= 0),
  -- A promotion is a consequence of the bout row next to it, not a second
  -- award, so it never moves the balance.
  CONSTRAINT "rank_history_move_is_a_result" CHECK (
    ("event_type" IN ('promotion', 'demotion') AND "trophy_delta" = 0)
    OR "event_type" IN ('win', 'loss', 'tie')
  )
);

CREATE INDEX "rank_history_user_id_created_at_idx"
  ON "rank_history" ("user_id", "created_at" DESC);

-- One result per fighter per bout, whatever races or replays reach
-- _rank_apply_match(). The same guarantee skill_rating_events gets from its
-- (user_id, match_id) key, restricted to the result rows so a promotion can
-- sit alongside its bout row.
CREATE UNIQUE INDEX "rank_history_one_result_per_bout_idx"
  ON "rank_history" ("user_id", "match_id")
  WHERE "event_type" IN ('win', 'loss', 'tie');

ALTER TABLE "rank_history" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rank_history_select_own" ON "rank_history"
  FOR SELECT USING ("user_id" = auth.uid());

REVOKE ALL ON "rank_history" FROM anon, authenticated;
GRANT SELECT ON "rank_history" TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. The trophy consequence of one settled bout
--
-- Everything a settled bout does to the ladder, for the whole field, in one
-- place: the award, the streak, the record counters, the league, and the
-- history rows. settle_match() calls it, and so does the backfill in
-- section 9 -- which is the point of it being a function rather than inline
-- SQL, because a fighter's trophy count and their history must be produced
-- by the same rules whether the bout settled today or last week.
--
-- Winners are passed in rather than recomputed. settle_match() has already
-- decided who won in order to pay the pot out; recomputing here would open
-- the possibility of the trophies going to someone the money did not.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._rank_apply_match(
  p_match_id uuid,
  p_winners uuid[],
  p_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_at        timestamptz := coalesce(p_at, now());
  v_shared    boolean := coalesce(cardinality(p_winners), 0) > 1;
  v_seats     integer;
  v_fighter   uuid;
  v_outcome   "RankEventType";
  v_delta     integer;
  v_streak    integer;
  v_before    integer;
  v_after     integer;
  v_was       "LeagueTier";
  v_now       "LeagueTier";
  v_opponent  uuid;
BEGIN
  -- Exactly-once, independently of settle_match()'s settled_at guard, so a
  -- hand re-run or a backfill over an already-credited bout is a no-op
  -- rather than a second award.
  IF EXISTS (SELECT 1 FROM "rank_history" h WHERE h."match_id" = p_match_id) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_seats
    FROM "match_participants" mp WHERE mp."match_id" = p_match_id;

  FOR v_fighter IN
    SELECT mp."user_id"
      FROM "match_participants" mp
     WHERE mp."match_id" = p_match_id
     -- The documented lock order. Called from settle_match() these rows are
     -- already held, so this re-takes locks rather than acquiring new ones;
     -- called from the backfill it is the only lock taken.
     ORDER BY mp."user_id"
  LOOP
    SELECT fp."trophies", fp."current_league", fp."current_streak"
      INTO v_before, v_was, v_streak
      FROM "fitness_profiles" fp
     WHERE fp."user_id" = v_fighter
     FOR UPDATE;

    -- A fighter with no profile row cannot be credited. Nothing can create
    -- that state today (enter_matchmaking needs the balance), so it is a
    -- skip rather than an exception that would take settlement down.
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF v_fighter = ANY (p_winners) THEN
      IF v_shared THEN
        v_outcome := 'tie';
        v_delta := public._trophy_tie_award();
      ELSE
        v_outcome := 'win';
        v_streak := v_streak + 1;
        v_delta := public._trophy_win_award(v_streak);
      END IF;
    ELSE
      v_outcome := 'loss';
      v_streak := 0;
      v_delta := -public._trophy_loss_penalty();
    END IF;

    v_after := greatest(v_before + v_delta, 0);
    -- Re-derive the delta from the floor, so the history row always
    -- describes the change that actually happened to the balance.
    v_delta := v_after - v_before;
    v_now := public.league_for(v_after);

    v_opponent := NULL;
    IF v_seats = 2 THEN
      SELECT mp."user_id" INTO v_opponent
        FROM "match_participants" mp
       WHERE mp."match_id" = p_match_id AND mp."user_id" <> v_fighter;
    END IF;

    UPDATE "fitness_profiles" fp
       SET "trophies"       = v_after,
           "current_league" = v_now,
           "current_streak" = v_streak,
           "total_wins"     = fp."total_wins"   + CASE WHEN v_outcome = 'win'  THEN 1 ELSE 0 END,
           "total_losses"   = fp."total_losses" + CASE WHEN v_outcome = 'loss' THEN 1 ELSE 0 END,
           "total_ties"     = fp."total_ties"   + CASE WHEN v_outcome = 'tie'  THEN 1 ELSE 0 END,
           "updated_at"     = now()
     WHERE fp."user_id" = v_fighter;

    INSERT INTO "rank_history"
      ("user_id", "event_type", "trophy_delta", "trophy_balance",
       "opponent_id", "match_id", "created_at")
      VALUES (v_fighter, v_outcome, v_delta, v_after, v_opponent, p_match_id, v_at);

    IF v_now IS DISTINCT FROM v_was THEN
      -- A millisecond after its cause, so "Promoted to Gold" sorts above
      -- the win that earned it in a newest-first timeline.
      INSERT INTO "rank_history"
        ("user_id", "event_type", "trophy_delta", "trophy_balance",
         "opponent_id", "match_id", "created_at")
        VALUES (
          v_fighter,
          CASE WHEN v_after > v_before THEN 'promotion' ELSE 'demotion' END::"RankEventType",
          0, v_after, NULL, p_match_id, v_at + interval '1 millisecond'
        );
    END IF;
  END LOOP;
END;
$fn$;

REVOKE ALL ON FUNCTION public._rank_apply_match(uuid, uuid[], timestamptz)
  FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6. settle_match(), with trophies folded in
--
-- Verbatim from 20260909000000 except for two changes, both marked below:
--
--   * the fitness_profiles pre-lock covers the whole field rather than the
--     winners, because the trophy step writes a row for every fighter (see
--     the LOCK ORDER note at the top);
--   * one _rank_apply_match() call, after the payout and after the rating,
--     before settled_at is stamped.
--
-- The placement is the same bargain the rating made: a bout that returns
-- needs_review awards nothing and awards normally on the later call that
-- clears it, a bout that returns already_settled never reaches here, and a
-- trophy write that fails takes the whole settlement down rather than
-- leaving a paid-out bout with no record of itself on the ladder.
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

  -- CHANGED IN 20260913000000: the whole field, not just the winners. The
  -- trophy step at the end writes a fitness_profiles row for every fighter,
  -- and every lock it needs has to be taken here, in user_id order, before
  -- the skill_ratings locks further down.
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

  -- The rating, from the same scores the pot was just decided on. Every
  -- fighter is rated, not just the winners: an Elo update is a statement
  -- about the whole field.
  PERFORM public._mmr_rate_match(p_match_id, v_challenge.type, v_challenge.max_participants);

  -- ADDED IN 20260913000000: trophies, streak, record and league, from the
  -- same winners the pot was paid to. Every profile row it touches is
  -- already locked by the PERFORM above.
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
-- 7. Reading the ladder
--
-- fitness_profiles_select_own means a client can read exactly one profile:
-- its own. A leaderboard is the opposite of that, so these three functions
-- are SECURITY DEFINER and each one is a deliberate, narrow widening --
-- they return a handle, a picture, a trophy count and a league, and nothing
-- else. Balance, strength tier, gender, age band, e-mail and MMR stay
-- unreadable. The handle and the picture are already effectively public
-- (the avatars bucket is world-readable by design, and the point of a
-- username is that opponents see it); the trophy count and the league are
-- the leaderboard.
--
-- A composite return type rather than RETURNS TABLE: OUT parameters are
-- plpgsql variables, and half of these names (user_id, trophies, username)
-- are also column names in the query underneath them.
-- ----------------------------------------------------------------------------

CREATE TYPE public.leaderboard_row AS (
  "rank"         BIGINT,
  "user_id"      UUID,
  "username"     TEXT,
  "display_name" TEXT,
  "avatar_url"   TEXT,
  "trophies"     INTEGER,
  "league"       "LeagueTier",
  "is_me"        BOOLEAN
);

CREATE TYPE public.rank_standing_row AS (
  "user_id"        UUID,
  "trophies"       INTEGER,
  "current_league" "LeagueTier",
  "total_wins"     INTEGER,
  "total_losses"   INTEGER,
  "total_ties"     INTEGER,
  "current_streak" INTEGER,
  "global_rank"    BIGINT
);

-- Who is on the board, for a scope. 'global' is everyone; 'friends' is the
-- fighters this user has actually shared a bout with, plus themselves.
--
-- There is no follow graph in this schema, and inventing one to satisfy the
-- word "friends" would be a social feature smuggled in under a leaderboard.
-- Who you have fought is a real relationship the database already holds, it
-- is symmetric, and it needs no new table, no new consent flow and no
-- moderation surface. If a follow graph ever lands, this is the one place
-- that changes.
--
-- Deleted accounts are excluded: delete_my_account() bans the auth row
-- rather than removing it (bout history on both sides has to survive), so
-- the ban is the marker for "no longer a player".
CREATE OR REPLACE FUNCTION public._leaderboard_scope(p_scope text, p_viewer uuid)
RETURNS TABLE ("user_id" uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT fp."user_id"
    FROM "fitness_profiles" fp
    JOIN auth.users u ON u.id = fp."user_id"
   WHERE (u.banned_until IS NULL OR u.banned_until <= now())
     AND (
       p_scope = 'global'
       OR fp."user_id" = p_viewer
       OR EXISTS (
            SELECT 1
              FROM "match_participants" mine
              JOIN "match_participants" theirs ON theirs."match_id" = mine."match_id"
             WHERE mine."user_id" = p_viewer
               AND theirs."user_id" = fp."user_id"
          )
     )
$fn$;

REVOKE ALL ON FUNCTION public._leaderboard_scope(text, uuid) FROM PUBLIC, anon, authenticated;

-- One page of the board, ranked. The ordering is the one the
-- fitness_profiles_trophies_idx index serves, with user_id as a final
-- tiebreak so a page boundary can never drop or repeat a row.
CREATE OR REPLACE FUNCTION public.leaderboard_page(
  p_scope text DEFAULT 'global',
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS SETOF public.leaderboard_row
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_me uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  IF p_scope NOT IN ('global', 'friends') THEN
    RAISE EXCEPTION 'unknown leaderboard scope %', p_scope;
  END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT fp."user_id"        AS uid,
           fp."username"::text AS handle,
           fp."display_name"   AS shown,
           fp."avatar_url"     AS photo,
           fp."trophies"       AS cups,
           fp."current_league" AS tier,
           row_number() OVER (
             ORDER BY fp."trophies" DESC, fp."created_at" ASC, fp."user_id" ASC
           ) AS place
      FROM "fitness_profiles" fp
     WHERE fp."user_id" IN (
             SELECT sc."user_id" FROM public._leaderboard_scope(p_scope, v_me) sc
           )
  )
  SELECT s.place, s.uid, s.handle, s.shown, s.photo, s.cups, s.tier, s.uid = v_me
    FROM scoped s
   ORDER BY s.place
   OFFSET v_offset
   LIMIT v_limit;
END;
$fn$;

REVOKE ALL ON FUNCTION public.leaderboard_page(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leaderboard_page(text, integer, integer) TO authenticated;

-- The caller's own row, wherever it falls. What the Rank screen pins to the
-- bottom of the list when the fighter is not on the page being shown.
CREATE OR REPLACE FUNCTION public.leaderboard_self(p_scope text DEFAULT 'global')
RETURNS public.leaderboard_row
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_me uuid := auth.uid();
  v_row public.leaderboard_row;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  IF p_scope NOT IN ('global', 'friends') THEN
    RAISE EXCEPTION 'unknown leaderboard scope %', p_scope;
  END IF;

  SELECT s.place, s.uid, s.handle, s.shown, s.photo, s.cups, s.tier, true
    INTO v_row
    FROM (
      SELECT fp."user_id"        AS uid,
             fp."username"::text AS handle,
             fp."display_name"   AS shown,
             fp."avatar_url"     AS photo,
             fp."trophies"       AS cups,
             fp."current_league" AS tier,
             row_number() OVER (
               ORDER BY fp."trophies" DESC, fp."created_at" ASC, fp."user_id" ASC
             ) AS place
        FROM "fitness_profiles" fp
       WHERE fp."user_id" IN (
               SELECT sc."user_id" FROM public._leaderboard_scope(p_scope, v_me) sc
             )
    ) s
   WHERE s.uid = v_me;

  -- SELECT INTO a record variable that finds nothing leaves every FIELD
  -- null rather than leaving the variable null, and PostgREST would render
  -- that as a row of nulls -- which the client would take for a real
  -- standing and pin to the board. Return nothing instead.
  IF v_row."user_id" IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN v_row;
END;
$fn$;

REVOKE ALL ON FUNCTION public.leaderboard_self(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leaderboard_self(text) TO authenticated;

-- The whole hero section in one round trip: the counters the client could
-- read off its own profile row anyway, plus the global rank it could not.
--
-- The rank is a count of the profiles ahead, not a window function over the
-- whole table: same answer, and it reads an index range instead of sorting
-- every player to find one row. The tiebreaks match leaderboard_page()'s
-- ORDER BY exactly, so "#42 globally" is the same 42 the board would put
-- them at.
CREATE OR REPLACE FUNCTION public.rank_standing()
RETURNS public.rank_standing_row
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_me uuid := auth.uid();
  v_row public.rank_standing_row;
  v_mine "fitness_profiles"%ROWTYPE;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;

  SELECT * INTO v_mine FROM "fitness_profiles" fp WHERE fp."user_id" = v_me;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_row."user_id"        := v_mine."user_id";
  v_row."trophies"       := v_mine."trophies";
  v_row."current_league" := v_mine."current_league";
  v_row."total_wins"     := v_mine."total_wins";
  v_row."total_losses"   := v_mine."total_losses";
  v_row."total_ties"     := v_mine."total_ties";
  v_row."current_streak" := v_mine."current_streak";

  SELECT 1 + count(*)
    INTO v_row."global_rank"
    FROM "fitness_profiles" fp
   WHERE fp."user_id" IN (
           SELECT sc."user_id" FROM public._leaderboard_scope('global', v_me) sc
         )
     AND (
       fp."trophies" > v_mine."trophies"
       OR (fp."trophies" = v_mine."trophies" AND fp."created_at" < v_mine."created_at")
       OR (fp."trophies" = v_mine."trophies" AND fp."created_at" = v_mine."created_at"
           AND fp."user_id" < v_mine."user_id")
     );

  RETURN v_row;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rank_standing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rank_standing() TO authenticated;

-- ----------------------------------------------------------------------------
-- 8. Every player has a name
--
-- 20260907000000 backfilled usernames from the sign-up handle, but nothing
-- since then sets one: fitness_profiles rows are created by the app with a
-- user_id and a tier only, and Settings > Profile is the sole writer. That
-- was invisible while a profile was something only its owner could read.
-- A leaderboard makes it visible, so the same backfill runs again over
-- whoever has arrived since. Idempotent: it only touches NULL usernames.
-- ----------------------------------------------------------------------------

DO $backfill$
DECLARE
  r RECORD;
  v_base text;
  v_candidate text;
  v_n integer;
BEGIN
  FOR r IN
    SELECT p."user_id", u.raw_user_meta_data->>'handle' AS handle, u.email
      FROM "fitness_profiles" p
      JOIN auth.users u ON u.id = p."user_id"
     WHERE p."username" IS NULL
       AND (u.banned_until IS NULL OR u.banned_until <= now())
     ORDER BY p."created_at"
  LOOP
    v_base := regexp_replace(
      public.normalize_username(
        coalesce(nullif(r.handle, ''), split_part(coalesce(r.email, ''), '@', 1))
      ),
      '[^a-z0-9._]', '', 'g');
    v_base := regexp_replace(v_base, '^[._]+', '');
    IF length(v_base) < 3 THEN
      v_base := 'fighter' || substr(replace(r."user_id"::text, '-', ''), 1, 6);
    END IF;
    v_base := substr(v_base, 1, 20);
    v_candidate := v_base;
    v_n := 1;
    WHILE EXISTS (SELECT 1 FROM "fitness_profiles" WHERE "username" = v_candidate::citext) LOOP
      v_n := v_n + 1;
      v_candidate := substr(v_base, 1, 20 - length(v_n::text)) || v_n::text;
    END LOOP;
    UPDATE "fitness_profiles" SET "username" = v_candidate::citext WHERE "user_id" = r."user_id";
  END LOOP;
END
$backfill$;

-- ----------------------------------------------------------------------------
-- 9. Replay the bouts that already happened
--
-- Everyone who has fought arrives on the new ladder with the record they
-- earned, rather than at zero with an empty timeline. Chronological, and
-- through _rank_apply_match() -- the same function settlement calls -- so
-- the backfilled trophies, streaks, counters and history rows are produced
-- by exactly the rules a bout settling a minute from now will use, streak
-- bonus and all.
--
-- Winners are recomputed from the recorded scores with settle_match()'s own
-- rule. `race` is skipped because settlement has never been implemented for
-- it, and a needs_review bout has no settled_at, so neither can appear here.
-- ----------------------------------------------------------------------------

DO $replay$
DECLARE
  r RECORD;
  v_best integer;
  v_winners uuid[];
BEGIN
  FOR r IN
    SELECT m."id" AS match_id, m."settled_at" AS settled_at, c."type" AS type
      FROM "matches" m
      JOIN "challenges" c ON c."id" = m."challenge_id"
     WHERE m."settled_at" IS NOT NULL
       AND c."type" IN ('pushups', 'plank', 'wallsit')
     ORDER BY m."settled_at" ASC, m."id" ASC
  LOOP
    SELECT max(CASE WHEN r.type = 'pushups' THEN mp."rep_count" ELSE mp."hold_duration_seconds" END)
      INTO v_best
      FROM "match_participants" mp WHERE mp."match_id" = r.match_id;
    CONTINUE WHEN v_best IS NULL;

    SELECT array_agg(mp."user_id" ORDER BY mp."user_id")
      INTO v_winners
      FROM "match_participants" mp
     WHERE mp."match_id" = r.match_id
       AND CASE WHEN r.type = 'pushups' THEN mp."rep_count" ELSE mp."hold_duration_seconds" END = v_best;

    PERFORM public._rank_apply_match(r.match_id, v_winners, r.settled_at);
  END LOOP;
END
$replay$;

-- ----------------------------------------------------------------------------
-- 10. Realtime
--
-- Nothing to add. fitness_profiles has been in the supabase_realtime
-- publication since 20260903100000, and the six columns above ride the same
-- per-row UPDATE payload the balance already does -- which is exactly why
-- the standing lives on that table. rank_history is deliberately left off
-- (see section 4).
-- ----------------------------------------------------------------------------

NOTIFY pgrst, 'reload schema';
