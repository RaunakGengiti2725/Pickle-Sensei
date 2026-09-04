/**
 * Mutation scenarios for the `mobile-ios-config` subsystem.
 *
 * Each scenario mutates ONE thing in a scratch worktree and then runs the
 * guards that are supposed to notice. `expect: 'fail'` means "this guard must
 * exit non-zero and mention `mustContain`"; `expect: 'pass'` documents a guard
 * that is KNOWN not to look at the mutated property (the harness still runs
 * it so the gap is evidence, not an assumption).
 *
 * `assigned: true` marks the coordinator's scenarios; the rest are extras.
 */
import {
  editTargetConfig,
  readText,
  replaceAll,
  replaceOnce,
  seededRandom,
  writeText,
} from "./lib.mjs";

const INFO_PLIST = "apps/mobile/ios/PickleSensei/Info.plist";
const PRIVACY = "apps/mobile/ios/PickleSensei/PrivacyInfo.xcprivacy";
const ENTITLEMENTS = "apps/mobile/ios/PickleSensei/PickleSensei.entitlements";
const PBXPROJ = "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj";
const PODFILE_LOCK = "apps/mobile/ios/Podfile.lock";
const PODFILE = "apps/mobile/ios/Podfile";
const RUNTIME_CONFIG = "apps/mobile/src/config/runtimeConfig.ts";
const APP_JSON = "apps/mobile/app.json";

const SUITE_SECRETS = "__tests__/wf/be-mobile-security-secrets.test.ts";
const SUITE_IOS_CONFIG = "__tests__/wf/flow-app-store-compliance-ios-config.test.ts";
const SUITE_FIX9 = "__tests__/wf/fix-9-privacyManifestCollectedData.test.ts";

const GOOGLE_SCHEME = "com.googleusercontent.apps.278019487172-ku9j3985cijj4e636t7s7efn8r1vsu8m";

function jest(...files) {
  return {
    name: `jest ${files.map((f) => f.replace("__tests__/wf/", "")).join(" ")}`,
    cwd: "mobile",
    cmd: "npx",
    args: ["jest", "--ci", ...files],
  };
}
const CHECK_DISTRIBUTION = {
  name: "npm run check:distribution",
  cwd: "mobile",
  cmd: "node",
  args: ["scripts/check-ios-distribution.mjs"],
};
const RELEASE_CHECK = {
  name: "node tools/release/check-release-manifest.mjs",
  cwd: "root",
  cmd: "node",
  args: ["tools/release/check-release-manifest.mjs"],
};
/** The new pins from this pass (file lives in the SOURCE checkout, runs
 * against the worktree via PICKLE_REPO_ROOT). */
const PINS = {
  name: "node --test tools/attack/mobile-ios-config/ios-config-pins.test.mjs",
  cwd: "root",
  cmd: "node",
  args: ["--test", new URL("./ios-config-pins.test.mjs", import.meta.url).pathname],
  envFromWorktree: "PICKLE_REPO_ROOT",
};

const fail = (check, ...mustContain) => ({ ...check, expect: "fail", mustContain });
const pass = (check) => ({ ...check, expect: "pass", mustContain: [] });

function edit(root, rel, fn) {
  writeText(root, rel, fn(readText(root, rel)));
}

const PRECISE_LOCATION_DICT = `		<dict>
			<key>NSPrivacyCollectedDataType</key>
			<string>NSPrivacyCollectedDataTypePreciseLocation</string>
			<key>NSPrivacyCollectedDataTypeLinked</key>
			<true/>
			<key>NSPrivacyCollectedDataTypePurposes</key>
			<array>
				<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
			</array>
			<key>NSPrivacyCollectedDataTypeTracking</key>
			<false/>
		</dict>
`;

