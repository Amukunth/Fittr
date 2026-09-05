import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Platform,
  PermissionsAndroid,
  StyleSheet,
  Text,
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
import { QuickPoseHoldTracker } from '../lib/holdTracker';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import type { ChallengeType, MatchParticipantRow } from '../types/database';
import { colors, space, typography } from '../theme/tokens';
import { EXERCISE_LABEL } from '../theme/copy';
import {
  Center,
  ErrorText,
  Headline,
  Kicker,
  Label,
  Loading,
  Muted,
  PrimaryButton,
} from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'MatchInProgress'>;

/**
 * QuickPose feature strings, validated against the SDK's parseFeature.ts
 * (its stated "single source of truth" — an unrecognised string parses to
 * null and the feature is silently dropped, with no error and no result key).
 * - overlay.wholeBody -> draws the skeleton so the user can see tracking.
 * - inside.wholeBody  -> whether the whole body is within frame. Used as a
 *                        capture-quality signal below.
 *
 * ⚠️ Do not trust the shipped README's onUpdate example
 * (node_modules/@quickpose/react-native/README.md) — it documents
 * `{ results, feedback }` with `results` as an ARRAY of `{feature, value}`
 * and `feedback` as a single string. That does not match this installed
 * version. Read src/index.tsx's handleUpdate directly: it parses
 * resultsJson/feedbacksJson (the actual native wire format — confirmed in
 * both ios/QuickPoseView.swift and the Android bridge) into `results` and
 * `feedbacks` — both plural, both keyed objects (Record<featureKey, value>),
 * plus `fps`. That's the QuickPoseUpdateEvent shape used below; the README
 * examples for this version are stale.
 */
const OVERLAY_FEATURE = 'overlay.wholeBody';
const INSIDE_FEATURE = 'inside.wholeBody';

type ScoredType = Extract<ChallengeType, 'pushups' | 'plank' | 'wallsit'>;

interface ExerciseConfig {
  /** The fitness.* feature whose 0..1 probability drives scoring. */
  readonly feature: string;
  /** reps = count enter/exit crossings; hold = accumulate time above threshold. */
  readonly mode: 'reps' | 'hold';
  readonly unitLabel: string;
  readonly instruction: string;
}

/**
 * One config per scorable challenge type, so all three run through the same
 * screen, the same capture pipeline and the same submit path — the only things
 * that vary are the feature string and whether the signal is counted or timed.
 *
 * ⚠️ wallsit uses `fitness.squats`, NOT a wall-sit feature. QuickPose 0.7.1 has
 * no wall-sit in any spelling: FITNESS_EXERCISES in parseFeature.ts lists 28
 * exercises and none of them is one, so `fitness.wallSit` would parse to null
 * and score nothing at all. A wall sit is a held bottom-of-squat, so the squat
 * pose probability is the closest available proxy. THIS IS UNVERIFIED ON A
 * REAL DEVICE — the squat model may not score a static, wall-braced hold
 * highly enough to cross HOLD_ENTER_THRESHOLD. If it doesn't, swap the feature
 * string here (fitness.sumoSquats is the next candidate) or fall back to
 * blocking wallsit the way race is blocked. Nothing else needs to change.
 *
 * rangeOfMotion.knee / rangeOfMotion.hip were investigated as an alternative
 * and rejected — see "Exercise types and the wall-sit proxy" in BACKEND.md
 * for the full writeup. Short version: docs.quickpose.ai/.../Range Of
 * Motion/Knee confirms (via its own `%.0f°` format-string example) that a ROM
 * result is a live angle IN DEGREES, not the 0..1 probability every other
 * signal in this file uses — so it can't plug into QuickPoseHoldTracker's
 * enter/exit hysteresis without a different (range-containment) comparison.
 * Worse: no QuickPose doc anywhere states a target angle for a wall-sit knee/
 * hip bend, so a threshold would be pure invention with zero vendor backing —
 * strictly less grounded than fitness.squats, which is at least a real
 * trained classifier. The fix candidates above remain the better next move.
 */
