import type {
  ChallengeFormat,
  ChallengeRow,
  ChallengeStatus,
  ChallengeType,
  MatchParticipantRow,
  MatchRow,
  PointsLedgerEntryRow,
} from '../types/database';
import { fmtRaw } from './score';

/**
 * Pure derivation of a user's record from the rows the app can read. Kept
 * free of Supabase so it can be unit-tested (__tests__/boutStats.test.ts)
 * and so Compete, Profile and Results agree on every number.
 *
 * A bout has 1..32 seats (challenges.max_participants). Everything here is
 * written for the field, with `opponentId` / `opponentScore` kept as "the
 * first opponent" for the 1v1 surfaces.
 *
 * SINCE 20260919000000 A BOUT IS DECIDED ON match_participants.score, not
 * on the raw rep count or hold. Every comparison in this file reads the
 * score; the raw number is carried alongside for display ("34 reps") and
 * for the personal best, which stays in the exercise's own units.
 *
 * ONE SEAT IS A SOLO MODE (Blitz or Streak), and it is deliberately counted
 * differently in two places -- see `solo` on BoutSummary, outcomeOf(), and
 * the `settled` filter in deriveBoutStats(). Both differences exist so this
 * file agrees with what the database actually did rather than inventing a
 * head-to-head reading of a bout that had no other corner.
 */

/**
 * `placed`: paid out of a pooled pot without finishing first -- second or
 * third of the field. Counted as a loss in the W/L record, because that is
 * what the trophy ladder does with it (only the top score wins trophies;
 * see BACKEND.md), and the record here has to agree with the profile row it
 * sits beside.
 */
export type Outcome = 'win' | 'loss' | 'tie' | 'placed' | 'pending' | 'review';

export interface OpponentScore {
  userId: string;
  /** The score, or null until they have recorded. */
  score: number | null;
  /** The raw count behind it. */
  raw: number | null;
  place: number | null;
}

export interface BoutSummary {
  matchId: string;
  challengeId: string;
  type: ChallengeType;
  format: ChallengeFormat;
  stake: number;
  /** Seats on the match: 1 for a solo mode, 2 for 1v1, 3+ for a pooled bout. */
  seats: number;
  /**
   * A Blitz or Streak attempt: one seat, no opponent, judged against a
   * calibrated bar. Kept as its own flag rather than left as `seats === 1` at
   * every call site, because the distinction changes how the row reads, not
   * just how many names are on it.
   */
  solo: boolean;
  status: ChallengeStatus;
  /** Match creation, i.e. when the lobby filled (or the competition opened). */
  createdAt: string;
  settledAt: string | null;
  winnerId: string | null;
  /** My score, or null until I have recorded. */
  myScore: number | null;
  /** My raw count (reps / seconds), or null until I have recorded. */
  myRaw: number | null;
  /** My finishing place, or null until the bout settles. */
  myPlace: number | null;
  /** Every other fighter on the match, best score first, unscored last. */
  opponents: OpponentScore[];
  /** The first opponent (the only one in a 1v1). */
  opponentId: string | null;
  opponentScore: number | null;
  outcome: Outcome;
  /** Net points across this match's ledger entries. */
  delta: number;
}

export interface RivalSummary {
  userId: string;
  bouts: number;
  wins: number;
  losses: number;
  lastPlayedAt: string;
}

export type HistoryMark = 'W' | 'L' | 'T';

export interface BoutStats {
  /** Newest first. Includes solo attempts. */
  bouts: BoutSummary[];
  /** Unsettled bouts the user still has to fight or wait on, newest first. */
  active: BoutSummary[];
  /**
   * Settled HEAD-TO-HEAD bouts only. Every counter below it -- wins, losses,
   * ties, winRate, streak, history -- is the record against other people, and
   * solo attempts are excluded from all of them.
   *
   * That is not a display preference, it is agreement with the server:
   * _solo_settle() writes no trophies and does not touch total_wins /
   * total_losses / total_ties / current_streak, so a client that counted solo
   * attempts here would disagree with the profile row it sits next to. Solo
   * scores DO still feed bestByType, because a personal best is a personal
   * best however it was set.
   */
  played: number;
  wins: number;
  /** Includes `placed` finishes -- see Outcome. */
  losses: number;
  ties: number;
  /** Paid second or third places, already counted inside `losses`. */
  placed: number;
  /** Percent, or null before the first settled bout. */
  winRate: number | null;
  /** "W3", "L2", or "—". */
  streak: string;
  /** Last 12 settled results, oldest first. */
  history: HistoryMark[];
  /** Personal best RAW count per exercise, in its own units. */
  bestByType: Partial<Record<ChallengeType, number>>;
  /** Personal best SCORE per exercise. */
  bestScoreByType: Partial<Record<ChallengeType, number>>;
  /** Most-fought first. */
  rivals: RivalSummary[];
}

