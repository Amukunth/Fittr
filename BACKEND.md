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

## Realtime: live match notifications

`join_challenge()` is called by the *joiner*, so nothing on the *creator's*
device knows a Match now exists. Before this was wired, both sides were
served by `useFocusEffect` refetches only: the joiner had to tap a second
"Go to Match" button, and the creator found out whenever they next happened
to navigate. The fix is Supabase Realtime on two tables, added to the
`supabase_realtime` publication by
`prisma/migrations/20260903100000_enable_realtime/migration.sql`.

**That publication ships EMPTY.** Postgres changes are only broadcast for
tables explicitly added to it, so subscription code against a table that
isn't a member connects, reports `SUBSCRIBED`, and then silently never
fires. That failure mode looks exactly like a client bug; check publication
membership first.

Who subscribes to what:

| Screen / component | Channel | Subscription |
| --- | --- | --- |
| `MatchFoundWatcher` (app-level, inside `NavigationContainer`) | `match-watch:<uid>` | `challenges` UPDATE, `created_by=eq.<uid>` |
| `HomeScreen` | `home-open-challenges` | `challenges` INSERT + UPDATE, unfiltered |
| `ChallengeDetailScreen` | `challenge-detail:<challengeId>` | `challenges` UPDATE, `id=eq.<challengeId>` |
| `ProfileScreen` | `fitness-profile:<uid>` | `fitness_profiles` UPDATE, `user_id=eq.<uid>` |

`MatchFoundWatcher` is mounted as a sibling of the navigator rather than on
a screen, because the creator can be anywhere when the accept lands; it
reaches navigation through `src/lib/navigationRef.ts`. It auto-navigates,
except on `MatchInProgress` (a live camera capture — navigating away would
destroy an in-flight set and its unsaved rep count) and `Results`, where it
shows a dismissible banner instead.

Every subscription tears down with `supabase.removeChannel(channel)`, not
just `unsubscribe()`, so the topic name is released for remount.

### Known limitation: no catch-up on resubscribe

**This is deliberate, not an oversight.** Realtime delivers only what
happens while the socket is actually connected. There is no replay on
resubscribe, and none of the subscriptions above run a catch-up query when
they reconnect. Consequences:

- A creator whose app is backgrounded (or offline, or on a dropped socket)
  when someone accepts their challenge is **not** notified on resume. They
  find out on the next `useFocusEffect` refetch — i.e. the next time they
  navigate to Home or the challenge — not instantly.
- The `useFocusEffect` refetches were kept alongside realtime for exactly
  this reason. They are not redundant: they are the resync path for the
  window in which live events were *missed* rather than merely late.

A catch-up query on `SUBSCRIBED` was considered and rejected: for
`MatchFoundWatcher` it would mean querying for already-`matched` challenges
on every app launch and then auto-navigating the creator into an old match
they'd already played. Correcting for that needs "has this user been
notified about this match yet" state that doesn't exist in the schema.

**The real fix is push notifications** (APNs/FCM via a Supabase Edge
Function or database webhook on the `challenges` status transition), which
is the only mechanism that reaches a backgrounded or killed app at all.
That's out of scope for now — it needs credentials, native config, and a
server-side trigger, none of which exist in this project yet. Realtime
covers the foreground case, which is the one that made the feature feel
broken.

## Settlement and multi-exercise verification

`settle_match(uuid)` (migration `20260903300000_add_match_settlement`) is the
only thing that writes `matches.winner_id` / `matches.settled_at` or moves a
challenge past `matched`. Before it existed, nothing did — both columns were
dead, `challenges.status` never left `matched`, and ResultsScreen was
unreachable because ChallengeDetail gated it on `status = 'completed'`.

**Winner rules** — pushups: higher `rep_count`. plank/wallsit: higher
`hold_duration_seconds`. race: raises; `time_seconds` is lower-is-better and
nothing produces it yet, so it guesses nothing.

**Tie rule (explicit):** nobody wins, each side is refunded exactly their own
stake, `winner_id` stays NULL and `settled_at` IS set. A tie is a completed
match, not an unsettled one. ResultsScreen special-cases this: reading
`winner_id === me` alone would render a tie as "You lost".

**Payout arithmetic:** both sides were already debited by `join_challenge()`,
so the pot is `2 * stake_points` and all of it goes to the winner as one
`payout` entry. Winner nets `+stake`, loser nets `-stake`. The loser's stake is
never touched twice.

**Anomaly gate:** if the session that *decides* the outcome is flagged and not
yet reviewed, nothing is paid, `settled_at` stays NULL, and the challenge goes
to `needs_review`. For a decisive result that is the winner's session only (a
flagged loser cannot pay themselves by losing); for a tie, either side blocks.
The gate tests `anomaly_flag AND NOT reviewed`, which is what gives
`verification_sessions.reviewed` a purpose: a service-role reviewer sets it,
then `settle_match()` runs again and pays out normally. There is no client
policy on that column, by design.

