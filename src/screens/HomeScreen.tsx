import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
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
import { compactPoints, fmtPoints } from '../lib/format';
import { initialsOf, ownHandle, peerHandle } from '../lib/identity';
import type { RootStackParamList } from '../navigation/types';
import type {
  ChallengeRow,
  ChallengeType,
  StrengthTier,
} from '../types/database';
import { TabBar } from '../components/TabBar';
import { EXERCISE_LABEL, FORMAT_LABEL, SEATS, UNIT } from '../theme/copy';
import { Icon } from '../theme/icons';
import { colors, fonts, radius, space } from '../theme/tokens';
import {
  Avatar,
  Body,
  Button,
  Chip,
  Display,
  EmptyRing,
  Label,
  LiveDot,
  Meta,
  Numeral,
  Skeleton,
  Slots,
  Tag,
  TierPill,
} from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

type Filter = 'all' | ChallengeType;

const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pushups', label: 'Push-ups' },
  { key: 'plank', label: 'Plank' },
  { key: 'wallsit', label: 'Wall-sit' },
  { key: 'race', label: 'Race' },
];

export function HomeScreen({ navigation }: Props) {
  const { session } = useAuth();
  const { profile } = useFitnessProfile();
  const insets = useSafeAreaInsets();
  const [challenges, setChallenges] = useState<ChallengeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    setError(null);
    const { data, error: queryError } = await supabase
      .from('challenges')
      .select('*')
      .eq('status', 'open')
      .order('created_at', { ascending: false });

    if (queryError) {
      setError(queryError.message);
    } else {
      setChallenges((data ?? []) as ChallengeRow[]);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Re-pull whenever the screen regains focus (e.g. after creating a
  // challenge or backing out of a match). Still worth keeping alongside the
  // realtime subscription below: it re-syncs after the socket has been down
  // (backgrounded app, lost network), which is exactly when live events were
  // missed rather than merely late.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // This list is `status = 'open'`, and join_challenge() flips challenges to
  // 'matched' out from under it — so without this a card stays tappable after
  // someone else has already taken it, and Accept fails with "challenge is
  // not open". Unfiltered by design: Home shows the whole open marketplace,
  // so every challenge row is relevant here.
  useEffect(() => {
    const channel = supabase
      .channel(channelName('home-open-challenges'))
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'challenges' },
        payload => {
          const row = payload.new as ChallengeRow;
          if (row.status !== 'open') {
            return;
          }
          setChallenges(prev =>
            // Guard against the echo of our own insert arriving after the
            // post-create focus refetch has already added it.
            prev.some(c => c.id === row.id) ? prev : [row, ...prev],
          );
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'challenges' },
        payload => {
          const row = payload.new as ChallengeRow;
          setChallenges(prev =>
            row.status === 'open'
              ? prev.map(c => (c.id === row.id ? row : c))
              : prev.filter(c => c.id !== row.id),
          );
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const visible = useMemo(
    () =>
      filter === 'all' ? challenges : challenges.filter(c => c.type === filter),
    [challenges, filter],
  );

  const me = session?.user.id ?? null;
  const myHandle = ownHandle(session);
  const myInitials = initialsOf(myHandle);
  const myTier = profile?.strength_tier ?? null;
  const headerPad = { paddingTop: insets.top + space.xl };

  let feed: React.ReactNode;
  if (loading) {
    feed = <SkeletonFeed />;
  } else if (error) {
    feed = (
      <ErrorBlock
        message={error}
        onRetry={() => {
          setLoading(true);
          load();
        }}
      />
    );
  } else if (visible.length === 0) {
    feed = (
      <EmptyBlock
        filtered={filter !== 'all' && challenges.length > 0}
        onPost={() => navigation.navigate('CreateChallenge')}
      />
    );
  } else {
    feed = (
      <FlatList
        data={visible}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={colors.accent}
            colors={[colors.accent]}
            progressBackgroundColor={colors.raised}
          />
        }
        renderItem={({ item }) => (
          <BoutCard
            challenge={item}
            own={item.created_by === me}
            myInitials={myInitials}
            myTier={myTier}
            onPress={() =>
              navigation.navigate('ChallengeDetail', { challengeId: item.id })
            }
          />
        )}
      />
    );
  }

  return (
    <View style={styles.screen}>
      <View style={[styles.header, headerPad]}>
        <View>
          <View style={styles.liveRow}>
            <LiveDot />
            <Label size={11}>{`${visible.length} OPEN · LIVE`}</Label>
          </View>
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

      {!loading && !error ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chips}
          contentContainerStyle={styles.chipsContent}
        >
          {FILTERS.map(f => (
            <Chip
              key={f.key}
              label={f.label}
              active={filter === f.key}
              onPress={() => setFilter(f.key)}
            />
          ))}
        </ScrollView>
      ) : null}

      <View style={styles.feed}>{feed}</View>
      <TabBar active="home" />
    </View>
  );
}

function BoutCard({
  challenge,
  own,
  myInitials,
  myTier,
  onPress,
}: {
  challenge: ChallengeRow;
  own: boolean;
  myInitials: string;
  myTier: StrengthTier | null;
  onPress: () => void;
}) {
  const handle = own ? 'you' : peerHandle(challenge.created_by);
  const filled = challenge.status === 'open' ? 1 : SEATS;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.cardTop}>
        <Display size={26}>{EXERCISE_LABEL[challenge.type]}</Display>
        <Tag label={FORMAT_LABEL[challenge.format]} />
      </View>
      <View style={styles.cardMid}>
        <View>
          <Label>STAKE</Label>
          <View style={styles.stakeRow}>
            <Numeral size={36}>{fmtPoints(challenge.stake_points)}</Numeral>
            <Label size={11} color={colors.secondary} tracking={0.1}>
              {UNIT}
            </Label>
          </View>
        </View>
        <View style={styles.spots}>
          <Label>SPOTS CLAIMED</Label>
          <Text style={styles.spotsText}>
            {filled} <Text style={styles.spotsOf}>of</Text> {SEATS}
          </Text>
          <Slots filled={filled} max={SEATS} style={styles.slots} />
        </View>
      </View>
      <View style={styles.cardFoot}>
        <Avatar
          initials={own ? myInitials : initialsOf(handle)}
          size={26}
          tone={own ? 'accent' : 'raised'}
        />
        <Meta style={styles.handle}>{handle}</Meta>
        {own && myTier ? <TierPill tier={myTier} style={styles.tier} /> : null}
      </View>
    </Pressable>
  );
}

