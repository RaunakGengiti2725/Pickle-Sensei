// Adversarial pass 3 — subsystem `release-config-docs` — checker + docs probes.
//
//   node --test tools/release/__attack__/
//
// Every test asserts the behaviour the release gate SHOULD have. A failing test
// is a reproduced finding (BROKEN); a passing test is a HELD scenario. Each
// scenario also records its verdict to $ATTACK_REPORT (JSON) so run-all.sh can
// tabulate HELD/BROKEN without parsing TAP. Production files are never modified:
// see sandbox.mjs. Fuzz cases use a fixed seed (recorded in the report).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import {
  GRADLE,
  MANIFEST,
  PBXPROJ,
  REPO_ROOT,
  RUNTIME_CONFIG,
  XCPRIVACY,
  attack,
  mutateManifest,
  readManifest,
  readRepo,
  readSandbox,
  seededRandom,
  writeSandbox,
} from "./sandbox.mjs";

const FUZZ_SEED = 20260904;
const REPORT_PATH =
  process.env.ATTACK_REPORT ??
  join(REPO_ROOT, "artifacts", "attack-release-config-docs-3", "checker-scenarios.json");
const results = [];

/** Run `fn`, record HELD/BROKEN + details for the report, then re-throw. */
async function scenario(id, title, fn) {
  const details = {};
  try {
    await fn(details);
    results.push({ id, title, verdict: "HELD", details });
  } catch (error) {
    results.push({ id, title, verdict: "BROKEN", details, error: String(error.message) });
    throw error;
  }
}

after(() => {
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(
    REPORT_PATH,
    JSON.stringify({ seed: FUZZ_SEED, generatedAtIso: new Date().toISOString(), results }, null, 2),
  );
});

describe("baseline", () => {
  test("B0 clean checker passes on the untouched tree", () =>
    scenario("B0", "clean checker exit 0", (d) => {
      const r = attack(() => {});
      d.exit = r.code;
      d.ok = r.okLines.length;
      d.fail = r.failLines.length;
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.failLines.length, 0);
    }));
});

describe("S1 irreversibleActions identity", () => {
  test("S1 removing app_store_submission must FAIL the checker", () =>
    scenario("S1", "remove app_store_submission from irreversibleActions", (d) => {
      const r = attack((root) =>
        mutateManifest(root, (m) => {
          m.irreversibleActions = m.irreversibleActions.filter(
            (a) => a.id !== "app_store_submission",
          );
        }),
      );
      d.exit = r.code;
      d.failLines = r.failLines;
      d.remainingIrreversible = r.okLines.filter((l) => l.includes("irreversibleActions")).length;
      assert.notEqual(r.code, 0, "checker exited 0 without app_store_submission");
    }));

  test("S1b replacing every irreversible action with a bogus one must FAIL", () =>
    scenario("S1b", "irreversibleActions = [{id:x}]", (d) => {
      const r = attack((root) =>
        mutateManifest(root, (m) => {
          m.irreversibleActions = [{ id: "x", requiresHumanAuthorization: true }];
        }),
      );
      d.exit = r.code;
      assert.notEqual(r.code, 0);
    }));

  test("E1 deleting releaseBlockingSteps (privacy_disclosure_sync …) must FAIL", () =>
    scenario("E1", "releaseBlockingSteps deleted", (d) => {
      const r = attack((root) =>
        mutateManifest(root, (m) => {
          delete m.releaseBlockingSteps;
        }),
      );
      d.exit = r.code;
      d.failLines = r.failLines;
      assert.notEqual(r.code, 0, "checker exited 0 with no release-blocking steps at all");
    }));

  test("E1b removing only privacy_disclosure_sync must FAIL", () =>
    scenario("E1b", "privacy_disclosure_sync removed", (d) => {
      const r = attack((root) =>
        mutateManifest(root, (m) => {
          m.releaseBlockingSteps = m.releaseBlockingSteps.filter(
            (s) => s.id !== "privacy_disclosure_sync",
          );
        }),
      );
      d.exit = r.code;
      assert.notEqual(r.code, 0);
    }));
});

