import { rpc, type SoloResult } from './soloModes';
import type { PooledFeaturedRow } from '../types/database';

/**
 * The client half of the featured pooled competition. Two SECURITY DEFINER
 * functions (see 20260919000000 and BACKEND.md, "The featured pooled
 * competition"); nothing here writes a table, and nothing here decides a
 * prize -- the server ranks the field and pays the table at settlement.
 */

/** Mirrors _pool_prize_shares_bp(): 50 / 30 / 20 of the pot to the top three. */
export const POOL_PRIZE_SHARES_BP: readonly number[] = [5000, 3000, 2000];

/** Mirrors _pool_entry_fee() / _pool_max_entries(). Display fallbacks only; the row carries the real ones. */
export const POOL_ENTRY_FEE = 100;
export const POOL_MAX_ENTRIES = 6;

/** The competition on the card, opened on demand. Reads only; stakes nothing. */
export function pooledFeatured(): Promise<SoloResult<PooledFeaturedRow>> {
  return rpc<PooledFeaturedRow>('pooled_featured', {});
}

/** Take a seat and pay the fee. The returned row carries the match_id to play now. */
export function pooledEnter(): Promise<SoloResult<PooledFeaturedRow>> {
  return rpc<PooledFeaturedRow>('pooled_enter', {});
}

/**
 * What one finishing place pays out of a pot, mirroring the per-share
 * truncation in settle_match(). Places past the table pay nothing. Ties
 * are settled server-side by sharing consecutive places; this is the
 * untied figure a preview shows.
 */
export function prizeFor(
  pot: number,
  place: number,
  shares: readonly number[] = POOL_PRIZE_SHARES_BP,
): number {
  const share = shares[place - 1];
  if (share === undefined) {
    return 0;
  }
  return Math.floor((pot * share) / 10000);
}

/** "1ST" / "2ND" / "3RD" / "4TH" ... */
export function fmtPlace(place: number): string {
  const n = Math.max(1, Math.floor(place));
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) {
    return `${n}TH`;
  }
  switch (n % 10) {
    case 1:
      return `${n}ST`;
    case 2:
      return `${n}ND`;
    case 3:
      return `${n}RD`;
    default:
      return `${n}TH`;
  }
}

/** The stable error codes pooled_enter() raises, mapped to copy. */
export function pooledErrorCopy(error: string): string {
  if (error.includes('pool_already_entered')) {
    return "You're already in this one. Play your round.";
  }
  if (error.includes('pool_full')) {
    return 'The last seat just went. The next competition is up.';
  }
  if (error.includes('pool_not_open')) {
    return 'No competition is open right now. Pull to refresh.';
  }
  if (error.includes('round_open')) {
    return 'You still have a round to fight. Finish it first.';
  }
  if (error.includes('insufficient_points')) {
    return "You don't have the entry fee.";
  }
  if (error.includes('profile_required')) {
    return 'Set up your profile before your first bout.';
  }
  return error;
}
