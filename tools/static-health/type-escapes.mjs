#!/usr/bin/env node
// Type-escape-hatch census for packages/*, services/*, tools/*, ml/.
//
//   node tools/static-health/type-escapes.mjs [--out report.json] [--md report.md] [--roots a,b,c]
//
// TypeScript files are parsed with the repo's own `typescript` compiler (AST, not
// regex) so we count real constructs, not words in strings/comments:
//   any            AnyKeyword type nodes (explicit `any` in annotations/generics)
//   as-any         `expr as any` / `<any>expr`
//   as-unknown-as  `expr as unknown as T` double-cast
//   non-null       `expr!` NonNullExpression, sub-classified by operand shape:
//                    index (`a[i]!`), map-get (`m.get(k)!`), find (`.find(..)!`,
//                    `.at(..)!`, `.pop()!`, `.shift()!`), regex-match (`m[1]!` on
//                    RegExpMatchArray is still index), property (`a.b!`), other
//   type-assertion any other `expr as T` / `<T>expr` (informational; often legitimate)
// Suppression comments are scanned textually (they only exist in comments):
//   ts-ignore, ts-expect-error, ts-nocheck, eslint-disable(-next-line|-line)
// Python files (ml/) are scanned textually:
//   type-ignore    `# type: ignore`
//   typing-any     `Any` from typing used in an annotation
//   cast           `typing.cast(` / `cast(`
//   noqa           `# noqa`
//
// Every hit is recorded with file:line so the report is a checkable table, and
// split by src vs test so production escapes are visible separately.
// Read-only: writes only the requested report files.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join, extname, isAbsolute } from "node:path";
import { REPO_ROOT, walk, rel } from "./lib/repo.mjs";

const require = createRequire(join(REPO_ROOT, "package.json"));
const ts = require("typescript");

const args = process.argv.slice(2);
const opt = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const roots = (opt("--roots") ?? "packages,services,tools,ml").split(",");

const TS_EXT = new Set([".ts", ".tsx", ".mts", ".cts"]);
const isTest = (p) =>
  /(^|\/)(test|tests|__tests__|e2e)\/|\.(test|spec)\.[cm]?tsx?$|(^|\/)test_[^/]*\.py$/.test(p);

/** @type {{kind:string,file:string,line:number,scope:"src"|"test",snippet:string}[]} */
const hits = [];
let tsFiles = 0;
let pyFiles = 0;

function push(kind, file, line, scope, snippet, shape) {
  const h = { kind, file, line, scope, snippet: snippet.trim().slice(0, 140) };
  if (shape) h.shape = shape;
  hits.push(h);
}

const FIND_LIKE = new Set(["find", "findLast", "at", "pop", "shift", "match", "exec", "reduce"]);
function nonNullShape(expr) {
  if (ts.isParenthesizedExpression(expr)) return nonNullShape(expr.expression);
  if (ts.isElementAccessExpression(expr)) return "index";
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const name = expr.expression.name.text;
    if (name === "get") return "map-get";
    if (FIND_LIKE.has(name)) return "find";
    return "call";
  }
  if (ts.isCallExpression(expr)) return "call";
  if (ts.isPropertyAccessExpression(expr)) return "property";
  if (ts.isIdentifier(expr)) return "identifier";
  return "other";
}

