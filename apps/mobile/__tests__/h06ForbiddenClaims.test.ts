/**
 * H06 — forbidden-claims scan over user-facing copy and store copy.
 *
 * `docs/APP_STORE_SUBMISSION.md` §1 (rules 4 and 5) and REVIEW.md forbid, in
 * anything a user or App Review reads: Android, Google Play, "guest mode",
 * "Live Court", DUPR, competitor names, accuracy percentages, superlatives,
 * and AI-coach-equivalence claims. This suite walks every place that copy
 * lives and fails on the first violation with file:line evidence:
 *
 *  1. the shipping mobile sources (`src/**` and `App.tsx`, every `.ts`,
 *     `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` module) — JSX text, JSX attribute
 *     values, string and template literals, and copy ASSEMBLED at runtime:
 *     `'…' + '…'` chains, `[…].join(…)` and template interpolations are
 *     matched as the rendered phrase, with interpolated identifiers resolved
 *     to their file-level literal value where one exists;
 *  2. the store copy the dossier tells the operator to type into App Store
 *     Connect — every `ENTER:` value (backticked or plain), every fenced
 *     block, the Appendix A text column and the Appendix C screenshot
 *     captions;
 *  3. the iOS permission prompts and display name in `Info.plist`;
 *  4. string literals in the shipping Swift sources (guided-capture overlay,
 *     audio coach cues) and the public privacy/terms/support pages served by
 *     the edge function (`legal.ts`).
 *
 * Policy prose in the dossier (which necessarily names the forbidden terms) is
 * deliberately not part of the store-copy corpus. Source strings that are
 * code tokens rather than prose (identifiers, kebab/snake case keys, paths,
 * URLs, JSON, style values) are skipped so `Platform.OS === 'android'` and
 * `'device-guest'` stay legal while `'Android'` and `'Guest'` are scanned.
 */
import ts from 'typescript';

declare const __dirname: string;
const { existsSync, readFileSync, readdirSync } = jest.requireActual<{
  existsSync(file: string): boolean;
  readFileSync(file: string, encoding: 'utf8'): string;
  readdirSync(
    directory: string,
    options: { withFileTypes: true },
  ): Array<{ name: string; isDirectory(): boolean }>;
}>('node:fs');
const path = jest.requireActual<{
  resolve(...parts: string[]): string;
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
  extname(file: string): string;
}>('node:path');

const MOBILE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(MOBILE_ROOT, '..', '..');
const DOSSIER = path.join(REPO_ROOT, 'docs', 'APP_STORE_SUBMISSION.md');
const INFO_PLIST = path.join(MOBILE_ROOT, 'ios', 'PickleSensei', 'Info.plist');
const LEGAL_PAGES = path.join(
  REPO_ROOT,
  'supabase',
  'functions',
  'api',
  'legal.ts',
);
const SWIFT_ROOTS = [
  path.join(MOBILE_ROOT, 'ios', 'PickleSensei'),
  path.join(MOBILE_ROOT, 'ios', 'LocalPods'),
  path.join(REPO_ROOT, 'native'),
];

type ForbiddenRule = { id: string; pattern: RegExp };

const ACCURACY_WORD = String.raw`(?:accura\w*|precis\w*|correct\w*|error[\s-]?free|exact\w*)`;
const PERCENT = String.raw`\d+(?:\.\d+)?\s?(?:%|\b(?:percent(?:age)?|pct)\b)`;
const RATIO = String.raw`\b\d+ (?:times )?(?:out of|in|of) (?:every )?\d+\b`;
const CORRECTNESS = String.raw`\b(?:right|spot[\s-]?on|nails? it)\b`;
const COACH_NOUN = String.raw`(?:real |human |pro |personal |private |live |in[\s-]person |pickleball |tennis |paid |expensive )?(?:coach(?:es)?|lessons?|trainer|instructor)`;

