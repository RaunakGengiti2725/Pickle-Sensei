import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import {
  PLAYER_RANK_TIERS,
  type PlayerRankSummary,
} from '@pickle/shared-types';
import { Circle, Path } from 'react-native-svg';
declare const __dirname: string;
const { readFileSync } = require('node:fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { join } = require('node:path') as {
  join: (...parts: string[]) => string;
};
import { RankIcon, RANK_TIER_STYLE } from '../src/components/RankIcon';
import { color, type as typography } from '../src/design/tokens';

// The celebration store persists through SQLite; the native module is absent
// under jest and none of these tests exercise persistence.
jest.mock('../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { RankUpCelebration } from '../src/components/RankUpCelebration';
import { useRankCelebrationStore } from '../src/progress/rankCelebration';

/**
 * Ceremony surface smoke tests: the overlay renders the promotion facts,
 * offers Continue and a backdrop dismiss, and unmounts cleanly. Animation
 * timing itself is not asserted — reduced-motion parity keeps the layout
 * identical at rest.
 */

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

function setCelebration(fromTier: 'platinum' | null) {
  useRankCelebrationStore.setState({
    current: {
      fromTier,
      toTier: 'diamond',
      fromRating: fromTier ? 7.1 : null,
      summary: diamondSummary,
    },
  });
}

afterEach(() => {
  useRankCelebrationStore.setState({ current: null });
});

function withSafeArea(children: React.ReactNode) {
  return (
    <SafeAreaInsetsContext.Provider
      value={{ top: 59, bottom: 34, left: 0, right: 0 }}
    >
      {children}
    </SafeAreaInsetsContext.Provider>
  );
}

function hostNodes(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => node.props.testID === testID && typeof node.type === 'string',
  );
}

describe('RankUpCelebration', () => {
  it('renders nothing without a pending celebration', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(withSafeArea(<RankUpCelebration />));
    });
    expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('shows the promotion facts for platinum → diamond', async () => {
    setCelebration('platinum');
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(withSafeArea(<RankUpCelebration />));
    });
    expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(1);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('Diamond unlocked');
    expect(text).toContain('RANK UP');
    expect(text).toContain('Top tier');
    act(() => renderer.unmount());
  });

  it('uses placement copy for a first-ever rank', async () => {
    setCelebration(null);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(withSafeArea(<RankUpCelebration />));
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('You’re on the board.');
    expect(text).toContain('PLACED');
    act(() => renderer.unmount());
  });

  it('Continue dismisses the ceremony', async () => {
    setCelebration('platinum');
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(withSafeArea(<RankUpCelebration />));
    });
    const continueButton = renderer.root.findAll(
      node => node.props.testID === 'rank-up-continue' && node.props.onPress,
    )[0]!;
    await act(async () => {
      continueButton.props.onPress();
    });
    expect(useRankCelebrationStore.getState().current).toBeNull();
    act(() => renderer.unmount());
  });
});

describe('flat rank insignia', () => {
  it('keeps every tier label and a distinct shape in the same two-color palette', () => {
    const silhouettes = new Set<string>();
    for (const tier of PLAYER_RANK_TIERS) {
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(<RankIcon tier={tier.key} size={44} />);
      });
      const paths = renderer.root.findAllByType(Path);
      const circles = renderer.root.findAllByType(Circle);
      const marks = [...paths, ...circles];
      const paints = marks
        .flatMap(mark => [mark.props.fill, mark.props.stroke])
        .filter(paint => paint && paint !== 'none');
      expect([...new Set(paints)].sort()).toEqual(
        [color.inkElevated, color.volt].sort(),
      );
      expect(marks).toHaveLength(2);
      expect(JSON.stringify(renderer.toJSON())).toContain(
        `${tier.label} rank emblem`,
      );
      expect(RANK_TIER_STYLE[tier.key]).toEqual({
        accent: color.volt,
        deep: color.inkElevated,
        tint: color.voltTint,
      });
      silhouettes.add(
        JSON.stringify(
          marks.map(mark => ({
            d: mark.props.d,
            cx: mark.props.cx,
            cy: mark.props.cy,
            r: mark.props.r,
          })),
        ),
      );
      act(() => renderer.unmount());
    }
    expect(silhouettes.size).toBe(PLAYER_RANK_TIERS.length);
  });

  it('keeps unranked neutral on its own dark plate', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<RankIcon tier={null} />);
    });
    const paths = renderer.root.findAllByType(Path);
    expect(paths[0]!.props.fill).toBe(color.inkElevated);
    expect(paths.every(path => path.props.stroke === color.onDarkFaint)).toBe(
      true,
    );
    expect(JSON.stringify(renderer.toJSON())).toContain('Unranked emblem');
    act(() => renderer.unmount());
  });
});

describe('inventory visual contract', () => {
  it.each([
    'screens/HomeScreen.tsx',
    'screens/ProgressScreen.tsx',
    'screens/StreakCalendarScreen.tsx',
    'screens/LibraryScreen.tsx',
    'components/RankIcon.tsx',
    'components/PlayerRankBanner.tsx',
    'components/PlayerRankCard.tsx',
    'components/RankUpCelebration.tsx',
    'consistency/FlameIcon.tsx',
    'consistency/MilestoneBadge.tsx',
    'consistency/ConsistencyCard.tsx',
    'consistency/AchievementsShowcase.tsx',
    'consistency/StreakCelebration.tsx',
    'consistency/DaySecuredBanner.tsx',
  ])('%s uses token colors and type without ornamental effects', file => {
    const source = readFileSync(join(__dirname, '../src', file), 'utf8');
    expect(source).not.toMatch(
      /\b(?:LinearGradient|RadialGradient|Sunburst|Shimmer|SPARKS|CONFETTI|glint|withRepeat|withSpring)\b/,
    );
    expect(source).not.toMatch(/['"`](?:#[\da-fA-F]{3,8}\b|rgba?\()/);
    expect(source).not.toMatch(
      /\b(?:shadowColor|shadowOffset|shadowOpacity|shadowRadius|textShadowColor|textShadowRadius|elevation|fontSize|lineHeight)\s*:/,
    );
  });

  it('uses the shared score, display, and minimum metadata roles', () => {
    expect(typography.score).toMatchObject({ fontSize: 30, lineHeight: 34 });
    expect(typography.display).toMatchObject({ fontSize: 64, lineHeight: 66 });
    expect(typography.micro.fontSize).toBeGreaterThanOrEqual(11);
  });
});