describe("S2 corrupt manifest", () => {
  test("S2 `{}` manifest → ≥20 FAIL lines, exit 1, no crash", () =>
    scenario("S2", "manifest {}", (d) => {
      const r = attack((root) => writeSandbox(root, MANIFEST, "{}\n"));
      d.exit = r.code;
      d.fail = r.failLines.length;
      d.crashed = r.crashed;
      assert.equal(r.code, 1);
      assert.ok(r.failLines.length >= 20, `only ${r.failLines.length} FAIL lines`);
      assert.equal(r.crashed, false, r.stderr);
    }));

  const NON_OBJECTS = ["[]", '""', "42", "null", "not json"];
  for (const body of NON_OBJECTS) {
    test(`S2b manifest ${body} → non-zero exit`, () =>
      scenario(`S2b:${body}`, `manifest ${body}`, (d) => {
        const r = attack((root) => writeSandbox(root, MANIFEST, body));
        d.exit = r.code;
        d.fail = r.failLines.length;
        d.crashed = r.crashed;
        assert.notEqual(r.code, 0);
      }));
  }

  test("S2c type-confused hook arrays exit non-zero (and record whether they crash)", () =>
    scenario("S2c", "hooks as null / object / string", (d) => {
      const cases = {
        monitoringHooksNullEntry: (m) => {
          m.monitoringHooks = [null];
        },
        monitoringHooksObject: (m) => {
          m.monitoringHooks = {};
        },
        rollbackHooksString: (m) => {
          m.rollbackHooks = "x";
        },
        irreversibleNullEntry: (m) => {
          m.irreversibleActions = [null];
        },
        versionSchemeNull: (m) => {
          m.versionScheme = null;
        },
      };
      d.cases = {};
      for (const [name, mutate] of Object.entries(cases)) {
        const r = attack((root) => mutateManifest(root, mutate));
        d.cases[name] = { exit: r.code, fail: r.failLines.length, crashed: r.crashed };
        assert.notEqual(r.code, 0, `${name} exited 0`);
      }
    }));

  test("S2d corrupt manifests should fail with FAIL lines, not an uncaught TypeError", () =>
    scenario("S2d", "no uncaught exception on corrupt hook arrays", (d) => {
      const r = attack((root) =>
        mutateManifest(root, (m) => {
          m.monitoringHooks = [null];
        }),
      );
      d.exit = r.code;
      d.stderrHead = r.stderr.split("\n").slice(0, 3).join(" | ");
      assert.equal(r.crashed, false, r.stderr.split("\n")[0]);
    }));

  test(`S2e seeded fuzz (seed ${FUZZ_SEED}): random key deletion never exits 0`, () =>
    scenario("S2e", "seeded key-deletion fuzz", (d) => {
      const rnd = seededRandom(FUZZ_SEED);
      const base = readManifest();
      const paths = [];
      const walk = (obj, prefix) => {
        if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj)) {
            const p = [...prefix, key];
            paths.push(p);
            walk(obj[key], p);
          }
        }
      };
      walk(base, []);
      d.seed = FUZZ_SEED;
      d.iterations = 40;
      d.exitZero = [];
      d.crashes = [];
      for (let i = 0; i < d.iterations; i++) {
        const victim = paths[Math.floor(rnd() * paths.length)];
        const r = attack((root) =>
          mutateManifest(root, (m) => {
            let cur = m;
            for (const k of victim.slice(0, -1)) cur = cur[k];
            if (Array.isArray(cur)) cur.splice(Number(victim.at(-1)), 1);
            else delete cur[victim.at(-1)];
          }),
        );
        if (r.code === 0) d.exitZero.push(victim.join("."));
        if (r.crashed) d.crashes.push(victim.join("."));
      }
      d.exitZeroUnique = [...new Set(d.exitZero)];
      // Deleting a $comment / rules / description is legitimately cosmetic; every
      // other exit-0 deletion is a check the manifest lacks and is listed here.
      d.exitZeroNonCosmetic = d.exitZeroUnique.filter(
        (p) => !/\$comment|rules|description|owner|notes|schemaVersion/.test(p),
      );
      assert.deepEqual(
        d.exitZeroNonCosmetic.filter((p) =>
          /^(irreversibleActions|releaseBlockingSteps)\.\d+$/.test(p),
        ),
        [],
        `deleting whole entries exited 0: ${d.exitZeroNonCosmetic.join(", ")}`,
      );
    }));
});

