// Adversarial tests for tools/diagnostics/edge_cold_start.ts (work package H07-01,
// candidate a84b02bf). Pure-helper boundary attacks; no Docker needed.
//
//   deno test -A tools/diagnostics/__attack__/edge_cold_start_args.attack.test.ts
//
// Each test states the expectation a robust CLI would meet. A failing test is a
// confirmed break of the candidate; a passing test is an attack that did not break it.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_API_PORT,
  parseArgs,
  readApiPort,
  readProjectId,
  renderBundleWorkdirConfig,
  summarize,
} from "../edge_cold_start.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

Deno.test("ATTACK boundary: --cycles beyond Number.MAX_SAFE_INTEGER must be rejected", () => {
  // /^\d+$/ + Number(raw) >= 1 accepts any digit string; 1e20 iterations is an unbounded run.
  const raw = "99999999999999999999";
  const rejected = throws(() => parseArgs(["--cycles", raw]));
  const parsed = rejected ? null : parseArgs(["--cycles", raw]);
  assert(
    rejected,
    `expected --cycles ${raw} to be rejected; got cycles=${parsed?.cycles} (Number.isSafeInteger=${Number.isSafeInteger(parsed?.cycles ?? NaN)})`,
  );
});

Deno.test(
  "ATTACK boundary: --warm-requests beyond Number.MAX_SAFE_INTEGER must be rejected",
  () => {
    const raw = "18446744073709551616";
    assert(
      throws(() => parseArgs(["--warm-requests", raw])),
      `expected --warm-requests ${raw} to be rejected; got ${parseArgs(["--warm-requests", raw]).warmRequests}`,
    );
  },
);

Deno.test("ATTACK boundary: malformed integers are rejected (no break expected)", () => {
  for (const bad of ["+3", "3.0", " 3", "3 ", "1e3", "0x10", "-1", "", "00"]) {
    assert(
      throws(() => parseArgs(["--cycles", bad])),
      `--cycles ${JSON.stringify(bad)} accepted`,
    );
  }
  assert(parseArgs(["--cycles", "007"]).cycles === 7, "leading zeros parse as 7");
});

Deno.test("ATTACK boundary: --out '' must not resolve to the repository root", () => {
  // main() does resolve(repoRoot, options.outDir ?? "artifacts/…"); "" is not undefined.
  const rejected = throws(() => parseArgs(["--out", ""]));
  if (!rejected) {
    const options = parseArgs(["--out", ""]);
    const outDir = resolve(repoRoot, options.outDir ?? "unreachable");
    assert(
      outDir !== repoRoot,
      `--out "" accepted and resolves to the repo root ${repoRoot}: report.json, serve-*.log and workdir/ would be written outside the git-ignored artifacts/ tree`,
    );
  }
});

Deno.test("ATTACK boundary: a flag given as the value of --out is swallowed silently", () => {
  // `--out --cycles 5` → outDir="--cycles", then "5" is an unknown argument (throws) — fine.
  assert(
    throws(() => parseArgs(["--out", "--cycles", "5"])),
    "trailing 5 should be unknown",
  );
  // `--out --cycles` alone → outDir="--cycles" and the run proceeds with default cycles.
  const options = parseArgs(["--out", "--cycles"]);
  assert(
    options.outDir !== "--cycles",
    `--out consumed the flag "--cycles" as a directory name (outDir=${JSON.stringify(options.outDir)}) instead of rejecting it`,
  );
});

Deno.test("ATTACK config: TOML forms the Supabase CLI accepts must parse identically", () => {
  // Dotted key and inline table are valid TOML for the same [api] port; the CLI's TOML
  // parser honours them, so the script's baseUrl would silently point at the wrong port.
  const dotted = 'project_id = "pickle-sensei"\napi.port = 55555\n';
  assert(
    readApiPort(dotted) === 55555,
    `dotted key api.port = 55555 read as ${readApiPort(dotted)} (CLI would serve on 55555)`,
  );
  const inline = 'project_id = "pickle-sensei"\napi = { port = 55556 }\n';
  assert(
    readApiPort(inline) === 55556,
    `inline table api = { port = 55556 } read as ${readApiPort(inline)}`,
  );
});

Deno.test("ATTACK config: TOML literal (single-quoted) project_id must be readable", () => {
  const toml = "project_id = 'pickle-sensei'\n\n[functions.api]\nverify_jwt = false\n";
  assert(
    !throws(() => readProjectId(toml)) && readProjectId(toml) === "pickle-sensei",
    "single-quoted TOML string for project_id rejected as 'has no project_id'",
  );
});

Deno.test(
  "ATTACK config: commented-out [api] port must not be picked up (no break expected)",
  () => {
    const toml = 'project_id = "p"\n[api]\n# port = 1\nport = 54321\n';
    assert(readApiPort(toml) === DEFAULT_API_PORT, "comment leaked");
  },
);

Deno.test(
  "ATTACK config: project_id from a [remotes.*] table must not be used when top-level is absent",
  () => {
    // A config whose only project_id lives under [remotes.production] would make the
    // script look for supabase_db_<remote-ref> containers.
    const toml = '[remotes.production]\nproject_id = "abcdefghijklmnopqrst"\n';
    assert(
      throws(() => readProjectId(toml)),
      `remote-scoped project_id accepted as the local project id: ${readProjectId(toml)}`,
    );
  },
);

Deno.test(
  "ATTACK config: rendered workdir config round-trips a projectId with TOML escapes",
  () => {
    const projectId = readProjectId('project_id = "a\\"b"');
    const rendered = renderBundleWorkdirConfig(projectId, 54321);
    assert(readProjectId(rendered) === projectId, "round trip differs");
  },
);

Deno.test("ATTACK numbers: summarize must not silently emit NaN/null statistics", () => {
  const summary = summarize([1, NaN, 3]);
  if (summary === null) {
    throw new Error("null for non-empty input");
  }
  const values = [summary.min, summary.median, summary.mean, summary.max];
  assert(
    !values.some((value) => Number.isNaN(value)),
    `NaN sample produced NaN statistics ${JSON.stringify(values)} (JSON.stringify → null in report.json)`,
  );
});
