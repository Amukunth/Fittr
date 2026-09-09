/**
 * Real-world percentile MMR seeding against a real Postgres: the reference
 * data's integrity, the shared percentile -> MMR curve, the interpolator,
 * the norms-based seed on a fighter's first rated bout only, the
 * population-median fallback when age/gender is missing, the standalone
 * race age-grading pipeline, and update_my_profile()'s two new fields.
 *
 * Ongoing Elo after placement is NOT retested here -- this migration
 * changes nothing about it, and __tests__/skillRating.db.test.ts already
 * covers it in full. These tests isolate exactly what changed: what a
 * fighter's MMR is on the way INTO their first rated bout.
 */
import {
  createUser,
  rpcAsUser,
  rpcRow,
  ratingOf,
  startTestDb,
  type TestDb,
} from '../test/dbHarness';
import type { MatchmakingQueueRow } from '../src/types/database';

let db: TestDb;

beforeAll(async () => {
  db = await startTestDb();
}, 120000);

afterAll(async () => {
  await db.stop();
});

afterEach(async () => {
  await db.pool.query('DELETE FROM matchmaking_queue');
  await db.pool.query(
    "DELETE FROM challenges c WHERE c.status = 'open' AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.challenge_id = c.id)",
  );
});

// ── helpers ─────────────────────────────────────────────────────────────

type Exercise = 'pushups' | 'plank' | 'wallsit';
type Gender = 'male' | 'female';
type AgeBand = 'under_20' | '20s' | '30s' | '40s' | '50s' | '60s' | '70_plus';

async function setDemographics(userId: string, gender: Gender | null, ageBand: AgeBand | null) {
  await db.pool.query(
    'UPDATE fitness_profiles SET gender = $2, age_band = $3 WHERE user_id = $1',
    [userId, gender, ageBand],
  );
}

async function createUserWith(
  gender: Gender | null, ageBand: AgeBand | null, points = 500,
): Promise<string> {
  const id = await createUser(db, { points });
  await setDemographics(id, gender, ageBand);
  return id;
}

function enter(
  user: string,
  r: { exercise?: Exercise; format?: '1v1' | 'pooled'; stake?: number; seats?: number } = {},
) {
  const format = r.format ?? '1v1';
  return rpcRow<MatchmakingQueueRow>(
    db, user, 'SELECT * FROM enter_matchmaking($1, $2, $3, $4)',
    [r.exercise ?? 'pushups', format, r.stake ?? 100, r.seats ?? (format === '1v1' ? 2 : 4)],
  );
}

async function submit(user: string, matchId: string, opts: { reps?: number; hold?: number }) {
  const { rows } = await db.pool.query<{ id: string }>(
    'SELECT id FROM match_participants WHERE match_id = $1 AND user_id = $2',
    [matchId, user],
  );
  return rpcAsUser<string>(
    db, user, 'SELECT submit_verification_session($1, $2, $3::jsonb, $4, $5)',
    [rows[0]!.id, opts.reps ?? null, JSON.stringify({ test: true }), false, opts.hold ?? null],
  );
}

async function eventFor(user: string, matchId: string) {
  const { rows } = await db.pool.query<{
    mmr_before: number; mmr_after: number; delta: number; norms_seeded: boolean;
    was_placement: boolean; matches_played: number;
  }>(
    'SELECT mmr_before, mmr_after, delta, norms_seeded, was_placement, matches_played FROM skill_rating_events WHERE user_id = $1 AND match_id = $2',
    [user, matchId],
  );
  return rows[0] ?? null;
}

/** Two fresh users matched through the real queue, one at each demographic. */
async function duel(
  a: { gender: Gender | null; ageBand: AgeBand | null },
  b: { gender: Gender | null; ageBand: AgeBand | null },
  exercise: Exercise = 'pushups',
): Promise<{ a: string; b: string; matchId: string }> {
  const ua = await createUserWith(a.gender, a.ageBand);
  const ub = await createUserWith(b.gender, b.ageBand);
  await enter(ua, { exercise });
  const row = await enter(ub, { exercise });
  expect(row.status).toBe('matched');
  return { a: ua, b: ub, matchId: row.match_id! };
}

async function mmrFromPercentile(p: number): Promise<number> {
  const { rows } = await db.pool.query<{ v: number }>('SELECT _mmr_from_percentile($1) v', [p]);
  return rows[0]!.v;
}

