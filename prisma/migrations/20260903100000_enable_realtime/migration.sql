-- Put `challenges` and `fitness_profiles` on the wire for Supabase Realtime.
--
-- WHY THIS MIGRATION EXISTS: Supabase ships the `supabase_realtime`
-- publication EMPTY. Postgres changes are only broadcast for tables
-- explicitly added to it, so client-side .channel(...).on('postgres_changes')
-- code connects, reports SUBSCRIBED, and then silently never fires. Nothing
-- in the app's realtime path works without this.
--
-- This grants no new privileges. Realtime re-checks each table's SELECT
-- policy for every subscriber; publication membership only decides which
-- tables produce WAL events at all.
--
-- ---------------------------------------------------------------------------
-- `challenges` — "someone accepted your challenge"
--
-- WHY challenges AND NOT matches:
--   * RLS is enforced on every broadcast. challenges_select_all is a flat
--     `auth.role() = 'authenticated'` check, so it always passes for a
--     signed-in user. matches_select_participant is an EXISTS subquery into
--     match_participants, whose rows join_challenge() writes in the SAME
--     transaction as the matches row — far more fragile to reason about.
--   * Realtime filters are server-side. `created_by=eq.<uid>` means a
--     challenge creator's socket only ever carries their own challenges.
--     `matches` has no user column, so it cannot be filtered per-user at all
--     and every client would receive (then RLS-drop) every match.
--   * status 'open' -> 'matched' IS the semantic "someone accepted" event.
--     A matches INSERT is a second-order signal for the same thing.
--
-- The tradeoff: an UPDATE payload on challenges carries no match_id, so a
-- notified creator does one follow-up `select id from matches where
-- challenge_id = ...`. That read is allowed — join_challenge() has already
-- inserted them into match_participants by the time the event fires.
--
-- ---------------------------------------------------------------------------
-- `fitness_profiles` — live points balance
--
-- points_balance moves underneath the client without the client asking:
-- join_challenge() deducts BOTH users' stakes, and the creator never called
-- anything. fitness_profiles_select_own (`auth.uid() = user_id`) is already
-- exactly the right per-subscriber check, and the client filters
-- `user_id=eq.<uid>` server-side, so a subscriber only ever sees their own
-- row on the wire.

-- REPLICA IDENTITY FULL makes payload.old available on UPDATE. The client
-- code today only reads payload.new (`status === 'matched'`), which works
-- under the default (primary-key) replica identity — but without FULL,
-- payload.old is just the id, so no consumer can ever distinguish a real
-- open->matched transition from a no-op UPDATE. Cheap insurance on a table
-- this narrow; drop it if challenges ever becomes write-hot.
ALTER TABLE "challenges" REPLICA IDENTITY FULL;

-- Deliberately NOT set on fitness_profiles. It is the write-hot table here —
-- every stake and every future payout updates it, twice per match — and FULL
-- writes the entire old tuple into the WAL on each of those. Nothing reads
-- payload.old for balances: ProfileScreen renders payload.new.points_balance
-- outright. Revisit only if a consumer needs the delta rather than the total.

DO $$
DECLARE
  v_table TEXT;
BEGIN
  -- Guarded so this migration is a no-op on a plain Postgres (local `prisma
  -- migrate dev`, CI) where Supabase's publication does not exist.
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    RAISE NOTICE 'publication supabase_realtime not found - skipping (not a Supabase database?)';
    RETURN;
  END IF;

  FOREACH v_table IN ARRAY ARRAY['challenges', 'fitness_profiles'] LOOP
    -- ALTER PUBLICATION ... ADD TABLE errors if the table is already a
    -- member, so this stays re-runnable.
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = v_table
    ) THEN
      EXECUTE format(
        'ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table
      );
    END IF;
  END LOOP;
END
$$;
