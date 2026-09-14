import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useLeagueTiers } from '../hooks/useLeagueTiers';
import {
  invalidateLeaderboard,
  useLeaderboard,
  type LeaderboardScope,
} from '../hooks/useLeaderboard';
import { useRankHistory } from '../hooks/useRankHistory';
import { useRankStanding } from '../hooks/useRankStanding';
import { fmtPoints, relativeDay } from '../lib/format';
import { handleFor, initialsOf, ownHandle } from '../lib/identity';
import {
  LEAGUE_COLOR,
  LEAGUE_LABEL,
  fmtWager,
  leagueIndex,
  leagueProgress,
  placeColor,
  rankEventCopy,
  standingOf,
  thresholdsFrom,
  winRate,
} from '../lib/league';
import { markLeagueSeen } from '../lib/rankBadge';
import type { RootStackParamList } from '../navigation/types';
import type {
  LeaderboardRow,
  LeagueTier,
  LeagueTierRow,
  RankHistoryRow,
} from '../types/database';
import { Celebration } from '../components/Celebration';
import { LeagueBadge } from '../components/LeagueBadge';
import { ProgressRing } from '../components/ProgressRing';
import { TabBar } from '../components/TabBar';
import { REAL_MONEY_NOTICE } from '../theme/copy';
import { Icon } from '../theme/icons';
import {
  alpha,
  colors,
  fonts,
  label as labelStyle,
  radius,
  space,
  typography,
} from '../theme/tokens';
import {
  Avatar,
  Button,
  Card,
  Chip,
  Display,
  Divider,
  Label,
  Notice,
  Numeral,
  SectionHead,
  Skeleton,
  Small,
  StatCard,
} from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Rank'>;

/** How close to the bottom the scroll gets before the next page is asked for. */
const LOAD_MORE_SLACK = 640;

export function RankScreen({ navigation }: Props) {
  const { session } = useAuth();
  const insets = useSafeAreaInsets();

  const { standing, loading, error, refresh, event, clearEvent } = useRankStanding();
  const { tiers } = useLeagueTiers();
  const {
    events: history,
    loading: historyLoading,
    refresh: refreshHistory,
  } = useRankHistory();

  const [scope, setScope] = useState<LeaderboardScope>('global');
  const board = useLeaderboard(scope);

  const [locked, setLocked] = useState<LeagueTierRow | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const trophies = standing?.trophies ?? 0;
  const league = standing?.current_league ?? 'bronze';

  // The thresholds the server actually holds, falling back to the mirrored
  // constants for the first paint.
  const thresholds = useMemo(() => thresholdsFrom(tiers), [tiers]);
  const progress = useMemo(
    () => leagueProgress(trophies, thresholds),
    [trophies, thresholds],
  );

  // A bout settled on the other fighter's phone while this one was on Bouts
  // or Find: the standing and the timeline both move without this screen
  // being told, so both are re-read on the way in.
  useFocusEffect(
    useCallback(() => {
      refresh();
      refreshHistory();
    }, [refresh, refreshHistory]),
  );

  // The tab badge's rank-up dot is "since you last looked at this screen",
  // and this is looking at it.
  useEffect(() => {
    const userId = session?.user.id;
    if (userId && standing) {
      markLeagueSeen(userId, standing.current_league);
    }
  }, [session, standing]);

  // Trophies landed while the screen was open. The timeline gains a row and
  // every board the fighter is on has moved, so the cached pages are stale.
  const liveKey = event?.key ?? null;
  useEffect(() => {
    if (liveKey === null) {
      return;
    }
    refreshHistory();
    invalidateLeaderboard();
    board.refresh();
    // board.refresh is recreated per render; keying on the event is what
    // makes this run once per change rather than once per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    invalidateLeaderboard();
    await Promise.all([refresh(), refreshHistory(), board.refresh()]);
    setRefreshing(false);
  }, [board, refresh, refreshHistory]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const fromBottom =
        contentSize.height - (contentOffset.y + layoutMeasurement.height);
      if (fromBottom < LOAD_MORE_SLACK) {
        board.loadMore();
      }
    },
    [board],
  );

  const pad = { paddingTop: insets.top + space.lg };

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.content, pad]}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={64}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.secondary}
            colors={[colors.accent]}
            progressBackgroundColor={colors.card}
          />
        }
      >
        {loading && !standing ? (
          <HeroSkeleton />
        ) : (
          <Hero
            league={league}
            trophies={trophies}
            progress={progress}
            globalRank={standing?.global_rank ?? null}
          />
        )}

        {error ? <Notice icon="warning">{error}</Notice> : null}

        <Stats standing={standing} loading={loading && !standing} />

        <Rewards
          tiers={tiers}
          current={league}
          trophies={trophies}
          onLockedPress={setLocked}
        />

        <Leaderboard
          board={board}
          scope={scope}
          onScope={setScope}
          session={session}
        />

        <History
          events={history}
          loading={historyLoading && history.length === 0}
          session={session}
          onFindBout={() => navigation.navigate('FindBout')}
        />
      </ScrollView>

      <TabBar active="rank" />

      <LockedSheet
        tier={locked}
        trophies={trophies}
        onClose={() => setLocked(null)}
      />

      {/* Only a gain is celebrated. A fighter who has just lost trophies does
          not need confetti about it; the timeline says what happened. */}
      {event && event.delta > 0 ? (
        <Celebration
          eventKey={event.key}
          delta={event.delta}
          league={event.league}
          promoted={event.promoted}
          onDone={clearEvent}
        />
      ) : null}
    </View>
  );
}

