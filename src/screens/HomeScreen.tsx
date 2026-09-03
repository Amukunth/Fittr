import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
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

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

function ProfileHeaderLink({ navigation }: Pick<Props, 'navigation'>) {
  return (
    <TouchableOpacity onPress={() => navigation.navigate('Profile')}>
      <Text style={styles.headerLink}>Profile</Text>
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
  // challenge or backing out of a match) instead of wiring realtime for v1.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <ProfileHeaderLink navigation={navigation} />,
    });
  }, [navigation]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
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
          />
        }
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            No open challenges right now. Create one to get started.
          </Text>
        }
        ListHeaderComponent={error ? <Text style={styles.error}>{error}</Text> : undefined}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.card}
            onPress={() =>
              navigation.navigate('ChallengeDetail', { challengeId: item.id })
            }
          >
            <View style={styles.cardRow}>
              <Text style={styles.cardType}>{formatType(item.type)}</Text>
              <Text style={styles.cardFormat}>{item.format}</Text>
            </View>
            <Text style={styles.cardStake}>{item.stake_points} pts stake</Text>
            {item.created_by === session?.user.id ? (
              <Text style={styles.ownBadge}>Your challenge</Text>
            ) : null}
          </TouchableOpacity>
        )}
      />
      <TouchableOpacity
        style={styles.fab}
        onPress={() => navigation.navigate('CreateChallenge')}
      >
        <Text style={styles.fabText}>+ New Challenge</Text>
      </TouchableOpacity>
    </View>
  );
}

function formatType(type: ChallengeRow['type']): string {
  switch (type) {
    case 'pushups':
      return 'Push-ups';
    case 'plank':
      return 'Plank';
    case 'wallsit':
      return 'Wall Sit';
    case 'race':
      return 'Race';
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { padding: 16, paddingBottom: 96 },
  emptyText: { textAlign: 'center', color: '#6B7280', marginTop: 40 },
  error: { color: '#DC2626', marginBottom: 12 },
  card: {
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  cardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  cardType: { fontSize: 18, fontWeight: '700' },
  cardFormat: { fontSize: 14, color: '#6B7280', textTransform: 'uppercase' },
  cardStake: { fontSize: 16, color: '#111827' },
  ownBadge: { marginTop: 6, color: '#E11D48', fontWeight: '600' },
  fab: {
    position: 'absolute',
    bottom: 24,
    left: 16,
    right: 16,
    backgroundColor: '#E11D48',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  fabText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  headerLink: { color: '#E11D48', fontWeight: '600', marginRight: 8 },
});
