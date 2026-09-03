import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  PermissionsAndroid,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  QuickPoseView,
  QuickPoseThresholdCounter,
  type QuickPoseUpdateEvent,
} from '@quickpose/react-native';
import { QUICKPOSE_SDK_KEY } from '@env';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import type { ChallengeType, MatchParticipantRow } from '../types/database';

type Props = NativeStackScreenProps<RootStackParamList, 'MatchInProgress'>;

/**
 * QuickPose feature strings (validated against the SDK's parseFeature.ts).
 * - fitness.pushUps    -> results[...] is a 0..1 pose probability, NOT a rep
 *                         count. Reps are derived client-side by feeding that
 *                         probability to QuickPoseThresholdCounter.
 * - overlay.wholeBody  -> draws the skeleton so the user can see tracking.
 * - inside.wholeBody   -> whether the whole body is within frame. Used as a
 *                         capture-quality signal below.
 */
const PUSHUP_FEATURE = 'fitness.pushUps';
const OVERLAY_FEATURE = 'overlay.wholeBody';
const INSIDE_FEATURE = 'inside.wholeBody';
const FEATURES = [PUSHUP_FEATURE, OVERLAY_FEATURE, INSIDE_FEATURE];

/**
 * Thresholds for what counts as a suspicious session. These are OUR
 * heuristics over QuickPose's raw signals — the SDK exposes no anti-cheat or
 * partial-rep API of its own. A rep only counts at all if the pose
 * probability crosses 0.6 and then falls back under 0.3 (the counter's
 * hysteresis), which is what implicitly rejects half-reps.
 */
const MIN_PLAUSIBLE_REP_MS = 500; // faster than this isn't a real push-up
const MAX_OUT_OF_FRAME_RATIO = 0.2; // >20% of frames with body out of frame
const MIN_MEAN_FPS = 15; // below this, tracking is too poor to trust
const INSIDE_FRAME_THRESHOLD = 0.5; // inside.* below this = out of frame

