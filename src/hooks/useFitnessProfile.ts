import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { FitnessProfileRow } from '../types/database';
import { useAuth } from '../context/AuthContext';

interface UseFitnessProfileResult {
  profile: FitnessProfileRow | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Fetches the current user's FitnessProfile, creating one (with a one-time
 * starter bonus — see grant_starter_bonus in the migration) the first time
 * they ever log in.
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

  useEffect(() => {
    load();
  }, [load]);

  return { profile, loading, error, refresh: load };
}
