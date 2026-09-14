import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { LEAGUES } from '../lib/league';
import type { LeagueTierRow } from '../types/database';

/**
 * The five league_tiers rows: thresholds, wager ceilings, colours.
 *
 * Reference data that only a migration writes, so it is fetched once per
 * app launch and kept in a module-level cache rather than re-read every
 * time the Rank screen opens. There is no invalidation because there is no
 * writer: if the seed ever changes, it changes in a deploy, which restarts
 * the bundle.
 *
 * The screen renders these rather than LEAGUE_MIN_TROPHIES, so a threshold
 * the server has moved shows up without shipping a build. The mirrored
 * constants are the fallback for the first paint and for an offline start.
 */

let cache: LeagueTierRow[] | null = null;
let inFlight: Promise<LeagueTierRow[]> | null = null;

async function fetchTiers(): Promise<LeagueTierRow[]> {
  const { data, error } = await supabase
    .from('league_tiers')
    .select('*')
    .order('min_trophies', { ascending: true });
  if (error) {
    throw new Error(error.message);
  }
  return (data ?? []) as LeagueTierRow[];
}

interface UseLeagueTiersResult {
  /** Ascending by threshold. Empty only if the very first read failed. */
  tiers: LeagueTierRow[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useLeagueTiers(): UseLeagueTiersResult {
  const [tiers, setTiers] = useState<LeagueTierRow[]>(cache ?? []);
  const [loading, setLoading] = useState(cache === null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    if (cache && !force) {
      setTiers(cache);
      setLoading(false);
      return;
    }
    setError(null);
    try {
      // One request even if three components mount in the same frame.
      inFlight = inFlight ?? fetchTiers();
      const rows = await inFlight;
      cache = rows;
      setTiers(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the leagues.');
    } finally {
      inFlight = null;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return {
    tiers,
    loading,
    error,
    refresh: useCallback(() => load(true), [load]),
  };
}

/**
 * Drop the cache, so the next mount goes to the network. Nothing in the app
 * needs this -- a migration is the only writer -- but a test that changes
 * what the server returns does, and so would a future "reload reference
 * data" path.
 */
export function invalidateLeagueTiers(): void {
  cache = null;
  inFlight = null;
}

/** Ascending order, whatever order the rows arrived in. */
export function sortTiers(rows: readonly LeagueTierRow[]): LeagueTierRow[] {
  return [...rows].sort(
    (a, b) => LEAGUES.indexOf(a.name) - LEAGUES.indexOf(b.name),
  );
}
