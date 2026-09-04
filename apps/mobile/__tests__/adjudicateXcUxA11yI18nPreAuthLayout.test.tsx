/**
 * Adjudication reproduction for area xc-ux-a11y-i18n (pre-auth layout).
 *
 * Linux cannot run iOS layout, so this pins what IS provable from the tree:
 *  - WelcomeScreen / SignInScreen render no scrollable container;
 *  - the vertical budget of Welcome's fixed pieces (paddings, `minHeight`s,
 *    lineHeight × line counts) exceeds the smallest supported iPhone viewport
 *    (375×667, 20pt status bar) already at font scale 1.0, and the primary CTA
 *    itself leaves the viewport at Dynamic Type xxLarge (≈1.235×).
 * Line counts are a model (3 tagline lines, 2 footnote lines at 1.0×) — the
 * iOS render must be confirmed on the M4 runner; this file is Linux evidence.
 *
 * Run: cd apps/mobile && npx jest --ci __tests__/adjudicateXcUxA11yI18nPreAuthLayout.test.tsx
 */
import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { WelcomeScreen } from '../src/screens/WelcomeScreen';
import { SignInScreen } from '../src/screens/SignInScreen';
import { space, type } from '../src/design/tokens';

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: (props: { children?: React.ReactNode }) =>
      ReactActual.createElement(View, null, props.children),
    useSafeAreaInsets: () => ({ top: 20, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 375, height: 667 },
      insets: { top: 20, bottom: 0, left: 0, right: 0 },
    },
  };
});
jest.mock('react-native-svg', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Ellipse: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});
jest.mock('../src/auth/authStore', () => ({
  useAuthStore: () => ({
    busy: false,
    error: {
      code: 'auth.failed',
      message:
        'The operation couldn’t be completed. (com.apple.AuthenticationServices.AuthorizationError error 1000.)',
    },
    signInWithApple: jest.fn(),
    signInWithGoogle: jest.fn(),
    clearError: jest.fn(),
  }),
}));

const SE_VIEWPORT = 667 - 20; // iPhone SE (2nd/3rd gen) minus status bar
const XXLARGE = 1.235; // Dynamic Type xxLarge relative to Large (default)

function scrollViews(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAllByType(ScrollView);
}

function flat(instance: ReactTestInstance) {
  return StyleSheet.flatten(instance.props.style) as Record<string, number>;
}

/** Welcome column model: every fixed contribution to the root's height. */
function welcomeBudget(scale: number) {
  const topBar = space.sm + 32; // BrandMark 32pt
  const hero = type.hero.lineHeight * 2 * scale;
  const taglineLines = scale > 1.1 ? 4 : 3;
  const heroCopy =
    space.xl + hero + space.sm + type.body.lineHeight * taglineLines * scale;
  const court = space.lg + 270;
  const ctaTop = topBar + heroCopy + court + space.lg;
  const cta = 56;
  const link = space.xs + 44;
  const footnote = space.md + type.caption.lineHeight * 2 * scale;
  return {
    ctaTop,
    ctaBottom: ctaTop + cta,
    linkBottom: ctaTop + cta + link,
    total: ctaTop + cta + link + footnote + space.sm,
  };
}

describe('C1 — WelcomeScreen: non-scrolling column whose fixed heights exceed the smallest supported viewport', () => {
  let tree: TestRenderer.ReactTestRenderer;
  beforeAll(() => {
    act(() => {
      tree = TestRenderer.create(
        <WelcomeScreen onGetStarted={() => {}} onSignIn={() => {}} />,
      );
    });
  });

  test('reproduction: no ScrollView anywhere in the Welcome tree', () => {
    expect(scrollViews(tree.root)).toHaveLength(0);
  });

  test('reproduction: CourtStory pins minHeight 270 while also flexing', () => {
    const court = tree.root
      .findAll(n => String(n.type) === 'View')
      .map(flat)
      .find(s => s && s.minHeight === 270);
    expect(court).toBeDefined();
    expect(court?.flex).toBe(1);
  });

  test('reproduction: modeled column at 1.0× is 731pt > 647pt available — sign-in link clipped, footnote offscreen', () => {
    const b = welcomeBudget(1);
    expect(b.total).toBe(731);
    expect(b.total).toBeGreaterThan(SE_VIEWPORT);
    expect(b.ctaBottom).toBeLessThanOrEqual(SE_VIEWPORT);
    expect(b.linkBottom).toBeGreaterThan(SE_VIEWPORT);
  });

  test('reproduction: at xxLarge the primary CTA bottom edge leaves the 375×667 viewport', () => {
    const b = welcomeBudget(XXLARGE);
    expect(b.ctaBottom).toBeGreaterThan(SE_VIEWPORT);
  });

  test.failing(
    'expected: Welcome content is scrollable (or fits 375×667 at 1.0×)',
    () => {
      const fits = welcomeBudget(1).total <= SE_VIEWPORT;
      expect(scrollViews(tree.root).length > 0 || fits).toBe(true);
    },
  );
});

describe('C2 — SignInScreen: error card grows an unscrollable body over the fixed footer', () => {
  let tree: TestRenderer.ReactTestRenderer;
  beforeAll(() => {
    act(() => {
      tree = TestRenderer.create(<SignInScreen onBack={() => {}} />);
    });
  });

  test('reproduction: no ScrollView; body is flex:1 with the error card inside it', () => {
    expect(scrollViews(tree.root)).toHaveLength(0);
    const body = tree.root
      .findAll(n => String(n.type) === 'View')
      .map(flat)
      .find(s => s && s.flex === 1 && s.paddingTop === space.lg);
    expect(body).toBeDefined();
    const errorTitle = tree.root.findAll(
      n => n.props.children === 'SIGN-IN FAILED',
    );
    expect(errorTitle.length).toBeGreaterThan(0);
  });

  test('reproduction: modeled 375×667 body with a 3-line provider error overflows into the footer', () => {
    const header = 56;
    const body =
      space.lg +
      32 +
      space.xl +
      type.hero.lineHeight * 2 +
      space.sm +
      type.body.lineHeight * 4 +
      space.xl +
      58 +
      12 +
      58 +
      space.md +
      space.md * 2 +
      type.micro.lineHeight +
      4 +
      type.caption.lineHeight * 3;
    const footer = space.md + type.caption.lineHeight * 2 + space.sm;
    expect(header + body + footer).toBeGreaterThan(SE_VIEWPORT);
  });

  test.failing(
    'expected: SignIn content is scrollable so long errors never overlap the trust footer',
    () => {
      expect(scrollViews(tree.root).length).toBeGreaterThan(0);
    },
  );
});
