# Backend notes for FittrApp

Read this before touching `prisma/` or wiring real credentials. It exists
because this app shares one Supabase Postgres database with a separate,
already-deployed app (`FittrLanding/waitlist-app`), and a few things about
that sharing aren't optional.

## What already exists in the shared database

Read directly from `FittrLanding/waitlist-app` on disk (no live DB
connection was made to produce this):

- One table, `signups` (the waitlist), owned by that app's own Prisma
  project and migration history. **Never modify it or its migrations.**
- `DATABASE_URL` there points at Supabase's transaction-mode pooler (port
  6543). That project's own `prisma.config.ts` runs migrations over a
  separate `DIRECT_URL` (session-mode/port 5432) instead, because the
  transaction-mode pooler doesn't reliably support the advisory locks and
  prepared statements `prisma migrate` needs — it hangs instead of
  erroring. This project copies that same convention; see `prisma.config.ts`
  and `prisma/.env.example`.
- **No Supabase Auth usage anywhere.** No `@supabase/supabase-js`
  dependency, no auth code, no users table beyond the waitlist rows
  themselves. This is the biggest assumption in this whole pass — see below.

## Assumptions made without being able to ask first

1. **Auth = Supabase Auth (email/password), starting from zero.** The brief
   says "linked to the existing user table" and "reuse session-check logic
   if already scaffolded" — neither exists. `FitnessProfile.user_id` is
   wired to Supabase's built-in `auth.users.id` (every Supabase project has
   this table automatically) rather than a new custom users table. The FK
   to `auth.users(id)` is raw SQL in the migration file, not a Prisma-level
   relation in `schema.prisma` — see "Migration status" below for why. If
   the real plan is a different auth provider, everything under
   `src/context/AuthContext.tsx` and those raw FKs need to change.
2. **The mobile app never gets a raw Postgres connection.** `DATABASE_URL`
   (real Postgres credentials) stays in `prisma/.env`, used only by the
   Prisma CLI on a dev/CI machine. The app itself talks to Supabase via
   `@supabase/supabase-js` with the public anon key, gated by the RLS
   policies in the migration. This wasn't explicitly requested, but shipping
   a direct DB connection string inside a mobile app bundle would be a
   straightforward credential leak (anyone can extract strings from an app
   binary) — not a reasonable tradeoff even for a points-only v1.
3. **No SUPABASE_URL / anon key were on file anywhere** — because the
   waitlist app never used the Supabase client library, its project URL and
   anon public key weren't in any file available up front. Both are now in
   `FittrApp/.env` (project `bxfonvtmhxjcnmjhcsls`).
4. **Pooled vs. 1v1 have identical backend mechanics in v1.** The brief's
   `Challenge` fields don't include a pool size, so there's no way to
   represent "wait for N players." A `Challenge` row **is** the offer/pool;
   the first same-strength-tier user to accept completes it into an
   ordinary 2-participant `Match`. The two formats currently differ only in
   how `HomeScreen`/`CreateChallengeScreen` present them, not in what
   happens server-side. Real N-way pooled contests are a schema change
   later (e.g. a `max_participants` column), not just app logic.
5. **Starter bonus of 500 points on first login**, granted once via
   `grant_starter_bonus()`. Without it the app has no points at all to
   stake, and v1 explicitly has no payments/top-up path. Change
   `v_bonus_amount` in the migration (or remove the function and the call
   to it in `useFitnessProfile`) once product has a real number.
6. **Strength tier values**: `beginner` / `intermediate` / `advanced`. Not
   specified in the brief.
7. **No display names.** Nothing in the brief adds a public username/handle
   field, so `ChallengeDetailScreen`/`MatchInProgressScreen` show "You" vs.
   a truncated user ID for the other participant. A real opponent name
   needs a public profile field (e.g. `display_name` on `FitnessProfile`) —
   deliberately not added here since it wasn't asked for.
8. **`join_challenge` and `grant_starter_bonus` run as `SECURITY DEFINER`**
   (elevated, bypassing RLS) so they're the only code path that can move
   `points_balance` or flip `challenges.status`. No table grants client-side
   writes to either. This is why matchmaking is "one SQL function" instead
   of a few `.insert()` calls from the app — separate inserts would be
   non-atomic (a crash mid-sequence leaves a half-created match) and, more
   importantly, would require RLS policies that let *some* client write to
   `points_ledger_entries`/`points_balance`, which any user could then abuse
   to credit themselves points directly.

## Camera verification (push-ups) — what it does and doesn't prove

