import { useCallback, useEffect, useRef, useState } from 'react';
import { channelName, supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { leagueIndex } from '../lib/league';
import { loadSeenLeague, publishStanding, resetBadge } from '../lib/rankBadge';
import type { FitnessProfileRow, LeagueTier, RankStandingRow } from '../types/database';

/** What a live trophy change was, for the celebration overlay. */
export interface RankEvent {
  /** Trophies gained (or lost) in this one change. */
  delta: number;
  /** The league after it. */
  league: LeagueTier;
  /** Whether that league is higher than the one before. */
  promoted: boolean;
  /** Distinguishes two identical events, so the overlay re-runs. */
  key: number;
}

interface UseRankStandingResult {
  standing: RankStandingRow | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** The most recent live change, until the screen clears it. */
  event: RankEvent | null;
  clearEvent: () => void;
}

/**
 * The Rank screen's hero: the caller's trophies, league, record and global
 * rank.
 *
 * One RPC rather than a profile read plus a rank query, because the rank is
 * the one number the profile row cannot carry (see the migration header for
 * why it is counted rather than stored).
 *
 * Kept live on the EXISTING fitness_profiles channel -- the same per-row
 * UPDATE that already carries points_balance. A bout settling on the other
 * fighter's phone moves these columns without this client asking, which is
 * exactly the case realtime is here for. The payload carries every column
 * except the rank, so the counters update from it optimistically and the
 * rank is re-counted in the background: the screen never blanks, and the
 * pill catches up a beat later rather than blocking the number that moved.
 */
export function useRankStanding(): UseRankStandingResult {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;

  const [standing, setStanding] = useState<RankStandingRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [event, setEvent] = useState<RankEvent | null>(null);

  // The standing as of the last thing that wrote it, so a realtime payload
  // can be turned into a delta and a direction. Refs, not state: reading
  // them must not re-subscribe the channel, and the subscription callback
  // must not have to reach into a reducer to see them.
  const trophiesRef = useRef<number | null>(null);
  const leagueRef = useRef<LeagueTier | null>(null);
  const eventSeq = useRef(0);

  const load = useCallback(async () => {
    if (!userId) {
      setStanding(null);
      setLoading(false);
      return;
    }
    setError(null);

    const { data, error: rpcError } = await supabase.rpc('rank_standing');
    if (rpcError) {
      setError(rpcError.message);
      setLoading(false);
      return;
    }

    const row = (data ?? null) as RankStandingRow | null;
    if (row) {
      trophiesRef.current = row.trophies;
      leagueRef.current = row.current_league;
      publishStanding(row.trophies, row.current_league);
    }
    setStanding(row);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!userId) {
      resetBadge();
      trophiesRef.current = null;
      leagueRef.current = null;
      return;
    }
    loadSeenLeague(userId);
  }, [userId]);

  // Re-count the rank without touching the counters already on screen.
  const refreshRank = useCallback(async () => {
    const { data } = await supabase.rpc('rank_standing');
    const row = (data ?? null) as RankStandingRow | null;
    if (row) {
      trophiesRef.current = row.trophies;
      leagueRef.current = row.current_league;
      setStanding(row);
    }
  }, []);

  useEffect(() => {
    if (!userId) {
      return;
    }
    const channel = supabase
      .channel(channelName(`rank:${userId}`))
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'fitness_profiles',
          filter: `user_id=eq.${userId}`,
        },
        payload => {
          const next = payload.new as FitnessProfileRow;
          const wasTrophies = trophiesRef.current;
          const wasLeague = leagueRef.current;
          trophiesRef.current = next.trophies;
          leagueRef.current = next.current_league;
          publishStanding(next.trophies, next.current_league);

          setStanding(current =>
            current
              ? {
                  ...current,
                  trophies: next.trophies,
                  current_league: next.current_league,
                  total_wins: next.total_wins,
                  total_losses: next.total_losses,
                  total_ties: next.total_ties,
                  current_streak: next.current_streak,
                }
              : current,
          );

          // A stake or a payout updates this row too, and neither moves the
          // ladder. Only a trophy change is worth a celebration or the
          // round trip to re-count the rank.
          if (next.trophies === wasTrophies) {
            return;
          }

          // Celebrated only once the screen knows what the count was
          // before -- the first payload after a cold start has nothing to
          // compare against.
          if (wasTrophies !== null) {
            eventSeq.current += 1;
            setEvent({
              delta: next.trophies - wasTrophies,
              league: next.current_league,
              promoted:
                wasLeague !== null &&
                leagueIndex(next.current_league) > leagueIndex(wasLeague),
              key: eventSeq.current,
            });
          }

          // The rank moved too, but nothing in the payload says where to.
          refreshRank();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, refreshRank]);

  const clearEvent = useCallback(() => setEvent(null), []);

  return { standing, loading, error, refresh: load, event, clearEvent };
}
