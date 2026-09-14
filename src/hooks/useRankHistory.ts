import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import type { RankHistoryRow } from '../types/database';

/** How many timeline entries the screen shows. */
export const HISTORY_LIMIT = 30;

interface UseRankHistoryResult {
  /** Newest first. */
  events: RankHistoryRow[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * The signed-in fighter's rank timeline.
 *
 * A plain table read: rank_history_select_own scopes it to the caller, so
 * there is no user filter to add here and nothing the client could do to
 * widen it.
 *
 * Not realtime-subscribed, deliberately. rank_history is not in the
 * publication (see the migration, section 4) because the profile row
 * already broadcasts the consequence of an award; the Rank screen refetches
 * the timeline when that broadcast arrives, which is one read on an event
 * that happens a few times a day rather than a second open socket.
 */
export function useRankHistory(): UseRankHistoryResult {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;

  const [events, setEvents] = useState<RankHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setEvents([]);
      setLoading(false);
      return;
    }
    setError(null);

    const { data, error: selectError } = await supabase
      .from('rank_history')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT);

    if (selectError) {
      setError(selectError.message);
      setLoading(false);
      return;
    }

    setEvents((data ?? []) as RankHistoryRow[]);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  return { events, loading, error, refresh: load };
}
