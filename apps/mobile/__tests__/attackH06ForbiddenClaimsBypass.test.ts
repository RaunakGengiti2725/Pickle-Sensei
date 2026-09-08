/**
 * H06-01 adversarial tests — does the forbidden-claims scan in
 * `__tests__/h06ForbiddenClaims.test.ts` actually catch forbidden copy at
 * its failure boundaries?
 *
 * Each attack injects copy that a reader would see (rendered JSX, label
 * maps, catalog rows, dossier `ENTER:` values, Info.plist strings, Swift
 * literals, bundled JSON) into a throwaway git worktree of the candidate
 * commit, runs the candidate's own scan there unmodified, and asserts that
 * every injected phrase is reported at its file and line. A phrase the scan
 * does not report is a bypass. Every attack also injects one control phrase
 * the scan is known to catch, so a silent harness failure cannot pass as a
 * clean scan.
 *
 * The candidate scanner and production sources are never edited in this
 * checkout: all fixtures live in the worktree and are restored after each
 * attack.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MOBILE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(MOBILE_ROOT, '..', '..');
const SCAN_TEST = path.join('__tests__', 'h06ForbiddenClaims.test.ts');
const SCAN_CASE = 'contains none of the forbidden terms';
/** One full jest run of the candidate scan per attack (≈3–5 s each). */
const SCAN_TIMEOUT_MS = 120_000;

type Violation = { source: string; line: number; rule: string; text: string };
type Fixture = Record<string, string>;

let worktree = '';

