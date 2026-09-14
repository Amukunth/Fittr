/**
 * The display half of the trophy ladder. Pure functions, no database: the
 * rules these mirror are asserted against the real SQL in rank.db.test.ts,
 * and what is tested here is what the Rank screen renders from them.
 */
import {
  LEAGUES,
  LEAGUE_COLOR,
  LEAGUE_MIN_TROPHIES,
  TROPHY_STREAK_BONUS_CAP,
  TROPHY_WIN_BASE,
  fmtWager,
  leagueIndex,
  leagueOf,
  leagueProgress,
  nextLeague,
  ordinal,
  placeColor,
  rankEventCopy,
  standingOf,
  thresholdsFrom,
  trophyWinAward,
  winRate,
} from '../src/lib/league';
import type { LeagueTier, LeagueTierRow, RankHistoryRow } from '../src/types/database';

type Event = Pick<
  RankHistoryRow,
  'event_type' | 'trophy_delta' | 'trophy_balance' | 'opponent_id'
>;

function event(over: Partial<Event>): Event {
  return {
    event_type: 'win',
    trophy_delta: 12,
    trophy_balance: 12,
    opponent_id: null,
    ...over,
  };
}

describe('leagueOf', () => {
  it('puts a count in the league whose threshold it has passed', () => {
    expect(leagueOf(0)).toBe('bronze');
    expect(leagueOf(49)).toBe('bronze');
    expect(leagueOf(50)).toBe('silver');
    expect(leagueOf(149)).toBe('silver');
    expect(leagueOf(150)).toBe('gold');
    expect(leagueOf(299)).toBe('gold');
    expect(leagueOf(300)).toBe('platinum');
    expect(leagueOf(499)).toBe('platinum');
    expect(leagueOf(500)).toBe('diamond');
    expect(leagueOf(10_000)).toBe('diamond');
  });

  it('treats a negative count as zero rather than as unranked', () => {
    expect(leagueOf(-5)).toBe('bronze');
  });
});

