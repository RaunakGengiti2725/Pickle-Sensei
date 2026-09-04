/**
 * Release copy policy scan — regression pin.
 *
 * Runs the AST-based copy-policy harness (scripts/copyPolicy) over every
 * user-visible copy surface of the shipping iOS product — apps/mobile/src,
 * supabase/functions/api/legal.ts (/privacy, /terms, /support), the drill
 * catalogue, Info.plist usage strings and app.json — and pins:
 *
 *   1. the extractor never misses a raw-text strict forbidden term
 *      (coverage gaps == 0), so "no hits" always means "scanned";
 *   2. the visibility classifier keeps JSX text / copy props / alerts /
 *      legal constants as user-visible and comments / identifiers / SQL /
 *      platform keys as non-visible;
 *   3. the strict rules match the dossier's forbidden terms and claims, and
 *      leave the approved "validated / server-accepted / estimate" wording
 *      alone;
 *   4. the set of user-visible STRICT hits equals the known-violations
 *      ledger below — any NEW forbidden term / claim in user-visible copy
 *      fails this test, and any ledger entry that has been fixed must be
 *      removed from the ledger (the test fails on stale entries too, so the
 *      ledger cannot silently grandfather copy that no longer exists).
 *
 * Policy sources: docs/APP_STORE_SUBMISSION.md §1 rules 4–5, REVIEW.md,
 * docs/CLAIM_REVIEW.md. Full report: `node apps/mobile/scripts/copyPolicy/cli.mjs --out <dir>`.
 */
import { extractStrings } from '../scripts/copyPolicy/extract';
import {
  APPROVED_LANGUAGE,
  COPY_RULES,
  STRICT_RULE_IDS,
  rulesById,
} from '../scripts/copyPolicy/policy';
import {
  coverageGaps,
  defaultSurfaces,
  exitCodeFor,
  hitKey,
  matchRules,
  runScan,
  type Hit,
  type ScanHost,
  type ScanReport,
} from '../scripts/copyPolicy/scan';

// Node built-ins, typed the same way the other node-side suites do it
// (apps/mobile/tsconfig.json has no @types/node).
declare const require: (id: string) => unknown;
declare const __dirname: string;

const fs = require('fs') as Omit<ScanHost, 'path'>;
const path = require('path') as ScanHost['path'] & {
  resolve(...parts: string[]): string;
};
const HOST: ScanHost = { ...fs, path };

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Known user-visible strict violations at 4d812e1a (release-copy-policy-scan
 * audit, 2026-09-04). Key = file | rule | slot | matched (lower-case);
 * line numbers are deliberately not part of the key so unrelated edits do
 * not churn this list. Remove an entry when the copy is fixed.
 */
const KNOWN_VISIBLE_STRICT_HITS: ReadonlyArray<{
  key: string;
  note: string;
}> = [
  {
    key: 'apps/mobile/src/components/PlayerRankCard.tsx|dupr|jsx_prop_copy|dupr',
    note: 'accessibilityLabel "estimated DUPR …" read by VoiceOver on the Player Rank card',
  },
  {
    key: 'apps/mobile/src/progress/duprEstimate.ts|dupr|copy_function_return|dupr',
    note: 'formatDuprEstimate() → "(≈ DUPR x.x)" rendered on Home, Result, Progress, PlayerRankCard',
  },
  {
    key: 'apps/mobile/src/progress/duprEstimate.ts|dupr|copy_constant|dupr',
    note: 'DUPR_ESTIMATE_NOTE disclaimer rendered on Result, Settings, PlayerRankCard',
  },
  {
    key: 'apps/mobile/src/screens/AnalyzeScreen.tsx|superlative|object_value_copy|most precise',
    note: '"declare the technique for the most precise read" (family-only capture guidance body)',
  },
  {
    key: 'apps/mobile/src/screens/ManageAccountScreen.tsx|google_play|object_value_copy|google play',
    note: 'SUBSCRIPTION_MANAGEMENT Android branch — storeName + accessibilityLabel (Platform.OS === "android" only; two literals share this key)',
  },
  {
    key: 'apps/mobile/src/screens/ProgressScreen.tsx|dupr|jsx_text|dupr',
    note: '"not a DUPR or verified match rating" rating disclosure',
  },
  {
    key: 'apps/mobile/src/screens/SettingsScreen.tsx|dupr|jsx_text|dupr',
    note: '"not a verified DUPR or player rating" rating note',
  },
  {
    key: 'supabase/functions/api/legal.ts|google_play|copy_constant|google play',
    note: 'PRIVACY_POLICY_TEXT (×2) + TERMS_TEXT (×1): "Apple\'s App Store or Google Play" purchase/subscription wording served at /privacy and /terms',
  },
  {
    key: 'supabase/functions/api/legal.ts|dupr|copy_constant|dupr',
    note: 'TERMS_TEXT score disclaimer names DUPR',
  },
];

