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
import {
  compactPoints,
  fmtPoints,
  fmtSigned,
  relativeDay,
} from '../lib/format';
import { initialsOf, ownHandle, peerHandle } from '../lib/identity';
import type { RootStackParamList } from '../navigation/types';
import { TabBar } from '../components/TabBar';
import { EXERCISE_LABEL, FORMAT_LABEL, UNIT } from '../theme/copy';
import { Icon } from '../theme/icons';
import { colors, radius, space, typography } from '../theme/tokens';
import {
  Avatar,
  Body,
  Button,
  Card,
  Display,
  EmptyRing,
  Label,
  LiveDot,
  Numeral,
  Skeleton,
  Tag,
} from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

/** Settled results shown under RECENT; the full record lives on Profile. */
const RECENT_LIMIT = 6;

export function HomeScreen({ navigation }: Props) {
  const { session } = useAuth();
  const { profile } = useFitnessProfile();
  const { stats, loading, error, refresh } = useBoutHistory();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Re-pull whenever the screen regains focus (back from Searching, the
  // camera, or Results). Still worth keeping alongside the realtime
  // subscription below: it re-syncs after the socket has been down
  // (backgrounded app, lost network), which is exactly when live events were
  // missed rather than merely late.
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const active = useMemo(() => stats?.active ?? [], [stats]);
  const recent = useMemo(
    () =>
      (stats?.bouts ?? [])
        .filter(b => b.outcome !== 'pending')
        .slice(0, RECENT_LIMIT),
    [stats],
  );

  // The live bouts as one sorted string. Sorted so the same set arriving in a
  // different order after a refetch does not tear the channel down and
  // rebuild it for nothing; a string so the effect below can key on it.
  const activeKey = useMemo(
    () =>
      active
        .map(b => b.challengeId)
        .sort()
        .join(','),
    [active],
  );

  // Settlement flips challenges.status to completed / needs_review, and
  // `challenges` is already in the realtime publication — so this picks up
  // the moment a bout the user is waiting on settles, with no extra
  // migration: the card leaves IN THE RING and its result lands in RECENT
  // without a pull. `matches` and `match_participants` are not published
  // (no user column to filter on; see BACKEND.md), so an opponent's round
  // landing is only seen once it settles the bout. Only the user's own live
  // bouts matter here, hence the id filter rather than the whole table, and
  // the effect is keyed on that id set: a new bout or a settled one rebuilds
  // the channel, and with nothing live there is nothing to listen for.
  useEffect(() => {
    if (!activeKey) {
      return;
    }
    const channel = supabase
      .channel(channelName('home-in-the-ring'))
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
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeKey, refresh]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const onRetry = useCallback(async () => {
    setRetrying(true);
    await refresh();
    setRetrying(false);
  }, [refresh]);

  const myHandle = ownHandle(session);
  const myInitials = initialsOf(myHandle);
  const headerPad = { paddingTop: insets.top + space.xl };
  const hasBouts = Boolean(stats && stats.bouts.length > 0);

  let kicker: React.ReactNode;
  if (loading) {
    // A placeholder rather than "NOTHING LIVE" that flips a beat later.
    kicker = <Skeleton width={120} height={13} />;
  } else if (active.length > 0) {
    kicker = (
      <>
        <LiveDot />
        <Label size={11}>{`${active.length} IN THE RING · LIVE`}</Label>
      </>
    );
  } else {
    kicker = <Label size={11}>NOTHING LIVE</Label>;
  }

  let feed: React.ReactNode;
  if (loading || retrying) {
    feed = <SkeletonFeed />;
  } else if (error) {
    feed = <ErrorBlock message={error} onRetry={onRetry} />;
  } else if (!hasBouts) {
    feed = <EmptyBlock />;
  } else {
    feed = (
      <>
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
                    // No score yet means the round is theirs to fight; once
                    // it is in, the only thing left to see is the board.
                    b.myScore === null
                      ? navigation.navigate('MatchInProgress', {
                          matchId: b.matchId,
                        })
                      : navigation.navigate('Results', { matchId: b.matchId })
                  }
                />
              ))}
            </View>
          </View>
        ) : null}

        {recent.length > 0 ? (
          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Label>RECENT</Label>
            </View>
            <View>
              {recent.map(b => (
                <RecentRow
                  key={b.matchId}
                  bout={b}
                  onPress={() =>
                    navigation.navigate('Results', { matchId: b.matchId })
                  }
                />
              ))}
            </View>
          </View>
        ) : null}
      </>
    );
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
              BOUTS
            </Display>
          </View>
          <Pressable
            onPress={() => navigation.navigate('Profile')}
            accessibilityRole="button"
            accessibilityLabel="Your profile and balance"
            style={({ pressed }) => [styles.balancePill, pressed && styles.pressed]}
          >
            <Avatar initials={myInitials} size={26} />
            <Numeral size={17} color={colors.accent}>
              {profile ? compactPoints(profile.points_balance) : '—'}
            </Numeral>
            <Label size={10} tracking={0.1}>
              {UNIT}
            </Label>
          </Pressable>
        </View>

        {/* The one primary CTA on this screen (lime budget: one per screen). */}
        <Card radius={radius.hero} pad={space.xl} style={styles.hero}>
          <Label size={11}>LIVE MATCHMAKING</Label>
          <Display size={32} style={styles.heroTitle}>
            FIND A BOUT.
          </Display>
          <Body muted style={styles.heroBody}>
            Pick the exercise and the stake. We pair you with a fighter at your
            level the moment one is there.
          </Body>
          <Button
            label="FIND A BOUT"
            onPress={() => navigation.navigate('FindBout')}
            style={styles.heroButton}
          />
        </Card>

        {feed}
      </ScrollView>
      <TabBar active="home" />
    </View>
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
    : `WAITING ON ${waitingOn} OF ${bout.seats - 1}`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${EXERCISE_LABEL[bout.type]}, ${fmtPoints(
        bout.stake,
      )} ${UNIT}. ${status}`}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.cardTop}>
        <Display size={26}>{EXERCISE_LABEL[bout.type]}</Display>
        <View style={styles.formatRow}>
          <Tag label={FORMAT_LABEL[bout.format]} />
          {bout.seats > 2 ? (
            <Label size={10} color={colors.secondary} tracking={0.12}>
              {`· ${bout.seats} PLAYERS`}
            </Label>
          ) : null}
        </View>
      </View>
      <View>
        <Label>STAKE</Label>
        <View style={styles.stakeRow}>
          <Numeral size={36}>{fmtPoints(bout.stake)}</Numeral>
          <Label size={11} color={colors.secondary} tracking={0.1}>
            {UNIT}
          </Label>
        </View>
      </View>
      <View style={styles.cardFoot}>
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

/** One settled result. Same row as Profile's RECENT BOUTS, made tappable. */
function RecentRow({
  bout,
  onPress,
}: {
  bout: BoutSummary;
  onPress: () => void;
}) {
  const letter =
    bout.outcome === 'win'
      ? 'W'
      : bout.outcome === 'loss'
        ? 'L'
        : bout.outcome === 'tie'
          ? 'T'
          : bout.outcome === 'review'
            ? '?'
            : '·';
  const won = bout.outcome === 'win';
  // A Group Battle has up to five opponents; naming the first would
  // misdescribe the bout, so it is counted instead.
  const versus =
    bout.seats > 2
      ? `${bout.seats - 1} others`
      : bout.opponentId
        ? peerHandle(bout.opponentId)
        : 'open seat';
  const when = relativeDay(bout.createdAt);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${EXERCISE_LABEL[bout.type]} vs ${versus}, ${when}, ${fmtSigned(
        bout.delta,
      )} ${UNIT}`}
      style={({ pressed }) => [styles.recent, pressed && styles.pressed]}
    >
      <View
        style={[
          styles.recentTile,
          won ? styles.recentTileWin : styles.recentTileOther,
        ]}
      >
        <Display size={15} color={won ? colors.accent : colors.secondary}>
          {letter}
        </Display>
      </View>
      <View style={styles.recentText}>
        <Text style={typography.rowTitle}>
          {EXERCISE_LABEL[bout.type]} <Text style={styles.vs}>vs</Text> {versus}
        </Text>
        <Text style={styles.when}>{when}</Text>
      </View>
      <Numeral size={20} color={won ? colors.accent : colors.secondary}>
        {fmtSigned(bout.delta)}
      </Numeral>
    </Pressable>
  );
}

