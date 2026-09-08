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
4. ~~**Pooled vs. 1v1 have identical backend mechanics in v1.**~~
   **Superseded on 2026-09-08** by "Live matchmaking" below. A challenge is
   no longer an offer anyone browses: it is a lobby the matchmaking queue
   fills, `max_participants` exists, and a Group Battle really does seat
   3–6 fighters in one `Match`. `join_challenge()` is dropped.
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
| `SearchingScreen` | `searching:<uid>` | `matchmaking_queue` UPDATE, `user_id=eq.<uid>` |
| `HomeScreen` | `home-in-the-ring` | `challenges` UPDATE, `id=in.(<my live bouts>)` |
| `ResultsScreen` | `results:<challengeId>` | `challenges` UPDATE, `id=eq.<challengeId>` |
| `ProfileScreen` | `fitness-profile:<uid>` | `fitness_profiles` UPDATE, `user_id=eq.<uid>` |

The first two rows changed on 2026-09-08; see "Live matchmaking" below.
`MatchFoundWatcher` (an app-level "your challenge was accepted" banner
mounted beside the navigator) and `src/lib/navigationRef.ts` were deleted
with it: a fighter waiting for a bout is now always on the Searching
screen, which owns its own subscription, so there is nothing left to
announce from outside the navigator.

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

A catch-up query on `SUBSCRIBED` was considered and rejected for the old
`MatchFoundWatcher`: it would have meant querying for already-`matched`
challenges on every app launch and then auto-navigating the creator into an
old match they'd already played. **The matchmaking queue does have a
catch-up path**, because a queue entry is explicit state with a clear
lifetime: `matchmaking_heartbeat()` returns the caller's row, so every
missed event converges within one 5-second beat. See "Live matchmaking".

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
- `prisma/migrations/20260908000000_live_matchmaking_queue/migration.sql` —
  the queue, its three entry points, N-seat settlement. See "Live
  matchmaking" below. (`src/components/MatchFoundWatcher.tsx` and
  `src/lib/navigationRef.ts` were deleted here.)
- `src/lib/matchmaking.ts` — the client half of the queue: the three RPC
  wrappers, the tunables mirrored from the migration, and the error copy.
- `src/screens/SearchingScreen.tsx` — the live queue screen.
- `test/dbHarness.ts`, `test/pgServer.mjs` — embedded Postgres for
  `__tests__/matchmaking.db.test.ts`.
- `src/lib/holdTracker.ts` — `QuickPoseHoldTracker`, the hold-duration
  analogue of the SDK's rep counter. Unit-tested in
  `__tests__/holdTracker.test.ts`; it takes an injected clock precisely so it
  can be verified without a device.

## Settings: profile identity, preferences, devices, deletion (2026-09-07)

Migration `20260907000000_settings_profile`. Everything the Settings screen
writes goes through it; the app never gained new table-level write grants.

- `fitness_profiles` gained `display_name`, `username` (citext, unique,
  `^[a-z0-9][a-z0-9._]{2,19}$`), `avatar_url`, `updated_at`. Usernames were
  backfilled from the sign-up handle in auth metadata (email local part as
  fallback, numeric suffix on collisions). Clients still hold UPDATE on
  `strength_tier` only; identity changes go through
  `update_my_profile(display_name, username, avatar_url)` (NULL = leave,
  '' = clear; raises `username_invalid` / `username_taken` /
  `display_name_invalid` / `avatar_url_invalid`) and
  `username_available(name)` for the live check while typing. The username
  is mirrored into `auth.users.raw_user_meta_data.handle` by the app so
  `ownHandle()` keeps working.
- `user_settings` (one row per user, `notifications` jsonb) and
  `user_devices` (upserted by the app on launch; "sign out other devices"
  is `auth.signOut({scope:'others'})` plus deleting the other rows).
  Supabase has no client API to list sessions, which is why the registry
  exists. Both tables are RLS own-row only.