function git(...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

beforeAll(() => {
  worktree = mkdtempSync(path.join(tmpdir(), 'h06-attack-'));
  rmSync(worktree, { recursive: true, force: true });
  git('worktree', 'add', '--detach', worktree, git('rev-parse', 'HEAD'));
  symlinkSync(
    path.join(MOBILE_ROOT, 'node_modules'),
    path.join(worktree, 'apps', 'mobile', 'node_modules'),
  );
  const rootModules = path.join(REPO_ROOT, 'node_modules');
  if (existsSync(rootModules)) {
    symlinkSync(rootModules, path.join(worktree, 'node_modules'));
  }
});

afterAll(() => {
  if (!worktree) return;
  spawnSync('git', ['worktree', 'remove', '--force', worktree], {
    cwd: REPO_ROOT,
  });
  rmSync(worktree, { recursive: true, force: true });
});

/** Lines of the scan's failure diff: `source:line [rule] text`. */
function parseViolations(output: string): Violation[] {
  const violations: Violation[] = [];
  const line =
    /^\s*(?:Received: ")?((?:\.\.\/|src\/|ios\/|App\.tsx)[^\s:]*):(\d+) \[([a-z-]+)\] (.*?)"?$/;
  for (const raw of output.split('\n')) {
    const match = line.exec(raw);
    if (!match) continue;
    violations.push({
      source: match[1] ?? '',
      line: Number(match[2]),
      rule: match[3] ?? '',
      text: match[4] ?? '',
    });
  }
  return violations;
}

/** Writes the fixtures (relative to the repo root) into the worktree, runs
 * the candidate scan there, restores the tree and returns what was
 * reported. */
function runScanWith(fixtures: Fixture): Violation[] {
  const originals = new Map<string, string | null>();
  for (const [relative, content] of Object.entries(fixtures)) {
    const file = path.join(worktree, relative);
    originals.set(file, existsSync(file) ? readFileSync(file, 'utf8') : null);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(MOBILE_ROOT, 'node_modules', 'jest', 'bin', 'jest.js'),
        '--ci',
        '--silent',
        SCAN_TEST,
        '-t',
        SCAN_CASE,
      ],
      {
        cwd: path.join(worktree, 'apps', 'mobile'),
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return parseViolations(`${result.stdout}\n${result.stderr}`);
  } finally {
    for (const [file, original] of originals) {
      if (original === null) unlinkSync(file);
      else writeFileSync(file, original);
    }
  }
}

/** 1-based line of the first fixture line containing `phrase`. */
function lineOf(content: string, phrase: string): number {
  const index = content.split('\n').findIndex(line => line.includes(phrase));
  if (index < 0) throw new Error(`fixture does not contain ${phrase}`);
  return index + 1;
}

function reportedAt(
  violations: Violation[],
  source: string,
  line: number,
): Violation[] {
  return violations.filter(
    entry => entry.source === source && entry.line === line,
  );
}

/** Appends a `<key>/<string>` block to the app target's Info.plist. */
function plistWith(extraEntries: string): string {
  const plist = readFileSync(
    path.join(MOBILE_ROOT, 'ios', 'PickleSensei', 'Info.plist'),
    'utf8',
  );
  return plist.replace('<dict>\n', `<dict>\n${extraEntries}`);
}

const PROBE = 'apps/mobile/src/__h06attack__/Probe.tsx';
const PROBE_SOURCE = 'src/__h06attack__/Probe.tsx';
const DOSSIER = 'docs/APP_STORE_SUBMISSION.md';
const DOSSIER_SOURCE = '../../docs/APP_STORE_SUBMISSION.md';
const PLIST_SOURCE = 'ios/PickleSensei/Info.plist';
const SWIFT = 'native/vision-core/Sources/H06AttackProbe.swift';
const SWIFT_SOURCE = '../../native/vision-core/Sources/H06AttackProbe.swift';
const CATALOG = 'supabase/functions/api/drillMedia.ts';
const CATALOG_SOURCE = '../../supabase/functions/api/drillMedia.ts';

function jsxScreen(lines: string[]): string {
  return [
    "import React from 'react';",
    "import { Text } from 'react-native';",
    '',
    'export function Probe(): React.JSX.Element {',
    '  return (',
    '    <>',
    ...lines.map(line => `      <Text>${line}</Text>`),
    '    </>',
    '  );',
    '}',
    '',
  ].join('\n');
}

function expectEachReported(
  violations: () => Violation[],
  fixture: string,
  source: string,
  phrases: string[],
): void {
  for (const phrase of phrases) {
    it(`reports "${phrase}"`, () => {
      const line = lineOf(fixture, phrase);
      expect(reportedAt(violations(), source, line)).not.toEqual([]);
    });
  }
}

// ---------------------------------------------------------------------------
// Attack 1 — the personal-best allow-list is applied to product claims
// ---------------------------------------------------------------------------

describe('attack 1: "best" superlatives that read as product claims', () => {
  const claims = [
    'Best app today',
    'Our best analyzer yet',
    'The best coach so far',
    'A new best-in-class swing analyzer',
  ];
  const control = 'The best pickleball coach';
  const fixture = jsxScreen([...claims, control]);
  let violations: Violation[] = [];

  beforeAll(() => {
    violations = runScanWith({ [PROBE]: fixture });
  }, SCAN_TIMEOUT_MS);

  it('control: reports the plain superlative', () => {
    expect(
      reportedAt(violations, PROBE_SOURCE, lineOf(fixture, control)).map(
        entry => entry.rule,
      ),
    ).toEqual(['superlative']);
  });

  it('exercises phrases that are superlatives about the product, not the player', () => {
    for (const claim of claims) {
      expect(claim).toMatch(/\bbest\b/i);
      expect(claim).not.toMatch(/\b(?:your|my|personal) best\b/i);
    }
  });

  describe('each product superlative is reported', () => {
    expectEachReported(() => violations, fixture, PROBE_SOURCE, claims);
  });
});

// ---------------------------------------------------------------------------
// Attack 2 — accuracy percentages phrased as "right N% of the time"
// ---------------------------------------------------------------------------

describe('attack 2: accuracy percentages phrased as correctness', () => {
  const claims = [
    'Gets your form right 95% of the time',
    'Spot-on 98% of the time',
    'Nails it 99% of the time',
    'Right 9 times out of 10 swings',
  ];
  const control = 'Accurate 95% of the time';
  const fixture = jsxScreen([...claims, control]);
  let violations: Violation[] = [];

  beforeAll(() => {
    violations = runScanWith({ [PROBE]: fixture });
  }, SCAN_TIMEOUT_MS);

  it('control: reports the accuracy percentage', () => {
    expect(
      reportedAt(violations, PROBE_SOURCE, lineOf(fixture, control)).map(
        entry => entry.rule,
      ),
    ).toEqual(['accuracy-percentage']);
  });

  describe('each correctness percentage is reported', () => {
    expectEachReported(() => violations, fixture, PROBE_SOURCE, claims);
  });
});

// ---------------------------------------------------------------------------
// Attack 3 — lowercase single-word labels rendered through a lookup table
// ---------------------------------------------------------------------------

describe('attack 3: lowercase label values behind dynamic lookups', () => {
  const fixture = [
    "import React from 'react';",
    "import { Alert, Text } from 'react-native';",
    '',
    "type Provider = 'apple' | 'google' | 'guest';",
    "type Plan = 'monthly' | 'yearly';",
    '',
    'const PROVIDER_LABELS: Record<Provider, string> = {',
    "  apple: 'Apple',",
    "  google: 'Google',",
    "  guest: 'guest',",
    '};',
    "const CONTROL_LABELS: Record<Provider, string> = { apple: 'Apple', google: 'Google', guest: 'Guest' };",
    'const PLAN_BADGES: Record<Plan, string> = {',
    "  monthly: 'popular',",
    "  yearly: 'best',",
    '};',
    '',
    'export function Probe(props: { provider: Provider; plan: Plan }): React.JSX.Element {',
    '  return (',
    '    <>',
    '      <Text>{PROVIDER_LABELS[props.provider]}</Text>',
    '      <Text>{CONTROL_LABELS[props.provider]}</Text>',
    '      <Text>{PLAN_BADGES[props.plan]}</Text>',
    '    </>',
    '  );',
    '}',
    '',
    'export function warnUnsupported(): void {',
    "  Alert.alert('android', 'This build runs on iPhone only.');",
    '}',
    '',
  ].join('\n');
  const catalog = readFileSync(path.join(REPO_ROOT, CATALOG), 'utf8').replace(
    /creatorName: "[^"]+",/,
    'creatorName: "selkirk",',
  );
  let violations: Violation[] = [];

  beforeAll(() => {
    violations = runScanWith({ [PROBE]: fixture, [CATALOG]: catalog });
  }, SCAN_TIMEOUT_MS);

  it('control: reports the capitalised "Guest" label in the same lookup shape', () => {
    expect(
      reportedAt(
        violations,
        PROBE_SOURCE,
        lineOf(fixture, "guest: 'Guest'"),
      ).map(entry => entry.rule),
    ).toEqual(['guest-mode']);
  });

  it('the catalog fixture still renames exactly one verified creator', () => {
    expect(catalog).toContain('creatorName: "selkirk",');
    expect(catalog.match(/creatorName: "selkirk",/g)).toHaveLength(1);
  });

  it('reports the lowercase "guest" provider label', () => {
    expect(
      reportedAt(violations, PROBE_SOURCE, lineOf(fixture, "guest: 'guest'")),
    ).not.toEqual([]);
  });

  it('reports the lowercase "best" plan badge', () => {
    expect(
      reportedAt(violations, PROBE_SOURCE, lineOf(fixture, "yearly: 'best'")),
    ).not.toEqual([]);
  });

  it('reports the lowercase "android" alert title', () => {
    expect(
      reportedAt(
        violations,
        PROBE_SOURCE,
        lineOf(fixture, "Alert.alert('android'"),
      ),
    ).not.toEqual([]);
  });

  it('reports a lowercase competitor creator name in the drill catalog', () => {
    expect(
      reportedAt(
        violations,
        CATALOG_SOURCE,
        lineOf(catalog, 'creatorName: "selkirk",'),
      ),
    ).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Attack 4 — homoglyphs that survive NFKC
// ---------------------------------------------------------------------------

describe('attack 4: Cyrillic homoglyphs in forbidden terms', () => {
  const claims = [
    '\u0410ndroid users: coming soon',
    'Also on G\u043E\u043Egle Play',
    'Live C\u043Eurt mode',
    'Compare with your DU\u0420R rating',
  ];
  const control = 'Google\u200BPlay';
  const fixture = jsxScreen([...claims, control]);
  let violations: Violation[] = [];

  beforeAll(() => {
    violations = runScanWith({ [PROBE]: fixture });
  }, SCAN_TIMEOUT_MS);

  it('control: reports the zero-width-space split', () => {
    expect(
      reportedAt(violations, PROBE_SOURCE, lineOf(fixture, control)).map(
        entry => entry.rule,
      ),
    ).toEqual(['google-play']);
  });

  it('the homoglyph claims read as the forbidden terms once confusables are folded', () => {
    const folded = (text: string): string =>
      text
        .replace(/\u0410/g, 'A')
        .replace(/\u043E/g, 'o')
        .replace(/\u0420/g, 'P');
    expect(claims.map(folded)).toEqual([
      'Android users: coming soon',
      'Also on Google Play',
      'Live Court mode',
      'Compare with your DUPR rating',
    ]);
  });

  describe('each homoglyph phrase is reported', () => {
    expectEachReported(() => violations, fixture, PROBE_SOURCE, claims);
  });
});

// ---------------------------------------------------------------------------
// Attack 5 — phrases assembled outside the recognised concatenation shapes
// ---------------------------------------------------------------------------

describe('attack 5: copy assembled by concat/+= and Swift concatenation', () => {
  const fixture = [
    "import React from 'react';",
    "import { Text } from 'react-native';",
    '',
    'export function Probe(): React.JSX.Element {',
    "  let store = 'Google ';",
    "  store += 'Play';",
    "  const court = 'Live '.concat('Court');",
    "  const control = 'Google ' + 'Play';",
    '  return (',
    '    <>',
    '      <Text>{store}</Text>',
    '      <Text>{court}</Text>',
    '      <Text>{control}</Text>',
    '    </>',
    '  );',
    '}',
    '',
  ].join('\n');
  const swift = [
    'import Foundation',
    '',
    'enum H06AttackProbe {',
    '  static let store = "Google " + "Play"',
    '  static let brand = "Google"',
    '  static let tagline = "\\(brand) Play exclusive"',
    '  static let control = "Google Play exclusive"',
    '}',
    '',
  ].join('\n');
  let violations: Violation[] = [];

  beforeAll(() => {
    violations = runScanWith({ [PROBE]: fixture, [SWIFT]: swift });
  }, SCAN_TIMEOUT_MS);

  it('control: reports the `+` concatenation and the plain Swift literal', () => {
    expect(
      reportedAt(
        violations,
        PROBE_SOURCE,
        lineOf(fixture, "'Google ' + 'Play'"),
      ).map(entry => entry.rule),
    ).toEqual(['google-play']);
    expect(
      reportedAt(
        violations,
        SWIFT_SOURCE,
        lineOf(swift, 'static let control'),
      ).map(entry => entry.rule),
    ).toEqual(['google-play']);
  });

  it('reports the `+=` assembled "Google Play"', () => {
    expect(
      reportedAt(violations, PROBE_SOURCE, lineOf(fixture, "store += 'Play'")),
    ).not.toEqual([]);
  });

  it('reports the `.concat()` assembled "Live Court"', () => {
    expect(
      reportedAt(violations, PROBE_SOURCE, lineOf(fixture, ".concat('Court')")),
    ).not.toEqual([]);
  });

  it('reports the Swift `+` assembled "Google Play"', () => {
    expect(
      reportedAt(violations, SWIFT_SOURCE, lineOf(swift, '"Google " + "Play"')),
    ).not.toEqual([]);
  });

  it('reports the Swift interpolated "Google Play"', () => {
    expect(
      reportedAt(violations, SWIFT_SOURCE, lineOf(swift, 'static let tagline')),
    ).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Attack 6 — copy the bundle ships that is not in a .ts/.tsx/.swift file
// ---------------------------------------------------------------------------

describe('attack 6: bundled JSON copy and Info.plist strings outside the scanned keys', () => {
  const json = '{ "badge": "Live Court", "tagline": "Also on Google Play" }\n';
  const jsonRelative = 'apps/mobile/src/__h06attack__/copy.json';
  const fixture = [
    "import React from 'react';",
    "import { Text } from 'react-native';",
    "import copy from './copy.json';",
    '',
    'export function Probe(): React.JSX.Element {',
    '  return (',
    '    <>',
    '      <Text>{copy.badge}</Text>',
    '      <Text>{copy.tagline}</Text>',
    '    </>',
    '  );',
    '}',
    '',
  ].join('\n');
  const plistEntries = [
    '\t<key>UIApplicationShortcutItems</key>',
    '\t<array>',
    '\t\t<dict>',
    '\t\t\t<key>UIApplicationShortcutItemTitle</key>',
    '\t\t\t<string>Live Court</string>',
    '\t\t\t<key>UIApplicationShortcutItemType</key>',
    '\t\t\t<string>com.picklesensei.livecourt</string>',
    '\t\t</dict>',
    '\t</array>',
    '\t<key>NSLocationWhenInUseUsageDescription</key>',
    '\t<!-- shown on the first location prompt -->',
    '\t<string>Find Live Court games near you</string>',
    '\t<key>NSMotionUsageDescription</key>',
    '\t<string>Control: Live Court motion tracking</string>',
    '',
  ].join('\n');
  const plist = plistWith(plistEntries);
  let violations: Violation[] = [];

  beforeAll(() => {
    violations = runScanWith({
      [PROBE]: fixture,
      [jsonRelative]: json,
      'apps/mobile/ios/PickleSensei/Info.plist': plist,
    });
  }, SCAN_TIMEOUT_MS);

  /** The scan reports a plist entry at its `<key>` line; accept the key
   * line through the `<string>` line. */
  const plistReport = (key: string, value: string): Violation[] => {
    const first = lineOf(plist, `<key>${key}</key>`);
    const last = lineOf(plist, value);
    return violations.filter(
      entry =>
        entry.source === PLIST_SOURCE &&
        entry.line >= first &&
        entry.line <= last,
    );
  };

  it('control: reports the plain usage description', () => {
    expect(
      plistReport(
        'NSMotionUsageDescription',
        'Control: Live Court motion tracking',
      ).map(entry => entry.rule),
    ).toEqual(['live-court']);
  });

  it('reports "Live Court" from the imported JSON copy table', () => {
    expect(
      violations.filter(
        entry =>
          entry.source.startsWith('src/__h06attack__/') &&
          /live court/i.test(entry.text),
      ),
    ).not.toEqual([]);
  });

  it('reports "Google Play" from the imported JSON copy table', () => {
    expect(
      violations.filter(
        entry =>
          entry.source.startsWith('src/__h06attack__/') &&
          /google play/i.test(entry.text),
      ),
    ).not.toEqual([]);
  });

  it('reports the home-screen quick action title', () => {
    expect(
      plistReport(
        'UIApplicationShortcutItemTitle',
        '<string>Live Court</string>',
      ),
    ).not.toEqual([]);
  });

  it('reports a usage description separated from its key by an XML comment', () => {
    expect(
      plistReport(
        'NSLocationWhenInUseUsageDescription',
        'Find Live Court games near you',
      ),
    ).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Attack 7 — dossier `ENTER:` values that continue past the marker line
// ---------------------------------------------------------------------------

describe('attack 7: App Store dossier values outside the marker line', () => {
  const appended = [
    '',
    '### 11.9 Attack probe',
    '',
    '- Promotional text (alt) — `ENTER:`',
    '  Film a stroke. Get the fix. Now with Live Court.',
    '- Review notes (alt): `ENTER:` `Also available on Android` and then',
    '  the DUPR-style estimate is disclaimed.',
    '',
    '| Field            | Value                                            |',
    '| ---------------- | ------------------------------------------------ |',
    '| Subtitle (alt 3) | `ENTER:` Best pickleball coach \\| Android tagline |',
    '',
  ].join('\n');
  const original = readFileSync(path.join(REPO_ROOT, DOSSIER), 'utf8');
  const dossier = `${original}${appended}`;
  let violations: Violation[] = [];

  beforeAll(() => {
    violations = runScanWith({ [DOSSIER]: dossier });
  }, SCAN_TIMEOUT_MS);

  it('control: reports the backticked ENTER value on the marker line', () => {
    expect(
      reportedAt(
        violations,
        DOSSIER_SOURCE,
        lineOf(dossier, '`Also available on Android`'),
      ).map(entry => entry.rule),
    ).toEqual(['android']);
  });

  it('reports the ENTER value written on the line after the marker', () => {
    expect(
      reportedAt(
        violations,
        DOSSIER_SOURCE,
        lineOf(dossier, 'Now with Live Court.'),
      ),
    ).not.toEqual([]);
  });

  it('reports the continuation line of a wrapped ENTER item', () => {
    expect(
      reportedAt(
        violations,
        DOSSIER_SOURCE,
        lineOf(dossier, 'the DUPR-style estimate is disclaimed.'),
      ),
    ).not.toEqual([]);
  });

  it('reports the whole cell when the ENTER value contains an escaped pipe', () => {
    const line = lineOf(dossier, 'Android tagline');
    expect(
      reportedAt(violations, DOSSIER_SOURCE, line).map(entry => entry.rule),
    ).toContain('android');
  });
});

// ---------------------------------------------------------------------------
// Attack 8 — superlative / equivalence / guest-entry phrasing outside the
// enumerated vocabulary
// ---------------------------------------------------------------------------

describe('attack 8: forbidden claims phrased outside the rule vocabulary', () => {
  const superlatives = [
    'The top pickleball coaching app',
    'Top-tier analysis',
    'Unbeaten pickleball analysis',
    'Outperforms every other pickleball app',
    'Professional-grade analysis',
    'Elite accuracy',
    'Pinpoint accuracy on every swing',
    'Never misses a swing',
  ];
  const equivalence = [
    'Smarter than any coach',
    'Beats a real coach',
    'An artificial intelligence coach in your phone',
  ];
  const guestEntry = ['Continue as a visitor', 'Try it first, sign in later'];
  const control = 'Better than a coach';
  const fixture = jsxScreen([
    ...superlatives,
    ...equivalence,
    ...guestEntry,
    control,
  ]);
  let violations: Violation[] = [];

  beforeAll(() => {
    violations = runScanWith({ [PROBE]: fixture });
  }, SCAN_TIMEOUT_MS);

  it('control: reports the enumerated coach comparison', () => {
    expect(
      reportedAt(violations, PROBE_SOURCE, lineOf(fixture, control)).map(
        entry => entry.rule,
      ),
    ).toEqual(['ai-coach-equivalence']);
  });

  describe('superlatives', () => {
    expectEachReported(() => violations, fixture, PROBE_SOURCE, superlatives);
  });

  describe('coach-equivalence claims', () => {
    expectEachReported(() => violations, fixture, PROBE_SOURCE, equivalence);
  });

  describe('guest-entry copy', () => {
    expectEachReported(() => violations, fixture, PROBE_SOURCE, guestEntry);
  });
});
