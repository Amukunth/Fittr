import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import type { NotificationPrefs, UserSettingsRow } from '../types/database';

export const DEFAULT_NOTIFICATIONS: NotificationPrefs = {
  callouts: true,
  results: true,
  reminders: true,
};

interface UseUserSettingsResult {
  notifications: NotificationPrefs;
  loading: boolean;
  saving: boolean;
  error: string | null;
  setNotification: (key: keyof NotificationPrefs, value: boolean) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * The user's own user_settings row (created on first change). Toggles are
 * optimistic: the switch moves at once and rolls back if the save fails.
 */
export function useUserSettings(): UseUserSettingsResult {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [notifications, setNotifications] = useState<NotificationPrefs>(DEFAULT_NOTIFICATIONS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }
    setError(null);
    const { data, error: queryError } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (queryError) {
      setError(queryError.message);
    } else if (data) {
      const row = data as UserSettingsRow;
      setNotifications({ ...DEFAULT_NOTIFICATIONS, ...row.notifications });
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const setNotification = useCallback(
    async (key: keyof NotificationPrefs, value: boolean) => {
      if (!userId) {
        return;
      }
      const previous = notifications;
      const next = { ...previous, [key]: value };
      setNotifications(next);
      setSaving(true);
      setError(null);
      const { error: upsertError } = await supabase.from('user_settings').upsert(
        { user_id: userId, notifications: next, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      );
      setSaving(false);
      if (upsertError) {
        setNotifications(previous);
        setError(upsertError.message);
      }
    },
    [userId, notifications],
  );

  return { notifications, loading, saving, error, setNotification, refresh: load };
}