export interface BoutRows {
  /** This user's own match_participants rows. */
  mine: MatchParticipantRow[];
  /** Every participant row on those matches (self included is fine). */
  others: MatchParticipantRow[];
  matches: MatchRow[];
  challenges: ChallengeRow[];
  /** This user's ledger entries for those matches. */
  ledger: PointsLedgerEntryRow[];
}

export const EMPTY_STATS: BoutStats = {
  bouts: [],
  active: [],
  played: 0,
  wins: 0,
  losses: 0,
  ties: 0,
  placed: 0,
  winRate: null,
  streak: '—',
  history: [],
  bestByType: {},
  bestScoreByType: {},
  rivals: [],
};

/** The raw column for this challenge type: what the fighter can picture. */
export function rawFor(
  participant: MatchParticipantRow,
  type: ChallengeType,
): number | null {
  switch (type) {
    case 'pushups':
      return participant.rep_count;
    case 'plank':
    case 'wallsit':
      return participant.hold_duration_seconds;
    case 'race':
      return participant.time_seconds;
  }
}

/** The score settle_match() compares. Null until the round is recorded. */
export function scoreFor(participant: MatchParticipantRow): number | null {
  return participant.score ?? null;
}

/** "34" for reps, "2:12" for holds and times, "—" for nothing yet. */
export function formatRaw(
  raw: number | null,
  type: ChallengeType,
): string {
  return fmtRaw(raw, type);
}

/** Higher raw is better except race, where a faster time wins. Personal bests only. */
export function isBetter(candidate: number, current: number, type: ChallengeType) {
  return type === 'race' ? candidate < current : candidate > current;
}

/** Best score first; unscored fighters last. Score is higher-is-better for every type. */
export function sortByScore<T extends { score: number | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.score === null && b.score === null) {
      return 0;
    }
    if (a.score === null) {
      return 1;
    }
    if (b.score === null) {
      return -1;
    }
    return b.score - a.score;
  });
}

/**
 * How the bout went for `userId`. `winner_id` alone is not enough once a
 * bout can have more than two seats: settle_match() leaves it NULL for any
 * tie, and in a 3-way bout where two fighters tie for first the third has
 * still lost. Since 20260919000000 the finishing `place` settles it
 * exactly; before that (rows the migration backfilled without a place,
 * or a caller without one) the ledger is the tell -- a fighter who got any
 * of the pot back shared it.
 */
export function outcomeOf(
  match: Pick<MatchRow, 'settled_at' | 'winner_id'>,
  status: ChallengeStatus,
  userId: string,
  delta: number,
  stake: number,
  /** One seat: a Blitz or Streak attempt. Read off winner_id alone. */
  solo = false,
  /** The finishing place settlement wrote, when known. */
  place: number | null = null,
): Outcome {
  if (status === 'needs_review') {
    return 'review';
  }
  if (match.settled_at === null) {
    return 'pending';
  }
  // A solo attempt has no ledger tell to read. _solo_settle() sets winner_id
  // to the fighter exactly when they cleared the bar and leaves it NULL when
  // they did not. There is no tie to have with a threshold, and the ledger
  // cannot be used as the tell in any case: advancing into Streak stage 2
  // clears a bar and moves no points at all.
  if (solo) {
    return match.winner_id === userId ? 'win' : 'loss';
  }
  if (match.winner_id === userId) {
    return 'win';
  }
  if (place !== null) {
    if (place === 1) {
      // Shared first place: winner_id is NULL for every tie.
      return 'tie';
    }
    return delta > -stake ? 'placed' : 'loss';
  }
  if (match.winner_id === null && delta > -stake) {
    return 'tie';
  }
  return 'loss';
}

