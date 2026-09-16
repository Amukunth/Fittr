import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { useFitnessProfile } from '../hooks/useFitnessProfile';
import { useCountdown } from '../hooks/useCountdown';
import { compactPoints, fmtPoints } from '../lib/format';
import {
  STREAK_STAGES,
  STREAK_WIN_COOLDOWN_MS,
  fmtCountdown,
  fmtMultiplier,
  fmtTarget,
  payoutFor,
  remainingMs,
  soloErrorCopy,
  streakPreview,
  streakStart,
  streakStagesOf,
  type StreakStage,
} from '../lib/soloModes';
import { RANK_TIER_LABEL, rankTierOf } from '../lib/skillRating';
import type { RootStackParamList } from '../navigation/types';
import type { RankedMode, StreakPreviewRow } from '../types/database';
import {
  EXERCISE_ICON,
  EXERCISE_LABEL,
  RANKED_NOTE,
  SOLO_CALIBRATION_NOTE,
  SOLO_CALIBRATION_ROUGH,
  STAKE_OPTIONS,
  STREAK_RULES,
  UNIT,
} from '../theme/copy';
import { Icon } from '../theme/icons';
import { colors, label, radius, space, typography } from '../theme/tokens';
import {
  Body,
  Button,
  Display,
  Dock,
  IconCircle,
  Label,
  Notice,
  Numeral,
  RankedToggle,
  Skeleton,
  TopBar,
} from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'StreakPre'>;

/**
 * Streak set-up, and the mode's one front door. Five states, all of them the
 * same screen because they are all answers to "can I run Streak right now":
 *
 *   idle      the three stage targets, a stake, and a START button.
 *   active    a run is already going: resume it at the stage it is on.
 *   failed    a buy-back is on offer, with the window counting down. (The
 *             full failure screen lives on StreakRun; this is the version
 *             someone sees when they come back to the mode later.)
 *   expired   that run is spent. The next one starts at stage 1, and the copy
 *             says so rather than quietly offering a fresh start.
 *   cooldown  LOCKED after a win, with a visible countdown to when it opens.
 *             Deliberately shown rather than hidden: a mode that vanishes
 *             reads as a bug, and a fighter who just won has earned an
 *             explanation, not an absence.
 */