- Storage bucket `avatars` (public read, 5 MB, jpeg/png/webp) with
  owner-only write inside `<user_id>/`. The bucket block is guarded on the
  `storage` schema existing, so the migration also applies to a plain
  Postgres (the embedded test database).
- `delete_my_account()` erases profile identity, photo, settings and
  devices, then anonymises and bans the auth user and revokes its sessions
  and factors. The `auth.users` row itself stays because completed bouts
  reference it from both sides (`challenges.created_by` is RESTRICT). It
  refuses with `live_bouts` while a matched bout is unsettled.
- Two-factor auth uses Supabase MFA (TOTP) straight from the client:
  `auth.mfa.enroll / challengeAndVerify / unenroll`. Nothing in the
  database changed for it; TOTP must be enabled under Authentication →
  Multi-factor in the dashboard or enrolment returns an error the app
  shows verbatim. `AuthContext.mfaRequired` keeps a password-only (AAL1)
  session on the Login screen's code step until it reaches AAL2.
- Biometric lock is device-local (react-native-keychain, biometry-gated
  secret); nothing server-side.

## Live matchmaking (2026-09-08)

Migration `20260908000000_live_matchmaking_queue`. This **replaces**
browse-and-accept rather than sitting beside it. Before: a user posted a
`challenges` row, it appeared on everyone's Home, and whoever tapped Accept
called `join_challenge()`. Now: a user picks exercise, format and stake, taps
Find a Bout, and the server either seats them in a lobby that is already
forming or opens one; the instant the last seat fills, every member's queue
row flips to `matched` and their Searching screen walks them into the bout.

**Removed outright** (not deprecated — deleted):

| Gone | Why |
| --- | --- |
| `join_challenge()` | There is no "accept a specific challenge" any more. |
| `challenges_insert_own` + client INSERT/UPDATE/DELETE grants | Lobbies are opened only by `enter_matchmaking()`. |
| `ChallengeDetailScreen`, `CreateChallengeScreen` | Their three jobs (accept, wait, enter a live bout) are now the queue, the Searching screen and Home. |
| `MatchFoundWatcher`, `src/lib/navigationRef.ts` | A waiting fighter is always on Searching, which owns its own subscription. |
| Home's open-challenge list, filter chips and unfiltered subscription | Nothing is browsable. |
| `SEATS = 2` in `theme/copy.ts` | Seats are `challenges.max_participants`. |

**Adapted**: `challenges` gained `max_participants`; `settle_match()` is
generalised to N seats; `delete_my_account()` leaves the queue first;
`MatchInProgress`, `Results`, `boutStats` and `ProfileScreen` now speak of a
field rather than an opponent; Results' Rematch re-enters the queue on the
same terms instead of inserting a challenge; the middle tab is Find.

### The model: a lobby is a challenge

A `challenges` row with `status = 'open'` **is** a forming lobby, and
`matchmaking_queue.challenge_id` points at it. This was chosen over a
separate `lobbies` table because the moment a lobby fills it must become
exactly the thing `matches`, `settle_match()` and every results screen
already expect — one challenge, one match. A separate table would have meant
copying every field across at fill time and keeping two lifecycles in step.

**Nothing is staked while a lobby forms.** Points move only inside
`_mm_try_complete()`, in the same transaction that creates the `Match`. That
is what makes cancelling free: `leave_matchmaking()` is a plain `DELETE` with
no refund path to get wrong, and there is no window in which a balance is
held by a bout that never happened. The balance check at entry is advisory;
the authoritative one is under `FOR UPDATE` at fill time, which is why a
fighter whose balance dropped mid-search is evicted
(`cancel_reason = 'insufficient_points'`) rather than the fill being aborted
for everyone.

### Concurrency: the part that had to be right

The race the brief called out: two fighters enter an empty queue at the same
instant, each looks for a lobby, each sees none because the other's INSERT
has not committed, each opens their own, and they never meet. **No row lock
can prevent this, because there is no row yet to lock.** `SELECT ... FOR
UPDATE SKIP LOCKED` alone makes it *worse*: a lobby that is momentarily
locked gets skipped and a duplicate is opened, which is the same miss.

