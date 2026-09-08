import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFitnessProfile } from '../hooks/useFitnessProfile';
import { compactPoints, fmtPoints } from '../lib/format';
import type { RootStackParamList } from '../navigation/types';
import type { ChallengeFormat, ChallengeType } from '../types/database';
import { TabBar } from '../components/TabBar';
import {
  EXERCISE_ICON,
  EXERCISE_LABEL,
  FORMAT_NAME,
  FORMAT_NOTE,
  GROUP_SIZES,
  STAKE_OPTIONS,
  UNIT,
  VERIFIABLE_TYPES,
} from '../theme/copy';
import { Icon } from '../theme/icons';
import { colors, fonts, label, radius, space, typography } from '../theme/tokens';
import {
  Button,
  Display,
  Dock,
  IconCircle,
  Label,
  Notice,
  Numeral,
  PageHead,
} from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'FindBout'>;

const TYPES: ChallengeType[] = ['pushups', 'plank', 'wallsit', 'race'];
const FORMATS: ChallengeFormat[] = ['1v1', 'pooled'];
/** In the design, not in the schema. Shown so the shape of the control matches. */
const LATER_FORMATS = ['Blitz', 'Bracket'];
/** A 1v1 is always two seats; only a Group Battle has a size to choose. */
const HEAD_TO_HEAD_SEATS = 2;
const DEFAULT_GROUP_SIZE = 4;

/**
 * One screen, four taps: exercise, format, stake, find. Nothing is written
 * here. The Searching screen owns the queue, so backing out of it never
 * leaves a half-made bout behind.
 */
