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
import { channelName, supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import {
  formatScore,
  outcomeOf,
  scoreFor,
  sortByScore,
} from '../lib/boutStats';
import { fmtPoints, formatSeconds } from '../lib/format';
import { peerHandle } from '../lib/identity';
import { ratingResultFor, type RatingResult } from '../lib/skillRating';
import {
  blitzRunForMatch,
  blitzTiersOf,
  fmtMultiplier,
  fmtTarget,
  streakRunIdForMatch,
} from '../lib/soloModes';
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
  // it: settle_match() leaves winner_id NULL for ANY tie, so once a bout has
  // more than two seats winner_id alone cannot separate "shared the pot"
  // from "lost to the fighters who did". A fighter who kept more than -stake
  // was paid out. RLS scopes the ledger to my rows, so this is my net.
  const net = ledgerEntries.reduce((sum, e) => sum + e.amount, 0);
  const stake = challenge?.stake_points ?? 0;
  const solo = challenge ? isSoloFormat(challenge.format) : false;
  const kind: Kind = !match
    ? 'pending'
    : outcomeOf(
        match,
        challenge?.status ?? 'matched',
        me ?? '',
        net,
        stake,
        solo,
      );

  /**
   * A Streak stage never renders here. Everything a fighter needs to know
   * after one -- next stage, buy back in, payout, the five-hour window -- is a
   * fact about the RUN, and StreakRun owns all three states of it. This screen
   * is still the destination the Home feed and the camera's fallback use, so
   * it has to forward rather than refuse.
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
  // bouts stay silent.
  //
  // A casual bout has no event row at all, by construction: settle_match()
  // skips _mmr_rate_match() entirely, so nothing was written. That is why the
  // screen shows NO rating line rather than a "0" -- there is no change to
  // report, which is different from a change of zero.
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

  const home = () => navigation.navigate('Home');

  if (loading) {
    return <Loading />;
  }

  const mode: RankedMode = challenge?.is_ranked ? 'ranked' : 'casual';

  // A Blitz result is not a win or a loss against anybody, so it does not
  // borrow either screen: it shows the ladder with the rung that was reached
  // marked, the multiplier that rung paid, and the payout. The lime flood is
  // still reserved for "you took something", which here means tier 1 or
  // better.
  if (challenge && challenge.format === 'blitz' && blitzRun?.settled_at) {
    return (
      <BlitzResult
        run={blitzRun}
        challenge={challenge}
        mode={mode}
        rating={rating}
        onHome={home}
        onAgain={() =>
          navigation.replace('BlitzPre', { exerciseType: challenge.type })
        }
      />
    );
  }

  // A solo round that has not settled yet -- in practice only one held for
  // anomaly review, since there is no opponent to wait for -- falls through to
  // the shared pending / review states below, which already say the right
  // thing about a held pot.

  const type = challenge?.type ?? 'pushups';
  const mine = participants.find(p => p.user_id === me) ?? null;
  const myScore = mine ? scoreFor(mine, type) : null;
  // The whole field, best first, unscored last. Every branch below reads
  // from this one ordering so a six-seat card and a 1v1 card agree on who
  // leads, and the top score is the bar's 100%.
  const rows = sortByScore(
    participants.map(p => ({
      userId: p.user_id,
      name: p.user_id === me ? 'you' : peerHandle(p.user_id),
      score: scoreFor(p, type),
    })),
    type,
  );
  const best = rows[0]?.score ?? null;
  const opponents = rows.filter(r => r.userId !== me);
  const others = opponents.length;
  const isGroup = others > 1;
  // The best opponent: the runner-up when I won, the leader when I lost.
  const leader = opponents[0]?.score ?? null;
  const oppName = opponents[0]?.name ?? 'the other corner';
  // Margin against the best opponent. Absolute so race, where lower wins,
  // reads the same way as reps and holds.
  const margin =
    myScore !== null && leader !== null
      ? type === 'pushups'
        ? String(Math.abs(myScore - leader))
        : formatSeconds(Math.abs(myScore - leader))
      : '—';
  const exercise = EXERCISE_LABEL[type].toUpperCase();
  const scoreRows: ScoreRow[] = rows.map(r => ({
    id: r.userId,
    name: r.name,
    score: formatScore(r.score, type),
    // Race is a time, so the shortest bar would be the winner's; invert it.
    pct: type === 'race' ? ratio(best, r.score) : ratio(r.score, best),
    // Whoever shares the top score is bold. On the win screen that is me by
    // definition, and only me: a shared top would have settled as a tie.
    strong: kind === 'win' ? r.userId === me : best !== null && r.score === best,
  }));
  // The pot is every seat's stake, so a group win pays more than `stake`.
  const winnings = net > 0 ? net : stake;

  const share = () => {
    const tape = `${formatScore(myScore, type)} to ${formatScore(leader, type)}`;
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
    // Only ever rendered for a head-to-head bout: Blitz redirects to
    // BlitzResult and Streak redirects to StreakRun before either loss/tie
    // branch below can render, so `challenge.format` is always '1v1' or
    // 'pooled' here -- the cast states that instead of leaving it implicit.
    if (!challenge || isSoloFormat(challenge.format)) {
      return;
    }
    navigation.replace('Searching', {
      exerciseType: challenge.type,
      format: challenge.format as Extract<typeof challenge.format, '1v1' | 'pooled'>,
      maxParticipants: challenge.max_participants,
      stake: challenge.stake_points,
      // A rematch keeps the mode it was played in, rather than resetting to
      // casual: it is a continuation of the same intent, not a fresh visit
      // to Find a Bout (which is the one place the default has to reset).
      mode: challenge.is_ranked ? 'ranked' : 'casual',
    });
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
              {`+${fmtPoints(winnings)}`}
            </Numeral>
            <Label size={14} color={colors.onAccentMuted} tracking={0.2}>
              {UNIT}
            </Label>
          </View>
          <ScoreCard
            onAccent
            rows={scoreRows}
            caption={`${exercise} · MARGIN ${margin}`}
          />
          {/* Whether this one counted, on the record of it. */}
          <View style={styles.badgeRow}>
            <RankedBadge mode={mode} onAccent />
          </View>
          {rating ? <RatingLine result={rating} onAccent /> : null}
        </Animated.View>
        <Dock transparent style={styles.dock}>
          <Button label="SHARE THE CARD" variant="onAccentDark" icon="share" onPress={share} />
          <Button
            label="FIND THE NEXT ONE"
            variant="onAccentGhost"
            onPress={() => navigation.navigate('FindBout')}
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
    // A 1v1 tie refunds both stakes; a group tie splits the pot among the
    // tied fighters, so there is something to show for it.
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
    if (!match) {
      detail = "The results for this bout aren't in.";
    } else if (waiting > 0) {
      // A 1v1 names the opponent; a group counts them.
      detail = isGroup
        ? `Waiting on ${waiting} of ${others} to record their round. This screen updates itself.`
        : `Waiting on ${oppName} to record their round. This screen updates itself.`;
    } else if (myScore === null) {
      // Everyone but me has recorded: this screen was opened before my round.
      detail = 'The field is in. It comes down to your round.';
    } else {
      detail = 'Every result is in. The decision is landing now.';
    }
    caption = `${exercise} · ${isGroup ? 'WAITING ON THE FIELD' : 'WAITING ON THE OTHER CORNER'}`;
    kicker = 'WAITING ON RESULTS';
  }

  // A 1v1 tie nets 0 (stake refunded). A group tie splits the pot among the
  // tied fighters, so the net is positive; the sign is shown either way.
  const tieDelta =
    net === 0 ? '0' : `${net > 0 ? '+' : '−'}${fmtPoints(Math.abs(net))}`;
  const deltaText =
    kind === 'tie' ? tieDelta : kind === 'loss' ? `−${fmtPoints(stake)}` : fmtPoints(net);

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
        {match ? <ScoreCard rows={scoreRows} caption={caption} /> : null}
        {match ? (
          <View style={styles.badgeRow}>
            <RankedBadge mode={mode} />
          </View>
        ) : null}
        {rating ? <RatingLine result={rating} /> : null}
      </View>
      <Dock style={styles.dock}>
        {kind === 'loss' || kind === 'tie' ? (
          <Button
            label={`REMATCH · ${fmtPoints(stake)} ${UNIT}`}
            icon="rematch"
            onPress={rematch}
          />
        ) : null}
        <Button label="BACK TO BOUTS" variant="card" onPress={home} />
      </Dock>
    </View>
  );
}