The design is therefore:

1. **A transaction-scoped advisory lock per matchable domain.** The domain is
   `(exercise_type, format, max_participants)` —
   `pg_advisory_xact_lock(hashtext('matchmaking:...'))`. Stake and tier
   compatibility both live *inside* a domain, so serialising the domain
   serialises every pair that could ever match, while different exercises and
   formats proceed in parallel. Transaction-scoped, not session-scoped, so it
   is safe behind Supabase's transaction-mode pooler and cannot leak (a
   session-level lock is exactly the hang this file warns about for
   `prisma migrate`).
2. **Every writer takes it**, not just `enter_matchmaking()`. An earlier
   draft had `leave_matchmaking()` use only a row lock, on the reasoning that
   a leave would serialise behind the matcher. That is wrong, and it was the
   single most valuable thing the design review caught: a leave that starts
   *before* the matcher deadlocks against it (leave holds its own queue row
   and wants the lobby; the matcher holds the lobby and wants the queue
   rows), and when Postgres picks the leave as the deadlock victim **the user
   who pressed Cancel is silently matched and debited**. Both
   `leave_matchmaking()` and `delete_my_account()` now take the domain lock
   before any row lock.
3. **One lock order everywhere**: advisory lock(s) → the lobby's `challenges`
   row → member `matchmaking_queue` rows → `fitness_profiles` **ordered by
   `user_id`**. `settle_match()` locks profiles in the same order, so a
   fighter settling one bout while another fills cannot deadlock. No function
   takes a row lock before its advisory lock; the pre-checks at the top of
   `enter_matchmaking()` are plain reads for exactly this reason.
4. **Two domains when re-entering with a different request.** Changing
   exercise while searching touches the old domain and the new one; the keys
   are taken in ascending numeric order so two users moving in opposite
   directions cannot deadlock. If another device replaced the search into a
   *third* domain in the gap before the locks, the call raises
   `search_in_flight` and the client retries — rarer than the alternative of
   holding three locks.
5. **Status-guarded writes.** Every mutation re-reads the row under the lock
   and is written `WHERE ... AND status = 'searching'`, so a call that read
   `searching` before waiting on the lock can never revive a row that was
   matched or swept while it waited.
6. **`SKIP LOCKED` in exactly one place**: the stale-entry sweep, where a row
   another transaction is touching should be left for the next sweep rather
   than waited on.

`READ COMMITTED` is relied on deliberately: a statement that waits on a
`FOR UPDATE` row re-evaluates its predicate against the committed version
when the lock is granted. That is what makes the cancel-versus-fill race
resolve cleanly — a leave that waited behind a completing matcher sees
`status = 'matched'` and returns the match instead of deleting the row. The
client treats that as "too late, it's on" and walks the user into the bout,
because their stake has already moved.

### Stale entries: a 20-second TTL with a 5-second heartbeat

**The choice.** The client beats every 5 s; an entry with no beat for 20 s is
swept to `cancelled`/`expired`. Twenty seconds is four missed beats: long
enough to ride out a cell handover, short enough that a killed app is not
offered to a real opponent for long. The alternative — a scheduled sweep via
`pg_cron` — was rejected because this project has no cron and because
sweeping on traffic is strictly better here: the queue is cleaned in the same
transaction as the read that is about to use it, so a newcomer can never be
paired with a ghost. The cost is that a quiet domain is not swept until
someone arrives, which is harmless (nobody is reading it) but does make "was
I expired?" depend on strangers' activity. The client closes that gap
deterministically: on returning to the foreground, if more than the TTL has
passed since the last successful beat, it ends the search locally rather than
waiting to find out.