const FORBIDDEN_RULES: ReadonlyArray<ForbiddenRule> = [
  { id: 'android', pattern: /\bandroid\b/i },
  {
    id: 'google-play',
    pattern: /\bgoogle[\s-]?play\b|\bplay[\s-]?store\b|\bplay\.google\.com\b/i,
  },
  {
    id: 'guest-mode',
    pattern:
      /\bguest[\s-]?mode\b|\bas (?:a |an )?guests?\b|\bguest (?:account|access|sign[\s-]?in|entry|login|log[\s-]?in|checkout|users?|sessions?|ratings?)\b|\b(?:continue|skip|browse|start|try|use|proceed|rate|play) without (?:an? )?(?:account|sign(?:ing)?[\s-]?in|sign(?:ing)?[\s-]?up)\b|\bno (?:account|sign[\s-]?in|sign[\s-]?up|login) (?:needed|required|necessary)\b/i,
  },
  { id: 'live-court', pattern: /\blive[\s-]?courts?\b/i },
  { id: 'dupr', pattern: /\bdupr\b/i },
  {
    id: 'competitor',
    pattern: /\bswing[\s-]?vision\b|\bpb[\s-]?vision\b|\bselkirk\b|\bjoola\b/i,
  },
  {
    id: 'accuracy-percentage',
    pattern: new RegExp(
      [
        `${ACCURACY_WORD}[^.!?]*?${PERCENT}`,
        `${PERCENT}[^.!?]*?${ACCURACY_WORD}`,
        `${ACCURACY_WORD}[^.!?]*?${RATIO}`,
        `${RATIO}[^.!?]*?${ACCURACY_WORD}`,
        `${RATIO}[^.!?]*?${CORRECTNESS}`,
        `${CORRECTNESS}[^.!?]*?${RATIO}`,
      ].join('|'),
      'i',
    ),
  },
  {
    id: 'superlative',
    pattern:
      /\b(?:the|very|world'?s|iphone'?s) best\b|\bbest[\s-]?(?:value|ever|in[\s-]?class|of[\s-]?breed|selling|seller|rated|pickleball|app|coach|coaching|way|choice|deal|plan|price|option|technique|analysis|analyzer|trainer|training|tool|experience)\b|(?:^|[\s(])#\s?1\b|\bnumber[\s-]one\b|\bno\.\s?1\b|\bworld[\s-]class\b|\b(?:industry|market|category|class)[\s-](?:leading|best)\b|\bmost (?:accurate|advanced|trusted|popular|powerful|precise|complete|reliable|effective|comprehensive|innovative|sophisticated|intelligent|loved|downloaded|realistic|detailed|thorough|helpful|affordable)\b|\b(?:the )?ultimate\b|\bunmatched\b|\bunrival+ed\b|\bunbeatable\b|\bunparalleled\b|\bunsurpassed\b|\brevolutionary\b|\bgroundbreaking\b|\bgame[\s-]chang(?:ing|er)\b|\bcutting[\s-]edge\b|\bstate[\s-]of[\s-]the[\s-]art\b|\btop[\s-]rated\b|\baward[\s-]winning\b|\bthe only (?:app|coach|tool|way)\b|\bthe (?:leading|premier|foremost|definitive|smartest|greatest)\b|\bfirst[\s-]ever\b|\b(?:results?|satisfaction|improvement|success) guaranteed\b|\bguaranteed (?:results?|improvement|success|to (?:improve|fix|win))\b/i,
  },
  {
    id: 'ai-coach-equivalence',
    pattern: new RegExp(
      [
        String.raw`\bai[\s-]?(?:powered[\s-])?coach(?:es|ing)?\b`,
        String.raw`\b(?:replace|replaces|replacing|replacement for|instead of|substitute for|no need for|need for|without|forget|ditch|fire|cancel|skip the) (?:having |hiring |paying (?:for )?|booking |seeing |needing |a |an |your |the )*${COACH_NOUN}\b`,
        String.raw`\b(?:like|as good as|better than|same as|just like|equivalent to|equal to) (?:having |hiring |working with |a |an |your |the )*${COACH_NOUN}\b`,
        String.raw`\bcoach in your pocket\b`,
        String.raw`\bno coach (?:needed|required|necessary)\b`,
      ].join('|'),
      'i',
    ),
  },
];

type CopyString = { source: string; line: number; text: string };
type Violation = CopyString & { rule: string };

/** Code points that render as nothing: soft hyphen, zero-width space/joiner/
 * non-joiner, LRM/RLM, word joiner, BOM, combining grapheme joiner, Arabic
 * letter mark, Mongolian vowel separator. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u2060\uFEFF\u061C\u180E]|\u034F/g;

function normalize(text: string): string {
  return text.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: '\u00A0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  shy: '\u00AD',
  zwsp: '\u200B',
  zwj: '\u200D',
  zwnj: '\u200C',
};

/** JSX decodes HTML entities before rendering; match what the user reads. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (entity: string, body: string): string => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        return String.fromCodePoint(parseInt(body.slice(2), 16));
      }
      if (body.startsWith('#')) {
        return String.fromCodePoint(parseInt(body.slice(1), 10));
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
    },
  );
}

function findViolations(strings: ReadonlyArray<CopyString>): Violation[] {
  const found: Violation[] = [];
  for (const entry of strings) {
    for (const rule of FORBIDDEN_RULES) {
      if (rule.pattern.test(entry.text)) {
        found.push({ ...entry, rule: rule.id });
      }
    }
  }
  return found;
}

/** Blank-line separated paragraphs of a multi-line string with the line
 * offset each starts at, so a violation inside a long template literal is
 * reported at its own line rather than the literal's first line. */
function paragraphs(raw: string): Array<{ text: string; lineOffset: number }> {
  const result: Array<{ text: string; lineOffset: number }> = [];
  let lineOffset = 0;
  for (const piece of raw.split(/(\n[ \t]*\n)/)) {
    if (!/^\n[ \t]*\n$/.test(piece)) {
      const leadingBreaks = /^\s*/.exec(piece)?.[0].split('\n').length ?? 1;
      result.push({ text: piece, lineOffset: lineOffset + leadingBreaks - 1 });
    }
    lineOffset += piece.split('\n').length - 1;
  }
  return result;
}

/** Violations as `source:line [rule] text`, one per line — the assertion
 * diff then names the file, the line, the rule and the phrase. */
function describeViolations(strings: ReadonlyArray<CopyString>): string {
  return findViolations(strings)
    .map(entry => `${entry.source}:${entry.line} [${entry.rule}] ${entry.text}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// 1. Mobile sources
// ---------------------------------------------------------------------------

const EXCLUDED_DIRECTORIES = new Set([
  '__tests__',
  '__mocks__',
  'node_modules',
]);
const SOURCE_EXTENSION = /\.(?:[cm]?js|jsx|ts|tsx)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?js|jsx|ts|tsx)$/;

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return EXCLUDED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(file);
    }
    return SOURCE_EXTENSION.test(entry.name) &&
      !/\.d\.ts$/.test(entry.name) &&
      !TEST_FILE.test(entry.name)
      ? [file]
      : [];
  });
}

const PLACEHOLDER = '{…}';

/** A string is a code token — not something a person reads — when it has no
 * letters at all, or is a single word that is lowercase / camelCase /
 * SCREAMING_CASE / kebab-case / a path, URL, JSON fragment, style value or
 * format string. Anything with a space, or a single Capitalised word such as
 * `'Guest'` or `'Android'`, is prose and gets scanned. */
function isCodeToken(text: string): boolean {
  if (!/\p{L}/u.test(text)) return true;
  if (/\s/.test(text)) return false;
  if (/^[a-z0-9]/.test(text) && !/^[a-z]+$/.test(text)) return true;
  if (/^[a-z]+$/.test(text)) return true;
  if (/^[A-Z0-9_]+$/.test(text) && text.includes('_')) return true;
  if (/^[A-Za-z0-9]+(?:[-_./:][A-Za-z0-9]+)+$/.test(text)) return true;
  if (/^[A-Za-z]+[A-Z][a-z]+/.test(text) && !/[^A-Za-z0-9]/.test(text)) {
    return /^[a-z]/.test(text);
  }
  if (/^[#@$%&*./:\\<>[\]{}|~^`"'()-]/.test(text)) return true;
  return false;
}

function scriptKind(file: string): ts.ScriptKind {
  switch (path.extname(file)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

function isStringConcatenation(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  );
}

function isArrayJoin(node: ts.Node): node is ts.CallExpression & {
  expression: ts.PropertyAccessExpression;
} {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'join' &&
    ts.isArrayLiteralExpression(unwrap(node.expression.expression))
  );
}

function isPropertyNameSlot(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  );
}

/** File-level literal bindings: `const platform = 'Android'` → `platform`,
 * `const LABELS = { guest: 'Guest' }` → `LABELS.guest`. Used to resolve
 * identifiers that are rendered or interpolated somewhere else in the file. */
function literalBindings(sourceFile: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>();
  const literalText = (expression: ts.Expression): string | undefined => {
    const value = unwrap(expression);
    return ts.isStringLiteralLike(value) ? value.text : undefined;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const initializer = unwrap(node.initializer);
      const direct = literalText(initializer);
      if (direct !== undefined) bindings.set(node.name.text, direct);
      if (ts.isObjectLiteralExpression(initializer)) {
        for (const property of initializer.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const key = ts.isIdentifier(property.name)
            ? property.name.text
            : ts.isStringLiteralLike(property.name)
              ? property.name.text
              : undefined;
          const value = literalText(property.initializer);
          if (key !== undefined && value !== undefined) {
            bindings.set(`${node.name.text}.${key}`, value);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

/** Scans one module's source text; exported through `collectSourceCopy` for
 * the on-disk corpus and used directly by the fixture tests below. */
function scanModule(fileName: string, text: string): CopyString[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const source = path.relative(MOBILE_ROOT, fileName);
  const bindings = literalBindings(sourceFile);
  const strings: CopyString[] = [];

  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1;

  /** `rendered` marks text that is definitely shown (JSX text and JSX
   * expression children); everything else goes through the token filter. */
  const record = (node: ts.Node, raw: string, rendered: boolean): void => {
    const start = lineOf(node);
    for (const paragraph of paragraphs(raw)) {
      const value = normalize(paragraph.text);
      if (!value) continue;
      if (!rendered && isCodeToken(value)) continue;
      strings.push({ source, line: start + paragraph.lineOffset, text: value });
    }
  };

  /** The literal value an expression renders as, when it is knowable from
   * this file alone; `undefined` for anything dynamic. */
  const resolve = (expression: ts.Expression): string | undefined => {
    const value = unwrap(expression);
    if (ts.isStringLiteralLike(value)) return value.text;
    if (ts.isNumericLiteral(value)) return value.text;
    if (ts.isIdentifier(value)) return bindings.get(value.text);
    if (
      ts.isPropertyAccessExpression(value) &&
      ts.isIdentifier(value.expression)
    ) {
      return bindings.get(`${value.expression.text}.${value.name.text}`);
    }
    if (
      ts.isElementAccessExpression(value) &&
      ts.isIdentifier(value.expression)
    ) {
      const key = unwrap(value.argumentExpression);
      if (ts.isStringLiteralLike(key)) {
        return bindings.get(`${value.expression.text}.${key.text}`);
      }
    }
    return undefined;
  };

  /** Flattens `a + b + c` into its operands (parentheses transparent). */
  const concatenationOperands = (node: ts.Expression): ts.Expression[] => {
    const value = unwrap(node);
    if (isStringConcatenation(value)) {
      return [
        ...concatenationOperands(value.left),
        ...concatenationOperands(value.right),
      ];
    }
    return [value];
  };

  /** Records an expression assembled from several parts as the single phrase
   * the user reads, then keeps walking the dynamic parts. */
  const recordAssembled = (
    node: ts.Node,
    parts: ReadonlyArray<ts.Expression>,
    separator: string,
    rendered: boolean,
  ): void => {
    const rendition = parts.map(part => resolve(part) ?? PLACEHOLDER);
    if (rendition.some(part => part !== PLACEHOLDER)) {
      record(node, rendition.join(separator), rendered);
    }
    for (const part of parts) {
      if (resolve(part) === undefined) visit(part, rendered);
    }
  };

  const visit = (node: ts.Node, rendered: boolean): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isTypeNode(node)
    ) {
      return;
    }
    if (ts.isJsxText(node)) {
      record(node, decodeEntities(node.text), true);
      return;
    }
    if (ts.isJsxExpression(node)) {
      if (!node.expression) return;
      const isChild =
        ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent);
      const value = unwrap(node.expression);
      const resolved = resolve(value);
      if (resolved !== undefined && !ts.isStringLiteralLike(value)) {
        record(node, resolved, isChild);
      }
      visit(node.expression, isChild);
      return;
    }
    if (isStringConcatenation(node)) {
      recordAssembled(node, concatenationOperands(node), '', rendered);
      return;
    }
    if (isArrayJoin(node)) {
      const elements = (
        unwrap(node.expression.expression) as ts.ArrayLiteralExpression
      ).elements;
      const separator = node.arguments[0]
        ? (resolve(node.arguments[0]) ?? PLACEHOLDER)
        : ',';
      recordAssembled(node, elements, separator, rendered);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const rendition = [
        node.head.text,
        ...node.templateSpans.flatMap(span => [
          resolve(span.expression) ?? PLACEHOLDER,
          span.literal.text,
        ]),
      ].join('');
      record(node, rendition, rendered);
      for (const span of node.templateSpans) {
        if (resolve(span.expression) === undefined) {
          visit(span.expression, rendered);
        }
      }
      return;
    }
    if (ts.isStringLiteralLike(node)) {
      if (isPropertyNameSlot(node) || ts.isLiteralTypeNode(node.parent)) {
        return;
      }
      const inJsxAttribute = ts.isJsxAttribute(node.parent);
      record(
        node,
        inJsxAttribute ? decodeEntities(node.text) : node.text,
        rendered,
      );
      return;
    }
    ts.forEachChild(node, child => visit(child, false));
  };
  visit(sourceFile, false);
  return strings;
}

function collectSourceCopy(file: string): CopyString[] {
  return scanModule(file, readFileSync(file, 'utf8'));
}

function mobileCopy(): CopyString[] {
  const files = [
    ...sourceFiles(path.join(MOBILE_ROOT, 'src')),
    path.join(MOBILE_ROOT, 'App.tsx'),
  ].filter(existsSync);
  return files.flatMap(collectSourceCopy);
}

// ---------------------------------------------------------------------------
// 2. App Store dossier store copy
// ---------------------------------------------------------------------------

const DOSSIER_SOURCE = path.relative(MOBILE_ROOT, DOSSIER);
const OPERATOR_MARKER = /^[A-Z]+:$/;
const ENTER_MARKER = '`ENTER:`';

function dossierLines(): string[] {
  return readFileSync(DOSSIER, 'utf8').split('\n');
}

/** Everything the operator is told to `ENTER:` on a line — each backticked
 * value (excluding the operator markers themselves) plus any plain text that
 * follows the marker inside the same table cell or list item. */
function enterValues(lines: string[]): CopyString[] {
  const strings: CopyString[] = [];
  lines.forEach((line, index) => {
    if (!line.includes(ENTER_MARKER)) return;
    const push = (raw: string): void => {
      const value = normalize(raw);
      if (value && !OPERATOR_MARKER.test(value)) {
        strings.push({ source: DOSSIER_SOURCE, line: index + 1, text: value });
      }
    };
    for (const match of line.matchAll(/`([^`]+)`/g)) push(match[1] ?? '');
    let cursor = line.indexOf(ENTER_MARKER);
    while (cursor >= 0) {
      const rest = line.slice(cursor + ENTER_MARKER.length);
      const cell = rest.slice(
        0,
        rest.indexOf('|') >= 0 ? rest.indexOf('|') : rest.length,
      );
      push(cell.replace(/`[^`]*`/g, ' '));
      cursor = line.indexOf(ENTER_MARKER, cursor + ENTER_MARKER.length);
    }
  });
  return strings;
}

/** Every fenced block in the dossier, at any indentation. The dossier only
 * fences text meant to be pasted verbatim (promotional text, keywords,
 * description, App Review notes), so all of them are store copy. */
function fencedBlocks(lines: string[]): {
  blocks: number;
  strings: CopyString[];
} {
  const strings: CopyString[] = [];
  let blocks = 0;
  const fence = /^(\s*)(`{3,}|~{3,})/;
  for (let index = 0; index < lines.length; index += 1) {
    const opening = fence.exec(lines[index] ?? '');
    if (!opening) continue;
    const indent = opening[1] ?? '';
    const marker = opening[2] ?? '```';
    const closing = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`);
    let end = index + 1;
    while (end < lines.length && !closing.test(lines[end] ?? '')) end += 1;
    blocks += 1;
    for (let row = index + 1; row < end; row += 1) {
      const raw = lines[row] ?? '';
      const value = normalize(
        raw.startsWith(indent) ? raw.slice(indent.length) : raw,
      );
      if (value) {
        strings.push({ source: DOSSIER_SOURCE, line: row + 1, text: value });
      }
    }
    index = end;
  }
  return { blocks, strings };
}

/** One column of the first markdown table under the heading that matches. */
function tableColumn(
  lines: string[],
  heading: RegExp,
  column: number,
): CopyString[] {
  const strings: CopyString[] = [];
  const headingIndex = lines.findIndex(
    line => /^#{1,6}\s/.test(line) && heading.test(line),
  );
  if (headingIndex < 0) return strings;
  let seenHeader = false;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^#{1,6}\s/.test(line)) break;
    if (!line.startsWith('|')) {
      if (seenHeader) break;
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map(cell => normalize(cell));
    if (!seenHeader) {
      seenHeader = true;
      continue;
    }
    if (cells.every(cell => /^-+$/.test(cell))) continue;
    const value = cells[column];
    if (value) {
      strings.push({ source: DOSSIER_SOURCE, line: index + 1, text: value });
    }
  }
  return strings;
}

function storeCopy(): {
  values: CopyString[];
  blocks: number;
  blockStrings: CopyString[];
  characterCountText: CopyString[];
  screenshotCaptions: CopyString[];
} {
  const lines = dossierLines();
  const { blocks, strings: blockStrings } = fencedBlocks(lines);
  return {
    values: enterValues(lines),
    blocks,
    blockStrings,
    characterCountText: tableColumn(lines, /Character counts/i, 2),
    screenshotCaptions: tableColumn(lines, /Screenshot shot list/i, 2),
  };
}

// ---------------------------------------------------------------------------
// 3. iOS permission prompts
// ---------------------------------------------------------------------------

function plistCopy(): CopyString[] {
  const plist = readFileSync(INFO_PLIST, 'utf8');
  const source = path.relative(MOBILE_ROOT, INFO_PLIST);
  const strings: CopyString[] = [];
  const pattern =
    /<key>(NS[A-Za-z]+UsageDescription|CFBundleDisplayName)<\/key>\s*<string>([^<]*)<\/string>/g;
  for (const match of plist.matchAll(pattern)) {
    const offset = match.index ?? 0;
    const line = plist.slice(0, offset).split('\n').length;
    strings.push({ source, line, text: normalize(match[2] ?? '') });
  }
  return strings;
}

// ---------------------------------------------------------------------------
// 4. Native Swift copy and the public legal pages
// ---------------------------------------------------------------------------

const SWIFT_EXCLUDED = new Set([
  'Tests',
  'Pods',
  'build',
  '.build',
  'DerivedData',
]);

function swiftFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return SWIFT_EXCLUDED.has(entry.name) || /Tests$/.test(entry.name)
        ? []
        : swiftFiles(file);
    }
    return entry.name.endsWith('.swift') ? [file] : [];
  });
}

/** Swift string literals (single-line and multi-line) that read as prose. */
function swiftCopy(): CopyString[] {
  const strings: CopyString[] = [];
  const literal = /"""\n([\s\S]*?)"""|"((?:[^"\\\n]|\\.)*)"/g;
  for (const file of SWIFT_ROOTS.flatMap(swiftFiles)) {
    const text = readFileSync(file, 'utf8');
    const source = path.relative(MOBILE_ROOT, file);
    for (const match of text.matchAll(literal)) {
      const line = text.slice(0, match.index ?? 0).split('\n').length;
      for (const paragraph of paragraphs(match[1] ?? match[2] ?? '')) {
        const value = normalize(paragraph.text);
        if (!value || isCodeToken(value)) continue;
        strings.push({
          source,
          line: line + paragraph.lineOffset,
          text: value,
        });
      }
    }
  }
  return strings;
}

function legalCopy(): CopyString[] {
  return existsSync(LEGAL_PAGES) ? collectSourceCopy(LEGAL_PAGES) : [];
}

// ---------------------------------------------------------------------------

describe('H06 forbidden claims — rule fixtures', () => {
  it.each([
    ['android', 'Also available on Android.'],
    ['google-play', 'Manage subscription in Google Play'],
    ['google-play', 'Also on GooglePlay.'],
    ['google-play', 'Find it on the Play Store.'],
    ['guest-mode', 'Continue as guest or enable guest mode later.'],
    ['guest-mode', 'Ratings you take as a guest stay on this phone.'],
    ['guest-mode', 'Rate without an account.'],
    ['live-court', 'Live Court sessions coach you in real time.'],
    ['live-court', 'Live Courts coach you in real time.'],
    ['dupr', 'A DUPR-style estimate of your level.'],
    ['competitor', 'Better than SwingVision and PB Vision.'],
    ['competitor', 'Better than PB-Vision.'],
    ['accuracy-percentage', 'Scores are 95% accurate.'],
    ['accuracy-percentage', 'Scores land with 95% precision.'],
    ['accuracy-percentage', 'Accuracy of 95 pct on every stroke.'],
    ['accuracy-percentage', 'Accurate 9 times out of 10.'],
    ['accuracy-percentage', 'Gets it right 9 out of 10 times.'],
    ['superlative', 'BEST VALUE'],
    ['superlative', 'BEST-VALUE'],
    ['superlative', 'The #1 pickleball coaching app.'],
    ['superlative', 'The ultimate pickleball coaching app.'],
    ['superlative', 'The most effective way to fix your dink.'],
    ['superlative', 'The very best pickleball coach on iPhone.'],
    ['superlative', 'Best pickleball coaching app.'],
    ['superlative', 'Results guaranteed.'],
    ['ai-coach-equivalence', 'An AI coach that works like a real coach.'],
    ['ai-coach-equivalence', 'Your personal AI-coach, always in your pocket.'],
    ['ai-coach-equivalence', 'AI coaching that replaces lessons.'],
    ['ai-coach-equivalence', 'Like having a coach in your pocket.'],
    ['ai-coach-equivalence', 'No need for a coach — Pickle Sensei does it.'],
    ['ai-coach-equivalence', 'Skip the expensive lessons.'],
  ])('rule %s flags "%s"', (rule, text) => {
    const violations = findViolations([{ source: 'fixture', line: 1, text }]);
    expect(violations.map(violation => violation.rule)).toContain(rule);
  });

  it.each([
    'Every price below comes from your app store — never an estimate.',
    'Your best score this month.',
    'SAVE 33%',
    'Technique scores are computer-generated coaching estimates, not an official player rating.',
    'Guided drills, with videos from real coaches.',
    'Pickle Sensei is a private pickleball technique coach that lives on your iPhone.',
    'Get the most out of every session.',
    'Your most recent 8 scored analyses.',
    'Replace the current plan?',
    'Confidence 82%',
    'A coach reviews the plan before it is published.',
  ])('approved copy "%s" is not flagged', text => {
    expect(findViolations([{ source: 'fixture', line: 1, text }])).toEqual([]);
  });

  it('matches the rendered phrase through invisible code points and entities', () => {
    expect(normalize('Goo\u00ADgle Play')).toBe('Google Play');
    expect(normalize('An\u200Bdroid')).toBe('Android');
    expect(normalize(decodeEntities('Google&nbsp;Play'))).toBe('Google Play');
    expect(normalize(decodeEntities('Live&#32;Court'))).toBe('Live Court');
    expect(normalize(decodeEntities('Live&#x20;Court'))).toBe('Live Court');
  });
});

const FIXTURE_HEADER =
  "import React from 'react';\nimport { Text } from 'react-native';\n\n";

function fixtureRules(fileName: string, source: string): string[] {
  return findViolations(
    scanModule(path.join(MOBILE_ROOT, 'src', fileName), source),
  ).map(violation => violation.rule);
}

describe('H06 forbidden claims — scanner fixtures (rendered copy)', () => {
  it('assembles `+` concatenations into the rendered phrase', () => {
    const source = `${FIXTURE_HEADER}export function Fixture() {\n  return <Text>{'Manage your subscription in Google ' + 'Play settings.'}</Text>;\n}\n`;
    expect(fixtureRules('Fixture.tsx', source)).toContain('google-play');
    const detail = `${FIXTURE_HEADER}export const detail =\n  'Re-record with your full body in frame, or declare the technique for the most ' +\n  'precise read.';\n`;
    expect(fixtureRules('Fixture.tsx', detail)).toContain('superlative');
  });

  it('assembles array joins into the rendered phrase', () => {
    const source = `${FIXTURE_HEADER}export const detail = ['Live', 'Court sessions coach you in real time.'].join(' ');\n`;
    expect(fixtureRules('Fixture.tsx', source)).toContain('live-court');
  });

  it('decodes JSX entities and strips invisible code points', () => {
    expect(
      fixtureRules(
        'Fixture.tsx',
        `${FIXTURE_HEADER}export function Fixture() {\n  return <Text>Also available on Google&nbsp;Play.</Text>;\n}\n`,
      ),
    ).toContain('google-play');
    expect(
      fixtureRules(
        'Fixture.tsx',
        `${FIXTURE_HEADER}export function Fixture() {\n  return <Text>Live&#32;Court sessions coach you.</Text>;\n}\n`,
      ),
    ).toContain('live-court');
    expect(
      fixtureRules(
        'Fixture.tsx',
        `${FIXTURE_HEADER}export function Fixture() {\n  return <Text>{${JSON.stringify('Manage it in Goo\u00ADgle Play today.')}}</Text>;\n}\n`,
      ),
    ).toContain('google-play');
    expect(
      fixtureRules(
        'Fixture.tsx',
        `${FIXTURE_HEADER}export function Fixture() {\n  return <Text>{${JSON.stringify('Also available on An\u200Bdroid phones.')}}</Text>;\n}\n`,
      ),
    ).toContain('android');
  });

  it('scans single-word values outside copy-named bindings', () => {
    expect(
      fixtureRules(
        'Fixture.tsx',
        `${FIXTURE_HEADER}export const STORE_LABELS = {\n  ios: 'App Store',\n  android: 'Android',\n};\n`,
      ),
    ).toContain('android');
    expect(
      fixtureRules(
        'Fixture.tsx',
        `${FIXTURE_HEADER}const RATING_SYSTEM: Record<string, string> = {\n  external: 'DUPR',\n};\nexport function Fixture() {\n  return <Text>{RATING_SYSTEM.external}</Text>;\n}\n`,
      ),
    ).toContain('dupr');
    expect(
      fixtureRules(
        'Fixture.tsx',
        `${FIXTURE_HEADER}const platform = 'Android';\nexport function Fixture() {\n  return <Text>{\`Also available on \${platform}.\`}</Text>;\n}\n`,
      ),
    ).toContain('android');
  });

  it('scans .js and .jsx modules', () => {
    expect(
      fixtureRules(
        'Fixture.jsx',
        `${FIXTURE_HEADER}export function Fixture() {\n  return <Text>Manage subscription in Google Play</Text>;\n}\n`,
      ),
    ).toContain('google-play');
    expect(
      fixtureRules(
        'copy.js',
        "export const detail = 'Manage subscription in Google Play';\n",
      ),
    ).toContain('google-play');
    expect(
      sourceFiles(path.join(MOBILE_ROOT, 'src')).every(file =>
        SOURCE_EXTENSION.test(file),
      ),
    ).toBe(true);
  });

  it('leaves implementation tokens alone', () => {
    const source = `${FIXTURE_HEADER}import { Platform } from 'react-native';\nexport const GUEST_DATA_OWNER = 'device-guest';\nexport const isAndroid = Platform.OS === 'android';\nexport const provider: 'apple' | 'google' | 'guest' = 'guest';\nexport const url = 'https://play.google.com/store/account/subscriptions';\nexport const key = 'ANDROID_CHANNEL_ID';\nexport const camel = 'androidChannelId';\n`;
    expect(fixtureRules('Fixture.tsx', source)).toEqual([]);
  });
});

