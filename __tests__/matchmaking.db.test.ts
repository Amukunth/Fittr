/**
 * Live matchmaking queue against a real Postgres. Boots an embedded server,
 * replays every migration, then drives enter / heartbeat / leave, the
 * N-player settlement and the grants with genuinely concurrent connections.
 *
 * What this proves: the SQL behaves under real lock contention. What it
 * cannot prove: the same calls arriving through PostgREST from two phones,
 * and Supabase Realtime delivering the 'matched' UPDATE. See BACKEND.md.
 */
import {
  asService,
  asUser,
  balance,
  createUser,
  rpcAsUser,
  rpcRow,
  startTestDb,
  type TestDb,
  type Tier,
} from '../test/dbHarness';
import type { MatchmakingQueueRow } from '../src/types/database';

let db: TestDb;

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await db.stop();
});

// Every test starts with an empty queue. Without this a fighter left
// searching by one test is the first thing the next test's entrant meets,
// and a lobby fills where the test expected a fresh one. Matches, ledgers
// and balances are left alone: each test creates its own users.
afterEach(async () => {
  await db.pool.query('DELETE FROM matchmaking_queue');
  await db.pool.query("DELETE FROM challenges c WHERE c.status = 'open' AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.challenge_id = c.id)");
});

// ── helpers ─────────────────────────────────────────────────────────────

interface Request {
  exercise?: 'pushups' | 'plank' | 'wallsit' | 'race';
  format?: '1v1' | 'pooled';
  stake?: number;
  seats?: number;
}

function args(r: Request) {
  const format = r.format ?? '1v1';
  return [r.exercise ?? 'pushups', format, r.stake ?? 100, r.seats ?? (format === '1v1' ? 2 : 4)];
}

function enter(user: string, r: Request = {}) {
  return rpcRow<MatchmakingQueueRow>(
    db,
    user,
    'SELECT * FROM enter_matchmaking($1, $2, $3, $4)',
    args(r),
  );
}

function beat(user: string, queueId: string) {
  return rpcRow<MatchmakingQueueRow>(db, user, 'SELECT * FROM matchmaking_heartbeat($1)', [queueId]);
}

function leave(user: string, queueId: string) {
  return rpcRow<MatchmakingQueueRow>(db, user, 'SELECT * FROM leave_matchmaking($1)', [queueId]);
}

