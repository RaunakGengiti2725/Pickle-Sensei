#!/usr/bin/env node
/**
 * ADVERSARIAL PASS 3 — mobile-ios-config — mutation harness (S6, S7, extras)
 *
 * Applies a HOSTILE configuration mutation to a scratch git worktree of the
 * pinned baseline commit (never to the real checkout), runs the Linux release
 * guards against it, and records whether each guard CAUGHT the mutation.
 *
 *   node scripts/attack/ios-config-3/mutation-harness.mjs [--out <dir>] [--only <name>[,<name>]]
 *
 * Guards exercised per mutation
 *   - jest  __tests__/wf/be-mobile-security-secrets.test.ts
 *   - jest  __tests__/wf/flow-app-store-compliance-ios-config.test.ts
 *   - node  scripts/check-ios-distribution.mjs
 *
 * A mutation is CAUGHT when at least one guard that is expected to catch it
 * exits non-zero. Guards named in `mustCatch` are asserted individually: if
 * any of them passes the mutated tree, that is an EVASION and the harness
 * exits 1 (a finding). Baseline (unmutated) is run first and must be green.
 *
 * Nothing under the real repo checkout is written; the worktree is a sparse
 * checkout at $ATTACK_WORKTREE (default /home/ubuntu/attack3/wt) with the
 * real node_modules symlinked in. Apple runtime behaviour is NOT claimed —
 * only what the Linux guards do or do not detect.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = path.resolve(HERE, '../../..');
const REPO_ROOT = path.resolve(MOBILE_ROOT, '../..');
const BASELINE_SHA = '4d812e1aa699014cc0521fd92fde66908043aaa8';
const WORKTREE = process.env.ATTACK_WORKTREE ?? '/home/ubuntu/attack3/wt';
const SPARSE_PATHS = [
  'apps/mobile',
  'packages',
  'supabase/functions/api',
  'native',
  'tools',
  'docs',
];

const args = process.argv.slice(2);
const argValue = flag => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT_DIR = path.resolve(
  argValue('--out') ?? path.join(REPO_ROOT, 'artifacts/attack-ios-config-3'),
);
const ONLY = argValue('--only')?.split(',').filter(Boolean);

fs.mkdirSync(OUT_DIR, { recursive: true });

function git(cwd, ...rest) {
  return execFileSync('git', ['-C', cwd, ...rest], { encoding: 'utf8' }).trim();
}

function ensureWorktree() {
  if (!fs.existsSync(path.join(WORKTREE, '.git'))) {
    git(
      REPO_ROOT,
      'worktree',
      'add',
      '--detach',
      '--no-checkout',
      WORKTREE,
      BASELINE_SHA,
    );
    git(WORKTREE, 'sparse-checkout', 'set', '--cone', ...SPARSE_PATHS);
    git(WORKTREE, 'checkout', '--detach', BASELINE_SHA);
  }
  const head = git(WORKTREE, 'rev-parse', 'HEAD');
  if (head !== BASELINE_SHA) {
    throw new Error(`worktree HEAD ${head} != baseline ${BASELINE_SHA}`);
  }
  for (const [link, target] of [
    [path.join(WORKTREE, 'node_modules'), path.join(REPO_ROOT, 'node_modules')],
    [
      path.join(WORKTREE, 'apps/mobile/node_modules'),
      path.join(MOBILE_ROOT, 'node_modules'),
    ],
  ]) {
    if (!fs.existsSync(link)) fs.symlinkSync(target, link);
  }
  const dirty = git(
    WORKTREE,
    'status',
    '--porcelain',
    '-uno',
    '--',
    'apps/mobile',
  );
  if (dirty) throw new Error(`worktree not clean before run:\n${dirty}`);
}

const WT_MOBILE = path.join(WORKTREE, 'apps/mobile');
const wt = rel => path.join(WT_MOBILE, rel);
const readWt = rel => fs.readFileSync(wt(rel), 'utf8');

/** Replace exactly-once helpers: refuse silently-noop mutations. */
function replaceOnce(text, needle, replacement) {
  const idx = text.indexOf(needle);
  if (idx < 0)
    throw new Error(`mutation needle not found: ${needle.slice(0, 80)}`);
  if (text.indexOf(needle, idx + 1) >= 0) {
    throw new Error(`mutation needle not unique: ${needle.slice(0, 80)}`);
  }
  return text.slice(0, idx) + replacement + text.slice(idx + needle.length);
}

