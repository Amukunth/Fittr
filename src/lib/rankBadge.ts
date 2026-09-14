import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LeagueTier } from '../types/database';

/**
 * The trophy count behind the Rank tab's badge, shared by every screen that
 * draws the tab bar.
 *
 * A module-level store rather than a hook per screen, because the tab bar is
 * rendered by Bouts, Find, Profile AND Rank: four independent fetches and
 * four realtime channels for one small number would be absurd. useRankStanding
 * publishes into it, useTrophyBadge reads it, and the one screen that has the
 * real standing keeps the other three's badges honest for free.
 *
 * The "ranked up" dot is per user and per device, like the onboarding flag,
 * and fails open the same way: a broken store must never leave a dot stuck on.
 */

export interface BadgeState {
  /** null until something has fetched it. */
  trophies: number | null;
  league: LeagueTier | null;
  /** The league the fighter has already been shown on the Rank screen. */
  seenLeague: LeagueTier | null;
}

const EMPTY: BadgeState = { trophies: null, league: null, seenLeague: null };

let state: BadgeState = EMPTY;
let listeners: Array<(next: BadgeState) => void> = [];

function emit() {
  for (const listener of listeners) {
    listener(state);
  }
}

export function getBadge(): BadgeState {
  return state;
}

export function subscribeBadge(listener: (next: BadgeState) => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter(l => l !== listener);
  };
}

/** What the tab badge should show, or null for no badge at all. */
export function badgeContentOf(badge: BadgeState): number | 'dot' | null {
  if (badge.league && badge.seenLeague && badge.league !== badge.seenLeague) {
    return 'dot';
  }
  if (badge.trophies === null || badge.trophies <= 0) {
    return null;
  }
  return badge.trophies;
}

/** Called by whichever hook has just learned the real numbers. */
export function publishStanding(trophies: number, league: LeagueTier): void {
  if (state.trophies === trophies && state.league === league) {
    return;
  }
  state = { ...state, trophies, league };
  emit();
}

const seenKey = (userId: string) => `fittr:rank-seen:${userId}`;

/**
 * Loads the league this device last showed the fighter. Until it resolves,
 * seenLeague stays null and badgeContentOf() shows the count rather than the
 * dot -- so a cold start never claims a rank-up that already happened.
 */
export async function loadSeenLeague(userId: string): Promise<void> {
  try {
    const stored = (await AsyncStorage.getItem(seenKey(userId))) as LeagueTier | null;
    state = { ...state, seenLeague: stored };
    emit();
  } catch {
    // Leave it null: the badge falls back to the trophy count.
  }
}

/** The fighter has now seen this league on the Rank screen. */
export async function markLeagueSeen(
  userId: string,
  league: LeagueTier,
): Promise<void> {
  if (state.seenLeague === league) {
    return;
  }
  state = { ...state, seenLeague: league };
  emit();
  try {
    await AsyncStorage.setItem(seenKey(userId), league);
  } catch {
    // The dot reappears next launch. Harmless.
  }
}

/** Sign-out: the next account must not inherit this one's badge. */
export function resetBadge(): void {
  state = EMPTY;
  emit();
}
