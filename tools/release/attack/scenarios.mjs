/**
 * Adversarial mutations against the release-config checkers, run in a sandbox copy.
 *
 * `expect` is the behaviour the release invariants in docs/RELEASE_OPERATIONS.md,
 * docs/APP_STORE_SUBMISSION.md and .agents/skills/release-verification demand, NOT the
 * behaviour observed today. A scenario is HELD when the observed exit codes match `expect`
 * and BROKEN otherwise. "pass" = exit 0, "fail" = exit 1, "any" = not asserted.
 *
 * Seeded randomness: ATTACK_SEED (default 20260904) drives every generated value so a
 * BROKEN run is reproducible byte-for-byte.
 */
import { FILES, editManifest, readSandbox, replaceIn, writeSandbox } from "./sandbox.mjs";

export const SEED = Number.parseInt(process.env.ATTACK_SEED ?? "20260904", 10);

/** mulberry32 — small deterministic PRNG, good enough for fixture generation. */
export function makeRng(seed = SEED) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CANONICAL_APP_STORE_ID = "6806918402";
const CANONICAL_TEAM = "H26U6W4K6V";

export function randomDigits(rng, length, avoid) {
  for (;;) {
    let s = String(1 + Math.floor(rng() * 9));
    while (s.length < length) s += String(Math.floor(rng() * 10));
    if (s !== avoid) return s;
  }
}

export function randomTeamId(rng, avoid) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    let s = "";
    while (s.length < 10) s += alphabet[Math.floor(rng() * alphabet.length)];
    if (s !== avoid) return s;
  }
}

const rng = makeRng();
export const generated = {
  seed: SEED,
  appStoreId: randomDigits(rng, 10, CANONICAL_APP_STORE_ID),
  teamId: randomTeamId(rng, CANONICAL_TEAM),
};

