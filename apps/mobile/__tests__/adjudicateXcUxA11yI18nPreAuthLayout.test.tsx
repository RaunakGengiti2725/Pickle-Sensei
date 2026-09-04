/**
 * Regression pins for area xc-ux-a11y-i18n, cluster XC-UAI-04 (pre-auth
 * layout): Welcome and SignIn must stay usable on the smallest supported
 * iPhone (375×667, 20pt status bar) at default AND accessibility Dynamic
 * Type sizes — the primary CTA and the "I already have an account" link may
 * never leave the viewport, and nothing may be pushed offscreen with no way
 * to reach it.
 *
 * Linux cannot run iOS layout, so this pins what IS provable from the tree:
 *  - both screens host their body in a ScrollView whose content container
 *    grows to fill the viewport (pinned-to-bottom layout on tall phones,
 *    scrolling only when the content genuinely overflows);
 *  - Welcome keeps its footer (CTA + sign-in link) OUTSIDE the ScrollView so
 *    it is reachable without scrolling at every text size; SignIn keeps the
 *    Back header outside for the same reason;
 *  - the Welcome illustration no longer pins a hard `minHeight` — it yields
 *    to its own copy and grows only when the column has room to give;
 *  - the vertical budget model of the fixed pieces (paddings, control
 *    heights, lineHeight × line counts) shows the pinned footer fits the SE
 *    viewport at Dynamic Type AX3 and the scrolled content fits without
 *    scrolling at 1.0×. Line counts are a model — the iOS render is confirmed
 *    on the M4 runner; this file is the Linux half of the evidence.
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
const AX3 = 2.35; // accessibilityExtraExtraLarge — RN's iOS fontScale

const START_LABEL = 'Start your first read';
const SIGN_IN_LABEL = 'I already have an account';

function flat(instance: ReactTestInstance) {
  return StyleSheet.flatten(instance.props.style) as Record<string, number>;
}

function byLabel(root: ReactTestInstance, label: string) {
  return root.findAll(n => n.props.accessibilityLabel === label);
}

/** Text nodes whose (possibly segmented) children join to `text`. */
function byText(root: ReactTestInstance, text: string) {
  return root.findAll(n => {
    const children: unknown = n.props.children;
    const joined = Array.isArray(children)
      ? children.every(c => typeof c === 'string')
        ? children.join('')
        : null
      : children;
    return joined === text;
  });
}

function hostByTestId(root: ReactTestInstance, testID: string) {
  return root.findAll(
    n => typeof n.type === 'string' && n.props.testID === testID,
  );
}

/** The one scroll container a pre-auth screen is allowed to have. */
function theScrollView(root: ReactTestInstance) {
  const found = root.findAllByType(ScrollView);
  expect(found).toHaveLength(1);
  return found[0]!;
}

function contentContainer(scroll: ReactTestInstance) {
  return StyleSheet.flatten(scroll.props.contentContainerStyle) as Record<
    string,
    number
  >;
}

const BRAND_MARK = 32;
const CTA = 56; // design Button minHeight (1pt border each side, no padding)
const LINK = 44; // sign-in text action minHeight
const SCREEN_HEADER = 52; // ScreenHeader minHeight

/** Welcome pinned footer: CTA, sign-in link, two-line footnote. */
function welcomeFooter(scale: number) {
  const footnoteLines = scale > 1.6 ? 4 : 2;
  return (
    space.lg +
    Math.max(CTA, type.bodyBold.lineHeight * scale + 2) +
    space.xs +
    Math.max(LINK, type.bodyBold.lineHeight * scale) +
    space.md +
    type.caption.lineHeight * footnoteLines * scale +
    space.sm
  );
}

/** Welcome scrolled column at its natural (unstretched) height. */
function welcomeScrollContent(scale: number) {
  const topBar = space.sm + BRAND_MARK;
  const taglineLines = scale > 1.1 ? 4 : 3;
  const heroCopy =
    space.xl +
    type.hero.lineHeight * 2 * scale +
    space.sm +
    type.body.lineHeight * taglineLines * scale;
  // CourtStory floor = its own copy: kicker, two-line title, caption row
  // sharing a line with the ON-DEVICE pill (micro text + 2×8 padding).
  const pill = type.micro.lineHeight * scale + 2 * 8;
  const court =
    28 +
    type.micro.lineHeight * scale +
    space.sm +
    type.h1.lineHeight * 2 * scale +
    5 +
    Math.max(type.caption.lineHeight * scale, pill) +
    20;
  return topBar + heroCopy + space.lg + court;
}

