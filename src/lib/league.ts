import type {
  LeagueTier,
  LeagueTierRow,
  RankEventType,
  RankHistoryRow,
} from '../types/database';

/**
 * The client half of the trophy ladder. Pure functions only, so every
 * display rule is unit-testable without a database
 * (__tests__/league.test.ts).
 *
 * The constants mirror the tunables and the league_tiers seed in the
 * 20260913000000_league_rank migration, the same arrangement skillRating.ts
 * has with the MMR bands. __tests__/rank.db.test.ts asserts the mirror
 * against the database, so the two cannot drift silently -- but the
 * database is the source of truth, and where a screen can read the real
 * league_tiers rows (useLeagueTiers) it should render those instead of
 * LEAGUE_MIN_TROPHIES / LEAGUE_MAX_WAGER_CENTS below.
 *
 * The one exception is colour. LEAGUE_COLOR is a design token, not data:
 * the badge glow, the progress fill and the tier card's wash are all mixed
 * from it at build time, and a hex arriving over the network could not
 * participate in that. league_tiers.color_hex exists so the two agree.
 */

/** Ascending. The order leagues are shown in, and their relative rank. */
export const LEAGUES: readonly LeagueTier[] = [
  'bronze',
  'silver',
  'gold',
  'platinum',
  'diamond',
];

export const LEAGUE_LABEL: Record<LeagueTier, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  platinum: 'Platinum',
  diamond: 'Diamond',
};

/** Mirrors league_tiers.min_trophies. The floor of each league. */
export const LEAGUE_MIN_TROPHIES: Record<LeagueTier, number> = {
  bronze: 0,
  silver: 50,
  gold: 150,
  platinum: 300,
  diamond: 500,
};

/** Mirrors league_tiers.max_wager_cents. */
export const LEAGUE_MAX_WAGER_CENTS: Record<LeagueTier, number> = {
  bronze: 1000,
  silver: 2500,
  gold: 5000,
  platinum: 10000,
  diamond: 25000,
};

/**
 * Mirrors league_tiers.color_hex. Metal up to Gold, then the two colours
 * that read as "past metal": Platinum's cyan and Diamond's icy white-blue.
 * None of them is the app's lime, deliberately -- the accent belongs to
 * actions and to winning, and a league is a state.
 */
export const LEAGUE_COLOR: Record<LeagueTier, string> = {
  bronze: '#CD7F32',
  silver: '#C0C0C0',
  gold: '#FFD700',
  platinum: '#00CFCF',
  diamond: '#B9F2FF',
};

/** Mirrors the _trophy_* tunables. See the migration for the reasoning. */
export const TROPHY_WIN_BASE = 12;
export const TROPHY_LOSS_PENALTY = 6;
export const TROPHY_TIE_AWARD = 6;
export const TROPHY_STREAK_BONUS_CAP = 5;

/** Mirrors _trophy_win_award(): what a win worth `streakAfter` straight pays. */
export function trophyWinAward(streakAfter: number): number {
  const run = Math.max(Math.round(streakAfter) - 1, 0);
  return TROPHY_WIN_BASE + Math.min(run, TROPHY_STREAK_BONUS_CAP);
}

/** Mirrors league_for(). The league a trophy count sits in. */
export function leagueOf(trophies: number): LeagueTier {
  const count = Math.max(trophies, 0);
  for (let i = LEAGUES.length - 1; i >= 0; i -= 1) {
    const tier = LEAGUES[i]!;
    if (count >= LEAGUE_MIN_TROPHIES[tier]) {
      return tier;
    }
  }
  return 'bronze';
}

/** The league above this one, or null at the top. */
export function nextLeague(tier: LeagueTier): LeagueTier | null {
  return LEAGUES[LEAGUES.indexOf(tier) + 1] ?? null;
}

/** 0 for Bronze, 4 for Diamond. How far up the ladder a league is. */
export function leagueIndex(tier: LeagueTier): number {
  return Math.max(LEAGUES.indexOf(tier), 0);
}

export type LeagueStanding = 'completed' | 'current' | 'locked';

/** Where one league sits relative to the one a fighter is in. */
export function standingOf(tier: LeagueTier, current: LeagueTier): LeagueStanding {
  const a = leagueIndex(tier);
  const b = leagueIndex(current);
  if (a < b) {
    return 'completed';
  }
  return a === b ? 'current' : 'locked';
}

export interface LeagueProgress {
  /** The league being climbed towards, or null at Diamond. */
  next: LeagueTier | null;
  /** Trophies still to earn. 0 at the top. */
  remaining: number;
  /** 0..1 across the current league's span. 1 at the top. */
  fraction: number;
  /** The next league's threshold, or the current floor at the top. */
  target: number;
}

/**
 * How far through the current league a trophy count is, and what is left.
 *
 * The fraction is measured across the span between the CURRENT league's
 * floor and the next one's, not from zero, so every league's bar fills at
 * its own pace and a fighter who has just been promoted starts near empty
 * rather than near full.
 */