const EXERCISES: Record<ScoredType, ExerciseConfig> = {
  pushups: {
    feature: 'fitness.pushUps',
    mode: 'reps',
    unitLabel: 'reps',
    instruction: 'Full push-ups, whole body in frame.',
  },
  plank: {
    feature: 'fitness.plank',
    mode: 'hold',
    unitLabel: 'held',
    instruction: 'Hold the plank. The timer pauses if you break form.',
  },
  wallsit: {
    feature: 'fitness.squats',
    mode: 'hold',
    unitLabel: 'held',
    instruction: 'Hold the wall sit. The timer pauses if you stand up.',
  },
};

function configFor(type: ChallengeType | null): ExerciseConfig | null {
  if (type === 'pushups' || type === 'plank' || type === 'wallsit') {
    return EXERCISES[type];
  }
  return null;
}

/**
 * Thresholds for what counts as a suspicious session. These are OUR heuristics
 * over QuickPose's raw signals — the SDK exposes no anti-cheat or partial-rep
 * API of its own.
 *
 * Reps: a rep only counts if the probability crosses 0.6 then falls back under
 * 0.3 (QuickPoseThresholdCounter's hysteresis), which is what implicitly
 * rejects half-reps.
 *
 * Holds: the same hysteresis, applied to time instead of crossings (see
 * src/lib/holdTracker.ts). The cheat it guards against is different — a
 * propped-up phone pointed at a photo or a mannequin holds "perfect form"
 * indefinitely — so the flag is an implausibly long unbroken hold rather than
 * an implausibly fast rep.
 */
const MIN_PLAUSIBLE_REP_MS = 500; // faster than this isn't a real push-up
const MAX_OUT_OF_FRAME_RATIO = 0.2; // >20% of frames with body out of frame
const MIN_MEAN_FPS = 15; // below this, tracking is too poor to trust
const INSIDE_FRAME_THRESHOLD = 0.5; // inside.* below this = out of frame
const MAX_PLAUSIBLE_HOLD_SECONDS = 600; // 10 min straight is a static image
const MIN_PLAUSIBLE_SEGMENT_MS = 750; // shorter than this is threshold jitter
const MAX_JITTER_SEGMENT_RATIO = 0.5; // >half the segments being jitter

