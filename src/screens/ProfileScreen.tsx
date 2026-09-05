import React, { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useFitnessProfile } from '../hooks/useFitnessProfile';
import type { FitnessProfileRow, StrengthTier } from '../types/database';
import { space } from '../theme/tokens';
import { TIER_LABEL } from '../theme/copy';
import {
  Chip,
  ChipRow,
  ErrorText,
  GhostButton,
  Label,
  Loading,
  Muted,
  Plate,
  Screen,
  Stat,
} from '../theme/ui';

const TIERS: StrengthTier[] = ['beginner', 'intermediate', 'advanced'];

export function ProfileScreen() {
  const { session, signOut } = useAuth();
  const { profile, loading, error, refresh, applyRow } = useFitnessProfile();
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [updatingTier, setUpdatingTier] = useState(false);

  const userId = session?.user.id ?? null;

  // points_balance moves without this screen doing anything: join_challenge()
  // deducts BOTH users' stakes, so a creator sitting here watches their
  // balance go stale the instant someone accepts. Filtered to this user's own
  // row server-side, which fitness_profiles_select_own would enforce anyway.
  useEffect(() => {
    if (!userId) {
      return;
    }

    const channel = supabase
      .channel(`fitness-profile:${userId}`)
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

  useEffect(() => {
    if (!session) {
      return;
    }
    supabase
      .from('match_participants')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', session.user.id)
      .then(({ count }) => setMatchCount(count ?? 0));
  }, [session]);

  const setTier = async (tier: StrengthTier) => {
    if (!profile || tier === profile.strength_tier) {
      return;
    }
    setUpdatingTier(true);
    await supabase
      .from('fitness_profiles')
      .update({ strength_tier: tier })
      .eq('user_id', profile.user_id);
    setUpdatingTier(false);
    await refresh();
  };

  if (loading || !profile) {
    return <Loading />;
  }

  return (
    <Screen>
      <Label style={styles.email}>{session?.user.email}</Label>

      {/* The key stat gets the full accent plate — ink fills the region. */}
      <Plate accent style={styles.bankroll}>
        <Stat label="Bankroll" value={`${profile.points_balance} pts`} onAccent />
      </Plate>

      <Label style={styles.fieldLabel}>Weight class · self-reported</Label>
      <ChipRow>
        {TIERS.map(tier => (
          <Chip
            key={tier}
            label={TIER_LABEL[tier]}
            active={profile.strength_tier === tier}
            onPress={() => setTier(tier)}
            disabled={updatingTier}
          />
        ))}
      </ChipRow>
      <Muted style={styles.hint}>
        You only get matched against your own class.
      </Muted>

      <Plate style={styles.record}>
        <Stat label="Bouts fought" value={matchCount ?? '—'} />
      </Plate>

      {error ? <ErrorText style={styles.error}>{error}</ErrorText> : null}

      <GhostButton style={styles.signOut} label="Log out" onPress={signOut} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  email: { marginBottom: space.md },
  bankroll: { marginBottom: space.lg },
  fieldLabel: { marginBottom: space.sm },
  hint: { marginTop: space.sm },
  record: { marginTop: space.lg },
  error: { marginTop: space.md },
  signOut: { marginTop: 'auto' },
});
