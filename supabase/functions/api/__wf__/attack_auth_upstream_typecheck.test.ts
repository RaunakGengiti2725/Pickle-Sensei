// Adversarial pin for the auth-outage fix (47438f11): the GoTrue call
// classifier `supabaseAuthRequest()` in index.ts must type-check.
//
// `deno check index.ts` has KNOWN pre-existing diagnostics from the untyped
// supabase-js client (AGENTS.md "Scale & security": insert/update infer
// `never`) — those live in the route bodies and are tolerated. The outage fix
// added a NEW class of diagnostic inside its own function: `let body: unknown`
// is tested through an aliased boolean (`const gotrueAnswered = isRecord(body)`)
// and TypeScript only narrows through an aliased condition when the narrowed
// reference is `const`/readonly, so `body.error_code`, `body.msg` and the
// `{ kind: "ok", body }` return are all `unknown` (TS18046 ×6, TS2322 ×1 at
// 47438f11). Baseline 4d812e1a reports 20 diagnostics in index.ts, the
// candidate 27 — every extra one is inside supabaseAuthRequest().
//
// This test runs the real type-checker and asserts that no diagnostic lands
// between the `async function supabaseAuthRequest(` line and the
// `const authUnavailable` line that follows it.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json \
//     attack_auth_upstream_typecheck.test.ts

import { assertEquals } from "@std/assert";

const API_DIR = new URL("../", import.meta.url);
const INDEX_URL = new URL("index.ts", API_DIR);
const CONFIG_PATH = new URL("deno.json", import.meta.url).pathname;

function functionRange(source: string, startMarker: string, endMarker: string) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.includes(startMarker));
  if (start < 0) throw new Error(`${startMarker} not found in index.ts`);
  const end = lines.findIndex((line, index) => index > start && line.includes(endMarker));
  if (end < 0) throw new Error(`${endMarker} not found after ${startMarker}`);
  return { start: start + 1, end: end + 1 }; // 1-based, inclusive
}

Deno.test(
  "ATTACK-TYPES: supabaseAuthRequest() adds no type errors to index.ts (narrow `body` before using it)",
  async () => {
    const source = await Deno.readTextFile(INDEX_URL);
    const range = functionRange(
      source,
      "async function supabaseAuthRequest(",
      "const authUnavailable = (",
    );

    const command = new Deno.Command(Deno.execPath(), {
      args: ["check", "--config", CONFIG_PATH, INDEX_URL.pathname],
      cwd: API_DIR.pathname,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    });
    const { stderr } = await command.output();
    const output = new TextDecoder().decode(stderr);

    // Each diagnostic ends with `at file:///…/index.ts:LINE:COL`.
    const diagnostics: Array<{ line: number; text: string }> = [];
    const blocks = output.split(/\n(?=TS\d+ \[ERROR\])/);
    for (const block of blocks) {
      const match = block.match(/at file:\/\/\S*\/index\.ts:(\d+):\d+/);
      if (!match) continue;
      diagnostics.push({
        line: Number(match[1]),
        text: block.split("\n")[0]?.trim() ?? block.trim(),
      });
    }

    const inside = diagnostics.filter((d) => d.line >= range.start && d.line <= range.end);
    assertEquals(
      inside,
      [],
      `deno check index.ts reports ${inside.length} diagnostic(s) inside supabaseAuthRequest() ` +
        `(lines ${range.start}-${range.end}); total in file: ${diagnostics.length}`,
    );
  },
);