export function StreakPreScreen({ route, navigation }: Props) {
  const { exerciseType } = route.params;
  const { profile } = useFitnessProfile();

  const [view, setView] = useState<StreakPreviewRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stake, setStake] = useState<number>(STAKE_OPTIONS[1] ?? 100);
  // Casual on every mount. A run that is already going carries its own mode,
  // which is what the badge below shows instead of this toggle.
  const [mode, setMode] = useState<RankedMode>('casual');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await streakPreview(exerciseType);
    if (error) {
      setLoadError(soloErrorCopy(error));
      return;
    }
    setLoadError(null);
    setView(data);
  }, [exerciseType]);

  // On focus, not just on mount: coming back from a stage that just settled
  // has to re-read the state, and the two countdowns have to re-anchor to a
  // fresh server clock.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const state = view?.state ?? null;
  // The ticker is only worth running while something is actually counting.
  const ticking = state === 'cooldown' || state === 'failed';
  const elapsed = useCountdown(view ? view.server_now : null, ticking);

  const balance = profile?.points_balance ?? null;
  const affordable = (value: number) => balance === null || value <= balance;

  const start = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    const result = await streakStart(exerciseType, stake, mode);
    setBusy(false);
    if (result.error !== null) {
      setActionError(soloErrorCopy(result.error));
      // The refusal may be news about the state (a cooldown that started on
      // another device), so re-read rather than leaving a stale screen up.
      load();
      return;
    }
    if (result.data.pending_match_id) {
      navigation.replace('MatchInProgress', { matchId: result.data.pending_match_id });
    } else {
      setView(result.data);
    }
  }, [exerciseType, stake, mode, navigation, load]);

  const resume = useCallback(() => {
    if (!view?.run_id) {
      return;
    }
    if (view.pending_match_id) {
      navigation.navigate('MatchInProgress', { matchId: view.pending_match_id });
    } else {
      // Mid-run with no open round: the stage-cleared screen is where the
      // "start stage N" button lives, so that is the right place to land.
      navigation.navigate('StreakRun', { runId: view.run_id });
    }
  }, [view, navigation]);

  if (loadError) {
    return (
      <View style={styles.screen}>
        <TopBar
          left={
            <IconCircle
              icon="arrow-left"
              accessibilityLabel="Back"
              onPress={() => navigation.goBack()}
            />
          }
        />
        <View style={styles.body}>
          <Display size={48}>NO RUN{'\n'}TO MAKE.</Display>
          <Body muted style={styles.detail}>
            {loadError}
          </Body>
        </View>
        <Dock>
          <Button label="BACK" variant="card" onPress={() => navigation.goBack()} />
        </Dock>
      </View>
    );
  }

  const stages = view ? streakStagesOf(view) : null;
  const locked = state === 'cooldown';
  const cooldownLeft = remainingMs(
    view?.cooldown_until ?? null,
    view?.server_now ?? '',
    elapsed,
  );
  const buybackLeft = remainingMs(
    view?.buyback_until ?? null,
    view?.server_now ?? '',
    elapsed,
  );
  // A run's own stake governs a resume or a buy-back; the picker only governs
  // a fresh run.
  const runStake = view?.stake_points ?? stake;
  const payout = view
    ? payoutFor(state === 'idle' ? stake : runStake, view.payout_bp)
    : 0;

  return (
    <View style={styles.screen}>
      <TopBar
        left={
          <IconCircle
            icon="arrow-left"
            accessibilityLabel="Back"
            onPress={() => navigation.goBack()}
          />
        }
        right={
          <View style={styles.headRight}>
            <Icon name={EXERCISE_ICON[exerciseType]} size={16} color={colors.secondary} />
            <Label size={11}>{EXERCISE_LABEL[exerciseType].toUpperCase()}</Label>
          </View>
        }
      />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View>
          <Label size={11}>SOLO · STREAK</Label>
          <Display size={44} style={styles.title}>
            {locked ? 'COOLING\nDOWN.' : 'THREE IN\nA ROW.'}
          </Display>
          <Text style={styles.rules}>
            {locked
              ? 'You took the last one. Streak opens again when the clock runs out — every other mode is open in the meantime.'
              : STREAK_RULES}
          </Text>
        </View>

        {/* The win cooldown, shown rather than hidden. */}
        {locked ? (
          <View style={styles.lockCard}>
            <View style={styles.lockHead}>
              <Icon name="lock" size={16} color={colors.secondary} />
              <Label size={11}>STREAK OPENS IN</Label>
            </View>
            <Numeral size={56} color={colors.text}>
              {fmtCountdown(cooldownLeft)}
            </Numeral>
            <Label size={10} color={colors.dim} tracking={0.12}>
              {`OF ${fmtCountdown(STREAK_WIN_COOLDOWN_MS)} AFTER A WIN`}
            </Label>
            {view?.payout_points !== null && view?.payout_points !== undefined ? (
              <Text style={styles.lockNote}>
                {`Last run paid ${fmtPoints(view.payout_points)} ${UNIT}.`}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* All three stages, up front, before anything is committed. */}
        <View>
          <View style={styles.sectionHead}>
            <Label size={11}>
              {state === 'active' ? 'THE RUN' : 'THE THREE STAGES'}
            </Label>
            {view ? (
              <Label size={11} tracking={0.08}>
                {view.placement_complete
                  ? `${RANK_TIER_LABEL[rankTierOf(view.mmr)].toUpperCase()} · ${view.mmr} MMR`
                  : 'UNRANKED · PROVISIONAL'}
              </Label>
            ) : null}
          </View>
          {stages ? (
            <View style={styles.ladder}>
              {stages.map(stage => (
                <StageRow
                  key={stage.stage}
                  stage={stage}
                  exerciseType={exerciseType}
                  // Only a live run has a "current" stage worth marking.
                  current={
                    state === 'active' || state === 'failed'
                      ? view!.current_stage === stage.stage
                      : false
                  }
                  cleared={
                    (state === 'active' || state === 'failed') &&
                    view!.current_stage !== null &&
                    stage.stage < view!.current_stage
                  }
                  dim={locked}
                />
              ))}
            </View>
          ) : (
            <View style={styles.ladder}>
              {[0, 1, 2].map(i => (
                <View key={i} style={styles.stageRow}>
                  <Skeleton width={90} height={20} />
                  <Skeleton width={60} height={28} />
                </View>
              ))}
            </View>
          )}
          <Text style={styles.helper}>
            {view && !view.calibrated_to_me
              ? SOLO_CALIBRATION_ROUGH
              : SOLO_CALIBRATION_NOTE}
          </Text>
        </View>

        {/* A failed run, seen on the way back into the mode. */}
        {state === 'failed' ? (
          <View style={styles.buybackCard}>
            <Label size={11} color={colors.accent} tracking={0.12}>
              {`FAILED AT STAGE ${view!.failed_stage} · BUY BACK IN`}
            </Label>
            <Numeral size={44} color={colors.accent}>
              {fmtCountdown(buybackLeft)}
            </Numeral>
            <Text style={styles.lockNote}>
              {`${fmtPoints(runStake)} ${UNIT} puts you back on stage ${view!.failed_stage} with everything you have already cleared.`}
            </Text>
          </View>
        ) : null}

        {state === 'expired' ? (
          <Notice icon="clock" iconColor={colors.secondary}>
            {`Your last run ended at stage ${view!.failed_stage} and the buy-back window has closed. A new run starts at stage 1.`}
          </Notice>
        ) : null}

        {/* Stake and mode are only a choice for a run that has not started. */}
        {state === 'idle' || state === 'expired' ? (
          <>
            <View>
              <View style={styles.sectionHead}>
                <Label size={11}>STAKE ONCE</Label>
                <Label size={11} tracking={0.08}>
                  {`YOU HAVE ${balance === null ? '—' : compactPoints(balance)}`}
                </Label>
              </View>
              <View style={styles.stakeRow}>
                {STAKE_OPTIONS.map(value => {
                  const on = stake === value;
                  const ok = affordable(value);
                  return (
                    <Pressable
                      key={value}
                      disabled={!ok}
                      onPress={() => setStake(value)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on, disabled: !ok }}
                      style={[
                        styles.stakeTile,
                        on && styles.stakeOn,
                        !ok && styles.stakeOff,
                      ]}
                    >
                      <Numeral size={22} color={on ? colors.onAccent : colors.text}>
                        {fmtPoints(value)}
                      </Numeral>
                      <Text style={[styles.stakeUnit, on && styles.stakeUnitOn]}>
                        {UNIT}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View>
              <Label size={11} style={styles.fieldLabel}>
                THIS RUN
              </Label>
              <RankedToggle value={mode} onChange={setMode} />
              <Text style={styles.helper}>
                {mode === 'ranked'
                  ? 'Ranked. Every stage attempt moves your rank — including a buy-back.'
                  : RANKED_NOTE.casual}
              </Text>
            </View>
          </>
        ) : null}

        {actionError ? (
          <Notice icon="warning" iconColor={colors.accent}>
            {actionError}
          </Notice>
        ) : null}
      </ScrollView>

      <Dock style={styles.dock}>
        {locked ? (
          <Button label="BACK TO BOUTS" variant="card" onPress={() => navigation.navigate('Home')} />
        ) : state === 'active' ? (
          <>
            <View style={styles.summary}>
              <Label size={11} color={colors.secondary} tracking={0.12}>
                {`STAGE ${view!.current_stage} OF ${STREAK_STAGES} · ${fmtPoints(runStake * (view!.stakes_paid ?? 1))} ${UNIT} IN`}
              </Label>
              <Display size={22} color={colors.accent}>
                {`WIN ${fmtPoints(payout)}`}
              </Display>
            </View>
            <Button label="BACK TO YOUR RUN" onPress={resume} />
          </>
        ) : state === 'failed' ? (
          <Button
            label="SEE THE RUN"
            onPress={() => navigation.navigate('StreakRun', { runId: view!.run_id! })}
          />
        ) : (
          <>
            <View style={styles.summary}>
              <Label size={11} color={colors.secondary} tracking={0.12}>
                {stages
                  ? `ALL THREE: ${stages
                      .map(s => fmtTarget(s.target, exerciseType))
                      .join(' · ')}`
                  : 'SETTING YOUR STAGES'}
              </Label>
              <Display size={22} color={colors.accent}>
                {view ? `${fmtMultiplier(view.payout_bp)} · ${fmtPoints(payout)}` : '—'}
              </Display>
            </View>
            <Button
              label={`STAKE ${fmtPoints(stake)} · START`}
              onPress={start}
              loading={busy}
              disabled={!view || !affordable(stake)}
            />
          </>
        )}
      </Dock>
    </View>
  );
}

/**
 * One stage of the ladder. A live run marks what has been cleared and what is
 * next; an idle one just lists the three, which is the whole point of showing
 * them before the stake.
 */
function StageRow({
  stage,
  exerciseType,
  current,
  cleared,
  dim,
}: {
  stage: StreakStage;
  exerciseType: Props['route']['params']['exerciseType'];
  current: boolean;
  cleared: boolean;
  dim: boolean;
}) {
  const ink = current ? colors.accent : cleared ? colors.secondary : colors.text;
  return (
    <View
      style={[
        styles.stageRow,
        current && styles.stageRowCurrent,
        dim && styles.stageRowDim,
      ]}
    >
      <View style={styles.stageLeft}>
        <View style={[styles.stagePip, cleared && styles.stagePipDone, current && styles.stagePipNow]}>
          {cleared ? (
            <Icon name="check" size={11} color={colors.onAccent} />
          ) : (
            <Text style={styles.stagePipText}>{String(stage.stage)}</Text>
          )}
        </View>
        <Label size={11} color={ink} tracking={0.1}>
          {`STAGE ${stage.stage}`}
        </Label>
      </View>
      <View style={styles.stageRight}>
        <Numeral size={26} color={ink}>
          {fmtTarget(stage.target, exerciseType)}
        </Numeral>
        <Label size={10} color={colors.dim} tracking={0.12}>
          {exerciseType === 'pushups' ? 'REPS' : 'HOLD'}
        </Label>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  headRight: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  content: {
    paddingTop: space.lg,
    paddingHorizontal: space.gutter,
    paddingBottom: space.gutter,
    gap: space.xxl,
  },
  body: { flex: 1, paddingTop: space.xxl, paddingHorizontal: space.xxl },
  detail: { marginTop: space.lg },
  title: { marginTop: space.sm },
  rules: { ...typography.helper, marginTop: space.md },
  fieldLabel: { marginBottom: space.sm + 2 },
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: space.sm + 2,
  },
  helper: { ...typography.helper, marginTop: space.sm },

  lockCard: {
    alignItems: 'center',
    gap: 6,
    paddingVertical: space.xl,
    paddingHorizontal: space.lg,
    borderRadius: radius.card,
    backgroundColor: colors.card,
  },
  lockHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  lockNote: { ...typography.helper, textAlign: 'center', marginTop: space.sm },

  buybackCard: {
    alignItems: 'center',
    gap: 4,
    paddingVertical: space.lg,
    paddingHorizontal: space.lg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.accentOutline,
    backgroundColor: colors.accentTint,
  },

  ladder: { gap: space.sm },
  stageRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    height: 60,
    paddingHorizontal: space.cardPad,
    borderRadius: radius.control,
    backgroundColor: colors.card,
  },
  stageRowCurrent: {
    borderWidth: 1,
    borderColor: colors.accentOutline,
    backgroundColor: colors.accentTint,
  },
  stageRowDim: { opacity: 0.5 },
  stageLeft: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  stageRight: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  stagePip: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.handle,
  },
  stagePipDone: { backgroundColor: colors.accent },
  stagePipNow: { backgroundColor: colors.text },
  stagePipText: { ...label(11, colors.bg, 0) },

  stakeRow: { flexDirection: 'row', gap: space.sm },
  stakeTile: {
    flex: 1,
    height: 56,
    borderRadius: radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    backgroundColor: colors.card,
  },
  stakeOn: { backgroundColor: colors.accent },
  stakeOff: { opacity: 0.35 },
  stakeUnit: { ...label(9, colors.secondary, 0.1) },
  stakeUnitOn: { color: colors.onAccentMuted },

  dock: { paddingBottom: space.md, gap: space.sm + 2 },
  summary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: space.xs,
    paddingBottom: space.sm + 2,
  },
});