const GUARDS = {
  'jest:security-secrets': {
    cmd: 'npx',
    args: [
      'jest',
      '--ci',
      '--silent',
      '__tests__/wf/be-mobile-security-secrets.test.ts',
    ],
  },
  'jest:compliance-ios-config': {
    cmd: 'npx',
    args: [
      'jest',
      '--ci',
      '--silent',
      '__tests__/wf/flow-app-store-compliance-ios-config.test.ts',
    ],
  },
  'node:check-ios-distribution': {
    cmd: 'node',
    args: ['scripts/check-ios-distribution.mjs'],
  },
};

// --with-new-pins: also run the pins added by this pass (copied into the
// worktree as untracked files for the duration of the run) so the report
// shows whether they close the gaps the existing guards leave open.
const NEW_PIN_TESTS = [
  '__tests__/attack/ios-config-3/x-pbxproj-release-config.attack.test.ts',
  '__tests__/attack/ios-config-3/s7-privacy-manifest-bundling.attack.test.ts',
];
const WITH_NEW_PINS = args.includes('--with-new-pins');
if (WITH_NEW_PINS) {
  GUARDS['jest:attack-new-pins'] = {
    cmd: 'npx',
    args: ['jest', '--ci', '--silent', ...NEW_PIN_TESTS],
  };
}

const PBXPROJ = 'ios/PickleSensei.xcodeproj/project.pbxproj';
const INFO_PLIST = 'ios/PickleSensei/Info.plist';
const ENTITLEMENTS = 'ios/PickleSensei/PickleSensei.entitlements';
const RUNTIME_CONFIG = 'src/config/runtimeConfig.ts';

/**
 * Each mutation: files it touches (for snapshot/restore), an `apply` that
 * returns the mutated contents, and the guards that MUST catch it.
 */