export function leagueProgress(
  trophies: number,
  thresholds: Record<LeagueTier, number> = LEAGUE_MIN_TROPHIES,
): LeagueProgress {
  const count = Math.max(trophies, 0);
  const tier = leagueOfWith(count, thresholds);
  const next = nextLeague(tier);
  if (!next) {
    return { next: null, remaining: 0, fraction: 1, target: thresholds[tier] };
  }
  const floor = thresholds[tier];
  const target = thresholds[next];
  const span = Math.max(target - floor, 1);
  return {
    next,
    remaining: Math.max(target - count, 0),
    fraction: clamp01((count - floor) / span),
    target,
  };
}

/** leagueOf() against a threshold table that may have come from the server. */
export function leagueOfWith(
  trophies: number,
  thresholds: Record<LeagueTier, number>,
): LeagueTier {
  const count = Math.max(trophies, 0);
  for (let i = LEAGUES.length - 1; i >= 0; i -= 1) {
    const tier = LEAGUES[i]!;
    if (count >= thresholds[tier]) {
      return tier;
    }
  }
  return 'bronze';
}

/** The league_tiers rows as a threshold table, for leagueProgress(). */
export function thresholdsFrom(
  rows: readonly LeagueTierRow[],
): Record<LeagueTier, number> {
  const table = { ...LEAGUE_MIN_TROPHIES };
  for (const row of rows) {
    table[row.name] = row.min_trophies;
  }
  return table;
}

/**
 * Win rate as a percentage, or null before the first settled bout.
 *
 * Ties are in the denominator and not in the numerator, matching
 * deriveBoutStats() exactly. A shared first place is not a win, and
 * pretending the bout never happened would make a fighter who ties often
 * look better than one who wins the same number outright.
 */
export function winRate(
  wins: number,
  losses: number,
  ties: number,
): number | null {
  const played = wins + losses + ties;
  if (played <= 0) {
    return null;
  }
  return Math.round((wins / played) * 100);
}

/** 1000 -> "$10". Whole dollars: every tier ceiling is one. */
export function fmtWager(cents: number): string {
  const dollars = cents / 100;
  const whole = Math.round(dollars);
  return Math.abs(dollars - whole) < 0.005
    ? `$${whole}`
    : `$${dollars.toFixed(2)}`;
}

/** "1" -> "1ST", for the podium places. */
export function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) {
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

/**
 * Podium colours for the top three. Deliberately the same three metals the
 * bottom three leagues use: a leaderboard place and a league are different
 * things, but "gold, silver, bronze for first, second, third" is older than
 * either and reads instantly.
 */
export function placeColor(rank: number): string | null {
  if (rank === 1) {
    return LEAGUE_COLOR.gold;
  }
  if (rank === 2) {
    return LEAGUE_COLOR.silver;
  }
  if (rank === 3) {
    return LEAGUE_COLOR.bronze;
  }
  return null;
}

export interface RankEventCopy {
  /** The line the timeline row leads with. */
  title: string;
  /** "+14" / "−6", or null when the balance did not move. */
  delta: string | null;
  /** Which way the arrow points. */
  direction: 'up' | 'down' | 'flat';
  /** A league move is drawn in that league's colour. */
  tier: LeagueTier | null;
}

/**
 * What one history row says, given a name for the opponent. The caller
 * resolves the handle (it needs the session to know whether the opponent is
 * the signed-in user), so this stays pure.
 */
export function rankEventCopy(
  event: Pick<
    RankHistoryRow,
    'event_type' | 'trophy_delta' | 'trophy_balance' | 'opponent_id'
  >,
  opponentHandle: string | null,
): RankEventCopy {
  const amount = Math.abs(event.trophy_delta);
  const versus = opponentHandle ? ` vs ${opponentHandle}` : '';

  switch (event.event_type) {
    case 'promotion': {
      const tier = leagueOf(event.trophy_balance);
      return {
        title: `Promoted to ${LEAGUE_LABEL[tier]}`,
        delta: null,
        direction: 'up',
        tier,
      };
    }
    case 'demotion': {
      const tier = leagueOf(event.trophy_balance);
      return {
        title: `Dropped to ${LEAGUE_LABEL[tier]}`,
        delta: null,
        direction: 'down',
        tier,
      };
    }
    case 'win':
      return {
        title: `Won ${amount} ${plural(amount)}${versus}`,
        delta: `+${amount}`,
        direction: 'up',
        tier: null,
      };
    case 'tie':
      return {
        title: `Shared the win${versus}`,
        delta: `+${amount}`,
        direction: 'up',
        tier: null,
      };
    case 'loss':
      // A loss at zero trophies costs nothing, and saying "Lost 0 trophies"
      // would be a worse description of that than saying what happened.
      return amount === 0
        ? {
            title: `Held at 0${versus}`,
            delta: null,
            direction: 'flat',
            tier: null,
          }
        : {
            title: `Lost ${amount} ${plural(amount)}${versus}`,
            delta: `−${amount}`,
            direction: 'down',
            tier: null,
          };
  }
}

function plural(n: number): string {
  return n === 1 ? 'trophy' : 'trophies';
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Whether a history row is a league move rather than a bout result. */
export function isLeagueMove(type: RankEventType): boolean {
  return type === 'promotion' || type === 'demotion';
}
