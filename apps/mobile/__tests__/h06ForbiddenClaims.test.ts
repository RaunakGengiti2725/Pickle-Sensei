/**
 * H06 — forbidden-claims scan over user-facing copy and store copy.
 *
 * `docs/APP_STORE_SUBMISSION.md` §1 (rules 4 and 5) and REVIEW.md forbid, in
 * anything a user or App Review reads: Android, Google Play, "guest mode",
 * "Live Court", competitor names, accuracy percentages, superlatives, and
 * AI-coach-equivalence claims. DUPR (a third-party trademark) is forbidden in
 * App Store METADATA and the iOS permission prompts only: since D-046
 * (2026-09-10) the app itself prints every rating as a disclaimed "estimated
 * DUPR", so the in-app corpora may name it. This suite walks every place that
 * copy lives and fails on the first violation with file:line evidence:
 *
 *  1. the shipping mobile sources (`src/**` and `App.tsx`, every `.ts`,
 *     `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` module) plus every monorepo
 *     package Metro bundles into the app (the `@pickle/*` aliases in
 *     `metro.config.js`) — JSX text, JSX attribute values, string and
 *     template literals, and copy ASSEMBLED at runtime: `'…' + '…'` chains,
 *     `[…].join(…)` (inline or file-level arrays), template interpolations
 *     and the children of one JSX element (the `{' '}` idiom, nested `<Text>`
 *     styling, literal expression children) are matched as the rendered
 *     phrase, with interpolated identifiers resolved to their file-level
 *     literal value where one exists and dynamic parts rendered as `{…}`;
 *  2. the server-supplied copy the app renders verbatim: the drill catalog
 *     and its third-party media attribution served by the production edge
 *     function (`drills.ts`, `drillMedia.ts` → `GET /v1/catalog/drills`);
 *  3. the store copy the dossier tells the operator to type into App Store
 *     Connect — every `ENTER:` value (backticked or plain), every fenced
 *     block, the Appendix A text column and the Appendix C screenshot
 *     captions;
 *  4. the iOS permission prompts and display name in `Info.plist`;
 *  5. string literals in the shipping Swift sources (guided-capture overlay,
 *     audio coach cues) and the public privacy/terms/support pages served by
 *     the edge function (`legal.ts`).
 *
 * Policy prose in the dossier (which necessarily names the forbidden terms) is
 * deliberately not part of the store-copy corpus. Source strings that are
 * code tokens rather than prose (identifiers, kebab/snake case keys, paths,
 * URLs, JSON, style values) are skipped so `Platform.OS === 'android'` and
 * `'device-guest'` stay legal while `'Android'`, `'Guest'` and hyphenated
 * prose such as `'PB-Vision'` are scanned. Invisible code points, entity
 * references and Unicode dash variants are folded before matching so the
 * regexes see what the reader sees.
 */
import ts from 'typescript';