`MatchInProgressScreen` runs `@quickpose/react-native` (QuickPoseView) with
the `fitness.pushUps` feature. Results are written by
`submit_verification_session()` (migration `20260903000000`), a SECURITY
DEFINER function, because `verification_sessions` and `match_participants`
both have RLS enabled with no client INSERT/UPDATE policy — same rule as
`join_challenge()`: nothing that decides a match outcome is a direct client
write. It records the rep count onto `match_participants.rep_count`, stores
raw telemetry as JSON, and rejects a second submission for the same
participant (otherwise a user could retry until they liked their score).

**The trust boundary is the important part.** The function verifies *who*
is submitting; it cannot verify *what*. QuickPose returns a 0–1 pose
probability per frame — it does not count reps. Rep counting is
`QuickPoseThresholdCounter` running in JS **on the user's own device**, so
a modified client can submit any number. `anomaly_flag` is likewise
computed client-side. For a points-only v1 that's an acceptable trade, but
it is not sufficient once money is involved — that needs the capture
re-scored somewhere the user doesn't control (server-side re-analysis of
uploaded video, or device attestation at minimum).

There is also **no anti-cheat API in QuickPose to surface**. What exists is
`feedbacks` (form-guidance strings) and `fps`. Partial reps are rejected
implicitly by the counter's hysteresis (probability must cross 0.6, then
fall below 0.3). The `anomaly_flag` heuristics are therefore ours, not the
SDK's, and are recorded in `raw_metrics.anomalyReasons` so it's clear which
tripped: implausibly fast reps (<500ms), body out of frame (>20% of
frames), or mean FPS <15. Feedback strings are tallied into `raw_metrics`
rather than discarded, but don't by themselves set the flag.

Requires `QUICKPOSE_SDK_KEY` in `.env` (free key at dev.quickpose.ai) and a
physical device (iOS 15+ / Android SDK 26+). Settlement is still not built:
no winner is chosen and no points move when a result is recorded.

### Patched upstream bug: iOS build failure on `.skipping`

`patches/@quickpose+react-native+0.7.1.patch`, applied automatically by the
`postinstall` script (`patch-package`). Same reasoning as
`src/types/quickpose-shims.d.ts`: fix upstream breakage without editing
`node_modules` in a way that a fresh `npm install` would silently undo.

**Symptom:** EAS iOS build fails in the Xcode step with
`reference to member 'skipping' cannot be resolved without a contextual type`
at `QuickPoseView.swift:301`.

**Cause:** the iOS bridge maps `"skipping"` to `QuickPose.FitnessFeature.skipping`,
but that case does not exist in the iOS SDK. Verified against
`QuickPoseCore.xcframework`'s `arm64-apple-ios.swiftinterface`, which
publishes 27 `FitnessFeature` cases — none named `skipping`. Only 1.6.0 and
1.7.0 are published to CocoaPods trunk, and neither has it. The Android SDK
*does* have `FitnessFeature.Skipping`, which is why only iOS fails to
compile, and why the TS type still offers `'skipping'` as a valid exercise.
This is an upstream bug in `@quickpose/react-native` 0.7.x, present in the
latest published version (0.7.1), with no issue filed upstream.

Swift's error message is misleading: "cannot be resolved without a
contextual type" is what it reports when the member doesn't exist on the
inferred type. Writing the full type name (`QuickPose.FitnessFeature.skipping`)
does **not** fix it — it just becomes "type has no member".

**Fix:** `case "skipping": return nil`, so requesting `fitness.skipping`
becomes a no-op feature on iOS instead of a build failure. Everything else
in the bridge was cross-checked against the swiftinterface; `skipping` was
the only referenced member the SDK lacks. Drop the patch if the iOS SDK
ever adds the case.

**Two things to know about this patch:**
- `patch-package` must stay installed on EAS for `postinstall` to work. It's
  a devDependency, so don't build with `--omit=dev` / `NODE_ENV=production`
  at install time. `eas.json` currently sets no `env` block and no install
  flags on any profile, so this is fine as it stands — but it's one line
  away from silently breaking. Guarded by `scripts/verify-native-patches.js`
  (below) rather than left to vigilance.
