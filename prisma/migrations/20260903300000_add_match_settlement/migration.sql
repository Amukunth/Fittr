-- Match settlement + hold-duration verification.
--
-- Two things land together because they are the same code path: settlement
-- has to know which column holds the verified result, and that depends on
-- the challenge type that submit_verification_session() just wrote.
--
-- Same rules as every other write in this schema: SECURITY DEFINER, pinned
-- search_path, no client-side ledger or status writes anywhere.

-- ============================================================================
-- settle_match()
--
-- Runs once BOTH participants have a VerificationSession. Idempotent and safe
-- to call repeatedly — the settled_at guard makes a second call a no-op, so it
-- does not matter that both clients may race to invoke it.
--
-- WINNER RULES
--   pushups        -> higher match_participants.rep_count wins
--   plank, wallsit -> higher match_participants.hold_duration_seconds wins
--   race           -> NOT implemented. time_seconds would be lower-is-better,
--                     and nothing produces that column yet. Raises rather than
--                     guessing a direction.
--
-- TIE RULE (explicit, not incidental): nobody wins. Each participant is
-- refunded exactly their own stake, matches.winner_id stays NULL, and
-- settled_at IS set — a tie is a completed match, not an unsettled one. Net
-- points change is 0 for both. The alternative (split the pot) is identical
-- arithmetic for a 2-player match but reads as a won payout in the ledger,
-- which would misreport "matches won" later.
--
-- PAYOUT ARITHMETIC. Both sides were debited stake_points by join_challenge()
-- at match creation. The pot is therefore 2 * stake_points and it ALL goes to
-- the winner, as a single 'payout' ledger entry:
--   winner: -stake (already taken) + 2*stake = net +stake
--   loser:  -stake (already taken)           = net -stake
-- Zero-sum, and the loser's stake is never touched a second time.
--
-- ANOMALY GATE. If the session that DECIDES the outcome is flagged and not yet
-- reviewed, nothing is paid and the challenge goes to 'needs_review' with
-- settled_at left NULL. Which session decides:
--   decisive result -> the winner's session only. A flagged loser cannot
--                      manufacture a payout to themselves by losing.
--   tie             -> either session blocks. A tie refund is net-zero, but a
--                      flagged tie may not actually BE a tie.
-- RESOLUTION PATH: verification_sessions.reviewed is what clears it. That
-- column has no client INSERT/UPDATE policy, so only a service-role reviewer
-- can set it; once set, calling settle_match() again pays out normally. This
-- is why the gate tests `anomaly_flag AND NOT reviewed` rather than
-- anomaly_flag alone — it gives that column its purpose.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.settle_match(p_match_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match "matches"%ROWTYPE;
  v_challenge "challenges"%ROWTYPE;
  v_a RECORD;
  v_b RECORD;
  v_participants INTEGER;
  v_submitted INTEGER;
  v_score_a INTEGER;
  v_score_b INTEGER;
  v_winner UUID;
  v_blocked BOOLEAN;
  v_stake INTEGER;
BEGIN
  SELECT * INTO v_match FROM "matches" WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'match % not found', p_match_id;
  END IF;

  -- Callable by a participant, or by a service role (auth.uid() IS NULL) for
  -- back-office re-settlement after a manual review. Not by arbitrary signed-
  -- in users: harmless in practice, but there is no reason to expose it.
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
  IF v_participants <> 2 THEN
    RAISE EXCEPTION 'settle_match expects exactly 2 participants, found % on match %',
      v_participants, p_match_id;
  END IF;

  SELECT count(*) INTO v_submitted
    FROM "match_participants" mp
    JOIN "verification_sessions" vs ON vs.match_participant_id = mp.id
    WHERE mp.match_id = p_match_id;

  -- The normal "first participant finished" case. Not an error.
  IF v_submitted < 2 THEN
    RETURN 'not_ready';
  END IF;

  -- Ordered by user_id purely so a/b are deterministic across calls.
  SELECT mp.user_id, mp.rep_count, mp.hold_duration_seconds,
         vs.anomaly_flag, vs.reviewed
    INTO v_a
    FROM "match_participants" mp
    JOIN "verification_sessions" vs ON vs.match_participant_id = mp.id
    WHERE mp.match_id = p_match_id
    ORDER BY mp.user_id OFFSET 0 LIMIT 1;

  SELECT mp.user_id, mp.rep_count, mp.hold_duration_seconds,
         vs.anomaly_flag, vs.reviewed
    INTO v_b
    FROM "match_participants" mp
    JOIN "verification_sessions" vs ON vs.match_participant_id = mp.id
    WHERE mp.match_id = p_match_id
    ORDER BY mp.user_id OFFSET 1 LIMIT 1;

  IF v_challenge.type = 'pushups' THEN
    v_score_a := v_a.rep_count;
    v_score_b := v_b.rep_count;
  ELSIF v_challenge.type IN ('plank', 'wallsit') THEN
    v_score_a := v_a.hold_duration_seconds;
    v_score_b := v_b.hold_duration_seconds;
  ELSE
    RAISE EXCEPTION 'settlement is not implemented for % challenges', v_challenge.type;
  END IF;

  -- A session exists but its score column is NULL: submit_verification_session
  -- and settle_match disagree about which column this type uses. Refuse rather
  -- than silently treat NULL as a loss.
  IF v_score_a IS NULL OR v_score_b IS NULL THEN
    RAISE EXCEPTION 'match % has a verification session with no % score recorded',
      p_match_id, v_challenge.type;
  END IF;

  IF v_score_a > v_score_b THEN
    v_winner := v_a.user_id;
  ELSIF v_score_b > v_score_a THEN
    v_winner := v_b.user_id;
  ELSE
    v_winner := NULL; -- tie, see TIE RULE above
  END IF;

  IF v_winner IS NULL THEN
    v_blocked := (v_a.anomaly_flag AND NOT v_a.reviewed)
              OR (v_b.anomaly_flag AND NOT v_b.reviewed);
  ELSIF v_winner = v_a.user_id THEN
    v_blocked := v_a.anomaly_flag AND NOT v_a.reviewed;
  ELSE
    v_blocked := v_b.anomaly_flag AND NOT v_b.reviewed;
  END IF;

  IF v_blocked THEN
    -- No ledger entry, no balance change, settled_at stays NULL so a later
    -- call (after reviewed = true) can still settle this match properly.
    UPDATE "challenges" SET status = 'needs_review' WHERE id = v_challenge.id;
    RETURN 'needs_review';
  END IF;

  v_stake := v_challenge.stake_points;

  IF v_winner IS NULL THEN
    UPDATE "fitness_profiles" SET points_balance = points_balance + v_stake
      WHERE user_id IN (v_a.user_id, v_b.user_id);

    INSERT INTO "points_ledger_entries" ("id", "user_id", "amount", "reason", "match_id") VALUES
      (gen_random_uuid(), v_a.user_id, v_stake, 'payout', p_match_id),
      (gen_random_uuid(), v_b.user_id, v_stake, 'payout', p_match_id);
  ELSE
    UPDATE "fitness_profiles" SET points_balance = points_balance + (v_stake * 2)
      WHERE user_id = v_winner;

    INSERT INTO "points_ledger_entries" ("id", "user_id", "amount", "reason", "match_id")
      VALUES (gen_random_uuid(), v_winner, v_stake * 2, 'payout', p_match_id);
  END IF;

  UPDATE "matches" SET winner_id = v_winner, settled_at = now() WHERE id = p_match_id;
  UPDATE "challenges" SET status = 'completed' WHERE id = v_challenge.id;

  RETURN CASE WHEN v_winner IS NULL THEN 'tie_refunded' ELSE 'settled' END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.settle_match(uuid) TO authenticated;

-- ============================================================================
-- submit_verification_session(): now type-aware (pushups | plank | wallsit).
--
-- The old 4-arg signature is DROPPED, not left alongside. Adding a 5th
-- parameter would create an overload, and PostgREST rejects RPC calls that
-- resolve ambiguously — the app would start failing on a call it never
-- changed. p_hold_duration_seconds defaults to NULL so the argument list stays
-- source-compatible for push-ups.
--
-- Everything the original said about trust still holds verbatim: this verifies
-- WHO submits, never WHAT they submit. Hold duration is accumulated on-device
-- in JS exactly like rep count was, so it is equally self-reported.
-- raw_metrics is a review trail, not proof.
-- ============================================================================

DROP FUNCTION IF EXISTS public.submit_verification_session(uuid, integer, jsonb, boolean);

CREATE OR REPLACE FUNCTION public.submit_verification_session(
  p_match_participant_id uuid,
  p_rep_count integer,
  p_raw_metrics jsonb,
  p_anomaly_flag boolean,
  p_hold_duration_seconds integer DEFAULT NULL
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

  SELECT c.type INTO v_challenge_type
    FROM "matches" m
    JOIN "challenges" c ON c.id = m.challenge_id
    WHERE m.id = v_participant.match_id;

  -- Each type accepts exactly one score and rejects the other outright. A rep
  -- count on a plank (or vice versa) means the client ran the wrong pose
  -- model, which must not be recorded as a valid result.
  IF v_challenge_type = 'pushups' THEN
    IF p_rep_count IS NULL OR p_rep_count < 0 THEN
      RAISE EXCEPTION 'rep count must be zero or greater for a pushups challenge';
    END IF;
    IF p_hold_duration_seconds IS NOT NULL THEN
      RAISE EXCEPTION 'hold duration is not a valid result for a pushups challenge';
    END IF;
  ELSIF v_challenge_type IN ('plank', 'wallsit') THEN
    IF p_hold_duration_seconds IS NULL OR p_hold_duration_seconds < 0 THEN
      RAISE EXCEPTION 'hold duration must be zero or greater for a % challenge', v_challenge_type;
    END IF;
    IF p_rep_count IS NOT NULL THEN
      RAISE EXCEPTION 'rep count is not a valid result for a % challenge', v_challenge_type;
    END IF;
  ELSE
    RAISE EXCEPTION 'camera verification is not implemented for % yet', v_challenge_type;
  END IF;

  INSERT INTO "verification_sessions"
    ("id", "match_participant_id", "raw_metrics", "anomaly_flag", "reviewed")
    VALUES (gen_random_uuid(), p_match_participant_id, p_raw_metrics,
            COALESCE(p_anomaly_flag, false), false)
    RETURNING id INTO v_session_id;

  UPDATE "match_participants"
    SET rep_count = p_rep_count,
        hold_duration_seconds = p_hold_duration_seconds
    WHERE id = p_match_participant_id;

  -- Settle inline, in this same transaction, the moment the second result
  -- lands. Deliberately not left to the client: a client that submits and then
  -- dies (or a modified build that simply never calls settle_match) would
  -- otherwise strand the match unsettled forever. Returns 'not_ready'
  -- harmlessly for the first submitter.
  --
  -- Letting a settlement failure roll this INSERT back is intentional. Every
  -- RAISE inside settle_match is a real inconsistency, and recording a result
  -- that provably cannot be settled is worse than rejecting the submission.
  PERFORM public.settle_match(v_participant.match_id);

  RETURN v_session_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_verification_session(uuid, integer, jsonb, boolean, integer) TO authenticated;
