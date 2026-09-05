import React, { useState } from 'react';
import { StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import type { ChallengeFormat, ChallengeType } from '../types/database';
import { colors, space, typography } from '../theme/tokens';
import { EXERCISE_LABEL, FORMAT_LABEL } from '../theme/copy';
import {
  Chip,
  ChipRow,
  ErrorText,
  Headline,
  Input,
  Kicker,
  Label,
  Muted,
  PrimaryButton,
  Screen,
} from '../theme/ui';

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
      setError('Put something on the line — the stake has to be more than zero.');
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
    <Screen>
      <Kicker>Set the terms</Kicker>
      <Headline>Name your bout</Headline>
      <Muted style={styles.lede}>
        Both corners put up the stake. Winner takes the pot.
      </Muted>

      <Label style={styles.fieldLabel}>Exercise</Label>
      <ChipRow>
        {TYPES.map(option => (
          <Chip
            key={option}
            label={EXERCISE_LABEL[option]}
            active={type === option}
            onPress={() => setType(option)}
          />
        ))}
      </ChipRow>

      <Label style={styles.fieldLabel}>Format</Label>
      <ChipRow>
        {FORMATS.map(option => (
          <Chip
            key={option}
            label={FORMAT_LABEL[option]}
            active={format === option}
            onPress={() => setFormat(option)}
          />
        ))}
      </ChipRow>

      <Label style={styles.fieldLabel}>Stake · pts on the line</Label>
      <Input
        style={styles.stakeInput}
        keyboardType="number-pad"
        value={stake}
        onChangeText={setStake}
      />

      {error ? <ErrorText style={styles.error}>{error}</ErrorText> : null}

      <PrimaryButton
        style={styles.cta}
        label="Post the bout"
        onPress={submit}
        loading={submitting}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  lede: { marginTop: space.sm },
  fieldLabel: { marginTop: space.lg, marginBottom: space.sm },
  stakeInput: {
    ...typography.stat,
    color: colors.accent,
    paddingVertical: space.sm + 2,
  },
  error: { marginTop: space.md },
  cta: { marginTop: space.xl },
});
