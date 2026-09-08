/**
 * H06-01 adversarial attack suite — runs the CANDIDATE scanner from
 * `__tests__/h06ForbiddenClaims.test.ts` (loaded verbatim, not re-implemented)
 * against copy shapes that ship in this codebase and against copy surfaces the
 * corpus omits. Every `it` is one attack: a failing test is a confirmed
 * break (the scanner lets a forbidden phrase through, or misses a surface a
 * user reads); a passing test is an attack the candidate survived.
 */
import ts from 'typescript';

declare const __dirname: string;
const { readFileSync, existsSync } = jest.requireActual<{
  readFileSync(file: string, encoding: 'utf8'): string;
  existsSync(file: string): boolean;
}>('node:fs');
const path = jest.requireActual<{
  resolve(...parts: string[]): string;
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
}>('node:path');

const TESTS_DIR = __dirname;
const MOBILE_ROOT = path.resolve(TESTS_DIR, '..');
const REPO_ROOT = path.resolve(MOBILE_ROOT, '..', '..');
const CANDIDATE = path.join(TESTS_DIR, 'h06ForbiddenClaims.test.ts');
const EDGE_API = path.join(REPO_ROOT, 'supabase', 'functions', 'api');

type CopyString = { source: string; line: number; text: string };
type Violation = CopyString & { rule: string };

interface CandidateScanner {
  findViolations(strings: ReadonlyArray<CopyString>): Violation[];
  scanModule(fileName: string, text: string): CopyString[];
  normalize(text: string): string;
  isCodeToken(text: string): boolean;
  mobileCopy(): CopyString[];
  legalCopy(): CopyString[];
  plistCopy(): CopyString[];
  swiftCopy(): CopyString[];
}

const EXPORTED = [
  'findViolations',
  'scanModule',
  'normalize',
  'isCodeToken',
  'mobileCopy',
  'legalCopy',
  'plistCopy',
  'swiftCopy',
] as const;

function isCandidateScanner(value: unknown): value is CandidateScanner {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return EXPORTED.every(name => typeof record[name] === 'function');
}

/** The candidate file has no exports; take everything above its first
 * `describe(` (the scanner) and export the helpers, so the attacks exercise
 * the exact code the acceptance test runs. */
function loadCandidateScanner(): CandidateScanner {
  const source = readFileSync(CANDIDATE, 'utf8');
  const cut = source.indexOf("\ndescribe('");
  if (cut < 0) throw new Error('candidate scanner: no describe() found');
  const program = `${source.slice(0, cut)}\nmodule.exports = { ${EXPORTED.join(', ')} };\n`;
  const { outputText } = ts.transpileModule(program, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: CANDIDATE,
  });
  const sandbox: { exports: Record<string, unknown> } = { exports: {} };
  const run = new Function(
    'exports',
    'require',
    'module',
    '__dirname',
    'jest',
    outputText,
  ) as (
    exports: Record<string, unknown>,
    require: NodeRequire,
    module: { exports: Record<string, unknown> },
    dirname: string,
    jestObject: typeof jest,
  ) => void;
  run(sandbox.exports, require, sandbox, TESTS_DIR, jest);
  if (!isCandidateScanner(sandbox.exports)) {
    throw new Error('candidate scanner: expected helpers not found');
  }
  return sandbox.exports;
}

const scanner = loadCandidateScanner();

const FIXTURE_HEADER =
  "import React from 'react';\nimport { Text } from 'react-native';\n\n";

const SOURCE_EXT = /\.(?:tsx|ts|jsx|js|mjs|cjs)$/;
const SKIP_FILE = /\.(?:test|spec|d)\.[cm]?[jt]sx?$/;

function* walkDir(dir: string): Generator<string> {
  const fs = jest.requireActual<{
    readdirSync(
      dir: string,
      options: { withFileTypes: true },
    ): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  }>('node:fs');
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('__'))
        continue;
      yield* walkDir(full);
    } else if (
      entry.isFile() &&
      SOURCE_EXT.test(entry.name) &&
      !SKIP_FILE.test(entry.name)
    ) {
      yield full;
    }
  }
}