function scanTs(abs) {
  const file = rel(abs);
  const scope = isTest(file) ? "test" : "src";
  const text = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(
    abs,
    text,
    ts.ScriptTarget.Latest,
    true,
    abs.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = text.split("\n");
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const snip = (node) => lines[lineOf(node) - 1] ?? "";

  const isAny = (t) => t && t.kind === ts.SyntaxKind.AnyKeyword;
  const isUnknown = (t) => t && t.kind === ts.SyntaxKind.UnknownKeyword;
  // The outer half of `x as unknown as T` is already recorded as as-unknown-as.
  const isUnknownCast = (e) =>
    (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) && isUnknown(e.type);

  const visit = (node) => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (isAny(node.type)) push("as-any", file, lineOf(node), scope, snip(node));
      else if (
        isUnknown(node.type) &&
        (ts.isAsExpression(node.parent) || ts.isTypeAssertionExpression(node.parent))
      ) {
        push("as-unknown-as", file, lineOf(node.parent), scope, snip(node.parent));
      } else if (
        !isUnknown(node.type) &&
        !ts.isConstTypeReference(node.type) &&
        !isUnknownCast(node.expression)
      ) {
        push("type-assertion", file, lineOf(node), scope, snip(node));
      }
    } else if (ts.isNonNullExpression(node)) {
      push("non-null", file, lineOf(node), scope, snip(node), nonNullShape(node.expression));
    } else if (node.kind === ts.SyntaxKind.AnyKeyword) {
      // `as any` is counted above; skip its type node so it is not double counted.
      const p = node.parent;
      if (!(p && (ts.isAsExpression(p) || ts.isTypeAssertionExpression(p)) && p.type === node)) {
        push("any", file, lineOf(node), scope, snip(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  lines.forEach((l, i) => {
    const m = l.match(/@ts-(ignore|expect-error|nocheck)\b/);
    if (m) push(`ts-${m[1]}`, file, i + 1, scope, l);
    if (/eslint-disable(-next-line|-line)?\b/.test(l))
      push("eslint-disable", file, i + 1, scope, l);
  });
  tsFiles++;
}

function scanPy(abs) {
  const file = rel(abs);
  const scope = isTest(file) ? "test" : "src";
  const lines = readFileSync(abs, "utf8").split("\n");
  lines.forEach((l, i) => {
    if (/#\s*type:\s*ignore/.test(l)) push("type-ignore", file, i + 1, scope, l);
    if (/#\s*noqa\b/.test(l)) push("noqa", file, i + 1, scope, l);
    if (/\bcast\(/.test(l) && !/^\s*#/.test(l)) push("cast", file, i + 1, scope, l);
    if (/(:\s*|->\s*|\[)Any\b/.test(l) && !/^\s*#/.test(l) && !/^\s*from typing import/.test(l)) {
      push("typing-any", file, i + 1, scope, l);
    }
  });
  pyFiles++;
}

for (const root of roots) {
  for (const abs of walk(isAbsolute(root) ? root : join(REPO_ROOT, root))) {
    const ext = extname(abs);
    if (TS_EXT.has(ext) && !abs.endsWith(".d.ts")) scanTs(abs);
    else if (ext === ".py") scanPy(abs);
  }
}

const KINDS = [
  "any",
  "as-any",
  "as-unknown-as",
  "non-null",
  "ts-ignore",
  "ts-expect-error",
  "ts-nocheck",
  "eslint-disable",
  "type-assertion",
  "type-ignore",
  "typing-any",
  "cast",
  "noqa",
];
const byKind = {};
for (const k of KINDS) byKind[k] = { src: 0, test: 0 };
for (const h of hits) byKind[h.kind][h.scope]++;

const nonNullShapes = {};
for (const h of hits) {
  if (h.kind !== "non-null") continue;
  nonNullShapes[h.shape] ??= { src: 0, test: 0 };
  nonNullShapes[h.shape][h.scope]++;
}

const byPackage = {};
for (const h of hits) {
  const pkg = h.file.split("/").slice(0, 2).join("/");
  byPackage[pkg] ??= {};
  byPackage[pkg][h.kind] = (byPackage[pkg][h.kind] ?? 0) + 1;
}

const report = {
  generatedAt: new Date().toISOString(),
  roots,
  tsFiles,
  pyFiles,
  totals: byKind,
  nonNullShapes,
  byPackage,
  hits: hits.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file) || a.line - b.line,
  ),
};

const out = opt("--out");
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
const md = opt("--md");
if (md) {
  const l = [];
  l.push(
    `# Type escape census (${tsFiles} ts files, ${pyFiles} py files; roots: ${roots.join(", ")})`,
    "",
  );
  l.push("| kind | src | test |", "|---|---|---|");
  for (const k of KINDS) l.push(`| ${k} | ${byKind[k].src} | ${byKind[k].test} |`);
  l.push(
    "",
    "## Hard escapes (src only): any, as-any, as-unknown-as, ts-ignore, ts-expect-error, ts-nocheck, eslint-disable, type-ignore",
    "",
  );
  l.push("| kind | file:line | snippet |", "|---|---|---|");
  const hard = new Set([
    "any",
    "as-any",
    "as-unknown-as",
    "ts-ignore",
    "ts-expect-error",
    "ts-nocheck",
    "eslint-disable",
    "type-ignore",
  ]);
  for (const h of hits.filter((h) => hard.has(h.kind) && h.scope === "src")) {
    l.push(`| ${h.kind} | ${h.file}:${h.line} | \`${h.snippet.replace(/\|/g, "\\|")}\` |`);
  }
  l.push(
    "",
    "## Non-null assertions by operand shape",
    "",
    "| shape | src | test |",
    "|---|---|---|",
  );
  for (const [s, c] of Object.entries(nonNullShapes).sort((a, b) => b[1].src - a[1].src))
    l.push(`| ${s} | ${c.src} | ${c.test} |`);
  l.push(
    "",
    "## Non-null assertions by package (src)",
    "",
    "| package | non-null (src) |",
    "|---|---|",
  );
  for (const [pkg, kinds] of Object.entries(byPackage).sort()) {
    const n = hits.filter(
      (h) => h.kind === "non-null" && h.scope === "src" && h.file.startsWith(pkg + "/"),
    ).length;
    if (n) l.push(`| ${pkg} | ${n} |`);
  }
  writeFileSync(md, l.join("\n") + "\n");
}
console.log(JSON.stringify({ tsFiles, pyFiles, totals: byKind, nonNullShapes }, null, 2));