async function seedFromNorms(
  exercise: Exercise, gender: Gender, ageBand: AgeBand, raw: number,
): Promise<number | null> {
  const { rows } = await db.pool.query<{ v: number | null }>(
    'SELECT _mmr_seed_from_norms($1, $2, $3, $4) v', [exercise, gender, ageBand, raw],
  );
  return rows[0]!.v;
}

// ── reference data integrity ────────────────────────────────────────────

describe('performance_norms data integrity', () => {
  it('seeds exactly the expected coverage: 3 exercises x 2 genders x 7 age bands', async () => {
    const { rows } = await db.pool.query<{ n: number }>(
      "SELECT count(DISTINCT (exercise_type, gender, age_band))::int n FROM performance_norms",
    );
    expect(rows[0]!.n).toBe(3 * 2 * 7);
  });

  it('never repeats an anchor raw_value within one (exercise, gender, age_band) group', async () => {
    // Strict monotonicity is what keeps _perf_percentile_from_anchors()'s
    // interpolation well-defined -- a collision would silently degrade to
    // a flat percentile via the NULLIF guard rather than erroring, so this
    // has to be checked as data, not left to surface as a wrong answer.
    const { rows } = await db.pool.query<{
      exercise_type: string; gender: string; age_band: string; vals: number[];
    }>(
      `SELECT exercise_type, gender, age_band, array_agg(raw_value ORDER BY percentile) vals
         FROM performance_norms GROUP BY 1, 2, 3`,
    );
    expect(rows.length).toBe(42);
    for (const r of rows) {
      for (let i = 1; i < r.vals.length; i += 1) {
        expect(Number(r.vals[i])).toBeGreaterThan(Number(r.vals[i - 1]));
      }
    }
  });

  it('keeps every percentile strictly between 0 and 100', async () => {
    const { rows } = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int n FROM performance_norms WHERE percentile <= 0 OR percentile >= 100',
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('reproduces the sourced plank baseline (18-25 / under_20+20s) verbatim', async () => {
    // The one exercise with real published percentiles (not an assumed
    // even-split). under_20 gets the baseline unmodified (no decline
    // applies below the sourced range).
    const { rows } = await db.pool.query<{ percentile: number; raw_value: number }>(
      `SELECT percentile, raw_value FROM performance_norms
        WHERE exercise_type = 'plank' AND gender = 'male' AND age_band = 'under_20'
        ORDER BY percentile`,
    );
    expect(rows.map(r => [Number(r.percentile), Number(r.raw_value)])).toEqual([
      [25, 84], [50, 110], [75, 135],
    ]);
  });

  it('applies no age decline to wall-sit -- every age band is identical', async () => {
    const { rows } = await db.pool.query<{ age_band: string; vals: number[] }>(
      `SELECT age_band, array_agg(raw_value ORDER BY percentile) vals
         FROM performance_norms WHERE exercise_type = 'wallsit' AND gender = 'male'
        GROUP BY age_band`,
    );
    const distinct = new Set(rows.map(r => JSON.stringify(r.vals.map(Number))));
    expect(distinct.size).toBe(1);
    expect(rows).toHaveLength(7);
  });

  it('declines push-up boundaries across age bands, floored at 1 rep', async () => {
    const { rows } = await db.pool.query<{ age_band: string; vals: number[] }>(
      `SELECT age_band, array_agg(raw_value ORDER BY percentile) vals
         FROM performance_norms WHERE exercise_type = 'pushups' AND gender = 'male'
        GROUP BY age_band`,
    );
    const byBand = new Map(rows.map(r => [r.age_band, r.vals.map(Number)]));
    expect(byBand.get('20s')).toEqual([17, 30, 47]);
    expect(byBand.get('30s')).toEqual([13, 26, 43]);
    expect(byBand.get('70_plus')).toEqual([1, 10, 27]);
    // Never below the floor.
    for (const vals of byBand.values()) {
      for (const v of vals) {
        expect(v).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("reproduces the women's push-up five-band data as given, including the repeated 'above avg' label", async () => {
    const { rows } = await db.pool.query<{ raw_value: number }>(
      `SELECT raw_value FROM performance_norms
        WHERE exercise_type = 'pushups' AND gender = 'female' AND age_band = '20s'
        ORDER BY percentile`,
    );
    expect(rows.map(r => Number(r.raw_value))).toEqual([9, 14, 23, 32]);
  });

  it('every row carries a non-empty confidence and source, and pushups/plank/wallsit use the exact graded labels', async () => {
    const { rows } = await db.pool.query<{ exercise_type: string; confidence: string }>(
      'SELECT DISTINCT exercise_type, confidence FROM performance_norms ORDER BY 1',
    );
    const byExercise = Object.fromEntries(rows.map(r => [r.exercise_type, r.confidence]));
    expect(byExercise).toEqual({
      pushups: 'high',
      plank: 'high-narrow',
      wallsit: 'low',
    });
    const empty = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM performance_norms WHERE btrim(source) = '' OR btrim(confidence) = ''",
    );
    expect(empty.rows[0]!.n).toBe(0);
  });
});

describe('race_standards', () => {
  it('seeds only the mile, for both genders, confidence low and clearly flagged', async () => {
    const { rows } = await db.pool.query<{ distance: string; gender: string; confidence: string; source: string }>(
      'SELECT distance, gender, confidence, source FROM race_standards ORDER BY gender',
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.distance).toBe('mile');
      expect(r.confidence).toBe('low');
      expect(r.source.toUpperCase()).toContain('PLACEHOLDER');
    }
  });
});

// ── the shared percentile -> MMR curve ──────────────────────────────────

describe('_mmr_from_percentile', () => {
  it('puts the population median exactly on the existing seed', async () => {
    expect(await mmrFromPercentile(50)).toBe(1000);
  });

  it('is symmetric around 1000: equal distance above and below the median mirrors', async () => {
    const above = await mmrFromPercentile(75);
    const below = await mmrFromPercentile(25);
    expect(above - 1000).toBe(1000 - below);
  });

  it('reuses the same base-10 /400 logistic family as _mmr_expected()', async () => {
    // A fighter seeded at the MMR for percentile p, facing a population-
    // average (1000) opponent, should have an Elo expectation of
    // approximately p/100 -- because _mmr_from_percentile is that formula
    // inverted.
    for (const p of [10, 25, 50, 75, 90]) {
      const mmr = await mmrFromPercentile(p);
      const { rows } = await db.pool.query<{ e: number }>(
        'SELECT _mmr_expected($1, 1000) e', [mmr],
      );
      expect(Number(rows[0]!.e)).toBeCloseTo(p / 100, 1);
    }
  });

  it('climbs monotonically and stays within the sane clamp range used by every caller', async () => {
    const p1 = await mmrFromPercentile(1);
    const p99 = await mmrFromPercentile(99);
    expect(p1).toBeLessThan(1000);
    expect(p99).toBeGreaterThan(1000);
    expect(p1).toBeGreaterThan(0);
    expect(p99).toBeLessThan(2000);
  });
});

// ── the interpolator ─────────────────────────────────────────────────────

describe('_perf_percentile_from_anchors via _mmr_seed_from_norms', () => {
  it('returns the exact anchor percentile when the raw score matches an anchor', async () => {
    // Men's push-ups, 20s: anchors (17,25) (30,50) (47,75).
    const mmrAt30 = await seedFromNorms('pushups', 'male', '20s', 30);
    expect(mmrAt30).toBe(await mmrFromPercentile(50));
  });

  it('interpolates linearly between two anchors', async () => {
    // Halfway between 17 (P25) and 30 (P50) in raw terms is not exactly
    // P37.5 (the raw gap isn't symmetric), but the direction must be right
    // and the value must sit strictly between the two anchor MMRs.
    const low = (await seedFromNorms('pushups', 'male', '20s', 17))!;
    const mid = (await seedFromNorms('pushups', 'male', '20s', 23))!;
    const high = (await seedFromNorms('pushups', 'male', '20s', 30))!;
    expect(mid).toBeGreaterThan(low);
    expect(mid).toBeLessThan(high);
  });

  it("extrapolates below the lowest anchor using the first segment's slope, then clamps", async () => {
    // Far below the lowest anchor (17 reps -> P25): a below-anchor score
    // moves the percentile down, but never below the [1,99] floor the
    // interpolator enforces before this even reaches _mmr_from_percentile.
    const zero = (await seedFromNorms('pushups', 'male', '20s', 0))!;
    const atLowAnchor = (await seedFromNorms('pushups', 'male', '20s', 17))!;
    expect(zero).toBeLessThan(atLowAnchor);
    expect(zero).toBeGreaterThan((await mmrFromPercentile(1)) - 1);
  });

  it('extrapolates above the highest anchor, then clamps', async () => {
    const huge = (await seedFromNorms('pushups', 'male', '20s', 200))!;
    const atHighAnchor = (await seedFromNorms('pushups', 'male', '20s', 47))!;
    expect(huge).toBeGreaterThan(atHighAnchor);
    expect(huge).toBeLessThan((await mmrFromPercentile(99)) + 1);
  });

  it('is monotonic in raw score across the whole range for every exercise/gender/age_band', async () => {
    // A blunt but effective regression guard against a bad interpolation
    // branch: more reps must never produce a lower seed.
    let prev = -Infinity;
    for (let reps = 0; reps <= 60; reps += 2) {
      const mmr = (await seedFromNorms('pushups', 'female', '40s', reps))!;
      expect(mmr).toBeGreaterThanOrEqual(prev);
      prev = mmr;
    }
  });

  it('returns null for an exercise the norms table does not cover', async () => {
    const { rows } = await db.pool.query<{ v: number | null }>(
      "SELECT _mmr_seed_from_norms('race', 'male', '20s', 300) v",
    );
    expect(rows[0]!.v).toBeNull();
  });
});

// ── the integration point: first rated bout only ────────────────────────

describe('norms-based seeding inside settlement', () => {
  it("seeds a placed fighter's very first rated bout from norms, not the flat 1000", async () => {
    const { a, b, matchId } = await duel(
      { gender: 'male', ageBand: '20s' },
      { gender: 'female', ageBand: '20s' },
    );
    await submit(a, matchId, { reps: 30 }); // exactly the P50 anchor for men/20s
    await submit(b, matchId, { reps: 40 }); // above the P80 anchor for women/20s

    const evA = (await eventFor(a, matchId))!;
    const evB = (await eventFor(b, matchId))!;
    expect(evA.norms_seeded).toBe(true);
    expect(evB.norms_seeded).toBe(true);
    // mmr_before must be the norms seed, not 1000 -- K=100 placement means
    // a flat-1000 start would show up as a very different mmr_after.
    // A: exactly 30 reps is the men/20s P50 anchor -> seed == the median MMR.
    expect(evA.mmr_before).toBe(await mmrFromPercentile(50));
    // B: 40 reps is well above the women/20s P80 anchor (32) -> seeded high.
    expect(evB.mmr_before).not.toBe(1000);
    expect(evB.mmr_before).toBeGreaterThan(evA.mmr_before);

    // The seed used is exactly what _mmr_seed_from_norms would produce for
    // that raw score.
    expect(evA.mmr_before).toBe(await seedFromNorms('pushups', 'male', '20s', 30));
    expect(evB.mmr_before).toBe(await seedFromNorms('pushups', 'female', '20s', 40));
  });

  it("does not re-seed a fighter's second placement bout", async () => {
    const a = await createUserWith('male', '30s');
    const b1 = await createUserWith(null, null);
    await enter(a, {});
    const first = await enter(b1, {});
    expect(first.status).toBe('matched');
    await submit(a, first.match_id!, { reps: 20 });
    await submit(b1, first.match_id!, { reps: 15 });
    const afterFirst = (await ratingOf(db, a, 'pushups'))!.mmr;
    expect(afterFirst).not.toBe(1000);

    const b2 = await createUserWith(null, null);
    await enter(a, {});
    const second = await enter(b2, {});
    expect(second.status).toBe('matched');
    await submit(a, second.match_id!, { reps: 20 });
    await submit(b2, second.match_id!, { reps: 20 });

    const ev2 = (await eventFor(a, second.match_id!))!;
    expect(ev2.norms_seeded).toBe(false);
    expect(ev2.matches_played).toBe(2);
    // mmr_before on bout 2 is wherever bout 1 left them, not a fresh seed.
    expect(ev2.mmr_before).toBe(afterFirst);
  });

  it('falls back to the flat population-median seed when age_band/gender are both missing', async () => {
    const { a, b, matchId } = await duel({ gender: null, ageBand: null }, { gender: null, ageBand: null });
    await submit(a, matchId, { reps: 25 });
    await submit(b, matchId, { reps: 20 });
    const ev = (await eventFor(a, matchId))!;
    expect(ev.norms_seeded).toBe(false);
    expect(ev.mmr_before).toBe(1000);
  });

  it('falls back when only gender is on file (age_band missing)', async () => {
    const { a, b, matchId } = await duel({ gender: 'male', ageBand: null }, { gender: null, ageBand: null });
    await submit(a, matchId, { reps: 25 });
    await submit(b, matchId, { reps: 20 });
    const ev = (await eventFor(a, matchId))!;
    expect(ev.norms_seeded).toBe(false);
    expect(ev.mmr_before).toBe(1000);
  });

  it('falls back when only age_band is on file (gender missing)', async () => {
    const { a, b, matchId } = await duel({ gender: null, ageBand: '30s' }, { gender: null, ageBand: null });
    await submit(a, matchId, { reps: 25 });
    await submit(b, matchId, { reps: 20 });
    const ev = (await eventFor(a, matchId))!;
    expect(ev.norms_seeded).toBe(false);
    expect(ev.mmr_before).toBe(1000);
  });

  it('does not block or affect settlement when demographics are missing -- payout is untouched', async () => {
    const { a, b, matchId } = await duel({ gender: null, ageBand: null }, { gender: null, ageBand: null });
    await submit(a, matchId, { reps: 40 });
    await submit(b, matchId, { reps: 10 });
    const { rows } = await db.pool.query<{ points_balance: number }>(
      'SELECT points_balance FROM fitness_profiles WHERE user_id = $1', [a],
    );
    expect(rows[0]!.points_balance).toBe(600); // 500 - 100 stake + 200 pot, same as before this migration
  });

  it('seeds every rated exercise type (plank, wallsit) on first bout, not just pushups', async () => {
    const plank = await duel({ gender: 'male', ageBand: '20s' }, { gender: 'female', ageBand: '20s' }, 'plank');
    await submit(plank.a, plank.matchId, { hold: 110 });
    await submit(plank.b, plank.matchId, { hold: 95 });
    expect((await eventFor(plank.a, plank.matchId))!.norms_seeded).toBe(true);

    const wallsit = await duel({ gender: 'male', ageBand: '20s' }, { gender: 'female', ageBand: '20s' }, 'wallsit');
    await submit(wallsit.a, wallsit.matchId, { hold: 90 });
    await submit(wallsit.b, wallsit.matchId, { hold: 70 });
    expect((await eventFor(wallsit.a, wallsit.matchId))!.norms_seeded).toBe(true);
  });

  it('seeds correctly inside a group battle, using pre-bout ratings for every pairwise comparison', async () => {
    const veteran = await createUserWith(null, null);
    // Give the veteran a real rating first, elsewhere, so they are placed.
    const foil = await createUserWith(null, null);
    await enter(veteran, {});
    const warm = await enter(foil, {});
    await submit(veteran, warm.match_id!, { reps: 20 });
    await submit(foil, warm.match_id!, { reps: 20 });
    const veteranMmr = (await ratingOf(db, veteran, 'pushups'))!.mmr;

    const rookie = await createUserWith('male', '20s');
    const c = await createUserWith(null, null);
    const d = await createUserWith(null, null);
    await enter(veteran, { format: 'pooled', seats: 4 });
    await enter(rookie, { format: 'pooled', seats: 4 });
    await enter(c, { format: 'pooled', seats: 4 });
    const lastRow = await enter(d, { format: 'pooled', seats: 4 });
    expect(lastRow.status).toBe('matched');
    const matchId = lastRow.match_id!;

    await submit(veteran, matchId, { reps: 45 });
    await submit(rookie, matchId, { reps: 30 }); // exactly the men/20s P50 anchor
    await submit(c, matchId, { reps: 20 });
    await submit(d, matchId, { reps: 10 });

    const rookieEvent = (await eventFor(rookie, matchId))!;
    expect(rookieEvent.norms_seeded).toBe(true);
    expect(rookieEvent.mmr_before).toBe(await mmrFromPercentile(50));

    const veteranEvent = (await eventFor(veteran, matchId))!;
    expect(veteranEvent.norms_seeded).toBe(false);
    expect(veteranEvent.mmr_before).toBe(veteranMmr);
  });
});

// ── race pipeline (standalone, not wired into settlement) ──────────────

describe('_mmr_seed_from_race_time (standalone -- not wired into settle_match)', () => {
  it('gives a faster time a higher seed than a slower one, same age/gender', async () => {
    const { rows } = await db.pool.query<{ fast: number; slow: number }>(
      "SELECT _mmr_seed_from_race_time('male','mile',280,'30s') fast, _mmr_seed_from_race_time('male','mile',400,'30s') slow",
    );
    expect(rows[0]!.fast).toBeGreaterThan(rows[0]!.slow);
  });

  it('credits an older runner more than a younger one for the identical clock time', async () => {
    // The whole point of age grading: same actual time, older runner
    // scores higher because the age factor shrinks their age-adjusted
    // time before comparing to the open standard.
    const { rows } = await db.pool.query<{ young: number; old: number }>(
      "SELECT _mmr_seed_from_race_time('male','mile',360,'20s') young, _mmr_seed_from_race_time('male','mile',360,'60s') old",
    );
    expect(rows[0]!.old).toBeGreaterThan(rows[0]!.young);
  });

  it('returns null for a distance with no standard on file', async () => {
    const { rows } = await db.pool.query<{ v: number | null }>(
      "SELECT _mmr_seed_from_race_time('male','marathon',10000,'30s') v",
    );
    expect(rows[0]!.v).toBeNull();
  });

  it('returns null rather than dividing by zero for a non-positive time', async () => {
    const { rows } = await db.pool.query<{ v: number | null }>(
      "SELECT _mmr_seed_from_race_time('male','mile',0,'30s') v",
    );
    expect(rows[0]!.v).toBeNull();
  });

  it('is not called anywhere in settlement -- race bouts still cannot settle at all', async () => {
    // Unchanged, pre-existing behaviour: settle_match() raises for race.
    // This pins that "not wired in" is still true after this migration.
    const [a, b] = [await createUserWith('male', '30s'), await createUserWith('female', '30s')];
    const { rows: challengeRows } = await db.pool.query<{ id: string }>(
      `INSERT INTO challenges (type, format, stake_points, max_participants, status, created_by)
       VALUES ('race', '1v1', 100, 2, 'matched', $1) RETURNING id`, [a],
    );
    const { rows: matchRows } = await db.pool.query<{ id: string }>(
      'INSERT INTO matches (challenge_id) VALUES ($1) RETURNING id', [challengeRows[0]!.id],
    );
    await db.pool.query(
      'INSERT INTO match_participants (match_id, user_id, time_seconds) VALUES ($1, $2, 300), ($1, $3, 320)',
      [matchRows[0]!.id, a, b],
    );
    await db.pool.query(
      `INSERT INTO verification_sessions (match_participant_id, raw_metrics, anomaly_flag, reviewed)
       SELECT id, '{}'::jsonb, false, false FROM match_participants WHERE match_id = $1`,
      [matchRows[0]!.id],
    );
    await expect(
      rpcAsUser(db, a, 'SELECT settle_match($1)', [matchRows[0]!.id]),
    ).rejects.toThrow(/not implemented for race/);
  });
});

// ── update_my_profile(): the two new fields ─────────────────────────────

describe('update_my_profile with age_band / gender', () => {
  it('sets both from a null starting point, and leaves them alone when omitted', async () => {
    const u = await createUser(db, {});
    const row1 = await rpcRow<{ gender: string | null; age_band: string | null }>(
      db, u, 'SELECT * FROM update_my_profile(p_age_band := $1, p_gender := $2)', ['40s', 'female'],
    );
    expect(row1).toMatchObject({ gender: 'female', age_band: '40s' });

    // Old-style call (display name only) must still work post-DROP/CREATE,
    // and must leave gender/age_band exactly as they were.
    const row2 = await rpcRow<{ gender: string | null; age_band: string | null; display_name: string | null }>(
      db, u, 'SELECT * FROM update_my_profile($1)', ['New Name'],
    );
    expect(row2).toMatchObject({ gender: 'female', age_band: '40s', display_name: 'New Name' });
  });

  it('rejects a value outside the enum at the call boundary', async () => {
    const u = await createUser(db, {});
    await expect(
      rpcAsUser(db, u, "SELECT update_my_profile(p_gender := 'nonbinary-not-a-real-value')"),
    ).rejects.toThrow();
  });
});
