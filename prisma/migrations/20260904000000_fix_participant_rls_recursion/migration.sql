-- Fix: every client read of matches / match_participants failed with
--   ERROR: infinite recursion detected in policy for relation "match_participants"
--
-- WHY. match_participants_select_participant (20260902000000) decided "is the
-- caller in this match" with an EXISTS subquery against match_participants —
-- the table the policy is ON. Postgres applies RLS to every table a policy
-- references, so evaluating the policy re-entered the same policy, and the
-- rewriter rejects that at plan time, before it looks at a single row. The
-- `user_id = auth.uid() OR ...` short-circuit does not help: the error is
-- structural, not data-dependent. matches_select_participant subqueries into
-- match_participants too, so it inherited the failure.
--
-- Nothing that WRITES was affected — join_challenge(), submit_verification_
-- session() and settle_match() are SECURITY DEFINER and bypass RLS — which is
-- why the symptom was "Accept flips the challenge to matched, then the app can
-- never load the match it just created": ChallengeDetail's Go to Match button
-- (gated on the matches read) never appeared, MatchFoundWatcher's follow-up
-- matches read failed silently, and MatchInProgress/Results would error.
--
-- FIX. The standard Supabase pattern: do the membership lookup inside a
-- SECURITY DEFINER function. It runs as the function owner (the table owner),
-- so RLS is not applied to the lookup itself and the policy no longer
-- re-enters. Postgres never inlines SECURITY DEFINER SQL functions, so this
-- stays a real function call and cannot be optimised back into the recursion.
-- auth.uid() still reads the caller's JWT claims — request-scoped settings
-- survive SECURITY DEFINER (join_challenge already relies on this).
--
-- verification_sessions_select_own is deliberately left alone: it references
-- match_participants (not itself), and with match_participants now guarded by
-- the function there is no cycle left for it to fall into.

CREATE OR REPLACE FUNCTION public.is_match_participant(p_match_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "match_participants"
    WHERE match_id = p_match_id
      AND user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_match_participant(uuid) TO authenticated;

-- Same semantics as before: a participant sees the match and every
-- participant row in it (both sides need each other's scores). Only the
-- mechanism changes.
DROP POLICY IF EXISTS "matches_select_participant" ON "matches";
CREATE POLICY "matches_select_participant" ON "matches"
    FOR SELECT USING (public.is_match_participant(id));

DROP POLICY IF EXISTS "match_participants_select_participant" ON "match_participants";
CREATE POLICY "match_participants_select_participant" ON "match_participants"
    FOR SELECT USING (public.is_match_participant(match_id));
