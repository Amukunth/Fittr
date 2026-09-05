import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
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
import { space, typography } from '../theme/tokens';
import { EXERCISE_LABEL, FORMAT_LABEL, STATUS_LABEL } from '../theme/copy';
import {
  Center,
  ErrorText,
  Kicker,
  Loading,
  Muted,
  Plate,
  PrimaryButton,
  Screen,
  Stat,
  Subhead,
  TapeRow,
} from '../theme/ui';

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

    // Do NOT drop these errors. The RLS-recursion bug (see migration
    // 20260904000000) hid here: the read failed, `match` stayed null, so the
    // screen showed "Status: matched" with no Go to Match button and no
    // message. A missing match on an 'open' challenge is still a clean
    // null-with-no-error from maybeSingle(), so surfacing errors changes
    // nothing on the happy path.
    const { data: matchData, error: matchError } = await supabase
      .from('matches')
      .select('*')
      .eq('challenge_id', challengeId)
      .maybeSingle();

    if (matchError) {
      setError(`Couldn't load match: ${matchError.message}`);
    } else if (matchData) {
      setMatch(matchData as MatchRow);
      const { data: participantsData, error: participantsError } =
        await supabase
          .from('match_participants')
          .select('*')
          .eq('match_id', matchData.id);
      if (participantsError) {
        setError(`Couldn't load participants: ${participantsError.message}`);
      }
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

  // Keep this screen's status/participants live. Matters for a viewer who is
  // sitting on someone else's challenge when a third user accepts it — the
  // app-level MatchFoundWatcher only fires for the creator, and without this
  // the Accept button would stay tappable against an already-matched
  // challenge until the next focus event.
  useEffect(() => {
    const channel = supabase
      .channel(`challenge-detail:${challengeId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'challenges',
          filter: `id=eq.${challengeId}`,
        },
        payload => {
          const next = payload.new as ChallengeRow;
          setChallenge(next);
          // Status moved off 'open', so a Match now exists (or its results
          // landed). Re-pull to pick up the match row and participants.
          if (next.status !== 'open') {
            load();
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [challengeId, load]);

  const join = async () => {
    if (!session) {
      return;
    }
    setJoining(true);
    setError(null);

    // join_challenge() RETURNS the new match's uuid, so the joiner never has
    // to re-query for it — by the time this resolves the Match, both
    // MatchParticipants and both stake deductions are already committed.
    const { data: matchId, error: rpcError } = await supabase.rpc(
      'join_challenge',
      { p_challenge_id: challengeId, p_user_id: session.user.id },
    );
    setJoining(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    if (typeof matchId === 'string') {
      // replace, not navigate: leaving ChallengeDetail on the stack would
      // mean MatchInProgress's "Done" (which replaces itself with
      // ChallengeDetail) stacks a duplicate of this screen behind it.
      navigation.replace('MatchInProgress', { matchId });
      return;
    }

    // Defensive: the join committed but we somehow got no id back. Fall back
    // to the old refetch so the "Go to Match" button still appears.
    await load();
  };

  if (loading) {
    return <Loading />;
  }

  if (!challenge) {
    return (
      <Center>
        <ErrorText>{error ?? "That bout isn't on the card."}</ErrorText>
      </Center>
    );
  }

  const isOwnChallenge = challenge.created_by === session?.user.id;
  const canJoin = challenge.status === 'open' && !isOwnChallenge;
  const decided =
    challenge.status === 'completed' || challenge.status === 'needs_review';

  return (
    <Screen>
      <Kicker>
        {STATUS_LABEL[challenge.status]}
        {isOwnChallenge ? ' · Your call-out' : ''}
      </Kicker>
      <Text style={typography.display}>{EXERCISE_LABEL[challenge.type]}</Text>

      <View style={styles.tape}>
        <Plate raised style={styles.tapePlate}>
          <Stat label="Stake" value={`${challenge.stake_points} pts`} accent />
        </Plate>
        <Plate raised style={styles.tapePlate}>
          <Stat label="Format" value={FORMAT_LABEL[challenge.format]} />
        </Plate>
      </View>

      {challenge.status === 'open' && isOwnChallenge ? (
        <Muted style={styles.note}>
          Posted. Waiting on somebody to take it.
        </Muted>
      ) : null}

      {error ? <ErrorText style={styles.error}>{error}</ErrorText> : null}

      {match && (
        <View style={styles.section}>
          <Subhead style={styles.sectionTitle}>Tale of the tape</Subhead>
          <Plate>
            {participants.map((p, i) => (
              <TapeRow
                key={p.id}
                left={
                  p.user_id === session?.user.id ? 'You' : p.user_id.slice(0, 8)
                }
                last={i === participants.length - 1}
              />
            ))}
          </Plate>
        </View>
      )}

      {canJoin && (
        <PrimaryButton
          style={styles.cta}
          label={`Accept the bout · ${challenge.stake_points} pts`}
          onPress={join}
          loading={joining}
        />
      )}

      {match && challenge.status === 'matched' && (
        <PrimaryButton
          style={styles.cta}
          label="Enter the ring"
          onPress={() =>
            navigation.navigate('MatchInProgress', { matchId: match.id })
          }
        />
      )}

      {/* needs_review is a settled-enough state to have results worth
          showing (scores are in, the payout is just held) — gating only on
          'completed' would make a flagged match unreachable from here. */}
      {match && decided && (
        <PrimaryButton
          style={styles.cta}
          label={
            challenge.status === 'needs_review'
              ? 'See the decision · under review'
              : 'See the decision'
          }
          onPress={() => navigation.navigate('Results', { matchId: match.id })}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  tape: { flexDirection: 'row', gap: space.sm + 2, marginTop: space.lg },
  tapePlate: { flex: 1 },
  note: { marginTop: space.md },
  error: { marginTop: space.md },
  section: { marginTop: space.xl },
  sectionTitle: { marginBottom: space.sm + 2 },
  cta: { marginTop: space.xl },
});
