import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
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
import type {
  ChallengeRow,
  MatchParticipantRow,
  MatchRow,
} from '../types/database';

type Props = NativeStackScreenProps<RootStackParamList, 'ChallengeDetail'>;

export function ChallengeDetailScreen({ route, navigation }: Props) {
  const { challengeId } = route.params;
  const { session } = useAuth();

  const [challenge, setChallenge] = useState<ChallengeRow | null>(null);
  const [match, setMatch] = useState<MatchRow | null>(null);
  const [participants, setParticipants] = useState<MatchParticipantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const { data: challengeData, error: challengeError } = await supabase
      .from('challenges')
      .select('*')
      .eq('id', challengeId)
      .single();

    if (challengeError) {
      setError(challengeError.message);
      setLoading(false);
      return;
    }
    setChallenge(challengeData as ChallengeRow);

    const { data: matchData } = await supabase
      .from('matches')
      .select('*')
      .eq('challenge_id', challengeId)
      .maybeSingle();

    if (matchData) {
      setMatch(matchData as MatchRow);
      const { data: participantsData } = await supabase
        .from('match_participants')
        .select('*')
        .eq('match_id', matchData.id);
      setParticipants((participantsData ?? []) as MatchParticipantRow[]);
    }

    setLoading(false);
  }, [challengeId]);

  useEffect(() => {
    load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const join = async () => {
    if (!session) {
      return;
    }
    setJoining(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('join_challenge', {
      p_challenge_id: challengeId,
      p_user_id: session.user.id,
    });
    setJoining(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    await load();
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!challenge) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error ?? 'Challenge not found.'}</Text>
      </View>
    );
  }

  const isOwnChallenge = challenge.created_by === session?.user.id;
  const canJoin = challenge.status === 'open' && !isOwnChallenge;

  return (
    <View style={styles.container}>
      <Text style={styles.type}>{challenge.type}</Text>
      <Text style={styles.meta}>
        {challenge.format} · {challenge.stake_points} pts stake
      </Text>
      <Text style={styles.status}>Status: {challenge.status}</Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {match && (
        <View style={styles.participants}>
          <Text style={styles.sectionTitle}>Participants</Text>
          {participants.map(p => (
            <Text key={p.id} style={styles.participant}>
              {p.user_id === session?.user.id ? 'You' : p.user_id.slice(0, 8)}
            </Text>
          ))}
        </View>
      )}

      {canJoin && (
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={join}
          disabled={joining}
        >
          {joining ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryButtonText}>
              Accept ({challenge.stake_points} pts)
            </Text>
          )}
        </TouchableOpacity>
      )}

      {match && challenge.status === 'matched' && (
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() =>
            navigation.navigate('MatchInProgress', { matchId: match.id })
          }
        >
          <Text style={styles.primaryButtonText}>Go to Match</Text>
        </TouchableOpacity>
      )}

      {match && challenge.status === 'completed' && (
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => navigation.navigate('Results', { matchId: match.id })}
        >
          <Text style={styles.primaryButtonText}>View Results</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  type: { fontSize: 28, fontWeight: '800', textTransform: 'capitalize' },
  meta: { fontSize: 16, color: '#6B7280', marginTop: 4, textTransform: 'capitalize' },
  status: { fontSize: 14, color: '#111827', marginTop: 12, fontWeight: '600' },
  error: { color: '#DC2626', marginTop: 16 },
  sectionTitle: { fontSize: 14, fontWeight: '700', marginBottom: 8, color: '#374151' },
  participants: { marginTop: 24 },
  participant: { fontSize: 15, color: '#111827', paddingVertical: 4 },
  primaryButton: {
    backgroundColor: '#E11D48',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 32,
  },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
