// Automated store-copy rule scan (APP_STORE_SUBMISSION.md §0 hard rules,
// REVIEW.md). Today these rules are enforced by manual grep only. The scan
// covers (a) every `ENTER:` value / fenced ENTER block in the dossier and
// (b) user-facing string literals and JSX text in apps/mobile/src.
//
//   node --test tools/release/__audit__/
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { readRepoFile, repoRoot } from "./fixture.mjs";

const PROHIBITED =
  /\b(Android|Google Play|guest mode|Live Court|DUPR|SwingVision|PB Vision|Selkirk|JOOLA)\b/;
const CLAIMS =
  /(\d{1,3}\s?% (accura|precis)|\bmost accurate\b|\bbest\b|\b#1\b|world[- ]class|\bperfect\b|as good as a (real|human) coach|replaces? (your|a) coach)/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Yields user-facing text candidates: string literals and JSX text nodes. */
function userFacingText(source) {
  const out = [];
  const lines = source.split("\n");
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const m of line.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
      if (m[2].length >= 4 && /[A-Za-z]/.test(m[2]) && !/^[\w./:@-]+$/.test(m[2])) {
        out.push({ line: i + 1, text: m[2] });
      }
    }
    const jsx = />([^<>{}]*[A-Za-z][^<>{}]*)</.exec(line);
    if (jsx) out.push({ line: i + 1, text: jsx[1].trim() });
  });
  return out;
}

function androidGuarded(lines, idx) {
  return lines.slice(Math.max(0, idx - 8), idx).some((l) => /Platform\.OS === 'android'/.test(l));
}

test("dossier ENTER: values contain no prohibited terms or claim language", () => {
  const dossier = readRepoFile("docs/APP_STORE_SUBMISSION.md");
  const hits = [];
  const lines = dossier.split("\n");
  let inEnterBlock = false;
  lines.forEach((line, i) => {
    if (/`ENTER:`/.test(line) && !/```/.test(line)) {
      const value = line.split("`ENTER:`").slice(1).join(" ");
      if (PROHIBITED.test(value) || CLAIMS.test(value))
        hits.push(`L${i + 1}: ${value.trim().slice(0, 120)}`);
      if (/^`ENTER:`/.test(line.trim())) inEnterBlock = true;
      return;
    }
    if (inEnterBlock && /^```/.test(line)) {
      inEnterBlock = inEnterBlock === "open" ? false : "open";
      return;
    }
    if (inEnterBlock === "open" && (PROHIBITED.test(line) || CLAIMS.test(line))) {
      hits.push(`L${i + 1}: ${line.trim().slice(0, 120)}`);
    }
    if (inEnterBlock === true && line.trim() && !/^```/.test(line)) inEnterBlock = false;
  });
  assert.deepEqual(hits, []);
});

test("apps/mobile/src user-facing strings contain no prohibited terms", () => {
  const files = walk(join(repoRoot, "apps/mobile/src"));
  const hits = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    for (const { line, text } of userFacingText(source)) {
      const m = PROHIBITED.exec(text);
      if (!m) continue;
      if (/^(Android|Google Play)$/.test(m[1]) && androidGuarded(lines, line - 1)) continue;
      hits.push(`${relative(repoRoot, file)}:${line}: ${m[1]} — ${text.slice(0, 100)}`);
    }
  }
  assert.deepEqual(hits, [], `prohibited terms in user-facing copy:\n${hits.join("\n")}`);
});

test("apps/mobile/src user-facing strings contain no superlative / accuracy / coach-equivalence claims", () => {
  const files = walk(join(repoRoot, "apps/mobile/src"));
  const hits = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const { line, text } of userFacingText(source)) {
      const m = CLAIMS.exec(text);
      if (!m) continue;
      // "best" as a possessive/adjective of the user's own results is not a
      // product claim ("personal best", "your best score").
      if (
        /\bbest\b/i.test(m[0]) &&
        /(personal|your|their|my|session|new|all-time) best|best (score|so far|attempt|rep|shot|swing|stroke|day|streak)|best \$\{|\$\{best\b/i.test(
          text,
        )
      )
        continue;
      hits.push(`${relative(repoRoot, file)}:${line}: ${m[0]} — ${text.slice(0, 100)}`);
    }
  }
  assert.deepEqual(hits, [], `claim language in user-facing copy:\n${hits.join("\n")}`);
});
