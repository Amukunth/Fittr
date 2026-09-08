import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import type { UserDeviceRow } from '../types/database';

const { version: APP_VERSION } = require('../../package.json') as { version: string };

const DEVICE_ID_KEY = 'fittr:device-id';

function uuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // eslint-disable-next-line no-bitwise -- RFC 4122 version nibble
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  // eslint-disable-next-line no-bitwise -- RFC 4122 variant bits
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let cachedId: string | null = null;

/**
 * A stable id for this install. Lives in AsyncStorage, so it survives
 * sign-out but not a reinstall, which is the right granularity for "which
 * devices have my account open".
 */
export async function deviceId(): Promise<string> {
  if (cachedId) {
    return cachedId;
  }
  try {
    const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (existing) {
      cachedId = existing;
      return existing;
    }
    const fresh = uuid();
    await AsyncStorage.setItem(DEVICE_ID_KEY, fresh);
    cachedId = fresh;
    return fresh;
  } catch {
    cachedId = cachedId ?? uuid();
    return cachedId;
  }
}

/** "iPhone · iOS 18.2", "iPad · iPadOS 18", "Google Pixel 8 · Android 15". */
export function deviceName(): string {
  if (Platform.OS === 'ios') {
    const c = Platform.constants as { interfaceIdiom?: string; osVersion?: string; systemName?: string };
    const model = c.interfaceIdiom === 'pad' ? 'iPad' : 'iPhone';
    const os = [c.systemName ?? 'iOS', c.osVersion].filter(Boolean).join(' ');
    return `${model} · ${os}`;
  }
  if (Platform.OS === 'android') {
    const c = Platform.constants as { Brand?: string; Model?: string; Release?: string };
    const brand = c.Brand ? c.Brand[0]!.toUpperCase() + c.Brand.slice(1) : '';
    const model = [brand, c.Model].filter(Boolean).join(' ') || 'Android device';
    return `${model} · Android ${c.Release ?? ''}`.trim();
  }
  return Platform.OS;
}

/** Records (or refreshes) this device on the signed-in user's account. */
export async function registerDevice(userId: string): Promise<void> {
  const id = await deviceId();
  await supabase.from('user_devices').upsert(
    {
      user_id: userId,
      device_id: id,
      name: deviceName(),
      platform: Platform.OS,
      app_version: APP_VERSION,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,device_id' },
  );
}

export async function listDevices(): Promise<UserDeviceRow[]> {
  const { data, error } = await supabase
    .from('user_devices')
    .select('*')
    .order('last_seen_at', { ascending: false });
  if (error) {
    throw new Error(error.message);
  }
  return (data ?? []) as UserDeviceRow[];
}

/**
 * Revokes every session except this one (the auth server does that part),
 * then drops the other devices' rows so the list reflects it.
 */
export async function signOutOtherDevices(): Promise<void> {
  const { error } = await supabase.auth.signOut({ scope: 'others' });
  if (error) {
    throw new Error(error.message);
  }
  const id = await deviceId();
  await supabase.from('user_devices').delete().neq('device_id', id);
}
