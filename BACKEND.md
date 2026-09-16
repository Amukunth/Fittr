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

**Superseded twice since.** `20260908000000_live_matchmaking_queue`
generalised all of the above to N seats (see "Settlement for N seats"), and
`20260909000000_skill_ratings` added the MMR update inside the same function
(see "Skill rating"). The rules in this section still describe how a *winner*
is chosen; the payout and rating details below it are the 2-seat originals.

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

`20260913000000_league_rank` and `20260913000100_rank_backfill_from_settlement`
were deployed 2026-09-13 via `migrate deploy` and verified afterward from
the live database (catalog queries plus a data audit, not the CLI's exit
code). See "Leagues, trophies and the Rank screen" at the end of this file
— including the backfill bug the second migration exists to correct.

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
- `prisma/migrations/20260909000000_skill_ratings/migration.sql` — the
  `skill_ratings` / `skill_rating_events` tables, `rank_tier_for()`, the
  `my_skill_ratings` view, `_mmr_rate_match()`, and the rewrites of
  `settle_match()`, `_mm_find_lobby()`, `enter_matchmaking()` and
  `matchmaking_heartbeat()`. See "Skill rating" below.
- `src/lib/skillRating.ts` — the client half of ratings: the tunables
  mirrored from that migration, the tier labels and colours, and the display
  rules for Profile and Results.
- `src/hooks/useSkillRatings.ts` — reads the `my_skill_ratings` view.
- `prisma/migrations/20260910000000_performance_norms/migration.sql` —
  `performance_norms` / `race_standards` seed tables, `gender`/`age_band`
  on `fitness_profiles`, `_mmr_from_percentile()`,
  `_perf_percentile_from_anchors()`, `_mmr_seed_from_norms()`, the race
  age-grading pipeline, the `_mmr_rate_match()` rewrite that seeds a
  fighter's first rated bout from it, and `update_my_profile()` extended
  with `p_age_band`/`p_gender`. See "Real-world percentile seeding" below.
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

> **Superseded by `20260909000000_skill_ratings` (see "Matchmaking on MMR").**
> `_mm_tier_rank()` and `_mm_tier_widen_after()` no longer exist, and
> `strength_tier` gates nothing. The two judgment calls below — widening is
> symmetric, and admission is pairwise rather than lobby-wide — were both
> carried over verbatim into the MMR window, which is why they are still
> worth reading. Everything else here is history.

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

### `round_open` looked like a broken search (2026-09-08)

**Symptom:** tapping FIND A BOUT ended the search instantly, every time.

**It was not matchmaking.** `matchmaking_queue` was empty and there were zero
open lobbies — `enter_matchmaking()` was raising before it ever inserted a
row. The guard being hit was `round_open`: both test accounts were
participants in two unsettled bouts from the previous 24 hours that had never
been played (no `verification_sessions` row). The client then flipped to the
`error` phase, which rendered "NO BOUT YET." — indistinguishable, to the user,
from a search that ran and found nobody.

Three separate things were wrong, and only the first was the actual bug:

1. **Abandoned test bouts accumulate and block queueing.** This is the "no
   forfeit rule" limitation below, met in practice. Every bout matched during
   testing and then abandoned at the camera step locks both fighters' stakes
   and blocks them both for 24 hours.
2. **The rejection was invisible until after navigation.** FindBout already
   pre-flighted affordability but not open rounds, so a doomed search was the
   only way to discover the block.
3. **The `error` copy claimed a result.** "NO BOUT YET." reads as an outcome
   of searching; the server had refused to search at all.

**Fixes.** FindBout now finds the blocking bout itself — an `active` bout with
`myScore === null` inside `OPEN_ROUND_BLOCKS_FOR_MS` (hand-mirrored from
`_mm_open_round_blocks_for()`) — disables FIND A BOUT, and offers a button
straight into that round. The server stays the authority; this only saves a
trip to a screen that would fail on arrival. The `error` heading is now
"CAN'T SEARCH."

**Data operation (live DB, 2026-09-08, one-off).** With the user's approval,
all 11 unsettled matches were voided and refunded. Refunds were computed from
the *actual* `points_ledger_entries` debits per `(match, user)` rather than
from `challenges.stake_points`, so the operation could not invent or lose
points, and it mirrored `settle_match()`'s `tie_refunded` bookkeeping exactly:
credit `fitness_profiles.points_balance`, write one `payout` ledger entry per
participant per match, `matches.winner_id = NULL, settled_at = now()`,
`challenges.status = 'completed'`. Applied in a single transaction that
asserted, before committing, that no `payout` already existed on those
matches, that no unsettled match remained, and that the net ledger across the
voided matches was exactly 0. 920 points returned across 4 fighters; all five
accounts landed on exactly 500, their starting balance, which is the
independent check that the arithmetic was right. Row-level backups of every
touched table were written first.

This was a cleanup of test data, not a substitute for the forfeit rule — the
underlying gap is unchanged and will recur on the next abandoned bout.

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
- **Stake is never widened**, only the rating window is (tier, when this was
  written). Matching across stakes would need a rule for what the pot is.
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

## Skill rating: per-exercise MMR and the six rank tiers (2026-09-09)

Migration `20260909000000_skill_ratings`. Replaces self-reported
`fitness_profiles.strength_tier` as the signal the live queue pairs on. The
column stays — it is what a fighter says about themselves before they have a
record, and onboarding still asks for it — but **nothing in
`_mm_find_lobby()` reads it any more**, and `_mm_tier_rank()` /
`_mm_tier_widen_after()` were dropped so no future function can pick it up
believing it still means something.

### Why tier could never have been the real signal

`strength_tier` is client-writable: the Profile screen sets it with a plain
`UPDATE fitness_profiles`, and the column grant that allows it predates all
of this. Anyone who wanted an easier bout could declare themselves a
beginner between searches. It also has three values for a whole account,
which says nothing about whether someone who can do 40 push-ups can also
hold a plank. MMR is per `(user, exercise_type)`, is written only inside
settlement, and has no client write path at all.

### The tables

`skill_ratings` — one row per `(user_id, exercise_type)`: `mmr`,
`matches_played`, `placement_complete`. Created on demand by
`enter_matchmaking()` when a fighter first queues an exercise, and by
`settle_match()` for anyone who somehow reaches settlement without one.
Select-own RLS, `GRANT SELECT` only.

`skill_rating_events` — one row per rated participant per settled bout:
`mmr_before`, `mmr_after`, `delta`, `k_factor`, `was_placement`,
`matches_played`, `participants`. The Results screen's source for "+18", and
the audit trail that makes `seed + sum(delta) = mmr` checkable. Same shape as
`points_ledger_entries` next to `fitness_profiles.points_balance`, and for
the same reason: a current value you can read cheaply, plus the history that
explains it.

`my_skill_ratings` — a `security_invoker` view over `skill_ratings` adding
`rank_tier` (from `rank_tier_for()`) and `placement_bouts`. This is what the
app reads, so the band edges are applied by the database and the client never
has to agree with SQL about where Knight starts. **`security_invoker = true`
is load-bearing**: a plain view runs as its owner and would have handed every
fighter the whole table.

`placement_complete` is stored but is *not* an independent fact — a
`BEFORE INSERT OR UPDATE` trigger pins it to
`matches_played >= _mmr_placement_bouts()` whatever wrote the row. It is
stored only so the matchmaking predicate and the queue snapshot can be plain
column reads.

### The tier bands

Six evenly-sized **200-point bands over a nominal 900–1900 range**, with the
outermost two open-ended because Elo has no ceiling or floor:

| Tier | MMR |
| --- | --- |
| Commoner | below 900 |
| Squire | 900 – 1099 |
| Knight | 1100 – 1299 |
| Hero | 1300 – 1499 |
| Sovereign | 1500 – 1699 |
| Ultimate Champion | 1700 and above |

`rank_tier_for(integer)` is the only definition. `src/lib/skillRating.ts`
mirrors the table for one purpose — deriving a tier from a
`skill_rating_events` row, which carries the MMR but not the band — and
`__tests__/skillRating.db.test.ts` asserts the mirror against the SQL
function at every 25 points from 0 to 2200, so the two cannot drift.

**The seed is 1000, which is the dead centre of Squire, not the middle of the
scale.** Two reasons. A fighter with no record should sit low enough that
early wins visibly move them, rather than starting halfway up. And Commoner
has to be *reachable*: seeding into Knight or Hero would make the bottom band
a place nobody is ever in, which is a tier that exists only on the marketing
page. At K=32 a win over an equal opponent is +16, so roughly twelve net wins
crosses a band — slow enough to mean something, fast enough to see.

**"Unranked" is not a stored tier.** It is how the client renders a rating
whose `placement_complete` is false. The row always carries a `rank_tier`
(derived from the seed), and the Profile screen deliberately withholds it
until placement finishes: showing "Squire" to someone who has fought once
would assert exactly the thing the five placement bouts exist to find out.

### K-factor and placement

| Condition | K |
| --- | --- |
| `matches_played < 5` for that exercise type | **100** |
| `matches_played >= 5` | **32** |

K is per fighter, not per bout. A fighter placing at K=100 can meet an
opponent moving at K=32 in the same bout, and they will move by different
amounts. **MMR is therefore not zero-sum and is not reconciled the way the
points ledger is** — that is a property of the K schedule, not a bug to fix.

Placement is per exercise type too: five bouts of push-ups place a push-up
rating and leave a plank rating untouched at the seed.

A **floor of 100** is applied after the delta. Standard Elo is unbounded
downward; from the seed at K=32 the floor is unreachable in practice, and it
exists only so a pathological run cannot produce a negative rating the tier
bands and the UI have no reading for. The clamp is applied *before*
`skill_rating_events` is written, and the event records the **effective**
delta, so what the Results screen shows is always the change that actually
happened.

### The Elo itself

Standard, with no margin-of-victory weighting (see "Deliberately not built"):

```
E_A = 1 / (1 + 10^((R_B - R_A) / 400))
R_A' = R_A + K * (S_A - E_A)
```

