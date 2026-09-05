import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@env';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'Missing SUPABASE_URL / SUPABASE_ANON_KEY. Copy .env.example to .env and fill in ' +
      'your Supabase project values (Project Settings -> API).',
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

let channelSeq = 0;

/**
 * A realtime topic name that is unique to one subscriber. `supabase.channel()`
 * hands back an EXISTING channel when the topic matches, and adding listeners
 * to a channel that has already called subscribe() throws ("cannot add
 * postgres_changes callbacks ... after subscribe()"). A remount (navigation,
 * Fast Refresh, sign-out/sign-in) runs the new effect before the previous
 * instance's async removeChannel() has finished, so a fixed name is a crash
 * waiting to happen. The base keeps the topic readable in the dashboard.
 */
export function channelName(base: string): string {
  channelSeq += 1;
  return `${base}#${channelSeq}`;
}
