// node --test tools/static-health/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = fileURLToPath(new URL("../type-escapes.mjs", import.meta.url));

// Fixture lives in a temp dir (not the repo) so the deliberate `any` / ts-ignore
// samples never reach `pnpm lint`.
function withFixture(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "type-escapes-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(root, name, ".."), { recursive: true });
      writeFileSync(join(root, name), body);
    }
    const out = join(root, "report.json");
    execFileSync(process.execPath, [HARNESS, "--roots", root, "--out", out], { stdio: "pipe" });
    return fn(JSON.parse(readFileSync(out, "utf8")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const TS_SRC = `
const a: any = 1;
const b = a as any;
const c = (a as unknown as string).length;
const d = [1][0]!;
const e = new Map<string, number>().get("k")!;
const f = [1].find((x) => x > 0)!;
const g = { h: 1 as number | undefined }.h!;
const i = a as string;
const j = "as any"; // @ts-ignore in a comment only
// eslint-disable-next-line no-console
console.log(b, c, d, e, f, g, i, j);
`;

const PY_SRC = `
from typing import Any, cast
def f(x: Any) -> Any:  # noqa: E501
    return cast(int, x)  # type: ignore
`;

test("counts constructs via the AST, not string contents", () =>
  withFixture({ "src/a.ts": TS_SRC, "src/b.py": PY_SRC }, (r) => {
    assert.equal(r.tsFiles, 1);
    assert.equal(r.pyFiles, 1);
    const src = Object.fromEntries(Object.entries(r.totals).map(([k, v]) => [k, v.src]));
    assert.equal(src.any, 1, "explicit `: any` annotation");
    assert.equal(src["as-any"], 1);
    assert.equal(src["as-unknown-as"], 1);
    assert.equal(src["non-null"], 4);
    assert.equal(
      src["type-assertion"],
      2,
      "`a as string` + `1 as number | undefined`; the outer half of `as unknown as` is not double counted",
    );
    assert.equal(src["ts-ignore"], 1, "comment scan is textual by design");
    assert.equal(src["eslint-disable"], 1);
    assert.deepEqual(r.nonNullShapes, {
      index: { src: 1, test: 0 },
      "map-get": { src: 1, test: 0 },
      find: { src: 1, test: 0 },
      property: { src: 1, test: 0 },
    });
    assert.equal(
      src["typing-any"],
      1,
      "one hit per line (`def f(x: Any) -> Any`); the import line is excluded",
    );
    assert.equal(src.cast, 1);
    assert.equal(src["type-ignore"], 1);
    assert.equal(src.noqa, 1);
    for (const h of r.hits) assert.match(h.file, /(a\.ts|b\.py)$/);
  }));

test("test-path detection splits src from test scope", () =>
  withFixture(
    {
      "src/x.ts": "export const v = [1][0]!;\n",
      "test/x.test.ts": "export const w = [1][0]!;\n",
      "src/__tests__/y.ts": "export const z = [1][0]!;\n",
      "scripts/test_thing.py": "x = 1  # type: ignore\n",
    },
    (r) => {
      assert.deepEqual(r.totals["non-null"], { src: 1, test: 2 });
      assert.deepEqual(r.totals["type-ignore"], { src: 0, test: 1 });
    },
  ));

test("`as const` and `x as unknown` (single) are not escapes", () =>
  withFixture(
    { "src/c.ts": "export const k = [1] as const;\nexport const u = k as unknown;\n" },
    (r) => {
      assert.equal(r.hits.length, 0, JSON.stringify(r.hits));
    },
  ));
