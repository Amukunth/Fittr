import type {
  ChallengeFormat,
  ChallengeRow,
  ChallengeStatus,
  ChallengeType,
  MatchParticipantRow,
  MatchRow,
  PointsLedgerEntryRow,
} from '../types/database';
import { formatSeconds } from './format';

/**
 * Pure derivation of a user's record from the rows the app can read. Kept
 * free of Supabase so it can be unit-tested (__tests__/boutStats.test.ts)
 * and so Home, Profile and Results agree on every number.
 *
 * A bout has 2..6 seats (challenges.max_participants). Everything here is
 * written for the field, with `opponentId` / `opponentScore` kept as "the
 * first opponent" for the 1v1 surfaces.
 */

export type Outcome = 'win' | 'loss' | 'tie' | 'pending' | 'review';

export interface OpponentScore {
  userId: string;
  score: number | null;
}

export interface BoutSummary {
  matchId: string;
  challengeId: string;
  type: ChallengeType;
  format: ChallengeFormat;
  stake: number;
  /** Seats on the match: 2 for 1v1, 3..6 for a Group Battle. */
  seats: number;
  status: ChallengeStatus;
  /** Match creation, i.e. when the lobby filled. */
  createdAt: string;
  settledAt: string | null;
  winnerId: string | null;
  myScore: number | null;
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
  /** Newest first. */
  bouts: BoutSummary[];
  /** Unsettled bouts the user still has to fight or wait on, newest first. */
  active: BoutSummary[];
  /** Settled bouts only. */
  played: number;
  wins: number;
  losses: number;
  ties: number;
  /** Percent, or null before the first settled bout. */
  winRate: number | null;
  /** "W3", "L2", or "—". */
  streak: string;
  /** Last 12 settled results, oldest first. */
  history: HistoryMark[];
  bestByType: Partial<Record<ChallengeType, number>>;
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
  winRate: null,
  streak: '—',
  history: [],
  bestByType: {},
  rivals: [],
};

/** The column that scores this challenge type. Mirrors settle_match(). */
export function scoreFor(
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

/** "34" for reps, "2:12" for holds and times, "—" for nothing yet. */
export function formatScore(
  score: number | null,
  type: ChallengeType,
): string {
  if (score === null) {
    return '—';
  }
  return type === 'pushups' ? String(score) : formatSeconds(score);
}

/** Higher is better except race, where a faster time wins. */
export function isBetter(candidate: number, current: number, type: ChallengeType) {
  return type === 'race' ? candidate < current : candidate > current;
}

/** Best score first; unscored fighters last. */
export function sortByScore<T extends { score: number | null }>(
  rows: T[],
  type: ChallengeType,
): T[] {
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
    if (a.score === b.score) {
      return 0;
    }
    return isBetter(a.score, b.score, type) ? -1 : 1;
  });
}

/**
 * How the bout went for `userId`. `winner_id` alone is not enough once a
 * bout can have more than two seats: settle_match() leaves it NULL for any
 * tie, and in a 3-way bout where two fighters tie for first the third has
 * still lost. The ledger tells them apart — a fighter who got any of the
 * pot back (their delta is better than losing the whole stake) shared it.
 */
export function outcomeOf(
  match: Pick<MatchRow, 'settled_at' | 'winner_id'>,
  status: ChallengeStatus,
  userId: string,
  delta: number,
  stake: number,
): Outcome {
  if (status === 'needs_review') {
    return 'review';
  }
  if (match.settled_at === null) {
    return 'pending';
  }
  if (match.winner_id === userId) {
    return 'win';
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
        .map(p => ({ userId: p.user_id, score: scoreFor(p, challenge.type) })),
      challenge.type,
    );
    const delta = ledgerByMatch.get(me.match_id) ?? -challenge.stake_points;
    const first = opponents[0] ?? null;
    bouts.push({
      matchId: match.id,
      challengeId: challenge.id,
      type: challenge.type,
      format: challenge.format,
      stake: challenge.stake_points,
      seats: challenge.max_participants,
      status: challenge.status,
      createdAt: match.created_at,
      settledAt: match.settled_at,
      winnerId: match.winner_id,
      myScore: scoreFor(me, challenge.type),
      opponents,
      opponentId: first?.userId ?? null,
      opponentScore: first?.score ?? null,
      outcome: outcomeOf(match, challenge.status, userId, delta, challenge.stake_points),
      delta,
    });
  }
  bouts.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const settled = bouts.filter(
    b => b.outcome === 'win' || b.outcome === 'loss' || b.outcome === 'tie',
  );
  const wins = settled.filter(b => b.outcome === 'win').length;
  const losses = settled.filter(b => b.outcome === 'loss').length;
  const ties = settled.length - wins - losses;

  let streak = '—';
  if (settled.length) {
    const lead = settled[0]!.outcome;
    let run = 0;
    for (const b of settled) {
      if (b.outcome !== lead) {
        break;
      }
      run += 1;
    }
    streak = lead === 'tie' ? 'T' : `${lead === 'win' ? 'W' : 'L'}${run}`;
  }

  const history = settled
    .slice(0, 12)
    .reverse()
    .map<HistoryMark>(b =>
      b.outcome === 'win' ? 'W' : b.outcome === 'loss' ? 'L' : 'T',
    );

  const bestByType: Partial<Record<ChallengeType, number>> = {};
  for (const b of bouts) {
    if (b.myScore === null) {
      continue;
    }
    const current = bestByType[b.type];
    if (current === undefined || isBetter(b.myScore, current, b.type)) {
      bestByType[b.type] = b.myScore;
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
      } else if (b.outcome === 'loss') {
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
    winRate: settled.length
      ? Math.round((wins / settled.length) * 100)
      : null,
    streak,
    history,
    bestByType,
    rivals,
  };
}
