/**
 * Release copy policy scan — library + CLI.
 *
 *   node apps/mobile/scripts/copyPolicy/cli.mjs --out artifacts/copy-policy/<run>
 *
 * Exit code: 0 clean, 2 user-visible strict hits, 3 extraction coverage gap.
 *
 * Surfaces scanned (all relative to the repo root):
 *   apps/mobile/src/**\/*.{ts,tsx}          — every string literal, template
 *                                             piece, JSX text and comment
 *   supabase/functions/api/legal.ts        — served verbatim by /privacy,
 *                                             /terms, /support → all visible
 *   supabase/functions/api/drills.ts       — drill titles/descriptions the
 *                                             app renders (object copy keys)
 *   apps/mobile/ios/PickleSensei/Info.plist — usage-description strings the
 *                                             OS shows in permission prompts
 *   apps/mobile/app.json                   — displayName
 *
 * Output: a JSON report with one row per (string, rule) hit — file, line,
 * column, rule, matched text, slot, visibility — plus per-surface string
 * counts so "0 hits" is distinguishable from "0 strings scanned".
 */
import {
  extractStrings,
  identifierRanges,
  type ExtractedString,
  type Visibility,
} from './extract';
import { APPROVED_LANGUAGE, COPY_RULES, type CopyRule } from './policy';

export interface Hit {
  file: string;
  /** Line of the matched text itself (exact even inside multi-line templates). */
  line: number;
  column: number;
  /** Line where the containing literal/comment starts. */
  literalLine: number;
  rule: string;
  category: CopyRule['category'];
  confidence: CopyRule['confidence'];
  matched: string;
  /** ±60 chars of the raw source around the match, newlines collapsed. */
  context: string;
  slot: string;
  slotName: string | null;
  visibility: Visibility;
  /** True when the policy treats this as a user-visible hit. */
  userVisible: boolean;
}

export interface SurfaceSummary {
  surface: string;
  files: number;
  strings: number;
  byVisibility: Record<Visibility, number>;
}

/**
 * A strict forbidden-term match found in RAW source text that no extracted
 * string, comment or identifier covers — i.e. an extraction gap. Must be empty.
 */
export interface CoverageGap {
  file: string;
  line: number;
  rule: string;
  matched: string;
  context: string;
}

export interface ScanReport {
  generatedAt: string;
  repoRoot: string;
  commit: string | null;
  rules: Array<{
    id: string;
    category: string;
    confidence: string;
    source: string;
    pattern: string;
    requires: string | null;
  }>;
  surfaces: SurfaceSummary[];
  totals: {
    files: number;
    strings: number;
    hits: number;
    userVisibleStrictHits: number;
    userVisibleTriageHits: number;
    nonVisibleHits: number;
    approvedLanguageStrings: number;
  };
  hits: Hit[];
  /** Raw-text matches not attributable to any string/comment/identifier. */
  coverageGaps: CoverageGap[];
  /** Every extracted string that is user-visible (visible|likely) — the audit universe. */
  visibleStrings: Array<
    Pick<
      ExtractedString,
      'file' | 'line' | 'slot' | 'slotName' | 'visibility' | 'text'
    >
  >;
}

export interface Surface {
  name: string;
  /** Repo-relative file list. */
  files: string[];
  allVisible?: boolean;
  /** Custom extractor for non-TS files. */
  kind: 'ts' | 'plist' | 'json-displayName';
}

/**
 * The slice of Node's `fs` / `path` the scan needs. apps/mobile/tsconfig.json
 * has no Node typings (`types: ["jest"]`), so callers hand the real modules
 * in: cli.mjs passes `node:fs` / `node:path`; the Jest suite types
 * `require('fs')` the way the other node-side suites do.
 */
export interface ScanHost {
  existsSync(p: string): boolean;
  readFileSync(p: string, encoding: 'utf8'): string;
  readdirSync(
    p: string,
    options: { withFileTypes: true },
  ): Array<{ name: string; isDirectory(): boolean }>;
  mkdirSync(p: string, options: { recursive: true }): unknown;
  writeFileSync(p: string, data: string): void;
  path: {
    sep: string;
    dirname(p: string): string;
    join(...parts: string[]): string;
    relative(from: string, to: string): string;
  };
}