export function MatchInProgressScreen({ route, navigation }: Props) {
  const { matchId } = route.params;
  const { session } = useAuth();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [challengeType, setChallengeType] = useState<ChallengeType | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [hasCameraPermission, setHasCameraPermission] = useState(false);

  const [repCount, setRepCount] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Accumulated per-frame telemetry. Kept in refs, not state: onUpdate fires
  // at camera frame rate and re-rendering on every frame would tank the UI.
  const counterRef = useRef(new QuickPoseThresholdCounter());
  const startedAtRef = useRef<number | null>(null);
  const repTimestampsRef = useRef<number[]>([]);
  const fpsSamplesRef = useRef<number[]>([]);
  const frameCountRef = useRef(0);
  const outOfFrameCountRef = useRef(0);
  const feedbackCountsRef = useRef<Record<string, number>>({});

  const sdkKeyMissing =
    !QUICKPOSE_SDK_KEY || QUICKPOSE_SDK_KEY === 'YOUR_QUICKPOSE_SDK_KEY';

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Android needs an explicit runtime request. iOS has no core RN API for
      // this — the native camera view triggers the system prompt itself on
      // mount, backed by NSCameraUsageDescription in Info.plist.
      if (Platform.OS === 'android') {
        const status = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.CAMERA,
          {
            title: 'Camera access',
            message: 'Fittr needs the camera to count and verify your reps.',
            buttonPositive: 'Allow',
          },
        );
        if (cancelled) {
          return;
        }
        setHasCameraPermission(status === PermissionsAndroid.RESULTS.GRANTED);
      } else {
        setHasCameraPermission(true);
      }

      const { data: matchData, error: matchError } = await supabase
        .from('matches')
        .select('id, challenge_id')
        .eq('id', matchId)
        .single();

      if (cancelled) {
        return;
      }
      if (matchError) {
        setError(matchError.message);
        setLoading(false);
        return;
      }

      const [{ data: challengeData }, { data: participants }] =
        await Promise.all([
          supabase
            .from('challenges')
            .select('id, type')
            .eq('id', matchData.challenge_id)
            .single(),
          supabase
            .from('match_participants')
            .select('*')
            .eq('match_id', matchId),
        ]);

      if (cancelled) {
        return;
      }

      setChallengeId(challengeData?.id ?? null);
      setChallengeType((challengeData?.type as ChallengeType) ?? null);

      const mine = ((participants ?? []) as MatchParticipantRow[]).find(
        p => p.user_id === session?.user.id,
      );
      if (!mine) {
        setError("You aren't a participant in this match.");
      } else {
        setParticipantId(mine.id);
        if (mine.rep_count !== null) {
          // Results are single-submission; don't let them record twice.
          setRepCount(mine.rep_count);
          setSubmitted(true);
        }
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [matchId, session]);

  const handleUpdate = useCallback((event: QuickPoseUpdateEvent) => {
    const { results, feedbacks, fps } = event.nativeEvent;

    frameCountRef.current += 1;
    if (typeof fps === 'number' && fps > 0) {
      fpsSamplesRef.current.push(fps);
    }

    const inside = results[INSIDE_FEATURE];
    if (typeof inside === 'number' && inside < INSIDE_FRAME_THRESHOLD) {
      outOfFrameCountRef.current += 1;
    }

    // Form guidance from the SDK. Surfaced live and tallied into raw_metrics
    // rather than dropped — it's the only qualitative signal QuickPose gives.
    const message = feedbacks[PUSHUP_FEATURE];
    if (message) {
      feedbackCountsRef.current[message] =
        (feedbackCountsRef.current[message] ?? 0) + 1;
      setFeedback(prev => (prev === message ? prev : message));
    } else {
      setFeedback(prev => (prev === null ? prev : null));
    }

    const probability = results[PUSHUP_FEATURE];
    if (typeof probability !== 'number') {
      return;
    }

    counterRef.current.count(probability, state => {
      if (state.type === 'poseComplete') {
        const elapsed = Date.now() - (startedAtRef.current ?? Date.now());
        repTimestampsRef.current.push(elapsed);
        setRepCount(state.count);
      }
    });
  }, []);

  const startSet = () => {
    counterRef.current.reset();
    startedAtRef.current = Date.now();
    repTimestampsRef.current = [];
    fpsSamplesRef.current = [];
    feedbackCountsRef.current = {};
    frameCountRef.current = 0;
    outOfFrameCountRef.current = 0;
    setRepCount(0);
    setFeedback(null);
    setRunning(true);
  };

  const finishSet = async () => {
    if (!participantId) {
      return;
    }
    setRunning(false);
    setSubmitting(true);
    setError(null);

    const durationMs = Date.now() - (startedAtRef.current ?? Date.now());
    const reps = repTimestampsRef.current;
    const fpsSamples = fpsSamplesRef.current;
    const meanFps = fpsSamples.length
      ? fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length
      : 0;
    const outOfFrameRatio = frameCountRef.current
      ? outOfFrameCountRef.current / frameCountRef.current
      : 0;

    const repIntervals = reps.map((t, i) => (i === 0 ? t : t - reps[i - 1]!));
    const fastestRepMs = repIntervals.length ? Math.min(...repIntervals) : null;

    const impossiblyFastRep =
      fastestRepMs !== null && fastestRepMs < MIN_PLAUSIBLE_REP_MS;
    const leftFrameTooOften = outOfFrameRatio > MAX_OUT_OF_FRAME_RATIO;
    const trackingTooPoor = meanFps > 0 && meanFps < MIN_MEAN_FPS;
    const anomalyFlag =
      impossiblyFastRep || leftFrameTooOften || trackingTooPoor;

    // Everything needed to re-review this session by hand later. QuickPose
    // gives no raw landmark stream through the RN bridge, so this is the
    // per-frame signal that is actually available.
    const rawMetrics = {
      schemaVersion: 1,
      source: {
        sdk: '@quickpose/react-native',
        feature: PUSHUP_FEATURE,
        repCounting: 'QuickPoseThresholdCounter',
        enterThreshold: counterRef.current.enterThreshold,
        exitThreshold: counterRef.current.exitThreshold,
      },
      session: {
        durationMs,
        repCount: reps.length,
        repElapsedMs: reps,
        repIntervalsMs: repIntervals,
        fastestRepMs,
      },
      capture: {
        frames: frameCountRef.current,
        meanFps: Number(meanFps.toFixed(2)),
        minFps: fpsSamples.length ? Math.min(...fpsSamples) : null,
        outOfFrameFrames: outOfFrameCountRef.current,
        outOfFrameRatio: Number(outOfFrameRatio.toFixed(4)),
      },
      feedbacks: feedbackCountsRef.current,
      // Which heuristic(s) tripped the flag — these are ours, not the SDK's.
      anomalyReasons: {
        impossiblyFastRep,
        leftFrameTooOften,
        trackingTooPoor,
      },
    };

    const { error: rpcError } = await supabase.rpc(
      'submit_verification_session',
      {
        p_match_participant_id: participantId,
        p_rep_count: repCount,
        p_raw_metrics: rawMetrics,
        p_anomaly_flag: anomalyFlag,
      },
    );

    setSubmitting(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setSubmitted(true);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (submitted) {
    return (
      <View style={styles.center}>
        <Text style={styles.doneTitle}>Set recorded</Text>
        <Text style={styles.doneReps}>{repCount} reps</Text>
        <Text style={styles.doneNote}>
          Waiting on the other participant. Scoring and points are settled once
          both results are in.
        </Text>
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() =>
            challengeId
              ? navigation.replace('ChallengeDetail', { challengeId })
              : navigation.replace('Home')
          }
        >
          <Text style={styles.primaryButtonText}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (challengeType && challengeType !== 'pushups') {
    return (
      <View style={styles.center}>
        <Text style={styles.blockedTitle}>Not supported yet</Text>
        <Text style={styles.blockedText}>
          Camera verification currently handles push-ups only. {challengeType}{' '}
          verification is a later pass.
        </Text>
      </View>
    );
  }

  if (sdkKeyMissing) {
    return (
      <View style={styles.center}>
        <Text style={styles.blockedTitle}>QuickPose key missing</Text>
        <Text style={styles.blockedText}>
          Set QUICKPOSE_SDK_KEY in .env (register free at dev.quickpose.ai),
          then restart Metro with --reset-cache.
        </Text>
      </View>
    );
  }

  if (!hasCameraPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.blockedTitle}>Camera access needed</Text>
        <Text style={styles.blockedText}>
          Fittr needs the camera to verify your reps. Enable camera access in
          Settings, then reopen this screen.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <QuickPoseView
        sdkKey={QUICKPOSE_SDK_KEY}
        features={FEATURES}
        useFrontCamera
        style={styles.camera}
        onUpdate={running ? handleUpdate : undefined}
      />

      <View style={styles.hud} pointerEvents="none">
        <Text style={styles.repCount}>{repCount}</Text>
        <Text style={styles.repLabel}>reps</Text>
        {feedback ? <Text style={styles.feedback}>{feedback}</Text> : null}
      </View>

      <View style={styles.controls}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {running ? (
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={finishSet}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryButtonText}>Finish</Text>
            )}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.primaryButton} onPress={startSet}>
            <Text style={styles.primaryButtonText}>Start set</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#fff',
  },
  camera: { flex: 1 },
  hud: {
    position: 'absolute',
    top: 24,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  repCount: { fontSize: 72, fontWeight: '800', color: '#fff' },
  repLabel: { fontSize: 16, color: '#E5E7EB', marginTop: -8 },
  feedback: {
    marginTop: 12,
    color: '#FDE68A',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  controls: { padding: 20, backgroundColor: '#000' },
  primaryButton: {
    backgroundColor: '#E11D48',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 16,
    paddingHorizontal: 32,
  },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  error: { color: '#F87171', marginBottom: 8 },
  doneTitle: { fontSize: 26, fontWeight: '800' },
  doneReps: { fontSize: 48, fontWeight: '800', marginTop: 8 },
  doneNote: {
    color: '#6B7280',
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 16,
  },
  blockedTitle: { fontSize: 22, fontWeight: '800', marginBottom: 8 },
  blockedText: { color: '#6B7280', textAlign: 'center' },
});