/**
 * A settled Blitz, rendered as what it is: a ladder with a mark on the rung
 * that was reached.
 *
 * Deliberately NOT the 1v1 win or loss screen with different words. There is
 * no opponent, no margin and no tale of the tape; the only comparison that
 * means anything is the one between the score and the three bars, so that is
 * the whole card. Tier 0 keeps the dark screen and says which bar was missed
 * and by how much, because "you needed three more reps" is the one thing
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
  const tiers = blitzTiersOf(run);
  const reached = run.tier_reached ?? 0;
  const paid = reached > 0;
  const score = run.score ?? 0;
  const type = challenge.type;
  const exercise = EXERCISE_LABEL[type].toUpperCase();
  const missed = tiers[0]!.target - score;
  const headPad = { paddingTop: insets.top + space.xl };

  const share = () => {
    const line = paid
      ? `Blitz on Fittr: ${fmtTarget(score, type)} ${type === 'pushups' ? 'push-ups' : 'hold'} at ${fmtMultiplier(run.multiplier_bp ?? 0)}. +${fmtPoints(run.payout_points ?? 0)} ${UNIT}.`
      : `Blitz on Fittr: ${fmtTarget(score, type)}. Missed the first bar by ${fmtTarget(missed, type)}.`;
    Share.share({ message: line }).catch(() => undefined);
  };

  const ladder = (
    <View
      style={[
        styles.blitzLadder,
        { backgroundColor: paid ? colors.onAccentWash : colors.card },
      ]}
    >
      {tiers.map(tier => {
        const cleared = reached >= tier.tier;
        const isTop = reached === tier.tier;
        const strong = paid ? colors.onAccent : colors.text;
        const soft = paid ? colors.onAccentMuted : colors.secondary;
        const faint = paid ? colors.onAccentFaint : colors.dim;
        const ink = isTop ? strong : cleared ? soft : faint;
        return (
          <View key={tier.tier} style={styles.blitzRow}>
            <View style={styles.blitzLeft}>
              <Icon
                name={cleared ? 'check' : 'x'}
                size={12}
                color={cleared ? ink : faint}
              />
              <Label size={11} color={ink} tracking={0.1}>
                {`${fmtTarget(tier.target, type)} ${type === 'pushups' ? 'REPS' : 'HOLD'}`}
              </Label>
            </View>
            <Display size={isTop ? 22 : 18} color={ink}>
              {fmtMultiplier(tier.bp)}
            </Display>
          </View>
        );
      })}
      <Label color={paid ? colors.onAccentFaint : colors.dim}>
        {`${exercise} · YOU DID ${fmtTarget(score, type)} · STAKED ${fmtPoints(run.stake_points)}`}
      </Label>
    </View>
  );

  if (paid) {
    return (
      <View style={styles.flood}>
        <Text style={styles.watermarkWin} pointerEvents="none">
          {fmtMultiplier(run.multiplier_bp ?? 0)}
        </Text>
        <View style={[styles.head, headPad]}>
          <View style={styles.verified}>
            <Icon name="seal-check" size={14} color={colors.onAccent} contrast={colors.accent} />
            <Label size={11} color={colors.onAccentMuted}>
              {`BLITZ · TIER ${reached} OF 3`}
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
        <View style={styles.body}>
          <Display size={60} tracking={-0.015} color={colors.onAccent}>
            {`${fmtMultiplier(run.multiplier_bp ?? 0)}`}{'\n'}CLEARED.
          </Display>
          <View style={styles.deltaRow}>
            <Numeral size={110} color={colors.onAccent}>
              {`+${fmtPoints(run.payout_points ?? 0)}`}
            </Numeral>
            <Label size={14} color={colors.onAccentMuted} tracking={0.2}>
              {UNIT}
            </Label>
          </View>
          {ladder}
          <View style={styles.badgeRow}>
            <RankedBadge mode={mode} onAccent />
          </View>
          {rating ? <RatingLine result={rating} onAccent /> : null}
        </View>
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
          <Label size={11}>BLITZ · NO TIER</Label>
        </View>
        <IconCircle icon="x" color={colors.secondary} accessibilityLabel="Close" onPress={onHome} />
      </View>
      <View style={styles.body}>
        <Display size={60} tracking={-0.015} color={colors.secondary}>
          SHORT OF{'\n'}
          <Text style={styles.white}>THE FIRST.</Text>
        </Display>
        <Body muted style={styles.detail}>
          {`You needed ${fmtTarget(tiers[0]!.target, type)} for ${fmtMultiplier(tiers[0]!.bp)} and got ${fmtTarget(score, type)}. The bars move with your rank, so they will be here next time.`}
        </Body>
        <View style={styles.deltaRow}>
          <Numeral size={110} color={colors.dim}>
            {`−${fmtPoints(run.stake_points)}`}
          </Numeral>
          <Label size={14} tracking={0.2}>
            {UNIT}
          </Label>
        </View>
        {ladder}
        <View style={styles.badgeRow}>
          <RankedBadge mode={mode} />
        </View>
        {rating ? <RatingLine result={rating} /> : null}
      </View>
      <Dock style={styles.dock}>
        <Button
          label={`GO AGAIN · ${fmtPoints(run.stake_points)} ${UNIT}`}
          icon="rematch"
          onPress={onAgain}
        />
        <Button label="BACK TO BOUTS" variant="card" onPress={onHome} />
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
  score: string;
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
  const track = onAccent ? colors.onAccentGhost : colors.raised;
  const fillStrong = onAccent ? colors.onAccent : colors.text;
  const fillSoft = onAccent ? colors.onAccentFaint : colors.dim;
  // Up to six rows share the space two used to, on a screen that doesn't
  // scroll: the number shrinks and the rows pack tighter. The bars keep
  // their height so the ranking stays legible.
  const crowded = rows.length > 2;
  const numeralSize = crowded ? 24 : 30;
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
        const fillStyle = {
          width: `${Math.round(row.pct * 100)}%` as DimensionValue,
          backgroundColor: row.strong ? fillStrong : fillSoft,
        };
        return (
          <React.Fragment key={row.id}>
            <View style={styles.scoreRow}>
              <Text style={nameStyle}>{row.name}</Text>
              <Numeral size={numeralSize} color={row.strong ? nameStrong : nameSoft}>
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
  blitzLadder: {
    marginTop: space.xxl,
    borderRadius: radius.card,
    padding: space.lg,
    gap: space.md,
  },
  blitzRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  blitzLeft: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 2 },

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
