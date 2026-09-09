/**
 * Real Postgres for the database tests.
 *
 * Boots an embedded Postgres (a real server binary, so plpgsql, FOR UPDATE
 * row locks, advisory locks and RLS all behave exactly as in production),
 * installs a shim of the pieces of Supabase the migrations depend on (the
 * `auth` schema, `auth.uid()` / `auth.role()`, the anon / authenticated /
 * service_role roles and Supabase's default table grants), then applies
 * every file in prisma/migrations in order — the same SQL `prisma migrate
 * deploy` runs against the live project.
 *
 * Identity is injected the way PostgREST does it: per-transaction settings
 * `request.jwt.claim.sub` and `request.jwt.claim.role`, which the shimmed
 * auth.uid() / auth.role() read. `asUser` also switches to the
 * `authenticated` role so RLS and grants are enforced.
 *
 * What this cannot reproduce: PostgREST itself, Supabase Realtime, and two
 * phones. Concurrency here is real (separate TCP connections, separate
 * backends, genuine lock contention) but the wire is not.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Pool, type PoolClient } from 'pg';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'prisma', 'migrations');
const PG_SERVER_SCRIPT = path.join(__dirname, 'pgServer.mjs');

const SUPABASE_SHIM = `
CREATE SCHEMA IF NOT EXISTS auth;
-- Only the columns the migrations touch. delete_my_account() writes email,
-- phone, raw_user_meta_data, banned_until and updated_at.
CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  phone text,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  banned_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth.identities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL);
CREATE TABLE auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL);
CREATE TABLE auth.refresh_tokens (id bigserial PRIMARY KEY, user_id text NOT NULL);
CREATE TABLE auth.mfa_factors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.role', true), '')
$$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO service_role;
-- Supabase's defaults: broad grants that the migrations then narrow.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
`;

export interface TestDb {
  pool: Pool;
  stop: () => Promise<void>;
}

export type Tier = 'beginner' | 'intermediate' | 'advanced';

function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(name => fs.statSync(path.join(MIGRATIONS_DIR, name)).isDirectory())
    .sort()
    .map(name => path.join(MIGRATIONS_DIR, name, 'migration.sql'))
    .filter(file => fs.existsSync(file));
}

/**
 * Boots test/pgServer.mjs (see there for why it is a separate process) and
 * resolves once it reports READY.
 */
function spawnPostgres(port: number, databaseDir: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PG_SERVER_SCRIPT, String(port), databaseDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`embedded Postgres did not start within 90s\n${stderr}`));
    }, 90000);
    child.stdout?.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.includes(`READY ${port}`)) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr?.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`embedded Postgres exited early (code ${code})\n${stderr}`));
    });
  });
}

function stopPostgres(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 15000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.stdin?.write('stop\n');
  });
}

export async function startTestDb(): Promise<TestDb> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const databaseDir = path.join(os.tmpdir(), `fittr-pg-${process.pid}-${port}`);
  const child = await spawnPostgres(port, databaseDir);

  const pool = new Pool({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password: 'postgres',
    database: 'postgres',
    // The race tests fire up to 12 RPCs at once, each on its own connection.
    max: 24,
  });

  const client = await pool.connect();
  try {
    await client.query(SUPABASE_SHIM);
    for (const file of migrationFiles()) {
      // Each file as one multi-statement batch, mirroring `migrate deploy`.
      await client.query(fs.readFileSync(file, 'utf8'));
    }
  } finally {
    client.release();
  }

  return {
    pool,
    stop: async () => {
      await pool.end();
      await stopPostgres(child);
      fs.rmSync(databaseDir, { recursive: true, force: true });
    },
  };
}

/** An auth user with a fitness profile at the given tier and balance. */
export async function createUser(
  db: TestDb,
  opts: { tier?: Tier; points?: number; email?: string } = {},
): Promise<string> {
  const email = opts.email ?? `user-${Math.random().toString(36).slice(2)}@test.local`;
  const { rows } = await db.pool.query<{ id: string }>(
    'INSERT INTO auth.users (email) VALUES ($1) RETURNING id',
    [email],
  );
  const id = rows[0]!.id;
  await db.pool.query(
    'INSERT INTO fitness_profiles (user_id, strength_tier, points_balance) VALUES ($1, $2, $3)',
    [id, opts.tier ?? 'beginner', opts.points ?? 500],
  );
  return id;
}