export function deriveBoutStats(userId: string, rows: BoutRows): BoutStats {
  const matchById = new Map(rows.matches.map(m => [m.id, m]));
  const challengeById = new Map(rows.challenges.map(c => [c.id, c]));

  const participantsByMatch = new Map<string, MatchParticipantRow[]>();
  for (const p of rows.others) {
    const list = participantsByMatch.get(p.match_id) ?? [];
    list.push(p);
    participantsByMatch.set(p.match_id, list);
  }

  const ledgerByMatch = new Map<string, number>();
  for (const entry of rows.ledger) {
    if (entry.match_id) {
      ledgerByMatch.set(
        entry.match_id,
        (ledgerByMatch.get(entry.match_id) ?? 0) + entry.amount,
      );
    }
  }

  const bouts: BoutSummary[] = [];
  for (const me of rows.mine) {
    const match = matchById.get(me.match_id);
    const challenge = match ? challengeById.get(match.challenge_id) : null;
    if (!match || !challenge) {
      continue;
    }
    const field = participantsByMatch.get(me.match_id) ?? [];
    const opponents = sortByScore(
      field
        .filter(p => p.user_id !== userId)
        .map(p => ({
          userId: p.user_id,
          score: scoreFor(p),
          raw: rawFor(p, challenge.type),
          place: p.place ?? null,
        })),
    );
    const solo = challenge.max_participants === 1;
    // No ledger row for this match means nothing moved, which is a real state
    // for a solo mode: advancing into Streak stage 2 or 3 opens a round on the
    // stake already paid at the start of the run. For a queued bout the stake
    // entry is always written by _mm_try_complete(), so the fallback there
    // stays what it has always been -- a defensive "you are down your stake".
    const ledgered = ledgerByMatch.get(me.match_id);
    const delta = ledgered ?? (solo ? 0 : -challenge.stake_points);
    const first = opponents[0] ?? null;
    const myPlace = me.place ?? null;
    bouts.push({
      matchId: match.id,
      challengeId: challenge.id,
      type: challenge.type,
      format: challenge.format,
      stake: challenge.stake_points,
      seats: challenge.max_participants,
      solo,
      status: challenge.status,
      createdAt: match.created_at,
      settledAt: match.settled_at,
      winnerId: match.winner_id,
      myScore: scoreFor(me),
      myRaw: rawFor(me, challenge.type),
      myPlace,
      opponents,
      opponentId: first?.userId ?? null,
      opponentScore: first?.score ?? null,
      outcome: outcomeOf(
        match,
        challenge.status,
        userId,
        delta,
        challenge.stake_points,
        solo,
        myPlace,
      ),
      delta,
    });
  }
  bouts.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  // Head-to-head only: see the note on BoutStats.played for why solo
  // attempts are excluded from the record but not from the feed.
  const settled = bouts.filter(
    b =>
      !b.solo &&
      (b.outcome === 'win' ||
        b.outcome === 'loss' ||
        b.outcome === 'tie' ||
        b.outcome === 'placed'),
  );
  const wins = settled.filter(b => b.outcome === 'win').length;
  const placed = settled.filter(b => b.outcome === 'placed').length;
  const losses = settled.filter(b => b.outcome === 'loss').length + placed;
  const ties = settled.length - wins - losses;

  // 'placed' reads as a loss on the streak and in the history, per Outcome.
  const markOf = (o: Outcome): HistoryMark =>
    o === 'win' ? 'W' : o === 'tie' ? 'T' : 'L';

  let streak = '—';
  if (settled.length) {
    const lead = markOf(settled[0]!.outcome);
    let run = 0;
    for (const b of settled) {
      if (markOf(b.outcome) !== lead) {
        break;
      }
      run += 1;
    }
    streak = lead === 'T' ? 'T' : `${lead}${run}`;
  }

  const history = settled
    .slice(0, 12)
    .reverse()
    .map<HistoryMark>(b => markOf(b.outcome));

  const bestByType: Partial<Record<ChallengeType, number>> = {};
  const bestScoreByType: Partial<Record<ChallengeType, number>> = {};
  for (const b of bouts) {
    if (b.myRaw !== null) {
      const current = bestByType[b.type];
      if (current === undefined || isBetter(b.myRaw, current, b.type)) {
        bestByType[b.type] = b.myRaw;
      }
    }
    if (b.myScore !== null) {
      const current = bestScoreByType[b.type];
      if (current === undefined || b.myScore > current) {
        bestScoreByType[b.type] = b.myScore;
      }
    }
  }

  const rivalMap = new Map<string, RivalSummary>();
  for (const b of bouts) {
    for (const opponent of b.opponents) {
      const r = rivalMap.get(opponent.userId) ?? {
        userId: opponent.userId,
        bouts: 0,
        wins: 0,
        losses: 0,
        lastPlayedAt: b.createdAt,
      };
      r.bouts += 1;
      if (b.outcome === 'win') {
        r.wins += 1;
      } else if (b.outcome === 'loss' || b.outcome === 'placed') {
        r.losses += 1;
      }
      if (b.createdAt > r.lastPlayedAt) {
        r.lastPlayedAt = b.createdAt;
      }
      rivalMap.set(opponent.userId, r);
    }
  }
  const rivals = [...rivalMap.values()].sort(
    (a, b) => b.bouts - a.bouts || (a.lastPlayedAt < b.lastPlayedAt ? 1 : -1),
  );

  return {
    bouts,
    active: bouts.filter(b => b.outcome === 'pending'),
    played: settled.length,
    wins,
    losses,
    ties,
    placed,
    winRate: settled.length
      ? Math.round((wins / settled.length) * 100)
      : null,
    streak,
    history,
    bestByType,
    bestScoreByType,
    rivals,
  };
}
