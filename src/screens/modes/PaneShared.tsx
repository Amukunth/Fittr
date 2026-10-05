import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { BoutSummary } from '../../lib/boutStats';
import { fmtPoints } from '../../lib/format';
import type { RootStackParamList } from '../../navigation/types';
import type { ChallengeType } from '../../types/database';
import { EXERCISE_LABEL, STAKE_OPTIONS, UNIT } from '../../theme/copy';
import { colors, label, radius, space, typography } from '../../theme/tokens';
import { Button, Label, Notice, Numeral, StakeStepper } from '../../theme/ui';

/**
 * What every pane on the exercise screen receives, and the pieces they
 * share: the "WIN" display, the stake-plus-play dock, and the open-round
 * block.
 */
export interface PaneProps {
  exerciseType: ChallengeType;
  navigation: NativeStackNavigationProp<RootStackParamList, 'ExerciseModes'>;
  /** null while the profile is loading: every stake is offered. */
  balance: number | null;
  /** A bout the fighter has not played yet, which blocks starting anything. */
  openRound: BoutSummary | null;
  onGoToRound: () => void;
}

/** The first affordable preset, highest first, or the lowest if none are. */
export function defaultStake(balance: number | null): number {
  const preferred = STAKE_OPTIONS[1] ?? STAKE_OPTIONS[0] ?? 100;
  if (balance === null || preferred <= balance) {
    return preferred;
  }
  const affordable = STAKE_OPTIONS.filter(s => s <= balance);
  return affordable.length ? affordable[affordable.length - 1]! : STAKE_OPTIONS[0] ?? 50;
}

/**
 * The reference's "WIN $1" block: a small label, a rule, and the payout,
 * big. `sub` is the line under it that says what the number is.
 */
export function WinDisplay({
  label: title = 'WIN',
  amount,
  sub,
  accent,
}: {
  label?: string;
  amount: number | null;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <View style={styles.win}>
      <Label size={12} color={colors.text} tracking={0.2}>
        {title}
      </Label>
      <View style={styles.winRule} />
      <View style={styles.winRow}>
        <Numeral size={72} color={accent ? colors.accent : colors.text}>
          {amount === null ? '—' : fmtPoints(amount)}
        </Numeral>
        <Label size={12} color={colors.secondary} tracking={0.16}>
          {UNIT}
        </Label>
      </View>
      {sub ? <Text style={styles.winSub}>{sub}</Text> : null}
    </View>
  );
}

/**
 * The bottom strip from the reference: the stake control on the left, the
 * play button on the right. One primary per screen, and it is this one.
 */
export function StakeDock({
  stake,
  onStake,
  balance,
  cta,
  onPress,
  disabled,
  loading,
}: {
  stake: number;
  onStake: (next: number) => void;
  balance: number | null;
  cta: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <View style={styles.dockRow}>
      <StakeStepper
        value={stake}
        options={STAKE_OPTIONS}
        onChange={onStake}
        balance={balance}
        unit={UNIT}
        style={styles.stepper}
      />
      <Button
        label={cta}
        icon="bolt"
        onPress={onPress}
        disabled={disabled}
        loading={loading}
        style={styles.play}
      />
    </View>
  );
}

/** The block every pane shows when a round is still open elsewhere. */
export function OpenRoundBlock({
  openRound,
  onGoToRound,
}: {
  openRound: BoutSummary;
  onGoToRound: () => void;
}) {
  return (
    <View style={styles.blocked}>
      <Notice icon="warning" iconColor={colors.accent}>
        {`You've got a ${EXERCISE_LABEL[openRound.type]} round waiting. Finish it before you start another — your stake is already in.`}
      </Notice>
      <Button label="GO TO YOUR ROUND" variant="card" onPress={onGoToRound} />
    </View>
  );
}

export const paneStyles = StyleSheet.create({
  pane: { flex: 1 },
  content: {
    paddingTop: space.sm,
    paddingHorizontal: space.gutter,
    paddingBottom: space.gutter,
    gap: space.xl,
  },
  note: { ...typography.helper },
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: space.sm + 2,
  },
  helper: { ...typography.helper, marginTop: space.sm },
  fieldLabel: { marginBottom: space.sm + 2 },
  dock: { paddingBottom: space.md, gap: space.sm + 2 },
  summary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: space.xs,
  },
  statCard: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: space.lg,
    gap: 4,
  },
  statRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  rankLabel: { ...label(11, colors.dim, 0.08) },
});

const styles = StyleSheet.create({
  win: { alignItems: 'center', paddingVertical: space.lg, gap: space.sm },
  winRule: { width: 28, height: 3, borderRadius: 2, backgroundColor: colors.handle },
  winRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  winSub: { ...typography.helper, textAlign: 'center' },
  dockRow: { flexDirection: 'row', gap: space.sm + 2 },
  stepper: { flex: 1.15 },
  play: { flex: 1 },
  blocked: { gap: space.sm },
});
