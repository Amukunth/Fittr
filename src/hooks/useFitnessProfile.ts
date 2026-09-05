import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { FitnessProfileRow } from '../types/database';
import { useAuth } from '../context/AuthContext';

interface UseFitnessProfileResult {
  profile: FitnessProfileRow | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /**
   * Adopt an already-complete row without refetching. Deliberately not
   * `refresh()`: that flips `loading` back to true, and consumers gate a
   * full-screen spinner on it, so using it for a live balance tick would
   * flash the whole screen on every stake.
   */
  applyRow: (row: FitnessProfileRow) => void;
}

/**
 * Fetches the current user's FitnessProfile, creating one (with a one-time
 * starter bonus — see grant_starter_bonus in the migration) the first time
 * they ever log in, and keeps points_balance live afterwards.
 *
 * The live part matters on every screen that prints the balance (the Home
 * pill, Create's "YOU HAVE", Profile): join_challenge() deducts BOTH users'
 * stakes, so a creator's balance goes stale the instant someone accepts,
 * and settle_match() pays out with no client involved. Filtered to this
 * user's own row server-side, which fitness_profiles_select_own enforces
 * anyway.
 */
export function useFitnessProfile(): UseFitnessProfileResult {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;

  const [profile, setProfile] = useState<FitnessProfileRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setProfile(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const { data: existing, error: selectError } = await supabase
      .from('fitness_profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (selectError) {
      setError(selectError.message);
      setLoading(false);
      return;
    }

    if (existing) {
      setProfile(existing as FitnessProfileRow);
      setLoading(false);
      return;
    }

    const { data: created, error: insertError } = await supabase
      .from('fitness_profiles')
      .insert({ user_id: userId, strength_tier: 'beginner' })
      .select('*')
      .single();

    if (insertError) {
      setError(insertError.message);
      setLoading(false);
      return;
    }

    const { error: bonusError } = await supabase.rpc('grant_starter_bonus', {
      p_user_id: userId,
    });
    if (bonusError) {
      setError(bonusError.message);
      setLoading(false);
      return;
    }

    const { data: withBonus, error: refetchError } = await supabase
      .from('fitness_profiles')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (refetchError) {
      setError(refetchError.message);
      setProfile(created as FitnessProfileRow);
    } else {
      setProfile(withBonus as FitnessProfileRow);
    }
    setLoading(false);
  }, [userId]);

  const applyRow = useCallback((row: FitnessProfileRow) => {
    setProfile(row);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!userId) {
      return;
    }
    const channel = supabase
      .channel(`fitness-profile:${userId}:${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'fitness_profiles',
          filter: `user_id=eq.${userId}`,
        },
        payload => {
          // payload.new is the complete new row, so no refetch is needed.
          applyRow(payload.new as FitnessProfileRow);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, applyRow]);

  return { profile, loading, error, refresh: load, applyRow };
}
