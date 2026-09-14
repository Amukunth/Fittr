import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import {
  badgeContentOf,
  getBadge,
  loadSeenLeague,
  publishStanding,
  subscribeBadge,
} from '../lib/rankBadge';
import type { LeagueTier } from '../types/database';

/**
 * What the Rank tab's badge should show: the trophy count, a dot when the
 * league has moved since the fighter last looked, or nothing at all.
 *
 * Reads the shared store in lib/rankBadge, and fetches only if nothing has
 * filled it yet -- so the four screens that draw the tab bar make one
 * request between them, and none at all once the Rank screen has been
 * opened. There is no realtime channel here on purpose: useRankStanding
 * already holds one on the same row and publishes into the same store, and
 * the badge on a screen the fighter is not looking at does not need to be
 * live to the second.
 */
export function useTrophyBadge(): number | 'dot' | null {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [badge, setBadge] = useState(getBadge);

  useEffect(() => subscribeBadge(setBadge), []);

  useEffect(() => {
    if (!userId) {
      return;
    }
    loadSeenLeague(userId);

    if (getBadge().trophies !== null) {
      return;
    }
    let cancelled = false;
    supabase
      .from('fitness_profiles')
      .select('trophies, current_league')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        const row = data as { trophies: number; current_league: LeagueTier } | null;
        if (!cancelled && row) {
          publishStanding(row.trophies, row.current_league);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return badgeContentOf(badge);
}
