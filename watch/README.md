# Fittr Watch App: Phase 1 runbook (Mac + Xcode)

This folder is a **staging area**, not an Xcode target. It holds the Phase 1
Swift sources and this runbook until the watchOS target has been created in
Xcode on a Mac. Once the files are inside the Xcode-created target folder,
delete `watch/Sources` so there is one source of truth.

Phase 1 goal (from the brief): a watchOS companion target with one SwiftUI
screen and a START button that does nothing; `pod install` run and
`ios/Podfile.lock` committed; the watch app launches in the Watch Simulator;
the iPhone app still builds. **Stop and report after that.**

Everything below was verified on 2026-10-10 against the repo, React Native
0.87.1's pod hooks, the CocoaPods and Xcodeproj changelogs, Apple's
documentation and the EAS CLI source. Items marked *record* are facts only the
Mac can establish; note them for the Phase 1 report.

---

## 0. Before leaving Windows

1. Commit and push this folder and the `eas.json` change so the Mac can pull
   them (local `main` is one commit ahead of GitHub already):

   ```sh
   git add watch eas.json
   git commit -m "Stage the watchOS Phase 1 sources and runbook"
   git push origin main
   ```

   Do not sweep the ~76 uncommitted paper-money files into that commit.

2. On the Mac, clone **the FittrApp repository itself**
   (`https://github.com/Amukunth/Fittr.git`). The parent `fittr/` folder on
   Windows is a separate repo that holds FittrApp as a stale gitlink; never
   clone that, and never work from a OneDrive-synced copy.

## 1. Mac prerequisites

