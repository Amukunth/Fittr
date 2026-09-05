import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useFitnessProfile } from '../hooks/useFitnessProfile';
import { useBoutHistory } from '../hooks/useBoutHistory';
import { formatScore } from '../lib/boutStats';
import { fmtPoints } from '../lib/format';
import { initialsOf, ownHandle, peerHandle } from '../lib/identity';
import type { RootStackParamList } from '../navigation/types';
import type {
  ChallengeRow,
  MatchParticipantRow,
  MatchRow,
} from '../types/database';
import {
  EXERCISE_LABEL,
  EXERCISE_RULES,
  EXERCISE_SCORE,
  FORMAT_LABEL,
  SEATS,
  STATUS_LABEL,
  TIER_COLOR,
  TIER_LABEL,
  UNIT,
} from '../theme/copy';
import { colors, fonts, label, space } from '../theme/tokens';
import {
  Avatar,
  Body,
  Button,
  Card,
  Display,
  Dock,
  IconCircle,
  Label,
  Loading,
  Notice,
  Numeral,
  Slots,
  StatCard,
  Tag,
  TopBar,
} from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'ChallengeDetail'>;

export function ChallengeDetailScreen({ route, navigation }: Props) {
  const { challengeId } = route.params;
  const { session } = useAuth();
  const { profile } = useFitnessProfile();
  const { stats } = useBoutHistory();

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

  const back = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('Home');
    }
  };

  const share = () => {
    if (!challenge) {
      return;
    }
    Share.share({
      message: `Take my ${EXERCISE_LABEL[challenge.type].toLowerCase()} bout on Fittr. ${fmtPoints(challenge.stake_points)} ${UNIT} on the line.`,
    }).catch(() => undefined);
  };

  if (loading) {
    return <Loading />;
  }

  if (!challenge) {
    return (
      <View style={styles.screen}>
        <TopBar
          left={<IconCircle icon="arrow-left" accessibilityLabel="Back" onPress={back} />}
        />
        <View style={styles.missing}>
          <Display size={44}>NOT ON{'\n'}THE CARD.</Display>
          <Body muted style={styles.missingBody}>
            {error ?? "That bout isn't on the card any more."}
          </Body>
        </View>
      </View>
    );
  }

  const me = session?.user.id ?? null;
  const isOwn = challenge.created_by === me;
  const otherId =
    participants.find(p => p.user_id !== me)?.user_id ??
    (isOwn ? null : challenge.created_by);
  const otherHandle = otherId ? peerHandle(otherId) : null;
  const myHandle = ownHandle(session);
  const myTier = profile?.strength_tier ?? null;

  const open = challenge.status === 'open';
  const live = challenge.status === 'matched' || challenge.status === 'in_progress';
  const decided =
    challenge.status === 'completed' || challenge.status === 'needs_review';
  const filled = open ? 1 : SEATS;
  const stake = challenge.stake_points;
  const balance = profile?.points_balance ?? null;
  const short = balance === null ? 0 : Math.max(0, stake - balance);
  const canJoin = open && !isOwn;
  // The other corner's tier is only knowable once the seat is taken:
  // join_challenge() refuses a mismatch, so a matched opponent is in my class.
  const otherTier = !open && myTier ? myTier : null;
  const record = stats ? `${stats.wins}–${stats.losses}` : '—';
  const best = stats
    ? formatScore(stats.bestByType[challenge.type] ?? null, challenge.type)
    : '—';

  return (
    <View style={styles.screen}>
      <TopBar
        left={<IconCircle icon="arrow-left" accessibilityLabel="Back" onPress={back} />}
        right={
          <IconCircle
            icon="share"
            color={colors.secondary}
            accessibilityLabel="Share this bout"
            onPress={share}
          />
        }
      />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View>
          <View style={styles.statusRow}>
            <Tag label={FORMAT_LABEL[challenge.format]} />
            <Label size={11} tracking={0.12}>
              {isOwn
                ? `${STATUS_LABEL[challenge.status]} · YOUR CALL-OUT`
                : STATUS_LABEL[challenge.status]}
            </Label>
          </View>
          <Display size={56} style={styles.title}>
            {EXERCISE_LABEL[challenge.type]}
          </Display>
        </View>

        <View style={styles.grid}>
          <StatCard label="STAKE" value={fmtPoints(stake)} unit={UNIT} style={styles.half} />
          <StatCard
            label="WINNER TAKES"
            value={fmtPoints(stake * SEATS)}
            unit={UNIT}
            accent
            style={styles.half}
          />
        </View>

        <Card>
          <Label style={styles.centered}>TALE OF THE TAPE</Label>
          <View style={styles.tapeHead}>
            <View style={styles.corner}>
              <Avatar
                initials={otherHandle ? initialsOf(otherHandle) : '?'}
                size={44}
                tone={otherHandle ? 'raised' : 'empty'}
              />
              <Text style={styles.tapeName}>{otherHandle ?? 'open seat'}</Text>
              <Text
                style={[
                  styles.tapeTier,
                  otherTier ? { color: TIER_COLOR[otherTier] } : null,
                ]}
              >
                {otherTier ? TIER_LABEL[otherTier].toUpperCase() : '—'}
              </Text>
            </View>
            <Display size={22} color={colors.dim}>
              VS
            </Display>
            <View style={[styles.corner, styles.cornerRight]}>
              <Avatar initials={initialsOf(myHandle)} size={44} tone="accent" />
              <Text style={styles.tapeName}>you</Text>
              <Text
                style={[styles.tapeTier, myTier ? { color: TIER_COLOR[myTier] } : null]}
              >
                {myTier ? TIER_LABEL[myTier].toUpperCase() : '—'}
              </Text>
            </View>
          </View>
          <View style={styles.tapeRows}>
            <TapeRow left="—" label="RECORD" right={record} />
            <TapeRow
              left="—"
              label={`BEST ${EXERCISE_SCORE[challenge.type]}`}
              right={best}
            />
            <TapeRow left="—" label="STREAK" right={stats?.streak ?? '—'} />
          </View>
        </Card>

        <Card>
          <View style={styles.spotsHead}>
            <Label>SPOTS CLAIMED</Label>
            <Text style={styles.spotsText}>
              {filled} <Text style={styles.spotsOf}>of</Text> {SEATS}
            </Text>
          </View>
          <Slots filled={filled} max={SEATS} height={6} gap={4} style={styles.slots} />
        </Card>

        <View style={styles.rules}>
          <Label>RULES</Label>
          <Text style={styles.rulesText}>
            {EXERCISE_RULES[challenge.type]} Camera verified. Partial reps
            don't count.
          </Text>
          <View style={styles.verified}>
            <Label>VERIFIED BY</Label>
            <Label color={colors.secondary} tracking={0.06}>
              POSE ESTIMATION · LIVENESS CHECK
            </Label>
          </View>
        </View>
      </ScrollView>

      <Dock>
        {error ? (
          <Notice icon="warning" style={styles.notice}>
            {error}
          </Notice>
        ) : null}

        {canJoin && short > 0 ? (
          <>
            <Notice icon="warning" style={styles.notice}>
              {`You're ${fmtPoints(short)} ${UNIT} short. Win a smaller bout first.`}
            </Notice>
            <Button label={`ACCEPT · ${fmtPoints(stake)} ${UNIT}`} disabled />
          </>
        ) : null}

        {canJoin && short === 0 ? (
          <Button
            label={`ACCEPT · ${fmtPoints(stake)} ${UNIT}`}
            onPress={join}
            loading={joining}
          />
        ) : null}

        {open && isOwn ? (
          <>
            <Notice icon="clock" iconColor={colors.secondary} style={styles.notice}>
              Posted. Waiting on somebody at your level to take it.
            </Notice>
            <Button
              label="BACK TO BOUTS"
              variant="secondary"
              onPress={() => navigation.navigate('Home')}
            />
          </>
        ) : null}

        {!open && !match ? (
          <>
            <Notice icon="clock" iconColor={colors.secondary} style={styles.notice}>
              This seat is taken. Find another bout.
            </Notice>
            <Button
              label="FIND ANOTHER"
              variant="secondary"
              onPress={() => navigation.navigate('Home')}
            />
          </>
        ) : null}

        {match && live ? (
          <Button
            label="ENTER THE RING"
            onPress={() =>
              navigation.navigate('MatchInProgress', { matchId: match.id })
            }
          />
        ) : null}

        {/* needs_review is a settled-enough state to have results worth
            showing (scores are in, the payout is just held). Gating only on
            'completed' would make a flagged match unreachable from here. */}
        {match && decided ? (
          <Button
            label={
              challenge.status === 'needs_review'
                ? 'SEE THE DECISION · UNDER REVIEW'
                : 'SEE THE DECISION'
            }
            onPress={() => navigation.navigate('Results', { matchId: match.id })}
          />
        ) : null}
      </Dock>
    </View>
  );
}

