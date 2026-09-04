// Attack on the mutation runner CLI (a1b2c248): `--only` must refuse ids that
// are not in the catalogue. Every acceptance command for XCM-08/09/10 is of
// the form `--only <comma separated ids>` → "N KILLED, exit 0"; a mistyped or
// renamed id silently shrinks the selection (worst case to zero mutants) and
// the runner still exits 0 with `killed=0 survived=0 score=n/a` — a green
// verdict that tested nothing.
//
// Lives under mutation/ so the runner's scratch copies (which drop this
// directory) never re-enter it.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MUTANTS } from "./mutants.ts";

const wfDir = new URL("../", import.meta.url);

async function runRunner(args: string[]): Promise<{ code: number; out: string }> {
  const outDir = await Deno.makeTempDir({ prefix: "mutation-only-filter-attack-" });
  try {
    const proc = await new Deno.Command("deno", {
      args: ["run", "-A", "mutation/run_mutations.ts", ...args, "--out", outDir],
      cwd: decodeURIComponent(wfDir.pathname),
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out =
      new TextDecoder().decode(proc.stdout) + "\n" + new TextDecoder().decode(proc.stderr);
    return { code: proc.code, out };
  } finally {
    await Deno.remove(outDir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test(
  "mutation runner attack[--only]: an id that is not in the catalogue is refused (non-zero exit naming the id) instead of a silent 0-mutant exit 0",
  async () => {
    const unknown = "SEC-03-prefix-compar"; // one character short of SEC-03-prefix-compare
    assert(!MUTANTS.some((m) => m.id === unknown));
    const { code, out } = await runRunner(["--mode", "existing", "--only", unknown]);
    assert(code !== 0, `exit ${code} for --only ${unknown}\n${out}`);
    assertStringIncludes(out, unknown);
    assertEquals(/mutants=0 /.test(out), false, "must not report a zero-mutant run as a result");
  },
);

Deno.test(
  "mutation runner attack[--only]: a selection mixing known and unknown ids is refused up front (no partial run reported as complete)",
  async () => {
    const known = MUTANTS[0].id;
    const unknown = `${known}-typo`;
    const { code, out } = await runRunner(["--mode", "existing", "--only", `${known},${unknown}`]);
    assert(code !== 0, `exit ${code} for --only ${known},${unknown}\n${out}`);
    assertStringIncludes(out, unknown);
    assertEquals(
      /\[baseline\]/.test(out),
      false,
      "the selection must be validated before the (expensive) baseline run",
    );
  },
);
