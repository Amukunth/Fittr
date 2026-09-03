import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useFitnessProfile } from '../hooks/useFitnessProfile';
import type { StrengthTier } from '../types/database';

const TIERS: StrengthTier[] = ['beginner', 'intermediate', 'advanced'];

export function ProfileScreen() {
  const { session, signOut } = useAuth();
  const { profile, loading, error, refresh } = useFitnessProfile();
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [updatingTier, setUpdatingTier] = useState(false);

  useEffect(() => {
    if (!session) {
      return;
    }
    supabase
      .from('match_participants')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', session.user.id)
      .then(({ count }) => setMatchCount(count ?? 0));
  }, [session]);

  const setTier = async (tier: StrengthTier) => {
    if (!profile || tier === profile.strength_tier) {
      return;
    }
    setUpdatingTier(true);
    await supabase
      .from('fitness_profiles')
      .update({ strength_tier: tier })
      .eq('user_id', profile.user_id);
    setUpdatingTier(false);
    await refresh();
  };

  if (loading || !profile) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.email}>{session?.user.email}</Text>

      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>Points balance</Text>
        <Text style={styles.balanceValue}>{profile.points_balance}</Text>
      </View>

      <Text style={styles.sectionTitle}>Strength tier (self-reported)</Text>
      <View style={styles.pillRow}>
        {TIERS.map(tier => (
          <TouchableOpacity
            key={tier}
            style={[
              styles.pill,
              profile.strength_tier === tier && styles.pillActive,
            ]}
            onPress={() => setTier(tier)}
            disabled={updatingTier}
          >
            <Text
              style={[
                styles.pillText,
                profile.strength_tier === tier && styles.pillTextActive,
              ]}
            >
              {tier}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.statsRow}>
        <Text style={styles.sectionTitle}>Matches played</Text>
        <Text style={styles.statValue}>{matchCount ?? '—'}</Text>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity style={styles.signOutButton} onPress={signOut}>
        <Text style={styles.signOutText}>Log out</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  email: { fontSize: 14, color: '#6B7280', marginBottom: 20 },
  balanceCard: {
    backgroundColor: '#0B0B0F',
    borderRadius: 14,
    padding: 24,
    marginBottom: 24,
  },
  balanceLabel: { color: '#9CA3AF', fontSize: 14 },
  balanceValue: { color: '#fff', fontSize: 36, fontWeight: '800', marginTop: 4 },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: '#374151', marginBottom: 8 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap' },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    marginRight: 8,
    marginBottom: 8,
  },
  pillActive: { backgroundColor: '#E11D48', borderColor: '#E11D48' },
  pillText: { color: '#374151', textTransform: 'capitalize' },
  pillTextActive: { color: '#fff', fontWeight: '700' },
  statsRow: { marginTop: 24, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statValue: { fontSize: 20, fontWeight: '700' },
  error: { color: '#DC2626', marginTop: 16 },
  signOutButton: {
    marginTop: 'auto',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#DC2626',
  },
  signOutText: { color: '#DC2626', fontWeight: '700', fontSize: 16 },
});
