import type {
  ChallengeType,
  MySkillRatingRow,
  RankTier,
  SkillRatingEventRow,
} from '../types/database';

/**
 * The client half of per-exercise MMR. Pure functions only, so the display
 * rules are unit-testable without a database (__tests__/skillRating.test.ts).
 *
 * The constants mirror the tunables declared at the top of the
 * 20260909000000_skill_ratings migration. If one side changes, change the
 * other -- same arrangement as HEARTBEAT_MS and friends in matchmaking.ts.
 *
 * The tier a fighter IS never comes from here: `rank_tier` arrives already
 * derived on the `my_skill_ratings` view, so rank_tier_for() in SQL stays
 * the single source of truth for where the bands fall. RANK_BANDS below is
 * used only to say how far the NEXT band is, and is asserted against the
 * database in the db test.
 */

/** Where a rating starts, in every exercise. */
export const MMR_SEED = 1000;

/** Rated bouts in one exercise before that exercise's rating is placed. */
export const PLACEMENT_BOUTS = 5;

/** K while placing, and K after. */
export const K_PLACEMENT = 100;
export const K_SETTLED = 32;

/** Ascending. The order tiers are shown in, and their relative strength. */
export const RANK_TIERS: readonly RankTier[] = [
  'commoner',
  'squire',
  'knight',
  'hero',
  'sovereign',
  'ultimate_champion',
];

/**
 * The lower bound of each band, mirroring rank_tier_for(). Commoner has no
 * floor and Ultimate Champion no ceiling; the six bands are 200 wide from
 * 900 to 1900.
 */
export const RANK_BANDS: Readonly<Record<RankTier, number>> = {
  commoner: 0,
  squire: 900,
  knight: 1100,
  hero: 1300,
  sovereign: 1500,
  ultimate_champion: 1700,
};

/** How wide every closed band is. */
export const BAND_WIDTH = 200;

/**
 * The rating one bout of `type` is judged on, or null before a fighter has
 * ever queued it. The Profile screen shows a row per exercise either way,
 * so "no rating yet" and "unplaced" are different states.
 */
export function ratingFor(
  ratings: readonly MySkillRatingRow[],
  type: ChallengeType,
): MySkillRatingRow | null {
  return ratings.find(r => r.exercise_type === type) ?? null;
}

/**
 * What to show for a tier. During placement the tier itself is withheld --
 * it is derived from a seed that has not been tested yet, and showing
 * "Squire" to someone who has fought once would be asserting something the
 * five placement bouts exist to find out.
 */
export function tierLabelFor(rating: MySkillRatingRow | null): string {
  if (!rating || !rating.placement_complete) {
    return 'Unranked';
  }
  return RANK_TIER_LABEL[rating.rank_tier];
}

/**
 * The line under the tier: "3 of 5 placement bouts" while placing, the MMR
 * once placed, and an invitation before the first bout.
 */
export function tierDetailFor(rating: MySkillRatingRow | null): string {
  if (!rating) {
    return 'No bouts yet';
  }
  if (!rating.placement_complete) {
    const total = rating.placement_bouts;
    return `${rating.matches_played} of ${total} placement bouts`;
  }
  return `${rating.mmr} MMR`;
}