**Where it runs from:** inline at the end of `submit_verification_session()`,
in the same transaction, so the match settles the instant the second result
lands without any client involvement. A client that submits and then dies
cannot strand a match. ResultsScreen also calls it once per mount as a safety
net for matches predating this work. It is idempotent — the `settled_at` guard
plus `SELECT ... FOR UPDATE` on `matches` is what makes concurrent settlement
safe: two simultaneous submitters serialize on that row lock, and whichever
gets it second sees both sessions.

### Exercise types and the wall-sit proxy

MatchInProgress drives all three scorable types from one `EXERCISES` config
table — only the QuickPose feature string and whether the signal is *counted*
or *timed* differ. Hold duration is accumulated by `src/lib/holdTracker.ts`
(`QuickPoseHoldTracker`), which deliberately mirrors the SDK's
`QuickPoseThresholdCounter` — same 0.6/0.3 hysteresis, same call style — because
that class is a rep counter (`poseComplete(count + 1)`) and has no notion of
elapsed time.

| type | feature | mode | verified? |
| --- | --- | --- | --- |
| pushups | `fitness.pushUps` | reps | pre-existing |
| plank | `fitness.plank` | hold | feature string confirmed in `parseFeature.ts` |
| wallsit | `fitness.squats` | hold | **PROXY — see below** |

**⚠️ QuickPose 0.7.1 has no wall-sit feature.** `FITNESS_EXERCISES` in
`parseFeature.ts` lists 28 exercises and none is a wall sit, in any spelling;
`parseFeatureString('fitness.wallSit')` returns `null`, which means the feature
is *silently dropped* — no error, no result key, a permanent score of zero. A
wall sit is a held bottom-of-squat, so `fitness.squats` is used as the closest
available proxy. **This is unverified on a real device:** the squat model may
not score a static, wall-braced hold above the 0.6 enter threshold. If it
doesn't, swap the feature string in `EXERCISES.wallsit` (`fitness.sumoSquats`
is the next candidate) or block wallsit the way race is blocked. Nothing else
needs to change. `raw_metrics.source.featureIsProxy` records this on every
wall-sit session so a reviewer is not misled about what was measured.