function shippingSources(): Array<{ file: string; text: string }> {
  const files = [
    ...walkDir(path.join(MOBILE_ROOT, 'src')),
    path.join(MOBILE_ROOT, 'App.tsx'),
  ];
  return files.map(file => ({ file, text: readFileSync(file, 'utf8') }));
}

/** What a reader of one <Text> element sees: every JSX text child, every
 * string-literal expression child and every nested element's text, joined in
 * order; non-literal expressions become `{…}`. */
function renderedJsxText(node: ts.JsxElement | ts.JsxFragment): string {
  const parts: string[] = [];
  for (const child of node.children) {
    if (ts.isJsxText(child)) parts.push(child.text);
    else if (ts.isJsxElement(child) || ts.isJsxFragment(child))
      parts.push(renderedJsxText(child));
    else if (ts.isJsxExpression(child) && child.expression) {
      const expr = child.expression;
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
        parts.push(expr.text);
      else parts.push('{…}');
    }
  }
  return parts.join('');
}

function jsxElementCopy(file: string, text: string): CopyString[] {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: CopyString[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const rendered = scanner.normalize(renderedJsxText(node));
      if (rendered) {
        out.push({
          source: path.relative(MOBILE_ROOT, file),
          line:
            sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          text: rendered,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/** Every string/JSX-attribute literal the candidate's `isCodeToken` skips
 * although it reads as Capitalised hyphenated prose (Right-handed, Non-binary,
 * AUTO-DETECTED are shipped in exactly this shape). */
function skippedHyphenatedProse(file: string, text: string): CopyString[] {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: CopyString[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const value = scanner.normalize(node.text);
      if (
        /^[A-Z][A-Za-z]*(?:-[A-Za-z]+)+$/.test(value) &&
        scanner.isCodeToken(value)
      ) {
        out.push({
          source: path.relative(MOBILE_ROOT, file),
          line:
            sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          text: value,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

function describeAll(entries: ReadonlyArray<Violation>): string[] {
  return entries.map(
    entry => `${entry.source}:${entry.line} [${entry.rule}] ${entry.text}`,
  );
}

function rulesFor(fileName: string, source: string): string[] {
  return scanner
    .findViolations(
      scanner.scanModule(path.join(MOBILE_ROOT, 'src', fileName), source),
    )
    .map(violation => violation.rule);
}

function rulesForText(text: string): string[] {
  return scanner
    .findViolations([{ source: 'attack', line: 1, text }])
    .map(violation => violation.rule);
}

// ---------------------------------------------------------------------------
// A1 — rendered phrase split across JSX nodes (the `{' '}` Prettier idiom and
// nested <Text>). Both shapes are used in this codebase (ProgressScreen.tsx
// alone has three `{' '}` splits inside one sentence).
// ---------------------------------------------------------------------------
describe('A1 — JSX children split a rendered phrase', () => {
  it("flags a phrase split by the `{' '}` idiom", () => {
    const source = `${FIXTURE_HEADER}export function Fixture() {\n  return (\n    <Text>\n      Manage your subscription in Google{' '}\n      Play settings.\n    </Text>\n  );\n}\n`;
    expect(rulesFor('Fixture.tsx', source)).toContain('google-play');
  });

  it("flags a superlative split by the `{' '}` idiom", () => {
    const source = `${FIXTURE_HEADER}export function Fixture() {\n  return (\n    <Text>\n      The most{' '}\n      {'accurate'} read of your dink.\n    </Text>\n  );\n}\n`;
    expect(rulesFor('Fixture.tsx', source)).toContain('superlative');
  });

  it('flags a phrase split across nested <Text> styling', () => {
    const source = `${FIXTURE_HEADER}export function Fixture() {\n  return (\n    <Text>\n      Live <Text style={{ fontWeight: '700' }}>Court</Text> sessions coach you in real time.\n    </Text>\n  );\n}\n`;
    expect(rulesFor('Fixture.tsx', source)).toContain('live-court');
  });

  it('flags a phrase split by an interpolated literal child', () => {
    const source = `${FIXTURE_HEADER}export function Fixture() {\n  return <Text>Also on {'Google'} Play.</Text>;\n}\n`;
    expect(rulesFor('Fixture.tsx', source)).toContain('google-play');
  });

  it('shipping <Text> elements, read whole, contain no forbidden terms', () => {
    const strings = shippingSources().flatMap(({ file, text }) =>
      jsxElementCopy(file, text),
    );
    expect(strings.length).toBeGreaterThan(500);
    expect(describeAll(scanner.findViolations(strings))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A2 — hyphenated prose is classified as a kebab-case code token and skipped
// everywhere except JSX text. The codebase writes hyphenated prose in exactly
// these slots ('Right-handed', 'Non-binary', eyebrow 'AUTO-DETECTED').
// ---------------------------------------------------------------------------
describe('A2 — hyphenated prose treated as a code token', () => {
  it.each([
    ['BEST-VALUE', 'superlative'],
    ['Best-in-class', 'superlative'],
    ['World-class', 'superlative'],
    ['Award-winning', 'superlative'],
    ['Top-rated', 'superlative'],
    ['State-of-the-art', 'superlative'],
    ['Game-changing', 'superlative'],
    ['DUPR-style', 'dupr'],
    ['Live-Court', 'live-court'],
    ['Google-Play', 'google-play'],
    ['Android-only', 'android'],
  ])('flags `heroBadge="%s"` as %s', (badge, rule) => {
    const source = `${FIXTURE_HEADER}export function Fixture() {\n  return <Text accessibilityLabel=${JSON.stringify(badge)}>x</Text>;\n}\n`;
    expect(rulesFor('Fixture.tsx', source)).toContain(rule);
  });

  it.each([
    ['BEST-VALUE', 'superlative'],
    ['DUPR-style', 'dupr'],
    ['Live-Court', 'live-court'],
  ])('flags `eyebrow: %s` in an object literal as %s', (label, rule) => {
    const source = `${FIXTURE_HEADER}export const notice = {\n  title: 'Ready',\n  eyebrow: ${JSON.stringify(label)},\n};\n`;
    expect(rulesFor('copy.ts', source)).toContain(rule);
  });

  it('does not classify hyphenated Capitalised prose as a code token', () => {
    expect(scanner.isCodeToken('Right-handed')).toBe(false);
    expect(scanner.isCodeToken('BEST-VALUE')).toBe(false);
    expect(scanner.isCodeToken('DUPR-style')).toBe(false);
  });

  it('flags a bare `#1` badge outside JSX text', () => {
    const source = `${FIXTURE_HEADER}export const badges = { rank: '#1' };\n`;
    expect(rulesFor('copy.ts', source)).toContain('superlative');
  });

  it('shipping hyphenated prose the scanner skipped contains no forbidden terms', () => {
    const skipped = shippingSources().flatMap(({ file, text }) =>
      skippedHyphenatedProse(file, text),
    );
    expect(skipped.length).toBeGreaterThan(0);
    expect(describeAll(scanner.findViolations(skipped))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A3 — accuracy percentages whose number arrives at runtime. The rule needs a
// literal digit; the scanner renders unknown parts as `{…}`, so the claim
// "N% accurate" is invisible whenever N is computed.
// ---------------------------------------------------------------------------
describe('A3 — accuracy claims with a runtime number', () => {
  it('flags a template-literal percentage claim', () => {
    const source = `${FIXTURE_HEADER}export function label(agreement: number): string {\n  return \`\${Math.round(agreement * 100)}% accurate on your last 20 strokes\`;\n}\n`;
    expect(rulesFor('copy.ts', source)).toContain('accuracy-percentage');
  });

  it('flags a concatenated percentage claim', () => {
    const source = `${FIXTURE_HEADER}export function label(pct: number): string {\n  return 'Accuracy: ' + pct + '% on scored strokes';\n}\n`;
    expect(rulesFor('copy.ts', source)).toContain('accuracy-percentage');
  });

  it('flags a JSX percentage claim with an interpolated number', () => {
    const source = `${FIXTURE_HEADER}export function Fixture(props: { pct: number }) {\n  return <Text>{props.pct}% accurate</Text>;\n}\n`;
    expect(rulesFor('Fixture.tsx', source)).toContain('accuracy-percentage');
  });

  it.each([
    'Accurate nine times out of ten.',
    'Ninety-five percent accuracy on every stroke.',
    'Accuracy: 9/10 strokes scored correctly.',
    'Scores match a coach 95% of the time.',
    '95% agreement with certified coaches.',
  ])('flags the spelled-out or ratio claim "%s"', text => {
    expect(rulesForText(text)).toContain('accuracy-percentage');
  });
});

// ---------------------------------------------------------------------------
// A4 — server-supplied copy rendered by the app. DrillLibraryScreen.tsx and
// DrillVideoPlayer.tsx render `drill.title`, `drill.description`,
// `media.title` and `media.creatorName` straight from the production edge
// function (`supabase/functions/api/drills.ts`, `drillMedia.ts`). Neither
// file is in the candidate corpus; scanning them with the candidate's own
// scanner shows what the app displays today.
// ---------------------------------------------------------------------------
describe('A4 — server-supplied drill copy is user-facing but unscanned', () => {
  const drillFiles = ['drills.ts', 'drillMedia.ts'].map(name =>
    path.join(EDGE_API, name),
  );

  it('the drill catalog files exist and are rendered by the app', () => {
    for (const file of drillFiles) expect(existsSync(file)).toBe(true);
    const screen = readFileSync(
      path.join(MOBILE_ROOT, 'src', 'screens', 'DrillLibraryScreen.tsx'),
      'utf8',
    );
    expect(screen).toContain('{media.creatorName}');
    expect(screen).toContain('{drill.title}');
  });

  it('the candidate corpus covers the drill catalog the app renders', () => {
    const covered = new Set(
      [...scanner.mobileCopy(), ...scanner.legalCopy()].map(entry =>
        path.resolve(MOBILE_ROOT, entry.source),
      ),
    );
    const missing = drillFiles.filter(file => !covered.has(file));
    expect(missing.map(file => path.relative(REPO_ROOT, file))).toEqual([]);
  });

  it('the drill catalog served to the app contains no forbidden terms', () => {
    const strings = drillFiles.flatMap(file =>
      scanner.scanModule(file, readFileSync(file, 'utf8')),
    );
    expect(strings.length).toBeGreaterThan(100);
    const violations = scanner
      .findViolations(strings)
      .map(
        entry =>
          `${path.relative(REPO_ROOT, path.resolve(MOBILE_ROOT, entry.source))}:${entry.line} [${entry.rule}] ${entry.text}`,
      );
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A5 — superlative / competitor-comparison phrasings adjacent to the ones the
// candidate fixes ("BEST VALUE" → badge copy; "the most precise read").
// ---------------------------------------------------------------------------
describe('A5 — superlative phrasings near the fixed violations', () => {
  it.each([
    'BEST',
    'BEST PICK',
    'OUR BEST',
    'Best for serious players',
    'Highest-rated pickleball app',
    'A leading pickleball coaching app',
    'The fastest way to fix your dink',
    'The most consistent read of your stroke',
    'Perfect form, every time',
    'Flawless technique in a week',
    'Better than any other app',
    'Nothing else comes close',
    'Second to none',
    'Unlike any other app',
    'Superior accuracy',
    'The "#1" pickleball app',
    'Pro-level accuracy',
  ])(
    'flags "%s" as a superlative (dossier §0.5: no "best" in any copy)',
    text => {
      expect(rulesForText(text)).toContain('superlative');
    },
  );
});

// ---------------------------------------------------------------------------
// A6 — guest-mode and AI-coach-equivalence phrasings.
// ---------------------------------------------------------------------------
describe('A6 — guest-mode and AI-coach-equivalence phrasings', () => {
  it.each([
    'Guest',
    'Explore without signing in',
    'Skip sign-in for now',
    'Guest analyses stay on this phone',
    'Guests get two ratings',
  ])('flags "%s" as guest mode', text => {
    expect(rulesForText(text)).toContain('guest-mode');
  });

  it.each([
    'Your AI-powered pickleball coach',
    'An AI-driven coach for every stroke',
    'Coaching powered by AI',
    'Coached by AI, on your phone',
    'A virtual coach in your pocket',
    'Everything a private coach would tell you',
  ])('flags "%s" as AI-coach equivalence', text => {
    expect(rulesForText(text)).toContain('ai-coach-equivalence');
  });
});

// ---------------------------------------------------------------------------
// A7 — invisible / format code points the normaliser does not strip. All of
// these render as nothing (or as blank) on iOS, so the reader sees the
// forbidden phrase while the regex sees two words.
// ---------------------------------------------------------------------------
describe('A7 — invisible code points outside the strip list', () => {
  it.each([
    ['U+FE0F variation selector', 'Google\uFE0F Play', 'google-play'],
    ['U+2062 invisible times', 'Google\u2062Play', 'google-play'],
    ['U+2064 invisible plus', 'Live\u2064 Court', 'live-court'],
    ['U+202A bidi embedding', 'An\u202Adroid', 'android'],
    ['U+2066 bidi isolate', 'Google\u2066 Play', 'google-play'],
    ['U+2800 braille blank', 'Live\u2800Court', 'live-court'],
    ['U+3164 Hangul filler', 'DU\u3164PR', 'dupr'],
    [
      'U+1D173 musical symbol begin beam',
      'Goo\u{1D173}gle Play',
      'google-play',
    ],
    ['U+E0001 language tag', 'Sel\u{E0001}kirk', 'competitor'],
  ])('%s does not hide "%s"', (_label, text, rule) => {
    expect(rulesForText(scanner.normalize(text))).toContain(rule);
  });

  it('normalises a non-breaking hyphen and an en dash between the words', () => {
    expect(rulesForText(scanner.normalize('Google\u2011Play'))).toContain(
      'google-play',
    );
    expect(rulesForText(scanner.normalize('Live\u2013Court'))).toContain(
      'live-court',
    );
  });

  it('shipping sources contain none of the unstripped invisible code points', () => {
    // Variation selectors only count after a plain letter (after an emoji
    // base they are the emoji's own presentation selector).
    const EXTRA_INVISIBLE =
      /[A-Za-z][\uFE00-\uFE0F]|[\u2061-\u2064\u202A-\u202E\u2066-\u2069\u2800\u3164\uFFA0]|[\u{1D173}-\u{1D17A}]|[\u{E0000}-\u{E007F}]/u;
    const hits = shippingSources()
      .filter(({ text }) => EXTRA_INVISIBLE.test(text))
      .map(({ file }) => path.relative(MOBILE_ROOT, file));
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A8 — copy stored in a named array and joined at render time. The scanner
// only assembles `[...].join()` when the array literal is inline.
// ---------------------------------------------------------------------------
describe('A8 — named-array copy joined at render time', () => {
  it('flags a phrase assembled from a named array', () => {
    const source = `${FIXTURE_HEADER}const LINES = ['Manage your subscription in Google', 'Play settings.'];\nexport function Fixture() {\n  return <Text>{LINES.join(' ')}</Text>;\n}\n`;
    expect(rulesFor('Fixture.tsx', source)).toContain('google-play');
  });

  it('flags a phrase whose words are object-literal KEYS rendered as labels', () => {
    const source = `${FIXTURE_HEADER}const STORE_URLS = {\n  'Google Play': 'https://play.google.com/store/account/subscriptions',\n};\nexport function Fixture() {\n  return <>{Object.keys(STORE_URLS).map(label => <Text key={label}>{label}</Text>)}</>;\n}\n`;
    expect(rulesFor('Fixture.tsx', source)).toContain('google-play');
  });
});

// ---------------------------------------------------------------------------
// A9 — the candidate's own corpus is non-empty for every surface it claims
// (a zero-length surface would silently pass its "contains none" checks).
// ---------------------------------------------------------------------------
describe('A9 — every claimed surface yields copy', () => {
  it('mobile, legal, plist and Swift corpora are all non-empty', () => {
    expect(scanner.mobileCopy().length).toBeGreaterThan(1000);
    expect(scanner.legalCopy().length).toBeGreaterThan(20);
    expect(scanner.plistCopy().length).toBeGreaterThanOrEqual(4);
    expect(scanner.swiftCopy().length).toBeGreaterThan(20);
  });

  it('the mobile corpus includes the three files the candidate fixed', () => {
    const sources = new Set(scanner.mobileCopy().map(entry => entry.source));
    for (const file of [
      'src/screens/ManageAccountScreen.tsx',
      'src/screens/PaywallScreen.tsx',
      'src/screens/AnalyzeScreen.tsx',
    ]) {
      expect(sources.has(file)).toBe(true);
    }
  });
});