let report: ScanReport;

beforeAll(() => {
  report = runScan(HOST, REPO_ROOT);
});

function visibleStrict(r: ScanReport): Hit[] {
  return r.hits.filter(h => h.userVisible && h.confidence === 'strict');
}

describe('release copy policy scan — surfaces and extractor completeness', () => {
  it('scans every declared surface and extracts strings from each', () => {
    const names = report.surfaces.map(s => s.surface).sort();
    expect(names).toEqual(
      [
        'edge_drills',
        'edge_legal',
        'ios_info_plist',
        'mobile_app_json',
        'mobile_src',
      ].sort(),
    );
    for (const s of report.surfaces) {
      expect(s.files).toBeGreaterThan(0);
      expect(s.strings).toBeGreaterThan(0);
    }
    const legal = report.surfaces.find(s => s.surface === 'edge_legal');
    // /privacy, /terms and /support are served verbatim: every literal in
    // legal.ts is public copy, so nothing there may be classified as code.
    expect(legal?.byVisibility.code).toBe(0);
    expect(legal?.byVisibility.likely).toBe(0);
    expect(legal?.byVisibility.visible).toBeGreaterThan(0);
    const plist = report.surfaces.find(s => s.surface === 'ios_info_plist');
    // Camera, microphone, photo-library (add + read) usage descriptions.
    expect(plist?.byVisibility.visible).toBeGreaterThanOrEqual(3);
    expect(report.totals.files).toBeGreaterThanOrEqual(100);
    expect(report.totals.strings).toBeGreaterThan(5000);
  });

  it('every strict forbidden-term match in the raw sources is attributable to an extracted string, comment or identifier', () => {
    expect(report.coverageGaps).toEqual([]);
  });

  it('exit code reflects the report (3 = coverage gap, 2 = visible strict hit, 0 = clean)', () => {
    const clean: ScanReport = {
      ...report,
      coverageGaps: [],
      totals: { ...report.totals, userVisibleStrictHits: 0 },
    };
    expect(exitCodeFor(clean)).toBe(0);
    expect(
      exitCodeFor({
        ...clean,
        totals: { ...clean.totals, userVisibleStrictHits: 1 },
      }),
    ).toBe(2);
    expect(
      exitCodeFor({
        ...clean,
        coverageGaps: [
          { file: 'x.ts', line: 1, rule: 'dupr', matched: 'DUPR', context: '' },
        ],
      }),
    ).toBe(3);
  });

  it('coverageGaps() flags a forbidden term the extractor did not attribute', () => {
    const src = `const a = 'DUPR';\n`;
    const strings = extractStrings('fixture.ts', src);
    expect(coverageGaps('fixture.ts', src, strings)).toEqual([]);
    // Same source, but pretend extraction returned nothing → gap reported.
    const gaps = coverageGaps('fixture.ts', src, []);
    expect(gaps.map(g => g.rule)).toEqual(['dupr']);
    expect(gaps[0]?.line).toBe(1);
  });
});

