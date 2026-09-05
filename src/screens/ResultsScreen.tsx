import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Easing,
  Share,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { formatScore, scoreFor } from '../lib/boutStats';
import { fmtPoints, formatSeconds } from '../lib/format';
import { peerHandle } from '../lib/identity';
import type { RootStackParamList } from '../navigation/types';
import type {
  ChallengeRow,
  MatchParticipantRow,
  MatchRow,
  PointsLedgerEntryRow,
} from '../types/database';
import { EXERCISE_LABEL, UNIT } from '../theme/copy';
import { Icon } from '../theme/icons';
import { anton, colors, fonts, label, radius, space } from '../theme/tokens';
import {
  Body,
  Button,
  Display,
  Dock,
  IconCircle,
  Label,
  Loading,
  Notice,
  Numeral,
} from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Results'>;

type Kind = 'win' | 'loss' | 'tie' | 'pending' | 'review';

export function ResultsScreen({ route, navigation }: Props) {
  const { matchId } = route.params;
  const { session } = useAuth();
  const insets = useSafeAreaInsets();
  const [match, setMatch] = useState<MatchRow | null>(null);
  const [challenge, setChallenge] = useState<ChallengeRow | null>(null);
  const [participants, setParticipants] = useState<MatchParticipantRow[]>([]);
  // RLS scopes this to the signed-in user's own rows, so this is always
  // "my" stake/payout history for the match, not every participant's.
  const [ledgerEntries, setLedgerEntries] = useState<PointsLedgerEntryRow[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [rematching, setRematching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // settle_match() is normally invoked inside submit_verification_session() the
  // moment the second result lands, so this is only a safety net: matches
  // recorded before settlement existed, or stranded by a failed transaction.
  // Once per mount — it must not re-fire off its own refetch.
  const settleAttemptedRef = useRef(false);
  const shake = useRef(new Animated.Value(0)).current;

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
      const { error: settleError } = await supabase.rpc('settle_match', {
        p_match_id: matchId,
      });
      if (!settleError) {
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

  const me = session?.user.id ?? null;
  const settled = match?.settled_at != null;
  const needsReview = challenge?.status === 'needs_review';
  // winner_id NULL on a SETTLED match is a tie, not a loss — settle_match's
  // documented tie rule refunds both stakes and leaves no winner.
  const isTie = settled && match?.winner_id === null;
  const won = settled && match?.winner_id === me;
  const kind: Kind = !match
    ? 'pending'
    : needsReview
      ? 'review'
      : !settled
        ? 'pending'
        : isTie
          ? 'tie'
          : won
            ? 'win'
            : 'loss';

  // The win screen lands with a shake, per the design.
  useEffect(() => {
    if (kind !== 'win') {
      return;
    }
    Animated.sequence(
      [-6, 6, -4, 4, -2, 0].map(x =>
        Animated.timing(shake, {
          toValue: x,
          duration: 75,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ),
    ).start();
  }, [kind, shake]);

  const home = () => navigation.navigate('Home');

  if (loading) {
    return <Loading />;
  }

  const type = challenge?.type ?? 'pushups';
  const stake = challenge?.stake_points ?? 0;
  const mine = participants.find(p => p.user_id === me) ?? null;
  const opp = participants.find(p => p.user_id !== me) ?? null;
  const myScore = mine ? scoreFor(mine, type) : null;
  const oppScore = opp ? scoreFor(opp, type) : null;
  const oppHandle = opp ? peerHandle(opp.user_id) : 'the other corner';
  const net = ledgerEntries.reduce((sum, e) => sum + e.amount, 0);
  const margin =
    myScore !== null && oppScore !== null
      ? type === 'pushups'
        ? String(Math.abs(myScore - oppScore))
        : formatSeconds(Math.abs(myScore - oppScore))
      : '—';
  const exercise = EXERCISE_LABEL[type].toUpperCase();

  const share = () => {
    const line =
      kind === 'win'
        ? `Took the pot on Fittr: ${EXERCISE_LABEL[type].toLowerCase()}, ${formatScore(myScore, type)} to ${formatScore(oppScore, type)}. +${fmtPoints(stake)} ${UNIT}.`
        : `${EXERCISE_LABEL[type]} on Fittr: ${formatScore(myScore, type)} to ${formatScore(oppScore, type)}.`;
    Share.share({ message: line }).catch(() => undefined);
  };

  const rematch = async () => {
    if (!challenge || !session) {
      return;
    }
    setRematching(true);
    setError(null);
    const { data, error: insertError } = await supabase
      .from('challenges')
      .insert({
        type: challenge.type,
        format: challenge.format,
        stake_points: challenge.stake_points,
        created_by: session.user.id,
      })
      .select('id')
      .single();
    setRematching(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    navigation.replace('ChallengeDetail', { challengeId: data.id });
  };

  const headPad = { paddingTop: insets.top + space.xl };
  const shakeStyle = { transform: [{ translateX: shake }] };

  if (kind === 'win') {
    return (
      <View style={styles.flood}>
        <Confetti />
        <Text style={styles.watermarkWin} pointerEvents="none">
          W
        </Text>
        <View style={[styles.head, headPad]}>
          <View style={styles.verified}>
            <Icon name="seal-check" size={14} color={colors.onAccent} contrast={colors.accent} />
            <Label size={11} color={colors.onAccentMuted}>
              VERIFIED · SETTLED
            </Label>
          </View>
          <IconCircle
            icon="x"
            bg={colors.onAccentGhost}
            color={colors.onAccent}
            accessibilityLabel="Close"
            onPress={home}
          />
        </View>
        <Animated.View style={[styles.body, shakeStyle]}>
          <Display size={64} tracking={-0.015} color={colors.onAccent}>
            YOU TOOK{'\n'}THE POT.
          </Display>
          <View style={styles.deltaRow}>
            <Numeral size={120} color={colors.onAccent}>
              {`+${fmtPoints(net > 0 ? net : stake)}`}
            </Numeral>
            <Label size={14} color={colors.onAccentMuted} tracking={0.2}>
              {UNIT}
            </Label>
          </View>
          <ScoreCard
            onAccent
            rows={[
              { name: 'you', score: formatScore(myScore, type), pct: 1, strong: true },
              {
                name: oppHandle,
                score: formatScore(oppScore, type),
                pct: ratio(oppScore, myScore),
                strong: false,
              },
            ]}
            caption={`${exercise} · MARGIN ${margin}`}
          />
        </Animated.View>
        <Dock transparent style={styles.dock}>
          <Button label="SHARE THE CARD" variant="onAccentDark" icon="share" onPress={share} />
          <Button label="FIND THE NEXT ONE" variant="onAccentGhost" onPress={home} />
        </Dock>
      </View>
    );
  }

  const submittedCount = participants.filter(
    p => scoreFor(p, type) !== null,
  ).length;

  let head: React.ReactNode;
  let detail: string | null = null;
  let caption: string;
  let kicker = 'VERIFIED · SETTLED';
  if (kind === 'loss') {
    head = (
      <Display size={64} tracking={-0.015} color={colors.secondary}>
        THEY GOT{'\n'}
        <Text style={styles.white}>YOU.</Text>
      </Display>
    );
    caption = `${exercise} · SHORT BY ${margin}`;
  } else if (kind === 'tie') {
    head = (
      <Display size={64} tracking={-0.015}>
        DEAD{'\n'}HEAT.
      </Display>
    );
    caption = `${exercise} · STAKES REFUNDED`;
  } else if (kind === 'review') {
    head = (
      <Display size={64} tracking={-0.015} color={colors.secondary}>
        UNDER{'\n'}
        <Text style={styles.white}>REVIEW.</Text>
      </Display>
    );
    detail =
      'The winning result tripped the on-device anomaly checks. The pot is held until a reviewer clears it.';
    caption = `${exercise} · POT HELD`;
    kicker = 'HELD FOR REVIEW';
  } else {
    head = (
      <Display size={64} tracking={-0.015}>
        NO DECISION{'\n'}
        <Text style={styles.dimText}>YET.</Text>
      </Display>
    );
    detail = !match
      ? "The results for this bout aren't in."
      : submittedCount < participants.length
        ? `Waiting on ${oppHandle} to record their round. This screen updates itself.`
        : 'Both results are in. The decision is landing now.';
    caption = `${exercise} · WAITING ON THE OTHER CORNER`;
    kicker = 'WAITING ON RESULTS';
  }

  const deltaText =
    kind === 'tie' ? '0' : kind === 'loss' ? `−${fmtPoints(stake)}` : fmtPoints(net);
  const oppLeads = kind === 'loss';

  return (
    <View style={styles.screen}>
      <Text style={styles.watermarkLoss} pointerEvents="none">
        {kind === 'loss' ? 'L' : kind === 'tie' ? 'T' : ''}
      </Text>
      <View style={[styles.head, headPad]}>
        <View style={styles.verified}>
          <Icon name="seal-check" size={14} color={colors.dim} contrast={colors.bg} />
          <Label size={11}>{kicker}</Label>
        </View>
        <IconCircle icon="x" color={colors.secondary} accessibilityLabel="Close" onPress={home} />
      </View>
      <View style={styles.body}>
        {head}
        {detail ? (
          <Body muted style={styles.detail}>
            {detail}
          </Body>
        ) : null}
        {kind === 'loss' || kind === 'tie' ? (
          <View style={styles.deltaRow}>
            <Numeral size={120} color={colors.dim}>
              {deltaText}
            </Numeral>
            <Label size={14} tracking={0.2}>
              {UNIT}
            </Label>
          </View>
        ) : null}
        {match ? (
          <ScoreCard
            rows={
              oppLeads
                ? [
                    { name: oppHandle, score: formatScore(oppScore, type), pct: 1, strong: true },
                    {
                      name: 'you',
                      score: formatScore(myScore, type),
                      pct: ratio(myScore, oppScore),
                      strong: false,
                    },
                  ]
                : [
                    {
                      name: 'you',
                      score: formatScore(myScore, type),
                      pct: myScore === null ? 0 : 1,
                      strong: true,
                    },
                    {
                      name: oppHandle,
                      score: formatScore(oppScore, type),
                      pct: kind === 'tie' ? 1 : ratio(oppScore, myScore),
                      strong: kind === 'tie',
                    },
                  ]
            }
            caption={caption}
          />
        ) : null}
      </View>
      <Dock style={styles.dock}>
        {error ? <Notice icon="warning">{error}</Notice> : null}
        {kind === 'loss' || kind === 'tie' ? (
          <Button
            label={`REMATCH · ${fmtPoints(stake)} ${UNIT}`}
            icon="rematch"
            onPress={rematch}
            loading={rematching}
          />
        ) : null}
        <Button label="BACK TO BOUTS" variant="card" onPress={home} />
      </Dock>
    </View>
  );
}

function ratio(part: number | null, whole: number | null): number {
  if (part === null || whole === null || whole <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, part / whole));
}

interface ScoreRow {
  name: string;
  score: string;
  /** 0..1 share of the bar. */
  pct: number;
  strong: boolean;
}

/** The you-versus-them comparison with proportional bars. */
function ScoreCard({
  rows,
  caption,
  onAccent,
}: {
  rows: ScoreRow[];
  caption: string;
  onAccent?: boolean;
}) {
  const nameStrong = onAccent ? colors.onAccent : colors.text;
  const nameSoft = onAccent ? colors.onAccentMuted : colors.secondary;
  const track = onAccent ? colors.onAccentGhost : colors.raised;
  const fillStrong = onAccent ? colors.onAccent : colors.text;
  const fillSoft = onAccent ? colors.onAccentFaint : colors.dim;
  const cardStyle = {
    backgroundColor: onAccent ? colors.onAccentWash : colors.card,
  };
  const trackStyle = { backgroundColor: track };
  return (
    <View style={[styles.scoreCard, cardStyle]}>
      {rows.map(row => {
        const nameStyle = {
          fontFamily: fonts.semibold,
          fontSize: 12,
          color: row.strong ? nameStrong : nameSoft,
        };
        const fillStyle = {
          width: `${Math.round(row.pct * 100)}%` as DimensionValue,
          backgroundColor: row.strong ? fillStrong : fillSoft,
        };
        return (
          <React.Fragment key={row.name}>
            <View style={styles.scoreRow}>
              <Text style={nameStyle}>{row.name}</Text>
              <Numeral size={30} color={row.strong ? nameStrong : nameSoft}>
                {row.score}
              </Numeral>
            </View>
            <View style={[styles.track, trackStyle]}>
              <View style={[styles.fill, fillStyle]} />
            </View>
          </React.Fragment>
        );
      })}
      <Label color={onAccent ? colors.onAccentFaint : colors.dim}>{caption}</Label>
    </View>
  );
}

const PIECES = 28;

/** Falling paper on the win screen. Loops until the screen goes away. */
function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: PIECES }, (_, i) => ({
        left: `${(i * 37) % 100}%` as DimensionValue,
        width: i % 3 ? 8 : 5,
        height: i % 2 ? 14 : 8,
        color: i % 4 === 0 ? colors.text : colors.onAccent,
        duration: 2600 + (i % 5) * 500,
        delay: (i % 9) * 180,
        progress: new Animated.Value(0),
      })),
    [],
  );

  useEffect(() => {
    const loops = pieces.map(p =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(p.delay),
          Animated.timing(p.progress, {
            toValue: 1,
            duration: p.duration,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
          Animated.timing(p.progress, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
      ),
    );
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, [pieces]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {pieces.map((p, i) => {
        const piece = {
          position: 'absolute' as const,
          left: p.left,
          top: -20,
          width: p.width,
          height: p.height,
          borderRadius: 2,
          backgroundColor: p.color,
          opacity: p.progress.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 0.6],
          }),
          transform: [
            {
              translateY: p.progress.interpolate({
                inputRange: [0, 1],
                outputRange: [-40, 900],
              }),
            },
            {
              rotate: p.progress.interpolate({
                inputRange: [0, 1],
                outputRange: ['0deg', '720deg'],
              }),
            },
          ],
        };
        return <Animated.View key={i} style={piece} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, overflow: 'hidden' },
  flood: { flex: 1, backgroundColor: colors.accent, overflow: 'hidden' },
  watermarkWin: {
    ...anton(420, { tracking: -0.05, color: colors.onAccentWatermark }),
    position: 'absolute',
    right: -30,
    top: 40,
  },
  watermarkLoss: {
    ...anton(420, { tracking: -0.05, color: colors.watermark }),
    position: 'absolute',
    right: -30,
    top: 40,
  },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space.xxl,
  },
  verified: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  body: { flex: 1, paddingTop: 26, paddingHorizontal: space.xxl },
  white: { color: colors.text },
  dimText: { color: colors.dim },
  detail: { marginTop: 14 },
  deltaRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
    marginTop: 22,
  },
  scoreCard: {
    marginTop: space.xxl,
    borderRadius: radius.card,
    padding: space.lg,
    gap: space.md,
  },
  scoreRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4 },
  dock: { gap: space.sm + 2 },
  captionOnAccent: { ...label(10, colors.onAccentFaint) },
});
