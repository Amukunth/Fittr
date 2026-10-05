import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { channelName, supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useFitnessProfile } from '../hooks/useFitnessProfile';
import { useBoutHistory } from '../hooks/useBoutHistory';
import type { BoutSummary } from '../lib/boutStats';
import { compactPoints, fmtPoints } from '../lib/format';
import { initialsOf, ownHandle } from '../lib/identity';
import { pooledErrorCopy, pooledFeatured } from '../lib/pooled';
import type { RootStackParamList } from '../navigation/types';
import type { ChallengeType, PooledFeaturedRow } from '../types/database';
import { TabBar } from '../components/TabBar';
import {
  EXERCISE_DESC,
  EXERCISE_ICON,
  EXERCISE_LABEL,
  FORMAT_LABEL,
  POOLED_KICKER,
  UNIT,
  VERIFIABLE_TYPES,
} from '../theme/copy';
import { Icon } from '../theme/icons';
import { colors, label, radius, space, typography } from '../theme/tokens';
import {
  Avatar,
  Body,
  Display,
  Label,
  LiveDot,
  Numeral,
  Skeleton,
  Slots,
  Tag,
} from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Compete'>;

const TYPES: ChallengeType[] = ['pushups', 'plank', 'wallsit', 'race'];

/**
 * The first tab. Top to bottom: the featured pooled competition, the
 * fighter's own open rounds (the one thing that can block everything else
 * and must stay reachable), and the exercise grid that leads to each
 * exercise's 1v1 / Blitz / Streak screen.
 *
 * Replaces both the old Bouts screen (its "in the ring" list lives here;
 * its "recent" list already lives on Profile) and the old Find screen (the
 * exercise pick is the grid; the mode and stake pick moved to the exercise's
 * own screen).
 */
