import {
  deriveBoutStats,
  formatScore,
  outcomeOf,
  scoreFor,
  sortByScore,
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
    max_participants: 2,
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

/**
 * Group Battles. settle_match() leaves winner_id NULL for ANY tie, so with
 * more than two seats winner_id alone cannot tell "shared the pot" from
 * "lost to the fighters who did" — the ledger is what separates them.
 */
describe('deriveBoutStats: group bouts', () => {
  const D = 'dee-0000-0000-0000-0000000000004';
  const groupChallenge = (id: string, seats: number, stake: number): ChallengeRow => ({
    ...challenge(id, 'pushups', 'completed', stake),
    format: 'pooled',
    max_participants: seats,
  });

  /** Three seats at 100: ME and MARCUS tie on 30, KT trails on 20. */
  const splitPot: BoutRows = {
    mine: [participant('g1', ME, { rep_count: 30 })],
    others: [
      participant('g1', ME, { rep_count: 30 }),
      participant('g1', MARCUS, { rep_count: 30 }),
      participant('g1', KT, { rep_count: 20 }),
    ],
    matches: [match('g1', 'gc1', '2026-09-04T10:00:00Z', null, true)],
    challenges: [groupChallenge('gc1', 3, 100)],
    ledger: [ledger('g1', -100, 'stake'), ledger('g1', 150, 'payout')],
  };

  it('reads a shared pot as a tie for the fighters who split it', () => {
    const stats = deriveBoutStats(ME, splitPot);
    const bout = stats.bouts[0]!;
    expect(bout.outcome).toBe('tie');
    expect(bout.delta).toBe(50);
    expect(bout.seats).toBe(3);
    expect(stats.ties).toBe(1);
    expect(stats.wins).toBe(0);
  });

  it('reads the same bout as a loss for the fighter who was paid nothing', () => {
    const asKt = deriveBoutStats(KT, {
      ...splitPot,
      mine: [participant('g1', KT, { rep_count: 20 })],
      ledger: [{ ...ledger('g1', -100, 'stake'), user_id: KT }],
    });
    const bout = asKt.bouts[0]!;
    expect(bout.outcome).toBe('loss');
    expect(bout.delta).toBe(-100);
    expect(asKt.losses).toBe(1);
    expect(asKt.ties).toBe(0);
  });

  it('still calls a sole winner a win when the pot is bigger than the stake', () => {
    const stats = deriveBoutStats(ME, {
      ...splitPot,
      matches: [match('g1', 'gc1', '2026-09-04T10:00:00Z', ME, true)],
      others: [
        participant('g1', ME, { rep_count: 40 }),
        participant('g1', MARCUS, { rep_count: 30 }),
        participant('g1', KT, { rep_count: 20 }),
      ],
      mine: [participant('g1', ME, { rep_count: 40 })],
      ledger: [ledger('g1', -100, 'stake'), ledger('g1', 300, 'payout')],
    });
    expect(stats.bouts[0]!.outcome).toBe('win');
    expect(stats.bouts[0]!.delta).toBe(200);
    expect(stats.wins).toBe(1);
  });

  it('orders the field best first and keeps the unscored last', () => {
    const stats = deriveBoutStats(ME, {
      ...splitPot,
      matches: [match('g1', 'gc1', '2026-09-04T10:00:00Z', null, false)],
      others: [
        participant('g1', ME, { rep_count: 30 }),
        participant('g1', MARCUS),
        participant('g1', KT, { rep_count: 25 }),
        participant('g1', D, { rep_count: 41 }),
      ],
      challenges: [groupChallenge('gc1', 4, 100)],
    });
    const bout = stats.bouts[0]!;
    expect(bout.opponents.map(o => o.userId)).toEqual([D, KT, MARCUS]);
    expect(bout.opponents.map(o => o.score)).toEqual([41, 25, null]);
    // The 1v1 surfaces read the first opponent, which is now the leader.
    expect(bout.opponentId).toBe(D);
    expect(bout.opponentScore).toBe(41);
    expect(bout.outcome).toBe('pending');
    expect(stats.active).toHaveLength(1);
  });

  it('counts every other fighter in a group as a rival', () => {
    const stats = deriveBoutStats(ME, splitPot);
    expect(stats.rivals.map(r => r.userId).sort()).toEqual([KT, MARCUS].sort());
    for (const rival of stats.rivals) {
      expect(rival).toMatchObject({ bouts: 1, wins: 0, losses: 0 });
    }
  });
});

describe('sortByScore', () => {
  it('puts the highest first, except for race where the fastest wins', () => {
    const field = [{ score: 20 }, { score: null }, { score: 41 }, { score: 25 }];
    expect(sortByScore(field, 'pushups').map(r => r.score)).toEqual([41, 25, 20, null]);
    expect(sortByScore(field, 'race').map(r => r.score)).toEqual([20, 25, 41, null]);
  });

  it('does not mutate the input', () => {
    const field = [{ score: 1 }, { score: 9 }];
    sortByScore(field, 'pushups');
    expect(field.map(r => r.score)).toEqual([1, 9]);
  });
});

describe('outcomeOf', () => {
  const settled = { settled_at: '2026-09-04T10:00:00Z', winner_id: null };

  it('puts an unreviewed anomaly ahead of everything else', () => {
    expect(outcomeOf(settled, 'needs_review', ME, -100, 100)).toBe('review');
  });

  it('is pending until the match settles', () => {
    expect(outcomeOf({ settled_at: null, winner_id: null }, 'matched', ME, -100, 100)).toBe('pending');
  });

  it('separates a shared pot from a loss by what the ledger paid', () => {
    expect(outcomeOf(settled, 'completed', ME, 50, 100)).toBe('tie');
    expect(outcomeOf(settled, 'completed', ME, 0, 100)).toBe('tie');
    expect(outcomeOf(settled, 'completed', ME, -100, 100)).toBe('loss');
  });

  it('names the sole winner from winner_id', () => {
    expect(outcomeOf({ ...settled, winner_id: ME }, 'completed', ME, 200, 100)).toBe('win');
    expect(outcomeOf({ ...settled, winner_id: MARCUS }, 'completed', ME, -100, 100)).toBe('loss');
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
