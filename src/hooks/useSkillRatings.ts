import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import type { MySkillRatingRow } from '../types/database';

interface UseSkillRatingsResult {
  /** One row per exercise the user has a rating in. Never null once loaded. */
  ratings: MySkillRatingRow[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * The signed-in user's per-exercise MMR and derived rank tier.
 *
 * Reads the `my_skill_ratings` view rather than `skill_ratings`, so the tier
 * bands are applied by the same rank_tier_for() the database defines them
 * in, and the client never has to agree with SQL about where Knight starts.
 * The view is security_invoker over a select-own policy, so there is no user
 * filter to add here -- and nothing the client could do to widen it.
 *
 * Deliberately NOT realtime-subscribed, unlike useFitnessProfile. A rating
 * only ever changes inside settlement, and both surfaces that show one
 * (Profile, Results) already refetch on the events that follow a
 * settlement: Profile on focus, Results on the `challenges` UPDATE. Adding a
 * third subscription would buy nothing and would need skill_ratings in the
 * realtime publication.
 */
export function useSkillRatings(): UseSkillRatingsResult {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;

  const [ratings, setRatings] = useState<MySkillRatingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setRatings([]);
      setLoading(false);
      return;
    }
    setError(null);

    const { data, error: selectError } = await supabase
      .from('my_skill_ratings')
      .select('*');

    if (selectError) {
      setError(selectError.message);
      setLoading(false);
      return;
    }

    setRatings((data ?? []) as MySkillRatingRow[]);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  return { ratings, loading, error, refresh: load };
}
