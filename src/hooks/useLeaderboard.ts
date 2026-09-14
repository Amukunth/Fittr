import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import type { LeaderboardRow } from '../types/database';

export type LeaderboardScope = 'global' | 'friends';

/** One page. Twenty is what fits a phone twice over. */
export const PAGE_SIZE = 20;

/**
 * How long a fetched page stays good. A leaderboard is not a live object --
 * it moves when other people's bouts settle, which the client has no reason
 * to hear about -- so switching tabs back and forth, or leaving the screen
 * and returning, reads the cache instead of the network.
 */
export const CACHE_MS = 60_000;

interface CacheEntry {
  rows: LeaderboardRow[];
  self: LeaderboardRow | null;
  /** The server returned a short page: there is nothing after this. */
  exhausted: boolean;
  fetchedAt: number;
  /** Whose board this is; a different account must not read it. */
  userId: string;
}

const cache = new Map<LeaderboardScope, CacheEntry>();

function cached(scope: LeaderboardScope, userId: string): CacheEntry | null {
  const entry = cache.get(scope);
  if (!entry || entry.userId !== userId) {
    return null;
  }
  return Date.now() - entry.fetchedAt < CACHE_MS ? entry : null;
}

interface UseLeaderboardResult {
  rows: LeaderboardRow[];
  /** The caller's own row, whether or not it is in `rows`. */
  self: LeaderboardRow | null;
  loading: boolean;
  /** A further page is on its way. */
  loadingMore: boolean;
  error: string | null;
  /** False once the server has returned a short page. */
  hasMore: boolean;
  loadMore: () => void;
  /** Ignores the cache. */
  refresh: () => Promise<void>;
}

/**
 * One scope of the leaderboard, paged twenty at a time.
 *
 * `self` comes from its own call rather than being searched for in the
 * pages: a fighter outside the top twenty would otherwise have to be paged
 * to before the screen could pin their row, which is the opposite of the
 * point of pinning it.
 */
export function useLeaderboard(scope: LeaderboardScope): UseLeaderboardResult {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;

  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [self, setSelf] = useState<LeaderboardRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);

  // Guards against a scroll that fires loadMore twice before the first
  // request lands, and against a response for a scope the user has left.
  const busy = useRef(false);
  const activeScope = useRef(scope);

  const fetchPage = useCallback(
    async (offset: number): Promise<LeaderboardRow[] | null> => {
      const { data, error: rpcError } = await supabase.rpc('leaderboard_page', {
        p_scope: scope,
        p_limit: PAGE_SIZE,
        p_offset: offset,
      });
      if (rpcError) {
        setError(rpcError.message);
        return null;
      }
      return (data ?? []) as LeaderboardRow[];
    },
    [scope],
  );

  const load = useCallback(
    async (force: boolean) => {
      if (!userId) {
        setRows([]);
        setSelf(null);
        setLoading(false);
        return;
      }

      const hit = force ? null : cached(scope, userId);
      if (hit) {
        setRows(hit.rows);
        setSelf(hit.self);
        setHasMore(!hit.exhausted);
        setLoading(false);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);
      busy.current = true;

      const [page, selfResult] = await Promise.all([
        fetchPage(0),
        supabase.rpc('leaderboard_self', { p_scope: scope }),
      ]);
      busy.current = false;

      // The user switched tabs while this was in the air.
      if (activeScope.current !== scope) {
        return;
      }
      if (page === null) {
        setLoading(false);
        return;
      }
      if (selfResult.error) {
        setError(selfResult.error.message);
        setLoading(false);
        return;
      }

      const mine = (selfResult.data ?? null) as LeaderboardRow | null;
      const exhausted = page.length < PAGE_SIZE;
      cache.set(scope, {
        rows: page,
        self: mine,
        exhausted,
        fetchedAt: Date.now(),
        userId,
      });
      setRows(page);
      setSelf(mine);
      setHasMore(!exhausted);
      setLoading(false);
    },
    [fetchPage, scope, userId],
  );

  useEffect(() => {
    activeScope.current = scope;
    load(false);
  }, [load, scope]);

  const loadMore = useCallback(() => {
    if (busy.current || loading || loadingMore || !hasMore || !userId) {
      return;
    }
    busy.current = true;
    setLoadingMore(true);

    const offset = rows.length;
    fetchPage(offset)
      .then(page => {
        if (page === null || activeScope.current !== scope) {
          return;
        }
        const next = [...rows, ...page];
        const exhausted = page.length < PAGE_SIZE;
        setRows(next);
        setHasMore(!exhausted);
        // Keep the cache in step, so coming back to this tab inside the
        // minute restores the scroll depth as well as the first page.
        const entry = cache.get(scope);
        if (entry && entry.userId === userId) {
          cache.set(scope, { ...entry, rows: next, exhausted });
        }
      })
      .finally(() => {
        busy.current = false;
        setLoadingMore(false);
      });
  }, [fetchPage, hasMore, loading, loadingMore, rows, scope, userId]);

  return {
    rows,
    self,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    refresh: useCallback(() => load(true), [load]),
  };
}

/** Sign-out, or a settled bout: the next read must go to the network. */
export function invalidateLeaderboard(): void {
  cache.clear();
}
