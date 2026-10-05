import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { useFitnessProfile } from '../hooks/useFitnessProfile';
import { fmtPoints } from '../lib/format';
import {
  fmtPlace,
  pooledEnter,
  pooledErrorCopy,
  pooledFeatured,
  prizeFor,
} from '../lib/pooled';
import type { RootStackParamList } from '../navigation/types';
import type { PooledFeaturedRow } from '../types/database';
import {
  EXERCISE_ICON,
  EXERCISE_LABEL,
  EXERCISE_RULES,
  POOLED_KICKER,
  POOLED_RULE,
  SCORE_RULE,
  UNIT,
} from '../theme/copy';
import { Icon } from '../theme/icons';
import { colors, radius, space, typography } from '../theme/tokens';
import {
  Body,
  Button,
  Display,
  Dock,
  IconCircle,
  Label,
  Notice,
  Numeral,
  Skeleton,
  Slots,
  StatCard,
  TopBar,
} from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Pooled'>;

/**
 * The featured pooled competition in full: what it is, what is in the pot,
 * what each place pays, how many seats are taken, and the one button --
 * ENTER, which pays the fee and opens the camera right away, because an
 * entrant plays their round on entry and their score waits on the board.
 */
export function PooledScreen({ navigation }: Props) {
  const { profile } = useFitnessProfile();
  const [comp, setComp] = useState<PooledFeaturedRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await pooledFeatured();
    if (error) {
      setLoadError(pooledErrorCopy(error));
      return;
    }
    setLoadError(null);
    setComp(data);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const enter = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    const result = await pooledEnter();
    setBusy(false);
    if (result.error !== null) {
      setActionError(pooledErrorCopy(result.error));
      load();
      return;
    }
    // The fee is paid and the round is open: straight to the camera, and
    // `replace` so back does not offer to enter again.
    navigation.replace('MatchInProgress', { matchId: result.data.match_id });
  }, [navigation, load]);

  const balance = profile?.points_balance ?? null;

  if (loadError) {
    return (
      <View style={styles.screen}>
        <TopBar
          left={<IconCircle icon="arrow-left" accessibilityLabel="Back" onPress={() => navigation.goBack()} />}
        />
        <View style={styles.body}>
          <Display size={48}>NO POOL{'\n'}OPEN.</Display>
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

  const seatsLeft = comp ? Math.max(0, comp.max_entries - comp.entries) : 0;
  const affordable = comp ? balance === null || balance >= comp.entry_fee : false;

  let cta: React.ReactNode;
  if (!comp) {
    cta = <Button label="ENTER" disabled />;
  } else if (comp.entered && !comp.played) {
    cta = (
      <Button
        label="PLAY YOUR ROUND"
        icon="bolt"
        onPress={() => navigation.navigate('MatchInProgress', { matchId: comp.match_id })}
      />
    );
  } else if (comp.entered) {
    cta = (
      <Button
        label="SEE THE BOARD"
        variant="secondary"
        onPress={() => navigation.navigate('Results', { matchId: comp.match_id })}
      />
    );
  } else {
    cta = (
      <Button
        label={`ENTER · ${fmtPoints(comp.entry_fee)} ${UNIT}`}
        icon="bolt"
        onPress={enter}
        loading={busy}
        disabled={seatsLeft === 0 || !affordable}
      />
    );
  }

  return (
    <View style={styles.screen}>
      <TopBar
        left={<IconCircle icon="arrow-left" accessibilityLabel="Back" onPress={() => navigation.goBack()} />}
        right={
          comp ? (
            <View style={styles.headRight}>
              <Icon name={EXERCISE_ICON[comp.exercise_type]} size={16} color={colors.secondary} />
              <Label size={11}>{EXERCISE_LABEL[comp.exercise_type].toUpperCase()}</Label>
            </View>
          ) : null
        }
      />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View>
          <View style={styles.kicker}>
            <Icon name="crown" size={13} color={colors.accent} />
            <Label size={11} color={colors.accent} tracking={0.12}>
              {POOLED_KICKER}
            </Label>
          </View>
          {comp ? (
            <Display size={44} style={styles.title}>
              {comp.title}
            </Display>
          ) : (
            <Skeleton width={220} height={40} style={styles.title} />
          )}
          <Text style={styles.rules}>{comp ? comp.description : POOLED_RULE}</Text>
        </View>

        <View style={styles.grid}>
          <StatCard
            label="PRIZE POOL"
            value={comp ? fmtPoints(comp.pool_points) : '—'}
            unit={comp ? `OF ${fmtPoints(comp.max_pool_points)}` : undefined}
            accent
            size={34}
            style={styles.half}
          />
          <StatCard
            label="ENTRY FEE"
            value={comp ? fmtPoints(comp.entry_fee) : '—'}
            unit={UNIT}
            size={34}
            style={styles.half}
          />
        </View>

        {/* Seats. */}
        <View style={styles.card}>
          <View style={styles.seatsHead}>
            <Label>SEATS</Label>
            <Text style={styles.seatsText}>
              {comp ? comp.entries : '—'} <Text style={styles.seatsOf}>/ {comp ? comp.max_entries : '—'}</Text>
            </Text>
          </View>
          {comp ? <Slots filled={comp.entries} max={comp.max_entries} height={6} style={styles.slots} /> : null}
          <Text style={styles.cardNote}>
            {comp
              ? seatsLeft === 0
                ? comp.settled_at
                  ? 'Settled. Every score is in and the pot has been paid.'
                  : 'Full. It settles the moment the last score lands.'
                : `${seatsLeft} seat${seatsLeft === 1 ? '' : 's'} left. The pot is ranked and paid the moment the last entrant's score is in.`
              : ' '}
          </Text>
        </View>

        {/* The prize table, on the full pot. */}
        <View style={styles.card}>
          <Label>PRIZES · ON A FULL POT</Label>
          <View style={styles.prizes}>
            {(comp?.prize_shares_bp ?? [5000, 3000, 2000]).map((share, i) => (
              <View key={i} style={styles.prize}>
                <Label size={10} color={i === 0 ? colors.accent : colors.secondary} tracking={0.12}>
                  {fmtPlace(i + 1)}
                </Label>
                <View style={styles.prizeRow}>
                  <Numeral size={26} color={i === 0 ? colors.accent : colors.text}>
                    {comp ? fmtPoints(prizeFor(comp.max_pool_points, i + 1, comp.prize_shares_bp)) : '—'}
                  </Numeral>
                  <Label size={9} color={colors.dim} tracking={0.1}>
                    {`${Math.round(share / 100)}%`}
                  </Label>
                </View>
              </View>
            ))}
          </View>
          <Text style={styles.cardNote}>
            Everyone else gets nothing. Tied scores share the places they occupy.
          </Text>
        </View>

        <Notice icon="seal-check" iconColor={colors.accent}>
          {comp ? `${EXERCISE_RULES[comp.exercise_type]} ${SCORE_RULE}` : SCORE_RULE}
        </Notice>

        {actionError ? (
          <Notice icon="warning" iconColor={colors.accent}>
            {actionError}
          </Notice>
        ) : null}
      </ScrollView>

      <Dock style={styles.dock}>
        <View style={styles.summary}>
          <Label size={11} color={colors.secondary} tracking={0.12}>
            {comp ? `${EXERCISE_LABEL[comp.exercise_type].toUpperCase()} · POOLED · CASUAL` : ' '}
          </Label>
          <Label size={11} color={colors.secondary} tracking={0.12}>
            {`YOU HAVE ${balance === null ? '—' : fmtPoints(balance)}`}
          </Label>
        </View>
        <Text style={styles.dockHelper}>
          {comp?.entered
            ? comp.played
              ? 'Your score is on the board. This screen updates as seats fill.'
              : 'Your seat is paid for. The round is yours to play now.'
            : 'Entering pays the fee and opens the camera right away. Your score waits on the board.'}
        </Text>
        {cta}
      </Dock>
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
    gap: space.xl,
  },
  body: { flex: 1, paddingTop: space.xxl, paddingHorizontal: space.xxl },
  detail: { marginTop: space.lg },
  kicker: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { marginTop: space.sm },
  rules: { ...typography.bodyMuted, marginTop: space.md },
  grid: { flexDirection: 'row', gap: space.sm },
  half: { flex: 1 },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: space.lg,
  },
  seatsHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  seatsText: { ...typography.rowTitle, fontSize: 22 },
  seatsOf: { color: colors.dim },
  slots: { marginTop: space.md },
  cardNote: { ...typography.helper, marginTop: space.md },
  prizes: { flexDirection: 'row', gap: space.md, marginTop: space.md },
  prize: { flex: 1, gap: 4 },
  prizeRow: { flexDirection: 'row', alignItems: 'baseline', gap: 5 },
  dock: { paddingBottom: space.md },
  summary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: space.xs,
    paddingBottom: space.sm,
  },
  dockHelper: {
    ...typography.helper,
    paddingHorizontal: space.xs,
    marginBottom: space.sm + 2,
  },
});
