/**
 * H06-01 adversarial suite — runs the CANDIDATE scanner
 * (`__tests__/h06ForbiddenClaims.test.ts`, copied byte-for-byte at run time)
 * inside a throwaway sandbox that mirrors the paths it resolves
 * (`<mobile>/src`, `<mobile>/App.tsx`, `<mobile>/ios/PickleSensei/Info.plist`,
 * `<repo>/docs/APP_STORE_SUBMISSION.md`) and feeds it one piece of copy at a
 * time. Every attack asserts that the scanner FLAGS a violation that a user or
 * App Review would read; an attack that passes here means the scanner caught
 * it, an attack that fails here is a confirmed false negative.
 *
 * The sandbox lives under `<mobile>/__h06attack__/` for the duration of a
 * single `it` and is removed afterwards, so the shipping `src/` tree is never
 * touched and the candidate suite (which scans `src/`) is unaffected.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

declare const __dirname: string;

const MOBILE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(MOBILE_ROOT, '..', '..');
const CANDIDATE_TEST = path.join(__dirname, 'h06ForbiddenClaims.test.ts');
const REAL_DOSSIER = path.join(REPO_ROOT, 'docs', 'APP_STORE_SUBMISSION.md');
const REAL_PLIST = path.join(MOBILE_ROOT, 'ios', 'PickleSensei', 'Info.plist');
const JEST_BIN = path.join(
  MOBILE_ROOT,
  'node_modules',
  'jest',
  'bin',
  'jest.js',
);
const SANDBOX_PARENT = path.join(MOBILE_ROOT, '__h06attack__');

const MOBILE_TEST_NAME =
  'H06 forbidden claims — mobile user-facing strings contains none of the forbidden terms';
const DOSSIER_TEST_NAME =
  'H06 forbidden claims — App Store dossier store copy contains none of the forbidden terms';

type AssertionResult = {
  fullName: string;
  status: string;
  failureMessages: string[];
};
type JestJson = {
  testResults: Array<{ assertionResults: AssertionResult[] }>;
};

type Sandbox = {
  root: string;
  mobile: string;
  src: string;
  dossier: string;
  testFile: string;
};

function makeSandbox(): Sandbox {
  mkdirSync(SANDBOX_PARENT, { recursive: true });
  const root = mkdtempSync(path.join(SANDBOX_PARENT, 'case-'));
  const mobile = path.join(root, 'repo', 'apps', 'mobile');
  const src = path.join(mobile, 'src');
  const tests = path.join(mobile, '__tests__');
  const iosDir = path.join(mobile, 'ios', 'PickleSensei');
  const docs = path.join(root, 'repo', 'docs');
  for (const dir of [src, tests, iosDir, docs]) {
    mkdirSync(dir, { recursive: true });
  }
  const testFile = path.join(tests, 'h06ForbiddenClaims.test.ts');
  copyFileSync(CANDIDATE_TEST, testFile);
  copyFileSync(REAL_PLIST, path.join(iosDir, 'Info.plist'));
  const dossier = path.join(docs, 'APP_STORE_SUBMISSION.md');
  copyFileSync(REAL_DOSSIER, dossier);
  writeFileSync(
    path.join(mobile, 'App.tsx'),
    'export default function App() {\n  return null;\n}\n',
  );
  return { root, mobile, src, dossier, testFile };
}

function runCandidate(sandbox: Sandbox): AssertionResult[] {
  const outputFile = path.join(sandbox.root, 'result.json');
  const env = { ...process.env };
  delete env.JEST_WORKER_ID;
  const run = spawnSync(
    process.execPath,
    [
      JEST_BIN,
      '--ci',
      '--silent',
      '--json',
      '--outputFile',
      outputFile,
      path.relative(MOBILE_ROOT, sandbox.testFile),
    ],
    { cwd: MOBILE_ROOT, env, encoding: 'utf8' },
  );
  if (run.error) throw run.error;
  const parsed = JSON.parse(readFileSync(outputFile, 'utf8')) as JestJson;
  const results = parsed.testResults.flatMap(file => file.assertionResults);
  if (results.length === 0) {
    throw new Error(
      `candidate scanner produced no assertions\n${run.stdout}\n${run.stderr}`,
    );
  }
  return results;
}

function assertion(results: AssertionResult[], fullName: string) {
  const found = results.find(result => result.fullName === fullName);
  if (!found) {
    throw new Error(
      `candidate scanner has no test named "${fullName}"; saw ${results
        .map(result => result.fullName)
        .join(' | ')}`,
    );
  }
  return found;
}

/** Runs the candidate scanner over a sandbox whose `src/Fixture.tsx` is the
 * given source and returns the mobile-copy verdict. */