// ── Hero ────────────────────────────────────────────────────────────────

function Hero({
  league,
  trophies,
  progress,
  globalRank,
}: {
  league: LeagueTier;
  trophies: number;
  progress: ReturnType<typeof leagueProgress>;
  globalRank: number | null;
}) {
  const color = LEAGUE_COLOR[league];
  const maxRank = progress.next === null;
  // The bar fills in the colour of the league being climbed to, not the one
  // already held: the point of the bar is the thing not yet earned.
  const fillColor = progress.next ? LEAGUE_COLOR[progress.next] : color;

  return (
    <View style={styles.hero}>
      <LeagueBadge tier={league} size={136} animated />

      <Display size={46} color={color} style={styles.heroName}>
        {LEAGUE_LABEL[league]}
      </Display>

      <View
        style={styles.heroTrophies}
        accessibilityLabel={`${trophies} trophies`}
      >
        <Icon name="trophy" size={18} color={colors.secondary} />
        <Numeral size={26}>{fmtPoints(trophies)}</Numeral>
        <Label size={11} color={colors.secondary} tracking={0.16}>
          TROPHIES
        </Label>
      </View>

      {maxRank ? (
        <MaxRank color={color} />
      ) : (
        <View style={styles.heroProgress}>
          <View
            style={styles.track}
            accessibilityRole="progressbar"
            accessibilityLabel={`Progress to ${LEAGUE_LABEL[progress.next!]}`}
            accessibilityValue={{
              min: 0,
              max: progress.target,
              now: trophies,
              text: `${trophies} of ${progress.target} trophies to ${
                LEAGUE_LABEL[progress.next!]
              }`,
            }}
          >
            <View
              style={[
                styles.fill,
                {
                  width: `${Math.round(progress.fraction * 100)}%`,
                  backgroundColor: fillColor,
                },
              ]}
            />
          </View>
          <View style={styles.heroProgressText}>
            <Label size={11} color={colors.secondary} tracking={0.1}>
              {`${fmtPoints(trophies)} / ${fmtPoints(progress.target)} TO ${LEAGUE_LABEL[
                progress.next!
              ].toUpperCase()}`}
            </Label>
            <Label size={11} color={fillColor} tracking={0.1}>
              {`${fmtPoints(progress.remaining)} TO GO`}
            </Label>
          </View>
        </View>
      )}

      {globalRank !== null ? (
        <View
          style={styles.rankPill}
          accessibilityLabel={`Ranked number ${globalRank} globally`}
        >
          <Label size={10} color={colors.secondary} tracking={0.12}>
            {`RANK #${fmtPoints(globalRank)} GLOBALLY`}
          </Label>
        </View>
      ) : null}
    </View>
  );
}

/**
 * What replaces the progress bar at the top of the ladder. A shimmer
 * travelling across the words rather than a bar at 100%: a full bar reads
 * as "nearly there", which is the opposite of what this means.
 */