declare const __dirname: string;
const { existsSync, readFileSync, readdirSync, statSync } = jest.requireActual<{
  existsSync(file: string): boolean;
  statSync(file: string): { isFile(): boolean };
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
  dirname(file: string): string;
  sep: string;
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
const EDGE_API = path.join(REPO_ROOT, 'supabase', 'functions', 'api');
/** Server copy the app renders as-is: `getCatalogDrills`/`getCatalogDrill`
 * in `index.ts` serialise these two modules to DrillLibraryScreen,
 * DrillVideoPlayer and the training components. */
const CATALOG_MODULES = ['drills.ts', 'drillMedia.ts'].map(name =>
  path.join(EDGE_API, name),
);
const METRO_CONFIG = path.join(MOBILE_ROOT, 'metro.config.js');

/** `allow` names the one legitimate reading of a matched phrase; a match is a
 * violation unless the text around it (± the window) matches `allow`. */
type ForbiddenRule = { id: string; pattern: RegExp; allow?: RegExp };
const ALLOW_WINDOW = 24;

/** A count as the reader sees it: digits, a spelled-out number ("nine",
 * "ninety-five") or a runtime value the scanner rendered as `{…}`. */
const NUMBER_WORD = String.raw`(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)`;
const NUMBER = String.raw`(?:\d+(?:\.\d+)?|\{(?:…|\.{3})\}|\b${NUMBER_WORD}(?:[\s-]${NUMBER_WORD})?\b)`;
const ACCURACY_WORD = String.raw`(?:accura\w*|precis\w*|correct\w*|error[\s-]?free|exact\w*|agree(?:s|d|ment|ing)? with|match(?:es|ed|ing)? (?:a |an |the |your )?(?:coach|pro|expert|human|certified)\w*)`;
const PERCENT = String.raw`${NUMBER}\s?(?:%|\b(?:percent(?:age)?|pct)\b)`;
const RATIO = String.raw`(?:${NUMBER} (?:times )?(?:out of|in|of) (?:every )?${NUMBER}|\b\d+\s?/\s?\d+\b)`;
const CORRECTNESS = String.raw`\b(?:right|spot[\s-]?on|nails? it)\b`;
const COACH_MODIFIER = String.raw`(?:real |human |pro |personal |private |live |in[\s-]person |pickleball |tennis |paid |expensive |certified |professional )?`;
const COACH_NOUN = String.raw`${COACH_MODIFIER}(?:coach(?:es)?|lessons?|trainer|instructor)`;
/** "a pro" is a coach only when the copy measures the app against one
 * ("rivals a pro"); "drop like a pro" describes the player's shot. */
const COACH_OR_PRO = String.raw`(?:${COACH_NOUN}|${COACH_MODIFIER}pros?)`;
/** The one context in which "best" is a fact about the reader rather than a
 * claim about the product: their own record ("your best score", "best of
 * 3 games"). Everything else that says "best" is a superlative. */
const PERSONAL_BEST = new RegExp(
  [
    String.raw`\b(?:your|my|personal|previous|season|monthly|weekly|all[\s-]time|new|current|lifetime|today'?s|this (?:week|month|session)'?s) best\b`,
    String.raw`\bbest (?:score|result|rating|dupr|run|streak|attempt|round|session|rep|so far|yet|of \d+)\b`,
    String.raw`\bbest (?:\w+ )?(?:today|so far|yet|this (?:week|month|session))\b`,
    String.raw`\bbest:? \{(?:…|\.{3})\}`,
  ].join('|'),
  'i',
);

const FORBIDDEN_RULES: ReadonlyArray<ForbiddenRule> = [
  { id: 'android', pattern: /\bandroid\b/i },
  {
    id: 'google-play',
    pattern: /\bgoogle[\s-]?play\b|\bplay[\s-]?store\b|\bplay\.google\.com\b/i,
  },
  {
    id: 'guest-mode',
    pattern:
      /\bguests?\b|\bwithout (?:an? |your |first )?(?:account|sign(?:ing)?[\s-]?(?:in|up)|logging in|log[\s-]?in|creating an account|registering)\b|\bskip (?:the )?(?:sign[\s-]?(?:in|up)|login|log[\s-]?in|registration)\b|\bno (?:account|sign[\s-]?in|sign[\s-]?up|login) (?:needed|required|necessary)\b/i,
  },
  { id: 'live-court', pattern: /\blive[\s-]?courts?\b/i },
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
    pattern: new RegExp(
      [
        String.raw`\bbest\b`,
        String.raw`(?:^|[\s(\["'“‘])#\s?1\b`,
        String.raw`\bnumber[\s-]one\b`,
        String.raw`\bno\.\s?1\b`,
        String.raw`\bworld[\s-]class\b`,
        String.raw`\b(?:industry|market|category|class)[\s-](?:leading|best)\b`,
        String.raw`\b(?:a|the|our|its) leading\b`,
        String.raw`\b(?:highest|top|best)[\s-](?:rated|ranked|reviewed)\b`,
        String.raw`\bmost (?:accurate|advanced|trusted|popular|powerful|precise|complete|reliable|effective|comprehensive|innovative|sophisticated|intelligent|loved|downloaded|realistic|detailed|thorough|helpful|affordable|consistent|honest|efficient|exact)\b`,
        String.raw`\bthe (?:fastest|quickest|easiest|simplest|smartest|surest|best|only|most \w+) way\b`,
        String.raw`\b(?:the )?ultimate\b`,
        String.raw`\bunmatched\b`,
        String.raw`\bunrival+ed\b`,
        String.raw`\bunbeatable\b`,
        String.raw`\bunparalleled\b`,
        String.raw`\bunsurpassed\b`,
        String.raw`\bsecond to none\b`,
        String.raw`\bnothing (?:else )?comes close\b`,
        String.raw`\bunlike any(?:thing| other)\b`,
        String.raw`\bbetter than (?:any|every|all|the rest|other|the competition)\b`,
        String.raw`\bsuperior\b`,
        String.raw`\b(?:pro|tour|elite|expert)[\s-]level (?:accura\w*|precis\w*|analysis|coaching|feedback|insight\w*)\b`,
        String.raw`\bperfect (?:form|technique|strokes?|dinks?|serves?|swings?|shots?|mechanics)\b`,
        String.raw`\bflawless\b`,
        String.raw`\brevolutionary\b`,
        String.raw`\bgroundbreaking\b`,
        String.raw`\bgame[\s-]chang(?:ing|er)\b`,
        String.raw`\bcutting[\s-]edge\b`,
        String.raw`\bstate[\s-]of[\s-]the[\s-]art\b`,
        String.raw`\baward[\s-]winning\b`,
        String.raw`\bthe only (?:app|coach|tool|way)\b`,
        String.raw`\bthe (?:leading|premier|foremost|definitive|smartest|greatest|finest)\b`,
        String.raw`\bfirst[\s-]ever\b`,
        String.raw`\b(?:results?|satisfaction|improvement|success) guaranteed\b`,
        String.raw`\bguaranteed (?:results?|improvement|success|to (?:improve|fix|win))\b`,
      ].join('|'),
      'i',
    ),
    allow: PERSONAL_BEST,
  },
  {
    id: 'ai-coach-equivalence',
    pattern: new RegExp(
      [
        String.raw`\ba\.?i\.?[\s-](?:\w+[\s-]){0,2}coach(?:es|ing)?\b`,
        String.raw`\bcoach(?:ed|ing)? (?:powered|driven|backed|delivered|run|led) by (?:an? )?(?:a\.?i\.?|machine|algorithm|model|computer)\b`,
        String.raw`\bcoached by (?:an? )?(?:a\.?i\.?|machine|algorithm|model|computer|app|phone)\b`,
        String.raw`\b(?:virtual|digital|robot|automated|machine|algorithmic|app) ${COACH_NOUN}\b`,
        String.raw`\b(?:replace|replaces|replacing|replacement for|instead of|substitute for|no need for|need for|without|forget|ditch|fire|cancel|skip the) (?:having |hiring |paying (?:for )?|booking |seeing |needing |a |an |your |the )*${COACH_NOUN}\b`,
        String.raw`\b(?:as good as|better than|same as|equivalent to|equal to|rivals?|matches) (?:having |hiring |working with |a |an |your |the )*${COACH_OR_PRO}\b`,
        String.raw`\b(?:like|just like) (?:having |hiring |working with |a |an |your |the )*${COACH_NOUN}\b`,
        String.raw`\b(?:everything|anything|all|what) (?:that )?(?:a |an |your |the )*${COACH_NOUN} (?:would|could|will|can|might) (?:tell|say|see|teach|show|give|spot|catch)\b`,
        String.raw`\bcoach in your pocket\b`,
        String.raw`\bno coach (?:needed|required|necessary)\b`,
      ].join('|'),
      'i',
    ),
  },
];