export function findRepoRoot(host: ScanHost, start: string): string {
  const { path } = host;
  let dir = start;
  for (;;) {
    if (
      host.existsSync(path.join(dir, 'pnpm-workspace.yaml')) &&
      host.existsSync(path.join(dir, 'apps', 'mobile'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`repo root not found from ${start}`);
    }
    dir = parent;
  }
}

function walk(host: ScanHost, dir: string, out: string[]): void {
  const { path } = host;
  for (const entry of host
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '__tests__' ||
        entry.name === '__mocks__'
      ) {
        continue;
      }
      walk(host, p, out);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.d\.ts$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      out.push(p);
    }
  }
}

export function defaultSurfaces(host: ScanHost, repoRoot: string): Surface[] {
  const { path } = host;
  const mobileSrc: string[] = [];
  walk(host, path.join(repoRoot, 'apps', 'mobile', 'src'), mobileSrc);
  const rel = (p: string) =>
    path.relative(repoRoot, p).split(path.sep).join('/');
  return [
    { name: 'mobile_src', files: mobileSrc.map(rel), kind: 'ts' },
    {
      name: 'edge_legal',
      files: ['supabase/functions/api/legal.ts'],
      allVisible: true,
      kind: 'ts',
    },
    {
      name: 'edge_drills',
      files: ['supabase/functions/api/drills.ts'],
      kind: 'ts',
    },
    {
      name: 'ios_info_plist',
      files: ['apps/mobile/ios/PickleSensei/Info.plist'],
      kind: 'plist',
    },
    {
      name: 'mobile_app_json',
      files: ['apps/mobile/app.json'],
      kind: 'json-displayName',
    },
  ];
}

function extractPlist(file: string, text: string): ExtractedString[] {
  const out: ExtractedString[] = [];
  const re = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const key = m[1] ?? '';
    const value = m[2] ?? '';
    const valueOffset = m.index + m[0].indexOf('<string>') + '<string>'.length;
    const line = text.slice(0, valueOffset).split('\n').length;
    const userFacing =
      /UsageDescription$|^CFBundleDisplayName$|^CFBundleName$/.test(key);
    out.push({
      file,
      line,
      column: 1,
      start: valueOffset,
      raw: value,
      text: value,
      slot: userFacing ? 'plist_user_facing' : 'plist_value',
      slotName: key,
      visibility: userFacing ? 'visible' : 'code',
    });
  }
  return out;
}

function extractAppJson(file: string, text: string): ExtractedString[] {
  const json = JSON.parse(text) as Record<string, unknown>;
  const out: ExtractedString[] = [];
  for (const key of ['displayName', 'name']) {
    const v = json[key];
    if (typeof v === 'string') {
      const idx = text.indexOf(`"${key}"`);
      out.push({
        file,
        line: text.slice(0, Math.max(idx, 0)).split('\n').length,
        column: 1,
        start: Math.max(idx, 0),
        raw: v,
        text: v,
        slot: key === 'displayName' ? 'app_display_name' : 'app_name',
        slotName: key,
        visibility: key === 'displayName' ? 'visible' : 'code',
      });
    }
  }
  return out;
}

function contextAround(raw: string, index: number, length: number): string {
  const from = Math.max(0, index - 60);
  const to = Math.min(raw.length, index + length + 60);
  return raw.slice(from, to).replace(/\s+/g, ' ').trim();
}

function lineColOfOffset(
  fileText: string,
  absolute: number,
): { line: number; column: number } {
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < absolute && i < fileText.length; i++) {
    if (fileText.charCodeAt(i) === 10) {
      line++;
      lastNl = i;
    }
  }
  return { line, column: absolute - lastNl };
}

export function matchRules(
  str: ExtractedString,
  fileText: string,
  rules: readonly CopyRule[] = COPY_RULES,
): Hit[] {
  const hits: Hit[] = [];
  for (const rule of rules) {
    if (rule.requires && !rule.requires.test(str.raw)) {
      continue;
    }
    const global = new RegExp(
      rule.pattern.source,
      rule.pattern.flags.includes('g')
        ? rule.pattern.flags
        : `${rule.pattern.flags}g`,
    );
    let m: RegExpExecArray | null;
    while ((m = global.exec(str.raw)) !== null) {
      if (m[0].length === 0) {
        global.lastIndex++;
        continue;
      }
      const abs = str.start + m.index;
      const lc = lineColOfOffset(fileText, abs);
      hits.push({
        file: str.file,
        line: lc.line,
        column: lc.column,
        literalLine: str.line,
        rule: rule.id,
        category: rule.category,
        confidence: rule.confidence,
        matched: m[0],
        context: contextAround(str.raw, m.index, m[0].length),
        slot: str.slot,
        slotName: str.slotName,
        visibility: str.visibility,
        userVisible:
          str.visibility === 'visible' || str.visibility === 'likely',
      });
    }
  }
  return hits;
}

