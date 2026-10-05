import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { StreakStages, type StageStatus } from '../../components/StreakStages';
import { useCountdown } from '../../hooks/useCountdown';
import { fmtPoints } from '../../lib/format';
import {
  STREAK_STAGES,
  STREAK_WIN_COOLDOWN_MS,
  fmtCountdown,
  fmtMultiplier,
  payoutFor,
  remainingMs,
  soloErrorCopy,
  streakBuyBackIn,
  streakPreview,
  streakStart,
  streakStagesOf,
} from '../../lib/soloModes';
import { RANK_TIER_LABEL, rankTierOf } from '../../lib/skillRating';
import type { RankedMode, StreakPreviewRow } from '../../types/database';
import {
  RANKED_NOTE,
  SOLO_CALIBRATION_NOTE,
  SOLO_CALIBRATION_ROUGH,
  STREAK_RULES,
  UNIT,
} from '../../theme/copy';
import { Icon } from '../../theme/icons';
import { colors, radius, space, typography } from '../../theme/tokens';
import {
  Button,
  Display,
  Dock,
  Label,
  Notice,
  Numeral,
  RankedToggle,
  Skeleton,
} from '../../theme/ui';
import {
  OpenRoundBlock,
  StakeDock,
  WinDisplay,
  defaultStake,
  paneStyles,
  type PaneProps,
} from './PaneShared';

/**
 * The Streak tab, and the mode's one front door. Six states, all the same
 * pane because they are all answers to "can I run Streak right now":
 *
 *   idle      the three stage cards, WIN for the stake on the stepper, PLAY.
 *   active    a run is going: the cards mark where it is; BACK TO YOUR RUN.
 *   failed    the reference's failure state: the failed stage marked, a
 *             "Streak failed" message, the payout badge, and two actions --
 *             NEW STREAK (secondary: a fresh run at stage 1) and REVIVE
 *             (primary: retry the same stage for another stake), with the
 *             five-hour window counting down.
 *   expired   that run is spent. A new run starts at stage 1, and the copy
 *             says so rather than quietly offering a fresh start.
 *   cooldown  LOCKED after a win, with a visible countdown. Shown rather
 *             than hidden: a mode that vanishes reads as a bug.
 *   fresh     NEW STREAK was tapped (or `fresh` arrived in the route): the
 *             stake control and PLAY, even while a failed run's window is
 *             still open. Starting over is always allowed; the window is an
 *             offer, not an obligation.
 */
