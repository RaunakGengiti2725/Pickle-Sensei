/**
 * H06 — forbidden-claims scan over user-facing copy and store copy.
 *
 * `docs/APP_STORE_SUBMISSION.md` §1 (rules 4 and 5) and REVIEW.md forbid, in
 * anything a user or App Review reads: Android, Google Play, "guest mode",
 * "Live Court", DUPR, competitor names, accuracy percentages, superlatives,
 * and AI-coach-equivalence claims. This suite walks the three places that copy
 * lives and fails on the first violation with file:line evidence:
 *
 *  1. every prose string literal, template literal, JSX text and JSX attribute
 *     value in the shipping mobile sources (`src/**`, `App.tsx`);
 *  2. the store copy the dossier tells the operator to type into App Store
 *     Connect — every backticked `ENTER:` value, the fenced blocks that follow
 *     an `ENTER:` prompt or are pasted into review notes, the Appendix A text
 *     column and the Appendix C screenshot captions;
 *  3. the iOS permission prompts and display name in `Info.plist`.
 *
 * Policy prose in the dossier (which necessarily names the forbidden terms) is
 * deliberately not part of the store-copy corpus.
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
}>('node:path');

const MOBILE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(MOBILE_ROOT, '..', '..');
const DOSSIER = path.join(REPO_ROOT, 'docs', 'APP_STORE_SUBMISSION.md');
const INFO_PLIST = path.join(MOBILE_ROOT, 'ios', 'PickleSensei', 'Info.plist');

type ForbiddenRule = { id: string; pattern: RegExp };

const FORBIDDEN_RULES: ReadonlyArray<ForbiddenRule> = [
  { id: 'android', pattern: /\bandroid\b/i },
  { id: 'google-play', pattern: /\bgoogle play\b|\bplay store\b/i },
  {
    id: 'guest-mode',
    pattern:
      /\bguest mode\b|\b(?:continue|sign in|start|browse|play|try|use)(?: the app)? as (?:a )?guest\b|\bguest (?:account|access|sign[- ]?in|entry|login)\b/i,
  },
  { id: 'live-court', pattern: /\blive[- ]?court\b/i },
  { id: 'dupr', pattern: /\bdupr\b/i },
  {
    id: 'competitor',
    pattern: /\bswing ?vision\b|\bpb ?vision\b|\bselkirk\b|\bjoola\b/i,
  },
  {
    id: 'accuracy-percentage',
    pattern:
      /accura[a-z]*[^.!?]*\d+(?:\.\d+)?\s?(?:%|percent)|\d+(?:\.\d+)?\s?(?:%|percent)[^.!?]*accura/i,
  },
  {
    id: 'superlative',
    pattern:
      /\bthe best\b|\bbest[- ]in[- ]class\b|\bbest value\b|\bbest (?:pickleball|app|coach|way|choice|deal|plan|price|option|technique|analysis|analyzer|trainer|training)\b|(?:^|[\s(])#\s?1\b|\bnumber one\b|\bno\.\s?1\b|\bworld[- ]class\b|\b(?:industry|market|category)[- ]leading\b|\bmost (?:accurate|advanced|trusted|popular|powerful|precise|complete|reliable)\b|\bunmatched\b|\bunrivaled\b|\bunbeatable\b|\brevolutionary\b|\bcutting[- ]edge\b|\bstate[- ]of[- ]the[- ]art\b|\bbest[- ]selling\b|\btop[- ]rated\b|\baward[- ]winning\b/i,
  },
  {
    id: 'ai-coach-equivalence',
    pattern:
      /\bai coach\b|\bai[- ]powered coach\b|\b(?:replace|replaces|replacing|instead of) (?:a|your) (?:human |real |pro |personal |private )?coach\b|\b(?:like|as good as|better than|same as) (?:a|your) (?:real |human |pro |personal |private )?coach\b/i,
  },
];

type CopyString = { source: string; line: number; text: string };
type Violation = CopyString & { rule: string };

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
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

// ---------------------------------------------------------------------------
// 1. Mobile sources
// ---------------------------------------------------------------------------

const EXCLUDED_DIRECTORIES = new Set([
  '__tests__',
  '__mocks__',
  'node_modules',
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return EXCLUDED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(file);
    }
    return /\.tsx?$/.test(entry.name) &&
      !/\.d\.ts$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
      ? [file]
      : [];
  });
}

const COPY_BINDING_NAME =
  /(?:label|title|text|caption|copy|body|badge|eyebrow|message|detail|hint|subtitle|heading|description|summary|cta|placeholder|name)$/i;

function isMultiWord(text: string): boolean {
  return /\S\s+\S/.test(text);
}

/** A string is user-facing copy when it reads as prose (two or more words),
 * is rendered by JSX, or is the value of a copy-named binding — single-word
 * labels such as a badge still count when they sit in a copy slot. */
function isCopyContext(node: ts.Node, text: string): boolean {
  const parent = node.parent;
  if (ts.isJsxText(node) || ts.isJsxAttribute(parent)) return true;
  if (isMultiWord(text)) return true;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    return COPY_BINDING_NAME.test(parent.name.getText());
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    return COPY_BINDING_NAME.test(parent.name.getText());
  }
  return false;
}

