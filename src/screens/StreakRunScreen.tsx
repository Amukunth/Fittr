import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { useCountdown } from '../hooks/useCountdown';
import { fmtPoints } from '../lib/format';
import { ratingResultFor } from '../lib/skillRating';
import {
  STREAK_BUYBACK_WINDOW_MS,
  STREAK_STAGES,
  fmtCountdown,
  fmtMultiplier,
  fmtTarget,
  payoutFor,
  remainingMs,
  soloErrorCopy,
  stageTargetOf,
  streakBuyBackIn,
  streakNextStage,
  streakPreview,
  windowProgress,
} from '../lib/soloModes';
import type { RootStackParamList } from '../navigation/types';
import type {
  ChallengeType,
  SkillRatingEventRow,
  StreakPreviewRow,
  StreakRunRow,
  StreakStageAttemptRow,
} from '../types/database';
import { EXERCISE_LABEL, UNIT } from '../theme/copy';
import { Icon } from '../theme/icons';
import { anton, colors, label, radius, space, typography } from '../theme/tokens';
import {
  Body,
  Button,
  Display,
  Dock,
  IconCircle,
  Label,
  Loading,
  Notice,
  Numeral,
  RankedBadge,
} from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'StreakRun'>;

/**
 * Where a Streak stage lands after the camera. Three states, each a screen of
 * its own in everything but the file count:
 *
 *   CLEARED   a short confirmation with the stage that was just beaten and
 *             the one coming up, and a button that opens it. Deliberately
 *             NOT automatic: settlement advances the run but does not open
 *             the next round, so nobody is dropped back into a camera while
 *             still reading the number they just hit.
 *   FAILED    the stage reached, the buy-back call to action, and the window
 *             counting down out of five hours. When it runs out the copy
 *             changes to say the next run starts at stage 1 -- the screen
 *             does not simply lose its button and leave the fighter to infer
 *             what happened.
 *   WON       the payout, distinct from a 1v1 win screen: three cleared
 *             stages down the middle rather than a tale of the tape, and the
 *             cooldown that has just started, stated here rather than
 *             discovered on the way back in.
 *
 * Keyed on the RUN, not on a match: all three states are facts about the run,
 * and the run outlives any one stage's match.
 */