/** 0..1 through the current band, for a progress bar. */
export function bandProgress(rating: MySkillRatingRow | null): number {
  if (!rating || !rating.placement_complete) {
    return 0;
  }
  const floor = RANK_BANDS[rating.rank_tier];
  if (rating.rank_tier === 'ultimate_champion') {
    return 1;
  }
  if (rating.rank_tier === 'commoner') {
    // Open-ended below: show how close they are to climbing out of it.
    return clamp01((rating.mmr - (RANK_BANDS.squire - BAND_WIDTH)) / BAND_WIDTH);
  }
  return clamp01((rating.mmr - floor) / BAND_WIDTH);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Whether the Results screen may show a number for this bout.
 *
 * Placement bouts are deliberately silent. At K=100 a single placement win
 * moves a rating by up to 100 points -- a swing that means far less than it
 * looks like it does, because the rating it moved was a seed rather than a
 * measurement. Showing "+100" and then "-100" across two bouts would read
 * as wild instability rather than as the system finding its level, so the
 * screen shows placement progress instead until the rating is placed.
 */
export function showsDelta(event: SkillRatingEventRow | null): boolean {
  return event !== null && !event.was_placement;
}

/** "+18" / "−24" / "0". A true minus sign, matching fmtSigned. */
export function fmtMmrDelta(delta: number): string {
  if (delta > 0) {
    return `+${delta}`;
  }
  if (delta < 0) {
    return `−${Math.abs(delta)}`;
  }
  return '0';
}

/**
 * The Results screen's rating line. Returns null when there is nothing
 * honest to say -- an unsettled bout, or one that predates ratings.
 */
export interface RatingResult {
  /** "+18", or null during placement. */
  delta: string | null;
  /** The caption under it. Always present when the event is. */
  caption: string;
}

export function ratingResultFor(
  event: SkillRatingEventRow | null,
): RatingResult | null {
  if (!event) {
    return null;
  }
  if (!event.was_placement) {
    return {
      delta: fmtMmrDelta(event.delta),
      caption: `${RANK_TIER_LABEL[rankTierOf(event.mmr_after)].toUpperCase()} · ${event.mmr_after} MMR`,
    };
  }
  // The bout that finishes placement is still a placement bout, but it is
  // worth telling someone their rank has landed.
  if (event.matches_played >= PLACEMENT_BOUTS) {
    return {
      delta: null,
      caption: `PLACED · ${RANK_TIER_LABEL[rankTierOf(event.mmr_after)].toUpperCase()}`,
    };
  }
  const left = PLACEMENT_BOUTS - event.matches_played;
  return {
    delta: null,
    caption: `PLACEMENT · ${event.matches_played} OF ${PLACEMENT_BOUTS} · ${left} TO GO`,
  };
}

/**
 * The band a rating falls in. Mirrors rank_tier_for(); used only where the
 * server has not already sent `rank_tier` alongside the number (i.e. a
 * skill_rating_events row, which carries the MMR but not the tier).
 */
export function rankTierOf(mmr: number): RankTier {
  for (let i = RANK_TIERS.length - 1; i >= 0; i -= 1) {
    const tier = RANK_TIERS[i]!;
    if (mmr >= RANK_BANDS[tier]) {
      return tier;
    }
  }
  return 'commoner';
}

/** Display names, in ascending order. Copy only. */
export const RANK_TIER_LABEL: Record<RankTier, string> = {
  commoner: 'Commoner',
  squire: 'Squire',
  knight: 'Knight',
  hero: 'Hero',
  sovereign: 'Sovereign',
  ultimate_champion: 'Ultimate Champion',
};

/** Short forms for places a two-word tier will not fit. */
export const RANK_TIER_SHORT: Record<RankTier, string> = {
  commoner: 'Commoner',
  squire: 'Squire',
  knight: 'Knight',
  hero: 'Hero',
  sovereign: 'Sovereign',
  ultimate_champion: 'Champion',
};

/**
 * Climbing from base metal to the accent the app uses for a win. Distinct
 * enough to tell apart at pill size, and unrelated to TIER_COLOR, which
 * still belongs to the self-reported Bronze/Silver/Gold.
 */
export const RANK_TIER_COLOR: Record<RankTier, string> = {
  commoner: '#8A8F98',
  squire: '#C48A5A',
  knight: '#B8BCC6',
  hero: '#E3B341',
  sovereign: '#7BD3EA',
  ultimate_champion: '#C6F24E',
};

/** Shown while a rating is still placing, and for an exercise never fought. */
export const UNRANKED_COLOR = '#6B7079';

export function rankTierColorFor(rating: MySkillRatingRow | null): string {
  if (!rating || !rating.placement_complete) {
    return UNRANKED_COLOR;
  }
  return RANK_TIER_COLOR[rating.rank_tier];
}
