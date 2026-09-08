/**
 * Runs an embedded Postgres in its own Node process for the database tests.
 *
 * Why a child process: `embedded-postgres` is ESM and loads its platform
 * binary with a dynamic import(), which Jest's CommonJS runtime refuses.
 * The harness (test/dbHarness.ts) spawns this script, waits for the READY
 * line, connects with `pg` over TCP, and writes "stop" to stdin when done.
 *
 * Usage: node test/pgServer.mjs <port> [dataDir]
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import EmbeddedPostgres from 'embedded-postgres';

const port = Number(process.argv[2]);
const dir = process.argv[3] ?? path.join(os.tmpdir(), `fittr-pg-${process.pid}-${port}`);

if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write('usage: node test/pgServer.mjs <port> [dataDir]\n');
  process.exit(2);
}

const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: false,
  // The race tests open many concurrent connections on purpose.
  postgresFlags: ['-c', 'max_connections=64'],
});

let stopping = false;
async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    await pg.stop();
  } catch {
    // Already down.
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort; it lives under the OS temp dir.
  }
  process.exit(0);
}

process.stdin.on('data', chunk => {
  if (String(chunk).includes('stop')) {
    void stop();
  }
});
process.stdin.on('end', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

try {
  await pg.initialise();
  await pg.start();
  process.stdout.write(`READY ${port}\n`);
} catch (error) {
  process.stderr.write(`pgServer failed: ${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
}
