/**
 * The score arithmetic and the Blitz curve, with no database: that the
 * client mirrors the SQL's rounding, that the form-quality meter counts only
 * the valid portion of a set, and that the curve is break-even at the
 * threshold and capped at the benchmark. The same constants are asserted
 * against the SQL functions in score.db.test.ts.
 */
import {
  BLITZ_BREAKEVEN_BP,
  BLITZ_MAX_BP,
  FormQualityMeter,
  REFERENCE_QUALITY_BP,
  blitzMultiplierBp,
  blitzScoreForMultiplier,
  fmtQuality,
  fmtScore,
  formPctOf,
  rawAtReference,
  scoreAtReference,
  scoreFor,
} from '../src/lib/score';

describe('scoreFor', () => {
  it('is raw times form quality in percent, rounded once', () => {
    expect(scoreFor(30, 8500)).toBe(2550);
    expect(scoreFor(30, 10000)).toBe(3000);
    // 30 * 8537 / 100 = 2561.1 -> 2561, not 2561 via two truncations.
    expect(scoreFor(30, 8537)).toBe(2561);
    // 7 * 8550 / 100 = 598.5 -> 599 (round half away from zero).
    expect(scoreFor(7, 8550)).toBe(599);
  });

  it('is zero for an empty set or zero form', () => {
    expect(scoreFor(0, 9000)).toBe(0);
    expect(scoreFor(12, 0)).toBe(0);
  });

  it('cleaner form beats more reps when the product says so', () => {
    expect(scoreFor(26, 10000)).toBeGreaterThan(scoreFor(30, 8500));
  });
});

describe('scoreAtReference / rawAtReference', () => {
  it('converts a raw target at the reference quality and back, rounding up', () => {
    expect(REFERENCE_QUALITY_BP).toBe(8500);
    expect(scoreAtReference(30)).toBe(2550);
    expect(rawAtReference(2550)).toBe(30);
    // 2551 needs a 31st rep at 85%.
    expect(rawAtReference(2551)).toBe(31);
  });

  it('is strictly increasing in the raw count, so a nudged ladder stays ascending', () => {
    for (let raw = 1; raw < 200; raw += 1) {
      expect(scoreAtReference(raw + 1)).toBeGreaterThan(scoreAtReference(raw));
    }
  });
});

describe('formPctOf', () => {
  it('recovers the form percentage from a recorded pair', () => {
    expect(formPctOf(30, 2550)).toBe(85);
    expect(formPctOf(0, 0)).toBeNull();
    expect(formPctOf(null, 100)).toBeNull();
  });
});

describe('display', () => {
  it('formats scores like points and quality as a percentage', () => {
    expect(fmtScore(2550)).toBe('2,550');
    expect(fmtScore(null)).toBe('—');
    expect(fmtQuality(8537)).toBe('85%');
    expect(fmtQuality(null)).toBe('—');
  });
});

describe('the Blitz curve', () => {
  const T = 2550;
  const B = 3825;

  it('pays nothing under the threshold and exactly break-even on it', () => {
    expect(blitzMultiplierBp(T - 1, T, B)).toBe(0);
    expect(blitzMultiplierBp(0, T, B)).toBe(0);
    expect(blitzMultiplierBp(T, T, B)).toBe(BLITZ_BREAKEVEN_BP);
  });

  it('is linear between the two bars and truncates, never rounds up', () => {
    // Half-way: 10000 + 15000 * 0.5 = 17500.
    expect(blitzMultiplierBp(T + (B - T) / 2, T, B)).toBe(17500);
    // One point above the threshold: 15000 * 1 / 1275 = 11.76 -> 11.
    expect(blitzMultiplierBp(T + 1, T, B)).toBe(10011);
  });

  it('caps at the benchmark and stays capped past it', () => {
    expect(blitzMultiplierBp(B, T, B)).toBe(BLITZ_MAX_BP);
    expect(blitzMultiplierBp(B + 5000, T, B)).toBe(BLITZ_MAX_BP);
  });

  it('degrades to the cap when the benchmark is not above the threshold', () => {
    expect(blitzMultiplierBp(T, T, T)).toBe(BLITZ_MAX_BP);
  });

  it('inverts for the graph labels: the lowest score that reaches a multiplier', () => {
    const twoX = blitzScoreForMultiplier(20000, T, B);
    expect(blitzMultiplierBp(twoX, T, B)).toBeGreaterThanOrEqual(20000);
    expect(blitzMultiplierBp(twoX - 1, T, B)).toBeLessThan(20000);
    expect(blitzScoreForMultiplier(BLITZ_BREAKEVEN_BP, T, B)).toBe(T);
    expect(blitzScoreForMultiplier(BLITZ_MAX_BP, T, B)).toBe(B);
  });
});

describe('FormQualityMeter', () => {
  it('reps: banks the peak of each counted rep and ignores the one in progress', () => {
    const m = new FormQualityMeter('reps');
    // Rep 1 peaks at 0.9.
    [0.1, 0.5, 0.9, 0.7, 0.2].forEach(p => m.observe(p));
    m.completeRep();
    // Rep 2 peaks at 0.7.
    [0.3, 0.7, 0.6, 0.1].forEach(p => m.observe(p));
    m.completeRep();
    // A third rep started but never completed: not in the average.
    [0.4, 1.0].forEach(p => m.observe(p));
    const snap = m.snapshot();
    expect(snap.samples).toBe(2);
    expect(snap.qualityBp).toBe(8000);
    expect(m.repPeakList()).toEqual([0.9, 0.7]);
  });

  it('reps: is zero with no completed rep, however high the probability got', () => {
    const m = new FormQualityMeter('reps');
    m.observe(0.99);
    expect(m.snapshot()).toEqual({ qualityBp: 0, samples: 0 });
  });

  it('hold: averages only the frames the tracker says are in position', () => {
    const m = new FormQualityMeter('hold');
    m.observe(0.9, true);
    m.observe(0.7, true);
    m.observe(0.05, false); // dropped out: not the valid portion
    m.observe(0.8, true);
    const snap = m.snapshot();
    expect(snap.samples).toBe(3);
    expect(snap.qualityBp).toBe(8000);
  });

  it('clamps stray probabilities into 0..1 and resets cleanly', () => {
    const m = new FormQualityMeter('hold');
    m.observe(1.4, true);
    m.observe(-0.2, true);
    expect(m.snapshot().qualityBp).toBe(5000);
    m.reset();
    expect(m.snapshot()).toEqual({ qualityBp: 0, samples: 0 });
  });
});
