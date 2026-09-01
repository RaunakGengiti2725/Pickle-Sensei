import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PlayerRankSummary } from '@pickle/shared-types';

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { AchievementsShowcase } from '../../src/consistency/AchievementsShowcase';
import {
  buildConsistencySnapshot,
  specialistTitle,
  type TrainingActivityInput,
} from '../../src/consistency/engine';
import { StreakCelebration } from '../../src/consistency/StreakCelebration';
import { useConsistencyStore } from '../../src/consistency/store';
import { RankUpCelebration } from '../../src/components/RankUpCelebration';
import { useRankCelebrationStore } from '../../src/progress/rankCelebration';
import { FirstRunWalkthrough } from '../../src/walkthrough/FirstRunWalkthrough';
import {
  registerWalkthroughMeasurer,
  type WalkthroughTargetKey,
} from '../../src/walkthrough/targets';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';

/**
 * Backdrop dismiss targets announce as buttons, achievement badges expose
 * their open/closed state to assistive tech, and the Specialist badge is
 * titled in title case on both surfaces that render it.
 */

function backdrop(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const nodes = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  expect(nodes.length).toBeGreaterThan(0);
  return nodes[0]!;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string => typeof child === 'string')
    .join(' ');
}

describe('backdrop dismiss targets announce as buttons', () => {
  afterEach(() => {
    useConsistencyStore.setState({ celebration: null });
    useRankCelebrationStore.setState({ current: null });
    useWalkthroughStore.setState({ visible: false });
  });

  it('StreakCelebration', () => {
    useConsistencyStore.setState({
      celebration: {
        kind: 'streak',
        achievementId: 'streak.7',
        title: 'One Week',
        blurb: 'Seven days.',
        reward: 'Streak Shield',
        rarity: 'uncommon',
        value: 7,
        streakAtCelebration: 7,
      },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<StreakCelebration />);
    });
    expect(
      backdrop(renderer, 'Dismiss milestone celebration').props
        .accessibilityRole,
    ).toBe('button');
    act(() => renderer.unmount());
  });

  it('RankUpCelebration', async () => {
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
    useRankCelebrationStore.setState({
      current: {
        fromTier: 'platinum',
        toTier: 'diamond',
        fromRating: 7.1,
        summary,
      },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RankUpCelebration />);
    });
    expect(
      backdrop(renderer, 'Dismiss rank celebration').props.accessibilityRole,
    ).toBe('button');
    act(() => renderer.unmount());
  });

  it('FirstRunWalkthrough', async () => {
    const rects: Record<
      WalkthroughTargetKey,
      { x: number; y: number; width: number; height: number }
    > = {
      'coach-fab': { x: 165, y: 700, width: 64, height: 64 },
      'rank-banner': { x: 24, y: 120, width: 345, height: 96 },
      'tab-library': { x: 96, y: 760, width: 70, height: 54 },
      'tab-progress': { x: 236, y: 760, width: 70, height: 54 },
    };
    const cleanups = (Object.keys(rects) as WalkthroughTargetKey[]).map(key =>
      registerWalkthroughMeasurer(key, () => Promise.resolve(rects[key])),
    );
    useWalkthroughStore.setState({ visible: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<FirstRunWalkthrough />);
    });
    const dismiss = backdrop(renderer, 'Dismiss walkthrough');
    expect(dismiss.props.accessibilityRole).toBe('button');
    await act(async () => dismiss.props.onPress());
    expect(useWalkthroughStore.getState().visible).toBe(false);
    act(() => renderer.unmount());
    for (const cleanup of cleanups) cleanup();
  });
});

function dinkGrind(): TrainingActivityInput[] {
  const activities: TrainingActivityInput[] = [];
  for (let day = 1; day <= 7; day += 1) {
    for (let i = 0; i < 4; i += 1) {
      activities.push({
        kind: 'stroke',
        atIso: `2026-03-${String(day).padStart(2, '0')}T1${i}:00:00.000Z`,
        shotType: 'dink',
        overallScore: 6,
        resultKind: 'scored',
      });
    }
  }
  return activities;
}

describe('AchievementsShowcase badges', () => {
  const snapshot = buildConsistencySnapshot(dinkGrind(), {
    asOfIso: '2026-03-07T18:00:00.000Z',
    timeZone: 'UTC',
  });

  function badges(renderer: TestRenderer.ReactTestRenderer) {
    const seen = new Set<string>();
    return renderer.root
      .findAll(
        node =>
          typeof node.props.accessibilityLabel === 'string' &&
          node.props.accessibilityState !== undefined &&
          typeof node.props.onPress === 'function',
      )
      .filter(node => {
        const label = node.props.accessibilityLabel as string;
        if (seen.has(label)) return false;
        seen.add(label);
        return true;
      });
  }

  it('expose selected state and toggle it on press', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <AchievementsShowcase snapshot={snapshot} />,
      );
    });
    const before = badges(renderer);
    expect(before.length).toBeGreaterThan(1);
    for (const badge of before) {
      expect(badge.props.accessibilityState).toEqual({ selected: false });
    }
    const target = before[0]!.props.accessibilityLabel as string;
    act(() => {
      before[0]!.props.onPress();
    });
    const after = badges(renderer);
    expect(
      after.map(node => [
        node.props.accessibilityLabel,
        node.props.accessibilityState.selected,
      ]),
    ).toEqual(
      after.map(node => [
        node.props.accessibilityLabel,
        node.props.accessibilityLabel === target,
      ]),
    );
    act(() => {
      after
        .find(node => node.props.accessibilityLabel === target)!
        .props.onPress();
    });
    for (const badge of badges(renderer)) {
      expect(badge.props.accessibilityState).toEqual({ selected: false });
    }
    act(() => renderer.unmount());
  });

  it('title the Specialist badge in title case', () => {
    expect(snapshot.earned.map(e => e.id)).toContain('volume.specialist');
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <AchievementsShowcase snapshot={snapshot} />,
      );
    });
    const copy = allText(renderer);
    expect(copy).toContain('Dink Specialist');
    expect(copy).not.toContain('dink Specialist');
    act(() => renderer.unmount());
  });
});

describe('specialistTitle', () => {
  it('title-cases multi-word techniques', () => {
    expect(specialistTitle('forehand drive')).toBe('Forehand Drive Specialist');
    expect(specialistTitle('third_shot_drop')).toBe(
      'Third Shot Drop Specialist',
    );
    expect(specialistTitle('serve')).toBe('Serve Specialist');
  });
});