export function extractSurface(
  host: ScanHost,
  repoRoot: string,
  surface: Surface,
): { strings: ExtractedString[]; texts: Map<string, string> } {
  const strings: ExtractedString[] = [];
  const texts = new Map<string, string>();
  for (const rel of surface.files) {
    const abs = host.path.join(repoRoot, rel);
    const text = host.readFileSync(abs, 'utf8');
    texts.set(rel, text);
    if (surface.kind === 'ts') {
      strings.push(
        ...extractStrings(rel, text, { allVisible: surface.allVisible }),
      );
    } else if (surface.kind === 'plist') {
      strings.push(...extractPlist(rel, text));
    } else {
      strings.push(...extractAppJson(rel, text));
    }
  }
  return { strings, texts };
}

/**
 * Completeness self-check: every raw-text match of a strict forbidden-term
 * rule must fall inside an extracted string/comment range or an identifier.
 * Anything else means the AST walk missed a literal.
 */
export function coverageGaps(
  file: string,
  text: string,
  strings: ExtractedString[],
  rules: readonly CopyRule[] = COPY_RULES,
): CoverageGap[] {
  const ranges = strings
    .filter(s => s.file === file)
    .map(s => ({ start: s.start, end: s.start + s.raw.length }));
  const idents = /\.(ts|tsx)$/.test(file) ? identifierRanges(file, text) : [];
  const gaps: CoverageGap[] = [];
  for (const rule of rules) {
    if (rule.confidence !== 'strict' || rule.category !== 'forbidden_term') {
      continue;
    }
    const global = new RegExp(
      rule.pattern.source,
      rule.pattern.flags.includes('g')
        ? rule.pattern.flags
        : `${rule.pattern.flags}g`,
    );
    let m: RegExpExecArray | null;
    while ((m = global.exec(text)) !== null) {
      if (m[0].length === 0) {
        global.lastIndex++;
        continue;
      }
      const at = m.index;
      const covered =
        ranges.some(r => at >= r.start && at < r.end) ||
        idents.some(r => at >= r.start && at < r.end);
      if (!covered) {
        gaps.push({
          file,
          line: lineColOfOffset(text, at).line,
          rule: rule.id,
          matched: m[0],
          context: contextAround(text, at, m[0].length),
        });
      }
    }
  }
  return gaps;
}

export function runScan(
  host: ScanHost,
  repoRoot: string,
  surfaces: Surface[] = defaultSurfaces(host, repoRoot),
  rules: readonly CopyRule[] = COPY_RULES,
): ScanReport {
  const { path } = host;
  const hits: Hit[] = [];
  const gaps: CoverageGap[] = [];
  const visibleStrings: ScanReport['visibleStrings'] = [];
  const summaries: SurfaceSummary[] = [];
  let approvedLanguageStrings = 0;
  let totalFiles = 0;
  let totalStrings = 0;

  for (const surface of surfaces) {
    const { strings, texts } = extractSurface(host, repoRoot, surface);
    const byVisibility: Record<Visibility, number> = {
      visible: 0,
      likely: 0,
      code: 0,
      comment: 0,
    };
    for (const s of strings) {
      byVisibility[s.visibility]++;
      if (s.visibility === 'visible' || s.visibility === 'likely') {
        visibleStrings.push({
          file: s.file,
          line: s.line,
          slot: s.slot,
          slotName: s.slotName,
          visibility: s.visibility,
          text: s.text,
        });
        if (APPROVED_LANGUAGE.test(s.text)) {
          approvedLanguageStrings++;
        }
      }
      hits.push(...matchRules(s, texts.get(s.file) ?? '', rules));
    }
    for (const [file, text] of texts) {
      gaps.push(...coverageGaps(file, text, strings, rules));
    }
    summaries.push({
      surface: surface.name,
      files: surface.files.length,
      strings: strings.length,
      byVisibility,
    });
    totalFiles += surface.files.length;
    totalStrings += strings.length;
  }

  hits.sort((a, b) =>
    a.file === b.file
      ? a.line - b.line || a.column - b.column
      : a.file.localeCompare(b.file),
  );

  let commit: string | null = null;
  try {
    const head = host
      .readFileSync(path.join(repoRoot, '.git', 'HEAD'), 'utf8')
      .trim();
    commit = head.startsWith('ref: ')
      ? host
          .readFileSync(path.join(repoRoot, '.git', head.slice(5)), 'utf8')
          .trim()
      : head;
  } catch {
    commit = null;
  }

  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    commit,
    rules: rules.map(r => ({
      id: r.id,
      category: r.category,
      confidence: r.confidence,
      source: r.source,
      pattern: r.pattern.toString(),
      requires: r.requires ? r.requires.toString() : null,
    })),
    surfaces: summaries,
    totals: {
      files: totalFiles,
      strings: totalStrings,
      hits: hits.length,
      userVisibleStrictHits: hits.filter(
        h => h.userVisible && h.confidence === 'strict',
      ).length,
      userVisibleTriageHits: hits.filter(
        h => h.userVisible && h.confidence === 'triage',
      ).length,
      nonVisibleHits: hits.filter(h => !h.userVisible).length,
      approvedLanguageStrings,
    },
    hits,
    coverageGaps: gaps,
    visibleStrings,
  };
}

