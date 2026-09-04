/**
 * AUDIT PROBE — user-facing copy rendered by the rank surfaces vs the copy
 * policy in docs/APP_STORE_SUBMISSION.md (no Android / Google Play / guest
 * mode / Live Court / DUPR / competitor mentions).
 *
 * The "DUPR-style estimate" is a recorded product decision (2026-09-01,
 * src/progress/duprEstimate.ts) and the dossier records it as an accepted
 * in-app risk, so a failure here is a coordinator decision, not a crash.
 * The probe exists so the decision is made against rendered evidence.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PlayerRankSummary } from '@pickle/shared-types';

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
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

import { PlayerRankCard } from '../../src/components/PlayerRankCard';
import { PlayerRankBanner } from '../../src/components/PlayerRankBanner';
import { RankUpCelebration } from '../../src/components/RankUpCelebration';
import type { RealAnalysisFact } from '../../src/data/repository';
import { useRankCelebrationStore } from '../../src/progress/rankCelebration';

const PROHIBITED = [
  /android/i,
  /google play/i,
  /guest mode/i,
  /live court/i,
  /\bDUPR\b/,
  /swingvision/i,
  /pb vision/i,
  /selkirk/i,
  /joola/i,
];

let sequence = 0;
function fact(): RealAnalysisFact {
  sequence += 1;
  return {
    id: `fact-${sequence}`,
    shotType: 'dink',
    capturedAt: `2026-08-${String(10 + sequence).padStart(2, '0')}T10:00:00Z`,
    overallScore: 5.5,
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'model-2',
    shotConfigVersion: 'config-1',
    sessionId: null,
    priorityCheckpoint: null,
    checkpointScores: {},
  };
}

const diamondSummary: PlayerRankSummary = {
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

const mounted: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  while (mounted.length) {
    const r = mounted.pop()!;
    act(() => r.unmount());
  }
  useRankCelebrationStore.setState({ current: null });
});

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  mounted.push(renderer);
  return renderer;
}

function flattenChildren(children: unknown): string {
  if (children == null || typeof children === 'boolean') return '';
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children);
  }
  if (Array.isArray(children)) return children.map(flattenChildren).join('');
  if (typeof children === 'object' && 'props' in children) {
    return flattenChildren(
      (children as { props: { children?: unknown } }).props.children,
    );
  }
  return '';
}

/** Every string a user can read or hear: visible text + accessibility labels. */
function userFacingStrings(renderer: TestRenderer.ReactTestRenderer): string[] {
  const visible = renderer.root
    .findAllByType(Text)
    .map(node => flattenChildren(node.props.children));
  const spoken = renderer.root
    .findAll(node => typeof node.props.accessibilityLabel === 'string')
    .map(node => node.props.accessibilityLabel as string);
  return [...visible, ...spoken].filter(s => s.trim().length > 0);
}

function violations(strings: string[]): string[] {
  return strings.filter(s => PROHIBITED.some(re => re.test(s)));
}

describe('rank surfaces — copy policy (docs/APP_STORE_SUBMISSION.md)', () => {
  it('PROBE: PlayerRankCard (ranked) renders/announces no prohibited term', async () => {
    const renderer = await render(<PlayerRankCard facts={[fact(), fact()]} />);
    expect(userFacingStrings(renderer).join(' ')).toContain('Gold');
    expect(violations(userFacingStrings(renderer))).toEqual([]);
  });

  it('VERIFIED: PlayerRankCard (Unranked) renders no prohibited term', async () => {
    const renderer = await render(<PlayerRankCard facts={[]} />);
    expect(userFacingStrings(renderer).join(' ')).toContain('Unranked');
    expect(violations(userFacingStrings(renderer))).toEqual([]);
  });

  it('PROBE: PlayerRankBanner (ranked) renders/announces no prohibited term', async () => {
    const renderer = await render(
      <PlayerRankBanner shots={[fact(), fact()]} streakDays={3} />,
    );
    expect(violations(userFacingStrings(renderer))).toEqual([]);
  });

  it('PROBE: RankUpCelebration renders/announces no prohibited term', async () => {
    useRankCelebrationStore.setState({
      current: {
        fromTier: 'platinum',
        toTier: 'diamond',
        fromRating: 7.1,
        summary: diamondSummary,
      },
    });
    const renderer = await render(<RankUpCelebration />);
    expect(userFacingStrings(renderer).join(' ')).toContain('Diamond');
    expect(violations(userFacingStrings(renderer))).toEqual([]);
  });
});
