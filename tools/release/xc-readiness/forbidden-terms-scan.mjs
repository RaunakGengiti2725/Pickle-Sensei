#!/usr/bin/env node
/**
 * Store-copy forbidden-terms scan over every user-facing string.
 *
 * Extracts string literals, template literals and JSX text from the mobile
 * app sources and the production edge function with the TypeScript compiler
 * API (so code identifiers such as `Platform.OS === 'android'` can be told
 * apart from copy), and scans them together with Info.plist usage strings and
 * the App Store dossier for the hard-rule terms in docs/APP_STORE_SUBMISSION.md
 * §0 rules 4–5 and REVIEW.md "Launch flow & copy".
 *
 * Read-only. Exit 0 = no HARD hit in copy-like text; exit 1 otherwise.
 * REVIEW-severity hits (superlatives, bare "accuracy", coach-equivalence
 * phrasing) never fail the run — they are listed for a human read.
 *
 * Usage:
 *   node tools/release/xc-readiness/forbidden-terms-scan.mjs [--json out.json] [--md out.md]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const require = createRequire(join(repoRoot, "package.json"));
const ts = require("typescript");

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const jsonOut = argValue("--json");
const mdOut = argValue("--md");

// ---------------------------------------------------------------------------
// Rules. HARD = never allowed in user-facing/store copy. REVIEW = must be read
// by a human (context decides); never fails the scan.
// ---------------------------------------------------------------------------
const RULES = [
  { id: "android", severity: "HARD", re: /\bandroid\b/i, why: "Android is not shipping" },
  {
    id: "google_play",
    severity: "HARD",
    re: /\bgoogle play\b|\bplay store\b/i,
    why: "no Play mention",
  },
  {
    id: "guest_mode",
    severity: "HARD",
    re: /\bguest[- ]mode\b/i,
    why: "guest mode has no UI entry point",
  },
  {
    id: "live_court",
    severity: "HARD",
    re: /\blive[- ]court\b/i,
    why: "Live Court was cut from v1",
  },
  { id: "dupr", severity: "HARD", re: /\bdupr\b/i, why: "third-party trademark" },
  {
    id: "competitor",
    severity: "HARD",
    re: /\bswing\s?vision\b|\bpb\s?vision\b|\bselkirk\b|\bjoola\b/i,
    why: "competitor names violate guideline 2.3.7",
  },
  {
    id: "accuracy_percent",
    severity: "HARD",
    re: /\d{1,3}(?:\.\d+)?\s?%\s*(?:accura|precis|correct|reliab)|(?:accura|precis)\w*\s+(?:of\s+)?\d{1,3}(?:\.\d+)?\s?%/i,
    why: "no accuracy percentages",
  },
  {
    id: "coach_equivalence",
    severity: "HARD",
    re: /\b(?:as good as|better than|replaces?|instead of|equivalent to|just like|same as)\s+(?:a\s+|an\s+|your\s+|the\s+)?(?:real\s+|human\s+|personal\s+|pro\s+|private\s+|in-person\s+|professional\s+)?coach(?:es|ing)?\b/i,
    why: "no AI-coach-equivalence claim",
  },
  {
    id: "superlative",
    severity: "REVIEW",
    re: /\b(?:the\s+best|#\s?1|number\s+one|world['’]?s\s+(?:best|first|only|most)|most\s+accurate|most\s+advanced|ultimate|unbeatable|flawless|guaranteed?|revolutionary|industry[- ]leading|market[- ]leading|cutting[- ]edge|state[- ]of[- ]the[- ]art|perfect(?:ly)?\s+accurate)\b/i,
    why: "superlatives forbidden in store copy",
  },
  {
    id: "accuracy_word",
    severity: "REVIEW",
    re: /\baccura(?:cy|te|tely)\b/i,
    why: "only validated / server-accepted / estimate language",
  },
  {
    id: "ai_coach",
    severity: "REVIEW",
    re: /\bAI[- ]coach\b|\bAI[- ]powered\b/i,
    why: "check for coach-equivalence framing",
  },
];

// Lines in the dossier / docs that ENUMERATE the forbidden terms (rule text) are
// classified META and never count as copy.
const META_LINE_RE =
  /do not mention|never mention|not shipping|was cut|cut from v1|third-party trademark|forbid|violat|hard rule|no (?:android|accuracy)|never (?:claim|use|say)|guideline 2\.3\.7|must not|banned|denylist|blocklist|prohibit/i;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
function walk(dir, pred, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__" || entry === "__mocks__") continue;
      walk(p, pred, out);
    } else if (pred(p)) out.push(p);
  }
  return out;
}
const isSource = (p) =>
  /\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p) && !/\.d\.ts$/.test(p);

const tsFiles = [
  ...walk(join(repoRoot, "apps/mobile/src"), isSource),
  join(repoRoot, "apps/mobile/App.tsx"),
  ...walk(join(repoRoot, "supabase/functions/api"), (p) => isSource(p) && !p.includes("/__wf__/")),
];

const copyLike = (text) =>
  /[A-Za-z]/.test(text) && (/\s/.test(text.trim()) || /[.!?]$/.test(text.trim()));

function extractStrings(file) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = [];
  // A literal nested in the non-iOS arm of a Platform.OS branch is never
  // rendered on the shipping product; it is reported but classified apart.
  const nonIosBranch = (node) => {
    let child = node;
    let p = node.parent;
    while (p) {
      if (ts.isConditionalExpression(p)) {
        const cond = p.condition.getText(sf);
        const inTrue =
          p.whenTrue === child || (p.whenTrue.pos <= child.pos && child.end <= p.whenTrue.end);
        const inFalse =
          p.whenFalse === child || (p.whenFalse.pos <= child.pos && child.end <= p.whenFalse.end);
        if (/Platform\.OS\s*===\s*['"]android['"]/.test(cond) && inTrue) return true;
        if (/Platform\.OS\s*===\s*['"]ios['"]/.test(cond) && inFalse) return true;
        if (/Platform\.OS\s*!==\s*['"]ios['"]/.test(cond) && inTrue) return true;
      } else if (ts.isIfStatement(p)) {
        const cond = p.expression.getText(sf);
        const inThen = p.thenStatement.pos <= child.pos && child.end <= p.thenStatement.end;
        if (/Platform\.OS\s*===\s*['"]android['"]/.test(cond) && inThen) return true;
        if (/Platform\.OS\s*!==\s*['"]ios['"]/.test(cond) && inThen) return true;
      }
      child = p;
      p = p.parent;
    }
    return false;
  };
  // Property names whose value is third-party attribution (YouTube channel
  // names on embedded drill videos) — not marketing copy about the product.
  const attribution = (node) =>
    node.parent &&
    ts.isPropertyAssignment(node.parent) &&
    node.parent.initializer === node &&
    /^(creatorName|channelName|attribution)$/.test(node.parent.name.getText(sf));
  const push = (node, value, kind) => {
    if (!value || !/[A-Za-z]/.test(value)) return;
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const context = nonIosBranch(node)
      ? "NON_IOS_BRANCH"
      : attribution(node)
        ? "ATTRIBUTION"
        : null;
    found.push({ value, kind, line: line + 1, col: character + 1, context });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) {
      // object key — scan only the initializer
      visit(node.initializer);
      return;
    }
    if (ts.isStringLiteral(node)) push(node, node.text, "string");
    else if (ts.isNoSubstitutionTemplateLiteral(node)) push(node, node.text, "template");
    else if (ts.isTemplateExpression(node)) {
      push(node.head, node.head.text, "template");
      for (const span of node.templateSpans) push(span.literal, span.literal.text, "template");
    } else if (ts.isJsxText(node)) push(node, node.text.trim(), "jsx");
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function scanText(rel, kind, value, line, col, hits, counters, context = null) {
  counters.strings += 1;
  for (const rule of RULES) {
    const re = new RegExp(
      rule.re.source,
      rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`,
    );
    for (const m of value.matchAll(re)) {
      // multi-line template literals: attribute each match to its own line
      const before = value.slice(0, m.index);
      const nl = before.split("\n").length - 1;
      const lineText = value.split("\n")[nl] ?? value;
      const isMeta = context === "META" || META_LINE_RE.test(lineText);
      const isCopy = copyLike(lineText);
      hits.push({
        rule: rule.id,
        severity: rule.severity,
        classification: isMeta
          ? "META"
          : context === "NON_IOS_BRANCH" || context === "ATTRIBUTION"
            ? context
            : isCopy
              ? "COPY"
              : "IDENTIFIER",
        file: rel,
        line: line + nl,
        col: nl === 0 ? col : 1,
        kind,
        match: m[0],
        text: lineText.length > 240 ? `${lineText.slice(0, 240)}…` : lineText,
        why: rule.why,
      });
    }
  }
}

const hits = [];
const counters = { files: 0, strings: 0 };

for (const file of tsFiles) {
  counters.files += 1;
  const rel = relative(repoRoot, file);
  for (const s of extractStrings(file))
    scanText(rel, s.kind, s.value, s.line, s.col, hits, counters, s.context);
}

// Info.plist usage strings (user-visible permission prompts)
{
  const rel = "apps/mobile/ios/PickleSensei/Info.plist";
  const lines = readFileSync(join(repoRoot, rel), "utf8").split("\n");
  counters.files += 1;
  lines.forEach((l, i) => {
    const m = /<string>(.*)<\/string>/.exec(l);
    if (m) scanText(rel, "plist", m[1], i + 1, 1, hits, counters);
  });
}

// Store dossier: only the App Store metadata sections (H2 headings matching
// COPY_SECTION_RE — the text that is pasted into App Store Connect) are store
// copy; the rest of the dossier is checklist/policy prose and is META.
// Release notes template: every line is potential store copy.
const COPY_SECTION_RE = /^## \d+\.\s+(App Store metadata|Metadata|Store listing|Copy)/i;
for (const rel of ["docs/APP_STORE_SUBMISSION.md", "docs/RELEASE_NOTES_TEMPLATE.md"]) {
  const lines = readFileSync(join(repoRoot, rel), "utf8").split("\n");
  counters.files += 1;
  const isDossier = rel.endsWith("APP_STORE_SUBMISSION.md");
  let inCopySection = !isDossier;
  lines.forEach((l, i) => {
    if (isDossier && /^## /.test(l)) inCopySection = COPY_SECTION_RE.test(l);
    if (l.trim())
      scanText(rel, "markdown", l, i + 1, 1, hits, counters, inCopySection ? null : "META");
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
let gitSha = "unknown";
try {
  gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
} catch {
  /* not a git checkout */
}