/** Rules that apply ONLY to what Apple reads outside the running app — the
 * App Store dossier's store copy and the Info.plist strings. DUPR is a
 * third-party trademark (guideline 5.2.1 / "names of other apps or companies
 * aren't allowed" in keywords); in-app it is a disclaimed estimate the owner
 * chose to show (D-046). */
const STORE_ONLY_RULES: ReadonlyArray<ForbiddenRule> = [
  { id: 'dupr', pattern: /\bdupr\b/i },
];
const STORE_RULES: ReadonlyArray<ForbiddenRule> = [
  ...FORBIDDEN_RULES,
  ...STORE_ONLY_RULES,
];

type CopyString = { source: string; line: number; text: string };
type Violation = CopyString & { rule: string };

/** Code points that render as nothing: every Unicode format character
 * (`\p{Cf}`: soft hyphen, zero-width space/joiner/non-joiner, LRM/RLM and
 * the bidi embedding/isolate controls, word joiner, invisible operators, BOM,
 * language/musical-notation tags), plus the non-format blanks — combining
 * grapheme joiner, Khmer/Hangul/halfwidth fillers, braille blank, variation
 * selectors. */
const INVISIBLE =
  /\p{Cf}|\u034F|\u115F|\u1160|\u17B4|\u17B5|\u2800|\u3164|\uFFA0|[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/gu;
/** Dash and hyphen look-alikes a reader sees as a hyphen (`Live‑Court`). */
const DASHES =
  /[\u2010-\u2015\u2212\u2043\u02D7\u2E3A\u2E3B\uFE58\uFE63\uFF0D]/g;
/** Punctuation that renders as a plain apostrophe or quote. */
const QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u02BC\u02B9]/g;

