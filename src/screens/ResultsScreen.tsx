import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import type { MatchRow, PointsLedgerEntryRow } from '../types/database';

type Props = NativeStackScreenProps<RootStackParamList, 'Results'>;

export function ResultsScreen({ route }: Props) {
  const { matchId } = route.params;
  const { session } = useAuth();
  const [match, setMatch] = useState<MatchRow | null>(null);
  // RLS scopes this to the signed-in user's own rows, so this is always
  // "my" stake/payout history for the match, not every participant's.
  const [ledgerEntries, setLedgerEntries] = useState<PointsLedgerEntryRow[]>(
    [],
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [{ data: matchData }, { data: ledgerData }] = await Promise.all([
        supabase.from('matches').select('*').eq('id', matchId).maybeSingle(),
        supabase
          .from('points_ledger_entries')
          .select('*')
          .eq('match_id', matchId)
          .order('created_at', { ascending: true }),
      ]);
      setMatch((matchData ?? null) as MatchRow | null);
      setLedgerEntries((ledgerData ?? []) as PointsLedgerEntryRow[]);
      setLoading(false);
    })();
  }, [matchId]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!match) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>Results aren't available yet.</Text>
      </View>
    );
  }

  const netChange = ledgerEntries.reduce((sum, e) => sum + e.amount, 0);
  const won = match.winner_id && match.winner_id === session?.user.id;

  return (
    <View style={styles.container}>
      <Text style={styles.outcome}>
        {match.settled_at
          ? won
            ? 'You won'
            : 'You lost'
          : 'Not settled yet'}
      </Text>

      <Text style={styles.netChange}>
        {netChange > 0 ? '+' : ''}
        {netChange} pts
      </Text>

      <View style={styles.ledger}>
        <Text style={styles.sectionTitle}>Points history</Text>
        {ledgerEntries.length === 0 ? (
          <Text style={styles.emptyText}>No points activity yet.</Text>
        ) : (
          ledgerEntries.map(entry => (
            <View key={entry.id} style={styles.ledgerRow}>
              <Text style={styles.ledgerReason}>{entry.reason}</Text>
              <Text
                style={[
                  styles.ledgerAmount,
                  entry.amount < 0 ? styles.negative : styles.positive,
                ]}
              >
                {entry.amount > 0 ? '+' : ''}
                {entry.amount}
              </Text>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  outcome: { fontSize: 26, fontWeight: '800' },
  netChange: { fontSize: 20, marginTop: 8, color: '#111827' },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: '#374151', marginBottom: 8 },
  ledger: { marginTop: 32 },
  ledgerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  ledgerReason: { textTransform: 'capitalize', color: '#111827' },
  ledgerAmount: { fontWeight: '700' },
  positive: { color: '#16A34A' },
  negative: { color: '#DC2626' },
  emptyText: { color: '#6B7280' },
});