**Heartbeats are not realtime events.** `last_seen_at` lives in a separate
`matchmaking_presence` table that is *not* in the `supabase_realtime`
publication. Had it been a column on `matchmaking_queue`, every 5-second beat
from every searching user would have been a WAL event that Realtime must
filter-check against every subscriber — N searchers producing N/5 events per
second, which at a few hundred users would saturate the project's Realtime
quota and delay the one event that matters. With presence split out, **every
UPDATE on a queue row means something actually changed** (the status, or the
lobby size).

**iOS `inactive` does not pause the heartbeat.** Only `background` does. A
notification shade, the app switcher or an incoming-call banner leaves JS
running and the user still expects to be found; `BiometricGate` already
encodes the same distinction. Beats fire on a fixed interval without awaiting
each other, each with its own 8-second timeout, so one stalled request cannot
silently consume the TTL.

**The heartbeat is also the catch-up path.** It returns the caller's row as
the server sees it, so a `matched` event missed while the socket was down
arrives within one beat. That is what makes the Realtime subscription an
optimisation rather than a correctness requirement — which matters, because
Realtime has no replay.

### Tier widening

A lobby starts same-tier. After **45 seconds** it may pair one tier apart —
never two, so a beginner never meets an advanced fighter. Two judgment calls:

- **Symmetric.** Both the lobby *and* the arriving fighter must have waited
  45 s. An earlier draft gated only on the lobby's age, which meant a
  beginner who tapped Find could be dropped into a 46-second-old intermediate
  lobby having waited zero seconds, without being told. Now a newcomer always
  forms their own lobby first and is moved into a neighbouring one by their
  own heartbeat once they too have waited. The Searching screen says so up
  front ("After 45s we also look one tier either side") and changes its copy
  once widened.
- **Pairwise, not lobby-wide.** Admission checks the caller against *every*
  current member, so a group cannot accumulate a beginner and an advanced
  fighter by admitting each of them next to an intermediate. Tier is the
  snapshot taken at entry (`matchmaking_queue.strength_tier`), not the live
  profile, because clients can change `fitness_profiles.strength_tier` at any
  time through the existing column grant.

### Settlement for N seats

Same rules, stated for a field:

- Everyone must have submitted, else `not_ready`.
- Best score takes the whole pot (`stake * seats`) → `settled`.
- Fighters tied for best split it; `winner_id` stays NULL. Everyone tied →
  `tie_refunded` (each gets their stake back — with two seats that is exactly
  the old tie). Some tied, some not → **`tie_split`**, a new return value.
- **The remainder rule.** Integer points do not always divide: a 4-seat
  50-point bout is a pot of 200, and three tied fighters get 66 each with 2
  left over. Those 2 go to the tied fighter with the lowest `user_id`, folded
  into their single payout row. It is arbitrary but deterministic, and the
  alternative (points evaporating) breaks the zero-sum property the ledger
  depends on. Remainders only occur at 4 and 5 seats with 3-4 tied; a 1v1
  always divides evenly, so its ledger rows are byte-identical to before.
- The anomaly gate is unchanged in spirit: if **any** fighter in the winning
  set has an unreviewed flag, nothing is paid and the bout goes to
  `needs_review`. A flagged loser still cannot manufacture a payout.

**`winner_id` alone can no longer classify an outcome, and this is the
subtlest consequence of the whole change.** With three seats where two tie
for first, `winner_id` is NULL for everybody — including the fighter who lost
their stake. Reading `winner_id === null` as "tie, stakes refunded" would
have shown that fighter "DEAD HEAT · 0 PTS" while their balance fell by 100,
and recorded a T for all three. `boutStats.outcomeOf()` therefore decides
from the caller's own ledger net for that match: paid more than `-stake`
means they shared the pot. RLS already scopes the ledger to the caller's own
rows, so this needs no new read. Unit-tested in `__tests__/boutStats.test.ts`.

### Security and visibility

- **`matchmaking_queue` has no client write path at all.** `REVOKE ALL`, then
  `GRANT SELECT` back; RLS is select-own. Every mutation is one of the three
  SECURITY DEFINER functions. `matchmaking_presence` is not client-readable
  either.