async function queueRow(id: string): Promise<MatchmakingQueueRow | null> {
  const { rows } = await db.pool.query<MatchmakingQueueRow>('SELECT * FROM matchmaking_queue WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function searchingRowFor(user: string): Promise<MatchmakingQueueRow | null> {
  const { rows } = await db.pool.query<MatchmakingQueueRow>(
    "SELECT * FROM matchmaking_queue WHERE user_id = $1 AND status = 'searching'",
    [user],
  );
  return rows[0] ?? null;
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) s`, params);
  return rows[0]!.n;
}

async function challengeStatus(id: string): Promise<string | null> {
  const { rows } = await db.pool.query<{ status: string }>('SELECT status FROM challenges WHERE id = $1', [id]);
  return rows[0]?.status ?? null;
}

async function participantsOf(matchId: string): Promise<string[]> {
  const { rows } = await db.pool.query<{ user_id: string }>(
    'SELECT user_id FROM match_participants WHERE match_id = $1 ORDER BY user_id',
    [matchId],
  );
  return rows.map(r => r.user_id);
}

async function matchesOf(ids: string[]): Promise<Map<string, string[]>> {
  const { rows } = await db.pool.query<{ user_id: string; match_id: string }>(
    'SELECT user_id, match_id FROM match_participants WHERE user_id = ANY($1) ORDER BY user_id',
    [ids],
  );
  const map = new Map<string, string[]>();
  for (const r of rows) {
    map.set(r.user_id, [...(map.get(r.user_id) ?? []), r.match_id]);
  }
  return map;
}

/** Rewind a lobby's clock (and its members' joined_at) by `seconds`. */
async function ageLobby(challengeId: string, seconds: number) {
  await db.pool.query(
    "UPDATE challenges SET created_at = created_at - make_interval(secs => $2) WHERE id = $1",
    [challengeId, seconds],
  );
  await db.pool.query(
    'UPDATE matchmaking_queue SET joined_at = joined_at - make_interval(secs => $2) WHERE challenge_id = $1',
    [challengeId, seconds],
  );
}

async function ageEntry(queueId: string, seconds: number) {
  await db.pool.query(
    'UPDATE matchmaking_queue SET joined_at = joined_at - make_interval(secs => $2) WHERE id = $1',
    [queueId, seconds],
  );
}

async function goSilent(queueId: string, seconds: number) {
  await db.pool.query(
    'UPDATE matchmaking_presence SET last_seen_at = now() - make_interval(secs => $2) WHERE queue_id = $1',
    [queueId, seconds],
  );
}

async function submit(user: string, matchId: string, opts: { reps?: number; hold?: number; anomaly?: boolean }) {
  const { rows } = await db.pool.query<{ id: string }>(
    'SELECT id FROM match_participants WHERE match_id = $1 AND user_id = $2',
    [matchId, user],
  );
  return rpcAsUser<string>(
    db,
    user,
    'SELECT submit_verification_session($1, $2, $3::jsonb, $4, $5)',
    [rows[0]!.id, opts.reps ?? null, JSON.stringify({ test: true }), opts.anomaly ?? false, opts.hold ?? null],
  );
}

function settle(user: string, matchId: string) {
  return rpcAsUser<string>(db, user, 'SELECT settle_match($1)', [matchId]);
}

async function ledgerFor(user: string, matchId: string): Promise<Array<{ amount: number; reason: string }>> {
  const { rows } = await db.pool.query<{ amount: number; reason: string }>(
    'SELECT amount, reason FROM points_ledger_entries WHERE user_id = $1 AND match_id = $2 ORDER BY created_at',
    [user, matchId],
  );
  return rows;
}

async function users(n: number, tier: Tier = 'beginner', points = 500): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(await createUser(db, { tier, points }));
  }
  return out;
}

/** Fill a 1v1 between two fresh users and return the match id. */
async function fight(stake = 100, exercise: Request['exercise'] = 'pushups'): Promise<{ a: string; b: string; matchId: string }> {
  const [a, b] = await users(2);
  await enter(a!, { stake, exercise });
  const row = await enter(b!, { stake, exercise });
  expect(row.status).toBe('matched');
  return { a: a!, b: b!, matchId: row.match_id! };
}

/** Fill a group of `seats` fresh users and return the match id. */
async function group(seats: number, stake = 100): Promise<{ members: string[]; matchId: string }> {
  const members = await users(seats);
  let last: MatchmakingQueueRow | null = null;
  for (const u of members) {
    last = await enter(u, { format: 'pooled', seats, stake });
  }
  expect(last!.status).toBe('matched');
  return { members, matchId: last!.match_id! };
}

// ── migration chain ─────────────────────────────────────────────────────

describe('migration chain', () => {
  it('replays every migration on a plain Postgres and retires join_challenge', async () => {
    const { rows } = await db.pool.query(
      "SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY 1",
    );
    const names = rows.map(r => r.proname as string);
    expect(names).toEqual(expect.arrayContaining([
      'enter_matchmaking', 'matchmaking_heartbeat', 'leave_matchmaking', 'settle_match',
      'submit_verification_session', 'delete_my_account', 'is_lobby_member',
    ]));
    expect(names).not.toContain('join_challenge');
  });
});

// ── entering ────────────────────────────────────────────────────────────

describe('enter_matchmaking', () => {
  it('seats the first fighter in a fresh lobby and stakes nothing', async () => {
    const [a] = await users(1);
    const row = await enter(a!);
    expect(row.status).toBe('searching');
    expect(row.lobby_size).toBe(1);
    expect(row.challenge_id).not.toBeNull();
    expect(row.match_id).toBeNull();
    expect(row.strength_tier).toBe('beginner');
    expect(await challengeStatus(row.challenge_id!)).toBe('open');
    expect(await count('SELECT 1 FROM matchmaking_presence WHERE queue_id = $1', [row.id])).toBe(1);
    expect(await balance(db, a!)).toBe(500);
  });

  it('completes a 1v1 the instant a compatible second fighter arrives', async () => {
    const [a, b] = await users(2);
    const first = await enter(a!, { stake: 250 });
    const second = await enter(b!, { stake: 250 });

    expect(second.status).toBe('matched');
    expect(second.match_id).not.toBeNull();
    expect(second.lobby_size).toBe(2);
    expect(second.closed_at).not.toBeNull();

    // The waiting fighter's own row carries the same match: that UPDATE is
    // the realtime event their Searching screen is waiting for.
    const waiting = await queueRow(first.id);
    expect(waiting).toMatchObject({ status: 'matched', match_id: second.match_id });

    expect(await participantsOf(second.match_id!)).toEqual([a!, b!].sort());
    expect(await challengeStatus(first.challenge_id!)).toBe('matched');
    expect(await balance(db, a!)).toBe(250);
    expect(await balance(db, b!)).toBe(250);
    expect(await ledgerFor(a!, second.match_id!)).toEqual([{ amount: -250, reason: 'stake' }]);
    expect(await ledgerFor(b!, second.match_id!)).toEqual([{ amount: -250, reason: 'stake' }]);
    // Presence rows are gone: matched rows never beat again.
    expect(await count('SELECT 1 FROM matchmaking_presence WHERE queue_id IN ($1, $2)', [first.id, second.id])).toBe(0);
  });

  it('keeps different stakes, exercises, sizes and tiers in separate lobbies', async () => {
    const [a, b, c, d, e] = await users(5);
    const base = await enter(a!, { stake: 100 });
    const otherStake = await enter(b!, { stake: 250 });
    const otherExercise = await enter(c!, { exercise: 'plank' });
    const groupOfFour = await enter(d!, { format: 'pooled', seats: 4 });
    const otherTier = await enter(await createUser(db, { tier: 'advanced' }), { stake: 100 });
    for (const row of [base, otherStake, otherExercise, groupOfFour, otherTier]) {
      expect(row.status).toBe('searching');
      expect(row.lobby_size).toBe(1);
    }
    const lobbies = new Set([base, otherStake, otherExercise, groupOfFour, otherTier].map(r => r.challenge_id));
    expect(lobbies.size).toBe(5);
    expect(e).toBeDefined();
  });

  it('answers a repeated identical request with the same entry', async () => {
    const [a] = await users(1);
    const first = await enter(a!);
    const again = await enter(a!);
    expect(again.id).toBe(first.id);
    expect(await count("SELECT 1 FROM matchmaking_queue WHERE user_id = $1 AND status = 'searching'", [a!])).toBe(1);
  });

  it('throttles a different request inside the re-entry floor, then replaces the old search', async () => {
    const [a] = await users(1);
    const first = await enter(a!, { stake: 100 });
    await expect(enter(a!, { stake: 250 })).rejects.toThrow(/too_fast/);

    await ageEntry(first.id, 5);
    const replaced = await enter(a!, { stake: 250 });
    expect(replaced.id).not.toBe(first.id);
    expect(replaced.status).toBe('searching');
    // The old row is closed, not deleted, so another device sees why.
    expect(await queueRow(first.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'replaced' });
    // Its lobby had nobody else in it, so it is gone.
    expect(await challengeStatus(first.challenge_id!)).toBeNull();
  });

  it('rejects what the client can never legitimately send', async () => {
    const [a] = await users(1);
    await expect(enter(a!, { exercise: 'race' })).rejects.toThrow(/exercise_not_available/);
    await expect(enter(a!, { stake: 7 })).rejects.toThrow(/stake_invalid/);
    await expect(enter(a!, { format: '1v1', seats: 3 })).rejects.toThrow(/seats_invalid/);
    await expect(enter(a!, { format: 'pooled', seats: 2 })).rejects.toThrow(/seats_invalid/);
    await expect(enter(a!, { format: 'pooled', seats: 7 })).rejects.toThrow(/seats_invalid/);
    const poor = await createUser(db, { points: 40 });
    await expect(enter(poor, { stake: 50 })).rejects.toThrow(/insufficient_points/);
    const { rows } = await db.pool.query<{ id: string }>("INSERT INTO auth.users (email) VALUES ('noprofile@test.local') RETURNING id");
    await expect(enter(rows[0]!.id)).rejects.toThrow(/profile_required/);
  });

  it('is closed to callers without a session', async () => {
    await expect(
      asService(db, async client => {
        await client.query("SELECT set_config('request.jwt.claim.role', 'anon', true)");
        await client.query('SET LOCAL ROLE anon');
        await client.query("SELECT * FROM enter_matchmaking('pushups', '1v1', 100, 2)");
      }),
    ).rejects.toThrow(/not signed in|permission denied/);
  });
});

// ── the race ────────────────────────────────────────────────────────────

describe('concurrent entry (the correctness requirement)', () => {
  it('never lets two simultaneous entrants into an empty domain miss each other', async () => {
    // Each round is a fresh pair in a fresh domain-state: stake 500 keeps
    // these rounds apart from the other suites' 100-point lobbies.
    for (let round = 0; round < 12; round += 1) {
      const [a, b] = await users(2, 'beginner', 1000);
      const results = await Promise.all([enter(a!, { stake: 500 }), enter(b!, { stake: 500 })]);
      const matched = results.filter(r => r.status === 'matched');
      expect(matched).toHaveLength(1);
      const matchId = matched[0]!.match_id!;
      expect(await participantsOf(matchId)).toEqual([a!, b!].sort());
      const other = await queueRow(results.find(r => r.status !== 'matched')!.id);
      expect(other).toMatchObject({ status: 'matched', match_id: matchId });
      expect(await balance(db, a!)).toBe(500);
      expect(await balance(db, b!)).toBe(500);
      expect(await count("SELECT 1 FROM matchmaking_queue WHERE user_id = ANY($1) AND status = 'searching'", [[a!, b!]])).toBe(0);
    }
  });

  it('pairs eight simultaneous 1v1 entrants into exactly four bouts, each fighter once', async () => {
    const eight = await users(8, 'intermediate', 1000);
    const results = await Promise.all(eight.map(u => enter(u, { stake: 500 })));
    const byUser = await matchesOf(eight);
    const matchIds = new Set<string>();
    for (const u of eight) {
      const mine = byUser.get(u) ?? [];
      expect(mine).toHaveLength(1);
      matchIds.add(mine[0]!);
      expect(await balance(db, u)).toBe(500);
      const row = await queueRow(results[eight.indexOf(u)]!.id);
      expect(row).toMatchObject({ status: 'matched', match_id: mine[0] });
    }
    expect(matchIds.size).toBe(4);
    for (const id of matchIds) {
      expect(await participantsOf(id)).toHaveLength(2);
    }
    expect(await count("SELECT 1 FROM matchmaking_queue WHERE user_id = ANY($1) AND status = 'searching'", [eight])).toBe(0);
    // Every seat came out of exactly one lobby: no duplicate lobbies were
    // left open for this stake and tier.
    expect(await count(
      "SELECT 1 FROM challenges c WHERE c.status = 'open' AND c.stake_points = 500 AND c.max_participants = 2 AND EXISTS (SELECT 1 FROM matchmaking_queue q WHERE q.challenge_id = c.id AND q.user_id = ANY($1))",
      [eight],
    )).toBe(0);
  });

  it('fills groups of four from nine simultaneous entrants and leaves one waiting', async () => {
    const nine = await users(9, 'advanced', 1000);
    const results = await Promise.all(nine.map(u => enter(u, { format: 'pooled', seats: 4, stake: 500 })));
    const byUser = await matchesOf(nine);
    const matchIds = new Set<string>();
    let waiting = 0;
    for (const u of nine) {
      const mine = byUser.get(u) ?? [];
      expect(mine.length).toBeLessThanOrEqual(1);
      if (mine.length === 1) {
        matchIds.add(mine[0]!);
        expect(await balance(db, u)).toBe(500);
      } else {
        waiting += 1;
        expect(await balance(db, u)).toBe(1000);
        const row = await searchingRowFor(u);
        expect(row).not.toBeNull();
        expect(row!.lobby_size).toBe(1);
      }
    }
    expect(matchIds.size).toBe(2);
    expect(waiting).toBe(1);
    for (const id of matchIds) {
      expect(await participantsOf(id)).toHaveLength(4);
    }
    expect(results.filter(r => r.status === 'matched')).toHaveLength(2);
  });

  it('pairs within tier even when three tiers arrive at once', async () => {
    const tiers: Tier[] = ['beginner', 'intermediate', 'advanced'];
    const all: Array<{ user: string; tier: Tier }> = [];
    for (const tier of tiers) {
      for (const u of await users(2, tier, 1000)) {
        all.push({ user: u, tier });
      }
    }
    await Promise.all(all.map(x => enter(x.user, { exercise: 'wallsit', stake: 500 })));
    const byUser = await matchesOf(all.map(x => x.user));
    for (const x of all) {
      const mine = byUser.get(x.user) ?? [];
      expect(mine).toHaveLength(1);
      const others = (await participantsOf(mine[0]!)).filter(u => u !== x.user);
      expect(others).toHaveLength(1);
      expect(all.find(y => y.user === others[0])!.tier).toBe(x.tier);
    }
  });

  it('resolves a cancel racing a fill one way or the other, never half-way', async () => {
    for (let round = 0; round < 10; round += 1) {
      const [a, b] = await users(2, 'beginner', 1000);
      const waiting = await enter(a!, { exercise: 'plank', stake: 500 });
      const [left, entered] = await Promise.all([
        leave(a!, waiting.id),
        enter(b!, { exercise: 'plank', stake: 500 }),
      ]);
      if (left.status === 'matched') {
        // Too late: the bout is on for both.
        expect(entered.status).toBe('matched');
        expect(entered.match_id).toBe(left.match_id);
        expect(await participantsOf(left.match_id!)).toEqual([a!, b!].sort());
        expect(await balance(db, a!)).toBe(500);
        expect(await balance(db, b!)).toBe(500);
      } else {
        // Cancelled cleanly: A is out and unstaked, B is alone in a lobby.
        expect(left.status).toBe('cancelled');
        expect(await queueRow(waiting.id)).toBeNull();
        expect(entered.status).toBe('searching');
        expect(entered.lobby_size).toBe(1);
        expect(await balance(db, a!)).toBe(1000);
        expect(await balance(db, b!)).toBe(1000);
        expect(await count('SELECT 1 FROM match_participants WHERE user_id = ANY($1)', [[a!, b!]])).toBe(0);
        await leave(b!, entered.id);
      }
    }
  });

  it('keeps one live search per fighter when two devices enter at once', async () => {
    const [a] = await users(1, 'beginner', 1000);
    const results = await Promise.allSettled([
      enter(a!, { exercise: 'plank', stake: 500 }),
      enter(a!, { exercise: 'plank', stake: 500 }),
      enter(a!, { exercise: 'plank', stake: 250 }),
    ]);
    const ok = results.filter(r => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(String(r.reason)).toMatch(/too_fast|search_in_flight/);
      }
    }
    expect(await count("SELECT 1 FROM matchmaking_queue WHERE user_id = $1 AND status = 'searching'", [a!])).toBe(1);
  });
});

// ── heartbeat and TTL ───────────────────────────────────────────────────

describe('matchmaking_heartbeat and expiry', () => {
  it('refreshes presence and returns the row; refuses ids that are not yours', async () => {
    const [a, b] = await users(2);
    const row = await enter(a!, { exercise: 'wallsit' });
    await goSilent(row.id, 15);
    const fresh = await beat(a!, row.id);
    expect(fresh.id).toBe(row.id);
    expect(fresh.status).toBe('searching');
    const { rows } = await db.pool.query<{ age: number }>(
      'SELECT extract(epoch FROM now() - last_seen_at)::int AS age FROM matchmaking_presence WHERE queue_id = $1',
      [row.id],
    );
    expect(rows[0]!.age).toBeLessThan(5);
    await expect(beat(b!, row.id)).rejects.toThrow(/queue_entry_not_found/);
    await expect(beat(a!, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(/queue_entry_not_found/);
  });

  it("expires a silent fighter so a newcomer is never paired with a ghost", async () => {
    const [ghost, live] = await users(2);
    const g = await enter(ghost!, { exercise: 'wallsit', stake: 250 });
    await goSilent(g.id, 25);
    const l = await enter(live!, { exercise: 'wallsit', stake: 250 });
    expect(l.status).toBe('searching');
    expect(l.challenge_id).not.toBe(g.challenge_id);
    expect(await queueRow(g.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'expired' });
    expect(await challengeStatus(g.challenge_id!)).toBeNull();
    expect(await count('SELECT 1 FROM matchmaking_presence WHERE queue_id = $1', [g.id])).toBe(0);
    expect(await balance(db, ghost!)).toBe(500);
  });

  it('recounts a group lobby when a member goes quiet', async () => {
    const [a, b, c] = await users(3);
    const ra = await enter(a!, { format: 'pooled', seats: 5, stake: 50 });
    const rb = await enter(b!, { format: 'pooled', seats: 5, stake: 50 });
    expect(rb.lobby_size).toBe(2);
    await goSilent(rb.id, 30);
    const rc = await enter(c!, { format: 'pooled', seats: 5, stake: 50 });
    expect(rc.challenge_id).toBe(ra.challenge_id);
    expect(rc.lobby_size).toBe(2);
    expect((await queueRow(ra.id))!.lobby_size).toBe(2);
    expect(await queueRow(rb.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'expired' });
  });

  it("a fighter's own beat can never expire them, and a matched row beats back its match", async () => {
    const [a] = await users(1);
    const row = await enter(a!, { exercise: 'plank', stake: 50 });
    await goSilent(row.id, 25);
    expect((await beat(a!, row.id)).status).toBe('searching');
    // Out of the way: a fresh pair below must meet each other, not this row.
    await leave(a!, row.id);

    const { a: x, matchId } = await fight(50, 'plank');
    const { rows } = await db.pool.query<{ id: string }>('SELECT id FROM matchmaking_queue WHERE user_id = $1', [x]);
    const afterMatch = await beat(x, rows[0]!.id);
    expect(afterMatch).toMatchObject({ status: 'matched', match_id: matchId });
  });

  it('forgets closed rows after the retention window', async () => {
    const { a, matchId } = await fight(50, 'wallsit');
    await db.pool.query(
      "UPDATE matchmaking_queue SET closed_at = now() - interval '11 minutes' WHERE match_id = $1",
      [matchId],
    );
    const [z] = await users(1);
    const trigger = await enter(z!, { exercise: 'wallsit', stake: 50 });
    expect(await count('SELECT 1 FROM matchmaking_queue WHERE match_id = $1', [matchId])).toBe(0);
    expect(await balance(db, a)).toBe(450);
    await leave(z!, trigger.id);
  });
});

// ── leaving ─────────────────────────────────────────────────────────────

describe('leave_matchmaking', () => {
  it('removes the entry and an empty lobby, and is safe to repeat', async () => {
    const [a, b] = await users(2);
    const row = await enter(a!, { stake: 250, exercise: 'plank' });
    const left = await leave(a!, row.id);
    expect(left.status).toBe('cancelled');
    expect(await queueRow(row.id)).toBeNull();
    expect(await challengeStatus(row.challenge_id!)).toBeNull();
    await expect(leave(a!, row.id)).rejects.toThrow(/queue_entry_not_found/);
    const rb = await enter(b!, { stake: 250, exercise: 'plank' });
    await expect(leave(a!, rb.id)).rejects.toThrow(/queue_entry_not_found/);
    expect((await queueRow(rb.id))!.status).toBe('searching');
  });

  it('keeps a group lobby alive for the others and tells them the new size', async () => {
    const [a, b, c] = await users(3);
    const ra = await enter(a!, { format: 'pooled', seats: 6, stake: 50 });
    const rb = await enter(b!, { format: 'pooled', seats: 6, stake: 50 });
    const rc = await enter(c!, { format: 'pooled', seats: 6, stake: 50 });
    expect(rc.lobby_size).toBe(3);
    await leave(b!, rb.id);
    expect(await challengeStatus(ra.challenge_id!)).toBe('open');
    expect((await queueRow(ra.id))!.lobby_size).toBe(2);
    expect((await queueRow(rc.id))!.lobby_size).toBe(2);
  });

  it('after the lobby has filled, leaving just hands back the match', async () => {
    const [a, b] = await users(2);
    const ra = await enter(a!, { stake: 500, exercise: 'wallsit' });
    const rb = await enter(b!, { stake: 500, exercise: 'wallsit' });
    const late = await leave(a!, ra.id);
    expect(late).toMatchObject({ status: 'matched', match_id: rb.match_id });
    expect(await balance(db, a!)).toBe(0);
  });
});

// ── tier widening ───────────────────────────────────────────────────────

describe('tier widening', () => {
  it('only pairs neighbouring tiers once both sides have waited, via the heartbeat, and never two tiers apart', async () => {
    const beginner = await createUser(db, { tier: 'beginner' });
    const intermediate = await createUser(db, { tier: 'intermediate' });
    const advanced = await createUser(db, { tier: 'advanced' });

    const rb = await enter(beginner, { stake: 100, exercise: 'plank' });
    await ageLobby(rb.challenge_id!, 60);

    // A fresh intermediate is not dropped into the aged lobby: they have
    // not waited themselves.
    const ri = await enter(intermediate, { stake: 100, exercise: 'plank' });
    expect(ri.status).toBe('searching');
    expect(ri.challenge_id).not.toBe(rb.challenge_id);

    // Before their own 45 s, a beat changes nothing.
    expect((await beat(intermediate, ri.id)).challenge_id).toBe(ri.challenge_id);

    // The advanced fighter has waited long enough, but is two tiers away.
    const ra = await enter(advanced, { stake: 100, exercise: 'plank' });
    await ageLobby(ra.challenge_id!, 60);
    expect((await beat(advanced, ra.id)).status).toBe('searching');
    expect((await queueRow(ra.id))!.challenge_id).toBe(ra.challenge_id);

    // Once the intermediate has waited too, their beat moves them in and
    // fills the bout.
    await ageLobby(ri.challenge_id!, 60);
    const moved = await beat(intermediate, ri.id);
    expect(moved.status).toBe('matched');
    expect(await participantsOf(moved.match_id!)).toEqual([beginner, intermediate].sort());
    expect(await queueRow(rb.id)).toMatchObject({ status: 'matched', match_id: moved.match_id });
    expect(await challengeStatus(ri.challenge_id!)).toBeNull();
    await leave(advanced, ra.id);
  });

  it('keeps a widened group lobby within one tier of every member', async () => {
    const [b1, b2] = await users(2, 'beginner');
    const inter = await createUser(db, { tier: 'intermediate' });
    const adv = await createUser(db, { tier: 'advanced' });
    const lobby = await enter(b1!, { format: 'pooled', seats: 4, stake: 250 });
    await enter(b2!, { format: 'pooled', seats: 4, stake: 250 });
    await ageLobby(lobby.challenge_id!, 60);

    const ri = await enter(inter, { format: 'pooled', seats: 4, stake: 250 });
    await ageLobby(ri.challenge_id!, 60);
    const movedIn = await beat(inter, ri.id);
    expect(movedIn.challenge_id).toBe(lobby.challenge_id);
    expect(movedIn.lobby_size).toBe(3);

    // Advanced is one tier from the intermediate but two from the
    // beginners: not admitted.
    const ra = await enter(adv, { format: 'pooled', seats: 4, stake: 250 });
    await ageLobby(ra.challenge_id!, 60);
    const stayed = await beat(adv, ra.id);
    expect(stayed.challenge_id).toBe(ra.challenge_id);
    expect(stayed.status).toBe('searching');
  });
});

// ── filling edge cases ──────────────────────────────────────────────────

describe('filling a lobby', () => {
  it('evicts a member who can no longer cover the stake instead of filling', async () => {
    const [a, b] = await users(2);
    const ra = await enter(a!, { stake: 500, exercise: 'plank' });
    await db.pool.query('UPDATE fitness_profiles SET points_balance = 10 WHERE user_id = $1', [a!]);
    const rb = await enter(b!, { stake: 500, exercise: 'plank' });
    expect(rb.status).toBe('searching');
    expect(rb.lobby_size).toBe(1);
    expect(await queueRow(ra.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'insufficient_points' });
    expect(await balance(db, b!)).toBe(500);
    expect(await count('SELECT 1 FROM match_participants WHERE user_id = ANY($1)', [[a!, b!]])).toBe(0);
    await leave(b!, rb.id);
  });

  it('blocks a fighter whose round in a recent bout is still open, until they play it or it ages out', async () => {
    const { a, b, matchId } = await fight(100);
    await expect(enter(a, { stake: 50 })).rejects.toThrow(/round_open/);

    await submit(a, matchId, { reps: 20 });
    const again = await enter(a, { stake: 50 });
    expect(again.status).toBe('searching');
    await leave(a, again.id);

    await expect(enter(b, { stake: 50 })).rejects.toThrow(/round_open/);
    await db.pool.query("UPDATE matches SET created_at = created_at - interval '25 hours' WHERE id = $1", [matchId]);
    const old = await enter(b, { stake: 50 });
    expect(old.status).toBe('searching');
    await leave(b, old.id);
  });
});

// ── settlement for N ────────────────────────────────────────────────────

describe('settle_match for N seats', () => {
  it('keeps the 1v1 rules byte-for-byte: winner takes both stakes, a tie refunds both', async () => {
    const { a, b, matchId } = await fight(100);
    await submit(a, matchId, { reps: 30 });
    expect(await settle(a, matchId)).toBe('not_ready');
    await submit(b, matchId, { reps: 25 });
    expect(await settle(a, matchId)).toBe('already_settled');
    const { rows } = await db.pool.query('SELECT winner_id, settled_at FROM matches WHERE id = $1', [matchId]);
    expect(rows[0].winner_id).toBe(a);
    expect(rows[0].settled_at).not.toBeNull();
    expect(await balance(db, a)).toBe(600);
    expect(await balance(db, b)).toBe(400);
    expect(await ledgerFor(a, matchId)).toEqual([{ amount: -100, reason: 'stake' }, { amount: 200, reason: 'payout' }]);

    const tie = await fight(100);
    await submit(tie.a, tie.matchId, { reps: 12 });
    await submit(tie.b, tie.matchId, { reps: 12 });
    const m = await db.pool.query('SELECT winner_id, settled_at FROM matches WHERE id = $1', [tie.matchId]);
    expect(m.rows[0].winner_id).toBeNull();
    expect(m.rows[0].settled_at).not.toBeNull();
    expect(await balance(db, tie.a)).toBe(500);
    expect(await balance(db, tie.b)).toBe(500);
  });

  it('pays the whole pot to a sole group winner', async () => {
    const { members, matchId } = await group(3, 100);
    const [a, b, c] = members;
    await submit(a!, matchId, { reps: 10 });
    await submit(b!, matchId, { reps: 40 });
    expect(await settle(a!, matchId)).toBe('not_ready');
    await submit(c!, matchId, { reps: 20 });
    const { rows } = await db.pool.query('SELECT winner_id FROM matches WHERE id = $1', [matchId]);
    expect(rows[0].winner_id).toBe(b);
    expect(await balance(db, a!)).toBe(400);
    expect(await balance(db, b!)).toBe(700);
    expect(await balance(db, c!)).toBe(400);
    expect(await challengeStatus((await db.pool.query('SELECT challenge_id FROM matches WHERE id = $1', [matchId])).rows[0].challenge_id)).toBe('completed');
  });

  it('splits the pot between fighters tied for best and reports tie_split', async () => {
    const { members, matchId } = await group(3, 100);
    const [a, b, c] = members;
    await submit(a!, matchId, { reps: 30 });
    await submit(b!, matchId, { reps: 30 });
    await submit(c!, matchId, { reps: 20 });
    // The inline settlement already ran; calling again reports the guard.
    expect(await settle(c!, matchId)).toBe('already_settled');
    const { rows } = await db.pool.query('SELECT winner_id, settled_at FROM matches WHERE id = $1', [matchId]);
    expect(rows[0].winner_id).toBeNull();
    expect(rows[0].settled_at).not.toBeNull();
    expect(await balance(db, a!)).toBe(550);
    expect(await balance(db, b!)).toBe(550);
    expect(await balance(db, c!)).toBe(400);
    expect(await ledgerFor(c!, matchId)).toEqual([{ amount: -100, reason: 'stake' }]);
  });

  it('returns tie_split versus tie_refunded from a direct call and conserves an uneven pot', async () => {
    // Four seats at 50: pot 200. Three tie -> 66 each, the 2 left over go
    // to the lowest user_id among the tied, in their single payout row.
    const { members, matchId } = await group(4, 50);
    const sorted = [...members].sort();
    const loser = sorted[3]!;
    const tied = sorted.slice(0, 3);
    // Hold the inline settlement off by submitting the loser last.
    for (const u of tied) {
      await submit(u, matchId, { reps: 15 });
    }
    await submit(loser, matchId, { reps: 1 });
    const { rows } = await db.pool.query<{ user_id: string; amount: number }>(
      "SELECT user_id, amount FROM points_ledger_entries WHERE match_id = $1 AND reason = 'payout' ORDER BY user_id",
      [matchId],
    );
    expect(rows.map(r => r.amount)).toEqual([68, 66, 66]);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(200);
    expect(await balance(db, tied[0]!)).toBe(518);
    expect(await balance(db, loser)).toBe(450);

    // Everyone tied: every stake comes back, reported as tie_refunded.
    const all = await group(3, 100);
    for (const u of all.members) {
      await submit(u, all.matchId, { reps: 9 });
    }
    for (const u of all.members) {
      expect(await balance(db, u)).toBe(500);
    }
    // A fresh settle after the fact still classifies the same way.
    await db.pool.query('UPDATE matches SET settled_at = NULL WHERE id = $1', [all.matchId]);
    await db.pool.query("DELETE FROM points_ledger_entries WHERE match_id = $1 AND reason = 'payout'", [all.matchId]);
    await db.pool.query('UPDATE fitness_profiles SET points_balance = 400 WHERE user_id = ANY($1)', [all.members]);
    expect(await settle(all.members[0]!, all.matchId)).toBe('tie_refunded');
    await db.pool.query('UPDATE matches SET settled_at = NULL WHERE id = $1', [matchId]);
    await db.pool.query("DELETE FROM points_ledger_entries WHERE match_id = $1 AND reason = 'payout'", [matchId]);
    expect(await settle(loser, matchId)).toBe('tie_split');
  });

  it('holds the pot when a winner is flagged, and pays once the review clears', async () => {
    const { members, matchId } = await group(3, 100);
    const [a, b, c] = members;
    await submit(a!, matchId, { reps: 50, anomaly: true });
    await submit(b!, matchId, { reps: 10 });
    await submit(c!, matchId, { reps: 5, anomaly: true });
    expect(await balance(db, a!)).toBe(400);
    const { rows } = await db.pool.query('SELECT c.status FROM matches m JOIN challenges c ON c.id = m.challenge_id WHERE m.id = $1', [matchId]);
    expect(rows[0].status).toBe('needs_review');
    // A flagged loser does not matter; the flagged winner does.
    await db.pool.query(
      'UPDATE verification_sessions vs SET reviewed = true FROM match_participants mp WHERE mp.id = vs.match_participant_id AND mp.match_id = $1 AND mp.user_id = $2',
      [matchId, a!],
    );
    expect(await settle(b!, matchId)).toBe('settled');
    expect(await balance(db, a!)).toBe(700);
  });

  it('is open to participants and the service role only', async () => {
    const { a, matchId } = await fight(50);
    const [stranger] = await users(1);
    await expect(settle(stranger!, matchId)).rejects.toThrow(/not a participant/);
    await expect(
      asService(db, async client => {
        await client.query("SELECT set_config('request.jwt.claim.role', 'anon', true)");
        await client.query('SET LOCAL ROLE anon');
        await client.query('SELECT settle_match($1)', [matchId]);
      }),
    ).rejects.toThrow(/not signed in|permission denied/);
    const viaService = await asService(db, async client => {
      const { rows } = await client.query<{ settle_match: string }>('SELECT settle_match($1)', [matchId]);
      return rows[0]!.settle_match;
    });
    expect(viaService).toBe('not_ready');
    expect(await settle(a, matchId)).toBe('not_ready');
  });
});

// ── account deletion ────────────────────────────────────────────────────

describe('delete_my_account', () => {
  it('leaves the queue first and repairs the lobby it was in', async () => {
    const [a, b] = await users(2);
    const ra = await enter(a!, { format: 'pooled', seats: 3, stake: 50 });
    const rb = await enter(b!, { format: 'pooled', seats: 3, stake: 50 });
    expect(rb.lobby_size).toBe(2);
    await rpcAsUser(db, a!, 'SELECT delete_my_account()');
    expect(await queueRow(ra.id)).toBeNull();
    expect(await challengeStatus(ra.challenge_id!)).toBe('open');
    expect((await queueRow(rb.id))!.lobby_size).toBe(1);
    await leave(b!, rb.id);
  });

  it('does not count a lobby someone opened and left as their live bout', async () => {
    // challenges.created_by is just "who opened this lobby". Someone who
    // opened one, left, and never fought must not be held by the bout the
    // others went on to have.
    const [opener, x, y, z] = await users(4);
    const ro = await enter(opener!, { format: 'pooled', seats: 3, stake: 250 });
    const rx = await enter(x!, { format: 'pooled', seats: 3, stake: 250 });
    expect(rx.challenge_id).toBe(ro.challenge_id);
    await leave(opener!, ro.id);

    const ry = await enter(y!, { format: 'pooled', seats: 3, stake: 250 });
    expect(ry.challenge_id).toBe(ro.challenge_id);
    const rz = await enter(z!, { format: 'pooled', seats: 3, stake: 250 });
    expect(rz.status).toBe('matched');

    const { rows } = await db.pool.query<{ created_by: string; status: string }>(
      'SELECT created_by, status FROM challenges WHERE id = $1',
      [ro.challenge_id],
    );
    expect(rows[0]).toMatchObject({ created_by: opener!, status: 'matched' });
    expect(await participantsOf(rz.match_id!)).toEqual([x!, y!, z!].sort());

    // The opener is not in it: deletion goes through (void returns '').
    await expect(rpcAsUser(db, opener!, 'SELECT delete_my_account()')).resolves.toBe('');
    // A fighter who is in it is refused.
    await expect(rpcAsUser(db, x!, 'SELECT delete_my_account()')).rejects.toThrow(/live_bouts/);
  });
});

// ── grants and RLS ──────────────────────────────────────────────────────

describe('grants and row security', () => {
  it('gives clients no write path and no view of other fighters', async () => {
    const [a, b] = await users(2);
    const ra = await enter(a!, { stake: 250 });

    await expect(asUser(db, b!, c => c.query(
      "INSERT INTO challenges (type, format, stake_points, created_by) VALUES ('pushups', '1v1', 100, $1)", [b!],
    ))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, b!, c => c.query(
      "INSERT INTO matchmaking_queue (user_id, exercise_type, format, max_participants, stake_points, strength_tier, challenge_id) VALUES ($1, 'pushups', '1v1', 2, 100, 'beginner', $2)", [b!, ra.challenge_id],
    ))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, b!, c => c.query('UPDATE matchmaking_queue SET status = $1', ['matched']))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, b!, c => c.query('SELECT * FROM matchmaking_presence'))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, b!, c => c.query('SELECT _mm_try_complete($1)', [ra.challenge_id]))).rejects.toThrow(/permission denied/);

    // b cannot see a's queue row or a's open lobby; a can see both.
    const bSees = await asUser(db, b!, async c => ({
      queue: (await c.query('SELECT id FROM matchmaking_queue')).rowCount,
      lobby: (await c.query('SELECT id FROM challenges WHERE id = $1', [ra.challenge_id])).rowCount,
    }));
    expect(bSees).toEqual({ queue: 0, lobby: 0 });
    const aSees = await asUser(db, a!, async c => ({
      queue: (await c.query('SELECT id FROM matchmaking_queue')).rowCount,
      lobby: (await c.query('SELECT id FROM challenges WHERE id = $1', [ra.challenge_id])).rowCount,
    }));
    expect(aSees).toEqual({ queue: 1, lobby: 1 });

    // Once matched, the challenge is readable by any signed-in user (Home,
    // Results and the realtime subscriptions rely on it).
    const rb = await enter(b!, { stake: 250 });
    const stranger = (await users(1))[0]!;
    const visible = await asUser(db, stranger, c => c.query('SELECT id FROM challenges WHERE id = $1', [rb.challenge_id]));
    expect(visible.rowCount).toBe(1);
  });
});
