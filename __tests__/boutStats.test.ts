import {
  deriveBoutStats,
  formatScore,
  scoreFor,
  type BoutRows,
} from '../src/lib/boutStats';
import type {
  ChallengeRow,
  MatchParticipantRow,
  MatchRow,
  PointsLedgerEntryRow,
} from '../src/types/database';

const ME = 'me-0000-0000-0000-000000000001';
const MARCUS = 'marcus-0000-0000-0000-00000000002';
const KT = 'kt-0000-0000-0000-000000000000003';

function challenge(
  id: string,
  type: ChallengeRow['type'],
  status: ChallengeRow['status'],
  stake = 100,
): ChallengeRow {
  return {
    id,
    type,
    format: '1v1',
    stake_points: stake,
    status,
    created_by: MARCUS,
    created_at: '2026-09-01T00:00:00Z',
  };
}

function match(
  id: string,
  challengeId: string,
  createdAt: string,
  winner: string | null,
  settled: boolean,
): MatchRow {
  return {
    id,
    challenge_id: challengeId,
    winner_id: winner,
    settled_at: settled ? createdAt : null,
    created_at: createdAt,
  };
}

function participant(
  matchId: string,
  userId: string,
  score: Partial<Pick<MatchParticipantRow, 'rep_count' | 'hold_duration_seconds'>> = {},
): MatchParticipantRow {
  return {
    id: `${matchId}:${userId}`,
    match_id: matchId,
    user_id: userId,
    rep_count: null,
    hold_duration_seconds: null,
    time_seconds: null,
    ...score,
  };
}

function ledger(
  matchId: string,
  amount: number,
  reason: PointsLedgerEntryRow['reason'],
): PointsLedgerEntryRow {
  return {
    id: `${matchId}:${reason}:${amount}`,
    user_id: ME,
    amount,
    reason,
    match_id: matchId,
    created_at: '2026-09-01T00:00:00Z',
  };
}

/**
 * Three bouts, newest first once derived:
 *   m3 (Sep 3) pending plank vs KT, I've scored, they haven't.
 *   m2 (Sep 2) lost push-ups to Marcus 31–34.
 *   m1 (Sep 1) won push-ups vs Marcus 34–31, stake 100.
 */
const rows: BoutRows = {
  mine: [
    participant('m1', ME, { rep_count: 34 }),
    participant('m2', ME, { rep_count: 31 }),
    participant('m3', ME, { hold_duration_seconds: 92 }),
  ],
  others: [
    participant('m1', ME, { rep_count: 34 }),
    participant('m1', MARCUS, { rep_count: 31 }),
    participant('m2', ME, { rep_count: 31 }),
    participant('m2', MARCUS, { rep_count: 34 }),
    participant('m3', ME, { hold_duration_seconds: 92 }),
    participant('m3', KT),
  ],
  matches: [
    match('m1', 'c1', '2026-09-01T10:00:00Z', ME, true),
    match('m2', 'c2', '2026-09-02T10:00:00Z', MARCUS, true),
    match('m3', 'c3', '2026-09-03T10:00:00Z', null, false),
  ],
  challenges: [
    challenge('c1', 'pushups', 'completed', 100),
    challenge('c2', 'pushups', 'completed', 250),
    challenge('c3', 'plank', 'matched', 50),
  ],
  ledger: [
    ledger('m1', -100, 'stake'),
    ledger('m1', 200, 'payout'),
    ledger('m2', -250, 'stake'),
    ledger('m3', -50, 'stake'),
  ],
};

describe('deriveBoutStats', () => {
  const stats = deriveBoutStats(ME, rows);

  it('orders bouts newest first and classifies outcomes', () => {
    expect(stats.bouts.map(b => b.matchId)).toEqual(['m3', 'm2', 'm1']);
    expect(stats.bouts.map(b => b.outcome)).toEqual(['pending', 'loss', 'win']);
  });

  it('counts only settled bouts in the record', () => {
    expect(stats.played).toBe(2);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
    expect(stats.ties).toBe(0);
    expect(stats.winRate).toBe(50);
  });

  it('reads the streak from the most recent settled bout', () => {
    expect(stats.streak).toBe('L1');
  });

  it('lists history oldest first', () => {
    expect(stats.history).toEqual(['W', 'L']);
  });

  it('nets each bout from its ledger entries', () => {
    const byId = new Map(stats.bouts.map(b => [b.matchId, b.delta]));
    expect(byId.get('m1')).toBe(100);
    expect(byId.get('m2')).toBe(-250);
    expect(byId.get('m3')).toBe(-50);
  });

  it('pairs each bout with the other participant and their score', () => {
    const m1 = stats.bouts.find(b => b.matchId === 'm1')!;
    expect(m1.opponentId).toBe(MARCUS);
    expect(m1.myScore).toBe(34);
    expect(m1.opponentScore).toBe(31);
    const m3 = stats.bouts.find(b => b.matchId === 'm3')!;
    expect(m3.opponentId).toBe(KT);
    expect(m3.opponentScore).toBeNull();
  });

  it('keeps a personal best per exercise', () => {
    expect(stats.bestByType).toEqual({ pushups: 34, plank: 92 });
  });

  it('ranks rivals by bouts fought, with the record against each', () => {
    expect(stats.rivals.map(r => r.userId)).toEqual([MARCUS, KT]);
    expect(stats.rivals[0]).toMatchObject({ bouts: 2, wins: 1, losses: 1 });
    expect(stats.rivals[1]).toMatchObject({ bouts: 1, wins: 0, losses: 0 });
  });

  it('returns an empty record with no rows', () => {
    const empty = deriveBoutStats(ME, {
      mine: [],
      others: [],
      matches: [],
      challenges: [],
      ledger: [],
    });
    expect(empty.played).toBe(0);
    expect(empty.winRate).toBeNull();
    expect(empty.streak).toBe('—');
    expect(empty.history).toEqual([]);
  });

  it('treats a settled match with no winner as a tie', () => {
    const tie = deriveBoutStats(ME, {
      ...rows,
      matches: [match('m1', 'c1', '2026-09-01T10:00:00Z', null, true)],
      mine: [participant('m1', ME, { rep_count: 30 })],
      others: [
        participant('m1', ME, { rep_count: 30 }),
        participant('m1', MARCUS, { rep_count: 30 }),
      ],
      ledger: [ledger('m1', -100, 'stake'), ledger('m1', 100, 'payout')],
    });
    expect(tie.bouts[0]!.outcome).toBe('tie');
    expect(tie.bouts[0]!.delta).toBe(0);
    expect(tie.streak).toBe('T');
  });
});

describe('scores', () => {
  it('picks the column settle_match() compares', () => {
    expect(scoreFor(participant('x', ME, { rep_count: 12 }), 'pushups')).toBe(12);
    expect(
      scoreFor(participant('x', ME, { hold_duration_seconds: 75 }), 'wallsit'),
    ).toBe(75);
    expect(scoreFor(participant('x', ME), 'plank')).toBeNull();
  });

  it('formats reps as a count and holds as a clock', () => {
    expect(formatScore(34, 'pushups')).toBe('34');
    expect(formatScore(92, 'plank')).toBe('1:32');
    expect(formatScore(null, 'pushups')).toBe('—');
  });
});