export function StreakRunScreen({ route, navigation }: Props) {
  const { runId } = route.params;
  const insets = useSafeAreaInsets();

  const [run, setRun] = useState<StreakRunRow | null>(null);
  const [attempts, setAttempts] = useState<StreakStageAttemptRow[]>([]);
  const [view, setView] = useState<StreakPreviewRow | null>(null);
  const [rating, setRating] = useState<SkillRatingEventRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pop = useRef(new Animated.Value(0)).current;

  const load = useCallback(async () => {
    const { data: runData } = await supabase
      .from('streak_runs')
      .select('*')
      .eq('id', runId)
      .maybeSingle();
    const runRow = (runData ?? null) as StreakRunRow | null;
    setRun(runRow);
    if (!runRow) {
      setLoading(false);
      return;
    }

    const [{ data: attemptData }, previewResult] = await Promise.all([
      supabase
        .from('streak_stage_attempts')
        .select('*')
        .eq('run_id', runId)
        .order('created_at', { ascending: true }),
      streakPreview(runRow.exercise_type),
    ]);
    const rows = (attemptData ?? []) as StreakStageAttemptRow[];
    setAttempts(rows);
    // The preview carries the server's own clock, which is what both
    // countdowns are measured against. It describes the same run whenever
    // this one is the most recent, which it is in every flow that reaches
    // here; when it is not, the timestamps below fall back to the run row.
    if (previewResult.data && previewResult.data.run_id === runId) {
      setView(previewResult.data);
    }

    // What the last settled attempt did to the rating. Null for a casual run
    // by construction: no event row is ever written for one.
    const last = [...rows].reverse().find(a => a.settled_at !== null);
    if (last) {
      const { data: event } = await supabase
        .from('skill_rating_events')
        .select('*')
        .eq('match_id', last.match_id)
        .maybeSingle();
      setRating((event ?? null) as SkillRatingEventRow | null);
    }
    setLoading(false);
  }, [runId]);

  useEffect(() => {
    load();
  }, [load]);

  // The cleared/won states land with a small pop, the way the 1v1 win screen
  // lands with a shake. A failure gets no animation at all.
  useEffect(() => {
    if (!run || run.status === 'failed') {
      return;
    }
    pop.setValue(0);
    Animated.timing(pop, {
      toValue: 1,
      duration: 380,
      easing: Easing.out(Easing.back(2)),
      useNativeDriver: true,
    }).start();
  }, [run, pop]);

  const serverNow = view?.server_now ?? run?.updated_at ?? null;
  const failedAt = run?.failed_at ?? null;
  const buybackUntil =
    view?.buyback_until ??
    (failedAt
      ? new Date(Date.parse(failedAt) + STREAK_BUYBACK_WINDOW_MS).toISOString()
      : null);
  const cooldownUntil = view?.cooldown_until ?? null;

  const ticking = run?.status === 'failed' || run?.status === 'won';
  const elapsed = useCountdown(serverNow, ticking);
  const buybackLeft = remainingMs(buybackUntil, serverNow ?? '', elapsed);
  const cooldownLeft = remainingMs(cooldownUntil, serverNow ?? '', elapsed);

  const nextStage = useCallback(async () => {
    setBusy(true);
    setError(null);
    const result = await streakNextStage(runId);
    setBusy(false);
    if (result.error !== null) {
      setError(soloErrorCopy(result.error));
      load();
      return;
    }
    if (result.data.pending_match_id) {
      navigation.replace('MatchInProgress', { matchId: result.data.pending_match_id });
    } else {
      load();
    }
  }, [runId, navigation, load]);

  const buyBack = useCallback(async () => {
    setBusy(true);
    setError(null);
    const result = await streakBuyBackIn(runId);
    setBusy(false);
    if (result.error !== null) {
      setError(soloErrorCopy(result.error));
      load();
      return;
    }
    if (result.data.pending_match_id) {
      navigation.replace('MatchInProgress', { matchId: result.data.pending_match_id });
    } else {
      load();
    }
  }, [runId, navigation, load]);

  const home = () => navigation.navigate('Home');

  if (loading) {
    return <Loading />;
  }

  if (!run) {
    return (
      <View style={styles.screen}>
        <View style={[styles.body, { paddingTop: insets.top + space.xxl }]}>
          <Display size={52}>RUN{'\n'}NOT FOUND.</Display>
          <Body muted style={styles.detail}>
            That run isn't yours, or it's gone.
          </Body>
        </View>
        <Dock>
          <Button label="BACK TO BOUTS" variant="card" onPress={home} />
        </Dock>
      </View>
    );
  }

  const type = run.exercise_type;
  const mode = run.is_ranked ? 'ranked' : 'casual';
  const ratingLine = run.is_ranked ? ratingResultFor(rating) : null;
  const totalStaked = run.stake_points * run.stakes_paid;
  const headPad = { paddingTop: insets.top + space.xl };
  const popStyle = {
    transform: [
      { scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) },
    ],
    opacity: pop,
  };

  // ── WON ───────────────────────────────────────────────────────────────
  if (run.status === 'won') {
    return (
      <View style={styles.flood}>
        <Text style={styles.watermark} pointerEvents="none">
          3
        </Text>
        <View style={[styles.head, headPad]}>
          <View style={styles.kicker}>
            <Icon name="seal-check" size={14} color={colors.onAccent} contrast={colors.accent} />
            <Label size={11} color={colors.onAccentMuted}>
              STREAK · ALL THREE CLEARED
            </Label>
          </View>
          <IconCircle
            icon="x"
            bg={colors.onAccentGhost}
            color={colors.onAccent}
            accessibilityLabel="Close"
            onPress={home}
          />
        </View>
        <Animated.View style={[styles.body, popStyle]}>
          <Display size={60} tracking={-0.015} color={colors.onAccent}>
            RUN{'\n'}COMPLETE.
          </Display>
          <View style={styles.deltaRow}>
            <Numeral size={104} color={colors.onAccent}>
              {`+${fmtPoints(run.payout_points ?? 0)}`}
            </Numeral>
            <Label size={14} color={colors.onAccentMuted} tracking={0.2}>
              {UNIT}
            </Label>
          </View>
          <StageTape run={run} attempts={attempts} type={type} onAccent />
          <View style={styles.tapeFoot}>
            <RankedBadge mode={mode} onAccent />
            <Label size={10} color={colors.onAccentFaint} tracking={0.12}>
              {`${fmtMultiplier(run.payout_bp)} ON ${fmtPoints(run.stake_points)} · ${fmtPoints(totalStaked)} ${UNIT} STAKED`}
            </Label>
          </View>
          {ratingLine ? (
            <View style={styles.rating}>
              {ratingLine.delta ? (
                <Numeral size={26} color={colors.onAccent}>
                  {ratingLine.delta}
                </Numeral>
              ) : null}
              <View style={styles.ratingText}>
                <Label size={9} color={colors.onAccentFaint} tracking={0.14}>
                  RANK
                </Label>
                <Label size={11} color={colors.onAccent} tracking={0.1}>
                  {ratingLine.caption}
                </Label>
              </View>
            </View>
          ) : null}
          {/* The cooldown, stated where the win is, not discovered later. */}
          <View style={styles.cooldownStrip}>
            <Icon name="clock" size={14} color={colors.onAccentMuted} />
            <Label size={10} color={colors.onAccentMuted} tracking={0.12}>
              {cooldownUntil
                ? `STREAK OPENS AGAIN IN ${fmtCountdown(cooldownLeft)}`
                : 'STREAK COOLS DOWN FOR FIVE HOURS'}
            </Label>
          </View>
        </Animated.View>
        <Dock transparent style={styles.dock}>
          <Button
            label="FIND ANOTHER BOUT"
            variant="onAccentDark"
            onPress={() => navigation.navigate('FindBout')}
          />
          <Button label="BACK TO BOUTS" variant="onAccentGhost" onPress={home} />
        </Dock>
      </View>
    );
  }

  // ── FAILED ────────────────────────────────────────────────────────────
  if (run.status === 'failed') {
    const open = buybackLeft > 0;
    const reached = run.failed_stage ?? run.current_stage;
    const target = stageTargetOf(
      {
        stage1_target: run.stage1_target,
        stage2_target: run.stage2_target,
        stage3_target: run.stage3_target,
      },
      reached,
    );
    const lastScore =
      [...attempts].reverse().find(a => a.settled_at !== null)?.score ?? null;
    return (
      <View style={styles.screen}>
        <Text style={styles.watermarkDim} pointerEvents="none">
          {String(reached)}
        </Text>
        <View style={[styles.head, headPad]}>
          <View style={styles.kicker}>
            <Icon name="flag" size={14} color={colors.dim} />
            <Label size={11}>{`STREAK · ENDED AT STAGE ${reached}`}</Label>
          </View>
          <IconCircle icon="x" color={colors.secondary} accessibilityLabel="Close" onPress={home} />
        </View>
        <View style={styles.body}>
          <Display size={60} tracking={-0.015} color={colors.secondary}>
            STAGE {reached}{'\n'}
            <Text style={styles.white}>HELD.</Text>
          </Display>
          <Body muted style={styles.detail}>
            {target !== null && lastScore !== null
              ? `You needed ${fmtTarget(target, type)} and got ${fmtTarget(lastScore, type)}. The ${reached - 1 > 0 ? `${reached - 1} stage${reached - 1 > 1 ? 's' : ''} you already cleared are` : 'run is'} still on the board.`
              : 'The run ends here.'}
          </Body>

          <StageTape run={run} attempts={attempts} type={type} />

          {/* The buy-back window, and what it becomes when it closes. */}
          <View style={[styles.window, open ? styles.windowOpen : styles.windowShut]}>
            <View style={styles.windowHead}>
              <Icon
                name="clock"
                size={14}
                color={open ? colors.accent : colors.dim}
              />
              <Label
                size={10}
                color={open ? colors.accent : colors.dim}
                tracking={0.12}
              >
                {open ? 'BUY-BACK WINDOW' : 'BUY-BACK WINDOW CLOSED'}
              </Label>
            </View>
            <Numeral size={44} color={open ? colors.accent : colors.dim}>
              {fmtCountdown(buybackLeft)}
            </Numeral>
            <View style={styles.windowTrack}>
              <View
                style={[
                  styles.windowFill,
                  {
                    width: `${Math.round(
                      windowProgress(buybackLeft, STREAK_BUYBACK_WINDOW_MS) * 100,
                    )}%`,
                    backgroundColor: open ? colors.accent : colors.slot,
                  },
                ]}
              />
            </View>
            <Text style={styles.windowNote}>
              {open
                ? `Out of ${fmtCountdown(STREAK_BUYBACK_WINDOW_MS)}. ${fmtPoints(run.stake_points)} ${UNIT} puts you back on stage ${reached} with your cleared stages intact.`
                : `The five hours are up. Your next run starts over at stage 1, with targets set to your rank as it is then.`}
            </Text>
          </View>

          {error ? (
            <Notice icon="warning" iconColor={colors.accent} style={styles.error}>
              {error}
            </Notice>
          ) : null}
        </View>
        <Dock style={styles.dock}>
          {open ? (
            <Button
              label={`BUY BACK IN · ${fmtPoints(run.stake_points)}`}
              icon="rematch"
              onPress={buyBack}
              loading={busy}
            />
          ) : (
            <Button
              label="START A NEW RUN"
              onPress={() =>
                navigation.replace('StreakPre', { exerciseType: type })
              }
            />
          )}
          <Button label="BACK TO BOUTS" variant="card" onPress={home} />
        </Dock>
      </View>
    );
  }

  // ── CLEARED, mid-run ──────────────────────────────────────────────────
  const justCleared = Math.max(1, run.current_stage - 1);
  const upNext = run.current_stage;
  const nextTarget = stageTargetOf(
    {
      stage1_target: run.stage1_target,
      stage2_target: run.stage2_target,
      stage3_target: run.stage3_target,
    },
    upNext,
  );
  const openRound = view?.pending_match_id ?? null;

  return (
    <View style={styles.screen}>
      <View style={[styles.head, headPad]}>
        <View style={styles.kicker}>
          <Icon name="seal-check" size={14} color={colors.accent} contrast={colors.bg} />
          <Label size={11} color={colors.accent}>
            {`STAGE ${justCleared} CLEARED`}
          </Label>
        </View>
        <IconCircle icon="x" color={colors.secondary} accessibilityLabel="Close" onPress={home} />
      </View>
      <Animated.View style={[styles.body, popStyle]}>
        <Display size={60} tracking={-0.015}>
          {`${justCleared} DOWN.`}{'\n'}
          <Text style={styles.accentText}>{`${STREAK_STAGES - justCleared} TO GO.`}</Text>
        </Display>
        <Body muted style={styles.detail}>
          {nextTarget !== null
            ? `Stage ${upNext} is ${fmtTarget(nextTarget, type)}. Your stake is already in — clearing all three pays ${fmtPoints(payoutFor(run.stake_points, run.payout_bp))} ${UNIT}.`
            : 'The run continues.'}
        </Body>

        <StageTape run={run} attempts={attempts} type={type} />

        <View style={styles.tapeFoot}>
          <RankedBadge mode={mode} />
          <Label size={10} color={colors.dim} tracking={0.12}>
            {`${EXERCISE_LABEL[type].toUpperCase()} · ${fmtPoints(totalStaked)} ${UNIT} IN`}
          </Label>
        </View>

        {error ? (
          <Notice icon="warning" iconColor={colors.accent} style={styles.error}>
            {error}
          </Notice>
        ) : null}
      </Animated.View>
      <Dock style={styles.dock}>
        <Button
          label={
            openRound
              ? `BACK TO STAGE ${upNext}`
              : `START STAGE ${upNext} OF ${STREAK_STAGES}`
          }
          onPress={
            openRound
              ? () => navigation.replace('MatchInProgress', { matchId: openRound })
              : nextStage
          }
          loading={busy}
        />
        <Button label="LATER" variant="card" onPress={home} />
      </Dock>
    </View>
  );
}