`numeric` throughout, so the pairwise sums in a six-seat bout are exact until
a single `round()` at the end (round-half-away-from-zero). The exponent is
clamped to ±10 — a 4000-point gap, far beyond anything reachable — because
`power()` on numeric raises rather than saturating, and a rating table
corrupted by some future bug must not be able to make *settlement* throw.

### Group Battles: pairwise decomposition, divided by (N−1)

A bout with N seats is decomposed into all N(N−1)/2 pairwise comparisons of
the final ranking. For each ordered pair (i, j):

- `S_ij` = 1 if i outscored j, **0.5 if they tied**, 0 if j outscored i
- `raw_i += K_i * (S_ij - E_ij)`

and then **every fighter's total is divided by (N−1)** before rounding.
Without the divisor a six-seat bout would move a rating five times as far as
a 1v1 for the same relative performance, which would make Group Battles the
only rational way to climb. With it, the top and bottom of a four-way move
exactly as far as a 1v1 winner and loser do (±16 between equals at K=32),
which the db test asserts directly.

Two consequences worth stating:

- **Every E_ij uses the ratings as they were when the bout started.** The
  arrays are read once, up front, and never updated inside the loop, so the
  result does not depend on the order pairs are visited. A
  sequentially-updating implementation would give a different (and
  order-dependent) answer; `__tests__/skillRating.db.test.ts` pins this with
  a mixed-rating three-way whose expectations are computed from the starting
  ratings only.
- **Second place is not "not the winner".** Second of four still beat two
  people and gains; third still lost to two and drops. Only the pairwise
  decomposition gets this right.

### Where it runs: inside settlement, not beside it

`_mmr_rate_match()` is called from `settle_match()` — **after** the anomaly
gate, **after** the pot has moved, and **before** `settled_at` is stamped.
That position is the whole design:

- a bout that returns `needs_review` rates nothing, and rates normally on the
  later call that clears the review;
- a bout that returns `already_settled` rates nothing, because it returns
  before reaching the call — the `settled_at` guard is what makes the rating
  write exactly-once, the same guard that makes the payout exactly-once;
- a rating write that fails takes the whole settlement down with it. That is
  the same bargain `submit_verification_session()` already makes with
  settlement itself: a paid-out bout with no rating would be silently wrong,
  and unrecoverable without knowing the pre-bout ratings.

Because settlement already runs inline at the end of
`submit_verification_session()`, ratings update the instant the last result
lands, with no client involvement and no separate step a modified build could
skip.

### Lock order

`20260908000000` fixed one order for every function that can run
concurrently: lobby `challenges` row → member `matchmaking_queue` rows →
`fitness_profiles` rows `ORDER BY user_id`. **`skill_ratings` is appended to
the end of that chain**: `settle_match()` takes its rating rows
`FOR UPDATE ORDER BY user_id` only after it has finished with
`fitness_profiles`.

Nothing else takes a rating row lock at all. `enter_matchmaking()` ensures
its row with `INSERT ... ON CONFLICT DO NOTHING` — which never waits on a
*committed* conflicting row — and then reads it unlocked, before it takes the
domain advisory lock. So a fighter entering the queue can never block, or be
blocked by, a bout settling underneath them. **Do not add a `FOR UPDATE` to
that read.**

### Matchmaking on MMR

`matchmaking_queue` gained `mmr` and `placement_complete`, snapshotted at
entry for the same reason `strength_tier` was: the pairing predicate must not
read a value that can move under a live search. (The client cannot write this
one, but a bout settling elsewhere can.) `strength_tier` stays on the row,
unread by any predicate.

**The rule, in full.** A lobby fits a fighter when it is in the same domain
(exercise, format, seats) at the same stake and has a free seat, *and* for
every member `m` currently seated in it:

- if **either** `m` or the arriving fighter is still in placement, that pair
  is compatible — **full stop, no rating comparison is made at all**;
- otherwise `abs(m.mmr - fighter.mmr)` must be within the window: **150**, or
  **400** once *both* the lobby and the fighter have waited **45 seconds**.

**What "broadly" means during placement, precisely: rating is ignored
entirely, and matching falls back to availability alone** — exercise, format,
seats and stake, which are what the fighter explicitly asked for and cannot
be wrong about. An unplaced rating is a seed, not a measurement: it says
"1000" about someone we have never seen lift. Gating on it would be gating on
a number that does not exist yet, and worse, it would herd every new fighter
into the same narrow band as every other new fighter regardless of actual
ability. K=100 is the other half of the trade: five bouts against a wide
field move a placing rating far enough to land near the truth, which is what
makes the narrow window meaningful once it does apply.

This is deliberately **asymmetric-tolerant**: *one* unplaced fighter opens
the pair up even if the other is placed, so a placed Sovereign can be handed
an unplaced newcomer. That is the intended direction — the newcomer needs a
hard reference point to place against, and the veteran's rating barely moves
for a win they were expected to take.

The check stays **pairwise rather than lobby-wide**, kept from the tier
version and mattering more here: without it a six-seat lobby could accumulate
a 900 and a 1500 by admitting each of them next to a 1200. Widening is still
**symmetric** — both the lobby and the arriving fighter must have waited the
45 seconds — so nobody is widened before they have queued for it themselves,
and the heartbeat retry is what pairs two patient neighbours.

### Display

**Profile** shows one row per ranked exercise (push-ups, plank, wall-sit) —
not a single combined rank, because the ratings are genuinely independent.
Three states, and they are not the same thing: never fought (no rating row),
placing ("Unranked" + "3 of 5 placement bouts"), and placed (the tier name,
the MMR, and a bar showing progress through the band). The self-reported
Bronze/Silver/Gold pill stays in the header, and its bottom sheet no longer
claims to set "who you get matched with" — that copy became false the moment
this shipped, and leaving it would be the worst kind of stale string.

**Results** shows the MMR change once placed ("+18", "−24") and **no number
at all during placement**. At K=100 a single placement bout can swing 100
points; shown as a number, that reads as wild instability rather than as the
system finding a fighter's level, especially across a +100 followed by a
−100. During placement the line carries progress instead
("PLACEMENT · 2 OF 5 · 3 TO GO"), and the bout that completes placement
announces the tier that landed ("PLACED · HERO"). RLS scopes
`skill_rating_events` to the caller, so an opponent's rating is never on the
wire.

### Re-settling by hand

The legitimate re-settle path — a `needs_review` bout whose review clears —
never wrote a rating event, because `needs_review` returns before rating. It
just works.

An operator who instead **unsets `matches.settled_at` to force a re-settle
must also delete that match's `skill_rating_events` rows**, exactly as they
already have to reverse the `payout` ledger rows and the balances. The
`(user_id, match_id)` unique constraint will otherwise refuse the second
rating and abort the whole settlement — loudly, which is the intended
behaviour and much better than double-rating a bout. This was found by an
existing test that resets `settled_at` to check the return-value
classification; that test now clears the rating events too.

### Deliberately not built

- **Margin-of-victory weighting.** A 40-rep win over 39 moves a rating
  exactly as much as 40 over 5. Elo is a model of *who beats whom*, and
  folding in margin needs a defensible per-exercise scale (is 10 extra reps
  worth the same as 30 extra seconds of plank?) plus a rule for what stops a
  sandbagger from farming huge margins against weak opponents. A future pass,
  explicitly out of scope for this one.
- **Rating decay.** A rating earned in March still stands in September.
- **Cross-exercise inference.** Being a Hero at push-ups says nothing about
  your plank, by construction.
- **A leaderboard.** `skill_ratings` is select-own; ranking players against
  each other publicly is a product decision with its own privacy shape.
- **Stake is still never widened**, only the rating window is. Matching
  across stakes would need a rule for what the pot is. Unchanged from before.
- **The MMR window never becomes unbounded.** It stops at ±400, exactly as
  tier widening never went two tiers. On a small user base, two placed
  fighters more than 400 apart in the same domain and stake will not meet,
  and both will time out. This is the same known limitation the tier rule
  had, in a new coordinate system.

### ⚠️ What is NOT verified about ratings

`__tests__/skillRating.db.test.ts` (35 tests) runs the real migration SQL
against a real embedded Postgres: the band boundaries, the K schedule across
six consecutive bouts fought through the live queue, the pairwise group
decomposition against hand-computed expectations, the (N−1) divisor, ties
inside a field, the review gate, the floor clamp, exactly-once rating under
repeated settlement, and the pairing and widening rules.
`__tests__/skillRating.test.ts` (16 tests) covers the display rules with no
database.

**None of it exercises a real bout.** These need real accounts on real
devices and cannot be confirmed by reading code:

1. **A real settlement moving a real rating**, through PostgREST rather than
   a `pg` connection. Every arithmetic test stages its bout by inserting the
   challenge/match/participant rows directly — deliberately, because the
   rating maths has to be testable at spreads the queue would never pair.
   Only the K-schedule test fights through `enter_matchmaking()` end to end.
2. **Two placed fighters actually failing to meet**, and then meeting after
   the 45-second widening, on real phones with real heartbeats. The window
   arithmetic is proven in SQL; the wall-clock behaviour is not.
3. **The Profile and Results screens rendering a real rating.** They
   typecheck and their pure functions are unit-tested, but no test mounts
   them against a live `my_skill_ratings` / `skill_rating_events` read. In
   particular **the `my_skill_ratings` view has never been read through
   PostgREST** — `security_invoker` views are exposed like tables, but that
   is asserted here from the migration, not observed. If Profile shows no
   ranks at all after deploy, that read is the first thing to check.
4. **Whether the numbers feel right.** Whether 5 placement bouts is enough,
   whether ±150 is too tight for the real user base, and whether crossing a
   band in ~12 net wins is satisfying are empirical product questions. All
   four are single-value tunable functions in the migration precisely so they
   can be changed without touching any logic.

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

### Deploy status: applied 2026-09-08