type Work<T> = (client: PoolClient) => Promise<T>;

async function inTransaction<T>(db: TestDb, setup: string[], work: Work<T>): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of setup) {
      await client.query(statement);
    }
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Runs `work` as a signed-in user, under RLS, in one transaction. */
export function asUser<T>(db: TestDb, userId: string, work: Work<T>): Promise<T> {
  return inTransaction(
    db,
    [
      `SELECT set_config('request.jwt.claim.sub', '${userId}', true)`,
      `SELECT set_config('request.jwt.claim.role', 'authenticated', true)`,
      'SET LOCAL ROLE authenticated',
    ],
    work,
  );
}

/** Runs `work` the way a service-role caller would (no uid, bypasses RLS). */
export function asService<T>(db: TestDb, work: Work<T>): Promise<T> {
  return inTransaction(
    db,
    [
      `SELECT set_config('request.jwt.claim.sub', '', true)`,
      `SELECT set_config('request.jwt.claim.role', 'service_role', true)`,
      'SET LOCAL ROLE service_role',
    ],
    work,
  );
}

/**
 * One RPC-style call as a user, returning the first row. PostgREST runs
 * every RPC in its own transaction, which is exactly what asUser does.
 */
export async function rpcRow<T>(
  db: TestDb,
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  return asUser(db, userId, async client => {
    const { rows } = await client.query(sql, params);
    // The row types here are hand-written mirrors of the schema (see
    // src/types/database.ts), which pg's QueryResultRow constraint rejects
    // for lacking an index signature. The cast is the whole point of the
    // helper: one place that says "this SQL returns that shape".
    return rows[0] as T;
  });
}

/** One RPC-style call as a user, returning its scalar result. */
export async function rpcAsUser<T = unknown>(
  db: TestDb,
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  return asUser(db, userId, async client => {
    const { rows } = await client.query(sql, params);
    const row = rows[0] as Record<string, T> | undefined;
    return row ? (Object.values(row)[0] as T) : (undefined as T);
  });
}

export async function rpcAsService<T = unknown>(
  db: TestDb,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  return asService(db, async client => {
    const { rows } = await client.query(sql, params);
    const row = rows[0] as Record<string, T> | undefined;
    return row ? (Object.values(row)[0] as T) : (undefined as T);
  });
}

/** points_balance as the database holds it (not through RLS). */
export async function balance(db: TestDb, userId: string): Promise<number> {
  const { rows } = await db.pool.query<{ points_balance: number }>(
    'SELECT points_balance FROM fitness_profiles WHERE user_id = $1',
    [userId],
  );
  return rows[0]!.points_balance;
}

/**
 * Force a skill rating into a known state. `matchesPlayed` drives
 * placement: the table's trigger derives placement_complete from it, so
 * passing 5 or more is what makes a rating "placed" and therefore subject
 * to the matchmaking MMR window.
 */
export async function setRating(
  db: TestDb,
  userId: string,
  exercise: 'pushups' | 'plank' | 'wallsit',
  mmr: number,
  matchesPlayed = 5,
): Promise<void> {
  await db.pool.query(
    `INSERT INTO skill_ratings (user_id, exercise_type, mmr, matches_played)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, exercise_type)
     DO UPDATE SET mmr = EXCLUDED.mmr, matches_played = EXCLUDED.matches_played`,
    [userId, exercise, mmr, matchesPlayed],
  );
}

/** A user with a profile AND a placed rating in one exercise. */
export async function createRatedUser(
  db: TestDb,
  exercise: 'pushups' | 'plank' | 'wallsit',
  mmr: number,
  opts: { points?: number; matchesPlayed?: number } = {},
): Promise<string> {
  const id = await createUser(db, { points: opts.points ?? 500 });
  await setRating(db, id, exercise, mmr, opts.matchesPlayed ?? 5);
  return id;
}

/** The current rating row for one (user, exercise), or null. */
export async function ratingOf(
  db: TestDb,
  userId: string,
  exercise: 'pushups' | 'plank' | 'wallsit',
): Promise<{ mmr: number; matches_played: number; placement_complete: boolean } | null> {
  const { rows } = await db.pool.query<{
    mmr: number;
    matches_played: number;
    placement_complete: boolean;
  }>(
    'SELECT mmr, matches_played, placement_complete FROM skill_ratings WHERE user_id = $1 AND exercise_type = $2',
    [userId, exercise],
  );
  return rows[0] ?? null;
}