function collectSourceCopy(file: string): CopyString[] {
  const text = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const source = path.relative(MOBILE_ROOT, file);
  const strings: CopyString[] = [];

  const record = (node: ts.Node, raw: string): void => {
    const value = normalize(raw);
    if (!value || !isCopyContext(node, value)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    strings.push({ source, line: line + 1, text: value });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isJsxText(node)) {
      record(node, node.text);
    } else if (ts.isStringLiteralLike(node)) {
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertyAssignment(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isPropertyDeclaration(parent)) &&
        parent.name === node;
      if (!isPropertyName && !ts.isLiteralTypeNode(parent)) {
        record(node, node.text);
      }
    } else if (ts.isTemplateExpression(node)) {
      record(
        node,
        [node.head.text, ...node.templateSpans.map(span => span.literal.text)]
          .map(part => part.trim())
          .filter(part => part.length > 0)
          .join(' '),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return strings;
}

function mobileCopy(): CopyString[] {
  const files = [
    ...sourceFiles(path.join(MOBILE_ROOT, 'src')),
    path.join(MOBILE_ROOT, 'App.tsx'),
  ];
  return files.flatMap(collectSourceCopy);
}

// ---------------------------------------------------------------------------
// 2. App Store dossier store copy
// ---------------------------------------------------------------------------

const DOSSIER_SOURCE = path.relative(MOBILE_ROOT, DOSSIER);
const OPERATOR_MARKER = /^[A-Z]+:$/;

function dossierLines(): string[] {
  return readFileSync(DOSSIER, 'utf8').split('\n');
}

/** Every backticked value on a line that instructs the operator to `ENTER:`
 * it, excluding the operator markers themselves (`ENTER:`, `HUMAN:`, ...). */
function enterValues(lines: string[]): CopyString[] {
  const strings: CopyString[] = [];
  lines.forEach((line, index) => {
    if (!line.includes('`ENTER:`')) return;
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const value = normalize(match[1] ?? '');
      if (!value || OPERATOR_MARKER.test(value)) continue;
      strings.push({ source: DOSSIER_SOURCE, line: index + 1, text: value });
    }
  });
  return strings;
}

/** Fenced blocks whose nearest preceding non-blank line is an `ENTER:` prompt
 * (promotional text, keywords, description) or a "paste into" instruction
 * (App Review notes). */
function enterBlocks(lines: string[]): {
  blocks: number;
  strings: CopyString[];
} {
  const strings: CopyString[] = [];
  let blocks = 0;
  const lineAt = (index: number): string => lines[index] ?? '';
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^```/.test(lineAt(index))) continue;
    let cursor = index - 1;
    while (cursor >= 0 && lineAt(cursor).trim() === '') cursor -= 1;
    const prompt = cursor >= 0 ? lineAt(cursor) : '';
    const isStoreCopy =
      prompt.includes('`ENTER:`') || /paste into/i.test(prompt);
    const start = index + 1;
    let end = start;
    while (end < lines.length && !/^```/.test(lineAt(end))) end += 1;
    if (isStoreCopy) {
      blocks += 1;
      for (let row = start; row < end; row += 1) {
        const value = normalize(lineAt(row));
        if (value) {
          strings.push({ source: DOSSIER_SOURCE, line: row + 1, text: value });
        }
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
  const { blocks, strings: blockStrings } = enterBlocks(lines);
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

describe('H06 forbidden claims — rule fixtures', () => {
  it.each([
    ['android', 'Also available on Android.'],
    ['google-play', 'Manage subscription in Google Play'],
    ['guest-mode', 'Continue as guest or enable guest mode later.'],
    ['live-court', 'Live Court sessions coach you in real time.'],
    ['dupr', 'A DUPR-style estimate of your level.'],
    ['competitor', 'Better than SwingVision and PB Vision.'],
    ['accuracy-percentage', 'Scores are 95% accurate.'],
    ['superlative', 'BEST VALUE'],
    ['superlative', 'The #1 pickleball coaching app.'],
    ['ai-coach-equivalence', 'An AI coach that works like a real coach.'],
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
  ])('approved copy "%s" is not flagged', text => {
    expect(findViolations([{ source: 'fixture', line: 1, text }])).toEqual([]);
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
    expect(findViolations(strings)).toEqual([]);
  });
});

describe('H06 forbidden claims — App Store dossier store copy', () => {
  it('the dossier exists at its documented path', () => {
    expect(existsSync(DOSSIER)).toBe(true);
  });

  const copy = storeCopy();

  it('extracts the ENTER values, pasted blocks, character-count text and captions', () => {
    expect(copy.values.length).toBeGreaterThanOrEqual(30);
    expect(copy.blocks).toBeGreaterThanOrEqual(4);
    expect(copy.blockStrings.length).toBeGreaterThanOrEqual(30);
    expect(copy.characterCountText.length).toBeGreaterThanOrEqual(10);
    expect(copy.screenshotCaptions.length).toBeGreaterThanOrEqual(6);
    expect(
      copy.blockStrings.some(entry => /^Pickle Sensei is a/.test(entry.text)),
    ).toBe(true);
  });

  it('contains none of the forbidden terms', () => {
    expect(
      findViolations([
        ...copy.values,
        ...copy.blockStrings,
        ...copy.characterCountText,
        ...copy.screenshotCaptions,
      ]),
    ).toEqual([]);
  });
});

describe('H06 forbidden claims — iOS permission prompts', () => {
  const strings = plistCopy();

  it('reads the display name and every usage description', () => {
    expect(strings.length).toBeGreaterThanOrEqual(4);
  });

  it('contains none of the forbidden terms', () => {
    expect(findViolations(strings)).toEqual([]);
  });
});