- **Open lobbies are private.** `challenges_select_all` (any signed-in user
  reads any challenge) was right when an open challenge was a public offer. A
  lobby is presence data — who is searching, at what stake, right now — so
  the policy is now `status <> 'open' OR is_lobby_member(id)`. Matched and
  settled challenges stay readable, which Home, Results and the realtime
  subscriptions need. `is_lobby_member()` is a SECURITY DEFINER helper, per
  the rule from the 2026-09-04 recursion bug that a policy must never query a
  table with a policy on it.
- **Default replica identity on `matchmaking_queue`, deliberately** — unlike
  `challenges`, which is FULL. Realtime cannot apply RLS to DELETE events;
  with FULL identity every cancel would broadcast the whole old row (user id,
  tier, stake) to any subscriber whose filter matched it. With the default, a
  DELETE carries only the primary key. Nothing here reads `payload.old`.
- **Parameters are validated, not trusted.** Stake must be one of the four
  offered values (an off-preset stake would otherwise form a private domain
  no honest client could reach); seats must agree with the format; the
  exercise must be one camera verification supports. All are also CHECK
  constraints, as defence behind the SECURITY DEFINER boundary.
- **`settle_match()`'s back-office path now requires
  `auth.role() = 'service_role'`** instead of inferring it from a NULL uid.
  Supabase grants EXECUTE on public functions to `anon` by default and the
  anon key ships inside the app bundle, so "no uid" was not the same thing as
  "service role". Every new function is `REVOKE`d from PUBLIC and `anon`
  explicitly.
- **Re-entry closes the old row rather than deleting it**
  (`cancel_reason = 'replaced'`), so a second device watching that row gets an
  UPDATE telling it why its search ended. Filtered subscribers never see
  DELETEs.
- **A 3-second re-entry floor** bounds how fast one modified client can churn
  a domain's lobbies under the shared lock, and the heartbeat only takes the
  domain lock when there is actually something to sweep or a widening move to
  try.

### The Searching screen

Order of operations, each step earned:

1. **Subscribe before entering the queue**, with
   `postgres_changes_options: { wait: true }` so `SUBSCRIBED` means the
   server's postgres_changes subscription is really established. Without
   `wait`, the callback fires when the *channel* joins, which can precede the
   replication side listening — leaving a window where the lobby fills and
   the event is never delivered.
2. **`enter_matchmaking()` runs exactly once.** `SUBSCRIBED` fires again on
   every socket rejoin; a literal "on SUBSCRIBED, enter" would re-enter the
   queue after each Wi-Fi handover, losing the lobby seat and resetting the
   widening clock. A rejoin calls the heartbeat instead.
3. **Events are keyed by row id**, not just status. A user owns several queue
   rows inside the 10-minute retention window and an old one can still emit
   an UPDATE. An event that arrives before the enter RPC has returned the id
   is parked and replayed once it is known.
4. **`matched` is applied once**, guarded by a ref, because the same
   transition can arrive by all three routes (the RPC return, the realtime
   event, a heartbeat). The 3-second countdown is local theatre, not a
   synchronised start — `MatchInProgress` is self-paced, so participants
   landing a second apart costs nothing.
5. **Every exit goes through `beforeRemove`**: cancel button, close circle
   and the hardware back button all ask the server to leave, and if it
   answers `matched` the user is taken into the bout instead of popped. The
   route also sets `gestureEnabled: false`, because a swipe that begins the
   pop before the RPC answers would defeat this. An enter that resolves after
   unmount immediately leaves again, so a row nobody is watching never sits
   in the queue looking available.
6. **`CHANNEL_ERROR` / `TIMED_OUT` are logged loudly.** A table missing from
   the publication reports exactly like this, and the heartbeat would
   otherwise mask it as mere slowness — the failure mode this file has warned
   about since the realtime migration.