export function StreakPane({
  exerciseType,
  navigation,
  balance,
  openRound,
  onGoToRound,
  fresh: freshParam,
}: PaneProps & { fresh: boolean }) {
  const [view, setView] = useState<StreakPreviewRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stake, setStake] = useState<number>(() => defaultStake(balance));
  const [mode, setMode] = useState<RankedMode>('casual');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [fresh, setFresh] = useState(freshParam);

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
  // has to re-read the state, and the countdowns re-anchor to a fresh
  // server clock.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const state = view?.state ?? null;
  const ticking = state === 'cooldown' || state === 'failed';
  const elapsed = useCountdown(view ? view.server_now : null, ticking);
  const affordable = balance === null || stake <= balance;

  const start = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    const result = await streakStart(exerciseType, stake, mode);
    setBusy(false);
    if (result.error !== null) {
      setActionError(soloErrorCopy(result.error));
      load();
      return;
    }
    if (result.data.pending_match_id) {
      navigation.replace('MatchInProgress', { matchId: result.data.pending_match_id });
    } else {
      setView(result.data);
    }
  }, [exerciseType, stake, mode, navigation, load]);

  const revive = useCallback(async () => {
    if (!view?.run_id) {
      return;
    }
    setBusy(true);
    setActionError(null);
    const result = await streakBuyBackIn(view.run_id);
    setBusy(false);
    if (result.error !== null) {
      setActionError(soloErrorCopy(result.error));
      load();
      return;
    }
    if (result.data.pending_match_id) {
      navigation.replace('MatchInProgress', { matchId: result.data.pending_match_id });
    } else {
      setView(result.data);
    }
  }, [view, navigation, load]);

  const resume = useCallback(() => {
    if (!view?.run_id) {
      return;
    }
    if (view.pending_match_id) {
      navigation.navigate('MatchInProgress', { matchId: view.pending_match_id });
    } else {
      navigation.navigate('StreakRun', { runId: view.run_id });
    }
  }, [view, navigation]);

  const stages = view ? streakStagesOf(view) : null;
  const locked = state === 'cooldown';
  const failed = state === 'failed' && !fresh;
  const startable = state === 'idle' || state === 'expired' || fresh;
  const cooldownLeft = remainingMs(view?.cooldown_until ?? null, view?.server_now ?? '', elapsed);
  const buybackLeft = remainingMs(view?.buyback_until ?? null, view?.server_now ?? '', elapsed);
  const runStake = view?.stake_points ?? stake;
  const payoutStake = startable ? stake : runStake;
  const payout = view ? payoutFor(payoutStake, view.payout_bp) : null;

  const statusOf = (stage: number): StageStatus => {
    if (!view || startable) {
      return 'idle';
    }
    const current = view.current_stage ?? 1;
    switch (view.state) {
      case 'idle':
        return 'idle';
      case 'failed':
      case 'expired':
        if (stage < current) {
          return 'cleared';
        }
        if (stage === (view.failed_stage ?? current)) {
          return 'failed';
        }
        return 'locked';
      case 'cooldown':
        return 'cleared';
      default:
        if (stage < current) {
          return 'cleared';
        }
        if (stage === current) {
          return 'active';
        }
        return 'locked';
    }
  };

  return (
    <View style={paneStyles.pane}>
      <ScrollView
        contentContainerStyle={paneStyles.content}
        showsVerticalScrollIndicator={false}
      >
        {loadError ? <Text style={typography.bodyMuted}>{loadError}</Text> : null}

        {/* On success, and while playing for it: the WIN display. */}
        {locked ? (
          <WinDisplay
            label="WON"
            amount={view?.payout_points ?? null}
            accent
            sub={`Last run paid ${fmtMultiplier(view?.payout_bp ?? 0)} on ${fmtPoints(runStake)} ${UNIT}. Streak opens again when the clock runs out.`}
          />
        ) : failed ? null : (
          <WinDisplay
            amount={payout}
            sub={
              state === 'active'
                ? `${fmtMultiplier(view?.payout_bp ?? 0)} on your ${fmtPoints(runStake)} ${UNIT} stake for all three. ${fmtPoints(runStake * (view?.stakes_paid ?? 1))} ${UNIT} in so far.`
                : STREAK_RULES
            }
          />
        )}

        {/* The stage list. */}
        <View>
          <View style={paneStyles.sectionHead}>
            <Label size={11}>
              {state === 'active' ? 'THE RUN' : failed ? 'THE RUN' : 'THE THREE STAGES'}
            </Label>
            {view ? (
              <Label size={11} tracking={0.08}>
                {view.placement_complete
                  ? `${RANK_TIER_LABEL[rankTierOf(view.mmr)].toUpperCase()} · ${view.mmr} MMR`
                  : 'UNRANKED · PROVISIONAL'}
              </Label>
            ) : null}
          </View>
          {stages && view ? (
            <StreakStages
              stages={stages}
              type={exerciseType}
              statusOf={statusOf}
              referenceQualityBp={view.reference_quality_bp}
            />
          ) : (
            <View style={styles.skeletons}>
              {[0, 1, 2].map(i => (
                <Skeleton key={i} width="100%" height={92} radius={20} />
              ))}
            </View>
          )}
          <Text style={paneStyles.helper}>
            {view && !view.calibrated_to_me ? SOLO_CALIBRATION_ROUGH : SOLO_CALIBRATION_NOTE}
          </Text>
        </View>

        {/* Failed: the message, the payout badge, the window. */}
        {failed && view ? (
          <View style={styles.failedCard}>
            <View style={styles.failedBadgeWrap}>
              <View style={styles.payoutBadge}>
                <Text style={styles.payoutBadgeText}>{fmtMultiplier(view.payout_bp)}</Text>
              </View>
              <Label size={10} tracking={0.14}>
                PAYOUT
              </Label>
            </View>
            <View style={styles.failedText}>
              <Display size={26}>STREAK FAILED</Display>
              <Text style={styles.failedBody}>
                {`Stage ${view.failed_stage} ended the run. Revive to keep it alive and replay that stage for ${fmtPoints(runStake)} ${UNIT} — the ${fmtMultiplier(view.payout_bp)} on your opening stake is still on the table.`}
              </Text>
              <View style={styles.windowRow}>
                <Icon name="clock" size={13} color={colors.accent} />
                <Label size={10} color={colors.accent} tracking={0.12}>
                  {`REVIVE WINDOW · ${fmtCountdown(buybackLeft)} LEFT`}
                </Label>
              </View>
            </View>
          </View>
        ) : null}

        {state === 'expired' && !fresh ? (
          <Notice icon="clock" iconColor={colors.secondary}>
            {`Your last run ended at stage ${view!.failed_stage} and the revive window has closed. A new run starts at stage 1.`}
          </Notice>
        ) : null}

        {locked ? (
          <View style={styles.lockCard}>
            <View style={styles.lockHead}>
              <Icon name="lock" size={16} color={colors.secondary} />
              <Label size={11}>STREAK OPENS IN</Label>
            </View>
            <Numeral size={48}>{fmtCountdown(cooldownLeft)}</Numeral>
            <Label size={10} color={colors.dim} tracking={0.12}>
              {`OF ${fmtCountdown(STREAK_WIN_COOLDOWN_MS)} AFTER A WIN`}
            </Label>
          </View>
        ) : null}

        {startable ? (
          <View>
            <Label size={11} style={paneStyles.fieldLabel}>
              THIS RUN
            </Label>
            <RankedToggle value={mode} onChange={setMode} />
            <Text style={paneStyles.helper}>
              {mode === 'ranked'
                ? 'Ranked. Every stage attempt moves your rank — including a revive.'
                : RANKED_NOTE.casual}
            </Text>
          </View>
        ) : null}

        {actionError ? (
          <Notice icon="warning" iconColor={colors.accent}>
            {actionError}
          </Notice>
        ) : null}

        {openRound ? <OpenRoundBlock openRound={openRound} onGoToRound={onGoToRound} /> : null}
      </ScrollView>

      <Dock style={paneStyles.dock}>
        {locked ? (
          <Button label="BACK TO COMPETE" variant="card" onPress={() => navigation.navigate('Compete')} />
        ) : state === 'active' ? (
          <>
            <View style={paneStyles.summary}>
              <Label size={11} color={colors.secondary} tracking={0.12}>
                {`STAGE ${view!.current_stage} OF ${STREAK_STAGES}`}
              </Label>
              <Label size={11} color={colors.secondary} tracking={0.12}>
                {`${fmtPoints(runStake * (view!.stakes_paid ?? 1))} ${UNIT} IN`}
              </Label>
            </View>
            <Button label="BACK TO YOUR RUN" onPress={resume} />
          </>
        ) : failed ? (
          <View style={styles.failedDock}>
            <Button
              label="NEW STREAK"
              variant="card"
              icon="refresh"
              onPress={() => setFresh(true)}
              style={styles.half}
            />
            <Button
              label={`REVIVE ${fmtPoints(runStake)}`}
              onPress={revive}
              loading={busy}
              disabled={openRound !== null || (balance !== null && balance < runStake)}
              style={styles.half}
            />
          </View>
        ) : (
          <>
            <View style={paneStyles.summary}>
              <Label size={11} color={colors.secondary} tracking={0.12}>
                {view ? `${fmtMultiplier(view.payout_bp)} FOR ALL THREE · STAKE ONCE` : 'SETTING YOUR STAGES'}
              </Label>
              <Label size={11} color={colors.secondary} tracking={0.12}>
                {`YOU HAVE ${balance === null ? '—' : fmtPoints(balance)}`}
              </Label>
            </View>
            <StakeDock
              stake={stake}
              onStake={setStake}
              balance={balance}
              cta="PLAY"
              onPress={start}
              loading={busy}
              disabled={!view || !affordable || openRound !== null}
            />
          </>
        )}
      </Dock>
    </View>
  );
}

const styles = StyleSheet.create({
  skeletons: { gap: 12 },
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
    fontFamily: 'Inter-SemiBold',
    fontSize: 15,
    color: colors.accent,
    includeFontPadding: false,
  },
  failedText: { flex: 1, gap: 6 },
  failedBody: { ...typography.small },
  windowRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  lockCard: {
    alignItems: 'center',
    gap: 6,
    paddingVertical: space.xl,
    paddingHorizontal: space.lg,
    borderRadius: radius.card,
    backgroundColor: colors.card,
  },
  lockHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  failedDock: { flexDirection: 'row', gap: space.sm + 2 },
  half: { flex: 1 },
});
