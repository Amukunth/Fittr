import React, { useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import type { ChallengeFormat, ChallengeType } from '../types/database';

type Props = NativeStackScreenProps<RootStackParamList, 'CreateChallenge'>;

const TYPES: ChallengeType[] = ['pushups', 'plank', 'wallsit', 'race'];
const FORMATS: ChallengeFormat[] = ['1v1', 'pooled'];

export function CreateChallengeScreen({ navigation }: Props) {
  const { session } = useAuth();
  const [type, setType] = useState<ChallengeType>('pushups');
  const [format, setFormat] = useState<ChallengeFormat>('1v1');
  const [stake, setStake] = useState('50');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const stakePoints = parseInt(stake, 10);
    if (!Number.isFinite(stakePoints) || stakePoints <= 0) {
      setError('Enter a stake amount greater than zero.');
      return;
    }
    if (!session) {
      setError('You must be logged in.');
      return;
    }

    setSubmitting(true);
    const { data, error: insertError } = await supabase
      .from('challenges')
      .insert({
        type,
        format,
        stake_points: stakePoints,
        created_by: session.user.id,
      })
      .select('id')
      .single();
    setSubmitting(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    navigation.replace('ChallengeDetail', { challengeId: data.id });
  };

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Type</Text>
      <View style={styles.pillRow}>
        {TYPES.map(option => (
          <TouchableOpacity
            key={option}
            style={[styles.pill, type === option && styles.pillActive]}
            onPress={() => setType(option)}
          >
            <Text style={[styles.pillText, type === option && styles.pillTextActive]}>
              {option}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.label}>Format</Text>
      <View style={styles.pillRow}>
        {FORMATS.map(option => (
          <TouchableOpacity
            key={option}
            style={[styles.pill, format === option && styles.pillActive]}
            onPress={() => setFormat(option)}
          >
            <Text style={[styles.pillText, format === option && styles.pillTextActive]}>
              {option}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.label}>Stake (points)</Text>
      <TextInput
        style={styles.input}
        keyboardType="number-pad"
        value={stake}
        onChangeText={setStake}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity
        style={styles.primaryButton}
        onPress={submit}
        disabled={submitting}
      >
        {submitting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.primaryButtonText}>Post Challenge</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#fff' },
  label: { fontSize: 14, fontWeight: '600', color: '#374151', marginTop: 16, marginBottom: 8 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
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
  input: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
  },
  error: { color: '#DC2626', marginTop: 16 },
  primaryButton: {
    backgroundColor: '#E11D48',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 32,
  },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
