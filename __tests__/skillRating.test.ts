/**
 * The display half of skill ratings: what a fighter is told about their
 * rank, and when a bout is allowed to show a number. No database — the
 * arithmetic those numbers come from is tested in skillRating.db.test.ts.
 */
import {
  BAND_WIDTH,
  PLACEMENT_BOUTS,
  RANK_BANDS,
  RANK_TIERS,
  RANK_TIER_LABEL,
  bandProgress,
  fmtMmrDelta,
  rankTierColorFor,
  rankTierOf,
  ratingFor,
  ratingResultFor,
  showsDelta,
  tierDetailFor,
  tierLabelFor,
} from '../src/lib/skillRating';
import type {
  ChallengeType,
  MySkillRatingRow,
  SkillRatingEventRow,
} from '../src/types/database';

function rating(over: Partial<MySkillRatingRow> = {}): MySkillRatingRow {
  return {
    user_id: 'me',
    exercise_type: 'pushups',
    mmr: 1000,
    matches_played: 0,
    placement_complete: false,
    rank_tier: 'squire',
    placement_bouts: PLACEMENT_BOUTS,
    updated_at: new Date().toISOString(),
    ...over,
  };
}

function event(over: Partial<SkillRatingEventRow> = {}): SkillRatingEventRow {
  return {
    id: 'e1',
    user_id: 'me',
    match_id: 'm1',
    exercise_type: 'pushups',
    mmr_before: 1200,
    mmr_after: 1218,
    delta: 18,
    k_factor: 32,
    was_placement: false,
    matches_played: 9,
    participants: 2,
    norms_seeded: false,
    created_at: new Date().toISOString(),
    ...over,
  };
}

describe('the tier ladder', () => {
  it('names six tiers in ascending order', () => {
    expect(RANK_TIERS.map(t => RANK_TIER_LABEL[t])).toEqual([
      'Commoner',
      'Squire',
      'Knight',
      'Hero',
      'Sovereign',
      'Ultimate Champion',
    ]);
  });

  it('bands them evenly, 200 apart, from 900', () => {
    const closed = RANK_TIERS.slice(1); // Commoner is open-ended below
    const floors = closed.map(t => RANK_BANDS[t]);
    expect(floors).toEqual([900, 1100, 1300, 1500, 1700]);
    for (let i = 1; i < floors.length; i += 1) {
      expect(floors[i]! - floors[i - 1]!).toBe(BAND_WIDTH);
    }
  });

  it('mirrors rank_tier_for() at every boundary', () => {
    // The same probes the SQL function is checked against, so the two
    // definitions cannot drift apart silently.
    expect(rankTierOf(0)).toBe('commoner');
    expect(rankTierOf(899)).toBe('commoner');
    expect(rankTierOf(900)).toBe('squire');
    expect(rankTierOf(1099)).toBe('squire');
    expect(rankTierOf(1100)).toBe('knight');
    expect(rankTierOf(1299)).toBe('knight');
    expect(rankTierOf(1300)).toBe('hero');
    expect(rankTierOf(1499)).toBe('hero');
    expect(rankTierOf(1500)).toBe('sovereign');
    expect(rankTierOf(1699)).toBe('sovereign');
    expect(rankTierOf(1700)).toBe('ultimate_champion');
    expect(rankTierOf(9000)).toBe('ultimate_champion');
  });
});