export function FindBoutScreen({ navigation }: Props) {
  const { profile } = useFitnessProfile();
  const [type, setType] = useState<ChallengeType>('pushups');
  const [format, setFormat] = useState<ChallengeFormat>('1v1');
  const [groupSize, setGroupSize] = useState<number>(DEFAULT_GROUP_SIZE);
  const [stake, setStake] = useState<number>(250);

  const balance = profile?.points_balance ?? null;
  const affordable = (value: number) => balance === null || value <= balance;
  const verifiable = VERIFIABLE_TYPES.has(type);
  const canFind = verifiable && affordable(stake);

  const players = format === '1v1' ? HEAD_TO_HEAD_SEATS : groupSize;
  const sizeIndex = GROUP_SIZES.indexOf(groupSize);
  const atMin = sizeIndex <= 0;
  const atMax = sizeIndex >= GROUP_SIZES.length - 1;
  // Step by position in the list rather than by one, so the offered sizes
  // stay the single source of truth if they ever stop being contiguous.
  const stepGroup = (delta: number) => {
    const next = Math.min(GROUP_SIZES.length - 1, Math.max(0, sizeIndex + delta));
    setGroupSize(GROUP_SIZES[next]);
  };

  const find = () =>
    navigation.navigate('Searching', {
      exerciseType: type,
      format,
      maxParticipants: players,
      stake,
    });

  return (
    <View style={styles.screen}>
      <PageHead kicker="FIND A BOUT" title="CALL IT." />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View>
          <Label size={11} style={styles.fieldLabel}>
            EXERCISE
          </Label>
          <View style={styles.grid}>
            {TYPES.map(t => {
              const on = type === t;
              const soon = !VERIFIABLE_TYPES.has(t);
              const ink = on ? colors.onAccent : colors.text;
              return (
                <Pressable
                  key={t}
                  onPress={() => setType(t)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={({ pressed }) => [
                    styles.tile,
                    on && styles.tileOn,
                    pressed && !on && styles.tilePressed,
                  ]}
                >
                  <View style={styles.tileTop}>
                    <Icon name={EXERCISE_ICON[t]} size={18} color={ink} />
                    {soon ? (
                      <Text style={[styles.soon, on && styles.soonOn]}>SOON</Text>
                    ) : null}
                  </View>
                  <Display size={18} color={ink}>
                    {EXERCISE_LABEL[t]}
                  </Display>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View>
          <Label size={11} style={styles.fieldLabel}>
            FORMAT
          </Label>
          <View style={styles.segment}>
            {FORMATS.map(f => {
              const on = format === f;
              return (
                <Pressable
                  key={f}
                  onPress={() => setFormat(f)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={[styles.segOpt, on && styles.segOn]}
                >
                  <Text style={[styles.segText, on && styles.segTextOn]}>
                    {FORMAT_NAME[f]}
                  </Text>
                </Pressable>
              );
            })}
            {LATER_FORMATS.map(name => (
              <View key={name} style={styles.segOpt}>
                <Text style={[styles.segText, styles.segTextSoon]}>{name}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.helper}>{FORMAT_NOTE[format]}</Text>

          {format === 'pooled' ? (
            <View style={styles.stepper}>
              <Label size={11}>PLAYERS</Label>
              <View style={styles.stepperControls}>
                <IconCircle
                  icon="minus"
                  color={atMin ? colors.dim : colors.text}
                  onPress={atMin ? undefined : () => stepGroup(-1)}
                  accessibilityLabel="Fewer players"
                />
                <Numeral size={24} style={styles.stepperValue}>
                  {String(groupSize)}
                </Numeral>
                <IconCircle
                  icon="plus"
                  color={atMax ? colors.dim : colors.text}
                  onPress={atMax ? undefined : () => stepGroup(1)}
                  accessibilityLabel="More players"
                />
              </View>
            </View>
          ) : null}
        </View>

        <View>
          <View style={styles.stakeHead}>
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
                  <Numeral size={24} color={on ? colors.onAccent : colors.text}>
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

        {!verifiable ? (
          <Notice icon="clock" iconColor={colors.secondary}>
            Race needs the watch-verified pace that isn't wired yet. Push-ups,
            plank and wall-sit are on the card now.
          </Notice>
        ) : null}
      </ScrollView>

      <Dock style={styles.dock}>
        <View style={styles.summary}>
          <Label size={11} color={colors.secondary} tracking={0.12}>
            {`${EXERCISE_LABEL[type]} · ${FORMAT_NAME[format].toUpperCase()} · ${players} PLAYERS`}
          </Label>
          <Display size={22} color={colors.accent}>
            {`POT ${fmtPoints(stake * players)}`}
          </Display>
        </View>
        <Text style={styles.dockHelper}>
          You'll be matched live with fighters at your level. Nothing is staked
          until the bout is on.
        </Text>
        <Button label="FIND A BOUT" onPress={find} disabled={!canFind} />
      </Dock>
      <TabBar active="find" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: {
    paddingTop: 22,
    paddingHorizontal: space.gutter,
    paddingBottom: space.gutter,
    gap: space.xxl,
  },
  fieldLabel: { marginBottom: space.sm + 2 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile: {
    width: '48.5%',
    height: 72,
    borderRadius: radius.button,
    padding: 14,
    justifyContent: 'space-between',
    backgroundColor: colors.card,
  },
  tileOn: { backgroundColor: colors.text },
  tilePressed: { backgroundColor: colors.raised },
  tileTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  soon: { ...label(9, colors.dim, 0.12) },
  soonOn: { color: colors.onAccentFaint },

  segment: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: radius.control,
    padding: space.xs,
    gap: space.xs,
  },
  segOpt: {
    flex: 1,
    height: 40,
    borderRadius: radius.tile,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segOn: { backgroundColor: colors.raised },
  segText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    letterSpacing: 0.5,
    color: colors.secondary,
    includeFontPadding: false,
  },
  segTextOn: { color: colors.text },
  segTextSoon: { color: colors.dim },
  helper: { ...typography.helper, marginTop: space.sm },

  stepper: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: space.lg,
    paddingHorizontal: space.xs,
  },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  // Fixed width so the circles don't shift when the count changes digits.
  stepperValue: { minWidth: 28, textAlign: 'center' },

  stakeHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: space.sm + 2,
  },
  stakeRow: { flexDirection: 'row', gap: space.sm },
  stakeTile: {
    flex: 1,
    height: 60,
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
  dockHelper: {
    ...typography.helper,
    paddingHorizontal: space.xs,
    marginBottom: space.sm + 2,
  },
});