const MUTATIONS = {
  // ── S6 ────────────────────────────────────────────────────────────────────
  's6-api-base-url-http': {
    scenario: 'S6',
    describe: 'API_BASE_URL downgraded to http:// (same host/path)',
    files: [RUNTIME_CONFIG],
    apply: t => ({
      [RUNTIME_CONFIG]: replaceOnce(
        t[RUNTIME_CONFIG],
        "'https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api'",
        "'http://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api'",
      ),
    }),
    mustCatch: ['jest:security-secrets', 'jest:compliance-ios-config'],
  },
  's6-api-base-url-http-localhost': {
    scenario: 'S6',
    describe: 'API_BASE_URL left pointing at a plain-http local dev server',
    files: [RUNTIME_CONFIG],
    apply: t => ({
      [RUNTIME_CONFIG]: replaceOnce(
        t[RUNTIME_CONFIG],
        "'https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api'",
        "'http://localhost:54321/functions/v1/api'",
      ),
    }),
    mustCatch: ['jest:security-secrets', 'jest:compliance-ios-config'],
  },
  's6-api-base-url-uppercase-scheme': {
    scenario: 'S6',
    describe:
      'API_BASE_URL scheme spelled HTTPS:// (bypasses startsWith("https://") literal filters)',
    files: [RUNTIME_CONFIG],
    apply: t => ({
      [RUNTIME_CONFIG]: replaceOnce(
        t[RUNTIME_CONFIG],
        "'https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api'",
        "'HTTPS://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api'",
      ),
    }),
    // Case-variant scheme is still TLS at runtime (URL() lower-cases it), so
    // the only guard expected to object is the literal allow-list.
    mustCatch: ['jest:security-secrets'],
  },
  // ── S7 ────────────────────────────────────────────────────────────────────
  's7-privacy-manifest-out-of-resources-phase': {
    scenario: 'S7',
    describe:
      'PrivacyInfo.xcprivacy removed from PBXResourcesBuildPhase.files ONLY (PBXBuildFile entry + file reference kept) — manifest is on disk but NOT bundled',
    files: [PBXPROJ],
    apply: t => ({
      [PBXPROJ]: replaceOnce(
        t[PBXPROJ],
        '\t\t\t\t9E6182F5C0175ABA960681B5 /* PrivacyInfo.xcprivacy in Resources */,\n',
        '',
      ),
    }),
    mustCatch: ['jest:compliance-ios-config'],
  },
  's7-privacy-manifest-target-membership-removed': {
    scenario: 'S7',
    describe:
      'PrivacyInfo.xcprivacy target membership removed the way Xcode does it (PBXBuildFile entry AND PBXResourcesBuildPhase entry gone; file reference kept)',
    files: [PBXPROJ],
    apply: t => ({
      [PBXPROJ]: replaceOnce(
        replaceOnce(
          t[PBXPROJ],
          '\t\t\t\t9E6182F5C0175ABA960681B5 /* PrivacyInfo.xcprivacy in Resources */,\n',
          '',
        ),
        '\t\t9E6182F5C0175ABA960681B5 /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = 13B07FB81A68108700A75B9A /* PrivacyInfo.xcprivacy */; };\n',
        '',
      ),
    }),
    mustCatch: ['jest:compliance-ios-config'],
  },
  's7-privacy-manifest-renamed-in-phase': {
    scenario: 'S7',
    describe:
      'Resources phase entry kept but its fileRef repointed at Info.plist (manifest file reference orphaned) — the "in Resources" comment survives',
    files: [PBXPROJ],
    apply: t => ({
      [PBXPROJ]: replaceOnce(
        t[PBXPROJ],
        '= {isa = PBXBuildFile; fileRef = 13B07FB81A68108700A75B9A /* PrivacyInfo.xcprivacy */; };',
        '= {isa = PBXBuildFile; fileRef = 13B07FB61A68108700A75B9A /* Info.plist */; };',
      ),
    }),
    mustCatch: ['jest:compliance-ios-config'],
  },
  // ── extras: Info.plist / ATS / entitlements / URL schemes / versions / debug ──
  'x-ats-arbitrary-loads-true': {
    scenario: 'X-ATS',
    describe: 'NSAllowsArbitraryLoads flipped to true',
    files: [INFO_PLIST],
    apply: t => ({
      [INFO_PLIST]: replaceOnce(
        t[INFO_PLIST],
        '<key>NSAllowsArbitraryLoads</key>\n\t\t<false/>',
        '<key>NSAllowsArbitraryLoads</key>\n\t\t<true/>',
      ),
    }),
    mustCatch: ['jest:security-secrets', 'node:check-ios-distribution'],
  },
  'x-ats-exception-domain': {
    scenario: 'X-ATS',
    describe: 'NSExceptionDomains added allowing insecure HTTP to the API host',
    files: [INFO_PLIST],
    apply: t => ({
      [INFO_PLIST]: replaceOnce(
        t[INFO_PLIST],
        '<key>NSAllowsLocalNetworking</key>',
        '<key>NSExceptionDomains</key>\n\t\t<dict>\n\t\t\t<key>supabase.co</key>\n\t\t\t<dict>\n\t\t\t\t<key>NSExceptionAllowsInsecureHTTPLoads</key>\n\t\t\t\t<true/>\n\t\t\t\t<key>NSIncludesSubdomains</key>\n\t\t\t\t<true/>\n\t\t\t</dict>\n\t\t</dict>\n\t\t<key>NSAllowsLocalNetworking</key>',
      ),
    }),
    mustCatch: ['jest:security-secrets'],
  },
  'x-privacy-string-camera-blank': {
    scenario: 'X-PLIST',
    describe: 'NSCameraUsageDescription blanked',
    files: [INFO_PLIST],
    apply: t => {
      const m =
        /<key>NSCameraUsageDescription<\/key>\s*<string>([^<]*)<\/string>/.exec(
          t[INFO_PLIST],
        );
      if (!m) throw new Error('camera usage string not found');
      return {
        [INFO_PLIST]: replaceOnce(t[INFO_PLIST], m[0], m[0].replace(m[1], '')),
      };
    },
    // check-ios-distribution only tests key PRESENCE (`includes(...)`), so a
    // blank string is expected to slip past it; the jest suite owns the
    // non-empty check.
    mustCatch: ['jest:compliance-ios-config'],
  },
  'x-privacy-string-photos-removed': {
    scenario: 'X-PLIST',
    describe:
      'NSPhotoLibraryUsageDescription key deleted (import from Photos would crash on access)',
    files: [INFO_PLIST],
    apply: t => {
      const m =
        /\t<key>NSPhotoLibraryUsageDescription<\/key>\s*<string>[^<]*<\/string>\n/.exec(
          t[INFO_PLIST],
        );
      if (!m) throw new Error('photo library usage string not found');
      return { [INFO_PLIST]: replaceOnce(t[INFO_PLIST], m[0], '') };
    },
    mustCatch: ['jest:compliance-ios-config', 'node:check-ios-distribution'],
  },
  'x-export-compliance-true': {
    scenario: 'X-PLIST',
    describe: 'ITSAppUsesNonExemptEncryption flipped to true',
    files: [INFO_PLIST],
    apply: t => ({
      [INFO_PLIST]: replaceOnce(
        t[INFO_PLIST],
        '<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>',
        '<key>ITSAppUsesNonExemptEncryption</key>\n\t<true/>',
      ),
    }),
    mustCatch: [
      'jest:security-secrets',
      'jest:compliance-ios-config',
      'node:check-ios-distribution',
    ],
  },
  'x-url-scheme-extra': {
    scenario: 'X-URL',
    describe:
      'A second custom URL scheme "picklesensei" added (new deep-link surface)',
    files: [INFO_PLIST],
    apply: t => {
      const m =
        /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(
          t[INFO_PLIST],
        );
      if (!m) throw new Error('URL scheme not found');
      return {
        [INFO_PLIST]: replaceOnce(
          t[INFO_PLIST],
          m[0],
          `${m[0]}\n\t\t\t\t<string>picklesensei</string>`,
        ),
      };
    },
    mustCatch: ['jest:security-secrets'],
  },
  'x-url-scheme-mismatched-google-id': {
    scenario: 'X-URL',
    describe:
      'Reversed Google client id scheme altered by one digit (Google sign-in redirect would never return)',
    files: [INFO_PLIST],
    apply: t => {
      const m = /<string>(com\.googleusercontent\.apps\.[^<]+)<\/string>/.exec(
        t[INFO_PLIST],
      );
      if (!m) throw new Error('reversed client id not found');
      return {
        [INFO_PLIST]: replaceOnce(
          t[INFO_PLIST],
          m[0],
          `<string>${m[1]}x</string>`,
        ),
      };
    },
    mustCatch: ['jest:security-secrets'],
  },
  'x-entitlement-applesignin-removed': {
    scenario: 'X-ENT',
    describe:
      'com.apple.developer.applesignin entitlement removed (Sign in with Apple would fail at runtime)',
    files: [ENTITLEMENTS],
    apply: t => {
      const m =
        /\t<key>com\.apple\.developer\.applesignin<\/key>\s*<array>\s*<string>Default<\/string>\s*<\/array>\n/.exec(
          t[ENTITLEMENTS],
        );
      if (!m) throw new Error('applesignin entitlement not found');
      return { [ENTITLEMENTS]: replaceOnce(t[ENTITLEMENTS], m[0], '') };
    },
    mustCatch: ['jest:security-secrets', 'node:check-ios-distribution'],
  },
  'x-entitlement-unwired': {
    scenario: 'X-ENT',
    describe:
      'CODE_SIGN_ENTITLEMENTS dropped from the Release configuration only',
    files: [PBXPROJ],
    apply: t => {
      const text = t[PBXPROJ];
      const releaseStart = text.indexOf(
        '13B07F951A680F5B00A75B9A /* Release */ = {',
      );
      const releaseEnd = text.indexOf('name = Release;', releaseStart);
      const block = text.slice(releaseStart, releaseEnd);
      const mutated = block.replace(
        '\t\t\t\tCODE_SIGN_ENTITLEMENTS = PickleSensei/PickleSensei.entitlements;\n',
        '',
      );
      if (mutated === block)
        throw new Error('release CODE_SIGN_ENTITLEMENTS not found');
      return {
        [PBXPROJ]:
          text.slice(0, releaseStart) + mutated + text.slice(releaseEnd),
      };
    },
    mustCatch: ['jest:compliance-ios-config'],
  },
  'x-privacy-manifest-file-deleted': {
    scenario: 'S7',
    describe:
      'PrivacyInfo.xcprivacy deleted from disk while the pbxproj still references it',
    files: ['ios/PickleSensei/PrivacyInfo.xcprivacy'],
    apply: () => ({ 'ios/PickleSensei/PrivacyInfo.xcprivacy': null }),
    mustCatch: ['jest:compliance-ios-config', 'node:check-ios-distribution'],
  },
  'x-release-debug-define': {
    scenario: 'X-DEBUG',
    describe:
      'Release target build settings gain GCC_PREPROCESSOR_DEFINITIONS DEBUG=1 and SWIFT_ACTIVE_COMPILATION_CONDITIONS DEBUG (debug code path in the store build)',
    files: [PBXPROJ],
    apply: t => {
      const text = t[PBXPROJ];
      const releaseStart = text.indexOf(
        '13B07F951A680F5B00A75B9A /* Release */ = {',
      );
      const needle = '\t\t\t\tSWIFT_VERSION = 5.0;\n';
      const idx = text.indexOf(needle, releaseStart);
      if (idx < 0) throw new Error('release SWIFT_VERSION not found');
      const injected =
        '\t\t\t\tGCC_PREPROCESSOR_DEFINITIONS = (\n\t\t\t\t\t"DEBUG=1",\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t);\n' +
        '\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = "$(inherited) DEBUG";\n' +
        needle;
      return {
        [PBXPROJ]:
          text.slice(0, idx) + injected + text.slice(idx + needle.length),
      };
    },
    // No existing guard is expected to know about this; the harness records
    // which (if any) do. An evasion here is reported, not asserted.
    mustCatch: [],
  },
  'x-release-ns-assertions-on': {
    scenario: 'X-DEBUG',
    describe:
      'Project-level Release ENABLE_NS_ASSERTIONS = YES and MTL_ENABLE_DEBUG_INFO = YES',
    files: [PBXPROJ],
    apply: t => {
      let text = t[PBXPROJ];
      const projRelease = text.indexOf(
        '83CBBA211A601CBA00E9B192 /* Release */ = {',
      );
      if (projRelease < 0) throw new Error('project Release config not found');
      const end = text.indexOf('name = Release;', projRelease);
      let block = text.slice(projRelease, end);
      const before = block;
      block = block
        .replace('ENABLE_NS_ASSERTIONS = NO;', 'ENABLE_NS_ASSERTIONS = YES;')
        .replace('MTL_ENABLE_DEBUG_INFO = NO;', 'MTL_ENABLE_DEBUG_INFO = YES;');
      if (block === before)
        throw new Error('release assertions settings not found');
      text = text.slice(0, projRelease) + block + text.slice(end);
      return { [PBXPROJ]: text };
    },
    mustCatch: [],
  },
  'x-version-skew-debug-vs-release': {
    scenario: 'X-VERSION',
    describe:
      'MARKETING_VERSION bumped to 1.1 in Release only (Debug stays 1.0; APP_VERSION stays 1.0)',
    files: [PBXPROJ],
    apply: t => {
      const text = t[PBXPROJ];
      const releaseStart = text.indexOf(
        '13B07F951A680F5B00A75B9A /* Release */ = {',
      );
      const needle = '\t\t\t\tMARKETING_VERSION = 1.0;\n';
      const idx = text.indexOf(needle, releaseStart);
      if (idx < 0) throw new Error('release MARKETING_VERSION not found');
      return {
        [PBXPROJ]:
          text.slice(0, idx) +
          '\t\t\t\tMARKETING_VERSION = 1.1;\n' +
          text.slice(idx + needle.length),
      };
    },
    mustCatch: [],
  },
  'x-bundle-id-typo': {
    scenario: 'X-VERSION',
    describe:
      'PRODUCT_BUNDLE_IDENTIFIER changed to com.picklesensei.dev in Release only',
    files: [PBXPROJ],
    apply: t => {
      const text = t[PBXPROJ];
      const releaseStart = text.indexOf(
        '13B07F951A680F5B00A75B9A /* Release */ = {',
      );
      const needle = '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.picklesensei;\n';
      const idx = text.indexOf(needle, releaseStart);
      if (idx < 0) throw new Error('release bundle id not found');
      return {
        [PBXPROJ]:
          text.slice(0, idx) +
          '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.picklesensei.dev;\n' +
          text.slice(idx + needle.length),
      };
    },
    mustCatch: [],
  },
};