const hardCopy = hits.filter((h) => h.severity === "HARD" && h.classification === "COPY");
const summary = {
  tool: "xc-readiness/forbidden-terms-scan",
  gitSha,
  generatedAt: new Date().toISOString(),
  filesScanned: counters.files,
  stringsScanned: counters.strings,
  rules: RULES.map((r) => ({ id: r.id, severity: r.severity, pattern: r.re.source, why: r.why })),
  totals: {
    hits: hits.length,
    hardCopy: hardCopy.length,
    hardIdentifier: hits.filter((h) => h.severity === "HARD" && h.classification === "IDENTIFIER")
      .length,
    hardMeta: hits.filter((h) => h.severity === "HARD" && h.classification === "META").length,
    hardNonIosBranch: hits.filter(
      (h) => h.severity === "HARD" && h.classification === "NON_IOS_BRANCH",
    ).length,
    hardAttribution: hits.filter((h) => h.severity === "HARD" && h.classification === "ATTRIBUTION")
      .length,
    review: hits.filter((h) => h.severity === "REVIEW").length,
  },
  hits,
};

if (jsonOut) writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
if (mdOut) {
  const rows = hits
    .sort((a, b) =>
      a.severity === b.severity ? a.file.localeCompare(b.file) : a.severity === "HARD" ? -1 : 1,
    )
    .map(
      (h) =>
        `| ${h.severity} | ${h.classification} | ${h.rule} | \`${h.file}:${h.line}\` | ${h.match} | ${h.text.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`,
    );
  writeFileSync(
    mdOut,
    [
      `# Forbidden-terms scan — ${gitSha}`,
      "",
      `Files ${counters.files}, strings ${counters.strings}, hits ${hits.length} (HARD/COPY ${hardCopy.length}).`,
      "",
      "| severity | class | rule | location | match | text |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows,
      "",
    ].join("\n"),
  );
}

console.log(
  `scanned ${counters.files} files / ${counters.strings} strings — HARD copy hits: ${hardCopy.length}, HARD identifier-only: ${summary.totals.hardIdentifier}, META: ${summary.totals.hardMeta}, NON_IOS_BRANCH: ${summary.totals.hardNonIosBranch}, ATTRIBUTION: ${summary.totals.hardAttribution}, REVIEW: ${summary.totals.review}`,
);
for (const h of hits.filter((x) => x.classification !== "IDENTIFIER")) {
  console.log(
    `${h.severity.padEnd(6)} ${h.classification.padEnd(10)} ${h.rule.padEnd(18)} ${h.file}:${h.line}  «${h.match}»  ${h.text.replace(/\n/g, " ").slice(0, 140)}`,
  );
}
process.exit(hardCopy.length > 0 ? 1 : 0);