7. **A client-side 30-second give-up (2026-09-08).** `SEARCH_TIMEOUT_SECONDS`
   in `SearchingScreen.tsx` — not a server concept, the queue row itself is
   untouched by it. If 30s of wall-clock elapse in the `searching` phase with
   no match, the screen calls `leave_matchmaking()` (the same path Cancel
   uses) and shows the search-ended page with a "no fighters found" message
   and a Search Again button, rather than waiting on the server's 20s TTL /
   45s tier-widen cycle indefinitely. Guarded the same way as every other
   transition here: if the lobby fills in the same instant the timeout fires,
   `leave_matchmaking()` answers `matched` and the fighter goes into the bout
   instead of seeing "no fighters found" for a bout they're actually in.

### Home, reworked — flagged as a product decision

**This is a real product decision, not an implementation detail, and it was
made without being able to ask.** Home was a marketplace; with browsing gone
it needed a new job. It now shows, top to bottom:

1. A hero card with the single primary CTA, **Find a Bout**.
2. **In the ring** — the user's unsettled bouts, each showing whether their
   round is still open or how many opponents are outstanding. Tapping goes to
   the camera or to Results depending on whether they have fought.
3. **Recent** — their last six settled results, tappable through to Results.

The reasoning: the two things a fighter can act on are "start something" and
"finish what you started", and the queue makes the first one tap rather than
a browse. Rank, streak and full history stay on Profile so Home does not
become a second profile. **If the intent was to keep a social or spectator
surface** (open lobbies, who is searching, a leaderboard), that is a
different Home and worth saying so — note that showing other people's lobbies
now also conflicts with the privacy policy above.

Two related product decisions, both defaults that can be reversed:

- **A fighter with an unplayed round cannot queue again** (`round_open`,
  within 24 hours of the bout). Without it, a user could start bouts and
  abandon them, freezing opponents' stakes. The 24-hour ceiling exists so an
  abandoned bout does not lock them out permanently.
- **Group sizes are 3-6** and a lobby that never fills within 30s gives up
  client-side (see "The Searching screen" above) rather than waiting
  indefinitely. See the limitation below — the queue row itself has no such
  bound.

### Known limitations — decisions deferred, not oversights

- **No forfeit rule.** `settle_match()` returns `not_ready` until every
  participant has submitted, so one fighter who never plays freezes the
  others' stakes and blocks their account deletion (`live_bouts`). This
  existed for 1v1 already, but a six-seat group multiplies both the odds and
  the blast radius. `round_open` bounds the *griefing* case (that account
  cannot queue again for 24 hours) but not the honest dead-phone case. The
  fix is a deadline on `matches` after which non-submitters are forfeited and
  the rest settle — deliberately not invented here, because "forfeit after N
  hours" versus "void and refund" is a product call.
- **An unfilled Group Battle still has no server-side expiry.** With exact
  matching on exercise, format, size, stake and tier, a 6-player 500-point
  lobby may never fill on a small user base. As of 2026-09-08 each fighter's
  own screen gives up after 30s and leaves (see "The Searching screen"), but
  that is a per-viewer client behavior, not a lobby lifetime: a member who
  closes the app without the client running the give-up (or without hitting
  Cancel) still only expires by the 20s TTL once their heartbeats stop, and a
  half-filled lobby with no live viewers can sit until swept. Starting short
  after a timeout, or hard-expiring the lobby row itself, remain unbuilt
  product calls.
- **Stake is never widened**, only tier is. Matching across stakes would need
  a rule for what the pot is.
- **No push notifications.** Unchanged from before: a backgrounded app is not
  reachable, which is why the TTL exists at all.

### ⚠️ What is NOT verified

