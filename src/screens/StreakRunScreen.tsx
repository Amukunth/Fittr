import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StreakStages, type StageStatus } from '../components/StreakStages';
import { supabase } from '../lib/supabase';
import { useCountdown } from '../hooks/useCountdown';
import { fmtPoints } from '../lib/format';
import { REFERENCE_QUALITY_BP, fmtScore } from '../lib/score';
import { ratingResultFor } from '../lib/skillRating';
import {
  STREAK_BUYBACK_WINDOW_MS,
  STREAK_STAGES,
  fmtCountdown,
  fmtMultiplier,
  payoutFor,
  remainingMs,
  soloErrorCopy,
  stageTargetOf,
  streakBuyBackIn,
  streakNextStage,
  streakPreview,
  streakStagesOf,
  windowProgress,
} from '../lib/soloModes';
import type { RootStackParamList } from '../navigation/types';
import type {
  SkillRatingEventRow,
  StreakPreviewRow,
  StreakRunRow,
  StreakStageAttemptRow,
} from '../types/database';
import { EXERCISE_LABEL, UNIT } from '../theme/copy';
import { Icon } from '../theme/icons';
import { anton, colors, fonts, label, radius, space, typography } from '../theme/tokens';
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
 *   CLEARED   the stage list with the stage just beaten checked and the next
 *             one live, and a button that opens it. Deliberately NOT
 *             automatic: settlement advances the run but does not open the
 *             next round, so nobody is dropped back into a camera while
 *             still reading the number they just hit.
 *   FAILED    the reference's failure state: the stage list with the failed
 *             stage marked, "Streak failed", the payout badge for what the
 *             run pays, and two actions -- NEW STREAK (secondary, a fresh run
 *             at stage 1) and REVIVE (primary, the same stage again for
 *             another stake) -- with the five-hour window counting down. When
 *             it runs out the copy says the next run starts at stage 1.
 *   WON       the WIN display, distinct from a 1v1 win screen: three cleared
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
    if (previewResult.data && previewResult.data.run_id === runId) {
      setView(previewResult.data);
    }

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

  const revive = useCallback(async () => {
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

  const home = () => navigation.navigate('Compete');

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
          <Button label="BACK TO COMPETE" variant="card" onPress={home} />
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
  const stages = streakStagesOf(run);
  const referenceBp = view?.reference_quality_bp ?? REFERENCE_QUALITY_BP;
  // The last attempt at a stage is the one that decided it; earlier ones
  // were revived out of.
  const decidedAttempt = (stage: number) =>
    [...attempts].reverse().find(a => a.stage === stage && a.settled_at !== null) ?? null;
  const scoreOf = (stage: number) => decidedAttempt(stage)?.score ?? null;
  const newStreak = () =>
    navigation.replace('ExerciseModes', { exerciseType: type, mode: 'streak', fresh: true });

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
          <Label size={12} color={colors.onAccentMuted} tracking={0.2}>
            WIN
          </Label>
          <View style={styles.deltaRow}>
            <Numeral size={104} color={colors.onAccent}>
              {`+${fmtPoints(run.payout_points ?? 0)}`}
            </Numeral>
            <Label size={14} color={colors.onAccentMuted} tracking={0.2}>
              {UNIT}
            </Label>
          </View>
          <Display size={40} tracking={-0.015} color={colors.onAccent}>
            RUN COMPLETE.
          </Display>
          <StageTape stages={stages} scoreOf={scoreOf} onAccent />
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
          <Button label="BACK TO COMPETE" variant="onAccentDark" onPress={home} />
        </Dock>
      </View>
    );
  }

  // ── FAILED ────────────────────────────────────────────────────────────
  if (run.status === 'failed') {
    const open = buybackLeft > 0;
    const reached = run.failed_stage ?? run.current_stage;
    const target = stageTargetOf(run, reached);
    const lastScore = scoreOf(reached);
    const statusOf = (stage: number): StageStatus =>
      stage < reached ? 'cleared' : stage === reached ? 'failed' : 'locked';
    return (
      <View style={styles.screen}>
        <View style={[styles.head, headPad]}>
          <View style={styles.kicker}>
            <Icon name="flag" size={14} color={colors.dim} />
            <Label size={11}>{`STREAK · ENDED AT STAGE ${reached}`}</Label>
          </View>
          <IconCircle icon="x" color={colors.secondary} accessibilityLabel="Close" onPress={home} />
        </View>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <View style={styles.winMuted}>
            <Label size={12} color={colors.dim} tracking={0.2}>
              WIN
            </Label>
            <Numeral size={40} color={colors.dim}>
              {fmtPoints(payoutFor(run.stake_points, run.payout_bp))}
            </Numeral>
          </View>

          <StreakStages
            stages={stages}
            type={type}
            statusOf={statusOf}
            scoreOf={scoreOf}
            referenceQualityBp={referenceBp}
          />

          <View style={styles.failedCard}>
            <View style={styles.failedBadgeWrap}>
              <View style={styles.payoutBadge}>
                <Text style={styles.payoutBadgeText}>{fmtMultiplier(run.payout_bp)}</Text>
              </View>
              <Label size={10} tracking={0.14}>
                PAYOUT
              </Label>
            </View>
            <View style={styles.failedText}>
              <Display size={26}>STREAK FAILED</Display>
              <Text style={styles.failedBody}>
                {target !== null && lastScore !== null
                  ? `Needed ${fmtScore(target)}, scored ${fmtScore(lastScore)}. `
                  : ''}
                {open
                  ? `Revive to keep this streak alive and replay stage ${reached} for ${fmtPoints(run.stake_points)} ${UNIT}. ${reached > 1 ? `The ${reached - 1} stage${reached - 1 > 1 ? 's' : ''} you cleared stay cleared.` : ''}`
                  : 'The revive window has closed. A new run starts at stage 1, with targets set to your rank as it is now.'}
              </Text>
            </View>
          </View>

          {/* The revive window, and what it becomes when it closes. */}
          <View style={[styles.window, open ? styles.windowOpen : styles.windowShut]}>
            <View style={styles.windowHead}>
              <Icon name="clock" size={14} color={open ? colors.accent : colors.dim} />
              <Label size={10} color={open ? colors.accent : colors.dim} tracking={0.12}>
                {open ? 'REVIVE WINDOW' : 'REVIVE WINDOW CLOSED'}
              </Label>
            </View>
            <Numeral size={40} color={open ? colors.accent : colors.dim}>
              {fmtCountdown(buybackLeft)}
            </Numeral>
            <View style={styles.windowTrack}>
              <View
                style={[
                  styles.windowFill,
                  {
                    width: `${Math.round(windowProgress(buybackLeft, STREAK_BUYBACK_WINDOW_MS) * 100)}%`,
                    backgroundColor: open ? colors.accent : colors.slot,
                  },
                ]}
              />
            </View>
            <Text style={styles.windowNote}>
              {`Out of ${fmtCountdown(STREAK_BUYBACK_WINDOW_MS)}. ${fmtPoints(totalStaked)} ${UNIT} in so far.`}
            </Text>
          </View>

          <View style={styles.tapeFoot}>
            <RankedBadge mode={mode} />
            <Label size={10} color={colors.dim} tracking={0.12}>
              {EXERCISE_LABEL[type].toUpperCase()}
            </Label>
          </View>

          {error ? (
            <Notice icon="warning" iconColor={colors.accent} style={styles.error}>
              {error}
            </Notice>
          ) : null}
        </ScrollView>
        <Dock style={styles.dock}>
          <View style={styles.failedDock}>
            <Button
              label="NEW STREAK"
              variant="card"
              icon="refresh"
              onPress={newStreak}
              style={styles.half}
            />
            {open ? (
              <Button
                label={`REVIVE ${fmtPoints(run.stake_points)}`}
                onPress={revive}
                loading={busy}
                style={styles.half}
              />
            ) : (
              <Button label="START AT STAGE 1" onPress={newStreak} style={styles.half} />
            )}
          </View>
        </Dock>
      </View>
    );
  }

  // ── CLEARED, mid-run ──────────────────────────────────────────────────
  const justCleared = Math.max(1, run.current_stage - 1);
  const upNext = run.current_stage;
  const nextTarget = stageTargetOf(run, upNext);
  const openRound = view?.pending_match_id ?? null;
  const statusOf = (stage: number): StageStatus =>
    stage < upNext ? 'cleared' : stage === upNext ? 'active' : 'locked';

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
      <Animated.ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        style={popStyle}
      >
        <View style={styles.win}>
          <Label size={12} color={colors.text} tracking={0.2}>
            WIN
          </Label>
          <View style={styles.winRule} />
          <View style={styles.winRow}>
            <Numeral size={64} color={colors.accent}>
              {fmtPoints(payoutFor(run.stake_points, run.payout_bp))}
            </Numeral>
            <Label size={12} color={colors.secondary} tracking={0.16}>
              {UNIT}
            </Label>
          </View>
          <Text style={styles.winSub}>
            {nextTarget !== null
              ? `${justCleared} down, ${STREAK_STAGES - justCleared} to go. Stage ${upNext} needs ${fmtScore(nextTarget)}; your stake is already in.`
              : 'The run continues.'}
          </Text>
        </View>

        <StreakStages
          stages={stages}
          type={type}
          statusOf={statusOf}
          scoreOf={scoreOf}
          referenceQualityBp={referenceBp}
        />

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
      </Animated.ScrollView>
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
 * The three stages with what each asked for and what was scored, for the
 * lime win screen where the dark stage cards would not sit.
 */
