/**
 * Adversarial probe of the C1 fix (f922afaf — "drop the DUPR trademark from
 * all user-facing copy"). The candidate's own repro pins PlayerRankCard plus
 * a case-sensitive scan of apps/mobile/src/**.ts(x). This suite widens the
 * net around it:
 *
 *   - every OTHER surface that renders the estimate (PlayerRankBanner,
 *     RankUpCelebration) — visible text AND accessibility copy;
 *   - boundary/degenerate scores through the rank card (0, 10, rounding
 *     edges) so the a11y label is checked with real numbers, not one value;
 *   - a CASE-INSENSITIVE scan over everything that ships in the iOS bundle
 *     or feeds its copy (App.tsx, app.json, src/**, ios/** minus Pods/build,
 *     and the shared packages the app renders labels from);
 *   - the replacement label itself against the full hard-rule word list.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PlayerRankSummary } from '@pickle/shared-types';

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View: RNView } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(RNView, null, props.children);
  return { __esModule: true, default: MockGradient };
});

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { PlayerRankBanner } from '../../src/components/PlayerRankBanner';
import { PlayerRankCard } from '../../src/components/PlayerRankCard';
import { RankUpCelebration } from '../../src/components/RankUpCelebration';
import { useRankCelebrationStore } from '../../src/progress/rankCelebration';
import {
  MATCH_RATING_ESTIMATE_NOTE,
  formatMatchRatingEstimate,
  matchRatingEstimate,
} from '../../src/progress/matchRatingEstimate';
import type { RealAnalysisFact } from '../../src/data/repository';

declare const __dirname: string;
const { readdirSync, readFileSync, statSync, existsSync } = jest.requireActual(
  'fs',
) as {
  readdirSync: (path: string) => string[];
  readFileSync: (path: string, encoding: 'utf8') => string;
  statSync: (path: string) => { isDirectory(): boolean };
  existsSync: (path: string) => boolean;
};
const { join, relative, resolve, basename } = jest.requireActual('path') as {
  join: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
  resolve: (...parts: string[]) => string;
  basename: (path: string) => string;
};

const TRADEMARK = /dupr/i;
// docs/APP_STORE_SUBMISSION.md hard rules + REVIEW.md "Launch flow & copy".
const HARD_RULE_TERMS =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d{1,3}\s?% accura|\bbest\b|\bmost accurate\b/i;

function fact(
  id: string,
  overallScore: number,
  shotType = 'dink',
): RealAnalysisFact {
  return {
    id,
    shotType,
    capturedAt: '2026-08-10T10:00:00Z',
    overallScore,
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'model-2',
    shotConfigVersion: 'config-1',
    sessionId: null,
    priorityCheckpoint: null,
    checkpointScores: {},
  };
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

function allAccessibilityCopy(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAll(() => true)
    .flatMap(node => [
      node.props.accessibilityLabel,
      node.props.accessibilityHint,
      node.props.accessibilityValue?.text,
    ])
    .filter((label): label is string => typeof label === 'string');
}

function everyString(renderer: TestRenderer.ReactTestRenderer): string {
  return `${allText(renderer)} ${allAccessibilityCopy(renderer).join(' ')} ${JSON.stringify(
    renderer.toJSON(),
  )}`;
}

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

const SKIP_DIRS = new Set([
  'node_modules',
  'Pods',
  'build',
  'DerivedData',
  '.git',
]);
const SHIPPED_EXT =
  /\.(tsx?|jsx?|json|swift|m|mm|h|plist|strings|xml|storyboard|xib|md)$/;

function listShippedFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listShippedFiles(full, out);
    else if (SHIPPED_EXT.test(name) && basename(full) !== 'package-lock.json')
      out.push(full);
  }
  return out;
}

describe('attack f922afaf — trademark absent from EVERY estimate surface', () => {
  afterEach(() => {
    useRankCelebrationStore.setState({ current: null });
  });

  it('PlayerRankBanner (ranked, device source) shows the renamed estimate and no trademark in text or a11y', async () => {
    const shots = [
      fact('a', 7.62, 'dink'),
      fact('b', 7.62, 'forehand_drive'),
      fact('c', 7.62, 'serve'),
    ];
    const renderer = await render(
      <PlayerRankBanner shots={shots} streakDays={2} />,
    );
    const copy = allText(renderer);
    const labels = allAccessibilityCopy(renderer);
    expect(copy).toContain('(≈ match rating');
    expect(copy).toMatch(/≈/);
    expect(labels.length).toBeGreaterThan(0);
    expect(everyString(renderer)).not.toMatch(TRADEMARK);
    act(() => renderer.unmount());
  });

  it('RankUpCelebration count-up shows the renamed estimate for a promotion and for a first placement', async () => {
    const summary: PlayerRankSummary = {
      rating: 7.62,
      tier: 'diamond',
      tierLabel: 'Diamond',
      division: 3,
      divisionLabel: 'III',
      techniqueCount: 3,
      scoredAnalysisCount: 9,
      techniques: [],
      nextTier: null,
    };
    for (const fromTier of ['platinum', null] as const) {
      useRankCelebrationStore.setState({
        current: {
          fromTier,
          toTier: 'diamond',
          fromRating: fromTier ? 7.1 : null,
          summary,
        },
      });
      const renderer = await render(<RankUpCelebration />);
      const all = everyString(renderer);
      expect(all).toContain('(≈ match rating 5.6)');
      expect(all).not.toMatch(TRADEMARK);
      act(() => renderer.unmount());
    }
  });

  it.each([
    [0.0, '1.0'],
    [0.04, '1.0'],
    [5.55, '4.3'],
    [7.62, '5.6'],
    [9.99, '7.0'],
    [10, '7.0'],
  ])(
    'PlayerRankCard at score %s — a11y label carries "estimated match rating %s" and no trademark',
    async (score, expected) => {
      const renderer = await render(
        <PlayerRankCard
          facts={[fact('f1', score, 'dink'), fact('f2', score, 'serve')]}
        />,
      );
      const labels = allAccessibilityCopy(renderer);
      const tierLabel = labels.find(l => l.startsWith('Player rank'));
      expect(tierLabel).toBeDefined();
      expect(tierLabel).toContain(`estimated match rating ${expected}`);
      expect(allText(renderer)).toContain(`(≈ match rating ${expected})`);
      expect(everyString(renderer)).not.toMatch(TRADEMARK);
      act(() => renderer.unmount());
    },
  );

  it('the replacement copy violates none of the hard-rule terms and stays an "estimate"', () => {
    for (const score of [-1, 0, 3.3333, 5, 7.62, 10, 11]) {
      const label = formatMatchRatingEstimate(score);
      expect(label).not.toMatch(HARD_RULE_TERMS);
      expect(label).toMatch(/^\(≈ match rating \d\.\d\)$/);
      const n = matchRatingEstimate(score);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(7);
    }
    expect(MATCH_RATING_ESTIMATE_NOTE).not.toMatch(HARD_RULE_TERMS);
    expect(MATCH_RATING_ESTIMATE_NOTE).toMatch(/estimate/);
  });

  it('CASE-INSENSITIVE: nothing that ships in the iOS bundle or feeds its labels mentions the trademark', () => {
    const mobileRoot = resolve(__dirname, '../..');
    const repoRoot = resolve(mobileRoot, '../..');
    const roots = [
      join(mobileRoot, 'src'),
      join(mobileRoot, 'ios'),
      join(mobileRoot, 'assets'),
      join(repoRoot, 'packages/shared-types/src'),
      join(repoRoot, 'packages/scoring/src'),
    ].filter(existsSync);
    const singles = [
      join(mobileRoot, 'App.tsx'),
      join(mobileRoot, 'app.json'),
      join(mobileRoot, 'index.js'),
    ].filter(existsSync);
    const files = [...roots.flatMap(r => listShippedFiles(r)), ...singles];
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter(file => TRADEMARK.test(readFileSync(file, 'utf8')))
      .map(file => relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });
});