Both `20260907000000_settings_profile` and
`20260908000000_live_matchmaking_queue` were applied to the live Supabase
project at **2026-09-08 18:23**, neither rolled back (verified against
`_prisma_migrations`, which now matches `prisma/migrations/` exactly — 12
local directories, 12 applied rows, plus the waitlist app's own 4). The
shipping build is EAS iOS `preview` on commit `30a6efc`.

Verified read-only after deploying: `matchmaking_queue`,
`matchmaking_presence`, `enter_matchmaking`, `matchmaking_heartbeat` and
`leave_matchmaking` all present; `join_challenge` gone; the 11 pre-existing
matched-but-unsettled bouts untouched by the migration and back-filled to
`max_participants = 2` as intended. Those 11 were later voided and refunded
as a separate, deliberate data operation — see "`round_open` looked like a
broken search" above; the migration itself moved no points.

Because the old build inserts challenges it no longer has the grant for, a
migration and its EAS build ship together: commit → push → `npm run
db:deploy` → `eas build` → install. See the README loop.

### Deploy status: applied 2026-09-10

`20260909000000_skill_ratings` was applied to the live Supabase project
together with `20260910000000_performance_norms` (below) on **2026-09-10**,
via `npm run db:deploy`. Verified independently afterward by direct
introspection, not just the CLI's exit code: `skill_ratings`,
`skill_rating_events`, the `my_skill_ratings` view, `matchmaking_queue.mmr`
/ `.placement_complete`, and every function this section names
(`settle_match`, `_mmr_rate_match`, `_mm_find_lobby`, `enter_matchmaking`,
`rank_tier_for`) all exist on the live database; `_mm_tier_rank()` and
`_mm_tier_widen_after()` are confirmed gone. `rank_tier_for(1000)` returns
`squire` against the live database, matching the seed. `npx prisma migrate
status` reports the schema up to date. No EAS build has shipped the client
half yet — see the README loop (commit → push → `npm run db:deploy` →
`eas build` → install) for the remaining step.

The two checks this section used to flag as unverified — `my_skill_ratings`
readable through PostgREST, and a real settled bout writing a
`skill_rating_events` row — are **still open**: introspection confirms the
view and table exist and are shaped correctly, not that a real device has
successfully read or written through them yet. See "What is NOT verified
about ratings" above, which still applies in full.

## Real-world percentile seeding (2026-09-10)

Migration `20260910000000_performance_norms`. Placement-only. Standard Elo
— `_mmr_expected()`, K=100/32, the group `(N-1)` divisor, the rating floor —
is **completely unchanged**. This migration changes exactly one thing: what
a fighter's MMR is *before* their very first rated bout in an exercise,
replacing the flat 1000 seed with a real-world-informed one when it can.

### Confidence, exactly as graded

| Exercise | Confidence | Why |
| --- | --- | --- |
| Push-ups | **high** | ACSM norms, a recognised source |
| Plank | **high-narrow** | Chase et al. 2014 — solid, but only for ages 18–25 |
| Wall-sit | **low** | Practitioner-sourced, not a published study |
| Race (WMA) | **high** | WMA age-grading is a well-established *method* — but see the loud caveat below: this migration's actual standard times and age factor are placeholders, not WMA's published tables |

**Do not read the wall-sit numbers, or any exercise's age-decline
adjustment, as sourced fact at the same weight as the push-up baseline
itself.** Every row in `performance_norms` carries its own `confidence` and
`source` text explaining exactly what it is and isn't.

### The shape: a reference table, not a formula buried in code

`performance_norms` — one row per `(exercise_type, gender, age_band,
percentile)` anchor point: `raw_value`, `confidence`, `source`. Not a
lookup of a single "your number" — a small ordered set of `(raw_value,
percentile)` anchors per combination that `_perf_percentile_from_anchors()`
interpolates between and extrapolates beyond. **No client grant exists on
this table at all** — `ENABLE ROW LEVEL SECURITY` with no policies (deny
even to a role with a grant) plus `REVOKE ALL FROM anon, authenticated`,
the same belt-and-suspenders pattern as `matchmaking_presence`. It's seed
data, consulted only from inside the SECURITY DEFINER chain.

**How ordinal categories become percentiles.** Chase et al. (plank)
publishes real percentiles (P25/P50/P75) — those anchors are used
directly, no assumption layered on. ACSM's push-up categories and the
wall-sit skill labels are **ordinal with no published percentile
cutpoints** in the source data given for this feature. Both are converted
the same documented way: *N* ordinal labels are assumed to be *N* **even**
population bands (each `100/N`% wide) — but anchored differently depending
on what the source actually gives:

- Push-ups' bands are **ranges** ("17–29 = average"), so the natural
  anchors are the **boundaries** between bands: 4 bands (men) → 3
  boundaries at 25/50/75; 5 bands (women, reproduced exactly as given,
  including the repeated "above avg" label at 14–22 and 23–31) → 4
  boundaries at 20/40/60/80.
- Wall-sit's labels are single **representative times** ("Novice ~45s"),
  not ranges, so the natural anchor is the **centre** of each assumed
  25%-wide band: 4 labels → centres at 12.5/37.5/62.5/87.5.

This is **one assumption** (even population splits) applied to two
differently-shaped inputs, not two different assumptions — but it's still
an assumption, not sourced fact, and the even-split premise is very
unlikely to be exactly right (fitness-norm "average" bands are typically
wider than the extremes in real published tables).

### Age decline, precomputed into the data

Every `raw_value` is **already age-adjusted** for its `age_band` — the
decline math ran once, at migration-write time, not on every lookup. The
table is literally the data, auditable as-is with a plain `SELECT`.

- **Push-ups: −4 reps/decade** beyond the 20-29 baseline (the task's own
  "roughly −3 to −5", midpoint used — an approximation, not sourced
  per-decade data). Every boundary floors at 1 rep and, where that floor
  would make two boundaries collide or invert (this happens in the
  **women's table from the 50s onward**, where the baseline is already
  low), is nudged to stay at least 1 rep above the previous one. That
  visible compression is the model straining past where it should be
  trusted — flagged in the row-level `source` text, not hidden.
- **Plank: −10%/decade** beyond the 18-25 baseline. **This rate is an
  analyst estimate** — Chase et al. covers ages 18-25 only and gives no
  decline rate at all. −10%/decade is a round, conservative approximation
  in line with general muscular-endurance aging literature, **not a
  number from the cited paper or any other source**. Needs real sourcing
  before being trusted past a rough seed.
- **Wall-sit: no decline at all.** Neither a rate nor an instruction to
  estimate one was given for wall-sit (unlike push-ups and plank); every
  age band reuses the 20-29 numbers verbatim. **This is a documented gap,
  not a finding** that wall-sit endurance doesn't decline with age.

**One unified age-band scheme reused everywhere**, even though each
exercise's own source baseline spans a slightly different range
(pushups/wallsit: 20-29; plank: 18-25): `under_20, 20s, 30s, 40s, 50s, 60s,
70_plus`, mapped to representative (midpoint) ages 17/25/35/45/55/65/75 by
`_age_band_representative_age()`. `under_20` has no source data in *any* of
the four exercises and defaults to the youngest sourced band rather than
inventing a youth adjustment. A side-effect worth naming: plank's `20s`
band (representative age 25) sits technically *inside* the sourced 18-25
range, so it still receives a small (~3.6%) decline it arguably shouldn't
— a minor, acknowledged inconsistency traded for one age-band scheme
instead of per-exercise-shaped bands.

### The shared percentile → MMR curve

```
MMR(p) = 1000 + 400 * log10( p / (100 - p) )
```

The **logit of the percentile**, scaled and centred so the population
median (`p=50`) lands exactly on the existing seed (1000). This is not a
new curve invented for this feature — it's `_mmr_expected()`'s own
logistic family (base 10, `/400`) run in reverse, so a fighter seeded this
way and paired against a population-average (1000) opponent has an
Elo-implied win expectation consistent with the percentile they were
seeded from (asserted directly in the db test). **One function
(`_mmr_from_percentile()`), called by every exercise type** — pushups,
plank and wallsit via `_mmr_seed_from_norms()`, race via
`_mmr_seed_from_race_time()` — per "define the percentile mapping once and
reuse it consistently."

Every caller clamps its percentile-shaped input to `[1, 99]` first, which
keeps `p/(100-p)` away from 0 and infinity and bounds the output to
roughly `[202, 1798]` — comfortably inside Commoner through Ultimate
Champion, never at a literal floor or an unbounded top.

### The interpolator

`_perf_percentile_from_anchors(raw, anchors_raw[], anchors_pct[])` —
piecewise-linear between the bracketing anchor pair; beyond either end,
extrapolates using the nearest segment's slope, then clamps to `[1, 99]` —
a single sourced or estimated data point should never be read as "the 0th
percentile of anyone who has ever lived." `NULLIF` guards every division
so two anchors sharing a `raw_value` (none do in the seed data — asserted
by a monotonicity db test across all 42 groups) degrade to a flat
percentile instead of dividing by zero. Fewer than two anchors — including
a `NULL` array, what `array_agg` returns over zero matching rows — returns
`NULL` rather than raising: an incomplete or missing norms row degrades to
"no seed available," never a failed settlement.

### Where the seed applies: first rated bout only

Point 2 in the task is precise, and the implementation matches it exactly:
**"before their first placement match's Elo update is even calculated"**
— singular, one-time, not re-applied on placement bouts 2 through 5.

Inside `_mmr_rate_match()`, `fitness_profiles.gender` / `age_band` are
pulled alongside the rating snapshot in the same query (an added `JOIN`,
**not a new lock** — read without `FOR UPDATE`, so it cannot change the
deadlock ordering `LOCK ORDER` in `20260908000000` established). Then, for
any participant whose `matches_played` is exactly `0` — this bout *is*
their first rated bout in this exercise — `v_mmr[i]` is overridden with
the norms-based seed **before the pairwise `E_ij` loop runs**, so every
expectation calculation in this bout (both this fighter's own, and every
opponent's expectation *against* them) uses the adjusted number, not the
stale flat seed. Every later placement bout leaves `v_mmr[i]` untouched.

Their own verified score for *this* bout is always present by the time
`_mmr_rate_match()` runs — `settle_match()` already refused to reach here
with a `NULL` score — so **the only real gate on norms-seeding is
`gender`/`age_band` being on file**, exactly "if their verified
performance data is available … and they've provided age/gender." Missing
either falls back to the population-median seed (unchanged 1000, K=100
placement as before), **never a block on placement** — point 3.

`skill_rating_events.norms_seeded` records, per bout, whether this
actually fired — independently queryable, not inferred from the numbers.
`mmr_before` in that row is always the value actually used for the Elo
calculation (the norms seed when applied, the flat 1000 otherwise), so the
`delta = mmr_after - mmr_before` invariant stays honest.

### Optional demographics

`fitness_profiles.gender` (`male`/`female`) and `age_band` (the seven
bands above), both nullable, neither required to play. **Binary gender**
because that is the shape of every source table this feature draws on
(ACSM, Chase et al., the wall-sit numbers, WMA's factors are all
published men's/women's) — a limitation of the source data, not a claim
about how many genders exist. Anyone who doesn't select one simply gets
the population-median seed, the same as anyone who leaves any other
optional field blank.

Set only through `update_my_profile()` (`p_age_band`, `p_gender`), the
same SECURITY DEFINER identity function from `20260907000000`. The old
3-arg signature is **dropped, not left alongside** — the same rule
`20260903300000` established for `submit_verification_session()`: adding
trailing `DEFAULT`-valued parameters still creates a second overload that
PostgREST cannot resolve a 3-arg call against unambiguously. Client UI:
Settings → Profile gained an "ABOUT YOU" section with two chip rows
(gender, age band); picking a chip saves immediately, the same
save-on-tap pattern the Profile screen's strength-tier sheet already uses
— no validation needed, since Postgres itself rejects anything outside
the enum at the call boundary.

### Race / WMA age-grading — read this before trusting any of it

WMA (World Masters Athletics) age-grading is a real, well-established
method — that part is genuinely "high confidence," which is why the table
above grades it that way. What it needs is a **large published table** of
per-age, per-event, per-gender factors (and an "open standard" time per
event) that WMA/Alan Jones publish to several decimal places. **This
feature was not given that table as source data**, and this implementation
does not have it memorized precisely enough to reproduce without risking
fabrication — doing so would be exactly the "invent additional precision
that isn't in the source data" the task says not to do.

So instead: the **pipeline** (`race_standards` → `_mmr_seed_from_race_time()`)
implements the real WMA formula shape —

```
AG% = standard / (actual / age_factor) * 100
```

— using two inputs that are **loudly, unmistakably named as placeholders**:

1. **`race_standards.standard_seconds`** — a rounded, approximate
   open-class (roughly world-record-level) **mile** time (only `mile` is
   seeded — `EXERCISE_LABEL.race` is "1-Mile Race" in `src/theme/copy.ts`,
   the only race distance FittrApp defines). Deliberately rounded to a
   5-second increment (225s men, 250s women) rather than stating a
   specific record time as if precisely sourced. **Not WMA's own
   published standard.**
2. **`_race_age_factor_APPROXIMATE()`** — the function name says
   `APPROXIMATE` on purpose. Flat 1.0 through age 30, then +1%/year
   beyond it, identically for every event and both genders. Real WMA age
   factors are nonlinear and vary by event; this doesn't attempt that
   curve.

`age_factor > 1` for an older runner shrinks the age-adjusted-equivalent
time below their raw actual time before comparing to the standard — the
same clock time earns a *higher* age grade the older the runner is, which
is the whole point of age grading, and the db test asserts this direction
is correct even though the magnitude is a placeholder. The result is
clamped to `[1, 99]` and fed through the same `_mmr_from_percentile()`
every other exercise uses, per the instruction to map the percentage to
MMR "the same way the other three map percentile to MMR" — stated there
explicitly because an age-graded % is **not itself a population
percentile**; the implementation follows that instruction rather than
asserting the two are the same statistic.

**Neither placeholder should be trusted for anything beyond a rough
placement seed** until replaced with WMA's actual published tables
(available from World Masters Athletics / mastersathletics.net, or Alan
Jones' age-grading calculators).

**Not wired into `settle_match()` / `_mmr_rate_match()`.** Race has no
verification or settlement path yet — `settle_match()` still raises for
challenge type `race` (see "Settlement," "Winner rules"), unchanged by
this migration and re-asserted by a db test. This section exists so the
pipeline is complete and independently testable ahead of that work, per
"for all four exercise types" — when race verification is eventually
built, wiring it in becomes "call this function," not "design this
function."

### What's NOT verified

`__tests__/performanceNorms.db.test.ts` (34 tests) runs the real migration
SQL against a real embedded Postgres: reference-table integrity
(coverage, strict monotonicity across all 42 anchor groups, percentile
bounds, exact reproduction of the sourced plank baseline and the
women's-pushups five-band data), the shared percentile curve's symmetry
and its consistency with `_mmr_expected()`, the interpolator's exact,
interpolated and extrapolated cases, the first-bout-only integration
point (placed and unplaced, 1v1 and group, across all three ranked
exercises), the population-median fallback in all three
missing-demographic combinations, that settlement's payout arithmetic is
untouched, the standalone race pipeline's direction (faster → higher,
older → higher for the same time) and its null-safety, and both the new
and old `update_my_profile()` call shapes.

**None of it exercises a real bout.** Same caveats as the rest of the
rating system, plus two specific to this feature:

1. **The reference data's real-world accuracy is unverified by
   construction**, not merely by missing a test — wall-sit and the
   age-decline rates are estimates by design, and the race standards are
   explicit placeholders. No test can validate that a "high" push-up
   confidence rating in this system corresponds to an actual high
   push-up count in the real population; the tests validate that the
   *pipeline* computes what the seeded numbers say it should, not that
   the seeded numbers are correct.
2. **`update_my_profile()`'s new fields have never been read through
   PostgREST**, and the ProfileEditor "ABOUT YOU" chips have not been
   exercised against a live profile — they typecheck and follow the
   existing save-on-tap pattern, but no test mounts the screen.

### Deploy status: applied 2026-09-10

Applied to the live Supabase project on **2026-09-10**, in the same
`npm run db:deploy` run as `20260909000000_skill_ratings` immediately
above it (both were pending together; `migrate deploy` applied them in
order in one invocation). Verified independently afterward: `performance_norms`
holds exactly 147 rows and `race_standards` exactly 2, matching the local
embedded-Postgres test counts precisely; `fitness_profiles.gender` and
`.age_band` exist; `_mmr_from_percentile`, `_mmr_seed_from_norms` and
`_mmr_seed_from_race_time` all exist and are callable; `_mmr_from_percentile(50)`
returns `1000` against the live database. Client grants confirmed exactly
as intended: `authenticated` has `SELECT` on `skill_ratings` and nothing
else — **no grant at all** exists on `performance_norms` or
`race_standards`, on the live database, not just in the migration source.

**Not yet done: an EAS build carrying the client half** (the "ABOUT YOU"
gender/age chips in ProfileEditor, and the profile/results screens reading
the now-live tables). The commit is pushed to `main`; the next step in the
usual loop is `eas build` → install. Until that build ships, the running
app still shows the old Settings screen — the database is ready, the
client on people's phones is not yet.

## Leagues, trophies and the Rank screen (2026-09-13)

Migration `20260913000000_league_rank`. A **second** ladder, running
alongside the per-exercise MMR from `20260909000000` rather than replacing
any part of it. Nothing in `_mm_find_lobby()`, `_mmr_rate_match()` or the
rating arithmetic changed.

### Why two ladders is not one ladder too many

They answer different questions and neither is derivable from the other:

| | MMR / RankTier | Trophies / LeagueTier |
| --- | --- | --- |
| Scope | per exercise | one number across every exercise |
| Purpose | who should this fighter meet | what has this fighter done |
| Sum | zero-sum (Elo) | positive-sum: +12 a win, −6 a loss |
| Floor | `_mmr_floor()`, effectively unreachable | hard 0, and it is reached |
| Visible to | its owner only | the whole leaderboard |
| Drives | matchmaking pairing | wager ceiling, leaderboard, the Rank screen |

A fighter who plays a lot and wins half will climb the trophy ladder and
sit still on the MMR one. That is intended: trophies are a record of
activity and results, MMR is a measurement of strength, and the number
matchmaking actually pairs on is the second one — so the first is free to
be generous without making anybody's bouts unfair.

### The award schedule

Tunable functions, same pattern as `_mm_*` and `_mmr_*`, mirrored in
`src/lib/league.ts` and asserted against the SQL in
`__tests__/rank.db.test.ts` so the two cannot drift:

- `_trophy_win_base()` = 12
- `_trophy_loss_penalty()` = 6
- `_trophy_tie_award()` = 6 (shared first place in a group battle)
- `_trophy_streak_bonus_cap()` = 5
- `_trophy_win_award(streak_after)` = 12 + min(streak_after − 1, 5)

So an unbroken run pays 12, 13, 14, 15, 16, 17, 17, 17… A loss resets the
streak to 0. **A tie neither extends nor breaks it** — nobody beat this
fighter and nobody was beaten. The balance is floored at 0, and the
history row records the *floored* delta, so a loss at zero trophies is
recorded as 0 rather than −6.

### The five leagues

`league_tiers`, seeded with five rows and read by `league_for()` — which is
the **only** thing that decides which league a trophy count is in.

| League | Threshold | Wager ceiling | Colour | ≈ clean wins |
| --- | --- | --- | --- | --- |
| Bronze | 0 | $10 | `#CD7F32` | — |
| Silver | 50 | $25 | `#C0C0C0` | 5 |
| Gold | 150 | $50 | `#FFD700` | 13 |
| Platinum | 300 | $100 | `#00CFCF` | 25 |
| Diamond | 500 | $250 | `#B9F2FF` | 40 |

A table rather than a `CASE` function (which is what the MMR bands are)
because three of the four facts are rendered on the Rank screen's tier
cards. Unlike `performance_norms` it **is** client-readable: RLS on, one
`auth.role() = 'authenticated'` SELECT policy, `GRANT SELECT` to
`authenticated`, and no write grant to anyone.

**`max_wager_cents` is display-only today.** Nothing in matchmaking or
`enter_matchmaking()` reads it, and the pilot stakes points, not dollars.
It is the ceiling that applies the day real-money play is switched on —
which is a server-side decision (`REAL_MONEY_NOTICE`). The Rank screen
shows it under that same notice. Wiring it into the stake picker would
have changed matchmaking behaviour and broken existing bouts staked at 100
points by Bronze fighters, so it was deliberately not done here.

### Where the standing lives, and why

Six columns on `fitness_profiles`, not a table of their own: `trophies`,
`current_league`, `total_wins`, `total_losses`, `total_ties`,
`current_streak`.

The reason is realtime. `fitness_profiles` has been in the
`supabase_realtime` publication since `20260903100000`, filtered
per-subscriber by `fitness_profiles_select_own`. Putting the standing there
means a trophy award reaches the fighter's own phone on the channel the
points balance already uses — no new publication member, no new policy, no
second subscription, and no second source of truth about who someone is.
`useRankStanding` reads `payload.new` and raises the counter without a
refetch; that is the whole live path.

`total_ties` is not decoration. A group battle can end with two fighters
sharing first, which is neither a win nor a loss, and
`src/lib/boutStats.ts` has always counted ties **in the denominator** of
the win rate. Without the column the Rank screen's win rate and the Profile
screen's would differ by exactly the ties.

No new client write grant: `REVOKE UPDATE` / `GRANT UPDATE(strength_tier)`
from `20260902000000` still stands, so the only writer is
`_rank_apply_match()`, which is SECURITY DEFINER.

### Global rank is computed, not stored

The spec called for `global_rank (int, computed or cached)`; it is
computed. A cached column would have to be rewritten for every player
ranked below whoever just won — an O(n) write on the write-hot table, and
one that is *also* a realtime broadcast per row. `rank_standing()` counts
the profiles ahead of the caller instead, off the new
`fitness_profiles_trophies_idx` `(trophies DESC, created_at ASC)` index.
One count per screen open beats a fan-out per bout.

The tiebreak chain is `trophies DESC, created_at ASC, user_id ASC` in both
`rank_standing()` and `leaderboard_page()`, so "#42 globally" is the same
42 the board would put them at — asserted in the db test by paging to that
offset and checking the row that comes back.

### `rank_history`

One row per fighter per settled bout, plus a second row for each promotion
or demotion that bout caused. The bout row carries the delta *and* the
balance it left behind, so the timeline is a straight read rather than a
running sum the client maintains — and `sum(trophy_delta)` can always be
audited against `trophies`.

- `event_type` ∈ `win | loss | tie | promotion | demotion`
- `opponent_id` is set **only for a two-seat bout**; a group battle has no
  single opponent to name, and the copy says so instead of inventing one.
- A promotion row is written at `created_at + 1ms` so it sorts above its
  own cause in a newest-first timeline.
- A `CHECK` forbids a promotion/demotion row from carrying a non-zero
  delta: it is a consequence of the bout row next to it, not a second award.
- A **partial unique index** on `(user_id, match_id) WHERE event_type IN
  ('win','loss','tie')` makes a double award impossible however many
  callers reach `_rank_apply_match()`, while still letting the promotion
  row sit alongside. Same guarantee `skill_rating_events` gets from its
  `(user_id, match_id)` key. `_rank_apply_match()` *also* returns early if
  any history row already exists for the match.
- RLS: select-own, `GRANT SELECT` to `authenticated`, no write grant.
- **Deliberately NOT in the realtime publication.** The profile row already
  broadcasts the consequence of an award; publishing a second table to say
  the same thing would double the WAL for it. The Rank screen refetches the
  timeline when the profile broadcast arrives.

### The lock order changed — read this before touching `settle_match()`

The chain fixed in `20260908000000` and extended in `20260909000000` is:

```
lobby `challenges` → member `matchmaking_queue`
  → `fitness_profiles` ORDER BY user_id → `skill_ratings` ORDER BY user_id
```

Trophies are a `fitness_profiles` write for **every fighter on the bout,
not just the winners**. So `settle_match()`'s existing pre-lock was
**widened** from `WHERE user_id = ANY(v_winners)` to every participant, at
the same point and in the same `ORDER BY user_id`. That is a superset taken
in the documented order, so the chain itself is unchanged — and it is why
`_rank_apply_match()`, which runs last, never acquires a lock it does not
already hold.

Taking those extra locks late instead (inside the trophy step, after the
`skill_ratings` locks) would invert the chain and deadlock two bouts
settling over an overlapping field. Don't.

### `settle_match()` placement

One `PERFORM public._rank_apply_match(p_match_id, v_winners, NULL)` after
the payout and after `_mmr_rate_match()`, before `settled_at` is stamped.
Same bargain the rating already makes:

- `needs_review` awards nothing and awards normally on the later call that
  clears it, from the standings as they are *then*;
- `already_settled` returns before reaching it;
- a trophy write that fails takes the whole settlement down, rather than
  leaving a paid-out bout with no record of itself on the ladder.

Winners are **passed in**, not recomputed. `settle_match()` has already
decided who won in order to pay the pot; recomputing inside the trophy step
would open the possibility of the trophies going to someone the money did
not.

### Reading the ladder: three SECURITY DEFINER functions

`fitness_profiles_select_own` means a client can read exactly one profile.
A leaderboard is the opposite, so this is a deliberate, narrow widening:

- `leaderboard_page(p_scope, p_limit, p_offset)` → `SETOF leaderboard_row`
- `leaderboard_self(p_scope)` → one `leaderboard_row`, the caller's own
- `rank_standing()` → the caller's counters + `global_rank`

**Exactly what is exposed about a stranger**: `username`, `display_name`,
`avatar_url`, `trophies`, `league`, `rank`. Nothing else. Balance,
`strength_tier`, gender, age band, e-mail and MMR stay unreadable — the db
test asserts the returned key set exactly, so widening it needs a
deliberate edit that fails that test. The handle and the picture are
already effectively public (the `avatars` bucket is world-readable by
design, and the point of a username is that opponents see it); the trophy
count and the league *are* the leaderboard.

A composite return type rather than `RETURNS TABLE` on purpose: `OUT`
parameters are plpgsql variables, and half of these names (`user_id`,
`trophies`, `username`) are also column names in the query underneath them.

**"Friends" means fighters you have shared a bout with**, plus yourself.
There is no follow graph in this schema, and inventing one to satisfy the
word would be a social feature smuggled in under a leaderboard — a new
table, a consent flow and a moderation surface, none of which was asked
for. Who you have fought is a real relationship the database already holds,
it is symmetric, and it needs none of that. `_leaderboard_scope()` is the
one place that changes if a follow graph ever lands. Friends rows are
ranked **within the scope** (1, 2, 3…), not by their global place.

**Deleted accounts are excluded.** `delete_my_account()` bans the auth row
rather than removing it (bout history on both sides has to survive), so the
ban is the marker for "no longer a player". `_leaderboard_scope()` joins
`auth.users` and drops anyone with `banned_until > now()`.

### Two backfills

1. **Usernames.** `20260907000000` backfilled them from the sign-up handle,
   but nothing since sets one — `fitness_profiles` rows are created by the
   app with a `user_id` and a tier only, and Settings > Profile is the sole
   writer. Invisible while a profile was something only its owner could
   read; a leaderboard makes it visible. The same backfill runs again over
   whoever has arrived since. Idempotent — it only touches NULL usernames.
2. **The ladder itself.** Every settled `pushups`/`plank`/`wallsit` match
   is replayed in `settled_at` order through `_rank_apply_match()` — the
   same function settlement calls — so backfilled trophies, streaks,
   counters and history rows are produced by exactly the rules a bout
   settling a minute from now will use, streak bonus and all. Everyone who
   has fought arrives on the new ladder with the record they earned rather
   than at zero with an empty timeline. `race` is skipped (settlement has
   never been implemented for it) and a `needs_review` bout has no
   `settled_at`, so neither can appear.

### What the tests cover

- `__tests__/rank.db.test.ts` — 27 tests against a real embedded Postgres
  with every migration replayed: the seed and the client mirror agreeing on
  thresholds/ceilings/colours, `league_for()` at every boundary, the award
  schedule, the streak compounding over a six-win run and resetting on a
  loss, the zero floor, promotion and demotion rows, the group-battle tie,
  `needs_review` awarding nothing until it is cleared, exactly-once under
  repeated `settle_match()` calls, `rank_history` RLS, leaderboard ordering
  and paging, the exposed key set, the friends scope, a deleted account
  dropping off the board, and `rank_standing().global_rank` agreeing with
  the page the board would draw.
- `__tests__/league.test.ts` — 25 tests over the pure display rules.
- `__tests__/rank.screen.test.tsx` — 18 tests mounting the screen with
  Supabase faked: the hero, the server-sent thresholds winning over the
  mirrored ones, Max Rank replacing the bar at Diamond, the pinned self
  row, the scope switch, the timeline, and a realtime payload raising the
  count and firing the celebration.

The existing `matchmaking.db.test.ts` and `skillRating.db.test.ts` suites
pass unchanged against the rewritten `settle_match()`, which is the main
evidence that widening the lock and folding the trophy step in broke
nothing.

### What is NOT verified

1. **Nothing has run through PostgREST.** The three new RPCs are called
   through `supabase.rpc()` in the hooks and are typed, but no test crosses
   the wire. A composite return type (`leaderboard_row`) is the one shape
   here whose PostgREST JSON encoding is worth eyeballing on first run: it
   should arrive as an array of objects for `leaderboard_page` and a single
   object for `leaderboard_self`.
2. **The realtime path is faked in the screen test**, exactly like
   `searching.test.tsx` — the handler is invoked directly. That Supabase
   actually delivers a `fitness_profiles` UPDATE carrying the six new
   columns is unproven here, though the publication membership it relies on
   was confirmed on 2026-09-04.
3. **No EAS build carries any of this yet.** The Rank tab does not exist on
   anybody's phone until one ships.

### The backfill bug, and `20260913000100_rank_backfill_from_settlement`

`20260913000000` was applied on 2026-09-13 and its replay was **wrong**.
Worth reading before writing any other backfill over settled bouts.

The replay recomputed each historical bout's winners from the recorded
scores, using `settle_match()`'s own `max()` rule. That is correct for a
bout settling *now* — `settle_match()` passes the winners it has just paid
the pot to — but it is wrong looking backwards, because a score column and
a settlement outcome can disagree about a bout that is already over.

On the live project they did. All eleven settled bouts there ended
`winner_id IS NULL` with every fighter refunded — ties — but two of them
have a score recorded for one fighter and `NULL` for the other (they
predate the null-score guard `settle_match()` has carried since
`20260908000000`). `max()` ignores NULLs, so the replay elected the scored
fighter as a sole winner and charged the other a loss: **trophies awarded
against the money**, and a Rank screen that would have shown 1W–1L for two
fighters the Profile screen reads as 8 and 10 ties.

Caught by comparing the backfilled columns against what
`deriveBoutStats()`/`outcomeOf()` derive from the ledger for the same
fighters — a check worth running after any backfill that claims to
reproduce a screen's numbers.

The fix migration adds `_rank_winners_of_settled(match_id)`, which reads
the outcome rather than re-deciding it:

```
winner_id IS NOT NULL  -> that one fighter won
winner_id IS NULL      -> everyone who received a payout shared it
no payout at all       -> nothing can be said; skip the bout
```

— exactly how `outcomeOf()` has always told a shared win from a loss. It
then clears the ladder and replays every settled bout through
`_rank_apply_match()` again. Clearing rather than patching keeps one code
path producing every trophy in the database and makes the migration
idempotent.

`settle_match()` is NOT touched by the fix: it still passes the winners it
paid, which is the same set this function would derive.

### Deploy status: applied 2026-09-13

Both migrations applied to the live Supabase project on **2026-09-13** via
`npm run db:deploy`. Verified independently afterward, from the live
database rather than from the CLI's exit code:

- `league_tiers` holds exactly the five seeded rows with the thresholds,
  ceilings and colours the client mirrors.
- All six columns exist on `fitness_profiles`, `NOT NULL` with the right
  defaults; `rank_history` has all eight columns.
- `league_for`, `_rank_apply_match`, `_rank_winners_of_settled`,
  `rank_standing`, `leaderboard_page`, `leaderboard_self` and
  `_leaderboard_scope` all exist, with `SECURITY DEFINER` set on exactly
  the five that need it.
- Client grants are `SELECT` and nothing else on `league_tiers` and
  `rank_history`; both RLS policies exist.
- The widened pre-lock is present in the live `settle_match()` source
  (read out of `pg_proc.prosrc`, not assumed), and the body calls
  `_rank_apply_match`.
- `signups` and all 23 `auth.*` tables untouched.

Backfill result, after the fix migration: all 11 settled bouts on the
ladder, 22 `tie` rows and 1 `promotion`, and four invariants at zero —
`sum(trophy_delta)` equals `trophies` for every fighter, `current_league`
equals `league_for(trophies)` for every fighter, nobody holds a `win`/`tie`
row for a bout `_rank_winners_of_settled()` says they did not win, and no
settled bout is missing from the ladder. The stored record now agrees
fighter-for-fighter with what `deriveBoutStats()` derives.

**Every historical bout on this project was a tie**, so the seeded ladder
is all tie awards: amukunth0 60 (Silver), hiddenmanand 48, ronitkongara 18,
aishaj2364 6, claudetest 0. Those eleven bouts are mostly score-less test
data; if they are ever purged, re-running the replay in
`20260913000100` against the remaining matches is what rebuilds the ladder.

**Not yet done: an EAS build carrying the client half.** The database is
ready; the Rank tab does not exist on anybody's phone until one ships.

## Blitz, Streak, and ranked/casual (2026-09-16)

Two new solo formats and a switch that runs across every format. All three
share one migration, `20260916000100_solo_modes_ranked_casual` (preceded by
the enum-only `20260916000000_solo_mode_formats`, split out for the same
"cannot use an enum value in the transaction that adds it" reason as every
other enum-extension migration in this project — see
`20260903200000_add_needs_review_status`).

```
blitz_runs             one solo set against three ascending thresholds
streak_runs            up to three stages, staked once
streak_stage_attempts  one row per stage attempt, INCLUDING buy-backs
challenges.is_ranked   whether a bout moves skill_ratings at all
_solo_target_for_rating()   rating -> percentile -> raw score, per exercise
_mmr_rate_solo()       one Elo update against a virtual opponent
settle_match()         forks to _solo_settle() for one-seat bouts
```

### The design decision: one seat, the whole existing pipeline

A Blitz or Streak attempt is a `Challenge` with `max_participants = 1`,
created already `matched` (there is no lobby to fill), running through
`match_participants`, `verification_sessions`, the anomaly gate,
`points_ledger_entries` and `Results` exactly like a 1v1. Two dedicated
tables (`blitz_runs`, `streak_runs`/`streak_stage_attempts`) hold only what
a head-to-head bout doesn't need: the calibrated thresholds, the virtual
opponent's rating, and — for Streak — which stage a run is on.

The alternative (a fully separate solo pipeline) was rejected because
`submit_verification_session()` is the *only* path a camera result can
reach the database by. A parallel entry point would need its own anomaly
gate, its own `needs_review` handling, and its own place in the open-round
guard (`_solo_start_guard()` reuses `_mm_open_round_blocks_for()`'s exact
predicate) — three things kept in step with the 1v1 path today, and three
things that could drift from it otherwise.

### Blitz: the multiplier/MMR calibration

The three tiers are **rating offsets**, not multiples of a base score:

```
_solo_blitz_tier_offsets()  {0, +150, +320}
_solo_blitz_tier_bp()       {15000, 20000, 25000}   (1.5x / 2x / 2.5x)
```

Tier *i*'s **target** is `_solo_target_for_rating(exercise, mmr + offset_i,
gender, age_band)` — the raw score whose population percentile (from
`performance_norms`, the same table `20260910000000`'s placement seed
reads) maps back to that rating, via `_solo_percentile_for_rating()` (the
exact inverse of `_mmr_from_percentile()`) and `_perf_raw_from_anchors()`
(the exact mirror of `_perf_percentile_from_anchors()`, with the raw/
percentile axes swapped).

This is the whole reason a rating offset was chosen over a flat multiplier
on the fighter's median: push-ups and a plank have wildly different
spreads (male 20s: push-ups P25=17/P50=30/P75=47, spread σ≈0.75 in log
space; plank P25=81/P50=106/P75=130, σ≈0.19). A flat "1.75× your median"
would be a ~1σ stretch on push-ups and a ~2.9σ stretch on a plank — the
same printed number, a coin flip in one exercise and a once-a-year event in
the other. Defining every tier in rating space and converting through the
norms curve makes the *difficulty* identical by construction, because the
curve absorbs each exercise's own spread.

It also makes the virtual opponent **exact rather than invented**: the
implied rating of a threshold *is* the rating it was calibrated from, so
the Elo expectation against it is, by definition, the probability a
fighter at that rating clears it —

```
E(clear tier 1) = 0.500   E(clear tier 2) = 0.297   E(clear tier 3) = 0.137
P(land exactly tier 1) = 0.203, tier 2 = 0.160, tier 3 = 0.137, miss = 0.500
EV per stake = 0.203·1.5 + 0.160·2.0 + 0.137·2.5 ≈ 0.97
```

(the exactly-tier probabilities come from the tier boundaries, not
directly from the "at least" E values above). Streak's chain of three
per-stage E-values compounds to `0.760·0.640·0.500 ≈ 0.243`, paid at 4.0x,
for the same ~0.97 EV. **Both land just under 1.0 on purpose** — a solo
wager that paid at or above parity would inflate the points economy with
no second stake feeding the pot, and the ~3% shortfall is the entire
reason a wager against yourself can exist at all.

⚠️ **This EV is a model, not a measurement.** It assumes a fighter's actual
rep/hold distribution matches the population percentile curve their rating
sits on — the same assumption `20260910000000`'s placement seed already
makes, and just as unverified against a real set. See "What is NOT
verified" below.

Two more calibration details worth knowing:

- **Rounding can collide.** Two adjacent tiers can round to the same
  integer, most easily on a hold (5-second step) at a low rating where the
  percentile curve is flat. `_blitz_ladder()`/`_streak_view()` force each
  tier at least one step above the one below it, which keeps the printed
  ladder strictly ascending (`blitz_runs_targets_ascending`,
  `streak_runs_targets_ascending`) at the cost of making a nudged tier
  *very* slightly harder than its nominal rating — the fighter is never
  paid more than the bar they actually cleared, which is the right side to
  err on.
- **Missing demographics.** `gender`/`age_band` are optional and always
  will be. No age band → `_solo_default_age_band()` returns `'20s'`, the
  one band every source table is actually anchored at. No gender → the
  target is the **mean of the male and female curves at the same
  percentile**, not a default sex — the most that can honestly be said
  about someone who didn't say. `calibrated_to_me` on both preview rows
  tells the client which case it's in, and `SOLO_CALIBRATION_ROUGH` in
  `src/theme/copy.ts` is the copy that results.

### The virtual-opponent rating approach

`_mmr_rate_solo()` is `_mmr_rate_match()`'s N=1 case, stated as its own
function rather than a special case inside the group-battle loop:

```sql
v_k := placement_complete ? K_settled : K_placement;   -- same schedule
v_s := cleared ? 1 : 0;                                -- win/loss, no ties
v_delta := round(v_k * (v_s - _mmr_expected(mmr, opponent_rating)));
v_after := greatest(_mmr_floor(), mmr + v_delta);      -- same floor
-- one skill_rating_events row, participants = 1
```

Everything is the *same* Elo as a 1v1 — same `_mmr_expected()`, same K
schedule, same floor, same event table — because the point of a virtual
opponent is that a solo result is commensurable with a head-to-head one:
clearing your own bar gains what beating an equal opponent gains.

What's different, and deliberately:

- **`participants = 1`** on the event row, not padded to 2. There is no
  `(N−1)` divisor to apply (division by 1 is a no-op in any case), and the
  column records the truth about the bout.
- **The opponent's rating never moves.** It isn't a rating, it's a bar — no
  `skill_ratings` row exists for it and none is written to.
- **Blitz always rates off `tier1_rating`**, never the top tier actually
  reached. Rating the top tier instead would make Blitz the one place
  margin of victory is weighted — see "Deliberately not built" under the
  original skill-rating section; this project has never done that anywhere
  else, and Blitz doesn't start.
- **A Streak stage rates off *that stage's own* rating** — stage 3's
  offset is zero, so the last stage of a run is, rating-wise, a fight
  against your unmodified self.
- **One update per attempt, including retries.** `_mmr_rate_solo()` is
  called once per settled match, and a Streak buy-back opens a new match
  (`streak_stage_attempts` gets a new row, `attempt_no` incremented) — so
  "one Elo update per stage attempt, including retries" falls out of the
  one-attempt-one-match design rather than needing a separate counter.

### The ranked/casual data model

One column, `challenges.is_ranked`, snapshotted onto `matchmaking_queue`
for pairing and read straight off the challenge row at settlement:

```
enter_matchmaking(..., p_is_ranked boolean DEFAULT false)
blitz_start(..., p_is_ranked boolean DEFAULT false)
streak_start(..., p_is_ranked boolean DEFAULT false)
```

**Casual is the default everywhere** — the column default, every RPC's
default, and the client's initial state on every screen that starts an
attempt (`FindBoutScreen`, `BlitzPreScreen`, `StreakPreScreen` all call
`setMode('casual')` on mount/focus, never read a persisted value). Ranked
requires an explicit tap on `RankedToggle`, every single time.

**Ranked and casual are two separate matchmaking pools.** `_mm_find_lobby()`
gained `AND c.is_ranked = p_is_ranked` alongside its existing exercise/
format/seats/stake predicate — a casual search cannot fill a ranked lobby
or vice versa, because a bout cannot be half-rated. The advisory-lock
domain key (`_mm_domain_key()`) was deliberately **not** split the same
way: it still hashes only `(exercise, format, seats)`, so the ranked and
casual pools for one domain serialise against the same lock. That's
slightly more contention than necessary and is the right trade — the key
is recomputed from a queue row in four separate call sites, and a key that
could disagree with itself across them would be a silent correctness bug,
not a slow one.

**What casual skips, and what it doesn't.** The spec is exactly: casual
"does not affect MMR, matches_played, or placement" — the three columns of
`skill_ratings`. So `settle_match()` and `_solo_settle()` gate exactly one
call each behind `is_ranked`: `_mmr_rate_match()` / `_mmr_rate_solo()`. A
casual bout writes **no** `skill_ratings` row, **no**
`skill_rating_events` row, and doesn't increment `matches_played` — which
is what keeps it out of the five-bout placement count too, since placement
is derived from that same counter.

`_rank_apply_match()` — trophies, `total_wins`/`total_losses`/`total_ties`,
`current_streak`, `rank_history` — is **NOT** gated on `is_ranked`, and
runs for a solo attempt not at all (see below). That is a defensible
reading of the spec ("does not affect MMR, matches_played, or placement" —
three specific things, not "the trophy ladder too") and it is not the only
possible one; flipping it is a single `IF v_challenge.is_ranked` wrapped
around the one `_rank_apply_match()` call inside `settle_match()`. Called
out explicitly so the decision is visible rather than assumed. See "Why two
ladders is not one ladder too many" further up this file for what the two
ladders are for.

**Solo attempts get neither ladder.** `_solo_settle()` calls
`_mmr_rate_solo()` (gated on `is_ranked`, same as above) but never calls
`_rank_apply_match()` at all — a bar you set for yourself is not a person,
and the trophy ladder is specifically the record of beating people. This
*is* a product decision (not implied by the ranked/casual spec, which is
silent on trophies for solo modes) and it's the one most likely to be
revisited; flipping it needs a `winners` array shaped for one seat, not
just an `IF`.

**Placement.** "Only ranked attempts count toward the existing 5-bout
placement requirement" is true by construction, not by a separate check:
`matches_played` only increments inside `_mmr_rate_match()` /
`_mmr_rate_solo()`, both of which only run for `is_ranked = true`. A
fighter who plays ten casual bouts and then one ranked one is still
unplaced after that first ranked bout — 1 of 5 — exactly as if the ten
casual ones never happened, because as far as placement is concerned, they
didn't.

**Backfill.** Every already-`matched`/`completed`/`needs_review` challenge
at migration time was backfilled to `is_ranked = true` (it already *had*
moved a rating, so it has to keep reading as ranked forever — the Results
screen's badge is not allowed to retroactively change what a settled bout
counted for). A live `open` lobby was left at the new column's default,
`false`: at deploy time it's a search in flight with no ranked/casual
opinion of its own, and the alternative (`true` on the lobby, `false` on
its queue rows) would strand it against a pairing predicate it could never
satisfy. It either fills normally under the casual default or expires on
the ordinary 20-second TTL, same as any other stale search.

### The two Streak timers — same duration, not the same clock

Both are five hours; that's the only thing they share.

```
_streak_buyback_window()   5h from streak_runs.failed_at
                            While open: streak_buy_back_in() may retry
                            THE FAILED STAGE, for another stake, without
                            losing any earlier stage.
                            Once closed: the run is spent. The NEXT call to
                            streak_start() begins a brand new run at stage 1,
                            calibrated fresh against whatever the fighter's
                            rating is by then.

_streak_win_cooldown()     5h from streak_runs.completed_at
                            While open: streak_start() refuses outright
                            ('streak_cooldown') for that exercise. Every
                            OTHER mode (1v1, pooled, Blitz, the other two
                            exercises' Streak) is unaffected.
                            A FAILED run has no cooldown at all — only the
                            buy-back window above applies to it.
```

Neither deadline is **stored**. `streak_preview()` (via `_streak_view()`,
shared by every Streak RPC so the state machine is decided in exactly one
place) computes `buyback_until`/`cooldown_until` from the anchor timestamp
at read time, and derives `state` — `'idle' | 'active' | 'failed' |
'expired' | 'cooldown'` — from *that*, not from a fourth stored status
value. `'expired'` and `'cooldown'` are the same underlying row
(`status = 'failed'` / `status = 'won'`) read against a clock that has run
out; changing either tunable therefore re-judges every live run
immediately, with no migration and no cron needed to "expire" anything.

**`failed_at` is deliberately not cleared by a buy-back.** `streak_runs`
holds only the most recent failure; `streak_stage_attempts` is the full
history (`attempt_no` per stage, `is_buy_back` marking which ones cost a
stake). If a bought-back attempt fails *again*, `_solo_settle()`
overwrites `failed_at`/`failed_stage` with the new failure — the window
**re-anchors** to it rather than inheriting whatever was left of the old
one. Asserted directly in `soloModes.db.test.ts` ("re-anchors failed_at
when a bought-back attempt fails again").

Both timestamps are rendered client-side against `streak_preview()`'s own
`server_now`, never against `Date.now()` (see `remainingMs()` in
`src/lib/soloModes.ts` and `useCountdown()`, which measures elapsed
*screen* time via `Date.now()` differences and lets the server's own clock
carry the absolute deadline) — a phone with a skewed clock sees the real
remaining time instead of its own opinion of it.

### Stage-persistence behaviour

A run's `current_stage` only advances on a **clear**, inside
`_solo_settle()`; nothing else moves it. Concretely:

- Clearing stage 1 or 2 sets `current_stage = current_stage + 1` and stops
  — it does **not** open the next stage's camera round.
  `streak_next_stage(run_id)` is a separate RPC the client calls only when
  the fighter taps the "start stage N" button on the stage-cleared screen
  (`StreakRunScreen`'s middle state). Folding the two together would drop
  a fighter into a live staked round while they were still reading the
  number they'd just hit.
- Clearing stage 3 pays out, sets `status = 'won'`, and leaves
  `current_stage` at 3.
- Failing any stage sets `status = 'failed'` and leaves `current_stage`
  **unchanged** — this is the literal mechanism behind "retrying the same
  stage without losing progress": a buy-back re-opens a round for
  whatever `current_stage` already says, and every earlier stage's cleared
  attempt is still sitting in `streak_stage_attempts`, untouched.
- `streak_stage_attempts_one_open_per_run` (a partial unique index on
  `run_id WHERE settled_at IS NULL`) makes "one live camera round per run"
  a database fact, not an app-level promise — `streak_next_stage()` is
  written to be idempotent against a double tap for exactly this reason
  (it returns the existing open attempt instead of trying to insert a
  second one, which the index would reject anyway).
- `streak_runs_one_active_per_exercise` (partial unique on `(user_id,
  exercise_type) WHERE status = 'active'`) makes "the run that matters"
  well-defined even against two devices racing `streak_start()` — the
  app-level guard in `streak_start()` is real (and fires first, as
  `round_open`, if a camera round happens to be open at that exact
  moment), but the index is what actually prevents two active rows,
  independent of whether the guard was reached at all. Both paths are
  exercised directly in `soloModes.db.test.ts`.

### Lock order — appended at the same end as every prior addition

```
lobby `challenges` row -> member `matchmaking_queue` rows
  -> `fitness_profiles` rows ORDER BY user_id
  -> `skill_ratings` rows ORDER BY user_id
  -> [new] blitz_runs / streak_runs / streak_stage_attempts
```

A solo attempt has exactly one of each row in the chain, so it cannot
deadlock against itself. `blitz_start()`/`streak_start()`/
`streak_buy_back_in()` take the one `fitness_profiles` row `FOR UPDATE`
(to debit a stake) and nothing else; `_solo_settle()` takes
`fitness_profiles` then `skill_ratings`, in that order, exactly as the 1v1
settlement path does. Nothing else ever locks a `blitz_runs`/
`streak_runs`/`streak_stage_attempts` row, and nothing they lock is taken
again afterward.

### Screens

Two new pre-bout screens and one new "what happened" screen, all reached
from `FindBoutScreen`'s format picker (now five options: `1v1`, `pooled`,
`blitz`, `streak`, and the still-unbuilt `Bracket` placeholder):

- **`BlitzPreScreen`** (new) — the calibrated ladder, the stake picker, the
  ranked/casual toggle, one `blitz_preview()` read and one `blitz_start()`
  write. Nothing is staked until START.
- **`StreakPreScreen`** (new) — the mode's one front door. Renders all five
  `streak_preview()` states: `idle` (three stages + stake + toggle),
  `active` (resume), `failed` (buy-back offered, countdown visible even
  from *this* screen, not only from `StreakRunScreen`), `expired` (says a
  fresh run starts at stage 1), `cooldown` (**locked and visibly
  countdown-shown**, never hidden — see the spec's own requirement 2).
- **`StreakRunScreen`** (new) — where a stage attempt lands after the
  camera: cleared (brief transition + "start next stage" button),
  failed (buy-back CTA + live countdown, reachable from the failure itself
  or later from `StreakPreScreen`), won (payout/celebration, distinct
  watermark and copy from the 1v1 win screen, cooldown timer shown inline).
  Keyed on **run id**, not match id — all three states are facts about the
  run, and the run outlives any one stage's match.
- **`MatchInProgressScreen`** (modified) — reads the challenge's `format`
  and, for a solo bout, the run's snapshot (`blitz_runs` or the
  `streak_stage_attempts` row + its `streak_runs` parent) alongside the
  existing challenge/participant reads. The opponent strip is replaced by
  a bar strip (which tier is banked / which stage is being chased); a new
  progress line under the live counter shows the next threshold and a row
  of tier pips for Blitz. On submit, a solo round routes straight to its
  own result screen (`Results` for Blitz, `StreakRun` for a Streak stage)
  rather than through the shared "no decision yet" pending state, since a
  one-seat bout settles the instant it's recorded — there's no field to
  wait on.
- **`ResultsScreen`** (modified) — forks to a new `BlitzResult` component
  (the ladder with the cleared rung marked, distinct win/loss framing from
  a 1v1) when the challenge is a settled Blitz; redirects (`replace`) a
  Streak stage's match straight to `StreakRun`, since everything a fighter
  needs after one is a fact about the run, not the match. Every kind
  screen (win/loss/tie/pending/review) now shows a `RankedBadge`.
- **`FindBoutScreen`** (modified) — Blitz/Streak push their own pre-bout
  screens instead of staking through this one; the stake picker and
  `RankedToggle` hide for a solo format (its own screen owns both).
- **`SearchingScreen`** (modified) — shows a `RankedBadge` next to the
  format tag, so the pool a live search is in is visible while waiting,
  not only after.

New shared primitives in `src/theme/ui.tsx`: `RankedToggle` (the two-way
switch, Casual first and selected) and `RankedBadge` (the after-the-fact
pill, rendered for casual too — an absent badge would be indistinguishable
from a screen that predates badges, which is exactly the ambiguity a badge
exists to remove).

### Testing

`__tests__/soloModes.test.ts` — pure client logic, no database: multiplier/
target formatting, `tierReachedFor()`/`nextTierFor()` against a hand-built
ladder, both countdown helpers (including that `remainingMs()` never goes
negative and correctly subtracts elapsed screen time), and every stable
error code `soloErrorCopy()` maps.

`__tests__/soloModes.db.test.ts` — against the same embedded-Postgres
harness every other `.db.test.ts` uses: the calibration round-trips
(rating → target → rating, within the same rounding tolerance
`_mmr_seed_from_norms()`'s own round-trip is held to), `blitz_preview`/
`blitz_start`/settlement across all four tiers (0 through 3) including that
margin above a tier doesn't change the rating move, a casual Blitz paying
identically while rating nothing, the anomaly-hold-and-clear path, a full
three-stage Streak win (three separate `skill_rating_events` rows, one per
stage attempt), the win cooldown blocking and then releasing a fresh
`streak_start()`, a failure preserving `current_stage` while charging
nothing extra, buy-back-in re-charging the stake and preserving progress,
the buy-back window actually expiring (`streak_buy_back_in` rejected,
`streak_preview` reporting `'expired'`), `failed_at` re-anchoring on a
second failure, the ranked/casual matchmaking pools genuinely not pairing
with each other, `enter_matchmaking` rejecting a solo format outright, a
casual 1v1 settling fully while writing no rating row (trophies still move
— the other-ladder assertion), and that the RLS/grant surface (`blitz_runs`/
`streak_runs`/`streak_stage_attempts`) matches every other rating table's
own-rows-only, no-client-write shape.

`__tests__/skillRating.db.test.ts` and `__tests__/performanceNorms.db.test.ts`
needed one change each: their `enter()`/`stage()` test helpers now pass
`p_is_ranked = true` explicitly (via a new fifth `enter_matchmaking`
argument, or a direct `is_ranked = true` column on a hand-staged
challenge). Both suites are specifically exercising the Elo/norms
arithmetic, which since this migration only runs at all for a ranked bout
— a fighter who forgot to opt in the way these helpers used to would
previously have been silently rated regardless; now they wouldn't be, and
the suites had to say so explicitly rather than relying on it happening by
default.

### ⚠️ What is NOT verified

- **The EV model.** Every "just under 1.0" number above assumes a
  fighter's actual score distribution matches the population percentile
  curve their rating sits on — untested against any real attempt. If real
  play skews easier or harder than the norms table implies, the house edge
  moves with it, in either direction.
- **No real attempts have been played.** Every number in this section
  comes from `soloModes.db.test.ts` calling the RPCs directly against a
  synthetic Postgres — never through `submit_verification_session()` fed
  by an actual camera session, never on a real phone, never through
  PostgREST. The camera HUD additions to `MatchInProgressScreen` (the tier
  pips, the "next tier at X" progress line, the stage/bar strip) are typed
  and unit-testable in isolation but have not been seen rendering live
  against real `onUpdate` events.
- **Rounding-collision nudging** (`_blitz_ladder()`/`_streak_view()`
  forcing an adjacent tier at least one step above the one below) is
  exercised only at the ratings the calibration test picks, not swept
  across the full rating range — a low-rated fighter on a coarse-stepped
  exercise (wall-sit, 5-second steps, at a rating where the percentile
  curve is nearly flat) is the scenario most likely to collide and least
  likely to have been hit by the current tests.
- **Deliberately not built:** a Bracket format (still a placeholder label
  in `FindBoutScreen`), a solo mode contributing to the trophy ladder (see
  "Solo attempts get neither ladder" above), and a UI affordance for
  starting a Streak run at a stage other than 1 after an *expired* buy-back
  — the spec is explicit that this restarts at stage 1, and that's what's
  built, but there's no "are you sure you want to lose the old progress"
  confirmation on the way there, because by the time the window has
  closed there's nothing left to confirm losing.

### Deploy status: applied 2026-09-16

Both migrations were deployed to the live Supabase project on **2026-09-16**
via `npm run db:deploy` and verified independently afterward (introspection
queries against the live database, not the CLI's exit code):

- `ChallengeFormat` is exactly `{pooled, 1v1, blitz, streak}`; `blitz_runs`,
  `streak_runs`, `streak_stage_attempts` all exist; `challenges.is_ranked`
  and `matchmaking_queue.is_ranked` both exist.
- All eight new/changed functions exist (`blitz_preview`, `blitz_start`,
  `streak_preview`, `streak_start`, `streak_next_stage`,
  `streak_buy_back_in`, `_solo_settle`, `_mmr_rate_solo`), and
  `enter_matchmaking` has exactly **one** signature in `pg_proc` (the old
  four-argument overload was dropped, not left ambiguous alongside the new
  five-argument one).
- RLS is enabled on all three new tables, each with exactly one
  `..._select_own` SELECT policy; `blitz_start`/`streak_start` carry the
  same `EXECUTE` ACL shape (`authenticated`, `service_role`, owner —
  no `anon`) as the pre-existing `enter_matchmaking`/`settle_match`.
- All seven `CHECK` constraints named in this section
  (`challenges_solo_has_one_seat`, `matchmaking_queue_no_solo_formats`,
  both `..._targets_ascending`, both `..._settled_is_complete`/
  `..._won_is_complete`, `streak_runs_failed_has_failure`) and both partial
  unique indexes (`streak_runs_one_active_per_exercise`,
  `streak_stage_attempts_one_open_per_run`) are present.
- The backfill produced exactly what was expected: all 11 pre-existing
  settled bouts read `is_ranked = true`; there were no live `open` lobbies
  at deploy time to fall through to the `false` default.
- `npx prisma migrate status` reports the schema up to date immediately
  after.

⚠️ **Not fixed, and not worth a migration for:** `authenticated` still
holds `REFERENCES`/`TRIGGER`/`TRUNCATE` on the three new tables (Supabase's
default privileges, minus the `INSERT`/`UPDATE`/`DELETE` this migration
explicitly revokes) rather than a clean `REVOKE ALL` + `GRANT SELECT`, which
is the tidier pattern `skill_ratings`/`rank_history` use. None of those
three grants are reachable through PostgREST's REST surface (it exposes
only `SELECT`/`INSERT`/`UPDATE`/`DELETE` as HTTP verbs), so this is a
cosmetic inconsistency with the rest of the schema, not a live gap — noted
here rather than silently left for someone to wonder about later.

**Still true:** no real attempt has been played through either mode —
every check above is schema/grant introspection, not a fighter clearing a
bar. See "What is NOT verified" above, which stands unchanged by a
successful deploy.