function StageTape({
  stages,
  scoreOf,
  onAccent,
}: {
  stages: ReturnType<typeof streakStagesOf>;
  scoreOf: (stage: number) => number | null;
  onAccent?: boolean;
}) {
  const strong = onAccent ? colors.onAccent : colors.text;
  const faint = onAccent ? colors.onAccentFaint : colors.dim;
  return (
    <View
      style={[
        styles.tape,
        { backgroundColor: onAccent ? colors.onAccentWash : colors.card },
      ]}
    >
      {stages.map(s => {
        const done = scoreOf(s.stage);
        return (
          <View key={s.stage} style={styles.tapeRow}>
            <View style={styles.tapeLeft}>
              <View style={[styles.tapePip, onAccent ? styles.tapePipDoneOnAccent : styles.tapePipDone]}>
                <Icon name="check" size={10} color={onAccent ? colors.accent : colors.onAccent} />
              </View>
              <Label size={10} color={strong} tracking={0.12}>
                {`STAGE ${s.stage} · BEAT ${fmtScore(s.target)}`}
              </Label>
            </View>
            <Numeral size={20} color={done === null ? faint : strong}>
              {fmtScore(done)}
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
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space.xxl,
  },
  kicker: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  body: { flex: 1, paddingTop: 24, paddingHorizontal: space.xxl },
  scroll: { paddingTop: space.md, paddingHorizontal: space.gutter, paddingBottom: space.lg, gap: space.lg },
  detail: { marginTop: 14 },
  deltaRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
    marginTop: 6,
    marginBottom: 6,
  },
  error: { marginTop: space.sm },

  win: { alignItems: 'center', paddingVertical: space.sm, gap: space.sm },
  winMuted: { alignItems: 'center', gap: 2, paddingVertical: space.xs },
  winRule: { width: 28, height: 3, borderRadius: 2, backgroundColor: colors.handle },
  winRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  winSub: { ...typography.helper, textAlign: 'center', paddingHorizontal: space.md },

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
  tapeFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.xs,
  },

  failedCard: {
    flexDirection: 'row',
    gap: space.lg,
    alignItems: 'flex-start',
    padding: space.lg,
    borderRadius: radius.card,
    backgroundColor: colors.card,
  },
  failedBadgeWrap: { alignItems: 'center', gap: 6 },
  payoutBadge: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: radius.tile,
    borderWidth: 1.5,
    borderColor: colors.accent,
    backgroundColor: colors.accentTint,
  },
  payoutBadgeText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.accent,
    includeFontPadding: false,
  },
  failedText: { flex: 1, gap: 6 },
  failedBody: { ...typography.small },
  failedDock: { flexDirection: 'row', gap: space.sm + 2 },
  half: { flex: 1 },

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
  pipText: { ...label(10, colors.dim, 0) },

  dock: { gap: space.sm + 2 },
});
