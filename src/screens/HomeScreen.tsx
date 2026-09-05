import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import type { ChallengeRow } from '../types/database';
import { colors, radius, space, typography } from '../theme/tokens';
import { EXERCISE_LABEL, FORMAT_LABEL } from '../theme/copy';
import {
  ErrorText,
  Kicker,
  Loading,
  Muted,
  Plate,
  PrimaryButton,
  Screen,
  Subhead,
} from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

function ProfileHeaderLink({ navigation }: Pick<Props, 'navigation'>) {
  return (
    <TouchableOpacity onPress={() => navigation.navigate('Profile')}>
      <Text style={styles.headerLink}>My corner</Text>
    </TouchableOpacity>
  );
}

export function HomeScreen({ navigation }: Props) {
  const { session } = useAuth();
  const [challenges, setChallenges] = useState<ChallengeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      .channel('home-open-challenges')
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

  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <ProfileHeaderLink navigation={navigation} />,
    });
  }, [navigation]);

  if (loading) {
    return <Loading />;
  }

  return (
    <Screen style={styles.container}>
      <FlatList
        data={challenges}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={colors.accent}
            colors={[colors.accent]}
            progressBackgroundColor={colors.surfaceRaised}
          />
        }
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <Kicker>Open bouts</Kicker>
            <Muted>Somebody in your group chat is about to lose.</Muted>
            {error ? <ErrorText style={styles.error}>{error}</ErrorText> : null}
          </View>
        }
        ListEmptyComponent={
          <Plate style={styles.empty}>
            <Subhead>Nothing on the card</Subhead>
            <Muted style={styles.emptyBody}>
              No open bouts right now. Call somebody out and yours goes up
              first.
            </Muted>
          </Plate>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() =>
              navigation.navigate('ChallengeDetail', { challengeId: item.id })
            }
            accessibilityRole="button"
            style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
          >
            <View style={styles.cardRow}>
              <Text style={styles.cardType}>{EXERCISE_LABEL[item.type]}</Text>
              <Text style={styles.cardFormat}>{FORMAT_LABEL[item.format]}</Text>
            </View>
            <View style={styles.cardStakeRow}>
              <Text style={styles.cardStake}>{item.stake_points}</Text>
              <Text style={styles.cardStakeUnit}>pts on the line</Text>
            </View>
            {item.created_by === session?.user.id ? (
              <Text style={styles.ownBadge}>Your call-out</Text>
            ) : null}
          </Pressable>
        )}
      />
      <PrimaryButton
        style={styles.fab}
        label="Call someone out"
        onPress={() => navigation.navigate('CreateChallenge')}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { padding: 0 },
  listContent: { padding: space.md, paddingBottom: 120 },
  listHeader: { marginBottom: space.md, gap: space.xs },
  error: { marginTop: space.sm },
  empty: { marginTop: space.md },
  emptyBody: { marginTop: space.sm },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.md + 2,
    marginBottom: space.sm + 2,
  },
  cardPressed: { backgroundColor: colors.surfaceRaised },
  cardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  cardType: { ...typography.subhead },
  cardFormat: { ...typography.label, marginTop: space.xs },
  cardStakeRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
    marginTop: space.sm,
  },
  cardStake: { ...typography.stat, color: colors.accent },
  cardStakeUnit: { ...typography.label },
  ownBadge: { ...typography.label, color: colors.accent, marginTop: space.sm },
  fab: {
    position: 'absolute',
    bottom: space.lg,
    left: space.md,
    right: space.md,
  },
  headerLink: { ...typography.label, color: colors.accent, marginRight: space.sm },
});