function MaxRank({ color }: { color: string }) {
  const sweep = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, {
          toValue: 1,
          duration: 1600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(900),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [sweep]);

  return (
    <View style={[styles.maxRank, { borderColor: alpha(color, 0.45) }]}>
      <Animated.View
        style={[
          styles.maxShimmer,
          {
            backgroundColor: alpha(color, 0.3),
            transform: [
              { rotate: '18deg' },
              {
                translateX: sweep.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-180, 180],
                }),
              },
            ],
          },
        ]}
      />
      <Icon name="crown" size={15} color={color} />
      <Label size={11} color={color} tracking={0.2}>
        MAX RANK
      </Label>
    </View>
  );
}

function HeroSkeleton() {
  return (
    <View style={styles.hero}>
      <Skeleton width={136} height={136} radius={68} />
      <Skeleton width={150} height={40} style={styles.heroName} />
      <Skeleton width={120} height={18} style={styles.skeletonGap} />
      <Skeleton width="100%" height={8} radius={4} style={styles.skeletonBar} />
      <Skeleton width={150} height={12} style={styles.skeletonGap} />
    </View>
  );
}

// ── Stats ───────────────────────────────────────────────────────────────

function Stats({
  standing,
  loading,
}: {
  standing: { total_wins: number; total_losses: number; total_ties: number; current_streak: number } | null;
  loading: boolean;
}) {
  const rate = standing
    ? winRate(standing.total_wins, standing.total_losses, standing.total_ties)
    : null;

  return (
    <View>
      <SectionHead>RECORD</SectionHead>

      {loading ? (
        <StatsSkeleton />
      ) : (
        <>
          <View style={styles.statRow}>
            <StatCard
              label="WINS"
              value={String(standing?.total_wins ?? 0)}
              size={34}
              accent
              style={styles.statCell}
            />
            <StatCard
              label="LOSSES"
              value={String(standing?.total_losses ?? 0)}
              size={34}
              style={styles.statCell}
            />
            <StatCard
              label="STREAK"
              value={String(standing?.current_streak ?? 0)}
              size={34}
              style={styles.statCell}
            />
          </View>

          <Card style={styles.rateCard}>
            <ProgressRing
              progress={(rate ?? 0) / 100}
              size={92}
              thickness={8}
              color={colors.accent}
            >
              <Numeral size={26}>{rate === null ? '—' : `${rate}`}</Numeral>
              {rate === null ? null : (
                <Label size={9} color={colors.dim} tracking={0.14}>
                  PERCENT
                </Label>
              )}
            </ProgressRing>
            <View style={styles.rateText}>
              <Label>WIN RATE</Label>
              <Display size={22} style={styles.rateHead}>
                {rate === null ? 'NO BOUTS YET' : `${rate}% OF THE CARD`}
              </Display>
              <Text style={styles.rateNote}>
                {rate === null
                  ? 'Your rate starts the second your first bout settles.'
                  : `${standing?.total_wins ?? 0}W · ${standing?.total_losses ?? 0}L${
                      standing && standing.total_ties > 0
                        ? ` · ${standing.total_ties}T`
                        : ''
                    } across every exercise.`}
              </Text>
            </View>
          </Card>
        </>
      )}
    </View>
  );
}

function StatsSkeleton() {
  return (
    <>
      <View style={styles.statRow}>
        {[0, 1, 2].map(i => (
          <Card key={i} pad={space.lg} style={styles.statCell}>
            <Skeleton width={44} height={10} />
            <Skeleton width={52} height={30} style={styles.skeletonGap} />
          </Card>
        ))}
      </View>
      <Card style={styles.rateCard}>
        <Skeleton width={92} height={92} radius={46} />
        <View style={styles.rateText}>
          <Skeleton width={70} height={10} />
          <Skeleton width={170} height={22} style={styles.skeletonGap} />
          <Skeleton width={130} height={12} style={styles.skeletonGap} />
        </View>
      </Card>
    </>
  );
}

// ── League rewards ──────────────────────────────────────────────────────