describe('nextLeague and leagueIndex', () => {
  it('walks up the ladder and stops at the top', () => {
    expect(LEAGUES.map(nextLeague)).toEqual([
      'silver',
      'gold',
      'platinum',
      'diamond',
      null,
    ]);
  });

  it('orders the five leagues', () => {
    expect(LEAGUES.map(leagueIndex)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('standingOf', () => {
  it('splits the ladder into completed, current and locked', () => {
    expect(LEAGUES.map(t => standingOf(t, 'gold'))).toEqual([
      'completed',
      'completed',
      'current',
      'locked',
      'locked',
    ]);
  });

  it('leaves nothing locked at the top and nothing completed at the bottom', () => {
    expect(LEAGUES.map(t => standingOf(t, 'diamond'))).not.toContain('locked');
    expect(LEAGUES.map(t => standingOf(t, 'bronze'))).not.toContain('completed');
  });
});

describe('leagueProgress', () => {
  it('measures across the current league, not from zero', () => {
    // 200 is 50 into Gold's 150 span (150..300), so the bar is a third full
    // -- not the two thirds it would read if it measured from zero.
    const p = leagueProgress(200);
    expect(p.next).toBe('platinum');
    expect(p.target).toBe(300);
    expect(p.remaining).toBe(100);
    expect(p.fraction).toBeCloseTo(50 / 150, 5);
  });

  it('starts a newly promoted fighter near empty', () => {
    expect(leagueProgress(150).fraction).toBe(0);
    expect(leagueProgress(150).remaining).toBe(150);
  });

  it('reports the top of the ladder as finished with nothing left', () => {
    const p = leagueProgress(900);
    expect(p.next).toBeNull();
    expect(p.remaining).toBe(0);
    expect(p.fraction).toBe(1);
  });

  it('reads the thresholds it is given, so a server change needs no build', () => {
    const moved: Record<LeagueTier, number> = {
      ...LEAGUE_MIN_TROPHIES,
      silver: 100,
    };
    expect(leagueProgress(60, moved).next).toBe('silver');
    expect(leagueProgress(60, moved).remaining).toBe(40);
    // The same count against the shipped table is already in Silver.
    expect(leagueProgress(60).next).toBe('gold');
  });
});

describe('thresholdsFrom', () => {
  it('takes the server rows over the mirrored constants', () => {
    const rows: LeagueTierRow[] = [
      { id: '1', name: 'silver', min_trophies: 75, max_wager_cents: 2500, color_hex: '#C0C0C0' },
    ];
    const table = thresholdsFrom(rows);
    expect(table.silver).toBe(75);
    // Anything the server did not send keeps the mirrored value.
    expect(table.gold).toBe(LEAGUE_MIN_TROPHIES.gold);
  });

  it('falls back to the mirror entirely when nothing has loaded', () => {
    expect(thresholdsFrom([])).toEqual(LEAGUE_MIN_TROPHIES);
  });
});

describe('trophyWinAward', () => {
  it('pays the base for a first win and one more per straight win, to the cap', () => {
    expect(trophyWinAward(1)).toBe(TROPHY_WIN_BASE);
    expect(trophyWinAward(2)).toBe(TROPHY_WIN_BASE + 1);
    expect(trophyWinAward(6)).toBe(TROPHY_WIN_BASE + TROPHY_STREAK_BONUS_CAP);
    expect(trophyWinAward(40)).toBe(TROPHY_WIN_BASE + TROPHY_STREAK_BONUS_CAP);
  });
});

describe('winRate', () => {
  it('counts a tie in the denominator and not in the numerator', () => {
    // The same rule deriveBoutStats() uses, so Rank and Profile agree.
    expect(winRate(3, 1, 0)).toBe(75);
    expect(winRate(3, 1, 2)).toBe(50);
  });

  it('is null before the first settled bout, and zero after a first loss', () => {
    expect(winRate(0, 0, 0)).toBeNull();
    expect(winRate(0, 1, 0)).toBe(0);
  });
});

describe('fmtWager', () => {
  it('writes whole-dollar ceilings without cents', () => {
    expect(fmtWager(1000)).toBe('$10');
    expect(fmtWager(2500)).toBe('$25');
    expect(fmtWager(25000)).toBe('$250');
  });

  it('keeps the cents when there are any', () => {
    expect(fmtWager(1250)).toBe('$12.50');
  });
});

describe('ordinal and placeColor', () => {
  it('handles the teens, which are not 1st, 2nd, 3rd', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 102].map(ordinal)).toEqual([
      '1ST',
      '2ND',
      '3RD',
      '4TH',
      '11TH',
      '12TH',
      '13TH',
      '21ST',
      '102ND',
    ]);
  });

  it('gives the podium the three metals and everyone else nothing', () => {
    expect(placeColor(1)).toBe(LEAGUE_COLOR.gold);
    expect(placeColor(2)).toBe(LEAGUE_COLOR.silver);
    expect(placeColor(3)).toBe(LEAGUE_COLOR.bronze);
    expect(placeColor(4)).toBeNull();
  });
});

describe('rankEventCopy', () => {
  it('names the opponent in a head-to-head and says nothing in a group bout', () => {
    expect(rankEventCopy(event({}), '@rey').title).toBe('Won 12 trophies vs @rey');
    expect(rankEventCopy(event({}), null).title).toBe('Won 12 trophies');
  });

  it('writes a single trophy in the singular', () => {
    expect(rankEventCopy(event({ trophy_delta: 1 }), null).title).toBe('Won 1 trophy');
  });

  it('signs a loss with a true minus and points the arrow down', () => {
    const copy = rankEventCopy(
      event({ event_type: 'loss', trophy_delta: -6, trophy_balance: 34 }),
      '@rey',
    );
    expect(copy.title).toBe('Lost 6 trophies vs @rey');
    expect(copy.delta).toBe('−6');
    expect(copy.direction).toBe('down');
  });

  it('does not claim a fighter on zero lost anything', () => {
    const copy = rankEventCopy(
      event({ event_type: 'loss', trophy_delta: 0, trophy_balance: 0 }),
      '@rey',
    );
    expect(copy.title).toBe('Held at 0 vs @rey');
    expect(copy.delta).toBeNull();
    expect(copy.direction).toBe('flat');
  });

  it('reads a league move off the balance it left behind', () => {
    const up = rankEventCopy(
      event({ event_type: 'promotion', trophy_delta: 0, trophy_balance: 156 }),
      null,
    );
    expect(up).toEqual({
      title: 'Promoted to Gold',
      delta: null,
      direction: 'up',
      tier: 'gold',
    });

    const down = rankEventCopy(
      event({ event_type: 'demotion', trophy_delta: 0, trophy_balance: 46 }),
      null,
    );
    expect(down).toMatchObject({
      title: 'Dropped to Bronze',
      direction: 'down',
      tier: 'bronze',
    });
  });

  it('calls a shared first place what it is', () => {
    const copy = rankEventCopy(
      event({ event_type: 'tie', trophy_delta: 6, trophy_balance: 18 }),
      null,
    );
    expect(copy.title).toBe('Shared the win');
    expect(copy.delta).toBe('+6');
    expect(copy.direction).toBe('up');
  });
});