describe('release copy policy scan — visibility classifier', () => {
  const FIXTURE = `
import { Alert, Platform, Text } from 'react-native';
// comment mentions Android and DUPR
/** block comment: Google Play */
const testId = 'guest-mode-row';
const sql = 'SELECT owner_key FROM shots WHERE provider = ?';
const label = 'Manage subscription in Google Play';
const store = Platform.OS === 'android' ? 'Google Play' : 'App Store';
export function Row() {
  Alert.alert('Heads up', 'Live Court is coming');
  return (
    <>
      <Text testID="dupr-estimate" accessibilityLabel="estimated DUPR 4.2">
        Technique Score is not a DUPR rating
      </Text>
      <Text>{\`Streak \${1} · DUPR\`}</Text>
    </>
  );
}
`;
  const strings = extractStrings('fixture.tsx', FIXTURE);
  const find = (needle: string) => strings.filter(s => s.text.includes(needle));

  it('JSX text, copy-like props, alert arguments, copy constants and template pieces are user-visible', () => {
    expect(find('not a DUPR rating')[0]?.visibility).toBe('visible');
    expect(find('estimated DUPR 4.2')[0]?.visibility).toBe('visible');
    expect(find('Live Court is coming')[0]?.visibility).toBe('visible');
    expect(find('Manage subscription in Google Play')[0]?.visibility).toBe(
      'visible',
    );
    expect(find('Streak ')[0]?.visibility).toBe('visible');
    expect(
      strings.filter(
        s => s.raw.includes('Google Play') && s.slotName === 'store',
      ),
    ).toHaveLength(1);
  });

  it('comments, testIDs, SQL and platform keys are not user-visible', () => {
    expect(find('comment mentions Android')[0]?.visibility).toBe('comment');
    expect(find('block comment: Google Play')[0]?.visibility).toBe('comment');
    expect(find('guest-mode-row')[0]?.visibility).toBe('code');
    expect(find('dupr-estimate')[0]?.visibility).toBe('code');
    expect(find('SELECT owner_key')[0]?.visibility).toBe('code');
    expect(find('android')[0]?.visibility).toBe('code');
  });

  it('allVisible surfaces (legal.ts) classify every non-comment literal as visible', () => {
    const legal = extractStrings(
      'legal.ts',
      `export const T = \`Purchases via Google Play\`; const x = 'DUPR';`,
      { allVisible: true },
    );
    expect(legal.map(s => s.visibility)).toEqual(['visible', 'visible']);
  });
});

describe('release copy policy scan — rules', () => {
  const rules = rulesById();
  const strictHits = (text: string) =>
    matchRules(
      {
        file: 'f.ts',
        line: 1,
        column: 1,
        start: 0,
        raw: text,
        text,
        slot: 'jsx_text',
        slotName: null,
        visibility: 'visible',
      },
      text,
    ).filter(h => h.confidence === 'strict');

  it('strict rule set is exactly the dossier list', () => {
    expect([...STRICT_RULE_IDS].sort()).toEqual(
      [
        'accuracy_percent',
        'ai_coach_equivalence',
        'android',
        'competitor',
        'dupr',
        'google_play',
        'guest_mode',
        'live_court',
        'superlative',
      ].sort(),
    );
    for (const r of COPY_RULES) {
      expect(r.source.length).toBeGreaterThan(0);
      expect(rules.get(r.id)).toBe(r);
    }
  });

  it.each([
    ['Works on Android too', 'android'],
    ['Manage in Google Play', 'google_play'],
    ['Open the Play Store', 'google_play'],
    ['Continue in guest mode', 'guest_mode'],
    ['Try Live Court', 'live_court'],
    ['≈ DUPR 4.2', 'dupr'],
    ['Better than SwingVision', 'competitor'],
    ['Better than PB Vision', 'competitor'],
    ['Used by Selkirk and JOOLA pros', 'competitor'],
    ['98% accurate stroke detection', 'accuracy_percent'],
    ['detects 9 out of 10 with 95 percent precision', 'accuracy_percent'],
    ['The most accurate pickleball coach', 'superlative'],
    ['for the most precise read', 'superlative'],
    ['the best pickleball app', 'superlative'],
    ['#1 pickleball app', 'superlative'],
    ['Like having a coach in your pocket', 'ai_coach_equivalence'],
    ['Your AI coach', 'ai_coach_equivalence'],
    ['Replaces your coach', 'ai_coach_equivalence'],
    ['As good as a real coach', 'ai_coach_equivalence'],
  ])('flags %j as %s', (text, ruleId) => {
    expect(strictHits(text).map(h => h.rule)).toContain(ruleId);
  });

  it.each([
    'Technique Score is coaching feedback, not a verified rating.',
    'Your rating is an estimate validated against server-accepted reads.',
    'Save 20% with yearly',
    'Best streak: 5 days',
    'Was this analysis accurate?',
    'Manage subscription in the App Store',
    'Signed in with Apple',
    'guest',
    'Coaching cue from your read',
  ])('does not strictly flag approved / neutral copy %j', text => {
    expect(strictHits(text)).toEqual([]);
  });

  it('approved language is recognised', () => {
    expect(APPROVED_LANGUAGE.test('validated')).toBe(true);
    expect(APPROVED_LANGUAGE.test('server-accepted')).toBe(true);
    expect(APPROVED_LANGUAGE.test('an estimate')).toBe(true);
    expect(APPROVED_LANGUAGE.test('best')).toBe(false);
  });

  it('a percentage without an accuracy word is triage, not strict', () => {
    const all = matchRules(
      {
        file: 'f.ts',
        line: 1,
        column: 1,
        start: 0,
        raw: 'Save 20% with yearly',
        text: 'Save 20% with yearly',
        slot: 'jsx_text',
        slotName: null,
        visibility: 'visible',
      },
      'Save 20% with yearly',
    );
    expect(all.map(h => `${h.rule}:${h.confidence}`)).toEqual([
      'percent_literal:triage',
    ]);
  });
});

