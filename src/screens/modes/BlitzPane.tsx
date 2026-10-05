import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { PayoutCurve } from '../../components/PayoutCurve';
import { fmtPoints } from '../../lib/format';
import { fmtQuality, fmtScore, rawUnit } from '../../lib/score';
import { RANK_TIER_LABEL, rankTierOf } from '../../lib/skillRating';
import {
  blitzPreview,
  blitzStart,
  fmtMultiplier,
  payoutFor,
  soloErrorCopy,
} from '../../lib/soloModes';
import type { BlitzPreviewRow, RankedMode } from '../../types/database';
import {
  BLITZ_RULES,
  RANKED_NOTE,
  SOLO_CALIBRATION_NOTE,
  SOLO_CALIBRATION_ROUGH,
  UNIT,
} from '../../theme/copy';
import { colors, space } from '../../theme/tokens';
import {
  Body,
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
  defaultStake,
  paneStyles,
  type PaneProps,
} from './PaneShared';

/**
 * The Blitz tab: the payout curve, the max payout for the stake on the
 * stepper, the ranked switch, and PLAY. Nothing is written until PLAY;
 * blitz_preview() reads no rows it could change, so switching the stake
 * costs nothing.
 *
 * WHERE THE REFERENCE DOES NOT MAP: the reference's curve is a smooth sweep
 * with checkpoints at 2x and 2.5x. Fittr's payout is linear from break-even
 * at the threshold to 2.5x at the benchmark and zero below the threshold,
 * so the graph draws exactly that (see PayoutCurve). The shape is a
 * documented tunable, not a design choice made here.
 */
export function BlitzPane({
  exerciseType,
  navigation,
  balance,
  openRound,
  onGoToRound,
}: PaneProps) {
  const [preview, setPreview] = useState<BlitzPreviewRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stake, setStake] = useState<number>(() => defaultStake(balance));
  const [mode, setMode] = useState<RankedMode>('casual');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await blitzPreview(exerciseType);
      if (cancelled) {
        return;
      }
      if (error) {
        setLoadError(soloErrorCopy(error));
        return;
      }
      setPreview(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [exerciseType]);

  const affordable = balance === null || stake <= balance;

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    const result = await blitzStart(exerciseType, stake, mode);
    if (result.error !== null) {
      setStarting(false);
      setStartError(soloErrorCopy(result.error));
      return;
    }
    // `replace`, not `navigate`: the stake is gone and the round is open, so
    // backing up to a screen that would let it be staked again is not a
    // state that should exist.
    navigation.replace('MatchInProgress', { matchId: result.data.match_id });
  }, [exerciseType, stake, mode, navigation]);

  const maxPayout = preview ? payoutFor(stake, preview.max_bp) : null;

  return (
    <View style={paneStyles.pane}>
      <ScrollView
        contentContainerStyle={paneStyles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={paneStyles.note}>{BLITZ_RULES}</Text>

        {loadError ? (
          <View>
            <Body muted>{loadError}</Body>
          </View>
        ) : null}

        {/* The max payout stat, beside the graph. */}
        <View style={styles.topRow}>
          <View style={[paneStyles.statCard, styles.maxCard]}>
            <Label>MAX PAYOUT</Label>
            <View style={paneStyles.statRow}>
              <Numeral size={40} color={colors.accent}>
                {maxPayout === null ? '—' : fmtPoints(maxPayout)}
              </Numeral>
              <Label size={10} color={colors.secondary} tracking={0.1}>
                {UNIT}
              </Label>
            </View>
            <Text style={paneStyles.rankLabel}>
              {preview ? `${fmtMultiplier(preview.max_bp)} AT ${fmtScore(preview.benchmark_score)}` : ' '}
            </Text>
          </View>
          <View style={[paneStyles.statCard, styles.barCard]}>
            <Label>BREAK EVEN</Label>
            <View style={paneStyles.statRow}>
              <Numeral size={28}>{preview ? fmtScore(preview.threshold_score) : '—'}</Numeral>
            </View>
            <Text style={paneStyles.rankLabel}>
              {preview
                ? `≈ ${preview.threshold_raw} ${rawUnit(exerciseType)} AT ${fmtQuality(preview.reference_quality_bp)} FORM`
                : ' '}
            </Text>
          </View>
        </View>

        <View>
          <View style={paneStyles.sectionHead}>
            <Label size={11}>PAYOUT BY SCORE</Label>
            {preview ? (
              <Label size={11} tracking={0.08}>
                {preview.placement_complete
                  ? `${RANK_TIER_LABEL[rankTierOf(preview.mmr)].toUpperCase()} · ${preview.mmr} MMR`
                  : 'UNRANKED · PROVISIONAL'}
              </Label>
            ) : null}
          </View>
          {preview ? (
            <PayoutCurve
              threshold={preview.threshold_score}
              benchmark={preview.benchmark_score}
              breakevenBp={preview.breakeven_bp}
              maxBp={preview.max_bp}
              height={300}
            />
          ) : (
            <Skeleton width="100%" height={300} radius={16} />
          )}
          <Text style={paneStyles.helper}>
            {preview && !preview.calibrated_to_me ? SOLO_CALIBRATION_ROUGH : SOLO_CALIBRATION_NOTE}
          </Text>
        </View>

        <View>
          <Label size={11} style={paneStyles.fieldLabel}>
            THIS ATTEMPT
          </Label>
          <RankedToggle value={mode} onChange={setMode} />
          <Text style={paneStyles.helper}>{RANKED_NOTE[mode]}</Text>
        </View>

        {startError ? (
          <Notice icon="warning" iconColor={colors.accent}>
            {startError}
          </Notice>
        ) : null}

        {openRound ? <OpenRoundBlock openRound={openRound} onGoToRound={onGoToRound} /> : null}
      </ScrollView>

      <Dock style={paneStyles.dock}>
        <View style={paneStyles.summary}>
          <Label size={11} color={colors.secondary} tracking={0.12}>
            {preview ? `MATCH ${fmtScore(preview.threshold_score)} TO BREAK EVEN` : 'SETTING YOUR BAR'}
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
          loading={starting}
          disabled={!preview || !affordable || openRound !== null}
        />
      </Dock>
    </View>
  );
}

const styles = StyleSheet.create({
  topRow: { flexDirection: 'row', gap: space.sm },
  maxCard: { flex: 1.2 },
  barCard: { flex: 1 },
});
