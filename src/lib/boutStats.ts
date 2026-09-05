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
 * and so Profile and ChallengeDetail agree on every number.
 */

export type Outcome = 'win' | 'loss' | 'tie' | 'pending' | 'review';

export interface BoutSummary {
  matchId: string;
  challengeId: string;
  type: ChallengeType;
  format: ChallengeFormat;
  stake: number;
  status: ChallengeStatus;
  /** Match creation, i.e. when it was accepted. */
  createdAt: string;
  settledAt: string | null;
  winnerId: string | null;
  myScore: number | null;
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
function isBetter(candidate: number, current: number, type: ChallengeType) {
  return type === 'race' ? candidate < current : candidate > current;
}

function outcomeOf(match: MatchRow, status: ChallengeStatus, userId: string) {
  if (status === 'needs_review') {
    return 'review' as const;
  }
  if (match.settled_at === null) {
    return 'pending' as const;
  }
  if (match.winner_id === null) {
    return 'tie' as const;
  }
  return match.winner_id === userId ? ('win' as const) : ('loss' as const);
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
    const opponent =
      (participantsByMatch.get(me.match_id) ?? []).find(
        p => p.user_id !== userId,
      ) ?? null;
    bouts.push({
      matchId: match.id,
      challengeId: challenge.id,
      type: challenge.type,
      format: challenge.format,
      stake: challenge.stake_points,
      status: challenge.status,
      createdAt: match.created_at,
      settledAt: match.settled_at,
      winnerId: match.winner_id,
      myScore: scoreFor(me, challenge.type),
      opponentId: opponent?.user_id ?? null,
      opponentScore: opponent ? scoreFor(opponent, challenge.type) : null,
      outcome: outcomeOf(match, challenge.status, userId),
      delta: ledgerByMatch.get(me.match_id) ?? -challenge.stake_points,
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
    if (!b.opponentId) {
      continue;
    }
    const r = rivalMap.get(b.opponentId) ?? {
      userId: b.opponentId,
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
    rivalMap.set(b.opponentId, r);
  }
  const rivals = [...rivalMap.values()].sort(
    (a, b) => b.bouts - a.bouts || (a.lastPlayedAt < b.lastPlayedAt ? 1 : -1),
  );

  return {
    bouts,
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