function scanMobileSource(source: string): AssertionResult {
  const sandbox = makeSandbox();
  try {
    writeFileSync(path.join(sandbox.src, 'Fixture.tsx'), source);
    return assertion(runCandidate(sandbox), MOBILE_TEST_NAME);
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}

function scanMobileFile(fileName: string, source: string): AssertionResult {
  const sandbox = makeSandbox();
  try {
    writeFileSync(path.join(sandbox.src, fileName), source);
    return assertion(runCandidate(sandbox), MOBILE_TEST_NAME);
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}

function scanDossier(transform: (dossier: string) => string): AssertionResult {
  const sandbox = makeSandbox();
  try {
    writeFileSync(
      sandbox.dossier,
      transform(readFileSync(REAL_DOSSIER, 'utf8')),
    );
    return assertion(runCandidate(sandbox), DOSSIER_TEST_NAME);
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}

const HEADER =
  "import React from 'react';\nimport { Text } from 'react-native';\n\n";

function jsxText(copy: string): string {
  return `${HEADER}export function Fixture() {\n  return <Text>${copy}</Text>;\n}\n`;
}

function jsxLiteral(copy: string): string {
  return `${HEADER}export function Fixture() {\n  return <Text>{${JSON.stringify(copy)}}</Text>;\n}\n`;
}

function expectFlagged(result: AssertionResult, copy: string): void {
  expect(result.status).toBe('failed');
  expect(result.failureMessages.join('\n')).toContain(copy);
}

afterAll(() => {
  rmSync(SANDBOX_PARENT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Controls — the scanner must catch the direct phrasing. These pass on the
// candidate and prove the sandbox exercises the real scanner.
// ---------------------------------------------------------------------------

describe('H06 attack — controls (direct phrasing is flagged)', () => {
  it('JSX text "Manage subscription in Google Play"', () => {
    expectFlagged(
      scanMobileSource(jsxText('Manage subscription in Google Play')),
      'Manage subscription in Google Play',
    );
  });

  it('string literal "BEST VALUE" as a JSX attribute', () => {
    const source = `${HEADER}export function Fixture() {\n  return <Text accessibilityLabel="BEST VALUE">x</Text>;\n}\n`;
    expectFlagged(scanMobileSource(source), 'BEST VALUE');
  });

  it('dossier ENTER value naming a competitor', () => {
    const result = scanDossier(dossier =>
      dossier.replace(
        '| Subtitle (30 max)   | `ENTER:` `Pickleball technique coach`',
        '| Subtitle (30 max)   | `ENTER:` `Better than SwingVision`',
      ),
    );
    expectFlagged(result, 'Better than SwingVision');
  });
});

// ---------------------------------------------------------------------------
// Attack 1 — the rendered string is assembled from several literals.
// The codebase wraps long copy with `'…' + '…'` (AnalyzeScreen.tsx:594-599,
// strokeResultModel.ts:348, offlineCapabilities.ts:176); a forbidden phrase
// that straddles the wrap point is invisible to a per-literal scan.
// ---------------------------------------------------------------------------

describe('H06 attack — copy assembled from concatenated literals', () => {
  it('flags "Google Play" split across a `+` concatenation', () => {
    const source = `${HEADER}export function Fixture() {\n  return <Text>{'Manage your subscription in Google ' + 'Play settings.'}</Text>;\n}\n`;
    expectFlagged(scanMobileSource(source), 'Google');
  });

  it('flags "the most precise read" split across a `+` concatenation', () => {
    const source = `${HEADER}export const detail =\n  'Re-record with your full body in frame, or declare the technique for the most ' +\n  'precise read.';\n`;
    expectFlagged(scanMobileSource(source), 'precise read.');
  });

  it('flags "Live Court" split across an array join', () => {
    const source = `${HEADER}export const detail = ['Live', 'Court sessions coach you in real time.'].join(' ');\n`;
    expectFlagged(scanMobileSource(source), 'Court sessions');
  });
});

// ---------------------------------------------------------------------------
// Attack 2 — JSX entity encoding. Babel/React decode `&nbsp;` and numeric
// entities in JSX text before rendering, so the user reads "Google Play".
// ---------------------------------------------------------------------------

describe('H06 attack — HTML entities in JSX text', () => {
  it('flags "Google&nbsp;Play"', () => {
    expectFlagged(
      scanMobileSource(jsxText('Also available on Google&nbsp;Play.')),
      'Google',
    );
  });

  it('flags "Live&#32;Court"', () => {
    expectFlagged(
      scanMobileSource(jsxText('Live&#32;Court sessions coach you.')),
      'Court sessions',
    );
  });
});

// ---------------------------------------------------------------------------
// Attack 3 — invisible Unicode inside a forbidden term (soft hyphen U+00AD,
// zero-width space U+200B). The glyphs render as "Google Play" / "Android".
// ---------------------------------------------------------------------------

describe('H06 attack — invisible code points inside a forbidden term', () => {
  it('flags "Goo\\u00ADgle Play" (soft hyphen)', () => {
    expectFlagged(
      scanMobileSource(jsxLiteral('Manage it in Goo\u00ADgle Play today.')),
      'gle Play',
    );
  });

  it('flags "An\\u200Bdroid" (zero-width space)', () => {
    expectFlagged(
      scanMobileSource(jsxLiteral('Also available on An\u200Bdroid phones.')),
      'droid phones',
    );
  });
});

// ---------------------------------------------------------------------------
// Attack 4 — single-word label maps. `PROVIDER_LABELS = { guest: 'Guest' }`
// (ManageAccountScreen.tsx:58) is the existing pattern: the value is rendered
// but neither multi-word nor under a copy-named binding.
// ---------------------------------------------------------------------------

describe('H06 attack — single-word copy outside a copy-named binding', () => {
  it('flags "Android" in a label map keyed by platform', () => {
    const source = `${HEADER}export const STORE_LABELS = {\n  ios: 'App Store',\n  android: 'Android',\n};\n`;
    expectFlagged(scanMobileSource(source), 'Android');
  });

  it('flags "DUPR" as a rendered enum value', () => {
    const source = `${HEADER}const RATING_SYSTEM: Record<string, string> = {\n  external: 'DUPR',\n};\nexport function Fixture() {\n  return <Text>{RATING_SYSTEM.external}</Text>;\n}\n`;
    expectFlagged(scanMobileSource(source), 'DUPR');
  });

  it('flags "Android" interpolated from a non-copy-named const', () => {
    const source = `${HEADER}const platform = 'Android';\nexport function Fixture() {\n  return <Text>{\`Also available on \${platform}.\`}</Text>;\n}\n`;
    expectFlagged(scanMobileSource(source), 'Android');
  });
});

// ---------------------------------------------------------------------------
// Attack 5 — vocabulary gaps in the rule set. Each phrase is a forbidden
// claim under APP_STORE_SUBMISSION.md §1 rules 4-5 expressed in a common
// alternative form.
// ---------------------------------------------------------------------------

describe('H06 attack — forbidden-claim phrasings the rules do not cover', () => {
  it.each([
    ['ai-coach-equivalence', 'Your personal AI-coach, always in your pocket.'],
    ['ai-coach-equivalence', 'AI coaching that replaces lessons.'],
    ['ai-coach-equivalence', 'Like having a coach in your pocket.'],
    ['ai-coach-equivalence', 'No need for a coach — Pickle Sensei does it.'],
    ['superlative', 'The ultimate pickleball coaching app.'],
    ['superlative', 'The most effective way to fix your dink.'],
    ['superlative', 'The very best pickleball coach on iPhone.'],
    ['superlative', 'BEST-VALUE'],
    ['superlative', 'Best pickleball coaching app.'],
    ['accuracy-percentage', 'Scores land with 95% precision.'],
    ['accuracy-percentage', 'Accuracy of 95 pct on every stroke.'],
    ['accuracy-percentage', 'Accurate 9 times out of 10.'],
    ['live-court', 'Live Courts coach you in real time.'],
    ['competitor', 'Better than PB-Vision.'],
    ['google-play', 'Also on GooglePlay.'],
    ['guest-mode', 'Ratings you take as a guest stay on this phone.'],
  ])('rule %s should flag "%s"', (_rule, copy) => {
    expectFlagged(scanMobileSource(jsxText(copy)), copy);
  });
});

// ---------------------------------------------------------------------------
// Attack 6 — copy in files the walker skips. `sourceFiles()` accepts only
// `.ts`/`.tsx`; a `.jsx`/`.js` module under `src/` renders copy unscanned.
// ---------------------------------------------------------------------------

describe('H06 attack — user-facing copy in files the walker ignores', () => {
  it('flags "Google Play" in src/Fixture.jsx', () => {
    expectFlagged(
      scanMobileFile(
        'Fixture.jsx',
        jsxText('Manage subscription in Google Play'),
      ),
      'Google Play',
    );
  });

  it('flags "Google Play" in src/copy.js', () => {
    expectFlagged(
      scanMobileFile(
        'copy.js',
        "export const detail = 'Manage subscription in Google Play';\n",
      ),
      'Google Play',
    );
  });
});

// ---------------------------------------------------------------------------
// Attack 7 — dossier store copy that the extractor does not reach.
// ---------------------------------------------------------------------------

describe('H06 attack — App Store dossier store copy outside the extractor', () => {
  it('flags an ENTER value that is not backticked', () => {
    const result = scanDossier(dossier =>
      dossier.replace(
        '| Subtitle (30 max)   | `ENTER:` `Pickleball technique coach`',
        '| Subtitle (30 max)   | `ENTER:` Pickleball coach for Android',
      ),
    );
    expectFlagged(result, 'Pickleball coach for Android');
  });

  it('flags a fenced ENTER block whose prompt is followed by a note line', () => {
    const result = scanDossier(dossier =>
      dossier.replace(
        '### 11.3 Keywords (100 max, comma-separated, no spaces)',
        [
          "### 11.2b What's New (4000 max)",
          '',
          '`ENTER:` (release notes)',
          'Paste exactly:',
          '',
          '```',
          'Now on Android too — the same coach on every phone.',
          '```',
          '',
          '### 11.3 Keywords (100 max, comma-separated, no spaces)',
        ].join('\n'),
      ),
    );
    expectFlagged(result, 'Now on Android too');
  });

  it('flags an indented fenced ENTER block (list item)', () => {
    const result = scanDossier(dossier =>
      dossier.replace(
        '### 11.3 Keywords (100 max, comma-separated, no spaces)',
        [
          "### 11.2b What's New (4000 max)",
          '',
          '- `ENTER:`',
          '',
          '  ```',
          '  Now on Android too — the same coach on every phone.',
          '  ```',
          '',
          '### 11.3 Keywords (100 max, comma-separated, no spaces)',
        ].join('\n'),
      ),
    );
    expectFlagged(result, 'Now on Android too');
  });
});