| What | Why |
| --- | --- |
| Xcode 26.x (anything at or above 16.1 passes React Native's check) | RN 0.87.1 raises "Please upgrade XCode" below 16.1. *Record the exact version.* |
| watchOS Simulator runtime (Xcode > Settings > Components) | Without it the watch scheme has no destination. Xcode pairs an iPhone + Watch simulator automatically. |
| Node 22.11 or newer, Ruby 2.6.10 or newer with Bundler | `package.json` engines; Gemfile. |
| `npm i -g eas-cli` and `eas login` (account mukunth123) | Only for step 8. |

Install JS and Ruby dependencies from the **repo root**. The tracked
`.bundle/config` puts gems in `vendor/bundle`, which is git-ignored only at the
root, so do not run `bundle install` inside `ios/`:

```sh
npm install            # postinstall must print "verify-native-patches: ok"
bundle install         # resolves cocoapods 1.15.2 + xcodeproj 1.25.1 under the current pins
```

Plain `npm install`, not `--omit=dev`: `patch-package` is a devDependency and
the QuickPose Swift patch must be applied before any `pod install`.

When Xcode offers **"Update to recommended settings"** for the project, decline
it (or review every checkbox). The project has no `ENABLE_USER_SCRIPT_SANDBOXING`
setting on purpose; turning sandboxing on breaks the "Bundle React Native code
and images" and CocoaPods script phases.

## 2. Baseline `pod install` (before touching the project)

```sh
cd ios && bundle exec pod install && cd ..
```

Expected, correct side effects on the first run (commit them):

- `ios/Podfile.lock` and `Gemfile.lock` appear (neither is git-ignored).
  `Podfile.lock` pins `QuickPoseCore`, `QuickPoseCamera` and `QuickPoseSwiftUI`,
  which the podspec declares without versions. *Record the QuickPoseCore
  version.*
- `ios/FittrApp.xcworkspace/` appears. Committing it is optional; EAS
  regenerates it.
- `ios/FittrApp.xcodeproj/project.pbxproj` changes: React Native's hooks write
  `PODFILE_DIR`, `USE_HERMES`, `REACT_NATIVE_PATH`,
  `CLANG_CXX_LANGUAGE_STANDARD = c++20`, `SWIFT_ACTIVE_COMPILATION_CONDITIONS`
  (Debug) and `-DRCT_REMOVE_LEGACY_ARCH=1`, and flatten the
  `OTHER_CPLUSPLUSFLAGS` array into a string. All project-level.
- `ios/FittrApp/Info.plist` gains `RCTNewArchEnabled = true`.
- `ios/FittrApp/PrivacyInfo.xcprivacy` is rewritten with the pods' aggregated
  required-reason APIs.

Then prove the toolchain before adding anything: open
`ios/FittrApp.xcworkspace`, scheme **FittrApp**, any iPhone simulator, Cmd-B.
(`npx react-native run-ios` also works; the CLI defaults to the scheme named
after the project and does not prompt when a second scheme appears later.)

Commit `ios/Podfile.lock`, `Gemfile.lock`, and the hook diffs to
`project.pbxproj`, `Info.plist` and `PrivacyInfo.xcprivacy` (plus the
workspace if you want it). Suggested message: "Add Podfile.lock from the first
Mac pod install; pin QuickPoseCore". This completes Phase 1 step 3.

## 3. Create the watch target in Xcode

File > New > Target... > **watchOS** > **App** > Next.

| Field | Value |
| --- | --- |
| Product Name | `Fittr` (this is the name shown on the watch) |
| Watch App for Existing iOS App | **selected**; companion = `FittrApp` |
| Interface / Language | SwiftUI / Swift |
| Include Notification Scene, tests | off |
| Bundle Identifier | Xcode derives `com.fittr.app.watchkitapp`. Keep it. |

Xcode creates the target **Fittr Watch App**, the folder
`ios/Fittr Watch App/`, an "Embed Watch Content" copy phase on FittrApp and a
target dependency. The seven existing FittrApp build phases keep their order;
do not reorder anything. Activate the new scheme when asked, but **leave it
unshared** (it then lives in git-ignored `xcuserdata`). EAS in non-interactive
mode sorts shared schemes and would pick "Fittr Watch App" before "FittrApp";
`eas.json` now pins `ios.scheme` to `FittrApp` as a second guard.

*Record from the new target's Build Settings:* the default
`WATCHOS_DEPLOYMENT_TARGET`, `SWIFT_VERSION`, `SWIFT_STRICT_CONCURRENCY`,
`SWIFT_APPROACHABLE_CONCURRENCY`, `SWIFT_DEFAULT_ACTOR_ISOLATION`,
`GENERATE_INFOPLIST_FILE`, the General tab's "Supports Running Without iOS App
Installation" state, and whether `objectVersion` at the top of
`project.pbxproj` changed from 54.

## 4. Fix the six things the template gets wrong for this repo

Do these **before** the next `pod install`.

1. **Convert the synchronized folder to a group.** Xcode 16 and later create
   the target's folder as a *synchronized folder*
   (`PBXFileSystemSynchronizedRootGroup`). The Gemfile pins
   `xcodeproj < 1.26.0`, and that gem aborts `pod install` with
   "RuntimeError - PBXGroup attempted to initialize an object with unknown ISA
   PBXFileSystemSynchronizedRootGroup" (support arrived in xcodeproj 1.26.0).
   In the Project navigator, right-click **Fittr Watch App** > **Convert to
   Group**. Verify:

   ```sh
   grep -c PBXFileSystemSynchronized ios/FittrApp.xcodeproj/project.pbxproj   # must print 0
   grep -m1 objectVersion ios/FittrApp.xcodeproj/project.pbxproj             # 54, or 70/77 (only a warning in xcodeproj 1.25.x)
   ```

   Alternative, only if you prefer to keep the synchronized folder: change the
   Gemfile to `gem 'cocoapods', '>= 1.16.2'` and `gem 'xcodeproj', '>= 1.27.0'`
   (1.27.0 reverted the build-setting change that caused React Native's pin;
   the pin is still in the RN 0.87 template but guards a fixed bug). EAS does
   not read the Gemfile at all (it runs plain `pod install` with the image's
   CocoaPods 1.16.2), so the pin only ever affects the Mac.

2. **Give the watch target its own privacy manifest.** React Native's
   `pod install` hook aggregates privacy manifests by default and adds the
   iOS app's `PrivacyInfo.xcprivacy` to the Copy Bundle Resources phase of
   *every* application-type target that lacks one, which includes a
   single-target watch app. With the watch group selected: File > New > File
   from Template... > Resource > **App Privacy**, name `PrivacyInfo.xcprivacy`,
   target membership = Fittr Watch App only. Leave it empty (no tracking, no
   collected data).

3. **Give the watch target an on-disk `Info.plist` seeded with three keys.**
   Select the target > **Info** tab > add a custom row `RCTNewArchEnabled`
   (Boolean, YES). Xcode creates `ios/Fittr Watch App/Info.plist` and sets
   `INFOPLIST_FILE` while keeping the rest generated. Then add
   `CFBundleVersion` = `$(CURRENT_PROJECT_VERSION)` and
   `CFBundleShortVersionString` = `$(MARKETING_VERSION)` to the same file (the
   indirection `ios/FittrApp/Info.plist` already uses). Reasons:
   - React Native's hook writes `RCTNewArchEnabled = true` into every
     `Info.plist` under `ios/` whose path lacks the substring `watchkitapp`
     (the folder is named `Fittr Watch App`). Pre-seeding the key makes the
     hook a no-op instead of a diff on every install. The key is inert on
     watchOS.
   - EAS's `appVersionSource: remote` writes `CFBundleVersion` and
     `CFBundleShortVersionString` only into targets that have an
     `INFOPLIST_FILE`; a purely generated plist is skipped, and Xcode's
     ValidateEmbeddedBinary step fails the build when the watch app's version
     differs from the companion's. Today both targets carry `1.0` / `1`, so a
     preview build passes; the first `production` build (autoIncrement) would
     not.

4. **One version for both targets.** `MARKETING_VERSION` and
   `CURRENT_PROJECT_VERSION` are target-level on FittrApp today, and the
   template writes an independent pair on the watch target. Move both settings
   to the project level (Project > Build Settings > Versioning) and delete the
   target-level copies from **both** targets, so a local bump is one edit.
   Confirm both targets resolve to `1.0` / `1`.

5. **Deployment target.** Set the watch target's `WATCHOS_DEPLOYMENT_TARGET`
   to **11.0**: same hardware as watchOS 26 (Series 6 and later, SE 2, Ultra),
   every API Phase 2 needs predates it, and un-updated watches and older
   simulator runtimes still run the app. Do not go below 10.0.

6. **Bundle id is a literal.** Build Settings > `PRODUCT_BUNDLE_IDENTIFIER`
   must read `com.fittr.app.watchkitapp` in both Debug and Release (EAS reads
   it per configuration). The companion key `WKCompanionAppBundleIdentifier`
   must equal `com.fittr.app`; Xcode set it. Never introduce a bundle-id
   variant for the iOS app without changing both.

Also, while in the scheme editor: **Edit Scheme > Test** for the FittrApp
scheme lists a `FittrAppTests` target that does not exist in the project
(stale template reference). Remove it and commit the scheme; do not let Xcode
create a replacement test target.

Leave `TARGETED_DEVICE_FAMILY = 1` on FittrApp alone: it is target-level and
the watch target carries its own (`4`). The project-level `SDKROOT = iphoneos`,
`IPHONEOS_DEPLOYMENT_TARGET`, `LIBRARY_SEARCH_PATHS`,
`CODE_SIGN_IDENTITY[sdk=iphoneos*]` and the folly C++ flags are inherited by
the watch target but are inert for a Swift-only `SDKROOT = watchos` target.

Signing: pick your Apple team on **both** targets (Signing & Capabilities) so
device runs work later; a Simulator build does not need it. Commit the
resulting `DEVELOPMENT_TEAM` lines for both targets or for neither; EAS
overrides signing either way. Add **no** capabilities in Phase 1 (HealthKit,
Background Modes and the usage strings are Phase 2 work).

## 5. Drop in the staged sources

Delete the two Swift files Xcode generated in `ios/Fittr Watch App/` (the
`@main` app file and `ContentView.swift`) and move ours in:

```sh
mv watch/Sources/FittrWatchApp.swift watch/Sources/ContentView.swift watch/Sources/FittrTheme.swift "ios/Fittr Watch App/"
```

Because the folder is now a classic group, add the three files to the group
in Xcode (right-click the group > Add Files to "FittrApp"..., target
membership = Fittr Watch App only, do **not** copy). Keep `Assets.xcassets`
from the template. If you want an icon now, reuse
`ios/FittrApp/Images.xcassets/AppIcon.appiconset/icon-1024.png` in the watch
AppIcon slot (it is opaque RGB, as watchOS requires; check the circular mask
in the Simulator). An icon is not needed for the Simulator run.

What the sources do: `FittrWatchApp.swift` is the `@main` entry;
`ContentView.swift` is the single screen (wordmark, one label, one lime START
button whose action only prints); `FittrTheme.swift` carries the design tokens
as sRGB colours and the button style. System font only; Anton and Inter
bundling is Phase 2 (`UIAppFonts` works on watchOS 2 and later).

## 6. `pod install` again and inspect the diff

```sh
cd ios && bundle exec pod install && cd ..
git diff --stat
grep -c PBXFileSystemSynchronized ios/FittrApp.xcodeproj/project.pbxproj   # still 0
git diff ios/FittrApp.xcodeproj/project.pbxproj | grep -i "watch"             # expect only your own target edits
```

Pods are linked into `FittrApp` only (the Podfile has one target block; do
not add a block for the watch target). The hook's `LIBRARY_SEARCH_PATHS`
fixer visits every native target but only acts on configurations that
already set that key, so the watch target's configurations stay clean.

## 7. Build and launch

1. Scheme **Fittr Watch App**, destination an Apple Watch simulator (paired
   to an iPhone simulator), Cmd-R. Expect: black screen, "FITTR" wordmark,
   "WATCH-VERIFIED" label, full-width lime START button; tapping it logs
   `START tapped (Phase 1: no-op)` in the console and nothing else happens.
   Try a 40 or 41 mm and a 45 or 46 mm simulator; the button must stay 44 pt
   tall and the wordmark on one line.
2. Scheme **FittrApp**, an iPhone simulator, Cmd-B and Cmd-R: the React
   Native app must be unchanged. Confirm the watch app is embedded:

   ```sh
   ls ~/Library/Developer/Xcode/DerivedData/FittrApp-*/Build/Products/Debug-iphonesimulator/FittrApp.app/Watch/
   ```

   should list `Fittr Watch App.app`.
3. `npx react-native run-ios` still picks the FittrApp scheme (no prompt).

Commit everything under `ios/Fittr Watch App/`, the `project.pbxproj` and
scheme changes, and delete `watch/Sources/`. Keep this README or move it to
`docs/`.

## 8. EAS (after the commit; step 1 consumes no build)

1. `eas credentials -p ios` **interactively** from the repo root. It parses
   the project, lists both targets, registers the App ID
   `com.fittr.app.watchkitapp`, reuses the distribution certificate and
   creates a provisioning profile for the watch target. A `--non-interactive`
   build before this fails with "EAS CLI couldn't find any credentials
   suitable for internal distribution". The Free plan allows 15 iOS builds
   per month, so set credentials up this way rather than through a build. If
   this command cannot list the watch target, the project file format is the
   suspect: re-check step 4.1.
2. Optional, once `Podfile.lock` is committed: add
   `"env": { "POD_INSTALL_DEPLOYMENT": "1" }` to the `preview` and
   `production` profiles so EAS runs `pod install --deployment` and fails
   loudly instead of re-resolving QuickPoseCore; and pin
   `"ios": { "image": "<image whose Xcode major matches the Mac's>" }`
   (the `latest` image on 2026-10-08 is `macos-tahoe-26.5-xcode-26.6`,
   CocoaPods 1.16.2).
3. `eas build -p ios --profile preview` (ad-hoc). For an on-wrist test prefer
   a TestFlight (`production`) build; whether an ad-hoc profile must also list
   the Apple Watch's UDID was not verified.
4. After the first build, unzip the IPA and diff
   `Payload/FittrApp.app/Info.plist` against
   `Payload/FittrApp.app/Watch/Fittr Watch App.app/Info.plist` for
   `CFBundleVersion` and `CFBundleShortVersionString`; they must match.

## 9. What to report back (Phase 1 checkpoint)

- Xcode version; `objectVersion` after Xcode saved the project; whether
  `pod install` printed the "Xcode project version ... higher than the latest
  supported by xcodeproj" warning.
- The template defaults recorded in step 3.
- `Gemfile.lock` versions (cocoapods, xcodeproj) and the `QuickPoseCore`
  version in `Podfile.lock`.
- Simulator screenshots: the watch screen on 41 mm and 45 mm; the iPhone app
  unchanged.
- Any Swift compile error in the staged files (they were written on Windows
  and could not be compiled there).

## Not in Phase 1 (for the record)

Phase 2 adds to the **watch** target: the HealthKit capability (creates
`Fittr Watch App.entitlements` and `CODE_SIGN_ENTITLEMENTS`), the Background
Modes capability with *Workout processing*, `NSHealthShareUsageDescription`
and `NSHealthUpdateUsageDescription` on its Info tab, and optionally
`NSLocationWhenInUseUsageDescription` for an `HKWorkoutRoute`. The same
HealthKit capability and usage strings must be added to the **iOS** target
before the phone can read a watch workout; nothing of that exists today. EAS
syncs capabilities to each App ID from each target's entitlements file, so
never enable them by hand in the developer portal.
