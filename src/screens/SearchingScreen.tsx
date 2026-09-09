import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Easing,
  StyleSheet,
  Text,
  View,
  type AppStateStatus,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { channelName, supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { fmtPoints, formatSeconds } from '../lib/format';
import { initialsOf, ownHandle } from '../lib/identity';
import {
  HEARTBEAT_MS,
  MATCH_COUNTDOWN_SECONDS,
  QUEUE_TTL_SECONDS,
  RANK_WIDEN_AFTER_SECONDS,
  cancelReasonCopy,
  enterErrorCopy,
  enterMatchmaking,
  heartbeat,
  isQueueEntryGone,
  leaveMatchmaking,
  type RpcResult,
} from '../lib/matchmaking';
import type { RootStackParamList } from '../navigation/types';
import type {
  MatchmakingCancelReason,
  MatchmakingQueueRow,
} from '../types/database';
import { EXERCISE_LABEL, EXERCISE_SCORE, FORMAT_LABEL, UNIT } from '../theme/copy';
import { anton, colors, fonts, label, radius, space } from '../theme/tokens';
import {
  Avatar,
  Body,
  Button,
  Card,
  Display,
  Dock,
  IconCircle,
  Label,
  LiveDot,
  Notice,
  Numeral,
  StatCard,
  Tag,
  TopBar,
} from '../theme/ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Searching'>;

/**
 * The live queue.
 *
 * Order of operations matters here, and each step exists because of a real
 * failure mode:
 *
 *  1. Subscribe to my own matchmaking_queue rows FIRST, with `wait: true` so
 *     SUBSCRIBED means the server's postgres_changes subscription is really
 *     established (the default callback fires when the channel joins, which
 *     can be before the replication side is listening). Only then call
 *     enter_matchmaking(). Doing it the other way round leaves a gap in
 *     which the lobby can fill and the 'matched' UPDATE is never seen.
 *  2. enter_matchmaking() is called exactly once. SUBSCRIBED fires again on
 *     every socket rejoin; a literal "on SUBSCRIBED, enter" would re-enter
 *     the queue after each Wi-Fi handover and lose the lobby seat.
 *  3. Events are keyed by row id, not just status: a user owns several rows
 *     within the 10-minute retention window and an old one can still emit
 *     an UPDATE (its lobby being swept, say). An event that arrives before
 *     the enter RPC has returned the id is parked and replayed.
 *  4. The heartbeat is the fallback for every missed event: it returns the
 *     row as the server sees it. Beats fire on a fixed interval without
 *     awaiting each other, each with its own timeout, so one stalled request
 *     cannot eat the 20-second TTL. Only 'background' pauses them — iOS
 *     'inactive' (notification shade, app switcher) keeps JS running and the
 *     user still expects to be found.
 *  5. Leaving goes through beforeRemove, so the back button, the close
 *     circle and the cancel button all take one path: ask the server to
 *     leave, and if it answers 'matched' (the lobby filled in the same
 *     instant, stakes already moved) go to the bout instead of popping.
 *  6. 'matched' is applied once, whether it comes from the RPC return, the
 *     realtime event or a heartbeat — the same row can arrive by all three.
 */

type Phase =
  | 'connecting'
  | 'searching'
  | 'matched'
  | 'ended'
  | 'error';

/** How long to wait for a confirmed subscription before entering anyway. */
const SUBSCRIBE_FALLBACK_MS = 4000;
/** A single heartbeat request may not take longer than this. */
const BEAT_TIMEOUT_MS = 8000;
/** Attempts at leaving before giving up and letting the TTL do it. */
const LEAVE_ATTEMPTS = 3;
/** No opponent in this long: stop searching and show the empty-result page. */
const SEARCH_TIMEOUT_SECONDS = 30;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function SearchingScreen({ route, navigation }: Props) {
  const request = route.params;
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const isGroup = request.format === 'pooled';
  const seats = request.maxParticipants;

  const [phase, setPhase] = useState<Phase>('connecting');
  const [lobbySize, setLobbySize] = useState(1);
  const [elapsed, setElapsed] = useState(0);
  const [countdown, setCountdown] = useState(MATCH_COUNTDOWN_SECONDS);
  const [message, setMessage] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const queueIdRef = useRef<string | null>(null);
  const enteredRef = useRef(false);
  const matchedRef = useRef(false);
  const goneRef = useRef(false);
  const phaseRef = useRef<Phase>('connecting');
  const pausedRef = useRef(AppState.currentState === 'background');
  const lastBeatOkRef = useRef(Date.now());
  const startedAtRef = useRef(Date.now());
  const parkedEventsRef = useRef(new Map<string, MatchmakingQueueRow>());
  const enterRef = useRef<() => void>(() => undefined);

  const setPhaseTracked = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  // ── Matched ───────────────────────────────────────────────────────────

  const onMatched = useCallback(
    (matchId: string) => {
      if (matchedRef.current) {
        return;
      }
      matchedRef.current = true;
      setPhaseTracked('matched');
      // The countdown is local theatre, not a synchronised start:
      // MatchInProgress is self-paced, so participants landing a second
      // apart costs nothing. It exists so the lobby-full moment is seen.
      let remaining = MATCH_COUNTDOWN_SECONDS;
      setCountdown(remaining);
      const tick = setInterval(() => {
        remaining -= 1;
        setCountdown(remaining);
        if (remaining <= 0) {
          clearInterval(tick);
          if (!goneRef.current) {
            navigation.replace('MatchInProgress', { matchId });
          }
        }
      }, 1000);
    },
    [navigation, setPhaseTracked],
  );

  const endSearch = useCallback(
    (reason: MatchmakingCancelReason | null) => {
      queueIdRef.current = null;
      setMessage(cancelReasonCopy(reason));
      setPhaseTracked('ended');
    },
    [setPhaseTracked],
  );

  /** Apply a fresh copy of my row, wherever it came from. */
  const applyRow = useCallback(
    (row: MatchmakingQueueRow) => {
      if (queueIdRef.current === null) {
        parkedEventsRef.current.set(row.id, row);
        return;
      }
      if (row.id !== queueIdRef.current || matchedRef.current) {
        return;
      }
      if (row.status === 'matched' && row.match_id) {
        onMatched(row.match_id);
        return;
      }
      if (row.status === 'cancelled') {
        endSearch(row.cancel_reason);
        return;
      }
      setLobbySize(prev => (prev === row.lobby_size ? prev : row.lobby_size));
      if (phaseRef.current === 'connecting') {
        setPhaseTracked('searching');
      }
    },
    [endSearch, onMatched, setPhaseTracked],
  );

  // ── Enter ─────────────────────────────────────────────────────────────

  const enter = useCallback(async () => {
    if (enteredRef.current || goneRef.current) {
      return;
    }
    enteredRef.current = true;
    const result: RpcResult<MatchmakingQueueRow> = await enterMatchmaking(request);
    if (goneRef.current) {
      // The screen went away while the RPC was in flight. A row nobody is
      // watching must not sit in the queue looking available.
      if (result.data && result.data.status === 'searching') {
        leaveMatchmaking(result.data.id).catch(() => undefined);
      }
      return;
    }
    if (result.data === null) {
      setMessage(enterErrorCopy(result.error));
      setPhaseTracked('error');
      return;
    }
    const row = result.data;
    queueIdRef.current = row.id;
    startedAtRef.current = new Date(row.joined_at).getTime() || Date.now();
    lastBeatOkRef.current = Date.now();
    setElapsed(0);
    setPhaseTracked('searching');
    // An event for this row may have landed while the RPC was in flight;
    // if so it is newer than the RPC's copy.
    const parked = parkedEventsRef.current.get(row.id);
    parkedEventsRef.current.clear();
    applyRow(parked ?? row);
  }, [applyRow, request, setPhaseTracked]);
  enterRef.current = () => {
    enter();
  };

  // ── Realtime ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!userId) {
      return;
    }
    goneRef.current = false;
    let fallback: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      fallback = null;
      console.warn('[Searching] realtime not confirmed in time; entering anyway (heartbeat covers it)');
      enterRef.current();
    }, SUBSCRIBE_FALLBACK_MS);

    const channel = supabase
      .channel(channelName(`searching:${userId}`), {
        config: { postgres_changes_options: { wait: true } },
      })
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'matchmaking_queue',
          filter: `user_id=eq.${userId}`,
        },
        payload => {
          applyRow(payload.new as MatchmakingQueueRow);
        },
      )
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          if (fallback) {
            clearTimeout(fallback);
            fallback = null;
          }
          if (!enteredRef.current) {
            enterRef.current();
          } else if (queueIdRef.current && !matchedRef.current) {
            // A rejoin after a socket drop: events in the gap are gone, so
            // ask the server where things stand.
            heartbeat(queueIdRef.current).then(result => {
              if (result.data && !goneRef.current) {
                lastBeatOkRef.current = Date.now();
                applyRow(result.data);
              }
            });
          }
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // Never silent: a table missing from the publication reports
          // exactly like this, and the heartbeat quietly masks it.
          console.warn(`[Searching] realtime ${status}: ${err?.message ?? 'no detail'}`);
        }
      });

    return () => {
      goneRef.current = true;
      if (fallback) {
        clearTimeout(fallback);
      }
      supabase.removeChannel(channel);
      // Sign-out or an OS kill mid-search: best effort. The server TTL is
      // the guarantee for the cases where this never runs.
      const id = queueIdRef.current;
      if (id && !matchedRef.current) {
        leaveMatchmaking(id).catch(() => undefined);
      }
    };
  }, [userId, applyRow]);

  // ── Heartbeat ─────────────────────────────────────────────────────────

  useEffect(() => {
    const beat = () => {
      const id = queueIdRef.current;
      if (!id || matchedRef.current || pausedRef.current || phaseRef.current !== 'searching') {
        return;
      }
      withTimeout(heartbeat(id), BEAT_TIMEOUT_MS).then(
        result => {
          if (goneRef.current || queueIdRef.current !== id) {
            return;
          }
          if (result.data === null) {
            // Gone from the server's side (swept, or ended from another
            // device): stop beating and say so. Anything else is transient.
            if (isQueueEntryGone(result.error)) {
              endSearch('expired');
            }
            return;
          }
          lastBeatOkRef.current = Date.now();
          applyRow(result.data);
        },
        () => undefined,
      );
    };
    const interval = setInterval(beat, HEARTBEAT_MS);

    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'background') {
        pausedRef.current = true;
        return;
      }
      if (next !== 'active' || !pausedRef.current) {
        return;
      }
      pausedRef.current = false;
      const id = queueIdRef.current;
      if (!id || matchedRef.current || phaseRef.current !== 'searching') {
        return;
      }
      // Away longer than the TTL: the server may or may not have swept us
      // yet depending on who else was in the domain. Make it deterministic
      // from this side — end the search here and let the server catch up.
      if (Date.now() - lastBeatOkRef.current > QUEUE_TTL_SECONDS * 1000) {
        leaveMatchmaking(id).then(result => {
          if (goneRef.current) {
            return;
          }
          if (result.data?.status === 'matched' && result.data.match_id) {
            onMatched(result.data.match_id);
          } else {
            endSearch('expired');
          }
        });
        return;
      }
      beat();
    });

    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [applyRow, endSearch, onMatched]);

  // ── Leaving ───────────────────────────────────────────────────────────

  const leaveWithRetry = useCallback(async (id: string) => {
    let last: RpcResult<MatchmakingQueueRow> = { data: null, error: 'not attempted' };
    for (let attempt = 0; attempt < LEAVE_ATTEMPTS; attempt += 1) {
      last = await leaveMatchmaking(id);
      if (last.data || isQueueEntryGone(last.error)) {
        return last;
      }
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
    return last;
  }, []);

  /**
   * Every way off this screen. Resolves true when it is safe to pop, false
   * when the user has instead been sent into a bout that filled as they left.
   */
  const leave = useCallback(async (): Promise<boolean> => {
    if (matchedRef.current) {
      return false;
    }
    const id = queueIdRef.current;
    if (!id) {
      return true;
    }
    setLeaving(true);
    const result = await leaveWithRetry(id);
    setLeaving(false);
    if (result.data?.status === 'matched' && result.data.match_id) {
      onMatched(result.data.match_id);
      return false;
    }
    queueIdRef.current = null;
    return true;
  }, [leaveWithRetry, onMatched]);

  // ── Clock ─────────────────────────────────────────────────────────────

  const timedOutRef = useRef(false);

  const giveUp = useCallback(async () => {
    if (timedOutRef.current || matchedRef.current || phaseRef.current !== 'searching') {
      return;
    }
    timedOutRef.current = true;
    // Same exit path as Cancel: if the lobby filled in the same instant as
    // the timeout fired, `leave` routes into the bout instead of ending.
    const ok = await leave();
    if (ok && !goneRef.current) {
      setMessage(`No fighters found in ${SEARCH_TIMEOUT_SECONDS}s. Try again, or pick a different stake.`);
      setPhaseTracked('ended');
    }
  }, [leave, setPhaseTracked]);

  useEffect(() => {
    if (phase !== 'searching') {
      return;
    }
    const tick = setInterval(() => {
      const secs = Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000));
      setElapsed(secs);
      if (secs >= SEARCH_TIMEOUT_SECONDS) {
        giveUp();
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [phase, giveUp]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', event => {
      // Our own replace() into the bout, or a search that already ended:
      // nothing left to leave.
      if (matchedRef.current || queueIdRef.current === null) {
        return;
      }
      event.preventDefault();
      leave().then(ok => {
        if (ok && !goneRef.current) {
          navigation.dispatch(event.data.action);
        }
      });
    });
    return unsubscribe;
  }, [navigation, leave]);

  const cancel = useCallback(() => {
    if (leaving || matchedRef.current) {
      return;
    }
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('FindBout');
    }
  }, [leaving, navigation]);

  const searchAgain = useCallback(() => {
    enteredRef.current = false;
    matchedRef.current = false;
    timedOutRef.current = false;
    queueIdRef.current = null;
    parkedEventsRef.current.clear();
    setMessage(null);
    setLobbySize(1);
    setPhaseTracked('connecting');
    enterRef.current();
  }, [setPhaseTracked]);

  // ── Render ────────────────────────────────────────────────────────────

  const myInitials = initialsOf(ownHandle(session));
  const widened = elapsed >= RANK_WIDEN_AFTER_SECONDS;
  const pot = request.stake * seats;
  const exercise = EXERCISE_LABEL[request.exerciseType];

  let pill: React.ReactNode;
  if (phase === 'matched') {
    pill = <Label size={11} color={colors.accent} tracking={0.12}>IT'S ON</Label>;
  } else if (phase === 'searching') {
    pill = (
      <>
        <LiveDot />
        <Label size={11} color={colors.secondary} tracking={0.12}>
          {isGroup ? 'LOBBY LIVE' : 'SEARCHING'} · {formatSeconds(elapsed)}
        </Label>
      </>
    );
  } else {
    pill = <Label size={11} color={colors.secondary} tracking={0.12}>{phase === 'connecting' ? 'CONNECTING' : 'SEARCH OVER'}</Label>;
  }

  return (
    <View style={styles.screen}>
      <TopBar
        left={
          <IconCircle
            icon="x"
            color={colors.secondary}
            accessibilityLabel="Cancel search"
            onPress={cancel}
          />
        }
        right={<View style={styles.pill}>{pill}</View>}
      />

      <View style={styles.content}>
        <View>
          <View style={styles.tagRow}>
            <Tag label={FORMAT_LABEL[request.format]} />
            <Label size={11} tracking={0.12}>
              {isGroup ? `${seats} PLAYERS · ${EXERCISE_SCORE[request.exerciseType]}` : EXERCISE_SCORE[request.exerciseType]}
            </Label>
          </View>
          <Display size={56} style={styles.title}>
            {exercise}
          </Display>
        </View>

        <View style={styles.grid}>
          <StatCard label="STAKE" value={fmtPoints(request.stake)} unit={UNIT} style={styles.half} />
          <StatCard label="POT" value={fmtPoints(pot)} unit={UNIT} accent style={styles.half} />
        </View>

        {phase === 'matched' ? (
          <View style={styles.matched}>
            <View>
              <Label size={11} color={colors.onAccentMuted} tracking={0.14}>
                {isGroup ? 'FULL HOUSE' : 'OPPONENT FOUND'}
              </Label>
              <Text style={styles.matchedHead}>BOUT STARTS IN</Text>
              <Text style={styles.matchedBody}>Get in frame. Camera opens automatically.</Text>
            </View>
            <Numeral size={96} color={colors.onAccent}>
              {String(Math.max(0, countdown))}
            </Numeral>
          </View>
        ) : null}

        {phase === 'ended' || phase === 'error' ? (
          <View style={styles.block}>
            {/* 'error' means the server refused to start the search at all —
                it must not read as "we looked and found nobody". */}
            <Display size={40}>{phase === 'error' ? "CAN'T\nSEARCH." : 'SEARCH\nOVER.'}</Display>
            <Body muted style={styles.blockBody}>
              {message}
            </Body>
          </View>
        ) : null}

        {phase === 'connecting' || phase === 'searching' ? (
          isGroup ? (
            <LobbyCard
              filled={lobbySize}
              seats={seats}
              myInitials={myInitials}
              widened={widened}
            />
          ) : (
            <Radar myInitials={myInitials} widened={widened} connecting={phase === 'connecting'} />
          )
        ) : null}
      </View>

      <Dock style={styles.dock}>
        {phase === 'searching' && !widened ? (
          <Notice icon="clock" iconColor={colors.secondary} style={styles.notice}>
            {`Matching fighters at your rank for a ${fmtPoints(request.stake)} ${UNIT} bout. After ${RANK_WIDEN_AFTER_SECONDS}s we widen the net.`}
          </Notice>
        ) : null}
        {phase === 'ended' || phase === 'error' ? (
          <>
            <Button label="SEARCH AGAIN" onPress={searchAgain} />
            <Button label="BACK" variant="card" onPress={cancel} />
          </>
        ) : (
          <Button
            label={phase === 'matched' ? 'OPENING CAMERA' : 'CANCEL SEARCH'}
            variant="secondary"
            onPress={cancel}
            loading={leaving}
            disabled={phase === 'matched'}
          />
        )}
      </Dock>
    </View>
  );
}