/**
 * The three stages with what each one asked for and what was actually done.
 * The Streak equivalent of the 1v1 tale of the tape -- and it has to be a
 * different shape, because the comparison is against three bars in sequence
 * rather than against one opponent.
 */
function StageTape({
  run,
  attempts,
  type,
  onAccent,
}: {
  run: StreakRunRow;
  attempts: StreakStageAttemptRow[];
  type: ChallengeType;
  onAccent?: boolean;
}) {
  const strong = onAccent ? colors.onAccent : colors.text;
  const soft = onAccent ? colors.onAccentMuted : colors.secondary;
  const faint = onAccent ? colors.onAccentFaint : colors.dim;
  const targets = [run.stage1_target, run.stage2_target, run.stage3_target];
  return (
    <View
      style={[
        styles.tape,
        { backgroundColor: onAccent ? colors.onAccentWash : colors.card },
      ]}
    >
      {targets.map((target, i) => {
        const stage = i + 1;
        // The last attempt at this stage is the one that decided it; earlier
        // ones were bought back out of.
        const attempt =
          [...attempts].reverse().find(a => a.stage === stage && a.settled_at) ?? null;
        const passed = attempt?.passed ?? null;
        const ink = passed === true ? strong : passed === false ? soft : faint;
        return (
          <View key={stage} style={styles.tapeRow}>
            <View style={styles.tapeLeft}>
              <View
                style={[
                  styles.tapePip,
                  passed === true && (onAccent ? styles.tapePipDoneOnAccent : styles.tapePipDone),
                  passed === false && styles.tapePipFail,
                ]}
              >
                {passed === true ? (
                  <Icon
                    name="check"
                    size={10}
                    color={onAccent ? colors.accent : colors.onAccent}
                  />
                ) : passed === false ? (
                  <Icon name="x" size={10} color={colors.text} />
                ) : (
                  <Text style={[styles.tapePipText, { color: faint }]}>
                    {String(stage)}
                  </Text>
                )}
              </View>
              <Label size={10} color={ink} tracking={0.12}>
                {`STAGE ${stage} · ${fmtTarget(target, type)}`}
              </Label>
            </View>
            <Numeral size={20} color={ink}>
              {attempt?.score !== null && attempt?.score !== undefined
                ? fmtTarget(attempt.score, type)
                : '—'}
            </Numeral>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, overflow: 'hidden' },
  flood: { flex: 1, backgroundColor: colors.accent, overflow: 'hidden' },
  watermark: {
    ...anton(420, { tracking: -0.05, color: colors.onAccentWatermark }),
    position: 'absolute',
    right: -20,
    top: 40,
  },
  watermarkDim: {
    ...anton(420, { tracking: -0.05, color: colors.watermark }),
    position: 'absolute',
    right: -20,
    top: 40,
  },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space.xxl,
  },
  kicker: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  body: { flex: 1, paddingTop: 24, paddingHorizontal: space.xxl },
  detail: { marginTop: 14 },
  white: { color: colors.text },
  accentText: { color: colors.accent },
  deltaRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
    marginTop: 18,
  },
  error: { marginTop: space.lg },

  tape: {
    marginTop: space.xl,
    borderRadius: radius.card,
    padding: space.lg,
    gap: space.md,
  },
  tapeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  tapeLeft: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 2 },
  tapePip: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.raised,
  },
  tapePipDone: { backgroundColor: colors.accent },
  tapePipDoneOnAccent: { backgroundColor: colors.onAccent },
  tapePipFail: { backgroundColor: colors.slot },
  tapePipText: { ...label(10, colors.dim, 0) },
  tapeFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.md,
  },

  rating: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.lg,
  },
  ratingText: { flex: 1, gap: 3 },
  cooldownStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.lg,
  },

  window: {
    marginTop: space.xl,
    borderRadius: radius.card,
    padding: space.lg,
    gap: 6,
    alignItems: 'center',
  },
  windowOpen: {
    backgroundColor: colors.accentTint,
    borderWidth: 1,
    borderColor: colors.accentOutline,
  },
  windowShut: { backgroundColor: colors.card },
  windowHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  windowTrack: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    marginTop: space.sm,
    backgroundColor: colors.slot,
    overflow: 'hidden',
  },
  windowFill: { height: '100%', borderRadius: 3 },
  windowNote: { ...typography.helper, textAlign: 'center', marginTop: space.sm },

  dock: { gap: space.sm + 2 },
});
