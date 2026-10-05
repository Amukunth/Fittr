import {
  deriveBoutStats,
  formatRaw,
  outcomeOf,
  rawFor,
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
    is_ranked: true,
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

/**
 * A participant row. `rep_count` / `hold_duration_seconds` is the raw
 * count; `score` is what settlement compares. A caller that gives only the
 * raw gets a score at 85% form, the way the migration backfilled old rows.
 */
function participant(
  matchId: string,
  userId: string,
  result: Partial<
    Pick<MatchParticipantRow, 'rep_count' | 'hold_duration_seconds' | 'score' | 'place'>
  > = {},
): MatchParticipantRow {
  const raw = result.rep_count ?? result.hold_duration_seconds ?? null;
  return {
    id: `${matchId}:${userId}`,
    match_id: matchId,
    user_id: userId,
    rep_count: null,
    hold_duration_seconds: null,
    time_seconds: null,
    score: result.score ?? (raw === null ? null : Math.round(raw * 85)),
    place: result.place ?? null,
    ...result,
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
    expect(stats.placed).toBe(0);
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

  it('pairs each bout with the other participant, their score and the raw behind it', () => {
    const m1 = stats.bouts.find(b => b.matchId === 'm1')!;
    expect(m1.opponentId).toBe(MARCUS);
    expect(m1.myScore).toBe(34 * 85);
    expect(m1.myRaw).toBe(34);
    expect(m1.opponentScore).toBe(31 * 85);
    expect(m1.opponents[0]!.raw).toBe(31);
    const m3 = stats.bouts.find(b => b.matchId === 'm3')!;
    expect(m3.opponentId).toBe(KT);
    expect(m3.opponentScore).toBeNull();
  });

  it('keeps a personal best per exercise in raw units, and a best score', () => {
    expect(stats.bestByType).toEqual({ pushups: 34, plank: 92 });
    expect(stats.bestScoreByType).toEqual({ pushups: 34 * 85, plank: 92 * 85 });
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

  it('decides on score, not on the raw count', () => {
    // Marcus did more reps at worse form; I scored higher.
    const upset = deriveBoutStats(ME, {
      ...rows,
      matches: [match('m1', 'c1', '2026-09-01T10:00:00Z', ME, true)],
      mine: [participant('m1', ME, { rep_count: 26, score: 2600, place: 1 })],
      others: [
        participant('m1', ME, { rep_count: 26, score: 2600, place: 1 }),
        participant('m1', MARCUS, { rep_count: 30, score: 2550, place: 2 }),
      ],
      ledger: [ledger('m1', -100, 'stake'), ledger('m1', 200, 'payout')],
    });
    const bout = upset.bouts[0]!;
    expect(bout.outcome).toBe('win');
    expect(bout.opponents[0]!.score).toBe(2550);
    expect(bout.myRaw).toBe(26);
    expect(upset.bestByType.pushups).toBe(26);
  });
});

/**
 * Pooled bouts. Since 20260919000000 settlement writes a place and pays
 * the top three, so the record can tell "shared first", "paid second" and
 * "lost" apart without reading the ledger.
 */
describe('deriveBoutStats: pooled bouts', () => {
  const D = 'dee-0000-0000-0000-0000000000004';
  const groupChallenge = (id: string, seats: number, stake: number): ChallengeRow => ({
    ...challenge(id, 'pushups', 'completed', stake),
    format: 'pooled',
    max_participants: seats,
  });

  /** Three seats at 100: ME and MARCUS tie on 30, KT trails on 20. */
  const splitPot: BoutRows = {
    mine: [participant('g1', ME, { rep_count: 30, place: 1 })],
    others: [
      participant('g1', ME, { rep_count: 30, place: 1 }),
      participant('g1', MARCUS, { rep_count: 30, place: 1 }),
      participant('g1', KT, { rep_count: 20, place: 3 }),
    ],
    matches: [match('g1', 'gc1', '2026-09-04T10:00:00Z', null, true)],
    challenges: [groupChallenge('gc1', 3, 100)],
    // Tied for first: places 1 and 2 shared, 120 each.
    ledger: [ledger('g1', -100, 'stake'), ledger('g1', 120, 'payout')],
  };

  it('reads a shared first place as a tie for the fighters who split it', () => {
    const stats = deriveBoutStats(ME, splitPot);
    const bout = stats.bouts[0]!;
    expect(bout.outcome).toBe('tie');
    expect(bout.delta).toBe(20);
    expect(bout.seats).toBe(3);
    expect(bout.myPlace).toBe(1);
    expect(stats.ties).toBe(1);
    expect(stats.wins).toBe(0);
  });

  it('reads third place with a prize as placed, counted as a loss in the record', () => {
    const asKt = deriveBoutStats(KT, {
      ...splitPot,
      mine: [participant('g1', KT, { rep_count: 20, place: 3 })],
      ledger: [
        { ...ledger('g1', -100, 'stake'), user_id: KT },
        { ...ledger('g1', 60, 'payout'), user_id: KT },
      ],
    });
    const bout = asKt.bouts[0]!;
    expect(bout.outcome).toBe('placed');
    expect(bout.delta).toBe(-40);
    expect(bout.myPlace).toBe(3);
    expect(asKt.placed).toBe(1);
    expect(asKt.losses).toBe(1);
    expect(asKt.ties).toBe(0);
    expect(asKt.history).toEqual(['L']);
  });

  it('reads a place with no prize as a loss', () => {
    const asD = deriveBoutStats(D, {
      ...splitPot,
      mine: [participant('g1', D, { rep_count: 5, place: 4 })],
      others: [...splitPot.others, participant('g1', D, { rep_count: 5, place: 4 })],
      challenges: [groupChallenge('gc1', 4, 100)],
      ledger: [{ ...ledger('g1', -100, 'stake'), user_id: D }],
    });
    expect(asD.bouts[0]!.outcome).toBe('loss');
    expect(asD.losses).toBe(1);
    expect(asD.placed).toBe(0);
  });

  it('still calls a sole winner a win when the pot is bigger than the stake', () => {
    const stats = deriveBoutStats(ME, {
      ...splitPot,
      matches: [match('g1', 'gc1', '2026-09-04T10:00:00Z', ME, true)],
      others: [
        participant('g1', ME, { rep_count: 40, place: 1 }),
        participant('g1', MARCUS, { rep_count: 30, place: 2 }),
        participant('g1', KT, { rep_count: 20, place: 3 }),
      ],
      mine: [participant('g1', ME, { rep_count: 40, place: 1 })],
      ledger: [ledger('g1', -100, 'stake'), ledger('g1', 150, 'payout')],
    });
    expect(stats.bouts[0]!.outcome).toBe('win');
    expect(stats.bouts[0]!.delta).toBe(50);
    expect(stats.wins).toBe(1);
  });

  it('falls back to the ledger for rows settled before places existed', () => {
    const legacy = deriveBoutStats(ME, {
      ...splitPot,
      mine: [participant('g1', ME, { rep_count: 30 })],
      others: [
        participant('g1', ME, { rep_count: 30 }),
        participant('g1', MARCUS, { rep_count: 30 }),
        participant('g1', KT, { rep_count: 20 }),
      ],
      ledger: [ledger('g1', -100, 'stake'), ledger('g1', 150, 'payout')],
    });
    expect(legacy.bouts[0]!.outcome).toBe('tie');
  });

  it('orders the field best score first and keeps the unscored last', () => {
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
    expect(bout.opponents.map(o => o.score)).toEqual([41 * 85, 25 * 85, null]);
    // The 1v1 surfaces read the first opponent, which is now the leader.
    expect(bout.opponentId).toBe(D);
    expect(bout.opponentScore).toBe(41 * 85);
    expect(bout.outcome).toBe('pending');
    expect(stats.active).toHaveLength(1);
  });

  it('counts every other fighter in a pooled bout as a rival', () => {
    const stats = deriveBoutStats(ME, splitPot);
    expect(stats.rivals.map(r => r.userId).sort()).toEqual([KT, MARCUS].sort());
    for (const rival of stats.rivals) {
      expect(rival).toMatchObject({ bouts: 1, wins: 0, losses: 0 });
    }
  });
});

describe('sortByScore', () => {
  it('puts the highest score first and the unscored last', () => {
    const field = [{ score: 20 }, { score: null }, { score: 41 }, { score: 25 }];
    expect(sortByScore(field).map(r => r.score)).toEqual([41, 25, 20, null]);
  });

  it('does not mutate the input', () => {
    const field = [{ score: 1 }, { score: 9 }];
    sortByScore(field);
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

  it('separates a shared pot from a loss by what the ledger paid, without a place', () => {
    expect(outcomeOf(settled, 'completed', ME, 50, 100)).toBe('tie');
    expect(outcomeOf(settled, 'completed', ME, 0, 100)).toBe('tie');
    expect(outcomeOf(settled, 'completed', ME, -100, 100)).toBe('loss');
  });

  it('reads the place when settlement wrote one', () => {
    expect(outcomeOf(settled, 'completed', ME, 20, 100, false, 1)).toBe('tie');
    expect(outcomeOf(settled, 'completed', ME, -40, 100, false, 3)).toBe('placed');
    expect(outcomeOf(settled, 'completed', ME, -100, 100, false, 4)).toBe('loss');
    expect(outcomeOf({ ...settled, winner_id: MARCUS }, 'completed', ME, 80, 100, false, 2)).toBe('placed');
  });

  it('names the sole winner from winner_id', () => {
    expect(outcomeOf({ ...settled, winner_id: ME }, 'completed', ME, 200, 100)).toBe('win');
    expect(outcomeOf({ ...settled, winner_id: MARCUS }, 'completed', ME, -100, 100)).toBe('loss');
  });

  it('reads a solo attempt off winner_id alone', () => {
    expect(outcomeOf({ ...settled, winner_id: ME }, 'completed', ME, 0, 100, true, 1)).toBe('win');
    expect(outcomeOf(settled, 'completed', ME, 0, 100, true, 1)).toBe('loss');
  });
});

describe('scores', () => {
  it('reads the score settle_match() compares, and the raw column behind it', () => {
    const p = participant('x', ME, { rep_count: 12, score: 1140 });
    expect(scoreFor(p)).toBe(1140);
    expect(rawFor(p, 'pushups')).toBe(12);
    expect(rawFor(participant('x', ME, { hold_duration_seconds: 75 }), 'wallsit')).toBe(75);
    expect(scoreFor(participant('x', ME))).toBeNull();
  });

  it('formats raw reps as a count and holds as a clock', () => {
    expect(formatRaw(34, 'pushups')).toBe('34');
    expect(formatRaw(92, 'plank')).toBe('1:32');
    expect(formatRaw(null, 'pushups')).toBe('—');
  });
});