describe("S3 runtimeConfig APP_VERSION quoting", () => {
  test('S3 semantically identical `"1.0"` must still PASS the version-triple check', () =>
    scenario("S3", 'APP_VERSION = "1.0" (double quotes)', (d) => {
      const r = attack((root) => {
        const src = readSandbox(root, RUNTIME_CONFIG);
        const next = src.replace("const APP_VERSION = '1.0';", 'const APP_VERSION = "1.0";');
        assert.notEqual(next, src, "fixture line not found");
        writeSandbox(root, RUNTIME_CONFIG, next);
      });
      d.exit = r.code;
      d.failLines = r.failLines;
      assert.equal(r.code, 0, `false-fail: ${r.failLines.join(" | ")}`);
    }));

  test("S3b typed / as-const / no-semicolon spellings of the same value must PASS", () =>
    scenario("S3b", "APP_VERSION formatting variants", (d) => {
      const variants = [
        "const APP_VERSION: string = '1.0';",
        "const APP_VERSION = '1.0' as const;",
        "const APP_VERSION = '1.0'",
        "const  APP_VERSION = '1.0';",
      ];
      d.falseFails = [];
      for (const v of variants) {
        const r = attack((root) => {
          writeSandbox(
            root,
            RUNTIME_CONFIG,
            readSandbox(root, RUNTIME_CONFIG).replace("const APP_VERSION = '1.0';", v),
          );
        });
        if (r.code !== 0) d.falseFails.push(v);
      }
      assert.deepEqual(d.falseFails, []);
    }));

  test("S3c a genuinely wrong APP_VERSION must FAIL (control)", () =>
    scenario("S3c", "APP_VERSION = '9.9' rejected", (d) => {
      const r = attack((root) =>
        writeSandbox(
          root,
          RUNTIME_CONFIG,
          readSandbox(root, RUNTIME_CONFIG).replace("APP_VERSION = '1.0'", "APP_VERSION = '9.9'"),
        ),
      );
      d.exit = r.code;
      assert.equal(r.code, 1);
    }));
});

describe("S7 buildNumber validation", () => {
  const REJECT = [1.5, 0, -1, "1", true, null];
  for (const value of REJECT) {
    test(`S7 buildNumber ${JSON.stringify(value)} rejected`, () =>
      scenario(`S7:${JSON.stringify(value)}`, `buildNumber ${JSON.stringify(value)}`, (d) => {
        const r = attack((root) =>
          mutateManifest(root, (m) => {
            m.versionScheme.buildNumber = value;
          }),
        );
        d.exit = r.code;
        d.failLines = r.failLines;
        assert.equal(r.code, 1);
        assert.ok(
          r.failLines.some((l) => l.includes("buildNumber is a positive integer")),
          r.failLines.join(" | "),
        );
      }));
  }

  test("S7b buildNumber beyond 2^53 is not silently accepted as a different integer", () =>
    scenario("S7b", "buildNumber 9007199254740993", (d) => {
      const r = attack((root) =>
        mutateManifest(root, (m) =>
          readSandbox(root, MANIFEST).replace(
            /"buildNumber": 1,/,
            '"buildNumber": 9007199254740993,',
          ),
        ),
      );
      d.exit = r.code;
      d.failLines = r.failLines;
      assert.equal(r.code, 1);
    }));
});