- `quickpose-react-native.podspec` declares `s.dependency "QuickPoseCore"`
  with **no version constraint**, so CocoaPods resolves whatever is newest.
  A future QuickPoseCore release could break the build again with nothing
  changed on our side. **`ios/Podfile.lock` does not exist yet** — no
  `pod install` has ever run (this project is developed on Windows, where
  CocoaPods isn't available), so every EAS build currently resolves pods
  fresh. Generate it on a Mac (`cd ios && pod install`) or pull it from an
  EAS build's artifacts, then commit it; `.gitignore` only excludes
  `**/Pods/`, so the lockfile itself is safe to commit. Upstream pins pods
  this way in their own example app.

**Install-time guard.** `postinstall` is
`patch-package --error-on-fail && node scripts/verify-native-patches.js`.
The flag alone isn't enough: if `patches/` is missing entirely,
patch-package prints "No patch files found" and exits **0** (it's an early
return, not a failure), so the install looks clean and the build fails much
later in Xcode with a Swift error that looks unrelated. The script asserts
the patched bytes are actually present in `node_modules`, which is the only
check that really guarantees it. Verified by deleting `patches/` and
reinstalling: `npm install` exits 1 with an explanatory message instead of
succeeding quietly.

Note: `patch-package` cannot *create* patches on Windows here — it spawns
bare `npm`, which modern Node won't resolve to `npm.cmd`, failing with an
empty error. Applying patches works fine on all platforms. To regenerate,
either use macOS/Linux/WSL or hand-write the diff with paths relative to the
**project root** (`a/node_modules/@quickpose/react-native/...`), not the
package root — patch-package applies effects with cwd set to the project
root.

## Migration status: applied

The migration was applied 2026-09-02 via `prisma migrate deploy` against
the live project (`bxfonvtmhxjcnmjhcsls.supabase.co`). `prisma/.env` and
`.env` are both filled in. Verified independently afterward (introspection
+ catalog queries, not just "the command exited 0"): `signups` and all of
Supabase's real `auth.*` tables are untouched, all six new tables exist,
all 9 RLS policies exist, and both `join_challenge`/`grant_starter_bonus`
exist. `npx prisma migrate status` reports the schema up to date.

The "baseline before running anything" concern this section used to lead
with turned out to be a non-issue in practice: `migrate deploy` (unlike
`migrate dev`) never compares against `_prisma_migrations` history for
drift — it just applies whatever local migration files aren't yet marked
applied in that database, and ignores any other apps' entries in that same
table. No `migrate resolve` step was needed.

**⚠️ Never run `prisma db push` or `prisma migrate dev` against this
database.** Both compute a live diff between `schema.prisma` and the real
database and then *apply* it — unlike `migrate deploy`, which only ever
replays the literal SQL already sitting in `prisma/migrations`. A dry run
of that diff (`prisma migrate diff --from-config-datasource --to-schema
prisma/schema.prisma --script`, safe — it only prints) showed exactly what
this means in practice: with an earlier version of `schema.prisma` that
declared `schemas = ["public", "auth"]` (multiSchema, to type the FK to
`auth.users`), the diff computed `DROP TABLE`/`DROP COLUMN` for nearly all
of Supabase's real `auth.*` tables — because Prisma treats any schema
listed under `schemas` as fully owned by the project for diffing, and
anything not modeled becomes a drop candidate. That version of the schema
was never applied. The fix, now in place: `schema.prisma` no longer
declares `auth` at all — `user_id`/`created_by`/`winner_id` are plain
`@db.Uuid` columns with no Prisma-level relation, while the real foreign
key to `auth.users(id)` still exists as hand-written raw SQL in the
migration file. Even with that fixed, the *same* diff still shows `DROP
TABLE "signups"` — because it's an unmanaged table sitting in the same
`public` schema this project's `schema.prisma` doesn't mention. That's not
fixable by modeling more tables (this project should never touch
`signups`'s definition); it's inherent to two independent Prisma projects
sharing one schema. `migrate deploy` is the only command that's immune to
it, which is why it's the only one used here or documented below.

If a future migration needs to be added:
1. Hand-write the new `migration.sql` in a new
   `prisma/migrations/<timestamp>_<name>/` folder (or use
   `prisma migrate dev --create-only` in a **local/throwaway** database,
   never pointed at this shared one, then copy the resulting SQL over).
2. Sanity-check it with the read-only diff command above if you want a
   second opinion on what changed — it's safe to run any time, it never
   applies anything.
3. Review the SQL, then `npm run db:deploy` (`prisma migrate deploy`).

Prisma's install scripts (`prisma`/`@prisma/engines` pre/postinstall) were
blocked by this environment's npm script allowlist and were approved with
`npm install-scripts approve prisma @prisma/engines` — needed once per
machine before the CLI's engine binaries will be present.

## Directory map (backend-relevant parts)

- `prisma/schema.prisma` — the six new models. Deliberately does not model
  `auth` at all (see "Migration status" above) — user references are plain
  `@db.Uuid` columns.
- `prisma/migrations/20260902000000_add_fittr_challenge_models/migration.sql`
  — tables, RLS policies, `join_challenge()`, `grant_starter_bonus()`.
- `prisma.config.ts` — points Prisma CLI at `prisma/.env`'s `DIRECT_URL`.
- `src/lib/supabase.ts` — the only client the app runtime talks to Postgres
  through.
- `src/types/database.ts` — hand-kept mirror of the schema in the
  snake_case shape PostgREST actually returns (not Prisma's camelCase
  client types, which the app never imports).