function SkeletonFeed() {
  return (
    <View style={styles.skeletonWrap}>
      <View style={styles.skeletonChips}>
        <Skeleton width={52} height={34} radius={radius.pill} />
        <Skeleton width={90} height={34} radius={radius.pill} />
        <Skeleton width={70} height={34} radius={radius.pill} />
      </View>
      <View style={styles.listContent}>
        {[0, 1, 2].map(i => (
          <View key={i} style={styles.skeletonCard}>
            <View style={styles.cardTop}>
              <Skeleton width={120} height={22} />
              <Skeleton width={44} height={22} />
            </View>
            <Skeleton width={80} height={34} />
            <Skeleton width={160} height={14} />
          </View>
        ))}
      </View>
    </View>
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
          ? "The feed needs a signal. Anything you finished is saved and settles when you're back."
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

function EmptyBlock({
  filtered,
  onPost,
}: {
  filtered: boolean;
  onPost: () => void;
}) {
  return (
    <View style={styles.block}>
      <EmptyRing />
      <Display size={44} style={styles.blockHead}>
        {filtered ? 'NOTHING IN\nTHIS CLASS.' : "NOBODY'S\nCALLING YOU OUT."}
      </Display>
      <Body muted style={styles.blockBody}>
        {filtered
          ? 'No open bouts for that exercise. Try another or post one.'
          : 'No open bouts right now. Post one and somebody will answer.'}
      </Body>
      <Button label="POST A BOUT" onPress={onPost} style={styles.blockButton} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: space.gutter,
  },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
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
  chips: { flexGrow: 0, marginTop: space.cardPad },
  chipsContent: { paddingHorizontal: space.gutter, gap: space.sm },
  feed: { flex: 1 },
  listContent: {
    paddingTop: 14,
    paddingHorizontal: space.gutter,
    paddingBottom: space.gutter,
    gap: space.md,
  },

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
  cardMid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  stakeRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 5,
    marginTop: space.xs,
  },
  spots: { alignItems: 'flex-end' },
  spotsText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.text,
    marginTop: 6,
    includeFontPadding: false,
  },
  spotsOf: { color: colors.dim },
  slots: { width: 112, marginTop: space.sm },
  cardFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  handle: { color: colors.secondary, flex: 1 },
  tier: { marginLeft: 'auto' },

  skeletonWrap: { flex: 1 },
  skeletonChips: {
    flexDirection: 'row',
    gap: space.sm,
    paddingTop: space.cardPad,
    paddingHorizontal: space.gutter,
  },
  skeletonCard: {
    height: 168,
    borderRadius: radius.card,
    backgroundColor: colors.card,
    padding: space.cardPad,
    justifyContent: 'space-between',
  },

  block: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingHorizontal: space.xxl,
    paddingBottom: 40,
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