/** Stable identity of a hit for the regression ledger (no line numbers). */
export function hitKey(
  h: Pick<Hit, 'file' | 'rule' | 'matched' | 'slot'>,
): string {
  return `${h.file}|${h.rule}|${h.slot}|${h.matched.toLowerCase()}`;
}

export function toMarkdown(report: ScanReport): string {
  const lines: string[] = [];
  lines.push(`# Release copy policy scan`);
  lines.push('');
  lines.push(`commit: ${report.commit ?? 'unknown'}  `);
  lines.push(`generated: ${report.generatedAt}`);
  lines.push('');
  lines.push(
    '| surface | files | strings | visible | likely | code | comment |',
  );
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const s of report.surfaces) {
    lines.push(
      `| ${s.surface} | ${s.files} | ${s.strings} | ${s.byVisibility.visible} | ${s.byVisibility.likely} | ${s.byVisibility.code} | ${s.byVisibility.comment} |`,
    );
  }
  lines.push('');
  lines.push(`totals: ${JSON.stringify(report.totals)}`);
  lines.push('');
  lines.push(
    `coverage gaps (raw-text strict matches outside any string/comment/identifier): ${report.coverageGaps.length}`,
  );
  for (const g of report.coverageGaps) {
    lines.push(`- ${g.file}:${g.line} ${g.rule} — ${g.context}`);
  }
  lines.push('');
  const section = (title: string, rows: Hit[]) => {
    lines.push(`## ${title} (${rows.length})`);
    lines.push('');
    if (rows.length === 0) {
      lines.push('_none_');
      lines.push('');
      return;
    }
    lines.push('| file:line | rule | matched | slot | visibility | context |');
    lines.push('|---|---|---|---|---|---|');
    for (const h of rows) {
      lines.push(
        `| ${h.file}:${h.line} | ${h.rule} | ${h.matched} | ${h.slot}${h.slotName ? `(${h.slotName})` : ''} | ${h.visibility} | ${h.context.replace(/\|/g, '\\|')} |`,
      );
    }
    lines.push('');
  };
  section(
    'USER-VISIBLE strict hits',
    report.hits.filter(h => h.userVisible && h.confidence === 'strict'),
  );
  section(
    'USER-VISIBLE triage hits',
    report.hits.filter(h => h.userVisible && h.confidence === 'triage'),
  );
  section(
    'Non-visible strict hits (comments / identifiers / platform code)',
    report.hits.filter(h => !h.userVisible && h.confidence === 'strict'),
  );
  return lines.join('\n');
}

/** 0 = clean, 2 = user-visible strict policy hit, 3 = extractor missed a raw match. */
export function exitCodeFor(report: ScanReport): number {
  if (report.coverageGaps.length > 0) return 3;
  return report.totals.userVisibleStrictHits > 0 ? 2 : 0;
}

export function writeReport(
  host: ScanHost,
  report: ScanReport,
  outDir: string,
): string[] {
  host.mkdirSync(outDir, { recursive: true });
  const files: Array<[string, string]> = [
    ['copy-policy-report.json', JSON.stringify(report, null, 2)],
    ['copy-policy-report.md', toMarkdown(report)],
    [
      'copy-policy-visible-strict-hits.json',
      JSON.stringify(
        report.hits.filter(h => h.userVisible && h.confidence === 'strict'),
        null,
        2,
      ),
    ],
    [
      'copy-policy-visible-strings.json',
      JSON.stringify(report.visibleStrings, null, 2),
    ],
  ];
  return files.map(([name, body]) => {
    const full = host.path.join(outDir, name);
    host.writeFileSync(full, body);
    return full;
  });
}