describe('what the Profile screen shows', () => {
  it('says Unranked for an exercise never fought, and says why', () => {
    expect(tierLabelFor(null)).toBe('Unranked');
    expect(tierDetailFor(null)).toBe('No bouts yet');
  });

  it('says Unranked with the placement count while placing', () => {
    const r = rating({ matches_played: 3, placement_complete: false, rank_tier: 'knight' });
    expect(tierLabelFor(r)).toBe('Unranked');
    expect(tierDetailFor(r)).toBe('3 of 5 placement bouts');
  });

  it('withholds the tier during placement even though the row carries one', () => {
    // The row always has a rank_tier -- it is derived from the seed. Showing
    // it before placement would assert something the placement bouts exist
    // to find out.
    const r = rating({ matches_played: 4, placement_complete: false, rank_tier: 'sovereign' });
    expect(tierLabelFor(r)).toBe('Unranked');
    expect(tierLabelFor(r)).not.toContain('Sovereign');
  });

  it('names the tier and the rating once placed', () => {
    const r = rating({ mmr: 1350, matches_played: 11, placement_complete: true, rank_tier: 'hero' });
    expect(tierLabelFor(r)).toBe('Hero');
    expect(tierDetailFor(r)).toBe('1350 MMR');
  });

  it('greys out anything not yet placed, and colours what is', () => {
    const unplaced = rankTierColorFor(rating({ placement_complete: false }));
    expect(rankTierColorFor(null)).toBe(unplaced);
    expect(rankTierColorFor(rating({ placement_complete: true, rank_tier: 'hero' })))
      .not.toBe(unplaced);
  });

  it('shows progress through the band only once placed', () => {
    expect(bandProgress(null)).toBe(0);
    expect(bandProgress(rating({ mmr: 1250, placement_complete: false }))).toBe(0);
    // 1200 is the middle of Knight (1100..1299).
    expect(bandProgress(rating({ mmr: 1200, placement_complete: true, rank_tier: 'knight' })))
      .toBeCloseTo(0.5);
    expect(bandProgress(rating({ mmr: 1100, placement_complete: true, rank_tier: 'knight' })))
      .toBe(0);
  });

  it('pins the open-ended top band full and never leaves the bar out of range', () => {
    expect(bandProgress(rating({ mmr: 2400, placement_complete: true, rank_tier: 'ultimate_champion' })))
      .toBe(1);
    const low = bandProgress(rating({ mmr: 300, placement_complete: true, rank_tier: 'commoner' }));
    expect(low).toBeGreaterThanOrEqual(0);
    expect(low).toBeLessThanOrEqual(1);
  });

  it('picks the rating for the exercise asked for, not the first one', () => {
    const rows = [
      rating({ exercise_type: 'pushups', mmr: 1100 }),
      rating({ exercise_type: 'plank', mmr: 1500 }),
    ];
    expect(ratingFor(rows, 'plank')!.mmr).toBe(1500);
    expect(ratingFor(rows, 'pushups')!.mmr).toBe(1100);
    // An exercise with no rating is null, not a defaulted 1000.
    expect(ratingFor(rows, 'wallsit' as ChallengeType)).toBeNull();
  });
});

describe('what the Results screen shows', () => {
  it('shows nothing at all for a bout that was never rated', () => {
    expect(ratingResultFor(null)).toBeNull();
    expect(showsDelta(null)).toBe(false);
  });

  it('shows the signed change once placed', () => {
    expect(showsDelta(event())).toBe(true);
    expect(ratingResultFor(event())).toEqual({
      delta: '+18',
      caption: 'KNIGHT · 1218 MMR',
    });
    expect(ratingResultFor(event({ delta: -24, mmr_before: 1218, mmr_after: 1194 }))).toEqual({
      delta: '−24',
      caption: 'KNIGHT · 1194 MMR',
    });
  });

  it('shows no number during placement, however big the swing', () => {
    const placing = event({
      was_placement: true, k_factor: 100, matches_played: 2,
      mmr_before: 1000, mmr_after: 1100, delta: 100,
    });
    expect(showsDelta(placing)).toBe(false);
    const result = ratingResultFor(placing)!;
    expect(result.delta).toBeNull();
    expect(result.caption).toBe('PLACEMENT · 2 OF 5 · 3 TO GO');
    expect(result.caption).not.toContain('100');
  });

  it('announces the tier on the bout that completes placement', () => {
    // Still a placement bout (K was 100, so still no number), but the rank
    // has landed and is worth saying.
    const last = event({
      was_placement: true, k_factor: 100, matches_played: 5,
      mmr_before: 1250, mmr_after: 1310, delta: 60,
    });
    expect(ratingResultFor(last)).toEqual({ delta: null, caption: 'PLACED · HERO' });
  });

  it('formats a delta with a true minus sign, matching the points display', () => {
    expect(fmtMmrDelta(18)).toBe('+18');
    expect(fmtMmrDelta(-24)).toBe('−24');
    expect(fmtMmrDelta(-24)).not.toBe('-24');
    expect(fmtMmrDelta(0)).toBe('0');
  });
});