function Rewards({
  tiers,
  current,
  trophies,
  onLockedPress,
}: {
  tiers: LeagueTierRow[];
  current: LeagueTier;
  trophies: number;
  onLockedPress: (tier: LeagueTierRow) => void;
}) {
  const ordered = useMemo(
    () => [...tiers].sort((a, b) => leagueIndex(a.name) - leagueIndex(b.name)),
    [tiers],
  );

  return (
    <View>
      <SectionHead>LEAGUE REWARDS</SectionHead>
      {ordered.length === 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.tierRow}>
            {[0, 1, 2].map(i => (
              <Card key={i} style={styles.tierCard}>
                <Skeleton width={56} height={56} radius={28} />
                <Skeleton width={80} height={22} style={styles.skeletonGap} />
                <Skeleton width={96} height={12} style={styles.skeletonGap} />
              </Card>
            ))}
          </View>
        </ScrollView>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tierRow}
        >
          {ordered.map(tier => (
            <TierCard
              key={tier.id}
              tier={tier}
              state={standingOf(tier.name, current)}
              trophies={trophies}
              onPress={onLockedPress}
            />
          ))}
        </ScrollView>
      )}
      <Text style={styles.helper}>{REAL_MONEY_NOTICE}</Text>
    </View>
  );
}

function TierCard({
  tier,
  state,
  trophies,
  onPress,
}: {
  tier: LeagueTierRow;
  state: ReturnType<typeof standingOf>;
  trophies: number;
  onPress: (tier: LeagueTierRow) => void;
}) {
  const color = LEAGUE_COLOR[tier.name];
  const isLocked = state === 'locked';
  const name = LEAGUE_LABEL[tier.name];

  const status =
    state === 'current'
      ? `You are in ${name}`
      : state === 'completed'
        ? `${name}, completed`
        : `${name}, locked. ${Math.max(tier.min_trophies - trophies, 0)} more trophies needed`;

  const card: ViewStyle = {
    borderWidth: 1,
    borderColor: state === 'current' ? color : colors.border,
    backgroundColor: state === 'current' ? alpha(color, 0.07) : colors.card,
  };

  return (
    <Pressable
      onPress={isLocked ? () => onPress(tier) : undefined}
      disabled={!isLocked}
      accessibilityRole={isLocked ? 'button' : undefined}
      accessibilityLabel={status}
      style={({ pressed }) => [
        styles.tierCard,
        card,
        pressed && isLocked && styles.tierCardPressed,
      ]}
    >
      <View style={isLocked ? styles.tierDim : undefined}>
        <LeagueBadge tier={tier.name} size={56} locked={isLocked} />
      </View>

      <Display
        size={20}
        color={isLocked ? colors.secondary : color}
        style={styles.tierName}
      >
        {name}
      </Display>

      <View style={styles.tierFacts}>
        <View style={styles.tierFact}>
          <Icon name="trophy" size={12} color={colors.dim} />
          <Text style={styles.tierFactText}>
            {tier.min_trophies === 0
              ? 'From the first bout'
              : `${fmtPoints(tier.min_trophies)} trophies`}
          </Text>
        </View>
        <View style={styles.tierFact}>
          <Icon name="wallet" size={12} color={colors.dim} />
          <Text style={styles.tierFactText}>
            {`${fmtWager(tier.max_wager_cents)} max wager`}
          </Text>
        </View>
      </View>

      {state === 'current' ? (
        <View style={[styles.tierPill, { backgroundColor: alpha(color, 0.16) }]}>
          <Text style={labelStyle(9, color, 0.14)}>CURRENT</Text>
        </View>
      ) : state === 'completed' ? (
        <View style={[styles.tierPill, styles.tierPillDone]}>
          <Icon name="check" size={10} color={colors.accent} />
          <Text style={labelStyle(9, colors.accent, 0.14)}>COMPLETED</Text>
        </View>
      ) : (
        <View style={[styles.tierPill, styles.tierPillLocked]}>
          <Icon name="lock" size={10} color={colors.dim} />
          <Text style={labelStyle(9, colors.dim, 0.14)}>LOCKED</Text>
        </View>
      )}
    </Pressable>
  );
}