const RINGS = 3;
const RING_PERIOD_MS = 2400;

/** Expanding rings around the fighter's own avatar. */
function Radar({
  myInitials,
  widened,
  connecting,
}: {
  myInitials: string;
  widened: boolean;
  connecting: boolean;
}) {
  const progress = useMemo(
    () => Array.from({ length: RINGS }, () => new Animated.Value(0)),
    [],
  );

  useEffect(() => {
    const loops = progress.map((value, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay((RING_PERIOD_MS / RINGS) * i),
          Animated.timing(value, {
            toValue: 1,
            duration: RING_PERIOD_MS,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(value, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, [progress]);

  return (
    <View style={styles.radarWrap}>
      <View style={styles.radar}>
        {progress.map((value, i) => {
          const ring = {
            transform: [
              {
                scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1.6] }),
              },
            ],
            opacity: value.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.55, 0] }),
          };
          return <Animated.View key={i} style={[styles.ring, ring]} />;
        })}
        <Avatar initials={myInitials} size={72} tone="accent" />
      </View>
      <Display size={40} style={styles.radarHead}>
        {connecting ? 'STEPPING\nINTO LINE.' : 'FINDING YOUR\nOPPONENT.'}
      </Display>
      <Body muted style={styles.radarBody}>
        {connecting
          ? 'Connecting to the queue.'
          : widened
            ? 'Nobody at your rank yet, so the net is wider now.'
            : 'Live matchmaking. The moment a fighter at your level is here, the bout opens for both of you.'}
      </Body>
    </View>
  );
}