describe("E marketingVersion + pbxproj/gradle drift", () => {
  test("E2 unicode full-width digits in marketingVersion rejected", () =>
    scenario("E2", "marketingVersion １.０", (d) => {
      const r = attack((root) =>
        mutateManifest(root, (m) => {
          m.versionScheme.marketingVersion = "１.０";
        }),
      );
      d.exit = r.code;
      assert.equal(r.code, 1);
      assert.ok(r.failLines.some((l) => l.includes("MAJOR.MINOR")));
    }));

  test("E3 marketingVersion 1.0.0 vs pbxproj 1.0 rejected", () =>
    scenario("E3", "marketingVersion 1.0.0 mismatch", (d) => {
      const r = attack((root) =>
        mutateManifest(root, (m) => {
          m.versionScheme.marketingVersion = "1.0.0";
        }),
      );
      d.exit = r.code;
      assert.equal(r.code, 1);
    }));

  test("E4 Release build configuration drifting to 2.0/99 while Debug stays 1.0/1 must FAIL", () =>
    scenario("E4", "pbxproj Release config drift", (d) => {
      const r = attack((root) => {
        const src = readSandbox(root, PBXPROJ);
        const cut = src.indexOf("MARKETING_VERSION = 1.0;") + "MARKETING_VERSION = 1.0;".length;
        assert.ok(cut > 0);
        const tail = src
          .slice(cut)
          .replace("MARKETING_VERSION = 1.0;", "MARKETING_VERSION = 2.0;")
          .replace("CURRENT_PROJECT_VERSION = 1;", "CURRENT_PROJECT_VERSION = 99;");
        const next = src.slice(0, cut) + tail;
        d.marketingVersions = [...new Set(next.match(/MARKETING_VERSION = [^;]+;/g))];
        d.projectVersions = [...new Set(next.match(/CURRENT_PROJECT_VERSION = [^;]+;/g))];
        assert.equal(d.marketingVersions.length, 2, "fixture did not create two distinct configs");
        writeSandbox(root, PBXPROJ, next);
      });
      d.exit = r.code;
      d.failLines = r.failLines;
      assert.notEqual(r.code, 0, "checker exit 0 with Release=2.0/99 and Debug=1.0/1");
    }));

  test("E5 a second gradle versionCode/versionName in another flavor must FAIL", () =>
    scenario("E5", "gradle duplicate versionCode", (d) => {
      const r = attack((root) => {
        const src = readSandbox(root, GRADLE);
        writeSandbox(
          root,
          GRADLE,
          src + '\n// drifted flavor\n// versionCode 42\nversionCode 42\nversionName "4.2"\n',
        );
      });
      d.exit = r.code;
      assert.notEqual(r.code, 0);
    }));
});

