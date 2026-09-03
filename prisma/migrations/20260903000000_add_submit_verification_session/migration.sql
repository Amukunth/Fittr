-- submit_verification_session(): the write path for camera-verified results.
--
-- `verification_sessions` and `match_participants` both have RLS enabled with
-- no INSERT/UPDATE policy for clients, so neither is writable with the anon
-- key. That's deliberate (see the first migration): anything that decides a
-- match outcome goes through a SECURITY DEFINER function, never a direct
-- client write. This adds the function for verification results, matching
-- join_challenge()/grant_starter_bonus().
--
-- IMPORTANT — what this function can and cannot guarantee:
--   It verifies WHO is submitting (the caller must own the match_participant
--   row). It cannot verify WHAT they submit. Rep counting runs on the user's
--   own device in JS (QuickPoseThresholdCounter over the SDK's pose
--   probability), so a modified client can submit any rep count it likes.
--   p_anomaly_flag is likewise self-reported by the client.
--   This is fine for a points-only v1, but it is NOT sufficient for anything
--   with money attached. Trustworthy verification needs the raw capture
--   re-scored somewhere the user doesn't control (server-side re-analysis of
--   uploaded video, or at minimum device attestation). Treat raw_metrics as a
--   review trail, not as proof.

CREATE OR REPLACE FUNCTION public.submit_verification_session(
  p_match_participant_id uuid,
  p_rep_count integer,
  p_raw_metrics jsonb,
  p_anomaly_flag boolean
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

  IF p_rep_count IS NULL OR p_rep_count < 0 THEN
    RAISE EXCEPTION 'rep count must be zero or greater';
  END IF;

  -- Results are single-submission on purpose. Allowing a re-submit would let
  -- someone retry until they liked their own score.
  IF EXISTS (
    SELECT 1 FROM "verification_sessions"
    WHERE match_participant_id = p_match_participant_id
  ) THEN
    RAISE EXCEPTION 'a verification session has already been submitted for this participant';
  END IF;

  -- This pass implements push-ups only; refuse anything else rather than
  -- recording a rep count produced by the wrong pose model.
  SELECT c.type INTO v_challenge_type
    FROM "matches" m
    JOIN "challenges" c ON c.id = m.challenge_id
    WHERE m.id = v_participant.match_id;

  IF v_challenge_type <> 'pushups' THEN
    RAISE EXCEPTION 'camera verification is not implemented for % yet', v_challenge_type;
  END IF;

  INSERT INTO "verification_sessions"
    ("id", "match_participant_id", "raw_metrics", "anomaly_flag", "reviewed")
    VALUES (gen_random_uuid(), p_match_participant_id, p_raw_metrics, COALESCE(p_anomaly_flag, false), false)
    RETURNING id INTO v_session_id;

  -- match_participants.rep_count is the canonical verified result the future
  -- settlement function will compare. Writing it here is result *recording*,
  -- not settlement: no winner is chosen, no points move, and neither the
  -- match nor the challenge changes status.
  UPDATE "match_participants" SET rep_count = p_rep_count
    WHERE id = p_match_participant_id;

  RETURN v_session_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_verification_session(uuid, integer, jsonb, boolean) TO authenticated;