function formatSeconds(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function MatchInProgressScreen({ route, navigation }: Props) {
  const { matchId } = route.params;
  const { session } = useAuth();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [challengeType, setChallengeType] = useState<ChallengeType | null>(null);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [hasCameraPermission, setHasCameraPermission] = useState(false);

  const [repCount, setRepCount] = useState(0);
  // Whole seconds only: the hold total is recomputed every camera frame, but
  // pushing it into state at frame rate would re-render the HUD ~30x/sec. A
  // same-value setState bails out, so this re-renders at most once a second.
  const [heldSeconds, setHeldSeconds] = useState(0);
  const [isHolding, setIsHolding] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Accumulated per-frame telemetry. Kept in refs, not state: onUpdate fires at
  // camera frame rate and re-rendering on every frame would tank the UI.
  const counterRef = useRef(new QuickPoseThresholdCounter());
  const holdRef = useRef(new QuickPoseHoldTracker());
  const startedAtRef = useRef<number | null>(null);
  const repTimestampsRef = useRef<number[]>([]);
  const fpsSamplesRef = useRef<number[]>([]);
  const frameCountRef = useRef(0);
  const outOfFrameCountRef = useRef(0);
  const feedbackCountsRef = useRef<Record<string, number>>({});

  const config = configFor(challengeType);
  const isHold = config?.mode === 'hold';

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

      setChallengeType((challengeData?.type as ChallengeType) ?? null);

      const mine = ((participants ?? []) as MatchParticipantRow[]).find(
        p => p.user_id === session?.user.id,
      );
      if (!mine) {
        setError("You aren't a participant in this match.");
      } else {
        setParticipantId(mine.id);
        // Results are single-submission; don't let them record twice. Either
        // column being populated means this participant is already done.
        if (mine.rep_count !== null) {
          setRepCount(mine.rep_count);
          setSubmitted(true);
        } else if (mine.hold_duration_seconds !== null) {
          setHeldSeconds(mine.hold_duration_seconds);
          setSubmitted(true);
        }
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [matchId, session]);

  const handleUpdate = useCallback(
    (event: QuickPoseUpdateEvent) => {
      if (!config) {
        return;
      }
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
      const message = feedbacks[config.feature];
      if (message) {
        feedbackCountsRef.current[message] =
          (feedbackCountsRef.current[message] ?? 0) + 1;
        setFeedback(prev => (prev === message ? prev : message));
      } else {
        setFeedback(prev => (prev === null ? prev : null));
      }

      const probability = results[config.feature];
      if (typeof probability !== 'number') {
        return;
      }

      if (config.mode === 'hold') {
        const snapshot = holdRef.current.update(probability, Date.now());
        const seconds = Math.floor(snapshot.totalHeldMs / 1000);
        setHeldSeconds(prev => (prev === seconds ? prev : seconds));
        setIsHolding(prev =>
          prev === snapshot.isHolding ? prev : snapshot.isHolding,
        );
        return;
      }

      counterRef.current.count(probability, state => {
        if (state.type === 'poseComplete') {
          const elapsed = Date.now() - (startedAtRef.current ?? Date.now());
          repTimestampsRef.current.push(elapsed);
          setRepCount(state.count);
        }
      });
    },
    [config],
  );

  const startSet = () => {
    counterRef.current.reset();
    holdRef.current.reset();
    startedAtRef.current = Date.now();
    repTimestampsRef.current = [];
    fpsSamplesRef.current = [];
    feedbackCountsRef.current = {};
    frameCountRef.current = 0;
    outOfFrameCountRef.current = 0;
    setRepCount(0);
    setHeldSeconds(0);
    setIsHolding(false);
    setFeedback(null);
    setRunning(true);
  };

  const finishSet = async () => {
    if (!participantId || !config) {
      return;
    }
    setRunning(false);
    setSubmitting(true);
    setError(null);

    const finishedAt = Date.now();
    const durationMs = finishedAt - (startedAtRef.current ?? finishedAt);
    const fpsSamples = fpsSamplesRef.current;
    const meanFps = fpsSamples.length
      ? fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length
      : 0;
    const outOfFrameRatio = frameCountRef.current
      ? outOfFrameCountRef.current / frameCountRef.current
      : 0;

    // Shared across both modes.
    const leftFrameTooOften = outOfFrameRatio > MAX_OUT_OF_FRAME_RATIO;
    const trackingTooPoor = meanFps > 0 && meanFps < MIN_MEAN_FPS;

    const capture = {
      frames: frameCountRef.current,
      meanFps: Number(meanFps.toFixed(2)),
      minFps: fpsSamples.length ? Math.min(...fpsSamples) : null,
      outOfFrameFrames: outOfFrameCountRef.current,
      outOfFrameRatio: Number(outOfFrameRatio.toFixed(4)),
    };

    let sessionMetrics: Record<string, unknown>;
    let anomalyReasons: Record<string, boolean>;
    let finalHoldSeconds = 0;
    let finalRepCount = 0;

    if (config.mode === 'hold') {
      // Bank the in-progress segment — without this a user who never breaks
      // form submits 0.
      const snapshot = holdRef.current.finish(finishedAt);
      finalHoldSeconds = Math.floor(snapshot.totalHeldMs / 1000);

      const segments = snapshot.segmentsMs;
      const jitterSegments = segments.filter(
        ms => ms < MIN_PLAUSIBLE_SEGMENT_MS,
      ).length;
      const fragmentedHold =
        segments.length >= 4 &&
        jitterSegments / segments.length > MAX_JITTER_SEGMENT_RATIO;
      const implausiblyLongHold =
        finalHoldSeconds > MAX_PLAUSIBLE_HOLD_SECONDS;

      sessionMetrics = {
        durationMs,
        holdSeconds: finalHoldSeconds,
        totalHeldMs: snapshot.totalHeldMs,
        segmentsMs: segments,
        segmentCount: segments.length,
        longestSegmentMs: segments.length ? Math.max(...segments) : 0,
        jitterSegments,
      };
      anomalyReasons = {
        implausiblyLongHold,
        fragmentedHold,
        leftFrameTooOften,
        trackingTooPoor,
      };
    } else {
      const reps = repTimestampsRef.current;
      const repIntervals = reps.map((t, i) => (i === 0 ? t : t - reps[i - 1]!));
      const fastestRepMs = repIntervals.length
        ? Math.min(...repIntervals)
        : null;
      const impossiblyFastRep =
        fastestRepMs !== null && fastestRepMs < MIN_PLAUSIBLE_REP_MS;

      finalRepCount = repCount;
      sessionMetrics = {
        durationMs,
        repCount: reps.length,
        repElapsedMs: reps,
        repIntervalsMs: repIntervals,
        fastestRepMs,
      };
      anomalyReasons = {
        impossiblyFastRep,
        leftFrameTooOften,
        trackingTooPoor,
      };
    }

    const anomalyFlag = Object.values(anomalyReasons).some(Boolean);

    // Everything needed to re-review this session by hand later. QuickPose
    // gives no raw landmark stream through the RN bridge, so this is the
    // per-frame signal that is actually available. Same envelope for both
    // modes so the review trail stays uniform.
    const rawMetrics = {
      schemaVersion: 1,
      source: {
        sdk: '@quickpose/react-native',
        feature: config.feature,
        mode: config.mode,
        scoring:
          config.mode === 'hold'
            ? 'QuickPoseHoldTracker'
            : 'QuickPoseThresholdCounter',
        enterThreshold: holdRef.current.enterThreshold,
        exitThreshold: holdRef.current.exitThreshold,
        // Records that wallsit is scored off the squat model, so a reviewer
        // reading raw_metrics later isn't misled about what was measured.
        featureIsProxy: challengeType === 'wallsit',
      },
      session: sessionMetrics,
      capture,
      feedbacks: feedbackCountsRef.current,
      // Which heuristic(s) tripped the flag — these are ours, not the SDK's.
      anomalyReasons,
    };

    // The DB enforces exactly one score per type and rejects the other as a
    // wrong-pose-model submission, so these must be null, not 0.
    const { error: rpcError } = await supabase.rpc(
      'submit_verification_session',
      {
        p_match_participant_id: participantId,
        p_rep_count: config.mode === 'hold' ? null : finalRepCount,
        p_raw_metrics: rawMetrics,
        p_anomaly_flag: anomalyFlag,
        p_hold_duration_seconds:
          config.mode === 'hold' ? finalHoldSeconds : null,
      },
    );

    setSubmitting(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    if (config.mode === 'hold') {
      setHeldSeconds(finalHoldSeconds);
    }
    setSubmitted(true);
  };

  if (loading) {
    return <Loading />;
  }

  if (submitted) {
    return (
      <Center>
        <Kicker>In the books</Kicker>
        <Text style={styles.doneValue}>
          {isHold ? formatSeconds(heldSeconds) : repCount}
        </Text>
        <Label>{isHold ? 'held' : 'reps'}</Label>
        <Muted style={styles.doneNote}>
          The decision lands the moment both results are in. Points move on
          their own.
        </Muted>
        {/* Results handles every state, including "still waiting on the
            other participant", so it is safe to offer immediately. */}
        <PrimaryButton
          style={styles.doneCta}
          label="See the decision"
          onPress={() => navigation.replace('Results', { matchId })}
        />
      </Center>
    );
  }

  if (challengeType && !config) {
    return (
      <Center>
        <Headline style={styles.blockedTitle}>Not on the card yet</Headline>
        <Muted style={styles.blockedText}>
          Camera verification covers push-ups, planks and wall sits.{' '}
          {EXERCISE_LABEL[challengeType]} is a later round.
        </Muted>
      </Center>
    );
  }

  if (sdkKeyMissing) {
    return (
      <Center>
        <Headline style={styles.blockedTitle}>QuickPose key missing</Headline>
        <Muted style={styles.blockedText}>
          Set QUICKPOSE_SDK_KEY in .env (register free at dev.quickpose.ai),
          then restart Metro with --reset-cache.
        </Muted>
      </Center>
    );
  }

  if (!hasCameraPermission) {
    return (
      <Center>
        <Headline style={styles.blockedTitle}>Camera access needed</Headline>
        <Muted style={styles.blockedText}>
          The camera is the referee — it counts every rep so nobody has to take
          your word for it. Allow camera access in Settings, then reopen this
          screen.
        </Muted>
      </Center>
    );
  }

  return (
    <View style={styles.container}>
      <QuickPoseView
        sdkKey={QUICKPOSE_SDK_KEY}
        features={
          config
            ? [config.feature, OVERLAY_FEATURE, INSIDE_FEATURE]
            : [OVERLAY_FEATURE, INSIDE_FEATURE]
        }
        useFrontCamera
        style={styles.camera}
        onUpdate={running ? handleUpdate : undefined}
      />

      <View style={styles.hud} pointerEvents="none">
        <Text style={styles.hudValue}>
          {isHold ? formatSeconds(heldSeconds) : repCount}
        </Text>
        <Text style={styles.hudUnit}>{config?.unitLabel ?? ''}</Text>
        {isHold && running ? (
          <Text style={isHolding ? styles.holding : styles.notHolding}>
            {isHolding ? 'Holding' : 'Hold broken — get back in position'}
          </Text>
        ) : null}
        {feedback ? <Text style={styles.feedback}>{feedback}</Text> : null}
      </View>

      <View style={styles.controls}>
        {error ? <ErrorText style={styles.error}>{error}</ErrorText> : null}
        {running ? (
          <PrimaryButton
            label="Finish the round"
            onPress={finishSet}
            loading={submitting}
          />
        ) : (
          <>
            {config ? (
              <Text style={styles.instruction}>{config.instruction}</Text>
            ) : null}
            <PrimaryButton label="Start the round" onPress={startSet} />
          </>
        )}
      </View>
    </View>
  );
}

/**
 * HUD type sits over live video, so it carries a hard 2px print offset in
 * the ground color for legibility — a second ink layer, not a blur.
 */
const hudShadow = {
  textShadowColor: colors.bg,
  textShadowOffset: { width: 2, height: 2 },
  textShadowRadius: 0,
} as const;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  camera: { flex: 1 },
  hud: {
    position: 'absolute',
    top: space.lg,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  hudValue: {
    ...typography.numeral,
    ...hudShadow,
    fontSize: 88,
    lineHeight: 88,
    color: colors.accent,
  },
  hudUnit: { ...typography.label, ...hudShadow, color: colors.text },
  holding: {
    ...typography.label,
    ...hudShadow,
    marginTop: space.sm,
    color: colors.accent,
  },
  notHolding: {
    ...typography.label,
    ...hudShadow,
    marginTop: space.sm,
    color: colors.text,
    textAlign: 'center',
    paddingHorizontal: space.lg,
  },
  feedback: {
    ...typography.body,
    ...hudShadow,
    fontWeight: '700',
    marginTop: space.sm + 4,
    color: colors.text,
    textAlign: 'center',
    paddingHorizontal: space.lg,
  },
  instruction: {
    ...typography.bodySm,
    textAlign: 'center',
    marginBottom: space.md,
  },
  controls: {
    padding: space.lg - space.xs,
    backgroundColor: colors.bgDeep,
  },
  error: { marginBottom: space.sm },
  doneValue: {
    ...typography.numeral,
    fontSize: 72,
    lineHeight: 72,
    color: colors.accent,
    marginTop: space.sm,
  },
  doneNote: { textAlign: 'center', marginTop: space.md },
  doneCta: { marginTop: space.lg, alignSelf: 'stretch' },
  blockedTitle: { textAlign: 'center', marginBottom: space.sm },
  blockedText: { textAlign: 'center' },
});