describe('C1 — WelcomeScreen: scrolling body under a pinned CTA footer', () => {
  let tree: TestRenderer.ReactTestRenderer;
  beforeAll(() => {
    act(() => {
      tree = TestRenderer.create(
        <WelcomeScreen onGetStarted={() => {}} onSignIn={() => {}} />,
      );
    });
  });

  test('the body lives in a ScrollView whose content grows to fill the viewport and only scrolls on overflow', () => {
    const scroll = theScrollView(tree.root);
    expect(flat(scroll)).toMatchObject({ flex: 1 });
    expect(contentContainer(scroll)).toMatchObject({ flexGrow: 1 });
    expect(scroll.props.alwaysBounceVertical).toBe(false);
    // The hero copy scrolls with the body.
    expect(byText(scroll, 'See the stroke.\nKnow the fix.')).not.toHaveLength(
      0,
    );
  });

  test('primary CTA and "I already have an account" are pinned outside the ScrollView', () => {
    const scroll = theScrollView(tree.root);
    expect(byLabel(tree.root, START_LABEL)).not.toHaveLength(0);
    expect(byLabel(tree.root, SIGN_IN_LABEL)).not.toHaveLength(0);
    expect(byLabel(scroll, START_LABEL)).toHaveLength(0);
    expect(byLabel(scroll, SIGN_IN_LABEL)).toHaveLength(0);
  });

  test('CourtStory yields: flexGrow without a hard minHeight, copy in flow rather than clipped', () => {
    const [court] = hostByTestId(tree.root, 'welcome-court-story');
    expect(court).toBeDefined();
    const style = flat(court!);
    expect(style.flexGrow).toBe(1);
    expect(style.flex).toBeUndefined();
    expect(style.minHeight).toBeUndefined();
    expect(style.height).toBeUndefined();
    // The illustration copy is laid out in flow so the box can never be
    // shorter than its own text (the old absolute overlay clipped at large
    // Dynamic Type sizes).
    expect(byText(court!, 'Automatic\ncapture.')).not.toHaveLength(0);
    for (const node of court!.findAll(n => typeof n.type === 'string')) {
      const s = flat(node) as Record<string, unknown> | undefined;
      if (s && s.position === 'absolute') {
        // Only the decorative SVG may float; text never does.
        expect(byText(node, 'ON-DEVICE')).toHaveLength(0);
        expect(byText(node, 'Automatic\ncapture.')).toHaveLength(0);
      }
    }
  });

  test('model: pinned footer fits the 375×667 viewport at 1.0×, xxLarge and AX3', () => {
    for (const scale of [1, XXLARGE, AX3]) {
      expect(welcomeFooter(scale)).toBeLessThan(SE_VIEWPORT);
    }
  });

  test('model: at 1.0× the scrolled column fits the remaining viewport without scrolling', () => {
    const region = SE_VIEWPORT - welcomeFooter(1);
    expect(welcomeScrollContent(1)).toBeLessThanOrEqual(region);
  });

  test('model: at xxLarge the column overflows the region, so the ScrollView is load-bearing', () => {
    const region = SE_VIEWPORT - welcomeFooter(XXLARGE);
    expect(welcomeScrollContent(XXLARGE)).toBeGreaterThan(region);
  });
});

describe('C2 — SignInScreen: scrolling body under a fixed Back header', () => {
  let tree: TestRenderer.ReactTestRenderer;
  beforeAll(() => {
    act(() => {
      tree = TestRenderer.create(<SignInScreen onBack={() => {}} />);
    });
  });

  test('providers, error card and trust footer scroll together in one growing content container', () => {
    const scroll = theScrollView(tree.root);
    expect(flat(scroll)).toMatchObject({ flex: 1 });
    expect(contentContainer(scroll)).toMatchObject({ flexGrow: 1 });
    expect(scroll.props.alwaysBounceVertical).toBe(false);
    expect(byLabel(scroll, 'Continue with Apple')).not.toHaveLength(0);
    expect(byLabel(scroll, 'Continue with Google')).not.toHaveLength(0);
    expect(
      scroll.findAll(n => n.props.children === 'SIGN-IN FAILED'),
    ).not.toHaveLength(0);
    expect(
      scroll.findAll(
        n =>
          n.props.children ===
          'Your existing on-device reads stay here when you connect.',
      ),
    ).not.toHaveLength(0);
  });

  test('the body grows (flexGrow, not flex:1) so its natural height drives the scroll extent', () => {
    const [body] = hostByTestId(tree.root, 'sign-in-body');
    expect(body).toBeDefined();
    const style = flat(body!);
    expect(style.flexGrow).toBe(1);
    expect(style.flex).toBeUndefined();
    expect(style.paddingTop).toBe(space.lg);
  });

  test('Back stays outside the ScrollView so it is reachable at any text size', () => {
    const scroll = theScrollView(tree.root);
    expect(byLabel(tree.root, 'Back')).not.toHaveLength(0);
    expect(byLabel(scroll, 'Back')).toHaveLength(0);
  });

  test('model: a 3-line provider error overflows 375×667, so the ScrollView is load-bearing', () => {
    const header = SCREEN_HEADER;
    const body =
      space.lg +
      BRAND_MARK +
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
});
