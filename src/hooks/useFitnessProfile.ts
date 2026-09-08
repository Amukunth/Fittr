import { useCallback, useEffect, useState } from 'react';
import { channelName, supabase } from '../lib/supabase';
import type { FitnessProfileRow } from '../types/database';
import { useAuth } from '../context/AuthContext';

interface UseFitnessProfileResult {
  profile: FitnessProfileRow | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Fetches the current user's FitnessProfile (tier, points, identity),
 * creating one and granting the starter bonus the first time they log in.
 * Kept live by realtime on the row: join_challenge() / settle_match() move
 * points_balance from the other player's device, and Settings edits the
 * identity columns through update_my_profile().
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
      .insert({ user_id: userId, strength_tier: 'beginner', points_balance: 0 })
      .select('*')
      .single();

    if (insertError) {
      setError(insertError.message);
      setLoading(false);
      return;
    }

    // One-time 500 point opening purse. Idempotent server-side.
    const { error: bonusError } = await supabase.rpc('grant_starter_bonus', {
      p_user_id: userId,
    });
    if (bonusError) {
      setError(bonusError.message);
      setProfile(created as FitnessProfileRow);
      setLoading(false);
      return;
    }

    const { data: refreshed } = await supabase
      .from('fitness_profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    setProfile((refreshed ?? created) as FitnessProfileRow);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!userId) {
      return;
    }
    const channel = supabase
      .channel(channelName(`profile:${userId}`))
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'fitness_profiles',
          filter: `user_id=eq.${userId}`,
        },
        payload => {
          setProfile(payload.new as FitnessProfileRow);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  return { profile, loading, error, refresh: load };
}