describe('H06 forbidden claims — mobile user-facing strings', () => {
  const strings = mobileCopy();

  it('scans a non-trivial corpus of shipping copy', () => {
    expect(new Set(strings.map(entry => entry.source)).size).toBeGreaterThan(
      50,
    );
    expect(strings.length).toBeGreaterThan(1000);
  });

  it('contains none of the forbidden terms', () => {
    expect(describeViolations(strings)).toBe('');
  });
});

describe('H06 forbidden claims — App Store dossier store copy', () => {
  it('the dossier exists at its documented path', () => {
    expect(existsSync(DOSSIER)).toBe(true);
  });

  const copy = storeCopy();

  it('extracts the ENTER values, fenced blocks, character-count text and captions', () => {
    expect(copy.values.length).toBeGreaterThanOrEqual(30);
    expect(copy.blocks).toBeGreaterThanOrEqual(4);
    expect(copy.blockStrings.length).toBeGreaterThanOrEqual(30);
    expect(copy.characterCountText.length).toBeGreaterThanOrEqual(10);
    expect(copy.screenshotCaptions.length).toBeGreaterThanOrEqual(6);
    expect(
      copy.blockStrings.some(entry => /^Pickle Sensei is a/.test(entry.text)),
    ).toBe(true);
  });

  it('reads plain (non-backticked) ENTER values and indented fenced blocks', () => {
    expect(
      enterValues([
        '| Subtitle | `ENTER:` Pickleball coach for everyone |',
      ]).map(entry => entry.text),
    ).toEqual(['Pickleball coach for everyone']);
    const indented = fencedBlocks([
      '- `ENTER:`',
      '',
      '  ```',
      '  Now on every phone.',
      '  ```',
    ]);
    expect(indented.blocks).toBe(1);
    expect(indented.strings.map(entry => entry.text)).toEqual([
      'Now on every phone.',
    ]);
  });

  it('contains none of the forbidden terms', () => {
    expect(
      describeViolations([
        ...copy.values,
        ...copy.blockStrings,
        ...copy.characterCountText,
        ...copy.screenshotCaptions,
      ]),
    ).toBe('');
  });
});

describe('H06 forbidden claims — iOS permission prompts', () => {
  const strings = plistCopy();

  it('reads the display name and every usage description', () => {
    expect(strings.length).toBeGreaterThanOrEqual(4);
  });

  it('contains none of the forbidden terms', () => {
    expect(describeViolations(strings)).toBe('');
  });
});

describe('H06 forbidden claims — native Swift copy and public legal pages', () => {
  const swift = swiftCopy();
  const legal = legalCopy();

  it('reads the shipping Swift sources and the legal pages', () => {
    expect(new Set(swift.map(entry => entry.source)).size).toBeGreaterThan(10);
    expect(legal.length).toBeGreaterThan(20);
  });

  it('contains none of the forbidden terms', () => {
    expect(describeViolations([...swift, ...legal])).toBe('');
  });
});
