import { supabase } from './supabase';
import type { AgeBand, FitnessProfileRow, Gender } from '../types/database';

/**
 * Profile identity: display name, unique @username, avatar URL. Validation
 * here is for instant feedback only; update_my_profile() re-checks every
 * rule and owns uniqueness.
 */

export const USERNAME_RULE = /^[a-z0-9][a-z0-9._]{2,19}$/;
export const DISPLAY_NAME_MAX = 40;

/** Same normalisation as the database: lower-case, no leading '@', trimmed. */
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

export function usernameProblem(raw: string): string | null {
  const name = normalizeUsername(raw);
  if (name.length < 3) {
    return 'At least 3 characters.';
  }
  if (name.length > 20) {
    return 'At most 20 characters.';
  }
  if (!/^[a-z0-9]/.test(name)) {
    return 'Start with a letter or number.';
  }
  if (!USERNAME_RULE.test(name)) {
    return 'Letters, numbers, dots and underscores only.';
  }
  return null;
}

export function displayNameProblem(raw: string): string | null {
  const name = raw.trim();
  if (name.length > DISPLAY_NAME_MAX) {
    return `At most ${DISPLAY_NAME_MAX} characters.`;
  }
  return null;
}

/** Asks the server whether the name is free for the signed-in user. */
export async function usernameAvailable(raw: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('username_available', {
    p_username: normalizeUsername(raw),
  });
  if (error) {
    throw new Error(error.message);
  }
  return data === true;
}

export interface ProfilePatch {
  /** undefined = unchanged, '' = clear. */
  displayName?: string;
  /** undefined = unchanged. */
  username?: string;
  /** undefined = unchanged, '' = clear. */
  avatarUrl?: string;
  /**
   * undefined = unchanged. No clear path from the client -- these are
   * fixed-choice pickers, not free text; there is no "clear" affordance in
   * the UI, only "pick a different one." Optional forever either way: a
   * profile that never sets either just keeps getting the population-
   * median MMR seed during placement.
   */
  ageBand?: AgeBand;
  gender?: Gender;
}

const ERROR_COPY: Record<string, string> = {
  username_invalid: 'That username is not allowed.',
  username_taken: 'That username is taken.',
  display_name_invalid: `Display names are up to ${DISPLAY_NAME_MAX} characters.`,
  avatar_url_invalid: 'That photo could not be attached to your profile.',
};

export function humanizeProfileError(message: string): string {
  for (const [code, copy] of Object.entries(ERROR_COPY)) {
    if (message.includes(code)) {
      return copy;
    }
  }
  return message;
}

/**
 * Saves through update_my_profile(). Also mirrors the username into the
 * auth user's metadata, which is where ownHandle() has always read it.
 */
export async function updateMyProfile(patch: ProfilePatch): Promise<FitnessProfileRow> {
  const { data, error } = await supabase.rpc('update_my_profile', {
    p_display_name: patch.displayName ?? null,
    p_username: patch.username !== undefined ? normalizeUsername(patch.username) : null,
    p_avatar_url: patch.avatarUrl ?? null,
    p_age_band: patch.ageBand ?? null,
    p_gender: patch.gender ?? null,
  });
  if (error) {
    throw new Error(humanizeProfileError(error.message));
  }
  const row = data as FitnessProfileRow;
  if (patch.username !== undefined && row.username) {
    await supabase.auth.updateUser({ data: { handle: `@${row.username}` } });
  }
  return row;
}

/** The '@name' to show for a profile, preferring the profile's own username. */
export function profileHandle(profile: Pick<FitnessProfileRow, 'username'> | null, fallback: string): string {
  return profile?.username ? `@${profile.username}` : fallback;
}