export const scenarios = [
  // ── assigned ──────────────────────────────────────────────────────────────
  {
    id: "S1-privacy-precise-location",
    assigned: true,
    title: "PrivacyInfo.xcprivacy gains NSPrivacyCollectedDataTypePreciseLocation",
    mutate(root) {
      edit(root, PRIVACY, (xml) =>
        replaceOnce(
          xml,
          "	<key>NSPrivacyCollectedDataTypes</key>\n	<array>\n",
          `	<key>NSPrivacyCollectedDataTypes</key>\n	<array>\n${PRECISE_LOCATION_DICT}`,
        ),
      );
    },
    checks: [fail(jest(SUITE_FIX9), "matches the App Store Connect purpose matrix exactly")],
  },
  {
    id: "S2-second-url-scheme",
    assigned: true,
    title: "Info.plist gains a second CFBundleURLTypes entry (picklesensei://)",
    mutate(root) {
      edit(root, INFO_PLIST, (plist) =>
        replaceOnce(
          plist,
          `				<string>${GOOGLE_SCHEME}</string>\n			</array>\n		</dict>\n`,
          `				<string>${GOOGLE_SCHEME}</string>\n			</array>\n		</dict>\n		<dict>\n			<key>CFBundleURLName</key>\n			<string>PickleSenseiDeepLink</string>\n			<key>CFBundleURLSchemes</key>\n			<array>\n				<string>picklesensei</string>\n			</array>\n		</dict>\n`,
        ),
      );
    },
    checks: [
      fail(jest(SUITE_SECRETS), "the only URL scheme is the reversed Google iOS OAuth client id"),
    ],
  },
  {
    id: "S3-ats-exception-domain",
    assigned: true,
    title: "Info.plist ATS gains NSExceptionDomains with NSExceptionAllowsInsecureHTTPLoads=true",
    mutate(root) {
      edit(root, INFO_PLIST, (plist) =>
        replaceOnce(
          plist,
          "		<key>NSAllowsLocalNetworking</key>\n		<true/>\n	</dict>\n",
          "		<key>NSAllowsLocalNetworking</key>\n		<true/>\n		<key>NSExceptionDomains</key>\n		<dict>\n			<key>example.com</key>\n			<dict>\n				<key>NSExceptionAllowsInsecureHTTPLoads</key>\n				<true/>\n			</dict>\n		</dict>\n	</dict>\n",
        ),
      );
    },
    checks: [
      fail(jest(SUITE_SECRETS), "ATS forbids arbitrary loads and declares no exception domains"),
      // Coordinator expectation was "both suites fail". This suite only pins
      // NSAllowsArbitraryLoads=false (flow-app-store-compliance-ios-config
      // .test.ts:62-64), so it stays green — recorded as a GAP.
      pass(jest(SUITE_IOS_CONFIG)),
    ],
  },
  {
    id: "S4-podfile-lock-checksum",
    assigned: true,
    title: "Podfile.lock PODFILE CHECKSUM altered (Podfile unchanged)",
    mutate(root) {
      edit(root, PODFILE_LOCK, (lock) =>
        replaceOnce(
          lock,
          "PODFILE CHECKSUM: 142bb0cc8ea87756c7bc868fb0145f3bf9080cfb",
          "PODFILE CHECKSUM: 0000000000000000000000000000000000000000",
        ),
      );
    },
    checks: [
      // Existence-only guard: documented gap, expected to still pass.
      // Mac plane (read from artifacts, not re-run): tools/macos-ci/pod-install.sh
      // runs plain `pod install` (not --deployment), which REWRITES Podfile.lock
      // before xcodebuild — so `[CP] Check Pods Manifest.lock` compares two
      // freshly generated files and cannot detect a tampered committed lock.
      pass(CHECK_DISTRIBUTION),
      pass(jest(SUITE_SECRETS, SUITE_IOS_CONFIG)),
      fail(PINS, "not ok 1 - Podfile.lock PODFILE CHECKSUM"),
    ],
  },
  {
    id: "S5a-marketing-version-pbxproj-only",
    assigned: true,
    title:
      "MARKETING_VERSION 1.0 -> 1.1 in project.pbxproj (both configs), runtimeConfig untouched",
    mutate(root) {
      edit(root, PBXPROJ, (p) =>
        replaceAll(p, "MARKETING_VERSION = 1.0;", "MARKETING_VERSION = 1.1;"),
      );
    },
    checks: [fail(RELEASE_CHECK, "FAIL pbxproj: MARKETING_VERSION = 1.0")],
  },
  {
    id: "S5b-app-version-only",
    assigned: true,
    title: "runtimeConfig APP_VERSION '1.0' -> '1.1', pbxproj untouched",
    mutate(root) {
      edit(root, RUNTIME_CONFIG, (t) =>
        replaceOnce(t, "const APP_VERSION = '1.0';", "const APP_VERSION = '1.1';"),
      );
    },
    checks: [fail(RELEASE_CHECK, "FAIL runtimeConfig.ts: APP_VERSION = '1.0'")],
  },
  {
    id: "S6-url-scheme-one-char",
    assigned: true,
    title:
      "One character of the CFBundleURLSchemes client-id suffix changed in Info.plist (seed 20260904)",
    mutate(root) {
      const seed = 20260904;
      const rand = seededRandom(seed);
      const suffix = "ku9j3985cijj4e636t7s7efn8r1vsu8m";
      const index = Math.floor(rand() * suffix.length);
      const original = suffix[index];
      const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789".replace(original, "");
      const replacement = alphabet[Math.floor(rand() * alphabet.length)];
      const mutated = suffix.slice(0, index) + replacement + suffix.slice(index + 1);
      this.detail = { seed, index, original, replacement, mutated };
      edit(root, INFO_PLIST, (plist) =>
        replaceOnce(
          plist,
          `<string>${GOOGLE_SCHEME}</string>`,
          `<string>${GOOGLE_SCHEME.replace(suffix, mutated)}</string>`,
        ),
      );
    },
    checks: [
      fail(jest(SUITE_SECRETS), "the only URL scheme is the reversed Google iOS OAuth client id"),
      fail(jest(SUITE_IOS_CONFIG), "registers the reversed Google iOS client id as a URL scheme"),
    ],
  },
  {
    id: "S7-entitlements-release-only",
    assigned: true,
    title: "CODE_SIGN_ENTITLEMENTS removed from the Release configuration only",
    mutate(root) {
      edit(root, PBXPROJ, (p) =>
        editTargetConfig(p, "Release", (settings) =>
          replaceOnce(
            settings,
            "				CODE_SIGN_ENTITLEMENTS = PickleSensei/PickleSensei.entitlements;\n",
            "",
          ),
        ),
      );
    },
    checks: [
      fail(jest(SUITE_IOS_CONFIG), "wires the entitlements file into every build configuration"),
      // Regex `.test` — any single occurrence satisfies it.
      pass(CHECK_DISTRIBUTION),
      fail(PINS, "not ok 6 - CODE_SIGN_ENTITLEMENTS is set identically"),
    ],
  },

  // ── extras: Release-only drift the Linux guards may not see ──────────────
  {
    id: "E1-marketing-version-release-only",
    title: "MARKETING_VERSION 1.0 -> 1.1 in the Release configuration only (Debug still 1.0)",
    mutate(root) {
      edit(root, PBXPROJ, (p) =>
        editTargetConfig(p, "Release", (s) =>
          replaceOnce(s, "MARKETING_VERSION = 1.0;", "MARKETING_VERSION = 1.1;"),
        ),
      );
    },
    checks: [
      pass(RELEASE_CHECK),
      pass(CHECK_DISTRIBUTION),
      pass(jest(SUITE_IOS_CONFIG)),
      fail(PINS, "not ok 3 - MARKETING_VERSION is set identically"),
    ],
  },
  {
    id: "E2-build-number-release-only",
    title: "CURRENT_PROJECT_VERSION 1 -> 7 in the Release configuration only",
    mutate(root) {
      edit(root, PBXPROJ, (p) =>
        editTargetConfig(p, "Release", (s) =>
          replaceOnce(s, "CURRENT_PROJECT_VERSION = 1;", "CURRENT_PROJECT_VERSION = 7;"),
        ),
      );
    },
    checks: [
      pass(RELEASE_CHECK),
      pass(CHECK_DISTRIBUTION),
      fail(PINS, "not ok 4 - CURRENT_PROJECT_VERSION is set identically"),
    ],
  },
  {
    id: "E3-bundle-id-release-only",
    title:
      "PRODUCT_BUNDLE_IDENTIFIER com.picklesensei -> com.picklesensei.dev in the Release configuration only",
    mutate(root) {
      edit(root, PBXPROJ, (p) =>
        editTargetConfig(p, "Release", (s) =>
          replaceOnce(
            s,
            "PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei;",
            "PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei.dev;",
          ),
        ),
      );
    },
    checks: [
      pass(CHECK_DISTRIBUTION),
      pass(jest(SUITE_IOS_CONFIG)),
      fail(PINS, "not ok 2 - PRODUCT_BUNDLE_IDENTIFIER is set identically"),
    ],
  },
  {
    id: "E4-device-family-release-only",
    title: 'TARGETED_DEVICE_FAMILY 1 -> "1,2" in the Release configuration only',
    mutate(root) {
      edit(root, PBXPROJ, (p) =>
        editTargetConfig(p, "Release", (s) =>
          replaceOnce(s, "TARGETED_DEVICE_FAMILY = 1;", 'TARGETED_DEVICE_FAMILY = "1,2";'),
        ),
      );
    },
    checks: [
      fail(CHECK_DISTRIBUTION, "FAIL pbxproj: iPhone-only"),
      fail(PINS, "not ok 7 - TARGETED_DEVICE_FAMILY is set identically"),
    ],
  },
  {
    id: "E5-dev-team-release-only",
    title: "DEVELOPMENT_TEAM removed from the Release configuration only",
    mutate(root) {
      edit(root, PBXPROJ, (p) =>
        editTargetConfig(p, "Release", (s) =>
          replaceOnce(s, "				DEVELOPMENT_TEAM = H26U6W4K6V;\n", ""),
        ),
      );
    },
    checks: [
      pass(CHECK_DISTRIBUTION),
      fail(PINS, "not ok 5 - DEVELOPMENT_TEAM is set identically"),
    ],
  },
  {
    id: "E6-debug-conditions-in-release",
    title:
      'SWIFT_ACTIVE_COMPILATION_CONDITIONS "$(inherited) DEBUG" added to the Release configuration (debug code compiled into the shipped binary)',
    mutate(root) {
      edit(root, PBXPROJ, (p) =>
        editTargetConfig(p, "Release", (s) =>
          replaceOnce(
            s,
            "				SWIFT_VERSION = 5.0;\n",
            '				SWIFT_ACTIVE_COMPILATION_CONDITIONS = "$(inherited) DEBUG";\n				SWIFT_VERSION = 5.0;\n',
          ),
        ),
      );
    },
    checks: [
      pass(CHECK_DISTRIBUTION),
      pass(jest(SUITE_SECRETS, SUITE_IOS_CONFIG)),
      fail(PINS, "not ok 12 - no DEBUG compilation condition"),
    ],
  },

  // ── extras: guards that should fire ──────────────────────────────────────
  {
    id: "E7-privacy-tracking-true",
    title: "PrivacyInfo.xcprivacy NSPrivacyTracking flipped to true",
    mutate(root) {
      edit(root, PRIVACY, (xml) =>
        replaceOnce(
          xml,
          "<key>NSPrivacyTracking</key>\n	<false/>",
          "<key>NSPrivacyTracking</key>\n	<true/>",
        ),
      );
    },
    checks: [
      fail(jest(SUITE_FIX9), "keeps tracking false"),
      fail(jest(SUITE_IOS_CONFIG), "declares no tracking"),
    ],
  },
  {
    id: "E8-privacy-bogus-reason-code",
    title:
      "PrivacyInfo.xcprivacy gains NSPrivacyAccessedAPICategoryDiskSpace with an invented reason code ZZZZ.1",
    mutate(root) {
      edit(root, PRIVACY, (xml) =>
        replaceOnce(
          xml,
          "				<string>35F9.1</string>\n			</array>\n		</dict>\n	</array>\n",
          "				<string>35F9.1</string>\n			</array>\n		</dict>\n		<dict>\n			<key>NSPrivacyAccessedAPIType</key>\n			<string>NSPrivacyAccessedAPICategoryDiskSpace</string>\n			<key>NSPrivacyAccessedAPITypeReasons</key>\n			<array>\n				<string>ZZZZ.1</string>\n			</array>\n		</dict>\n	</array>\n",
        ),
      );
    },
    checks: [
      fail(
        jest(SUITE_IOS_CONFIG),
        "every declared category carries at least one approved reason code",
      ),
    ],
  },
  {
    id: "E9-privacy-duplicate-type",
    title: "PrivacyInfo.xcprivacy declares NSPrivacyCollectedDataTypeEmailAddress twice",
    mutate(root) {
      edit(root, PRIVACY, (xml) => {
        const start = xml.indexOf(
          "		<dict>\n			<key>NSPrivacyCollectedDataType</key>\n			<string>NSPrivacyCollectedDataTypeEmailAddress</string>",
        );
        if (start < 0) throw new Error("email dict not found");
        const end = xml.indexOf("		</dict>\n", start) + "		</dict>\n".length;
        const dict = xml.slice(start, end);
        return xml.slice(0, end) + dict + xml.slice(end);
      });
    },
    checks: [
      fail(jest(SUITE_FIX9), "declares every app-level category covered by the privacy policy"),
    ],
  },
  {
    id: "E10-url-scheme-zero-width-space",
    title: "U+200B zero-width space inserted inside the Google URL scheme",
    mutate(root) {
      edit(root, INFO_PLIST, (plist) =>
        replaceOnce(
          plist,
          `<string>${GOOGLE_SCHEME}</string>`,
          `<string>${GOOGLE_SCHEME.slice(0, 30)}\u200b${GOOGLE_SCHEME.slice(30)}</string>`,
        ),
      );
    },
    checks: [
      fail(jest(SUITE_SECRETS), "the only URL scheme"),
      fail(jest(SUITE_IOS_CONFIG), "registers the reversed Google iOS client id"),
    ],
  },
  {
    id: "E11-ats-arbitrary-loads-true",
    title: "NSAllowsArbitraryLoads flipped to true",
    mutate(root) {
      edit(root, INFO_PLIST, (plist) =>
        replaceOnce(
          plist,
          "<key>NSAllowsArbitraryLoads</key>\n		<false/>",
          "<key>NSAllowsArbitraryLoads</key>\n		<true/>",
        ),
      );
    },
    checks: [
      fail(jest(SUITE_SECRETS), "ATS forbids arbitrary loads"),
      fail(jest(SUITE_IOS_CONFIG), "keeps App Transport Security strict"),
      fail(CHECK_DISTRIBUTION, "FAIL Info.plist: ATS arbitrary loads disabled"),
    ],
  },
  {
    id: "E12-ats-block-removed",
    title: "The whole NSAppTransportSecurity dict removed from Info.plist",
    mutate(root) {
      edit(root, INFO_PLIST, (plist) =>
        replaceOnce(
          plist,
          "	<key>NSAppTransportSecurity</key>\n	<dict>\n		<key>NSAllowsArbitraryLoads</key>\n		<false/>\n		<key>NSAllowsLocalNetworking</key>\n		<true/>\n	</dict>\n",
          "",
        ),
      );
    },
    checks: [
      fail(jest(SUITE_SECRETS), "ATS forbids arbitrary loads"),
      fail(jest(SUITE_IOS_CONFIG), "keeps App Transport Security strict"),
      fail(CHECK_DISTRIBUTION, "FAIL Info.plist: ATS arbitrary loads disabled"),
    ],
  },
  {
    id: "E13-export-compliance-true",
    title: "ITSAppUsesNonExemptEncryption flipped to true",
    mutate(root) {
      edit(root, INFO_PLIST, (plist) =>
        replaceOnce(
          plist,
          "<key>ITSAppUsesNonExemptEncryption</key>\n	<false/>",
          "<key>ITSAppUsesNonExemptEncryption</key>\n	<true/>",
        ),
      );
    },
    checks: [
      fail(jest(SUITE_SECRETS), "export compliance flag is present and false"),
      fail(jest(SUITE_IOS_CONFIG), "declares ITSAppUsesNonExemptEncryption=false"),
      fail(CHECK_DISTRIBUTION, "FAIL Info.plist: export-compliance exemption"),
    ],
  },
  {
    id: "E14-applesignin-entitlement-removed",
    title: "com.apple.developer.applesignin removed from the entitlements file",
    mutate(root) {
      edit(root, ENTITLEMENTS, (e) =>
        replaceOnce(
          e,
          "	<key>com.apple.developer.applesignin</key>\n	<array>\n		<string>Default</string>\n	</array>\n",
          "",
        ),
      );
    },
    checks: [
      fail(jest(SUITE_SECRETS), "Apple Sign-In entitlement is declared"),
      fail(jest(SUITE_IOS_CONFIG), "declares com.apple.developer.applesignin"),
      fail(CHECK_DISTRIBUTION, "FAIL entitlements: Sign in with Apple"),
    ],
  },
  {
    id: "E15-google-client-id-runtime-only",
    title: "GOOGLE_IOS_CLIENT_ID rotated in runtimeConfig.ts, Info.plist scheme left stale",
    mutate(root) {
      edit(root, RUNTIME_CONFIG, (t) =>
        replaceOnce(
          t,
          "'278019487172-ku9j3985cijj4e636t7s7efn8r1vsu8m.apps.googleusercontent.com'",
          "'278019487172-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.apps.googleusercontent.com'",
        ),
      );
    },
    checks: [
      fail(jest(SUITE_SECRETS), "the only URL scheme"),
      fail(jest(SUITE_IOS_CONFIG), "registers the reversed Google iOS client id"),
    ],
  },
  {
    id: "E16-camera-usage-placeholder",
    title: 'NSCameraUsageDescription replaced by "TODO"',
    mutate(root) {
      edit(root, INFO_PLIST, (plist) =>
        replaceOnce(
          plist,
          "<string>Pickle Sensei uses guided automatic capture to find your body position, detect a stroke motion, and run private on-device analysis.</string>",
          "<string>TODO</string>",
        ),
      );
    },
    checks: [fail(jest(SUITE_IOS_CONFIG), "NSCameraUsageDescription is a real sentence")],
  },

  // ── extras: unpinned surfaces ────────────────────────────────────────────
  {
    id: "E17-app-json-module-name",
    title:
      'app.json name "PickleSensei" -> "PickleSenseiX" while AppDelegate.swift keeps withModuleName: "PickleSensei"',
    mutate(root) {
      edit(root, APP_JSON, (t) =>
        replaceOnce(t, '"name": "PickleSensei"', '"name": "PickleSenseiX"'),
      );
    },
    checks: [
      pass(CHECK_DISTRIBUTION),
      pass(jest(SUITE_SECRETS, SUITE_IOS_CONFIG)),
      fail(PINS, "not ok 13 - app.json registration name"),
    ],
  },
  {
    id: "E18-podfile-new-arch-env-removed",
    title:
      "Podfile line ENV['RCT_NEW_ARCH_ENABLED'] = '1' removed (Podfile comment says the app then crashes at startup)",
    mutate(root) {
      edit(root, PODFILE, (t) => replaceOnce(t, "ENV['RCT_NEW_ARCH_ENABLED'] = '1'\n", ""));
    },
    checks: [
      pass(CHECK_DISTRIBUTION),
      pass(jest(SUITE_IOS_CONFIG)),
      // The Podfile changed, so the committed checksum no longer matches it.
      fail(PINS, "not ok 1 - Podfile.lock PODFILE CHECKSUM", "not ok 14 - Podfile keeps"),
    ],
  },
  {
    id: "E19-app-store-id-drift",
    title: "runtimeConfig APP_STORE_ID '6806918402' -> '1234567890' (dossier says 6806918402)",
    mutate(root) {
      edit(root, RUNTIME_CONFIG, (t) =>
        replaceOnce(
          t,
          "const APP_STORE_ID: string | null = '6806918402';",
          "const APP_STORE_ID: string | null = '1234567890';",
        ),
      );
    },
    checks: [
      pass(RELEASE_CHECK),
      pass(jest(SUITE_SECRETS, SUITE_IOS_CONFIG)),
      fail(PINS, "not ok 15 - runtimeConfig APP_STORE_ID"),
    ],
  },
  {
    id: "E20-baseline-unmutated",
    control: true,
    title: "Control: no mutation — every guard and every new pin must pass",
    mutate() {},
    checks: [
      pass(jest(SUITE_SECRETS, SUITE_IOS_CONFIG, SUITE_FIX9)),
      pass(CHECK_DISTRIBUTION),
      pass(RELEASE_CHECK),
      pass(PINS),
    ],
  },
];
