import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import {
  EMPTY_STATS,
  deriveBoutStats,
  type BoutStats,
} from '../lib/boutStats';
import type {
  ChallengeRow,
  MatchParticipantRow,
  MatchRow,
  PointsLedgerEntryRow,
} from '../types/database';

interface UseBoutHistoryResult {
  stats: BoutStats | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Everything the signed-in user has fought, in four reads that all pass
 * RLS: own participant rows -> those matches (matches_select_participant)
 * -> every participant on them (same policy) + own ledger entries -> the
 * challenges behind them (readable by any signed-in user).
 */
export function useBoutHistory(): UseBoutHistoryResult {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;

  const [stats, setStats] = useState<BoutStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setStats(null);
      setLoading(false);
      return;
    }
    setError(null);

    const { data: mineData, error: mineError } = await supabase
      .from('match_participants')
      .select('*')
      .eq('user_id', userId);
    if (mineError) {
      setError(mineError.message);
      setLoading(false);
      return;
    }
    const mine = (mineData ?? []) as MatchParticipantRow[];
    const matchIds = mine.map(m => m.match_id);
    if (matchIds.length === 0) {
      setStats(EMPTY_STATS);
      setLoading(false);
      return;
    }

    const [matchesRes, othersRes, ledgerRes] = await Promise.all([
      supabase.from('matches').select('*').in('id', matchIds),
      supabase.from('match_participants').select('*').in('match_id', matchIds),
      supabase
        .from('points_ledger_entries')
        .select('*')
        .in('match_id', matchIds),
    ]);
    const firstError =
      matchesRes.error ?? othersRes.error ?? ledgerRes.error ?? null;
    if (firstError) {
      setError(firstError.message);
      setLoading(false);
      return;
    }
    const matches = (matchesRes.data ?? []) as MatchRow[];

    const { data: challengeData, error: challengeError } = await supabase
      .from('challenges')
      .select('*')
      .in(
        'id',
        matches.map(m => m.challenge_id),
      );
    if (challengeError) {
      setError(challengeError.message);
      setLoading(false);
      return;
    }

    setStats(
      deriveBoutStats(userId, {
        mine,
        others: (othersRes.data ?? []) as MatchParticipantRow[],
        matches,
        challenges: (challengeData ?? []) as ChallengeRow[],
        ledger: (ledgerRes.data ?? []) as PointsLedgerEntryRow[],
      }),
    );
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  return { stats, loading, error, refresh: load };
}