/** @type {Array<{id:string, assigned:boolean, title:string, mutate:(root:string)=>void, expect:{releaseCheck:"pass"|"fail"|"any", distributionCheck:"pass"|"fail"|"any"}, invariant:string}>} */
export const scenarios = [
  {
    id: "s01_fastfile_hardcoded_password",
    assigned: true,
    title: "Fastfile gains `FASTLANE_PASSWORD=x`",
    invariant: "check:distribution rejects hardcoded Fastlane credentials",
    mutate(root) {
      writeSandbox(
        root,
        FILES.fastfile,
        `${readSandbox(root, FILES.fastfile)}\nFASTLANE_PASSWORD=x\n`,
      );
    },
    expect: { releaseCheck: "pass", distributionCheck: "fail" },
  },
  {
    id: "s02_pbxproj_device_family_1_2_one_config",
    assigned: true,
    title: 'One pbxproj configuration sets TARGETED_DEVICE_FAMILY = "1,2";',
    invariant: "check:distribution enforces the iPhone-only v1 pin",
    mutate(root) {
      replaceIn(
        root,
        FILES.pbxproj,
        "TARGETED_DEVICE_FAMILY = 1;",
        'TARGETED_DEVICE_FAMILY = "1,2";',
        1,
      );
    },
    expect: { releaseCheck: "pass", distributionCheck: "fail" },
  },
  {
    id: "s03_manifest_duplicate_silent_failure_rate_P1",
    assigned: true,
    title: "Duplicate monitoringHooks entry silent_failure_rate with severity P1",
    invariant: "release:check keeps silent_failure_rate at P0 (every() spans duplicates)",
    mutate(root) {
      editManifest(root, (m) => {
        const orig = m.monitoringHooks.find((h) => h.id === "silent_failure_rate");
        m.monitoringHooks.push({ ...orig, severity: "P1" });
      });
    },
    expect: { releaseCheck: "fail", distributionCheck: "pass" },
  },
  {
    id: "s03b_manifest_duplicate_silent_failure_rate_P0",
    assigned: false,
    title: "Duplicate monitoringHooks entry silent_failure_rate with severity P0 (p13 extension)",
    invariant: "monitoringHooks ids are unique (a duplicate is a corrupt manifest)",
    mutate(root) {
      editManifest(root, (m) => {
        const orig = m.monitoringHooks.find((h) => h.id === "silent_failure_rate");
        m.monitoringHooks.push({ ...orig, alarm: "duplicate alarm text" });
      });
    },
    expect: { releaseCheck: "fail", distributionCheck: "pass" },
  },
  {
    id: "s03c_manifest_duplicate_rollback_and_irreversible_ids",
    assigned: false,
    title: "Duplicate rollbackHooks id and duplicate irreversibleActions id (p13 extension)",
    invariant: "rollbackHooks / irreversibleActions ids are unique",
    mutate(root) {
      editManifest(root, (m) => {
        m.rollbackHooks.push({ ...m.rollbackHooks[0] });
        m.irreversibleActions.push({ ...m.irreversibleActions[0] });
      });
    },
    expect: { releaseCheck: "fail", distributionCheck: "pass" },
  },
  {
    id: "s04_build_2_everywhere_except_manifest",
    assigned: true,
    title: "versionCode and CURRENT_PROJECT_VERSION bumped to 2, manifest still 1",
    invariant:
      "release:check catches version-triple drift; check:distribution does not consult the manifest (by design)",
    mutate(root) {
      replaceIn(
        root,
        FILES.pbxproj,
        "CURRENT_PROJECT_VERSION = 1;",
        "CURRENT_PROJECT_VERSION = 2;",
      );
      replaceIn(root, FILES.gradle, "versionCode 1", "versionCode 2");
    },
    expect: { releaseCheck: "fail", distributionCheck: "pass" },
  },
  {
    id: "s05_runtime_app_store_id_changed",
    assigned: true,
    title: `runtimeConfig APP_STORE_ID changed to a different digit string (seed ${SEED})`,
    invariant: `APP_STORE_ID must stay ${CANONICAL_APP_STORE_ID} (dossier §1 / knowledge); a release gate must pin it`,
    mutate(root) {
      replaceIn(
        root,
        FILES.runtimeConfig,
        `'${CANONICAL_APP_STORE_ID}'`,
        `'${generated.appStoreId}'`,
      );
    },
    expect: { releaseCheck: "fail", distributionCheck: "any" },
  },
  {
    id: "s05b_runtime_app_store_id_null",
    assigned: false,
    title: "runtimeConfig APP_STORE_ID reverted to null",
    invariant:
      "dossier §2.6 marks APP_STORE_ID as set; reverting it silently would break rate-us / store links",
    mutate(root) {
      replaceIn(root, FILES.runtimeConfig, `'${CANONICAL_APP_STORE_ID}'`, "null");
    },
    expect: { releaseCheck: "fail", distributionCheck: "any" },
  },
  {
    id: "s06_appfile_team_mismatch",
    assigned: true,
    title: `Appfile team_id changed to ${generated.teamId} (seed ${SEED})`,
    invariant: "check:distribution rejects Appfile team != DEVELOPMENT_TEAM",
    mutate(root) {
      replaceIn(
        root,
        FILES.appfile,
        `team_id("${CANONICAL_TEAM}")`,
        `team_id("${generated.teamId}")`,
      );
    },
    expect: { releaseCheck: "pass", distributionCheck: "fail" },
  },
  {
    id: "s07_release_config_build_3_only",
    assigned: true,
    title: "Only the Release configuration CURRENT_PROJECT_VERSION set to 3 (dossier build 3)",
    invariant:
      "manifest buildNumber MUST equal CURRENT_PROJECT_VERSION (RELEASE_OPERATIONS §1); Debug/Release must agree",
    mutate(root) {
      const text = readSandbox(root, FILES.pbxproj);
      const needle = "CURRENT_PROJECT_VERSION = 1;";
      const first = text.indexOf(needle);
      const second = text.indexOf(needle, first + needle.length);
      if (second < 0) throw new Error("expected two CURRENT_PROJECT_VERSION entries");
      writeSandbox(
        root,
        FILES.pbxproj,
        `${text.slice(0, second)}CURRENT_PROJECT_VERSION = 3;${text.slice(second + needle.length)}`,
      );
    },
    expect: { releaseCheck: "fail", distributionCheck: "any" },
  },
  {
    id: "x01_release_config_marketing_1_1_only",
    assigned: false,
    title: "Only the Release configuration MARKETING_VERSION set to 1.1",
    invariant: "manifest marketingVersion MUST equal MARKETING_VERSION in every configuration",
    mutate(root) {
      const text = readSandbox(root, FILES.pbxproj);
      const needle = "MARKETING_VERSION = 1.0;";
      const first = text.indexOf(needle);
      const second = text.indexOf(needle, first + needle.length);
      if (second < 0) throw new Error("expected two MARKETING_VERSION entries");
      writeSandbox(
        root,
        FILES.pbxproj,
        `${text.slice(0, second)}MARKETING_VERSION = 1.1;${text.slice(second + needle.length)}`,
      );
    },
    expect: { releaseCheck: "fail", distributionCheck: "any" },
  },
  {
    id: "x02_pbxproj_team_changed_in_one_config",
    assigned: false,
    title: `DEVELOPMENT_TEAM changed to ${generated.teamId} in one configuration only`,
    invariant: "check:distribution rejects any configuration signed by a foreign team",
    mutate(root) {
      replaceIn(
        root,
        FILES.pbxproj,
        `DEVELOPMENT_TEAM = ${CANONICAL_TEAM};`,
        `DEVELOPMENT_TEAM = ${generated.teamId};`,
        1,
      );
    },
    expect: { releaseCheck: "pass", distributionCheck: "fail" },
  },
  {
    id: "x03_pbxproj_device_family_2_one_config",
    assigned: false,
    title: "One configuration sets TARGETED_DEVICE_FAMILY = 2; (iPad-only)",
    invariant: "iPhone-only pin must hold for every configuration, not just one",
    mutate(root) {
      replaceIn(
        root,
        FILES.pbxproj,
        "TARGETED_DEVICE_FAMILY = 1;",
        "TARGETED_DEVICE_FAMILY = 2;",
        1,
      );
    },
    expect: { releaseCheck: "pass", distributionCheck: "fail" },
  },
  {
    id: "x04_fastfile_distribute_external_true_keeps_comment",
    assigned: false,
    title: "distribute_external flipped to true while the old value survives in a comment",
    invariant: "check:distribution rejects external TestFlight distribution",
    mutate(root) {
      replaceIn(
        root,
        FILES.fastfile,
        "distribute_external: false,",
        "distribute_external: true, # was distribute_external: false,",
        1,
      );
    },
    expect: { releaseCheck: "pass", distributionCheck: "fail" },
  },
  {
    id: "x05_fastfile_base64_key_content",
    assigned: false,
    title: "Fastfile embeds a base64 ASC private key via key_content/is_key_content_base64",
    invariant: "check:distribution rejects hardcoded credentials of any encoding",
    mutate(root) {
      replaceIn(
        root,
        FILES.fastfile,
        '{ key_content: ENV.fetch("APP_STORE_CONNECT_API_KEY_KEY") }',
        '{ key_content: "TUlHVEFnRUFNQk1HQnlxR1NNNDlBZ0VHQ0NxR1NNNDlBd0VIQkhrd2R3SUJBUVFn", is_key_content_base64: true }',
        1,
      );
    },
    expect: { releaseCheck: "pass", distributionCheck: "fail" },
  },
  {
    id: "x06_manifest_severity_lowercase",
    assigned: false,
    title: 'monitoringHooks severity "p0" (case drift)',
    invariant: "severity must be exactly P0 or P1",
    mutate(root) {
      editManifest(root, (m) => {
        m.monitoringHooks[0].severity = "p0";
      });
    },
    expect: { releaseCheck: "fail", distributionCheck: "pass" },
  },
  {
    id: "x07_manifest_production_origin_provisioned",
    assigned: false,
    title: 'production apiOrigin set to a real https origin instead of "tbd"',
    invariant: "staging/production origins stay tbd until a human provisions them",
    mutate(root) {
      editManifest(root, (m) => {
        m.environments.production.apiOrigin = "https://example.invalid";
      });
    },
    expect: { releaseCheck: "fail", distributionCheck: "pass" },
  },
  {
    id: "x08_manifest_build_number_string",
    assigned: false,
    title: 'manifest buildNumber "1" (string)',
    invariant: "buildNumber must be an integer >= 1",
    mutate(root) {
      editManifest(root, (m) => {
        m.versionScheme.buildNumber = "1";
      });
    },
    expect: { releaseCheck: "fail", distributionCheck: "pass" },
  },
  {
    id: "x09_manifest_staging_real_user_data",
    assigned: false,
    title: "staging realUserData flipped to true",
    invariant: "only production may carry real user data",
    mutate(root) {
      editManifest(root, (m) => {
        m.environments.staging.realUserData = true;
      });
    },
    expect: { releaseCheck: "fail", distributionCheck: "pass" },
  },
  {
    id: "x10_manifest_irreversible_no_human_auth",
    assigned: false,
    title: "an irreversibleAction drops requiresHumanAuthorization",
    invariant: "every irreversible action requires human authorization",
    mutate(root) {
      editManifest(root, (m) => {
        m.irreversibleActions[0].requiresHumanAuthorization = false;
      });
    },
    expect: { releaseCheck: "fail", distributionCheck: "pass" },
  },
  {
    id: "x11_appfile_apple_id",
    assigned: false,
    title: 'Appfile gains apple_id("someone@example.com")',
    invariant: "Appfile must not carry an Apple ID / password",
    mutate(root) {
      writeSandbox(
        root,
        FILES.appfile,
        `${readSandbox(root, FILES.appfile)}\napple_id("someone@example.com")\n`,
      );
    },
    expect: { releaseCheck: "pass", distributionCheck: "fail" },
  },
  {
    id: "x12_pbxproj_bundle_id_one_config",
    assigned: false,
    title: "PRODUCT_BUNDLE_IDENTIFIER changed in one configuration only",
    invariant: "bundle id com.picklesensei must hold in every configuration",
    mutate(root) {
      replaceIn(
        root,
        FILES.pbxproj,
        "PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei;",
        "PRODUCT_BUNDLE_IDENTIFIER = com.picklesensei.dev;",
        1,
      );
    },
    expect: { releaseCheck: "pass", distributionCheck: "fail" },
  },
  {
    id: "x13_manifest_unicode_lookalike_hook_id",
    assigned: false,
    title: "silent_failure_rate renamed with a Cyrillic 'а' (U+0430) lookalike",
    invariant: "required monitoring ids are matched byte-exactly",
    mutate(root) {
      editManifest(root, (m) => {
        const hook = m.monitoringHooks.find((h) => h.id === "silent_failure_rate");
        hook.id = "silent_f\u0430ilure_rate";
      });
    },
    expect: { releaseCheck: "fail", distributionCheck: "pass" },
  },
  {
    id: "x14_manifest_huge_hook_list",
    assigned: false,
    title: "manifest padded with 20,000 extra well-formed monitoring hooks (huge input)",
    invariant: "checker still terminates and still passes a well-formed manifest",
    mutate(root) {
      editManifest(root, (m) => {
        const rng2 = makeRng(SEED + 1);
        for (let i = 0; i < 20000; i += 1) {
          m.monitoringHooks.push({
            id: `pad_${i}_${randomDigits(rng2, 6)}`,
            signal: "pad",
            alarm: "pad",
            severity: rng2() < 0.5 ? "P0" : "P1",
          });
        }
      });
    },
    expect: { releaseCheck: "pass", distributionCheck: "pass" },
  },
];