function SkeletonFeed() {
  return (
    <>
      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Skeleton width={90} height={12} />
        </View>
        <View style={styles.skeletonCard}>
          <View style={styles.cardTop}>
            <Skeleton width={120} height={22} />
            <Skeleton width={44} height={22} />
          </View>
          <Skeleton width={80} height={34} />
          <Skeleton width={160} height={14} />
        </View>
      </View>
      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Skeleton width={60} height={12} />
        </View>
        {[0, 1, 2].map(i => (
          <View key={i} style={styles.recent}>
            <Skeleton width={30} height={30} radius={8} />
            <View style={styles.recentText}>
              <Skeleton width={140} height={14} />
              <Skeleton width={60} height={11} style={styles.skeletonWhen} />
            </View>
            <Skeleton width={48} height={20} />
          </View>
        ))}
      </View>
    </>
  );
}

function ErrorBlock({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const offline = /network|fetch|offline|timeout|socket/i.test(message);
  return (
    <View style={styles.block}>
      <View style={styles.blockTile}>
        <Icon name="signal-off" size={28} color={colors.secondary} />
      </View>
      <Display size={44} style={styles.blockHead}>
        {offline ? "YOU'RE\nOFFLINE." : "COULDN'T LOAD\nTHE CARD."}
      </Display>
      <Body muted style={styles.blockBody}>
        {offline
          ? "The card needs a signal. Anything you finished is saved and settles when you're back."
          : message}
      </Body>
      <Button
        label="RETRY"
        variant="secondary"
        icon="refresh"
        onPress={onRetry}
        style={styles.blockButton}
      />
    </View>
  );
}

/** No bouts at all. No button: the hero above already carries the CTA. */
function EmptyBlock() {
  return (
    <View style={styles.block}>
      <EmptyRing />
      <Display size={44} style={styles.blockHead}>
        {'NO FIGHTS\nON THE CARD.'}
      </Display>
      <Body muted style={styles.blockBody}>
        Your record starts with your first bout.
      </Body>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  // flexGrow so the error / empty block can centre itself in whatever is
  // left under the hero on a tall screen, while still scrolling on a short one.
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

  hero: { marginTop: space.xl, marginHorizontal: space.gutter },
  heroTitle: { marginTop: space.sm },
  heroBody: { marginTop: space.md },
  heroButton: { marginTop: space.xl },

  section: { marginTop: space.xxl, paddingHorizontal: space.gutter },
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: space.xs,
    paddingBottom: space.sm + 2,
  },
  cards: { gap: space.md },

  card: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: space.cardPad,
    gap: 14,
  },
  cardPressed: { backgroundColor: colors.cardPressed },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  formatRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  stakeRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 5,
    marginTop: space.xs,
  },
  cardFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  status: { flex: 1 },

  recent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  recentTile: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recentTileWin: { backgroundColor: colors.accentTint },
  recentTileOther: { backgroundColor: colors.raised },
  recentText: { flex: 1 },
  vs: { color: colors.dim },
  when: { ...typography.footnote, marginTop: 2 },

  skeletonCard: {
    height: 168,
    borderRadius: radius.card,
    backgroundColor: colors.card,
    padding: space.cardPad,
    justifyContent: 'space-between',
  },
  skeletonWhen: { marginTop: 6 },

  block: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingHorizontal: space.xxl,
    paddingVertical: 40,
  },
  blockTile: {
    width: 64,
    height: 64,
    borderRadius: 18,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  blockHead: { marginTop: 28 },
  blockBody: { marginTop: space.md },
  blockButton: { marginTop: 28, alignSelf: 'flex-start', paddingHorizontal: 28 },
});