describe("E docs / manifest / runtimeConfig coherence", () => {
  const manifest = readManifest();
  const runtimeConfig = readRepo(RUNTIME_CONFIG);
  const apiBase = runtimeConfig
    .match(/const API_BASE_URL: string \| null =\s*([^;]+);/)?.[1]
    .trim();

  test("E9 manifest environment story matches committed runtimeConfig.ts", () =>
    scenario("E9", "manifest environments vs runtimeConfig API_BASE_URL", (d) => {
      d.runtimeConfigApiBaseUrlIsNull = apiBase === "null";
      d.manifestProductionApiOrigin = manifest.environments.production.apiOrigin;
      d.manifestDevelopmentMobileConfig = manifest.environments.development.mobileConfig;
      d.manifestProductionMobileConfig = manifest.environments.production.mobileConfig;
      assert.ok(apiBase, "API_BASE_URL declaration not found");
      // The manifest claims runtimeConfig defaults are all null and that production
      // values are "never committed"; the checker enforces production.apiOrigin ===
      // "tbd". Either the committed config must be null OR the manifest must carry
      // the real production origin — not both stories at once.
      const coherent =
        apiBase === "null" ||
        (manifest.environments.production.apiOrigin !== "tbd" &&
          apiBase.includes(manifest.environments.production.apiOrigin));
      assert.ok(
        coherent,
        `runtimeConfig commits a real API origin while manifest.production.apiOrigin=${JSON.stringify(
          manifest.environments.production.apiOrigin,
        )} and development.mobileConfig=${JSON.stringify(manifest.environments.development.mobileConfig)}`,
      );
    }));

  test("E7 RELEASE_OPERATIONS.md privacy section matches PrivacyInfo.xcprivacy + runtimeConfig", () =>
    scenario("E7", "RELEASE_OPERATIONS.md privacy paragraph vs code", (d) => {
      const ops = readRepo("docs/RELEASE_OPERATIONS.md");
      const xcprivacy = readRepo(XCPRIVACY);
      d.collectedTypes = (xcprivacy.match(/<key>NSPrivacyCollectedDataType<\/key>/g) ?? []).length;
      d.docsClaimsCollectedEmpty = /NSPrivacyCollectedDataTypes`?\s*\n?\s*empty/.test(ops);
      d.docsClaimsApiBaseUrlNull = /`apiBaseUrl` null/.test(ops);
      d.runtimeConfigApiBaseUrlIsNull = apiBase === "null";
      const problems = [];
      if (d.docsClaimsCollectedEmpty && d.collectedTypes > 0) {
        problems.push(
          `docs say NSPrivacyCollectedDataTypes empty; manifest declares ${d.collectedTypes} types`,
        );
      }
      if (d.docsClaimsApiBaseUrlNull && apiBase !== "null") {
        problems.push(
          "docs describe the default build as apiBaseUrl null; runtimeConfig commits a backend",
        );
      }
      d.problems = problems;
      assert.deepEqual(problems, []);
    }));

  test("E10 dossier §11.5 Version equals manifest marketingVersion", () =>
    scenario("E10", "APP_STORE_SUBMISSION §11.5 version", (d) => {
      const dossier = readRepo("docs/APP_STORE_SUBMISSION.md");
      const m = dossier.match(/\| Version\s*\|\s*`ENTER:` `([^`]+)`/);
      d.dossierVersion = m?.[1];
      d.manifestVersion = manifest.versionScheme.marketingVersion;
      assert.equal(d.dossierVersion, d.manifestVersion);
    }));

  test("E11 dossier §5 tracking No agrees with PrivacyInfo.xcprivacy NSPrivacyTracking", () =>
    scenario("E11", "dossier tracking vs xcprivacy", (d) => {
      const dossier = readRepo("docs/APP_STORE_SUBMISSION.md");
      const xcprivacy = readRepo(XCPRIVACY);
      d.xcprivacyTrackingFalse = /<key>NSPrivacyTracking<\/key>\s*<false\/>/.test(xcprivacy);
      d.dossierTrackingNo = /Tracking is No for every type/.test(dossier);
      assert.ok(d.xcprivacyTrackingFalse && d.dossierTrackingNo);
    }));

  test("E12 store copy (§11.2–11.4) carries no forbidden terms or claims", () =>
    scenario("E12", "store-copy rules on promotional text/keywords/description", (d) => {
      const dossier = readRepo("docs/APP_STORE_SUBMISSION.md");
      const start = dossier.indexOf("### 11.2 Promotional Text");
      const end = dossier.indexOf("### 11.5 URLs, version, copyright");
      assert.ok(start > 0 && end > start, "store-copy sections not found");
      const copy = dossier
        .slice(start, end)
        .split("```")
        .filter((_, i) => i % 2 === 1)
        .join("\n");
      d.copyChars = copy.length;
      const forbidden =
        /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?% (accura|precis)|most accurate|#1|best (pickleball )?coach|replaces? (a|your) coach|as good as a coach/i;
      d.hits = copy.split("\n").filter((l) => forbidden.test(l));
      assert.deepEqual(d.hits, []);
    }));

  test("E13 manifest versionScheme rule text agrees with the checker regex", () =>
    scenario(
      "E13",
      "rules.marketingVersion says MAJOR.MINOR.PATCH but value is MAJOR.MINOR",
      (d) => {
        d.rule = manifest.versionScheme.rules.marketingVersion;
        d.value = manifest.versionScheme.marketingVersion;
        const ruleRequiresPatch = /^MAJOR\.MINOR\.PATCH;/.test(d.rule);
        const valueHasPatch = /^\d+\.\d+\.\d+$/.test(d.value);
        assert.ok(!ruleRequiresPatch || valueHasPatch, `${d.rule} vs ${d.value}`);
      },
    ));
});