function runGuard(name, logPath) {
  const guard = GUARDS[name];
  const started = Date.now();
  const result = spawnSync(guard.cmd, guard.args, {
    cwd: WT_MOBILE,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output =
    `$ (cd ${WT_MOBILE} && ${guard.cmd} ${guard.args.join(' ')})\n` +
    `exit=${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`;
  fs.writeFileSync(logPath, output);
  const failingTests = Array.from(
    `${result.stdout}\n${result.stderr}`.matchAll(/^\s+● (.+)$/gm),
    m => m[1],
  ).filter(line => !line.startsWith('Test suite failed to run'));
  return {
    guard: name,
    command: `${guard.cmd} ${guard.args.join(' ')}`,
    exit: result.status,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    log: path.relative(OUT_DIR, logPath),
    failing: Array.from(new Set(failingTests)),
  };
}

function snapshot(files) {
  return Object.fromEntries(files.map(f => [f, readWt(f)]));
}

function restore(snap) {
  for (const [rel, text] of Object.entries(snap))
    fs.writeFileSync(wt(rel), text);
  const dirty = git(
    WORKTREE,
    'status',
    '--porcelain',
    '-uno',
    '--',
    'apps/mobile',
  );
  if (dirty) throw new Error(`worktree still dirty after restore:\n${dirty}`);
}

function installNewPins() {
  if (!WITH_NEW_PINS) return () => {};
  const copied = [];
  for (const rel of NEW_PIN_TESTS) {
    const src = path.join(MOBILE_ROOT, rel);
    if (!fs.existsSync(src)) throw new Error(`new pin test missing: ${rel}`);
    const dst = wt(rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied.push(dst);
  }
  return () => {
    for (const f of copied) fs.rmSync(f, { force: true });
  };
}

function main() {
  ensureWorktree();
  const removeNewPins = installNewPins();
  process.on('exit', removeNewPins);
  const report = {
    tool: 'attack-ios-config-3/mutation-harness',
    baseline_sha: BASELINE_SHA,
    worktree: WORKTREE,
    started_utc: new Date().toISOString(),
    node: process.version,
    baseline: {},
    mutations: [],
  };

  // Baseline: every guard must be green on the unmutated tree.
  for (const name of Object.keys(GUARDS)) {
    const r = runGuard(
      name,
      path.join(OUT_DIR, `baseline.${name.replace(':', '-')}.log`),
    );
    report.baseline[name] = r;
    if (r.exit !== 0) {
      fs.writeFileSync(
        path.join(OUT_DIR, 'report.json'),
        JSON.stringify(report, null, 2),
      );
      throw new Error(
        `baseline guard ${name} is RED on ${BASELINE_SHA}: see ${r.log}`,
      );
    }
  }

  let evasions = 0;
  const names = ONLY ?? Object.keys(MUTATIONS);
  for (const name of names) {
    const mutation = MUTATIONS[name];
    if (!mutation) throw new Error(`unknown mutation ${name}`);
    const snap = snapshot(mutation.files);
    const entry = {
      name,
      scenario: mutation.scenario,
      describe: mutation.describe,
      files: mutation.files,
      diff: '',
      guards: [],
      caught_by: [],
      evaded: [],
      verdict: '',
    };
    try {
      const mutated = mutation.apply(snap);
      for (const [rel, text] of Object.entries(mutated)) {
        if (text === null) fs.rmSync(wt(rel));
        else fs.writeFileSync(wt(rel), text);
      }
      entry.diff = execFileSync(
        'git',
        ['-C', WORKTREE, 'diff', '--', 'apps/mobile'],
        {
          encoding: 'utf8',
        },
      );
      if (!entry.diff.trim())
        throw new Error(`mutation ${name} produced no diff`);
      fs.writeFileSync(path.join(OUT_DIR, `${name}.diff`), entry.diff);
      for (const guardName of Object.keys(GUARDS)) {
        const r = runGuard(
          guardName,
          path.join(OUT_DIR, `${name}.${guardName.replace(':', '-')}.log`),
        );
        entry.guards.push(r);
        if (r.exit !== 0) entry.caught_by.push(guardName);
      }
      entry.caught_by_new_pins = entry.caught_by.includes(
        'jest:attack-new-pins',
      );
      entry.evaded = mutation.mustCatch.filter(
        g => !entry.caught_by.includes(g),
      );
      if (entry.evaded.length > 0) {
        entry.verdict = 'EVADED';
        evasions += 1;
      } else if (entry.caught_by.length === 0) {
        entry.verdict =
          mutation.mustCatch.length === 0 ? 'UNGUARDED' : 'EVADED';
        if (entry.verdict === 'EVADED') evasions += 1;
      } else {
        entry.verdict = 'CAUGHT';
      }
    } finally {
      restore(snap);
    }
    report.mutations.push(entry);
    console.log(
      `${entry.verdict.padEnd(9)} ${name}  caught_by=[${entry.caught_by.join(', ')}]` +
        (entry.evaded.length ? `  EVADED=[${entry.evaded.join(', ')}]` : ''),
    );
  }

  report.finished_utc = new Date().toISOString();
  report.evasions = evasions;
  report.unguarded = report.mutations
    .filter(m => m.verdict === 'UNGUARDED')
    .map(m => m.name);
  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(`\nreport: ${path.join(OUT_DIR, 'report.json')}`);
  console.log(
    `evasions (asserted guard passed a hostile mutation): ${evasions}`,
  );
  console.log(
    `unguarded (no guard asserted, none fired): ${report.unguarded.join(', ') || 'none'}`,
  );
  process.exit(evasions > 0 ? 1 : 0);
}

main();
