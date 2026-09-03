#!/usr/bin/env node
/**
 * Fails the install if a required native patch did not actually land.
 *
 * Why this exists: `patch-package` is a devDependency applied via
 * postinstall. If it isn't installed (NODE_ENV=production, --omit=dev), or
 * if patches/ never reached the build (not committed, excluded by
 * .easignore), patch-package prints "No patch files found" and exits 0 —
 * so the install looks fine and the iOS build then fails much later in the
 * Xcode step with an unrelated-looking Swift error. `--error-on-fail` does
 * not cover that case: a missing patches directory is an early return, not
 * a failure.
 *
 * This asserts the patched bytes are present in node_modules, which is the
 * only thing that actually guarantees the build won't hit
 * "reference to member 'skipping' cannot be resolved without a contextual
 * type". See BACKEND.md.
 */
const fs = require('fs');
const path = require('path');

const CHECKS = [
  {
    file: 'node_modules/@quickpose/react-native/ios/QuickPoseView.swift',
    mustContain: 'case "skipping": return nil',
    mustNotContain: 'case "skipping": return .skipping',
    patch: 'patches/@quickpose+react-native+0.7.1.patch',
    why: "QuickPose's iOS bridge maps a FitnessFeature case that does not exist in the iOS SDK, which breaks the Xcode build.",
  },
];

let failed = false;

for (const check of CHECKS) {
  const target = path.resolve(process.cwd(), check.file);

  if (!fs.existsSync(target)) {
    // The package isn't installed at all — nothing to verify against.
    // Don't fail the install; a missing dependency surfaces on its own.
    console.warn(`verify-native-patches: skipped, ${check.file} not installed`);
    continue;
  }

  const contents = fs.readFileSync(target, 'utf8');
  const applied =
    contents.includes(check.mustContain) &&
    !contents.includes(check.mustNotContain);

  if (!applied) {
    failed = true;
    console.error(
      [
        '',
        `✖ Native patch NOT applied: ${check.patch}`,
        '',
        `  ${check.why}`,
        '',
        '  Likely causes:',
        '    - patch-package was not installed (installed with --omit=dev,',
        '      or NODE_ENV=production at install time). It is a devDependency.',
        `    - ${check.patch} did not reach this machine/build`,
        '      (not committed to git, or excluded by .easignore).',
        '',
        '  Fix, then re-run `npm install`. Do not ship this build — the iOS',
        '  Xcode step will fail with a misleading Swift error.',
        '',
      ].join('\n'),
    );
  }
}

if (failed) {
  process.exit(1);
}

console.log('verify-native-patches: ok');