**Alternative investigated and rejected: `rangeOfMotion.knee` / `rangeOfMotion.hip`.**
These exist (`ROM_JOINTS` in `parseFeature.ts` includes `knee` and `hip`), so
they were a real candidate — a wall sit is definable as "knee and hip angle
both held near ~90°". Checked against the vendor's own docs rather than
assumed, same as everything else in this file:
[docs.quickpose.ai/.../Range Of Motion/Knee](https://docs.quickpose.ai/docs/MobileSDK/Features/Range%20Of%20Motion/Knee)
and the sibling Hip page both give a `Reading: \(String(format:"%.0f°",score))`
example — confirming the result `value` for a ROM feature is a **live angle in
degrees**, not the 0..1 probability every `fitness.*` feature (pushups, plank,
the squats proxy) returns. Two consequences:

1. It cannot plug into `QuickPoseHoldTracker` as built. That class's
   enter/exit hysteresis assumes "higher = more in position" (`value >
   enterThreshold` enters, `value < exitThreshold` exits) — the right shape
   for a probability, wrong for "is the angle inside a target band". Making
   ROM work would mean a second, range-containment comparison, not a reuse of
   the existing one.
2. There is no vendor-documented target angle for anything, let alone a wall
   sit specifically — the Hip page's only worked example is "raise your leg
   to the side," unrelated. A threshold here would be entirely invented, with
   no trained-model backing, versus `fitness.squats`, which is at least a real
   classifier the vendor trained (whether it responds to a *static* wall-brace
   hold the way it does to an active squat rep is the part still unverified).
3. The docs' own idiom for reading a ROM value —
   `QuickPoseDoubleUnchangedDetector`, which waits for a reading to *stabilize*
   for ~2 seconds before accepting it — is built for "capture one peak
   measurement" (a physio-style ROM assessment), not "sustain a position for
   an open-ended duration." It's also Swift/Kotlin-only:
   `grep -rn -i "unchanged" node_modules/@quickpose/react-native/{src,ios,android}`
   finds nothing, so it isn't reachable from this RN bridge at all.

Net: technically wireable, but weaker on every axis than the squats proxy
already in place. Left as `fitness.squats` unless on-device testing rules that
out too.

Hold anomaly heuristics differ from the rep ones because the cheat differs: a
propped-up phone aimed at a photo holds "perfect form" forever, so the flags
are `implausiblyLongHold` (>10 min) and `fragmentedHold` (majority of segments
under 750ms, i.e. threshold jitter banked as real time), alongside the shared
`leftFrameTooOften` / `trackingTooPoor`.

Everything the original verification note said about trust still holds: this
verifies WHO submits, never WHAT they submit. Hold duration is accumulated
on-device in JS exactly like rep count, so it is equally self-reported.

## RLS: the participant-policy recursion bug (fixed 2026-09-04)

Until migration `20260904000000_fix_participant_rls_recursion`, **every
client read of `matches` or `match_participants` failed** with
`infinite recursion detected in policy for relation "match_participants"`.
Reproduced against the live database with `SET ROLE authenticated; SELECT
count(*) FROM match_participants;` (and the same on `matches`);
`challenges` read fine as a control.

**Cause.** `match_participants_select_participant` answered "is the caller
in this match" with an `EXISTS` subquery against `match_participants` — the
table the policy is on. Postgres applies RLS to every table a policy
references, so evaluating the policy re-entered itself, and the rewriter
rejects that at plan time before it looks at any rows. The
`user_id = auth.uid() OR ...` short-circuit is irrelevant: the failure is
structural, not data-dependent. `matches_select_participant` subqueried into
`match_participants` too, so it inherited the error.

**Why it looked like "Accept does nothing".** Every *write* in the flow is a
`SECURITY DEFINER` function and bypasses RLS, so `join_challenge()` happily
created the match and flipped the challenge to `matched` — and then the app
could never read the match it had just created. `ChallengeDetailScreen.load()`
discarded the `matches` error, so `match` stayed null and the Go to Match
button (gated on it) never rendered; `MatchFoundWatcher` returned silently on
the same error, so the creator was never navigated either. Both call sites
now surface the error (a message on ChallengeDetail, a `console.warn` in the
watcher) so a policy regression can't hide the same way again.

**Fix.** `public.is_match_participant(uuid)` — a `STABLE SECURITY DEFINER`
SQL function — does the membership lookup as the table owner, so RLS is not
re-applied inside it, and both policies now call it instead of subquerying.
Postgres never inlines `SECURITY DEFINER` SQL functions, so the planner
cannot fold it back into the recursion. Semantics are unchanged: a
participant sees the match and every participant row in it.
`verification_sessions_select_own` was left as-is — it references
`match_participants`, not itself, and with that table's policy no longer
self-referential there is no cycle left for it to fall into. Verified after
deploy: all three tables now read cleanly as `authenticated`.

**Rule going forward:** an RLS policy must never query the table it is on.
If a policy needs "is the caller a member of X", put that lookup in a
`SECURITY DEFINER` helper the way `is_match_participant` does.

## Migration status: applied

The original migration was applied 2026-09-02 via `prisma migrate deploy`
against the live project (`bxfonvtmhxjcnmjhcsls.supabase.co`). `prisma/.env`
and `.env` are both filled in. Verified independently afterward
(introspection + catalog queries, not just "the command exited 0"):
`signups` and all of Supabase's real `auth.*` tables are untouched, all six
new tables exist, all 9 RLS policies exist, and both
`join_challenge`/`grant_starter_bonus` exist. `npx prisma migrate status`
reports the schema up to date.

The three later migrations (`enable_realtime`, `add_needs_review_status`,
`add_match_settlement`) were deployed 2026-09-03, also via `migrate deploy`.
Confirmed applied from the CLI's own output — 5 migrations found, all
showing as successfully applied. Publication membership was later confirmed
directly from `pg_publication_tables` on 2026-09-04 (`challenges,
fitness_profiles`), so the realtime migration did take effect. `settle_match()`
and `needs_review` remain unverified by independent introspection; if they
misbehave, that (rather than a code bug) is the first thing to rule out.

`20260904000000_fix_participant_rls_recursion` was deployed 2026-09-04 via
`migrate deploy` and verified afterward by re-running the failing
`SET ROLE authenticated` reads — see the RLS section above.

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
- `prisma/migrations/20260903100000_enable_realtime/migration.sql` — adds
  `challenges` and `fitness_profiles` to the `supabase_realtime`
  publication. See "Realtime" above.
- `prisma/migrations/20260903200000_add_needs_review_status/migration.sql` —
  one `ALTER TYPE ... ADD VALUE`, alone in its own migration on purpose.
- `prisma/migrations/20260903300000_add_match_settlement/migration.sql` —
  `settle_match()`, and `submit_verification_session()` extended to accept
  hold duration. See "Settlement" above.
- `prisma/migrations/20260904000000_fix_participant_rls_recursion/migration.sql`
  — `is_match_participant()` and the rewritten `matches` /
  `match_participants` SELECT policies. See "RLS: the participant-policy
  recursion bug" above.
- `prisma.config.ts` — points Prisma CLI at `prisma/.env`'s `DIRECT_URL`.
- `src/lib/supabase.ts` — the only client the app runtime talks to Postgres
  through.
- `src/types/database.ts` — hand-kept mirror of the schema in the
  snake_case shape PostgREST actually returns (not Prisma's camelCase
  client types, which the app never imports).
- `src/components/MatchFoundWatcher.tsx` — app-level "your challenge was
  accepted" subscriber. Mounted once inside `NavigationContainer`.
- `src/lib/navigationRef.ts` — navigation handle for that watcher, which
  has no `navigation` prop of its own.
- `src/lib/holdTracker.ts` — `QuickPoseHoldTracker`, the hold-duration
  analogue of the SDK's rep counter. Unit-tested in
  `__tests__/holdTracker.test.ts`; it takes an injected clock precisely so it
  can be verified without a device.