function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(DASHES, '-')
    .replace(QUOTES, "'")
    .replace(/\s+/g, ' ')
    .trim();
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

/** JSX text as React renders it: whitespace-only lines vanish, line breaks
 * collapse to a single space, leading/trailing indentation is trimmed. */
function jsxTextValue(raw: string): string {
  const lines = raw.split('\n');
  const kept: string[] = [];
  lines.forEach((line, index) => {
    let value = line;
    if (index > 0) value = value.replace(/^[ \t]+/, '');
    if (index < lines.length - 1) value = value.replace(/[ \t]+$/, '');
    if (value) kept.push(value);
  });
  return kept.join(' ');
}

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

function ruleMatches(rule: ForbiddenRule, raw: string): boolean {
  const text = normalize(raw);
  const pattern = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
  for (const match of text.matchAll(pattern)) {
    if (!rule.allow) return true;
    const start = Math.max(0, match.index - ALLOW_WINDOW);
    const end = Math.min(
      text.length,
      match.index + match[0].length + ALLOW_WINDOW,
    );
    if (!rule.allow.test(text.slice(start, end))) return true;
  }
  return false;
}

function findViolations(
  strings: ReadonlyArray<CopyString>,
  rules: ReadonlyArray<ForbiddenRule> = FORBIDDEN_RULES,
): Violation[] {
  const found: Violation[] = [];
  for (const entry of strings) {
    for (const rule of rules) {
      if (ruleMatches(rule, entry.text)) {
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
function describeViolations(
  strings: ReadonlyArray<CopyString>,
  rules: ReadonlyArray<ForbiddenRule> = FORBIDDEN_RULES,
): string {
  return findViolations(strings, rules)
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
  if (/^#\s?\d+$/.test(text)) return false;
  if (!/\p{L}/u.test(text)) return true;
  if (/\s/.test(text)) return false;
  if (/^[a-z0-9]/.test(text) && !/^[a-z]+$/.test(text)) return true;
  if (/^[a-z]+$/.test(text)) return true;
  if (/^[A-Z0-9_]+$/.test(text) && text.includes('_')) return true;
  if (/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/.test(text) && /[A-Z]/.test(text)) {
    return false;
  }
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

const COMPARISON = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** A literal something is COMPARED against (`provider !== 'DUPR'`,
 * `case 'Guest':`) is a discriminator the code tests, never text the user
 * reads; whatever is rendered for that state is a separate literal. */
function isComparedValue(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  return (
    (ts.isBinaryExpression(parent) &&
      COMPARISON.has(parent.operatorToken.kind)) ||
    (ts.isCaseClause(parent) && parent.expression === node)
  );
}

function isStringConcatenation(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  );
}

function isJoinCall(node: ts.Node): node is ts.CallExpression & {
  expression: ts.PropertyAccessExpression;
} {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'join'
  );
}

type Bindings = {
  literals: Map<string, string>;
  arrays: Map<string, ReadonlyArray<ts.Expression>>;
};

/** File-level literal bindings: `const platform = 'Android'` → `platform`,
 * `const LABELS = { guest: 'Guest' }` → `LABELS.guest`, and array literals
 * (`const LINES = ['…', '…']`) so a later `LINES.join(' ')` can be assembled.
 * Used to resolve identifiers that are rendered or interpolated somewhere
 * else in the file. */
function literalBindings(sourceFile: ts.SourceFile): Bindings {
  const bindings = new Map<string, string>();
  const arrays = new Map<string, ReadonlyArray<ts.Expression>>();
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
      if (ts.isArrayLiteralExpression(initializer)) {
        arrays.set(node.name.text, initializer.elements);
      }
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
  return { literals: bindings, arrays };
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
  const { literals: bindings, arrays } = literalBindings(sourceFile);
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

  /** The elements of `[…].join(…)` — inline or a file-level array binding. */
  const joinedElements = (
    node: ts.CallExpression & { expression: ts.PropertyAccessExpression },
  ): ReadonlyArray<ts.Expression> | undefined => {
    const target = unwrap(node.expression.expression);
    if (ts.isArrayLiteralExpression(target)) return target.elements;
    if (ts.isIdentifier(target)) return arrays.get(target.text);
    return undefined;
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

  /** What one JSX element renders when its children are read in order: text,
   * literal/resolvable expression children (`{' '}`, `{LABEL}`), nested
   * elements' own text (`<Text>Live <Text style=…>Court</Text></Text>`) and
   * `{…}` for anything dynamic. Returns the parts so the caller can decide
   * whether the joined phrase adds anything to the parts already recorded. */
  const renderedChildren = (children: ts.NodeArray<ts.JsxChild>): string[] => {
    const parts: string[] = [];
    for (const child of children) {
      if (ts.isJsxText(child)) {
        parts.push(jsxTextValue(decodeEntities(child.text)));
      } else if (ts.isJsxExpression(child)) {
        if (!child.expression) continue;
        parts.push(resolve(child.expression) ?? PLACEHOLDER);
      } else if (ts.isJsxElement(child)) {
        parts.push(renderedChildren(child.children).join(''));
      } else {
        parts.push(PLACEHOLDER);
      }
    }
    return parts;
  };

  const visit = (node: ts.Node, rendered: boolean): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isTypeNode(node)
    ) {
      return;
    }
    if (ts.isJsxElement(node)) {
      const parts = renderedChildren(node.children);
      const meaningful = parts.filter(part => /\S/.test(part));
      if (meaningful.length > 1) record(node, parts.join(''), true);
      ts.forEachChild(node, child => visit(child, false));
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
    if (isJoinCall(node)) {
      const elements = joinedElements(node);
      if (elements) {
        const separator = node.arguments[0]
          ? (resolve(node.arguments[0]) ?? PLACEHOLDER)
          : ',';
        recordAssembled(node, elements, separator, rendered);
        return;
      }
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
      if (ts.isLiteralTypeNode(node.parent) || isComparedValue(node)) return;
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

function mobileSourceCopy(): CopyString[] {
  const files = [
    ...sourceFiles(path.join(MOBILE_ROOT, 'src')),
    path.join(MOBILE_ROOT, 'App.tsx'),
  ].filter(existsSync);
  return files.flatMap(collectSourceCopy);
}

/** The `@pickle/*` → `packages/<name>/src/<entry>` aliases Metro resolves
 * when bundling the app, read from `metro.config.js`. */
function metroAliases(): Map<string, string> {
  const aliases = new Map<string, string>();
  const config = readFileSync(METRO_CONFIG, 'utf8');
  const alias =
    /'(@pickle\/[^']+)':\s*path\.join\(\s*monorepoRoot,\s*'(packages\/[^']+)',?\s*\)/g;
  for (const match of config.matchAll(alias)) {
    aliases.set(match[1] ?? '', path.join(REPO_ROOT, match[2] ?? ''));
  }
  return aliases;
}

/** Resolves one import specifier the way Metro does for these packages:
 * `@pickle/*` through the alias table, relative specifiers against the
 * importing file with the `.js` → `.ts` mapping and directory indexes. */
function resolveModule(
  from: string,
  specifier: string,
  aliases: ReadonlyMap<string, string>,
): string | undefined {
  const aliased = aliases.get(specifier);
  if (aliased) return aliased;
  if (!specifier.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = [
    base,
    base.replace(/\.[cm]?js$/, '.ts'),
    base.replace(/\.[cm]?js$/, '.tsx'),
    ...['.ts', '.tsx', '.js', '.mjs', '.cjs'].map(ext => `${base}${ext}`),
    ...['.ts', '.tsx', '.js'].map(ext => path.join(base, `index${ext}`)),
  ];
  return candidates.find(
    candidate =>
      SOURCE_EXTENSION.test(candidate) &&
      !/\.d\.ts$/.test(candidate) &&
      existsSync(candidate) &&
      statSync(candidate).isFile(),
  );
}

/** Static import/export/require specifiers of one module. */
function moduleSpecifiers(file: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/** Every monorepo module Metro bundles into the app: the alias entry points
 * and everything they import, transitively. Their strings (coaching cues,
 * drill/skill labels, error copy) ship inside the same bundle as `src/`. */
function bundledPackageModules(): string[] {
  const aliases = metroAliases();
  const seen = new Set<string>();
  const queue = [...aliases.values()];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const specifier of moduleSpecifiers(file)) {
      const resolved = resolveModule(file, specifier, aliases);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen].sort();
}

function bundledPackageCopy(): CopyString[] {
  return bundledPackageModules().flatMap(collectSourceCopy);
}

// ---------------------------------------------------------------------------
// 1b. Server-supplied catalog copy the app renders verbatim
// ---------------------------------------------------------------------------

function catalogCopy(): CopyString[] {
  return CATALOG_MODULES.filter(existsSync).flatMap(collectSourceCopy);
}

/** Everything the running app can put in front of the user: its own
 * sources, the monorepo modules bundled with them, and the catalog copy the
 * edge function serves it. */
function mobileCopy(): CopyString[] {
  return [...mobileSourceCopy(), ...bundledPackageCopy(), ...catalogCopy()];
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
    ['guest-mode', 'Guest'],
    ['guest-mode', 'Try it first without signing up.'],
    ['guest-mode', 'Skip sign-in for now.'],
    ['live-court', 'Live Court sessions coach you in real time.'],
    ['live-court', 'Live Courts coach you in real time.'],
    ['live-court', 'Live\u2011Court sessions coach you in real time.'],
    ['competitor', 'Better than SwingVision and PB Vision.'],
    ['competitor', 'Better than PB-Vision.'],
    ['competitor', 'Selkirk TV'],
    ['competitor', '"How to Reset" by Selkirk TV on YouTube'],
    ['accuracy-percentage', 'Scores are 95% accurate.'],
    ['accuracy-percentage', 'Scores land with 95% precision.'],
    ['accuracy-percentage', 'Accuracy of 95 pct on every stroke.'],
    ['accuracy-percentage', 'Accurate 9 times out of 10.'],
    ['accuracy-percentage', 'Gets it right 9 out of 10 times.'],
    ['accuracy-percentage', 'Ninety-five percent accurate.'],
    ['accuracy-percentage', 'Accurate nine times out of ten.'],
    ['accuracy-percentage', 'Scores are {…}% accurate.'],
    ['accuracy-percentage', 'Right 9/10 times.'],
    ['accuracy-percentage', 'Agrees with a certified coach 92% of the time.'],
    ['superlative', 'BEST VALUE'],
    ['superlative', 'BEST-VALUE'],
    ['superlative', 'Best'],
    ['superlative', '#1'],
    ['superlative', 'The #1 pickleball coaching app.'],
    ['superlative', 'The ultimate pickleball coaching app.'],
    ['superlative', 'The most effective way to fix your dink.'],
    ['superlative', 'The very best pickleball coach on iPhone.'],
    ['superlative', 'Best pickleball coaching app.'],
    ['superlative', 'Reset Game of Death [BEST PICKLEBALL DRILLS]'],
    [
      'superlative',
      'The Greatest PICKLEBALL Drill You Can Do With Two People!',
    ],
    ['superlative', 'The fastest way to a better dink.'],
    ['superlative', 'Perfect form on every dink.'],
    ['superlative', 'Pro-level analysis for everyone.'],
    ['superlative', 'Superior technique feedback.'],
    ['superlative', 'Nothing else comes close.'],
    ['superlative', 'Results guaranteed.'],
    ['ai-coach-equivalence', 'Feedback that rivals a pro.'],
    ['ai-coach-equivalence', 'As good as a pro.'],
    ['ai-coach-equivalence', 'An AI coach that works like a real coach.'],
    ['ai-coach-equivalence', 'Your personal AI-coach, always in your pocket.'],
    ['ai-coach-equivalence', 'Your A.I. pickleball coach.'],
    ['ai-coach-equivalence', 'Coaching powered by AI.'],
    ['ai-coach-equivalence', 'A virtual coach on every swing.'],
    ['ai-coach-equivalence', 'AI coaching that replaces lessons.'],
    ['ai-coach-equivalence', 'Like having a coach in your pocket.'],
    ['ai-coach-equivalence', 'No need for a coach — Pickle Sensei does it.'],
    ['ai-coach-equivalence', 'Skip the expensive lessons.'],
    ['ai-coach-equivalence', 'Everything a coach would tell you, instantly.'],
  ])('rule %s flags "%s"', (rule, text) => {
    const violations = findViolations([{ source: 'fixture', line: 1, text }]);
    expect(violations.map(violation => violation.rule)).toContain(rule);
  });

  it.each([
    'A DUPR-style estimate of your level.',
    'DUPR-style',
    'Estimated DUPR 5.84',
    'DU\u3164PR ratings on every swing.',
  ])('store copy rule dupr flags "%s" but the in-app rules do not', text => {
    const entry = { source: 'fixture', line: 1, text };
    expect(findViolations([entry], STORE_RULES).map(v => v.rule)).toContain(
      'dupr',
    );
    expect(findViolations([entry]).map(v => v.rule)).not.toContain('dupr');
  });

  it.each([
    'Every price below comes from your app store — never an estimate.',
    'Your best score this month.',
    'Personal best',
    'best DUPR',
    'New best: 82',
    'best of 3 games per role',
    'SAVE 33%',
    'Technique scores are computer-generated coaching estimates, not an official player rating.',
    'Guided drills, with videos from real coaches.',
    'Pickle Sensei is a private pickleball technique coach that lives on your iPhone.',
    'Get the most out of every session.',
    'Your most recent 8 scored analyses.',
    'Replace the current plan?',
    'Confidence 82%',
    'A coach reviews the plan before it is published.',
    'Let the ball drop from the same hand position every time.',
    'Contact — the fastest wrist moment in this swing.',
    'Bias reps toward the opponent-backhand call — the highest-value return in doubles.',
    'Reset from mid-court and still win the point',
    'Kitchen line dinks: 1 of 3 sets',
    'Only the app store can pause or cancel your plan.',
    '3 Smart Drills to Level Up Your 3rd Shot Drops Like a Pro!',
    'Local · this device',
    'Progress stays on this phone until you connect an account.',
  ])('approved copy "%s" is not flagged', text => {
    expect(findViolations([{ source: 'fixture', line: 1, text }])).toEqual([]);
  });

  it('matches the rendered phrase through invisible code points, entities and dash variants', () => {
    expect(normalize('Goo\u00ADgle Play')).toBe('Google Play');
    expect(normalize('An\u200Bdroid')).toBe('Android');
    expect(normalize('An\u2064droid')).toBe('Android');
    expect(normalize('An\uFE0Fdroid')).toBe('Android');
    expect(normalize('An\u{E0001}droid')).toBe('Android');
    expect(normalize('An\u202Adroid')).toBe('Android');
    expect(normalize('Google\u2066 Play')).toBe('Google Play');
    expect(normalize('Live\u2800Court')).toBe('LiveCourt');
    expect(normalize('Live\u2800 Court')).toBe('Live Court');
    expect(normalize('DU\u3164PR')).toBe('DUPR');
    expect(normalize('Goo\u{1D173}gle Play')).toBe('Google Play');
    expect(normalize('Sel\u{E0001}kirk')).toBe('Selkirk');
    expect(normalize('Live\u2011Court')).toBe('Live-Court');
    expect(normalize('Live\u2013Court')).toBe('Live-Court');
    expect(normalize('\uFF21ndroid')).toBe('Android');
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
    const bound = `${FIXTURE_HEADER}const LINES = ['Also on', 'Google', 'Play.'];\nexport const detail = LINES.join(' ');\n`;
    expect(fixtureRules('Fixture.tsx', bound)).toContain('google-play');
  });

  it('reads the children of one JSX element as the phrase the user sees', () => {
    const spaceIdiom = `${FIXTURE_HEADER}export function Fixture() {\n  return (\n    <Text>\n      Also on Google{' '}\n      <Text style={{ fontWeight: '700' }}>Play</Text>.\n    </Text>\n  );\n}\n`;
    expect(fixtureRules('Fixture.tsx', spaceIdiom)).toContain('google-play');
    const nested = `${FIXTURE_HEADER}export function Fixture() {\n  return (\n    <Text>\n      <Text>Live </Text>\n      <Text>Court</Text> sessions coach you.\n    </Text>\n  );\n}\n`;
    expect(fixtureRules('Fixture.tsx', nested)).toContain('live-court');
    const interpolated = `${FIXTURE_HEADER}export function Fixture({ score }: { score: number }) {\n  return <Text>Scores are {score}% accurate.</Text>;\n}\n`;
    expect(fixtureRules('Fixture.tsx', interpolated)).toContain(
      'accuracy-percentage',
    );
    const constant = `${FIXTURE_HEADER}const BRAND = 'Selkirk';\nexport function Fixture() {\n  return <Text>Paddles by {BRAND}</Text>;\n}\n`;
    expect(fixtureRules('Fixture.tsx', constant)).toContain('competitor');
  });

  it('scans prose object keys and hyphenated proper nouns', () => {
    const keys = `${FIXTURE_HEADER}export const LABELS: Record<string, string> = {\n  'Guest mode': 'off',\n};\n`;
    expect(fixtureRules('Fixture.tsx', keys)).toContain('guest-mode');
    const hyphenated = `${FIXTURE_HEADER}export const source = 'PB-Vision';\nexport const label = 'Live-Court';\n`;
    expect(fixtureRules('Fixture.tsx', hyphenated)).toEqual(
      expect.arrayContaining(['competitor', 'live-court']),
    );
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
        `${FIXTURE_HEADER}const PADDLE_BRAND: Record<string, string> = {\n  external: 'Selkirk',\n};\nexport function Fixture() {\n  return <Text>{PADDLE_BRAND.external}</Text>;\n}\n`,
      ),
    ).toContain('competitor');
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
    const source = `${FIXTURE_HEADER}import { Platform } from 'react-native';\nexport const GUEST_DATA_OWNER = 'device-guest';\nexport const isAndroid = Platform.OS === 'android';\nexport const provider: 'apple' | 'google' | 'guest' = 'guest';\nexport const url = 'https://play.google.com/store/account/subscriptions';\nexport const key = 'ANDROID_CHANNEL_ID';\nexport const camel = 'androidChannelId';\nexport const headers = { 'Content-Type': 'application/json' };\nexport const guestKey = 'guest-mode';\n`;
    expect(fixtureRules('Fixture.tsx', source)).toEqual([]);
  });

  it('leaves values the code only compares against alone, not what it renders for them', () => {
    const compared = `${FIXTURE_HEADER}export function label(provider: string, rating: { provider: string }) {
  if (rating.provider !== 'DUPR') return null;
  switch (provider) {
    case 'Guest':
      return 'This device';
    default:
      return provider === 'Android' ? 'Other' : provider;
  }
}
`;
    expect(fixtureRules('Fixture.tsx', compared)).toEqual([]);
    const rendered = `${FIXTURE_HEADER}export function label(provider: string) {
  return provider === 'guest' ? 'Guest' : provider;
}
`;
    expect(fixtureRules('Fixture.tsx', rendered)).toEqual(['guest-mode']);
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

describe('H06 forbidden claims — monorepo packages bundled into the app', () => {
  const aliases = metroAliases();
  const modules = bundledPackageModules();
  const strings = bundledPackageCopy();

  it('covers every @pickle/* entry aliased in metro.config.js and its imports', () => {
    expect(aliases.size).toBeGreaterThanOrEqual(10);
    for (const [name, entry] of aliases) {
      expect(name.startsWith('@pickle/')).toBe(true);
      expect(existsSync(entry)).toBe(true);
      expect(modules).toContain(entry);
    }
    expect(modules.length).toBeGreaterThan(aliases.size * 2);
    expect(
      modules.every(file =>
        file.startsWith(`${path.join(REPO_ROOT, 'packages')}${path.sep}`),
      ),
    ).toBe(true);
    expect(strings.length).toBeGreaterThan(100);
  });

  it('contains none of the forbidden terms', () => {
    expect(describeViolations(strings)).toBe('');
  });
});

describe('H06 forbidden claims — server-supplied drill catalog copy', () => {
  const strings = catalogCopy();

  it('covers the drill catalog and media modules the app renders verbatim', () => {
    for (const module of CATALOG_MODULES) {
      expect(existsSync(module)).toBe(true);
      const source = path.relative(MOBILE_ROOT, module);
      expect(
        strings.filter(entry => entry.source === source).length,
      ).toBeGreaterThan(20);
    }
    expect(strings.some(entry => /\bon YouTube\b/.test(entry.text))).toBe(true);
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

  it('contains none of the forbidden terms, DUPR included', () => {
    expect(
      describeViolations(
        [
          ...copy.values,
          ...copy.blockStrings,
          ...copy.characterCountText,
          ...copy.screenshotCaptions,
        ],
        STORE_RULES,
      ),
    ).toBe('');
  });
});

describe('H06 forbidden claims — iOS permission prompts', () => {
  const strings = plistCopy();

  it('reads the display name and every usage description', () => {
    expect(strings.length).toBeGreaterThanOrEqual(4);
  });

  it('contains none of the forbidden terms, DUPR included', () => {
    expect(describeViolations(strings, STORE_RULES)).toBe('');
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
