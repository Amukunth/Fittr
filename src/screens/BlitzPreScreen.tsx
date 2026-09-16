import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFitnessProfile } from '../hooks/useFitnessProfile';
import { compactPoints, fmtPoints } from '../lib/format';
import {
  blitzPreview,
  blitzStart,
  blitzTiersOf,
  fmtMultiplier,
  fmtTarget,
  payoutFor,
  soloErrorCopy,
  type BlitzTier,
} from '../lib/soloModes';
import { RANK_TIER_LABEL, rankTierOf } from '../lib/skillRating';
import type { RootStackParamList } from '../navigation/types';
import type { BlitzPreviewRow, RankedMode } from '../types/database';
import {
  BLITZ_RULES,
  EXERCISE_ICON,
  EXERCISE_LABEL,
  RANKED_NOTE,
  SOLO_CALIBRATION_NOTE,
  SOLO_CALIBRATION_ROUGH,
  STAKE_OPTIONS,
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

type Props = NativeStackScreenProps<RootStackParamList, 'BlitzPre'>;

/**
 * Blitz set-up. The whole reason this screen exists rather than starting the
 * moment Blitz is picked: the fighter has to see the three bars BEFORE they
 * agree to the stake. A solo wager against an unseen threshold is not a
 * wager, it is a surprise.
 *
 * Nothing is written until START. blitz_preview() reads no rows it could
 * change, so re-mounting this screen or switching the stake costs nothing.
 */
export function BlitzPreScreen({ route, navigation }: Props) {
  const { exerciseType } = route.params;
  const { profile } = useFitnessProfile();

  const [preview, setPreview] = useState<BlitzPreviewRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stake, setStake] = useState<number>(STAKE_OPTIONS[1] ?? 100);
  // Casual on every mount, and this screen is pushed fresh each time, so the
  // mode is never carried over from the last attempt. See RankedToggle.
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

  const balance = profile?.points_balance ?? null;
  const affordable = (value: number) => balance === null || value <= balance;

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
    // backing up to a set-up screen that would let it be staked again is not
    // a state that should exist.
    navigation.replace('MatchInProgress', { matchId: result.data.match_id });
  }, [exerciseType, stake, mode, navigation]);

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
          <Display size={48}>NO BARS{'\n'}TO CLEAR.</Display>
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

  const tiers = preview ? blitzTiersOf(preview) : null;

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
          <Label size={11}>SOLO · BLITZ</Label>
          <Display size={44} style={styles.title}>
            BEAT{'\n'}YOUR BAR.
          </Display>
          <Text style={styles.rules}>{BLITZ_RULES}</Text>
        </View>

        {/* The ladder, and the reason this screen exists. */}
        <View>
          <View style={styles.sectionHead}>
            <Label size={11}>YOUR TARGETS</Label>
            {preview ? (
              <Label size={11} tracking={0.08}>
                {preview.placement_complete
                  ? `${RANK_TIER_LABEL[rankTierOf(preview.mmr)].toUpperCase()} · ${preview.mmr} MMR`
                  : 'UNRANKED · PROVISIONAL'}
              </Label>
            ) : null}
          </View>
          {tiers ? (
            <View style={styles.ladder}>
              {tiers.map(tier => (
                <TierRow
                  key={tier.tier}
                  tier={tier}
                  stake={stake}
                  exerciseType={exerciseType}
                />
              ))}
            </View>
          ) : (
            <View style={styles.ladder}>
              {[0, 1, 2].map(i => (
                <View key={i} style={styles.tierRow}>
                  <Skeleton width={72} height={30} />
                  <Skeleton width={110} height={16} />
                </View>
              ))}
            </View>
          )}
          <Text style={styles.helper}>
            {preview && !preview.calibrated_to_me
              ? SOLO_CALIBRATION_ROUGH
              : SOLO_CALIBRATION_NOTE}
          </Text>
        </View>

        <View>
          <View style={styles.sectionHead}>
            <Label size={11}>STAKE</Label>
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

        {/* The switch, at the point of starting — not in a settings screen. */}
        <View>
          <Label size={11} style={styles.fieldLabel}>
            THIS ATTEMPT
          </Label>
          <RankedToggle value={mode} onChange={setMode} />
          <Text style={styles.helper}>{RANKED_NOTE[mode]}</Text>
        </View>

        {startError ? (
          <Notice icon="warning" iconColor={colors.accent}>
            {startError}
          </Notice>
        ) : null}
      </ScrollView>

      <Dock style={styles.dock}>
        <View style={styles.summary}>
          <Label size={11} color={colors.secondary} tracking={0.12}>
            {tiers
              ? `CLEAR ${fmtTarget(tiers[0]!.target, exerciseType)} TO PAY`
              : 'SETTING YOUR TARGETS'}
          </Label>
          <Display size={22} color={colors.accent}>
            {tiers
              ? `UP TO ${fmtPoints(payoutFor(stake, tiers[2]!.bp))}`
              : '—'}
          </Display>
        </View>
        <Button
          label={`STAKE ${fmtPoints(stake)} · GO`}
          onPress={start}
          loading={starting}
          disabled={!preview || !affordable(stake)}
        />
      </Dock>
    </View>
  );
}

/**
 * One rung: the target, big, with what it pays beside it. The target leads
 * because it is the thing that has to be done; the multiplier is the reward
 * for having done it.
 */
function TierRow({
  tier,
  stake,
  exerciseType,
}: {
  tier: BlitzTier;
  stake: number;
  exerciseType: Props['route']['params']['exerciseType'];
}) {
  // The top rung wears the accent: it is the one worth wanting.
  const top = tier.tier === 3;
  return (
    <View style={[styles.tierRow, top && styles.tierRowTop]}>
      <View style={styles.tierLeft}>
        <Numeral size={30} color={top ? colors.accent : colors.text}>
          {fmtTarget(tier.target, exerciseType)}
        </Numeral>
        <Label size={10} color={colors.dim} tracking={0.12}>
          {exerciseType === 'pushups' ? 'REPS' : 'HOLD'}
        </Label>
      </View>
      <View style={styles.tierRight}>
        <Display size={24} color={top ? colors.accent : colors.text}>
          {fmtMultiplier(tier.bp)}
        </Display>
        <Label size={10} color={colors.secondary} tracking={0.1}>
          {`${fmtPoints(payoutFor(stake, tier.bp))} ${UNIT}`}
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

  ladder: { gap: space.sm },
  tierRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    height: 64,
    paddingHorizontal: space.cardPad,
    borderRadius: radius.control,
    backgroundColor: colors.card,
  },
  tierRowTop: {
    borderWidth: 1,
    borderColor: colors.accentOutline,
    backgroundColor: colors.accentTint,
  },
  tierLeft: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  tierRight: { alignItems: 'flex-end', gap: 2 },

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

  dock: { paddingBottom: space.md },
  summary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: space.xs,
    paddingBottom: space.sm + 2,
  },
});
