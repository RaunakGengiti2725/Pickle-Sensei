// node --test tools/static-health/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "../depcheck-consolidate.mjs";

test("classify separates tooling / workspace / runtime / dev / missing", () => {
  assert.equal(classify("typescript", "devDependencies"), "tooling");
  assert.equal(classify("@types/node", "devDependencies"), "tooling");
  assert.equal(classify("eslint-plugin-x", "devDependencies"), "tooling");
  assert.equal(classify("@pickle/scoring", "dependencies"), "workspace");
  assert.equal(classify("zod", "dependencies"), "runtime-lib");
  assert.equal(classify("zod", "devDependencies"), "dev-lib");
  assert.equal(classify("zod", "missing"), "missing");
});

test("consolidated table lists every hit with its class and importer paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "depcheck-"));
  try {
    writeFileSync(
      join(dir, "@pickle_demo.json"),
      JSON.stringify({
        dependencies: ["zod", "@pickle/other"],
        devDependencies: ["vitest"],
        missing: { "node-fetch": ["/x/Pickle-Sensei/packages/demo/src/a.ts"] },
        using: {},
        invalidFiles: {},
        invalidDirs: {},
      }),
    );
    const md = execFileSync(
      process.execPath,
      [fileURLToPath(new URL("../depcheck-consolidate.mjs", import.meta.url)), dir],
      { encoding: "utf8" },
    );
    assert.match(md, /# depcheck consolidated \(4 hits\)/);
    assert.match(md, /\| @pickle\/demo \| zod \| dependencies \| runtime-lib \|/);
    assert.match(md, /\| @pickle\/demo \| @pickle\/other \| dependencies \| workspace \|/);
    assert.match(md, /\| @pickle\/demo \| vitest \| devDependencies \| tooling \|/);
    assert.match(
      md,
      /\| @pickle\/demo \| node-fetch \| missing \| missing \| packages\/demo\/src\/a\.ts \|/,
    );
    const detail = md.slice(md.indexOf("| package | dependency |"));
    const order = ["runtime-lib", "missing", "workspace", "tooling"].map((c) =>
      detail.indexOf(`| ${c} |`),
    );
    assert.ok(
      order.every((i) => i >= 0),
      "every class appears in the detail table",
    );
    assert.ok(
      order[0] < order[1] && order[1] < order[2] && order[2] < order[3],
      "runtime-lib, missing sort first",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