/** One row of the tape: their figure, the label, my figure. */
function TapeRow({
  left,
  label: name,
  right,
}: {
  left: string;
  label: string;
  right: string;
}) {
  return (
    <View style={styles.tapeRow}>
      <Numeral size={22} style={styles.tapeCell}>
        {left}
      </Numeral>
      <Label tracking={0.12}>{name}</Label>
      <Numeral size={22} style={[styles.tapeCell, styles.tapeCellRight]}>
        {right}
      </Numeral>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: {
    paddingTop: 22,
    paddingHorizontal: space.gutter,
    paddingBottom: space.gutter,
    gap: space.xl,
  },
  missing: { flex: 1, justifyContent: 'center', paddingHorizontal: space.xxl },
  missingBody: { marginTop: space.md },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { marginTop: space.md },
  grid: { flexDirection: 'row', gap: space.sm },
  half: { flex: 1 },

  centered: { textAlign: 'center' },
  tapeHead: {
    marginTop: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  corner: { flex: 1, alignItems: 'flex-start' },
  cornerRight: { alignItems: 'flex-end' },
  tapeName: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.text,
    marginTop: space.sm,
    includeFontPadding: false,
  },
  tapeTier: { ...label(10, colors.dim, 0.12), marginTop: space.xs },
  tapeRows: { marginTop: space.cardPad, gap: space.sm + 2 },
  tapeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  tapeCell: { flex: 1 },
  tapeCellRight: { textAlign: 'right' },

  spotsHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  spotsText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.text,
    includeFontPadding: false,
  },
  spotsOf: { color: colors.dim },
  slots: { marginTop: space.sm + 2 },

  rules: { paddingHorizontal: space.xs, gap: space.sm },
  rulesText: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 21,
    color: colors.secondary,
  },
  verified: { flexDirection: 'row', alignItems: 'center', gap: space.sm },

  notice: { marginBottom: space.sm + 2 },
});
