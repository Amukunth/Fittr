import type { Session } from '@supabase/supabase-js';

/**
 * Who to call people. There is no public profile table (BACKEND.md,
 * assumption 7), so the only name the app can show for ANOTHER user is a
 * stub cut from their id. The signed-in user's own handle comes from the
 * auth user metadata written at sign-up (see AuthContext.signUpWithPassword),
 * falling back to the local part of their email.
 */

export function normalizeHandle(raw: string): string {
  const trimmed = raw.trim().replace(/^@+/, '').replace(/\s+/g, '');
  return trimmed ? `@${trimmed.toLowerCase()}` : '';
}

export function ownHandle(session: Session | null): string {
  const meta = session?.user.user_metadata as
    | { handle?: unknown }
    | undefined;
  if (typeof meta?.handle === 'string' && meta.handle.trim()) {
    return normalizeHandle(meta.handle);
  }
  const email = session?.user.email ?? '';
  const local = email.split('@')[0] ?? '';
  return local ? `@${local.toLowerCase()}` : '@you';
}

/** A stable stand-in handle for a user we can't name. */
export function peerHandle(userId: string): string {
  return `@${userId.replace(/-/g, '').slice(0, 6)}`;
}

/** "JR" from "@jreyes", "MD" from "@marcus_dl", "F" from "fittr". */
export function initialsOf(handle: string): string {
  const bare = handle.replace(/^@/, '');
  const parts = bare.split(/[._\-\s]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  }
  return bare.slice(0, 2).toUpperCase() || '?';
}

/** Handle for any participant, given who is signed in. */
export function handleFor(userId: string, session: Session | null): string {
  return userId === session?.user.id ? ownHandle(session) : peerHandle(userId);
}
