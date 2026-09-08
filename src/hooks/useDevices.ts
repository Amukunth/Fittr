import { useCallback, useEffect, useState } from 'react';
import { deviceId, listDevices, signOutOtherDevices } from '../lib/device';
import { useAuth } from '../context/AuthContext';
import type { UserDeviceRow } from '../types/database';

interface UseDevicesResult {
  devices: UserDeviceRow[];
  /** device_id of the phone this code is running on. */
  thisDeviceId: string | null;
  loading: boolean;
  error: string | null;
  signingOut: boolean;
  refresh: () => Promise<void>;
  signOutOthers: () => Promise<void>;
}

/** Devices that have opened Fittr with this account, newest activity first. */
export function useDevices(): UseDevicesResult {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [devices, setDevices] = useState<UserDeviceRow[]>([]);
  const [thisDeviceId, setThisDeviceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setDevices([]);
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const [rows, id] = await Promise.all([listDevices(), deviceId()]);
      setDevices(rows);
      setThisDeviceId(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const signOutOthers = useCallback(async () => {
    setSigningOut(true);
    setError(null);
    try {
      await signOutOtherDevices();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigningOut(false);
    }
  }, [load]);

  return { devices, thisDeviceId, loading, error, signingOut, refresh: load, signOutOthers };
}
