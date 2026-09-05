import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { supabase } from '../lib/supabase';
import { navigationRef } from '../lib/navigationRef';
import { useAuth } from '../context/AuthContext';
import type { ChallengeRow } from '../types/database';
import { colors, radius, space, typography } from '../theme/tokens';
import { EXERCISE_LABEL } from '../theme/copy';

/**
 * App-level "someone accepted your challenge" watcher.
 *
 * The creator of a challenge never calls join_challenge() themselves — the
 * joiner does — so nothing on the creator's device knows a Match now exists.
 * Before this, they'd sit on Home (or anywhere) with stale data until they
 * manually navigated away and back.
 *
 * Mounted once inside NavigationContainer rather than on a screen, because
 * the creator can be anywhere when the accept lands.
 *
 * Subscribes to `challenges` UPDATE filtered server-side to this user's own
 * rows. See the 20260903100000 migration for why challenges and not matches.
 */

/**
 * Screens we refuse to yank someone off of. MatchInProgress is a live camera
 * capture — auto-navigating out of it would destroy an in-flight set and its
 * unsaved rep count. Results is mid-read. On these, we show the banner and
 * let the user choose.
 */
const DO_NOT_INTERRUPT: ReadonlySet<string> = new Set([
  'MatchInProgress',
  'Results',
]);

interface PendingMatch {
  matchId: string;
  challengeType: ChallengeRow['type'];
}

export function MatchFoundWatcher() {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [pending, setPending] = useState<PendingMatch | null>(null);

  // Realtime delivers at-least-once, and a challenge can be UPDATEd again
  // later (status -> in_progress/completed). Without this guard a creator
  // could be navigated into the same match twice.
  const announcedRef = useRef<Set<string>>(new Set());

  const goToMatch = useCallback((matchId: string) => {
    setPending(null);
    if (navigationRef.isReady()) {
      navigationRef.navigate('MatchInProgress', { matchId });
    }
  }, []);

  useEffect(() => {
    if (!userId) {
      return;
    }

    // Scope the dedupe set to the signed-in user, so switching accounts on
    // one device doesn't suppress the new user's events.
    const announced = announcedRef.current;
    announced.clear();

    let cancelled = false;

    const announce = async (challenge: ChallengeRow) => {
      // The challenges payload has no match_id. Resolve it — allowed,
      // because join_challenge() already inserted this user into
      // match_participants, which is what matches_select_participant checks.
      const { data, error } = await supabase
        .from('matches')
        .select('id')
        .eq('challenge_id', challenge.id)
        .maybeSingle();

      // Effect torn down (unmount / sign-out) while the query was in flight.
      if (cancelled) {
        return;
      }
      // Never swallow this silently: a failed matches read here is how the
      // RLS-recursion bug (migration 20260904000000) went unnoticed — the
      // creator was simply never navigated, with nothing in the logs.
      if (error) {
        console.warn(
          `[MatchFoundWatcher] challenge ${challenge.id} is matched but the ` +
            `matches read failed: ${error.message}`,
        );
        return;
      }
      if (!data) {
        return;
      }

      const currentRoute = navigationRef.isReady()
        ? navigationRef.getCurrentRoute()?.name
        : undefined;

      if (currentRoute && DO_NOT_INTERRUPT.has(currentRoute)) {
        setPending({ matchId: data.id, challengeType: challenge.type });
        return;
      }
      goToMatch(data.id);
    };

    const channel = supabase
      .channel(`match-watch:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'challenges',
          filter: `created_by=eq.${userId}`,
        },
        payload => {
          const next = payload.new as ChallengeRow;
          if (next.status !== 'matched' || announced.has(next.id)) {
            return;
          }
          announced.add(next.id);
          announce(next);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      // Unsubscribes AND drops the channel from the shared client, so a
      // remount can reuse the same topic name without colliding.
      supabase.removeChannel(channel);
    };
  }, [userId, goToMatch]);

  // Sign-out should never leave a stale banner floating over the Login screen.
  useEffect(() => {
    if (!userId) {
      setPending(null);
    }
  }, [userId]);

  if (!pending) {
    return null;
  }

  return (
    <View style={styles.banner} pointerEvents="box-none">
      {/* An accent-filled plate: the ink fills the whole region, not an edge. */}
      <View style={styles.bannerInner}>
        <View style={styles.bannerText}>
          <Text style={styles.bannerTitle}>It's on</Text>
          <Text style={styles.bannerBody}>
            Somebody took your{' '}
            {EXERCISE_LABEL[pending.challengeType].toLowerCase()} bout.
          </Text>
        </View>
        <TouchableOpacity
          style={styles.bannerButton}
          onPress={() => goToMatch(pending.matchId)}
        >
          <Text style={styles.bannerButtonText}>Enter</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.bannerDismiss}
          onPress={() => setPending(null)}
          accessibilityLabel="Dismiss"
        >
          <Text style={styles.bannerDismissText}>✕</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: 48,
    paddingHorizontal: space.sm + 4,
  },
  bannerInner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: space.sm + 4,
    paddingHorizontal: space.md,
  },
  bannerText: { flex: 1 },
  bannerTitle: { ...typography.subhead, color: colors.onAccent },
  bannerBody: {
    ...typography.bodySm,
    color: colors.onAccentMuted,
    marginTop: 2,
  },
  bannerButton: {
    backgroundColor: colors.onAccent,
    borderRadius: radius.sm,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
    marginLeft: space.sm + 4,
  },
  bannerButtonText: { ...typography.button, color: colors.accent },
  bannerDismiss: {
    paddingLeft: space.sm + 4,
    paddingRight: space.xs,
    paddingVertical: space.sm,
  },
  bannerDismissText: {
    color: colors.onAccentMuted,
    fontSize: 16,
    fontWeight: '700',
  },
});
