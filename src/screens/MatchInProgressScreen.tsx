import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  PermissionsAndroid,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  QuickPoseView,
  QuickPoseThresholdCounter,
  type QuickPoseUpdateEvent,
} from '@quickpose/react-native';
import { QUICKPOSE_SDK_KEY } from '@env';
import { supabase } from '../lib/supabase';
import { QuickPoseHoldTracker } from '../lib/holdTracker';
import { formatScore, scoreFor } from '../lib/boutStats';
import { formatSeconds } from '../lib/format';
import { initialsOf, peerHandle } from '../lib/identity';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import type { ChallengeType, MatchParticipantRow } from '../types/database';
import { EXERCISE_LABEL, EXERCISE_SCORE } from '../theme/copy';
import { Icon, type IconName } from '../theme/icons';
import { colors, label, radius, space } from '../theme/tokens';
import {
  Avatar,
  Body,
  Button,
  Display,
  Dock,
  Label,
  LiveDot,
  Loading,
  Notice,
  Numeral,
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
 * and rejected — see "Exercise types and the wall-sit proxy" in BACKEND.md.
 */
const EXERCISES: Record<ScoredType, ExerciseConfig> = {
  pushups: {
    feature: 'fitness.pushUps',
    mode: 'reps',
    instruction: 'Full push-ups, whole body in frame. Prop the phone 2–3 m away.',
  },
  plank: {
    feature: 'fitness.plank',
    mode: 'hold',
    instruction: 'Hold the plank. The clock pauses if you break form.',
  },
  wallsit: {
    feature: 'fitness.squats',
    mode: 'hold',
    instruction: 'Hold the wall sit. The clock pauses if you stand up.',
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
/** How long the body can be out of frame before the "can't see you" overlay. */
const LOST_TRACKING_MS = 1500;

export function MatchInProgressScreen({ route, navigation }: Props) {
  const { matchId } = route.params;
  const { session } = useAuth();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [challengeType, setChallengeType] = useState<ChallengeType | null>(null);
  const [participants, setParticipants] = useState<MatchParticipantRow[]>([]);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [hasCameraPermission, setHasCameraPermission] = useState(false);

  const [repCount, setRepCount] = useState(0);
  // Whole seconds only: the hold total is recomputed every camera frame, but
  // pushing it into state at frame rate would re-render the HUD ~30x/sec. A
  // same-value setState bails out, so this re-renders at most once a second.
  const [heldSeconds, setHeldSeconds] = useState(0);
  const [isHolding, setIsHolding] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [outOfFrame, setOutOfFrame] = useState(false);
  const [elapsed, setElapsed] = useState(0);
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
  const lastInFrameAtRef = useRef(Date.now());
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

      const [{ data: challengeData }, { data: participantData }] =
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
      const rows = (participantData ?? []) as MatchParticipantRow[];
      setParticipants(rows);

      const mine = rows.find(p => p.user_id === session?.user.id);
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

  // The clock in the top-left pill. Half-second ticks so a whole second never
  // visibly skips.
  useEffect(() => {
    if (!running) {
      return;
    }
    const id = setInterval(() => {
      const started = startedAtRef.current ?? Date.now();
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [running]);

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

      const now = Date.now();
      const inside = results[INSIDE_FEATURE];
      if (typeof inside === 'number' && inside < INSIDE_FRAME_THRESHOLD) {
        outOfFrameCountRef.current += 1;
        if (now - lastInFrameAtRef.current > LOST_TRACKING_MS) {
          setOutOfFrame(prev => (prev ? prev : true));
        }
      } else {
        lastInFrameAtRef.current = now;
        setOutOfFrame(prev => (prev ? false : prev));
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
        const snapshot = holdRef.current.update(probability, now);
        const seconds = Math.floor(snapshot.totalHeldMs / 1000);
        setHeldSeconds(prev => (prev === seconds ? prev : seconds));
        setIsHolding(prev =>
          prev === snapshot.isHolding ? prev : snapshot.isHolding,
        );
        return;
      }

      counterRef.current.count(probability, state => {
        if (state.type === 'poseComplete') {
          const elapsedMs = now - (startedAtRef.current ?? now);
          repTimestampsRef.current.push(elapsedMs);
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
    lastInFrameAtRef.current = Date.now();
    repTimestampsRef.current = [];
    fpsSamplesRef.current = [];
    feedbackCountsRef.current = {};
    frameCountRef.current = 0;
    outOfFrameCountRef.current = 0;
    setRepCount(0);
    setHeldSeconds(0);
    setIsHolding(false);
    setFeedback(null);
    setOutOfFrame(false);
    setElapsed(0);
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

  const exit = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('Home');
    }
  };

  const leave = () => {
    if (!running) {
      exit();
      return;
    }
    Alert.alert(
      'Leave the ring?',
      "Your set so far won't be recorded. You can come back and start again.",
      [
        { text: 'Stay', style: 'cancel' },
        { text: 'Leave', style: 'destructive', onPress: exit },
      ],
    );
  };

  if (loading) {
    return <Loading />;
  }

  const valueText = isHold ? formatSeconds(heldSeconds) : String(repCount);
  const unit = challengeType ? EXERCISE_SCORE[challengeType] : 'REPS';

  if (submitted) {
    return (
      <View style={styles.screen}>
        <View style={[styles.done, { paddingTop: insets.top + 66 }]}>
          <Label size={11}>IN THE BOOKS</Label>
          <Numeral size={120} color={colors.accent} style={styles.doneValue}>
            {valueText}
          </Numeral>
          <Label size={12} color={colors.secondary} tracking={0.24}>
            {unit}
          </Label>
          <Body muted style={styles.doneNote}>
            The decision lands the moment both results are in. Points move on
            their own.
          </Body>
        </View>
        {/* Results handles every state, including "still waiting on the
            other participant", so it is safe to offer immediately. */}
        <Dock>
          <Button
            label="SEE THE DECISION"
            onPress={() => navigation.replace('Results', { matchId })}
          />
        </Dock>
      </View>
    );
  }

  if (challengeType && !config) {
    return (
      <Blocked
        icon="clock"
        title={'NOT ON\nTHE CARD YET.'}
        body={`Camera verification covers push-ups, planks and wall sits. ${EXERCISE_LABEL[challengeType]} is a later round.`}
        onClose={exit}
      />
    );
  }

  if (error && !participantId) {
    return <Blocked icon="warning" title={'NO SEAT\nFOR YOU.'} body={error} onClose={exit} />;
  }

  if (sdkKeyMissing) {
    return (
      <Blocked
        icon="warning"
        title={'NO REF\nON DUTY.'}
        body="QUICKPOSE_SDK_KEY is missing from .env. Register free at dev.quickpose.ai, then restart Metro with --reset-cache."
        onClose={exit}
      />
    );
  }

  if (!hasCameraPermission) {
    return (
      <Blocked
        icon="camera"
        title={'THE CAMERA\nIS THE REF.'}
        body="It counts every rep so nobody has to take your word for it. Allow camera access in Settings, then come back."
        onClose={exit}
        action={
          <Button
            label="OPEN SETTINGS"
            variant="secondary"
            onPress={() => Linking.openSettings()}
          />
        }
      />
    );
  }

  const me = session?.user.id ?? null;
  const opponent = participants.find(p => p.user_id !== me) ?? null;
  const opponentScore =
    opponent && challengeType ? scoreFor(opponent, challengeType) : null;
  const opponentHandle = opponent ? peerHandle(opponent.user_id) : null;

  let formMessage: string;
  if (!running) {
    formMessage = 'GET IN FRAME';
  } else if (outOfFrame) {
    formMessage = 'TRACKING PAUSED';
  } else if (feedback) {
    formMessage = feedback.toUpperCase();
  } else if (isHold) {
    formMessage = isHolding ? 'HOLD IT.' : 'GET BACK IN POSITION';
  } else {
    formMessage = 'FULL RANGE. KEEP GOING.';
  }
  const formGood =
    running && !outOfFrame && !feedback && (!isHold || isHolding);

  const dockBottom = Math.max(insets.bottom, space.xl) + space.xxl;
  const topPad = { top: insets.top + space.md };
  const stripPad = { top: insets.top + space.md + 44 };
  const counterPad = { bottom: dockBottom + 56 + 40 };
  const bottomPad = { bottom: dockBottom };

  return (
    <View style={styles.screen}>
      <QuickPoseView
        sdkKey={QUICKPOSE_SDK_KEY}
        features={
          config
            ? [config.feature, OVERLAY_FEATURE, INSIDE_FEATURE]
            : [OVERLAY_FEATURE, INSIDE_FEATURE]
        }
        useFrontCamera
        style={StyleSheet.absoluteFill}
        onUpdate={running ? handleUpdate : undefined}
      />

      <View style={[styles.topRow, topPad]} pointerEvents="none">
        <View style={styles.pill}>
          {running ? (
            <LiveDot color={colors.recording} size={8} period={1000} />
          ) : (
            <View style={styles.idleDot} />
          )}
          <Text style={styles.pillText}>
            {running ? formatSeconds(elapsed) : 'READY'}
          </Text>
        </View>
        <View style={styles.pill}>
          <Icon name="seal-check" size={14} color={colors.accent} contrast={colors.card} />
          <Text style={[styles.pillText, styles.pillTextDim]}>VERIFIED LIVE</Text>
        </View>
      </View>

      {opponentHandle ? (
        <View style={[styles.strip, stripPad]} pointerEvents="none">
          <View style={styles.stripLeft}>
            <Avatar initials={initialsOf(opponentHandle)} size={28} />
            <Text style={styles.stripHandle}>{opponentHandle}</Text>
          </View>
          <View style={styles.stripRight}>
            <Numeral size={28}>
              {challengeType ? formatScore(opponentScore, challengeType) : '—'}
            </Numeral>
            <Label size={10} tracking={0.12}>
              {opponentScore === null ? 'NOT IN YET' : unit}
            </Label>
          </View>
        </View>
      ) : null}

      <View style={[styles.counter, counterPad]} pointerEvents="none">
        <Label size={12} color={colors.secondary} tracking={0.24}>
          {isHold ? 'HOLD' : 'REPS'}
        </Label>
        <Numeral size={isHold ? 120 : 200} style={styles.counterValue}>
          {valueText}
        </Numeral>
        <View style={[styles.form, formGood ? styles.formGood : styles.formPlain]}>
          <Text style={[styles.formText, formGood && styles.formTextGood]}>
            {formMessage}
          </Text>
        </View>
      </View>

      {running && outOfFrame ? (
        <View style={styles.lost} pointerEvents="none">
          <View style={styles.lostTile}>
            <Icon name="crosshair" size={30} color={colors.accent} />
          </View>
          <Display size={56} style={styles.lostHead}>
            CAN'T{'\n'}SEE YOU.
          </Display>
          <Body muted style={styles.lostBody}>
            Step back into frame. Counting is paused, the clock isn't. Reps out
            of frame don't count.
          </Body>
          <View style={styles.lostClock}>
            <Numeral size={40}>{formatSeconds(elapsed)}</Numeral>
            <Label tracking={0.14}>STILL RUNNING</Label>
          </View>
        </View>
      ) : null}

      <View style={[styles.bottom, bottomPad]}>
        {error ? (
          <Notice icon="warning" style={styles.error}>
            {error}
          </Notice>
        ) : null}
        {!running && config ? (
          <Text style={styles.instruction}>{config.instruction}</Text>
        ) : null}
        <View style={styles.bottomRow}>
          <Pressable
            onPress={leave}
            accessibilityRole="button"
            accessibilityLabel="Leave the ring"
            style={({ pressed }) => [styles.leave, pressed && styles.leavePressed]}
          >
            <Icon name="x" size={20} color={colors.secondary} />
          </Pressable>
          {running ? (
            <Button
              label={isHold ? 'DROP & FINISH' : 'FINISH'}
              variant="white"
              icon="flag"
              onPress={finishSet}
              loading={submitting}
              style={styles.mainButton}
            />
          ) : (
            <Button
              label="START THE ROUND"
              onPress={startSet}
              loading={submitting}
              style={styles.mainButton}
            />
          )}
        </View>
      </View>
    </View>
  );
}

/** Full-screen stop: no camera, no key, wrong exercise. */
function Blocked({
  icon,
  title,
  body,
  onClose,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  onClose: () => void;
  action?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.screen}>
      <View style={[styles.blocked, { paddingTop: insets.top + space.xxl }]}>
        <View style={styles.lostTile}>
          <Icon name={icon} size={30} color={colors.accent} />
        </View>
        <Display size={56} style={styles.lostHead}>
          {title}
        </Display>
        <Body muted style={styles.lostBody}>
          {body}
        </Body>
      </View>
      <Dock style={styles.blockedDock}>
        {action}
        <Button label="BACK TO BOUTS" variant="card" onPress={onClose} />
      </Dock>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },

  topRow: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    height: 34,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.glass,
  },
  idleDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.dim,
  },
  pillText: { ...label(11, colors.text, 0.12) },
  pillTextDim: { color: colors.secondary },

  strip: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.sm + 2,
    paddingHorizontal: 14,
    borderRadius: radius.control,
    backgroundColor: colors.glass,
  },
  stripLeft: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 2 },
  stripHandle: { ...label(12, colors.secondary, 0), textTransform: 'none' },
  stripRight: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },

  counter: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  counterValue: {
    textShadowColor: colors.accentGlow,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 40,
  },
  form: {
    marginTop: 6,
    height: 36,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  formGood: { backgroundColor: colors.accentTintStrong },
  formPlain: { backgroundColor: colors.whiteTint },
  formText: { ...label(13, colors.text, 0.08) },
  formTextGood: { color: colors.accent },

  lost: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.overlay,
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  lostTile: {
    width: 64,
    height: 64,
    borderRadius: 18,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lostHead: { marginTop: space.xxl },
  lostBody: { marginTop: 14 },
  lostClock: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
    marginTop: space.xxl,
  },

  bottom: {
    position: 'absolute',
    left: space.gutter,
    right: space.gutter,
  },
  bottomRow: { flexDirection: 'row', gap: space.sm + 2 },
  leave: {
    width: 56,
    height: 56,
    borderRadius: radius.button,
    backgroundColor: colors.glass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  leavePressed: { opacity: 0.7 },
  mainButton: { flex: 1 },
  instruction: {
    ...label(11, colors.secondary, 0.08),
    textAlign: 'center',
    marginBottom: space.md,
  },
  error: { marginBottom: space.sm + 2 },

  done: { flex: 1, paddingHorizontal: space.xxl },
  doneValue: { marginTop: space.md },
  doneNote: { marginTop: space.lg },

  blocked: { flex: 1, paddingHorizontal: 28 },
  blockedDock: { gap: space.sm + 2 },
});
