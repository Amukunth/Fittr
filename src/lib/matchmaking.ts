import { supabase } from './supabase';
import type { BoutRequest } from '../navigation/types';
import type {
  MatchmakingCancelReason,
  MatchmakingQueueRow,
} from '../types/database';

/**
 * The client half of the live matchmaking queue. Every mutation is one of
 * three SECURITY DEFINER functions (see the 20260908000000 migration and
 * BACKEND.md); nothing here writes a table directly.
 *
 * The constants mirror the ones declared at the top of that migration. If
 * one side changes, change the other.
 */

/** How often the Searching screen proves it is still alive. */
export const HEARTBEAT_MS = 5000;
/** Server-side: an entry with no heartbeat for this long is treated as gone. */
export const QUEUE_TTL_SECONDS = 20;
/**
 * Server-side: once BOTH a lobby and a fighter have waited this long, the
 * MMR window they may be paired within widens (150 -> 400 points). Both
 * sides must have waited, so nobody is widened before they have queued for
 * it themselves. Named for tiers before 20260909000000; matchmaking pairs
 * on skill rating now, and strength_tier gates nothing.
 */
export const RANK_WIDEN_AFTER_SECONDS = 45;

/** The MMR window between two PLACED fighters, before and after widening. */
export const MMR_WINDOW = 150;
export const MMR_WINDOW_WIDE = 400;
/** Seconds between "It's on" and the camera opening, for every participant. */
export const MATCH_COUNTDOWN_SECONDS = 3;

export type RpcResult<T> =
  | { data: T; error: null }
  | { data: null; error: string };

/** The server raises this when the entry has expired or was never ours. */
export const QUEUE_ENTRY_NOT_FOUND = 'queue_entry_not_found';

export function isQueueEntryGone(error: string | null): boolean {
  return error !== null && error.includes(QUEUE_ENTRY_NOT_FOUND);
}

/**
 * PostgREST returns a function declared `RETURNS matchmaking_queue` as one
 * JSON object. Kept defensive against the SETOF shape (an array) so a
 * later signature change cannot silently break the screen.
 */
function firstRow(data: unknown): MatchmakingQueueRow | null {
  if (Array.isArray(data)) {
    return (data[0] as MatchmakingQueueRow | undefined) ?? null;
  }
  if (data && typeof data === 'object') {
    return data as MatchmakingQueueRow;
  }
  return null;
}

async function call(
  fn: 'enter_matchmaking' | 'matchmaking_heartbeat' | 'leave_matchmaking',
  args: Record<string, unknown>,
): Promise<RpcResult<MatchmakingQueueRow>> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    return { data: null, error: error.message };
  }
  const row = firstRow(data);
  if (!row) {
    return { data: null, error: `${fn} returned no queue row` };
  }
  return { data: row, error: null };
}

/**
 * Join the queue for this request. Returns the caller's entry: status
 * `matched` (with match_id) when the lobby filled on this very call,
 * otherwise `searching`. Re-entering while an entry exists replaces it.
 */
export function enterMatchmaking(
  req: BoutRequest,
): Promise<RpcResult<MatchmakingQueueRow>> {
  return call('enter_matchmaking', {
    p_exercise_type: req.exerciseType,
    p_format: req.format,
    p_stake_points: req.stake,
    p_max_participants: req.maxParticipants,
  });
}

/**
 * Liveness plus catch-up: bumps last_seen_at and returns the entry as it is
 * now, so a realtime event missed while the socket was down is never fatal.
 * The server also uses the beat to move a lone fighter into a lobby that
 * became compatible after they entered (tier widening).
 */
export function heartbeat(
  queueId: string,
): Promise<RpcResult<MatchmakingQueueRow>> {
  return call('matchmaking_heartbeat', { p_queue_id: queueId });
}

/**
 * Cancel. If the lobby filled in the same instant, the row comes back as
 * `matched` and the caller is in the bout whether they like it or not (the
 * stakes are already moved) — the screen must take them there.
 */
export function leaveMatchmaking(
  queueId: string,
): Promise<RpcResult<MatchmakingQueueRow>> {
  return call('leave_matchmaking', { p_queue_id: queueId });
}

/** What to tell a fighter whose search ended without a bout. */
export function cancelReasonCopy(reason: MatchmakingCancelReason | null): string {
  switch (reason) {
    case 'insufficient_points':
      return 'The lobby filled, but your balance dropped under the stake. Pick a smaller one.';
    case 'replaced':
      return 'This search was ended from another device.';
    case 'expired':
    default:
      return 'The search timed out while the app was away. Tap to search again.';
  }
}

/**
 * The stable error codes enter_matchmaking() raises, mapped to copy. Anything
 * else is shown verbatim — a novel message is a bug worth seeing.
 */
export function enterErrorCopy(error: string): string {
  if (error.includes('round_open')) {
    return 'You still have a round to fight. Finish it from In the ring first.';
  }
  if (error.includes('insufficient_points')) {
    return "You don't have that stake. Pick a smaller one.";
  }
  if (error.includes('too_fast') || error.includes('search_in_flight')) {
    return 'Hold on a second, then try again.';
  }
  if (error.includes('exercise_not_available')) {
    return "That exercise isn't on the card yet.";
  }
  if (error.includes('profile_required')) {
    return 'Set up your profile before your first bout.';
  }
  return error;
}