export function CompeteScreen({ navigation }: Props) {
  const { session } = useAuth();
  const { profile } = useFitnessProfile();
  const { stats, loading, error, refresh } = useBoutHistory();
  const insets = useSafeAreaInsets();
  const [featured, setFeatured] = useState<PooledFeaturedRow | null>(null);
  const [featuredError, setFeaturedError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadFeatured = useCallback(async () => {
    const { data, error: rpcError } = await pooledFeatured();
    if (rpcError) {
      setFeaturedError(pooledErrorCopy(rpcError));
      return;
    }
    setFeaturedError(null);
    setFeatured(data);
  }, []);

  // Re-pull whenever the screen regains focus (back from a bout, the
  // camera, or Results). Kept alongside the realtime subscription below: it
  // re-syncs after the socket has been down, which is exactly when live
  // events were missed rather than merely late.
  useFocusEffect(
    useCallback(() => {
      refresh();
      loadFeatured();
    }, [refresh, loadFeatured]),
  );

  const active = useMemo(() => stats?.active ?? [], [stats]);

  const activeKey = useMemo(
    () =>
      active
        .map(b => b.challengeId)
        .sort()
        .join(','),
    [active],
  );

  // Settlement flips challenges.status, and `challenges` is in the realtime
  // publication, so a bout the fighter is waiting on leaves this list the
  // moment it settles. See BACKEND.md, "Realtime".
  useEffect(() => {
    if (!activeKey) {
      return;
    }
    const channel = supabase
      .channel(channelName('compete-in-the-ring'))
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'challenges',
          filter: `id=in.(${activeKey})`,
        },
        () => {
          refresh();
          loadFeatured();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeKey, refresh, loadFeatured]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refresh(), loadFeatured()]);
    setRefreshing(false);
  }, [refresh, loadFeatured]);

  const myHandle = ownHandle(session);
  const headerPad = { paddingTop: insets.top + space.xl };

  let kicker: React.ReactNode;
  if (loading) {
    kicker = <Skeleton width={120} height={13} />;
  } else if (active.length > 0) {
    kicker = (
      <>
        <LiveDot />
        <Label size={11}>{`${active.length} IN THE RING · LIVE`}</Label>
      </>
    );
  } else {
    kicker = <Label size={11}>PICK YOUR FIGHT</Label>;
  }

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
            colors={[colors.accent]}
            progressBackgroundColor={colors.raised}
          />
        }
      >
        <View style={[styles.header, headerPad]}>
          <View>
            <View style={styles.liveRow}>{kicker}</View>
            <Display size={40} style={styles.title}>
              COMPETE
            </Display>
          </View>
          <Pressable
            onPress={() => navigation.navigate('Profile')}
            accessibilityRole="button"
            accessibilityLabel="Your profile and balance"
            style={({ pressed }) => [styles.balancePill, pressed && styles.pressed]}
          >
            <Avatar initials={initialsOf(myHandle)} size={26} />
            <Numeral size={17} color={colors.accent}>
              {profile ? compactPoints(profile.points_balance) : '—'}
            </Numeral>
            <Label size={10} tracking={0.1}>
              {UNIT}
            </Label>
          </Pressable>
        </View>

        {/* The featured pooled competition. */}
        <View style={styles.section}>
          {featured ? (
            <FeaturedCard
              competition={featured}
              onPress={() => navigation.navigate('Pooled')}
            />
          ) : featuredError ? (
            <View style={styles.featuredError}>
              <Icon name="warning" size={16} color={colors.secondary} />
              <Text style={styles.featuredErrorText}>{featuredError}</Text>
            </View>
          ) : (
            <View style={styles.featuredSkeleton}>
              <Skeleton width={110} height={12} />
              <Skeleton width={200} height={28} style={styles.skelGap} />
              <Skeleton width="100%" height={40} style={styles.skelGap} />
              <Skeleton width="100%" height={4} style={styles.skelGap} />
            </View>
          )}
        </View>

        {/* Open rounds: the one thing that blocks every other mode. */}
        {active.length > 0 ? (
          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Label>IN THE RING</Label>
            </View>
            <View style={styles.cards}>
              {active.map(b => (
                <ActiveCard
                  key={b.matchId}
                  bout={b}
                  onPress={() =>
                    b.myScore === null
                      ? navigation.navigate('MatchInProgress', { matchId: b.matchId })
                      : navigation.navigate('Results', { matchId: b.matchId })
                  }
                />
              ))}
            </View>
          </View>
        ) : null}

        {error ? (
          <View style={styles.section}>
            <View style={styles.featuredError}>
              <Icon name="signal-off" size={16} color={colors.secondary} />
              <Text style={styles.featuredErrorText}>{error}</Text>
            </View>
          </View>
        ) : null}

        {/* The exercises. Each leads to its own 1v1 / Blitz / Streak screen. */}
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Label>EXERCISES</Label>
            <Label color={colors.dim}>1V1 · BLITZ · STREAK</Label>
          </View>
          <View style={styles.grid}>
            {TYPES.map(t => {
              const soon = !VERIFIABLE_TYPES.has(t);
              return (
                <Pressable
                  key={t}
                  disabled={soon}
                  onPress={() => navigation.navigate('ExerciseModes', { exerciseType: t })}
                  accessibilityRole="button"
                  accessibilityLabel={`${EXERCISE_LABEL[t]}${soon ? ', coming soon' : ''}`}
                  style={({ pressed }) => [
                    styles.tile,
                    pressed && styles.tilePressed,
                    soon && styles.tileSoon,
                  ]}
                >
                  <View style={styles.tileTop}>
                    <View style={styles.tileIcon}>
                      <Icon name={EXERCISE_ICON[t]} size={18} color={soon ? colors.dim : colors.accent} />
                    </View>
                    {soon ? <Text style={styles.soon}>SOON</Text> : <Icon name="caret-right" size={14} color={colors.dim} />}
                  </View>
                  <View>
                    <Display size={22} color={soon ? colors.secondary : colors.text}>
                      {EXERCISE_LABEL[t]}
                    </Display>
                    <Text style={styles.tileDesc} numberOfLines={2}>
                      {EXERCISE_DESC[t]}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      </ScrollView>
      <TabBar active="compete" />
    </View>
  );
}

/**
 * The featured pooled competition: title, the pot as it stands, the fee,
 * the description, and how many of the seats are taken. One tap goes to the
 * full screen with the entry button; the card itself does not stake.
 */
function FeaturedCard({
  competition,
  onPress,
}: {
  competition: PooledFeaturedRow;
  onPress: () => void;
}) {
  const c = competition;
  const seatsLeft = Math.max(0, c.max_entries - c.entries);
  const status = c.entered
    ? c.played
      ? seatsLeft > 0
        ? `YOU'RE IN · ${seatsLeft} SEAT${seatsLeft === 1 ? '' : 'S'} TO FILL`
        : "YOU'RE IN · SETTLING"
      : "YOU'RE IN · PLAY YOUR ROUND"
    : seatsLeft > 0
      ? `ENTER · ${fmtPoints(c.entry_fee)} ${UNIT}`
      : 'FULL';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${c.title}, prize pool ${fmtPoints(c.pool_points)} ${UNIT}, ${c.entries} of ${c.max_entries} seats filled`}
      style={({ pressed }) => [styles.featured, pressed && styles.featuredPressed]}
    >
      <View style={styles.featuredHead}>
        <View style={styles.featuredKicker}>
          <Icon name="crown" size={13} color={colors.accent} />
          <Label size={11} color={colors.accent} tracking={0.12}>
            {POOLED_KICKER}
          </Label>
        </View>
        <Tag label={EXERCISE_LABEL[c.exercise_type].toUpperCase()} />
      </View>
      <Display size={30} style={styles.featuredTitle}>
        {c.title}
      </Display>
      <View style={styles.featuredStats}>
        <View style={styles.featuredStat}>
          <Label>PRIZE POOL</Label>
          <View style={styles.statRow}>
            <Numeral size={34} color={colors.accent}>
              {fmtPoints(c.pool_points)}
            </Numeral>
            <Label size={10} color={colors.secondary} tracking={0.1}>
              {`OF ${fmtPoints(c.max_pool_points)}`}
            </Label>
          </View>
        </View>
        <View style={styles.featuredStat}>
          <Label>ENTRY</Label>
          <View style={styles.statRow}>
            <Numeral size={34}>{fmtPoints(c.entry_fee)}</Numeral>
            <Label size={10} color={colors.secondary} tracking={0.1}>
              {UNIT}
            </Label>
          </View>
        </View>
      </View>
      <Body muted style={styles.featuredDesc}>
        {c.description}
      </Body>
      <View style={styles.seatsRow}>
        <Label size={10} tracking={0.12}>
          {`${c.entries} OF ${c.max_entries} SEATS FILLED`}
        </Label>
        <Label size={10} color={colors.accent} tracking={0.12}>
          {status}
        </Label>
      </View>
      <Slots filled={c.entries} max={c.max_entries} style={styles.slots} />
    </Pressable>
  );
}

/** An unsettled bout: what it is, what is on it, and whose move it is. */
function ActiveCard({
  bout,
  onPress,
}: {
  bout: BoutSummary;
  onPress: () => void;
}) {
  const yourTurn = bout.myScore === null;
  const waitingOn = bout.opponents.filter(o => o.score === null).length;
  const status = yourTurn
    ? 'YOUR ROUND IS OPEN'
    : bout.solo
      ? 'SETTLING'
      : bout.format === 'pooled'
        ? `ON THE BOARD · ${bout.seats - 1 - waitingOn} OF ${bout.seats - 1} OTHERS IN`
        : `WAITING ON ${waitingOn} OF ${bout.seats - 1}`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${EXERCISE_LABEL[bout.type]}, ${fmtPoints(bout.stake)} ${UNIT}. ${status}`}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.cardTop}>
        <Display size={24}>{EXERCISE_LABEL[bout.type]}</Display>
        <View style={styles.formatRow}>
          <Tag label={FORMAT_LABEL[bout.format]} tone={bout.solo ? 'accent' : 'raised'} />
          {bout.seats > 2 ? (
            <Label size={10} color={colors.secondary} tracking={0.12}>
              {`· ${bout.seats} SEATS`}
            </Label>
          ) : bout.solo ? (
            <Label size={10} color={colors.secondary} tracking={0.12}>
              · SOLO
            </Label>
          ) : null}
        </View>
      </View>
      <View style={styles.cardFoot}>
        <View style={styles.stakeRow}>
          <Numeral size={24}>{fmtPoints(bout.stake)}</Numeral>
          <Label size={10} color={colors.secondary} tracking={0.1}>
            {UNIT} IN
          </Label>
        </View>
        <Label
          size={11}
          color={yourTurn ? colors.accent : colors.secondary}
          tracking={0.1}
          style={styles.status}
        >
          {status}
        </Label>
        <Icon name="caret-right" size={14} color={colors.dim} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { flexGrow: 1, paddingBottom: space.gutter },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: space.gutter,
  },
  liveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 13,
  },
  title: { marginTop: space.sm },
  balancePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.card,
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingLeft: 6,
    paddingRight: space.md,
  },
  pressed: { opacity: 0.7 },

  section: { marginTop: space.xxl, paddingHorizontal: space.gutter },
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: space.xs,
    paddingBottom: space.sm + 2,
  },
  cards: { gap: space.md },

  featured: {
    backgroundColor: colors.card,
    borderRadius: radius.hero,
    padding: space.xl,
    borderWidth: 1,
    borderColor: colors.accentOutline,
  },
  featuredPressed: { backgroundColor: colors.cardPressed },
  featuredHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  featuredKicker: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  featuredTitle: { marginTop: space.md },
  featuredStats: { flexDirection: 'row', gap: space.xl, marginTop: space.lg },
  featuredStat: { gap: 4 },
  statRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  featuredDesc: { marginTop: space.md },
  seatsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: space.lg,
  },
  slots: { marginTop: space.sm },
  featuredSkeleton: {
    backgroundColor: colors.card,
    borderRadius: radius.hero,
    padding: space.xl,
  },
  skelGap: { marginTop: space.md },
  featuredError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: space.lg,
  },
  featuredErrorText: { ...typography.small, flex: 1 },

  card: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: space.cardPad,
    gap: space.md,
  },
  cardPressed: { backgroundColor: colors.cardPressed },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  formatRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  stakeRow: { flexDirection: 'row', alignItems: 'baseline', gap: 5 },
  cardFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  status: { flex: 1, textAlign: 'right' },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile: {
    width: '48.5%',
    minHeight: 132,
    borderRadius: radius.card,
    padding: 14,
    justifyContent: 'space-between',
    gap: space.md,
    backgroundColor: colors.card,
  },
  tilePressed: { backgroundColor: colors.cardPressed },
  tileSoon: { opacity: 0.6 },
  tileTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  tileIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.raised,
  },
  tileDesc: { ...typography.helper, marginTop: 4 },
  soon: { ...label(9, colors.dim, 0.12) },
});
