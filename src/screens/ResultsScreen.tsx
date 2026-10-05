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
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PayoutCurve } from '../components/PayoutCurve';
import { channelName, supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { outcomeOf, rawFor, scoreFor, sortByScore } from '../lib/boutStats';
import { fmtPoints } from '../lib/format';
import { peerHandle } from '../lib/identity';
import { fmtPlace, prizeFor } from '../lib/pooled';
import { fmtRaw, fmtScore, formPctOf, rawUnit } from '../lib/score';
import { ratingResultFor, type RatingResult } from '../lib/skillRating';
import { blitzRunForMatch, fmtMultiplier, streakRunIdForMatch } from '../lib/soloModes';
import type { RootStackParamList } from '../navigation/types';
import type {
  BlitzRunRow,
  ChallengeRow,
  MatchParticipantRow,
  MatchRow,
  PointsLedgerEntryRow,
  RankedMode,
  SkillRatingEventRow,
} from '../types/database';
import { EXERCISE_LABEL, UNIT, isSoloFormat } from '../theme/copy';
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
  Numeral,
  RankedBadge,
} from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Results'>;

type Kind = 'win' | 'loss' | 'tie' | 'placed' | 'pending' | 'review';

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
  // What this bout did to my rating for this exercise. RLS scopes the table
  // to my own rows, so at most one row comes back and it is always mine --
  // an opponent's rating is never on the wire. Null until settlement has
  // written it, and for any bout fought before ratings existed.
  const [ratingEvent, setRatingEvent] = useState<SkillRatingEventRow | null>(
    null,
  );
  /**
   * The Blitz run behind this match, when there is one. Null for a
   * head-to-head bout and for a Streak stage -- a Streak stage never renders
   * here at all, it redirects to StreakRun (see the effect below).
   */
  const [blitzRun, setBlitzRun] = useState<BlitzRunRow | null>(null);
  const [loading, setLoading] = useState(true);

  // settle_match() is normally invoked inside submit_verification_session() the
  // moment the last result lands, so this is only a safety net: matches
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

    const [
      { data: challengeData },
      { data: participantData },
      { data: ledger },
      { data: rating },
    ] = await Promise.all([
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
        supabase
          .from('skill_rating_events')
          .select('*')
          .eq('match_id', matchId)
          .maybeSingle(),
      ]);

    const challengeRow = (challengeData ?? null) as ChallengeRow | null;
    setChallenge(challengeRow);
    setParticipants((participantData ?? []) as MatchParticipantRow[]);
    setLedgerEntries((ledger ?? []) as PointsLedgerEntryRow[]);
    setRatingEvent((rating ?? null) as SkillRatingEventRow | null);

    // A fifth read, and only for a Blitz. Deliberately not folded into the
    // Promise.all above: it needs the challenge's format to know whether
    // there is anything to fetch, and a blitz_runs read on every 1v1 result
    // would be a wasted round trip on the commonest screen in the app.
    if (challengeRow?.format === 'blitz') {
      setBlitzRun(await blitzRunForMatch(matchId));
    }
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
  // moment the *last opponent* finishes, with no extra migration. `matches` is not
  // published (it has no user column to filter on); see BACKEND.md.
  useEffect(() => {
    const challengeId = match?.challenge_id;
    if (!challengeId) {
      return;
    }
    const channel = supabase
      .channel(channelName(`results:${challengeId}`))
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
  // The ledger net is derived before the outcome because outcomeOf() needs
  // it as the fallback tell for rows without a place. RLS scopes the
  // ledger to my rows, so this is my net.
  const net = ledgerEntries.reduce((sum, e) => sum + e.amount, 0);
  const stake = challenge?.stake_points ?? 0;
  const solo = challenge ? isSoloFormat(challenge.format) : false;
  const mine = participants.find(p => p.user_id === me) ?? null;
  const kind: Kind = !match
    ? 'pending'
    : outcomeOf(
        match,
        challenge?.status ?? 'matched',
        me ?? '',
        net,
        stake,
        solo,
        mine?.place ?? null,
      );

  /**
   * A Streak stage never renders here. Everything a fighter needs to know
   * after one -- next stage, revive, payout, the five-hour window -- is a
   * fact about the RUN, and StreakRun owns all three states of it. This
   * screen is still the destination the Compete feed and the camera's
   * fallback use, so it has to forward rather than refuse.
   *
   * `replace`, so back does not bounce between the two.
   */
  useEffect(() => {
    if (challenge?.format !== 'streak') {
      return;
    }
    let cancelled = false;
    streakRunIdForMatch(matchId).then(found => {
      if (!cancelled && found) {
        navigation.replace('StreakRun', { runId: found.runId });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [challenge?.format, matchId, navigation]);

  // The rating line. Null until settlement has rated the bout; a number
  // only once this exercise is placed -- see showsDelta() for why placement
  // bouts stay silent. A casual bout has no event row at all, by
  // construction, so the screen shows no rating line rather than a "0".
  const rating = ratingResultFor(ratingEvent);

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

  const home = () => navigation.navigate('Compete');

  if (loading) {
    return <Loading />;
  }

  const mode: RankedMode = challenge?.is_ranked ? 'ranked' : 'casual';

  // A Blitz result is not a win or a loss against anybody, so it does not
  // borrow either screen: it shows where the score landed on the curve, the
  // multiplier that paid, and the payout. The lime flood is still reserved
  // for "you took something", which here means the bar was cleared.
  if (challenge && challenge.format === 'blitz' && blitzRun?.settled_at) {
    return (
      <BlitzResult
        run={blitzRun}
        challenge={challenge}
        mode={mode}
        rating={rating}
        onHome={home}
        onAgain={() =>
          navigation.replace('ExerciseModes', { exerciseType: challenge.type, mode: 'blitz' })
        }
      />
    );
  }

  // A solo round that has not settled yet -- in practice only one held for
  // anomaly review, since there is no opponent to wait for -- falls through to
  // the shared pending / review states below, which already say the right
  // thing about a held pot.

  const type = challenge?.type ?? 'pushups';
  const seats = challenge?.max_participants ?? 2;
  const pooled = challenge?.format === 'pooled';
  const myScore = mine ? scoreFor(mine) : null;
  // The whole field, best first, unscored last. Every branch below reads
  // from this one ordering so a six-seat card and a 1v1 card agree on who
  // leads, and the top score is the bar's 100%.
  const rows = sortByScore(
    participants.map(p => ({
      userId: p.user_id,
      name: p.user_id === me ? 'you' : peerHandle(p.user_id),
      score: scoreFor(p),
      raw: rawFor(p, type),
      place: p.place ?? null,
    })),
  );
  const best = rows[0]?.score ?? null;
  const opponents = rows.filter(r => r.userId !== me);
  const others = opponents.length;
  const isGroup = others > 1;
  // The best opponent: the runner-up when I won, the leader when I lost.
  const leader = opponents[0]?.score ?? null;
  const oppName = opponents[0]?.name ?? 'the other corner';
  const margin = myScore !== null && leader !== null ? fmtScore(Math.abs(myScore - leader)) : '—';
  const exercise = EXERCISE_LABEL[type].toUpperCase();
  const pot = stake * seats;
  const scoreRows: ScoreRow[] = rows.map((r, i) => {
    // Placings come from settlement; before it, the order on this card is
    // provisional, and the number says so by being absent.
    const place = r.place ?? (match?.settled_at ? i + 1 : null);
    const pct = formPctOf(r.raw, r.score);
    return {
      id: r.userId,
      name: r.name,
      score: fmtScore(r.score),
      sub:
        r.score === null
          ? 'not in yet'
          : `${fmtRaw(r.raw, type)} ${rawUnit(type).toLowerCase()} · ${pct === null ? '—' : `${pct}%`} form`,
      place: pooled && place !== null ? fmtPlace(place) : null,
      prize:
        pooled && place !== null && match?.settled_at
          ? prizeFor(pot, place)
          : null,
      pct: ratio(r.score, best),
      // Whoever shares the top score is bold. On the win screen that is me by
      // definition, and only me: a shared top would have settled as a tie.
      strong: kind === 'win' ? r.userId === me : best !== null && r.score === best,
    };
  });
  // The pot is every seat's stake, so a group win pays more than `stake`.
  const winnings = net > 0 ? net : stake;

  const share = () => {
    const tape = `${fmtScore(myScore)} to ${fmtScore(leader)}`;
    const line =
      kind === 'win'
        ? `Took the pot on Fittr: ${EXERCISE_LABEL[type].toLowerCase()}, ${tape}. +${fmtPoints(winnings)} ${UNIT}.`
        : `${EXERCISE_LABEL[type]} on Fittr: ${tape}.`;
    Share.share({ message: line }).catch(() => undefined);
  };

  // A rematch is a fresh search on the same terms. Matchmaking is a live
  // queue, so there is no way to re-challenge one fighter directly — the
  // next opponent is whoever the queue pairs, the same one if they search too.
  const rematch = () => {
    if (!challenge || isSoloFormat(challenge.format)) {
      return;
    }
    if (challenge.format === 'pooled') {
      // The next featured competition, not this one again.
      navigation.replace('Pooled');
      return;
    }
    navigation.replace('Searching', {
      exerciseType: challenge.type,
      format: '1v1',
      maxParticipants: challenge.max_participants,
      stake: challenge.stake_points,
      // A rematch keeps the mode it was played in, rather than resetting to
      // casual: it is a continuation of the same intent, not a fresh visit
      // to the mode screen (which is the one place the default has to reset).
      mode: challenge.is_ranked ? 'ranked' : 'casual',
    });
  };

  const headPad = { paddingTop: insets.top + space.xl };
  const shakeStyle = { transform: [{ translateX: shake }] };
  const myPlace = mine?.place ?? null;

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
        <Animated.ScrollView
          contentContainerStyle={styles.body}
          showsVerticalScrollIndicator={false}
          style={shakeStyle}
        >
          <Display size={64} tracking={-0.015} color={colors.onAccent}>
            {pooled ? 'FIRST OF\nTHE FIELD.' : 'YOU TOOK\nTHE POT.'}
          </Display>
          <View style={styles.deltaRow}>
            <Numeral size={120} color={colors.onAccent}>
              {`+${fmtPoints(winnings)}`}
            </Numeral>
            <Label size={14} color={colors.onAccentMuted} tracking={0.2}>
              {UNIT}
            </Label>
          </View>
          <ScoreCard
            onAccent
            rows={scoreRows}
            caption={pooled ? `${exercise} · ${seats} SEATS · POT ${fmtPoints(pot)}` : `${exercise} · MARGIN ${margin}`}
          />
          {/* Whether this one counted, on the record of it. */}
          <View style={styles.badgeRow}>
            <RankedBadge mode={mode} onAccent />
          </View>
          {rating ? <RatingLine result={rating} onAccent /> : null}
        </Animated.ScrollView>
        <Dock transparent style={styles.dock}>
          <Button label="SHARE THE CARD" variant="onAccentDark" icon="share" onPress={share} />
          <Button
            label="FIND THE NEXT ONE"
            variant="onAccentGhost"
            onPress={() => navigation.navigate('Compete')}
          />
        </Dock>
      </View>
    );
  }

  let head: React.ReactNode;
  let detail: string | null = null;
  let caption: string;
  let kicker = 'VERIFIED · SETTLED';
  if (kind === 'loss') {
    head = (
      <Display size={64} tracking={-0.015} color={colors.secondary}>
        {pooled ? 'OUT OF\n' : 'THEY GOT\n'}
        <Text style={styles.white}>{pooled ? 'THE MONEY.' : 'YOU.'}</Text>
      </Display>
    );
    caption = pooled
      ? `${exercise} · ${myPlace ? `${fmtPlace(myPlace)} OF ${seats}` : 'UNPLACED'}`
      : `${exercise} · SHORT BY ${margin}`;
  } else if (kind === 'placed') {
    head = (
      <Display size={64} tracking={-0.015}>
        IN THE{'\n'}
        <Text style={styles.accentText}>MONEY.</Text>
      </Display>
    );
    detail = `${myPlace ? fmtPlace(myPlace) : 'Placed'} of ${seats}. Not the top score, but a paid seat.`;
    caption = `${exercise} · ${myPlace ? fmtPlace(myPlace) : 'PLACED'} OF ${seats} · POT ${fmtPoints(pot)}`;
  } else if (kind === 'tie') {
    head = (
      <Display size={64} tracking={-0.015}>
        DEAD{'\n'}HEAT.
      </Display>
    );
    // A 1v1 tie refunds both stakes; a pooled tie splits the places the tied
    // fighters occupy, so there is something to show for it.
    caption = net > 0 ? `${exercise} · POT SHARED` : `${exercise} · STAKES REFUNDED`;
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
    const waiting = opponents.filter(o => o.score === null).length;
    const seatsOpen = Math.max(0, seats - participants.length);
    if (!match) {
      detail = "The results for this bout aren't in.";
    } else if (pooled && seatsOpen > 0) {
      detail = `${seatsOpen} seat${seatsOpen === 1 ? '' : 's'} still to fill. The board is ranked and paid the moment the last score lands. This screen updates itself.`;
    } else if (waiting > 0) {
      // A 1v1 names the opponent; a field counts them.
      detail = isGroup
        ? `Waiting on ${waiting} of ${others} to record their round. This screen updates itself.`
        : `Waiting on ${oppName} to record their round. This screen updates itself.`;
    } else if (myScore === null) {
      // Everyone but me has recorded: this screen was opened before my round.
      detail = 'The field is in. It comes down to your round.';
    } else {
      detail = 'Every result is in. The decision is landing now.';
    }
    caption = `${exercise} · ${pooled ? 'THE BOARD SO FAR' : isGroup ? 'WAITING ON THE FIELD' : 'WAITING ON THE OTHER CORNER'}`;
    kicker = 'WAITING ON RESULTS';
  }

  // A 1v1 tie nets 0 (stake refunded). A pooled tie or a place nets a
  // share, so the sign is shown either way.
  const netText =
    net === 0 ? '0' : `${net > 0 ? '+' : '−'}${fmtPoints(Math.abs(net))}`;
  const deltaText =
    kind === 'tie' || kind === 'placed' ? netText : kind === 'loss' ? `−${fmtPoints(stake)}` : fmtPoints(net);
  const deltaColor = kind === 'placed' ? colors.accent : colors.dim;

  return (
    <View style={styles.screen}>
      <Text style={styles.watermarkLoss} pointerEvents="none">
        {kind === 'loss' ? 'L' : kind === 'tie' ? 'T' : kind === 'placed' && myPlace ? String(myPlace) : ''}
      </Text>
      <View style={[styles.head, headPad]}>
        <View style={styles.verified}>
          <Icon name="seal-check" size={14} color={colors.dim} contrast={colors.bg} />
          <Label size={11}>{kicker}</Label>
        </View>
        <IconCircle icon="x" color={colors.secondary} accessibilityLabel="Close" onPress={home} />
      </View>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {head}
        {detail ? (
          <Body muted style={styles.detail}>
            {detail}
          </Body>
        ) : null}
        {kind === 'loss' || kind === 'tie' || kind === 'placed' ? (
          <View style={styles.deltaRow}>
            <Numeral size={110} color={deltaColor}>
              {deltaText}
            </Numeral>
            <Label size={14} tracking={0.2}>
              {UNIT}
            </Label>
          </View>
        ) : null}
        {match ? <ScoreCard rows={scoreRows} caption={caption} /> : null}
        {match ? (
          <View style={styles.badgeRow}>
            <RankedBadge mode={mode} />
          </View>
        ) : null}
        {rating ? <RatingLine result={rating} /> : null}
      </ScrollView>
      <Dock style={styles.dock}>
        {kind === 'loss' || kind === 'tie' || kind === 'placed' ? (
          <Button
            label={pooled ? 'THE NEXT POOL' : `REMATCH · ${fmtPoints(stake)} ${UNIT}`}
            icon="rematch"
            onPress={rematch}
          />
        ) : null}
        <Button label="BACK TO COMPETE" variant="card" onPress={home} />
      </Dock>
    </View>
  );
}

/**
 * A settled Blitz, rendered as what it is: a score on a curve.
 *
 * Deliberately NOT the 1v1 win or loss screen with different words. There is
 * no opponent, no margin and no tale of the tape; the only comparison that
 * means anything is the one between the score and the two bars, so that is
 * the whole card. A miss keeps the dark screen and says how far short of
 * break-even the score fell, because "you needed 120 more" is the one thing
 * worth knowing on the way to trying again.
 */
function BlitzResult({
  run,
  challenge,
  mode,
  rating,
  onHome,
  onAgain,
}: {
  run: BlitzRunRow;
  challenge: ChallengeRow;
  mode: RankedMode;
  rating: RatingResult | null;
  onHome: () => void;
  onAgain: () => void;
}) {
  const insets = useSafeAreaInsets();
  const cleared = run.cleared === true;
  const score = run.score ?? 0;
  const bp = run.multiplier_bp ?? 0;
  const type = challenge.type;
  const exercise = EXERCISE_LABEL[type].toUpperCase();
  const short = Math.max(0, run.threshold_score - score);
  const net = (run.payout_points ?? 0) - run.stake_points;
  const headPad = { paddingTop: insets.top + space.xl };

  const share = () => {
    const line = cleared
      ? `Blitz on Fittr: scored ${fmtScore(score)} against a ${fmtScore(run.threshold_score)} bar, ${fmtMultiplier(bp)}. ${net >= 0 ? '+' : '−'}${fmtPoints(Math.abs(net))} ${UNIT}.`
      : `Blitz on Fittr: scored ${fmtScore(score)}. Missed the bar by ${fmtScore(short)}.`;
    Share.share({ message: line }).catch(() => undefined);
  };

  const summary = (
    <View style={[styles.blitzCard, { backgroundColor: cleared ? colors.onAccentWash : colors.card }]}>
      <PayoutCurve
        threshold={run.threshold_score}
        benchmark={run.benchmark_score}
        breakevenBp={run.breakeven_bp}
        maxBp={run.max_bp}
        markScore={score}
        height={240}
      />
      <Label color={cleared ? colors.onAccentFaint : colors.dim}>
        {`${exercise} · SCORED ${fmtScore(score)} · BAR ${fmtScore(run.threshold_score)} · STAKED ${fmtPoints(run.stake_points)}`}
      </Label>
    </View>
  );

  if (cleared) {
    return (
      <View style={styles.flood}>
        <Text style={styles.watermarkWin} pointerEvents="none">
          {fmtMultiplier(bp)}
        </Text>
        <View style={[styles.head, headPad]}>
          <View style={styles.verified}>
            <Icon name="seal-check" size={14} color={colors.onAccent} contrast={colors.accent} />
            <Label size={11} color={colors.onAccentMuted}>
              BLITZ · BAR CLEARED
            </Label>
          </View>
          <IconCircle
            icon="x"
            bg={colors.onAccentGhost}
            color={colors.onAccent}
            accessibilityLabel="Close"
            onPress={onHome}
          />
        </View>
        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          <Display size={60} tracking={-0.015} color={colors.onAccent}>
            {`${fmtMultiplier(bp)}`}{'\n'}{bp >= run.max_bp ? 'MAXED.' : 'PAID.'}
          </Display>
          <View style={styles.deltaRow}>
            <Numeral size={110} color={colors.onAccent}>
              {`${net >= 0 ? '+' : '−'}${fmtPoints(Math.abs(net))}`}
            </Numeral>
            <Label size={14} color={colors.onAccentMuted} tracking={0.2}>
              {`${UNIT} NET`}
            </Label>
          </View>
          {summary}
          <View style={styles.badgeRow}>
            <RankedBadge mode={mode} onAccent />
          </View>
          {rating ? <RatingLine result={rating} onAccent /> : null}
        </ScrollView>
        <Dock transparent style={styles.dock}>
          <Button label="SHARE THE CARD" variant="onAccentDark" icon="share" onPress={share} />
          <Button label="GO AGAIN" variant="onAccentGhost" onPress={onAgain} />
        </Dock>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.watermarkLoss} pointerEvents="none">
        0
      </Text>
      <View style={[styles.head, headPad]}>
        <View style={styles.verified}>
          <Icon name="seal-check" size={14} color={colors.dim} contrast={colors.bg} />
          <Label size={11}>BLITZ · UNDER THE BAR</Label>
        </View>
        <IconCircle icon="x" color={colors.secondary} accessibilityLabel="Close" onPress={onHome} />
      </View>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Display size={60} tracking={-0.015} color={colors.secondary}>
          SHORT OF{'\n'}
          <Text style={styles.white}>THE BAR.</Text>
        </Display>
        <Body muted style={styles.detail}>
          {`You needed ${fmtScore(run.threshold_score)} to break even and scored ${fmtScore(score)} — ${fmtScore(short)} short. The bar moves with your rank, so it will be here next time.`}
        </Body>
        <View style={styles.deltaRow}>
          <Numeral size={110} color={colors.dim}>
            {`−${fmtPoints(run.stake_points)}`}
          </Numeral>
          <Label size={14} tracking={0.2}>
            {UNIT}
          </Label>
        </View>
        {summary}
        <View style={styles.badgeRow}>
          <RankedBadge mode={mode} />
        </View>
        {rating ? <RatingLine result={rating} /> : null}
      </ScrollView>
      <Dock style={styles.dock}>
        <Button
          label={`GO AGAIN · ${fmtPoints(run.stake_points)} ${UNIT}`}
          icon="rematch"
          onPress={onAgain}
        />
        <Button label="BACK TO COMPETE" variant="card" onPress={onHome} />
      </Dock>
    </View>
  );
}

/**
 * What the bout did to this exercise's rank. During placement there is no
 * number -- the swing at K=100 is large enough to read as instability
 * rather than as the system finding a fighter's level -- so the caption
 * carries the progress instead and the space where a delta would go stays
 * empty. Once placed it is the plain Elo change: "+18", "−24".
 */
function RatingLine({
  result,
  onAccent,
}: {
  result: RatingResult;
  onAccent?: boolean;
}) {
  const strong = onAccent ? colors.onAccent : colors.text;
  const soft = onAccent ? colors.onAccentMuted : colors.dim;
  return (
    <View style={styles.rating}>
      {result.delta ? (
        <Numeral size={28} color={strong}>
          {result.delta}
        </Numeral>
      ) : null}
      <View style={styles.ratingText}>
        <Label size={9} color={soft} tracking={0.14}>
          RANK
        </Label>
        <Label size={11} color={strong} tracking={0.1}>
          {result.caption}
        </Label>
      </View>
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
  /** Participant id. Stub handles are six hex chars and can collide; ids can't. */
  id: string;
  name: string;
  /** The score, formatted. */
  score: string;
  /** "34 reps · 88% form", the raw count and the form behind the score. */
  sub: string;
  /** "1ST" on a pooled card once settled. */
  place: string | null;
  /** What that place paid, once settled. */
  prize: number | null;
  /** 0..1 share of the bar. */
  pct: number;
  strong: boolean;
}

/** The tale of the tape: one row per seat, best first, with proportional bars. */
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
  const faint = onAccent ? colors.onAccentFaint : colors.dim;
  const track = onAccent ? colors.onAccentGhost : colors.raised;
  const fillStrong = onAccent ? colors.onAccent : colors.text;
  const fillSoft = onAccent ? colors.onAccentFaint : colors.dim;
  // Up to six rows share the space two used to: the number shrinks and the
  // rows pack tighter. The bars keep their height so the ranking stays
  // legible.
  const crowded = rows.length > 2;
  const numeralSize = crowded ? 22 : 30;
  const cardStyle = {
    backgroundColor: onAccent ? colors.onAccentWash : colors.card,
    gap: crowded ? space.sm : space.md,
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
        const subStyle = { ...label(9, faint, 0.08), textTransform: 'none' as const };
        const fillStyle = {
          width: `${Math.round(row.pct * 100)}%` as DimensionValue,
          backgroundColor: row.strong ? fillStrong : fillSoft,
        };
        return (
          <React.Fragment key={row.id}>
            <View style={styles.scoreRow}>
              <View style={styles.scoreName}>
                <View style={styles.scoreNameRow}>
                  {row.place ? (
                    <Text style={[label(9, row.strong ? nameStrong : faint, 0.12)]}>{row.place}</Text>
                  ) : null}
                  <Text style={nameStyle}>{row.name}</Text>
                </View>
                <Text style={subStyle}>{row.sub}</Text>
              </View>
              <View style={styles.scoreRight}>
                <Numeral size={numeralSize} color={row.strong ? nameStrong : nameSoft}>
                  {row.score}
                </Numeral>
                {row.prize !== null ? (
                  <Text style={label(9, row.prize > 0 ? (onAccent ? nameStrong : colors.accent) : faint, 0.1)}>
                    {row.prize > 0 ? `+${fmtPoints(row.prize)}` : 'NO PRIZE'}
                  </Text>
                ) : null}
              </View>
            </View>
            <View style={[styles.track, trackStyle]}>
              <View style={[styles.fill, fillStyle]} />
            </View>
          </React.Fragment>
        );
      })}
      <Label color={faint}>{caption}</Label>
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
  body: { paddingTop: 26, paddingHorizontal: space.xxl, paddingBottom: space.lg },
  white: { color: colors.text },
  dimText: { color: colors.dim },
  accentText: { color: colors.accent },
  detail: { marginTop: 14 },
  rating: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.lg,
  },
  ratingText: { flex: 1, gap: 3 },
  deltaRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
    marginTop: 22,
  },
  badgeRow: { marginTop: space.lg },
  blitzCard: {
    marginTop: space.xxl,
    borderRadius: radius.card,
    padding: space.lg,
    gap: space.md,
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
    gap: space.md,
  },
  scoreName: { flex: 1, gap: 2 },
  scoreNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  scoreRight: { alignItems: 'flex-end', gap: 1 },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4 },
  dock: { gap: space.sm + 2 },
});