describe('release copy policy scan — user-visible strict hits ledger', () => {
  it('reports the location, slot and visibility of every hit', () => {
    for (const h of report.hits) {
      expect(h.file.length).toBeGreaterThan(0);
      expect(h.line).toBeGreaterThan(0);
      expect(h.column).toBeGreaterThan(0);
      expect(h.matched.length).toBeGreaterThan(0);
      expect(['visible', 'likely', 'code', 'comment']).toContain(h.visibility);
      expect(h.userVisible).toBe(
        h.visibility === 'visible' || h.visibility === 'likely',
      );
    }
  });

  it('no NEW forbidden term or claim has entered user-visible copy', () => {
    const known = new Set(KNOWN_VISIBLE_STRICT_HITS.map(k => k.key));
    const unexpected = visibleStrict(report)
      .filter(h => !known.has(hitKey(h)))
      .map(
        h =>
          `${h.file}:${h.line} [${h.rule}] "${h.matched}" in ${h.slot}${
            h.slotName ? `(${h.slotName})` : ''
          } — ${h.context}`,
      );
    expect(unexpected).toEqual([]);
  });

  it('every ledger entry still exists (remove fixed entries from KNOWN_VISIBLE_STRICT_HITS)', () => {
    const present = new Set(visibleStrict(report).map(hitKey));
    const stale = KNOWN_VISIBLE_STRICT_HITS.filter(k => !present.has(k.key));
    expect(stale.map(k => `${k.key} — ${k.note}`)).toEqual([]);
  });

  it('the ledger accounts for exactly the strict hits found at the audited commit', () => {
    // 12 literal occurrences collapse to the 9 ledger keys (Google Play ×2
    // in ManageAccountScreen, ×3 in legal.ts). If copy is fixed, both this
    // count and the ledger must change together.
    expect(visibleStrict(report)).toHaveLength(12);
    expect(new Set(visibleStrict(report).map(hitKey)).size).toBe(
      KNOWN_VISIBLE_STRICT_HITS.length,
    );
  });

  it('the scan surfaces include legal.ts and Info.plist explicitly', () => {
    const files = defaultSurfaces(HOST, REPO_ROOT).flatMap(s => s.files);
    expect(files).toContain('supabase/functions/api/legal.ts');
    expect(files).toContain('apps/mobile/ios/PickleSensei/Info.plist');
    expect(
      files.some(f => f === 'apps/mobile/src/screens/SettingsScreen.tsx'),
    ).toBe(true);
  });
});