Everything above typechecks, lints and passes 104 tests.
`__tests__/matchmaking.db.test.ts` runs the real migration SQL against a real
embedded Postgres — including genuinely concurrent connections that race
twelve pairs into an empty queue, eight fighters into four bouts, nine into
two groups of four, and a cancel against a fill ten times over, which
exercises every lock in this file. `__tests__/searching.test.tsx` covers the
half that lives in JS with Supabase faked: that the channel is subscribed
before the queue is entered, that a reconnect heartbeats instead of
re-entering, that `matched` navigates exactly once however it arrives, and
that cancelling into a filled lobby takes the fighter to the bout.

**It does not exercise the wire.** These need two or more real accounts on
real devices racing each other, and cannot be confirmed by reading code:

1. **Two phones tapping Find a Bout in the same instant, through PostgREST.**
   The tests call the SQL functions over `pg` connections with the same
   per-request transaction shape PostgREST uses, but not through PostgREST
   itself, and not with real network jitter between the subscribe and the RPC.
2. **Realtime actually delivering the `matched` UPDATE.** Publication
   membership is added by the migration and RLS is select-own, but "the
   subscription connects, reports SUBSCRIBED, and silently never fires" is
   this project's documented failure mode. Nothing in Jest can catch it. The
   `wait: true` option and the `CHANNEL_ERROR` logging exist to make it loud
   when it happens.
3. **The heartbeat/TTL loop against real backgrounding**, on a real device
   with a real radio: whether 20 seconds is too aggressive on a poor
   connection is an empirical question.
4. **Simultaneous cancel-versus-fill from two devices.** Proven in SQL, not
   through the app's `beforeRemove` path.
5. **A Group Battle actually filling** with 3-6 distinct real accounts, and
   all of them landing in the camera together.

The single highest-value manual test: **two accounts, both on Find a Bout,
same exercise and stake, tapping within a second of each other.** Both should
land in the camera together, each having lost exactly one stake, with one
`matches` row and two `match_participants`.

### Testing: embedded Postgres

`test/dbHarness.ts` boots a real Postgres (`embedded-postgres`, a real server
binary, so plpgsql, advisory locks, `FOR UPDATE` and RLS behave as in
production), shims the parts of Supabase the migrations depend on (the `auth`
schema, `auth.uid()` / `auth.role()`, the three roles and Supabase's default
grants), then replays every file in `prisma/migrations` in order — the same
SQL `prisma migrate deploy` runs against the live project. `asUser()` injects
identity the way PostgREST does, with per-transaction
`request.jwt.claim.sub` / `.role` settings and `SET LOCAL ROLE authenticated`,
so RLS and grants are genuinely enforced.

`__tests__/searching.test.tsx` needs no database: it fakes
`src/lib/supabase` (channel, handler, subscribe callback and rpc) so the
screen's ordering and lifecycle can be driven directly.

The Postgres harness is a restored, trimmed version of the one written for
the (reverted) real-money work; `embedded-postgres`, `pg` and `@types/pg` are
devDependencies, and `@embedded-postgres/windows-x64`'s install script needs
`npm install-scripts approve` once per machine (already recorded in
`package.json`'s `allowScripts`). It runs on the same `npm test` as
everything else; the suite adds ~6 s.

`test/pgServer.mjs` runs the server in its own process because
`embedded-postgres` is ESM and loads its platform binary with a dynamic
`import()`, which Jest's CommonJS runtime refuses.

### Deploy status: NOT deployed

`prisma/migrations/20260908000000_live_matchmaking_queue/migration.sql` has
**not** been applied to the live Supabase project. Neither has
`20260907000000_settings_profile` (written 2026-09-07, still pending). Both
go in the same `npm run db:deploy`, in filename order.

Before deploying, note that the live database currently holds **11
matched-but-unsettled challenges** and 0 open ones (checked read-only on
2026-09-08). The migration's `DELETE FROM challenges WHERE status = 'open'
AND no match` therefore removes nothing today, and `max_participants`
back-fills to 2, so those 11 bouts settle exactly as before. Deploying while
a user still has the *old* build installed would break their app — it would
try to insert challenges it no longer has the grant for — so this migration
and an EAS build should ship together; see the commit → push → build →
install loop in the README.