/** Tapping a league you have not reached says how far off it is. */
function LockedSheet({
  tier,
  trophies,
  onClose,
}: {
  tier: LeagueTierRow | null;
  trophies: number;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const pad = { paddingBottom: Math.max(insets.bottom, space.lg) + space.xxxl };
  const needed = tier ? Math.max(tier.min_trophies - trophies, 0) : 0;
  const color = tier ? LEAGUE_COLOR[tier.name] : colors.text;

  return (
    <Modal
      visible={tier !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={[styles.sheet, pad]} onPress={() => undefined}>
          <View style={styles.grip} />
          {tier ? (
            <>
              <View style={styles.sheetBadge}>
                <LeagueBadge tier={tier.name} size={88} locked />
              </View>
              <Label size={11}>LOCKED</Label>
              <Display size={30} color={color} style={styles.sheetTitle}>
                {`${needed} MORE TO ${LEAGUE_LABEL[tier.name].toUpperCase()}`}
              </Display>
              <Small style={styles.sheetBody}>
                {`You need ${needed} more ${
                  needed === 1 ? 'trophy' : 'trophies'
                } to reach ${LEAGUE_LABEL[tier.name]}. It unlocks a ${fmtWager(
                  tier.max_wager_cents,
                )} wager ceiling.`}
              </Small>
              <Button
                label="CLOSE"
                variant="secondary"
                size="md"
                onPress={onClose}
                style={styles.sheetButton}
              />
            </>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Leaderboard ─────────────────────────────────────────────────────────

function Leaderboard({
  board,
  scope,
  onScope,
  session,
}: {
  board: ReturnType<typeof useLeaderboard>;
  scope: LeaderboardScope;
  onScope: (next: LeaderboardScope) => void;
  session: ReturnType<typeof useAuth>['session'];
}) {
  const { rows, self, loading, loadingMore, error, hasMore } = board;
  const onPage = self ? rows.some(r => r.user_id === self.user_id) : true;

  return (
    <View>
      <SectionHead>LEADERBOARD</SectionHead>

      <View style={styles.tabs}>
        <Chip label="Global" active={scope === 'global'} onPress={() => onScope('global')} />
        <Chip
          label="Friends"
          active={scope === 'friends'}
          onPress={() => onScope('friends')}
        />
      </View>

      {error ? <Notice icon="warning">{error}</Notice> : null}

      {loading ? (
        <BoardSkeleton />
      ) : rows.length === 0 ? (
        <View style={styles.emptyCard}>
          <Display size={26}>
            {scope === 'friends' ? 'NO ONE HERE YET.' : 'THE BOARD IS EMPTY.'}
          </Display>
          <Small style={styles.emptyBody}>
            {scope === 'friends'
              ? 'Fighters you have met in a bout show up here. Take one and they will.'
              : 'Nobody has earned a trophy yet. Be first.'}
          </Small>
        </View>
      ) : (
        <View style={styles.board}>
          {rows.map(row => (
            <BoardRow key={row.user_id} row={row} session={session} />
          ))}

          {loadingMore ? <BoardRowSkeleton /> : null}

          {!onPage && self ? (
            <>
              {/* The fighter's own row, kept in view however far down it is.
                  Finding yourself should never be a scrolling exercise. */}
              <View style={styles.pinnedRule}>
                <Divider style={styles.pinnedLine} />
                <Label size={9} color={colors.dim} tracking={0.16}>
                  YOUR POSITION
                </Label>
                <Divider style={styles.pinnedLine} />
              </View>
              <BoardRow row={self} session={session} />
            </>
          ) : null}

          {!hasMore && rows.length > 0 ? (
            <Text style={styles.boardEnd}>
              {scope === 'friends'
                ? 'Everyone you have fought.'
                : 'That is everyone.'}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

function BoardRow({
  row,
  session,
}: {
  row: LeaderboardRow;
  session: ReturnType<typeof useAuth>['session'];
}) {
  const handle = row.username
    ? `@${row.username}`
    : row.is_me
      ? ownHandle(session)
      : handleFor(row.user_id, session);
  const podium = placeColor(row.rank);

  return (
    <View
      style={[styles.row, row.is_me && styles.rowMine]}
      accessible
      accessibilityLabel={`Rank ${row.rank}${row.is_me ? ', you' : ''}, ${handle}, ${
        LEAGUE_LABEL[row.league]
      } league, ${row.trophies} trophies`}
    >
      <View style={styles.rowRank}>
        <Numeral size={16} color={podium ?? colors.dim}>
          {String(row.rank)}
        </Numeral>
      </View>

      <Avatar
        initials={initialsOf(handle)}
        uri={row.avatar_url}
        size={34}
        tone={row.is_me ? 'accent' : 'raised'}
      />

      <View style={styles.rowText}>
        <Text style={typography.rowTitle} numberOfLines={1}>
          {handle}
          {row.is_me ? <Text style={styles.rowYou}>{'  YOU'}</Text> : null}
        </Text>
        {row.display_name ? (
          <Text style={styles.rowName} numberOfLines={1}>
            {row.display_name}
          </Text>
        ) : null}
      </View>

      <LeagueBadge tier={row.league} size={22} />

      <View style={styles.rowTrophies}>
        <Numeral size={17}>{fmtPoints(row.trophies)}</Numeral>
        <Icon name="trophy" size={12} color={colors.dim} />
      </View>
    </View>
  );
}

function BoardSkeleton() {
  return (
    <View style={styles.board}>
      {[0, 1, 2, 3, 4].map(i => (
        <BoardRowSkeleton key={i} />
      ))}
    </View>
  );
}

function BoardRowSkeleton() {
  return (
    <View style={styles.row}>
      <View style={styles.rowRank}>
        <Skeleton width={16} height={16} />
      </View>
      <Skeleton width={34} height={34} radius={17} />
      <View style={styles.rowText}>
        <Skeleton width="60%" height={14} />
      </View>
      <Skeleton width={22} height={22} radius={11} />
      <Skeleton width={38} height={17} />
    </View>
  );
}

// ── Rank history ────────────────────────────────────────────────────────

function History({
  events,
  loading,
  session,
  onFindBout,
}: {
  events: RankHistoryRow[];
  loading: boolean;
  session: ReturnType<typeof useAuth>['session'];
  onFindBout: () => void;
}) {
  return (
    <View>
      <SectionHead>RANK HISTORY</SectionHead>

      {loading ? (
        <View style={styles.timeline}>
          {[0, 1, 2].map(i => (
            <View key={i} style={styles.event}>
              <Skeleton width={10} height={10} radius={5} />
              <View style={styles.eventText}>
                <Skeleton width={60} height={10} />
                <Skeleton width="70%" height={14} style={styles.skeletonGap} />
              </View>
            </View>
          ))}
        </View>
      ) : events.length === 0 ? (
        <View style={styles.emptyCard}>
          <Display size={30}>NO RANK{'\n'}HISTORY YET.</Display>
          <Small style={styles.emptyBody}>
            Win your first bout to earn trophies. Every result lands here,
            newest first.
          </Small>
          <Button
            label="TAKE A BOUT"
            size="md"
            onPress={onFindBout}
            style={styles.emptyButton}
          />
        </View>
      ) : (
        <View style={styles.timeline}>
          {events.map((e, i) => (
            <EventRow
              key={e.id}
              event={e}
              session={session}
              last={i === events.length - 1}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function EventRow({
  event,
  session,
  last,
}: {
  event: RankHistoryRow;
  session: ReturnType<typeof useAuth>['session'];
  last: boolean;
}) {
  const opponent = event.opponent_id ? handleFor(event.opponent_id, session) : null;
  const copy = rankEventCopy(event, opponent);

  // Lime for a gain and the system red for a loss: the two chroma the design
  // allows, and already what a win and a loss look like everywhere else.
  const tint =
    copy.direction === 'up'
      ? (copy.tier ? LEAGUE_COLOR[copy.tier] : colors.accent)
      : copy.direction === 'down'
        ? colors.recording
        : colors.dim;

  return (
    <View style={styles.event}>
      <View style={styles.eventRail}>
        <View style={[styles.eventDot, { backgroundColor: tint }]} />
        {last ? null : <View style={styles.eventLine} />}
      </View>

      <View style={styles.eventText}>
        <Label size={9} color={colors.dim} tracking={0.14}>
          {relativeDay(event.created_at).toUpperCase()}
        </Label>
        <Text style={styles.eventTitle} numberOfLines={2}>
          {copy.title}
        </Text>
        <Text style={styles.eventBalance}>
          {`${fmtPoints(event.trophy_balance)} trophies`}
        </Text>
      </View>

      <View style={styles.eventDelta}>
        {copy.direction === 'flat' ? null : (
          <Icon
            name={copy.direction === 'up' ? 'arrow-up' : 'arrow-down'}
            size={14}
            color={tint}
          />
        )}
        {copy.delta ? (
          <Numeral size={18} color={tint}>
            {copy.delta}
          </Numeral>
        ) : null}
      </View>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: {
    paddingHorizontal: space.gutter,
    paddingBottom: space.xxxl,
    gap: space.xxl,
  },

  hero: { alignItems: 'center' },
  heroName: { marginTop: space.lg },
  heroTrophies: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.sm,
  },
  heroProgress: { width: '100%', marginTop: space.xl },
  track: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.raised,
    overflow: 'hidden',
  },
  fill: { height: 8, borderRadius: 4 },
  heroProgressText: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.sm + 2,
  },
  maxRank: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.xl,
    paddingVertical: space.md,
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    borderWidth: 1,
    overflow: 'hidden',
  },
  maxShimmer: { position: 'absolute', width: 48, height: 120 },
  rankPill: {
    marginTop: space.md,
    paddingVertical: 7,
    paddingHorizontal: space.md + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
  },

  statRow: { flexDirection: 'row', gap: space.sm },
  statCell: { flex: 1 },
  rateCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.cardPad,
    marginTop: space.sm,
  },
  rateText: { flex: 1, minWidth: 0 },
  rateHead: { marginTop: 6 },
  rateNote: { ...typography.helper, marginTop: 6 },

  tierRow: { flexDirection: 'row', gap: space.sm + 2, paddingRight: space.gutter },
  tierCard: {
    width: 168,
    padding: space.cardPad,
    borderRadius: radius.card,
    backgroundColor: colors.card,
  },
  tierCardPressed: { backgroundColor: colors.cardPressed },
  tierDim: { opacity: 0.55 },
  tierName: { marginTop: space.md },
  tierFacts: { marginTop: space.sm + 2, gap: 6 },
  tierFact: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tierFactText: {
    fontFamily: fonts.medium,
    fontSize: 12,
    lineHeight: 16,
    color: colors.secondary,
    flexShrink: 1,
  },
  tierPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    marginTop: space.lg,
    paddingVertical: 6,
    paddingHorizontal: 9,
    borderRadius: radius.tag,
  },
  tierPillDone: { backgroundColor: colors.accentTint },
  tierPillLocked: { backgroundColor: colors.raised },

  tabs: { flexDirection: 'row', gap: space.sm, marginBottom: space.md },
  board: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    overflow: 'hidden',
    paddingVertical: space.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    minHeight: 58,
  },
  rowMine: {
    backgroundColor: colors.accentTint,
    borderWidth: 1,
    borderColor: colors.accentOutline,
    borderRadius: radius.control,
    marginHorizontal: space.sm,
    paddingHorizontal: space.md,
  },
  rowRank: { width: 26, alignItems: 'center' },
  rowText: { flex: 1, minWidth: 0 },
  rowYou: { ...labelStyle(9, colors.accent, 0.14) },
  rowName: { ...typography.footnote, marginTop: 2 },
  rowTrophies: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  pinnedRule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  pinnedLine: { flex: 1 },
  boardEnd: {
    ...typography.footnote,
    textAlign: 'center',
    paddingVertical: space.md,
  },

  timeline: { gap: 0 },
  event: { flexDirection: 'row', gap: space.md, paddingRight: space.xs },
  eventRail: { width: 10, alignItems: 'center' },
  eventDot: { width: 10, height: 10, borderRadius: 5, marginTop: 6 },
  eventLine: { flex: 1, width: 2, backgroundColor: colors.line, marginTop: 4 },
  eventText: { flex: 1, minWidth: 0, paddingBottom: space.xl },
  eventTitle: { ...typography.rowTitle, marginTop: 4 },
  eventBalance: { ...typography.footnote, marginTop: 3 },
  eventDelta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 14 },

  emptyCard: {
    borderRadius: radius.card,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.slot,
    paddingVertical: 28,
    paddingHorizontal: 22,
  },
  emptyBody: { marginTop: space.sm + 2 },
  emptyButton: { marginTop: space.xl, alignSelf: 'flex-start' },
  helper: { ...typography.helper, marginTop: space.md },

  skeletonGap: { marginTop: space.sm },
  skeletonBar: { marginTop: space.xl },

  scrim: { flex: 1, backgroundColor: colors.scrim, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingTop: 14,
    paddingHorizontal: space.gutter,
  },
  grip: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.handle,
    alignSelf: 'center',
    marginBottom: space.cardPad,
  },
  sheetBadge: { alignItems: 'center', marginBottom: space.xl },
  sheetTitle: { marginTop: space.sm },
  sheetBody: { marginTop: space.sm },
  sheetButton: { marginTop: space.xxl, alignSelf: 'stretch' },
});
