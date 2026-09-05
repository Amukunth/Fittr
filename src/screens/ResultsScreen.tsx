import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import type {
  ChallengeRow,
  MatchParticipantRow,
  MatchRow,
  PointsLedgerEntryRow,
} from '../types/database';
import { colors, space, typography } from '../theme/tokens';
import { EXERCISE_LABEL, LEDGER_LABEL } from '../theme/copy';
import {
  Center,
  GhostButton,
  Kicker,
  Label,
  Loading,
  Muted,
  Plate,
  Screen,
  Subhead,
  TapeRow,
} from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Results'>;

function formatSeconds(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** The score column that decides this challenge type — must match settle_match(). */
function scoreOf(
  participant: MatchParticipantRow,
  type: ChallengeRow['type'] | undefined,
): number | null {
  if (type === 'pushups') {
    return participant.rep_count;
  }
  if (type === 'plank' || type === 'wallsit') {
    return participant.hold_duration_seconds;
  }
  return null;
}

function formatScore(
  score: number | null,
  type: ChallengeRow['type'] | undefined,
): string {
  if (score === null) {
    return '—';
  }
  return type === 'pushups' ? `${score} reps` : formatSeconds(score);
}

export function ResultsScreen({ route, navigation }: Props) {
  const { matchId } = route.params;
  const { session } = useAuth();
  const [match, setMatch] = useState<MatchRow | null>(null);
  const [challenge, setChallenge] = useState<ChallengeRow | null>(null);
  const [participants, setParticipants] = useState<MatchParticipantRow[]>([]);
  // RLS scopes this to the signed-in user's own rows, so this is always
  // "my" stake/payout history for the match, not every participant's.
  const [ledgerEntries, setLedgerEntries] = useState<PointsLedgerEntryRow[]>(
    [],
  );
  const [loading, setLoading] = useState(true);

  // settle_match() is normally invoked inside submit_verification_session() the
  // moment the second result lands, so this is only a safety net: matches
  // recorded before settlement existed, or stranded by a failed transaction.
  // Once per mount — it must not re-fire off its own refetch.
  const settleAttemptedRef = useRef(false);

  const load = useCallback(async () => {
    const { data: matchData } = await supabase
      .from('matches')
      .select('*')
      .eq('id', matchId)
      .maybeSingle();

    const matchRow = (matchData ?? null) as MatchRow | null;
    setMatch(matchRow);

    if (!matchRow) {
      setLoading(false);
      return;
    }

    const [{ data: challengeData }, { data: participantData }, { data: ledger }] =
      await Promise.all([
        supabase
          .from('challenges')
          .select('*')
          .eq('id', matchRow.challenge_id)
          .maybeSingle(),
        supabase
          .from('match_participants')
          .select('*')
          .eq('match_id', matchId),
        supabase
          .from('points_ledger_entries')
          .select('*')
          .eq('match_id', matchId)
          .order('created_at', { ascending: true }),
      ]);

    setChallenge((challengeData ?? null) as ChallengeRow | null);
    setParticipants((participantData ?? []) as MatchParticipantRow[]);
    setLedgerEntries((ledger ?? []) as PointsLedgerEntryRow[]);
    setLoading(false);
  }, [matchId]);

  useEffect(() => {
    (async () => {
      await load();
      if (settleAttemptedRef.current) {
        return;
      }
      settleAttemptedRef.current = true;
      // Errors are deliberately swallowed: every raise inside settle_match is
      // a state this screen should still render (e.g. an unsupported type), and
      // a safety net that can block the results view is worse than no net.
      const { error } = await supabase.rpc('settle_match', {
        p_match_id: matchId,
      });
      if (!error) {
        await load();
      }
    })();
  }, [load, matchId]);

  // Settlement flips challenges.status to completed / needs_review, and
  // `challenges` is already in the realtime publication — so this picks up the
  // moment the *opponent* finishes, with no extra migration. `matches` is not
  // published (it has no user column to filter on); see BACKEND.md.
  useEffect(() => {
    const challengeId = match?.challenge_id;
    if (!challengeId) {
      return;
    }
    const channel = supabase
      .channel(`results:${challengeId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'challenges',
          filter: `id=eq.${challengeId}`,
        },
        () => {
          load();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [match?.challenge_id, load]);

  if (loading) {
    return <Loading />;
  }

  if (!match) {
    return (
      <Center>
        <Muted style={styles.centerText}>
          No decision yet — the results for this bout aren't in.
        </Muted>
      </Center>
    );
  }

  const netChange = ledgerEntries.reduce((sum, e) => sum + e.amount, 0);
  const settled = match.settled_at !== null;
  const needsReview = challenge?.status === 'needs_review';
  // winner_id NULL on a SETTLED match is a tie, not a loss — settle_match's
  // documented tie rule refunds both stakes and leaves no winner.
  const isTie = settled && match.winner_id === null;
  const won = settled && match.winner_id === session?.user.id;

  const submittedCount = participants.filter(
    p => scoreOf(p, challenge?.type) !== null,
  ).length;

  let outcome: string;
  let detail: string;
  if (needsReview) {
    outcome = 'Under review';
    detail =
      'The winning result tripped the on-device anomaly checks. The pot is held until a reviewer clears it.';
  } else if (!settled) {
    outcome = 'No decision yet';
    detail =
      submittedCount < participants.length
        ? 'Waiting on your opponent to record their round.'
        : 'Both results are in — the decision is landing now.';
  } else if (isTie) {
    outcome = 'Draw';
    detail = "Dead heat. Both stakes refunded — nobody's points moved.";
  } else if (won) {
    outcome = 'Winner';
    detail = 'The pot is yours. The full purse just hit your bankroll.';
  } else {
    outcome = 'Beaten';
    detail = 'Your stake went to the winner. Call them out again.';
  }

  const netTone =
    netChange > 0
      ? styles.netPositive
      : netChange < 0
        ? styles.netNegative
        : undefined;

  return (
    <Screen>
      <Kicker>{challenge ? EXERCISE_LABEL[challenge.type] : 'The decision'}</Kicker>
      <Text style={typography.display}>{outcome}</Text>
      <Muted style={styles.detail}>{detail}</Muted>

      <View style={styles.netRow}>
        <Text style={[styles.net, netTone]}>
          {netChange > 0 ? '+' : ''}
          {netChange}
        </Text>
        <Label>pts</Label>
      </View>

      <View style={styles.section}>
        <Subhead style={styles.sectionTitle}>Tale of the tape</Subhead>
        <Plate>
          {participants.map((p, i) => {
            const score = scoreOf(p, challenge?.type);
            const isWinner = settled && match.winner_id === p.user_id;
            return (
              <TapeRow
                key={p.id}
                left={
                  p.user_id === session?.user.id ? 'You' : p.user_id.slice(0, 8)
                }
                tag={isWinner ? 'Winner' : undefined}
                right={formatScore(score, challenge?.type)}
                highlight={isWinner}
                last={i === participants.length - 1}
              />
            );
          })}
        </Plate>
      </View>

      <View style={styles.section}>
        <Subhead style={styles.sectionTitle}>The purse</Subhead>
        <Plate>
          {ledgerEntries.length === 0 ? (
            <Muted>No points have moved yet.</Muted>
          ) : (
            ledgerEntries.map((entry, i) => (
              <TapeRow
                key={entry.id}
                left={LEDGER_LABEL[entry.reason]}
                right={`${entry.amount > 0 ? '+' : ''}${entry.amount}`}
                highlight={entry.amount > 0}
                last={i === ledgerEntries.length - 1}
              />
            ))
          )}
        </Plate>
      </View>

      <GhostButton
        style={styles.back}
        label="Back to the card"
        onPress={() => navigation.navigate('Home')}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  centerText: { textAlign: 'center' },
  detail: { marginTop: space.sm },
  netRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
    marginTop: space.md,
  },
  net: { ...typography.numeral, fontSize: 48, lineHeight: 48 },
  netPositive: { color: colors.accent },
  netNegative: { color: colors.textMuted },
  section: { marginTop: space.xl },
  sectionTitle: { marginBottom: space.sm + 2 },
  back: { marginTop: 'auto' },
});