/** The group lobby: one slot per seat, the ones taken filled in. */
function LobbyCard({
  filled,
  seats,
  myInitials,
  widened,
}: {
  filled: number;
  seats: number;
  myInitials: string;
  widened: boolean;
}) {
  const toGo = Math.max(0, seats - filled);
  return (
    <Card>
      <View style={styles.spotsHead}>
        <Label>SPOTS CLAIMED</Label>
        <Text style={styles.spotsText}>
          {filled} <Text style={styles.spotsOf}>/ {seats}</Text>
        </Text>
      </View>
      <View style={styles.slots}>
        {Array.from({ length: seats }, (_, i) => {
          // Other members' rows are not readable (select-own RLS), so the
          // lobby shows counts, not names: me first, then anonymous seats.
          const me = i === 0;
          const taken = i < filled;
          return (
            <View key={i} style={styles.slot}>
              <Avatar
                initials={me ? myInitials : taken ? '?' : ''}
                size={48}
                tone={me ? 'accent' : taken ? 'raised' : 'empty'}
              />
              <Text style={[styles.slotName, !taken && styles.slotOpen]} numberOfLines={1}>
                {me ? 'you' : taken ? 'in' : 'open'}
              </Text>
            </View>
          );
        })}
      </View>
      <Text style={styles.lobbyNote}>
        {toGo === 0
          ? 'Full house. Camera opens for everyone at once.'
          : `Starts the moment the last spot fills. ${toGo} to go.${widened ? ' Now open to a wider range of ranks.' : ''}`}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
  },
  content: {
    flex: 1,
    paddingTop: 22,
    paddingHorizontal: space.gutter,
    gap: space.xl,
  },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { marginTop: space.md },
  grid: { flexDirection: 'row', gap: space.sm },
  half: { flex: 1 },

  matched: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    backgroundColor: colors.accent,
    borderRadius: radius.hero,
    paddingVertical: 22,
    paddingHorizontal: space.xl,
  },
  matchedHead: { ...anton(30, { color: colors.onAccent }), marginTop: space.sm },
  matchedBody: {
    fontFamily: fonts.medium,
    fontSize: 13,
    lineHeight: 18,
    color: colors.onAccentMuted,
    marginTop: space.sm,
  },

  block: { paddingTop: space.md },
  blockBody: { marginTop: space.md },

  radarWrap: { flex: 1, alignItems: 'flex-start' },
  radar: {
    alignSelf: 'center',
    width: 200,
    height: 200,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.sm,
  },
  ring: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  radarHead: { marginTop: space.md },
  radarBody: { marginTop: space.md },

  spotsHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  spotsText: { ...anton(26), textTransform: 'none' },
  spotsOf: { color: colors.dim },
  slots: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.lg,
  },
  slot: { alignItems: 'center', gap: space.sm, width: 52 },
  slotName: { ...label(10, colors.text, 0), textTransform: 'none' },
  slotOpen: { color: colors.dim },
  lobbyNote: {
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 18,
    color: colors.secondary,
    marginTop: space.lg,
  },

  dock: { gap: space.sm + 2 },
  notice: {},
});
