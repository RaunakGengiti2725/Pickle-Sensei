/**
 * Adversarial pins for the XC-UAI-04 fix (Welcome/SignIn scroll under pinned
 * chrome, candidate 4cff001d).
 *
 * Linux cannot lay out iOS, so everything below is either a tree fact or a
 * budget model built from `src/design/tokens.ts` and the components' own
 * StyleSheet numbers. Where a line count is needed the model reuses the
 * counts the candidate's acceptance test chose for itself
 * (`adjudicateXcUxA11yI18nPreAuthLayout.test.tsx`), so any overflow shown
 * here is one the candidate's own model already implies.
 *
 * Dynamic Type multipliers come from react-native 0.87.1
 * `React/CoreModules/RCTAccessibilityManager.mm` (the value RN reports as
 * `fontScale`, applied to fontSize AND lineHeight when allowFontScaling is
 * on — the default, and nothing in apps/mobile turns it off).
 *
 * Run: cd apps/mobile && npx jest --ci __tests__/attackXcUai04PreAuthFold.test.tsx
 */
import React from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
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

const APPLE_ERROR =
  'The operation couldn’t be completed. (com.apple.AuthenticationServices.AuthorizationError error 1000.)';
const authState: {
  busy: boolean;
  error: { code: string; message: string } | null;
} = { busy: false, error: null };
jest.mock('../src/auth/authStore', () => ({
  useAuthStore: () => ({
    busy: authState.busy,
    error: authState.error,
    signInWithApple: jest.fn(),
    signInWithGoogle: jest.fn(),
    clearError: jest.fn(),
  }),
}));

// react-native 0.87.1 RCTAccessibilityManager.mm:260-271
// (AX1..AX5 = UIContentSizeCategoryAccessibilityMedium .. ExtraExtraExtraLarge)
const RN_IOS_FONT_SCALE = {
  large: 1.0,
  xxLarge: 1.235,
  xxxLarge: 1.353,
  ax1: 1.786,
  ax2: 2.143,
  ax3: 2.643,
  ax4: 3.143,
  ax5: 3.571,
} as const;

const SE_HEIGHT = 667;
const SE_TOP_INSET = 20;
const SE_VIEWPORT = SE_HEIGHT - SE_TOP_INSET;

const BRAND_MARK_IMAGE = 32; // BrandMark default size
const SCREEN_HEADER = 52; // ScreenHeader minHeight (44pt icon button inside)
const PROVIDER_BUTTON = 58; // ProviderButton minHeight
const PROVIDER_GAP = 12;

function flat(instance: ReactTestInstance) {
  return StyleSheet.flatten(instance.props.style) as Record<string, unknown>;
}

function render(el: React.ReactElement) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(el);
  });
  return tree;
}

function texts(root: ReactTestInstance) {
  return root.findAllByType(Text).map(t => {
    const c: unknown = t.props.children;
    return Array.isArray(c) ? c.map(String).join('') : String(c);
  });
}

function a11yLabels(root: ReactTestInstance) {
  return root
    .findAll(
      n =>
        typeof n.type === 'string' &&
        typeof n.props.accessibilityLabel === 'string',
    )
    .map(
      n =>
        `${n.props.accessibilityRole ?? '-'}|${n.props.accessibilityLabel}|${
          n.props.accessibilityHint ?? ''
        }`,
    );
}

type ScrollMock = {
  scrollTo: jest.Mock;
  scrollToEnd: jest.Mock;
  flashScrollIndicators: jest.Mock;
};

function scrollInstance(scroll: ReactTestInstance): ScrollMock {
  return scroll.instance as ScrollMock;
}

function resetScrollMocks(scroll: ReactTestInstance) {
  const i = scrollInstance(scroll);
  i.scrollTo.mockClear();
  i.scrollToEnd.mockClear();
  i.flashScrollIndicators.mockClear();
}

function scrolledOrFlashed(scroll: ReactTestInstance) {
  const i = scrollInstance(scroll);
  return (
    i.scrollTo.mock.calls.length +
      i.scrollToEnd.mock.calls.length +
      i.flashScrollIndicators.mock.calls.length >
    0
  );
}

/** A ScrollView is "load-bearing" when the screen relies on it to reach
 * content that does not fit. Such a ScrollView must give the user SOME cue
 * that more content exists: either the system indicator stays on, or the
 * screen measures overflow (`onLayout` + `onContentSizeChange`, as
 * OnboardingScreen's LockedScroll does) and turns the indicator on / flashes
 * it / scrolls when the content is taller than the viewport. The overflow is
 * simulated here with a 500pt viewport and 900pt of content. */
function advertisesOverflow(tree: TestRenderer.ReactTestRenderer): boolean {
  const find = () => tree.root.findAllByType(ScrollView)[0]!;
  let scroll = find();
  if (scroll.props.showsVerticalScrollIndicator !== false) return true;
  resetScrollMocks(scroll);
  act(() => {
    scroll.props.onLayout?.({
      nativeEvent: { layout: { x: 0, y: 0, width: 375, height: 500 } },
    });
  });
  act(() => {
    find().props.onContentSizeChange?.(375, 900);
  });
  scroll = find();
  return (
    scroll.props.showsVerticalScrollIndicator !== false ||
    scrolledOrFlashed(scroll)
  );
}

/** SignIn: y (from the top of the physical screen) at which each block
 * starts, using the candidate's own line counts (hero 2, sub 4, error 3). */
function signInModel(scale: number, errorLines: number) {
  let y = SE_TOP_INSET + SCREEN_HEADER + space.lg;
  y += Math.max(BRAND_MARK_IMAGE, type.h3.lineHeight * scale); // BrandMark row
  y += space.xl + type.hero.lineHeight * 2 * scale; // title
  y += space.sm + type.body.lineHeight * 4 * scale; // sub
  y += space.xl; // providers marginTop
  const appleTop = y;
  y += Math.max(PROVIDER_BUTTON, type.bodyBold.lineHeight * scale);
  y += PROVIDER_GAP;
  const googleTop = y;
  y += Math.max(PROVIDER_BUTTON, type.bodyBold.lineHeight * scale);
  const errorCardTop = y + space.md;
  y = errorCardTop + space.md; // card padding
  y += type.micro.lineHeight * scale + 4; // "SIGN-IN FAILED"
  const errorMessageTop = y;
  y += type.caption.lineHeight * errorLines * scale;
  const errorMessageBottom = y;
  const errorCardBottom = y + space.md;
  return {
    appleTop,
    googleTop,
    errorCardTop,
    errorMessageTop,
    errorMessageBottom,
    errorCardBottom,
  };
}

/** Welcome pinned footer height, from the candidate's own model but with
 * the REAL AX3 multiplier. */
function welcomeFooter(scale: number) {
  const footnoteLines = scale > 1.6 ? 4 : 2;
  return (
    space.lg +
    Math.max(56, type.bodyBold.lineHeight * scale + 2) +
    space.xs +
    Math.max(44, type.bodyBold.lineHeight * scale) +
    space.md +
    type.caption.lineHeight * footnoteLines * scale +
    space.sm
  );
}

describe('A — parity with 4d812e1a: copy and accessibility surface unchanged', () => {
  // Captured by rendering the 4d812e1a screens with the same mocks
  // (busy=true, error shown) and dumping every Text node in tree order.
  const WELCOME_TEXTS = [
    'Pickle Sensei',
    'PRIVATE BY DEFAULT',
    'See the stroke.\nKnow the fix.',
    'A private technique coach that guides each capture and turns validated reads into one clear next step.',
    'POSE-GUIDED',
    'Automatic\ncapture.',
    'No shot picker. No timer.',
    'ON-DEVICE',
    'Start your first read',
    'I already have an account',
    'Two successful validated ratings free · Unscored attempts don’t count',
  ];
  const SIGN_IN_TEXTS = [
    'Pickle Sensei',
    'Your ratings,\ntied to you.',
    'A connected account is required for free ratings, membership, and server-verified coaching. Synced progress stays with that account.',
    '\uF8FF', // Apple logo glyph (private-use) on the Apple provider mark
    'Continue with Apple',
    'G',
    'Continue with Google',
    'Signing in securely…',
    'SIGN-IN FAILED',
    'ERRMSG',
    'Your existing on-device reads stay here when you connect.',
  ];

  test('Welcome renders exactly the 4d812e1a strings, in order', () => {
    const tree = render(
      <WelcomeScreen onGetStarted={() => {}} onSignIn={() => {}} />,
    );
    expect(texts(tree.root)).toEqual(WELCOME_TEXTS);
    expect(a11yLabels(tree.root)).toEqual([
      'image|Pickle Sensei|',
      'button|Start your first read|',
      'button|I already have an account|Sign in to an existing account',
    ]);
  });

  test('SignIn renders exactly the 4d812e1a strings, in order (busy + error)', () => {
    authState.busy = true;
    authState.error = { code: 'auth.failed', message: 'ERRMSG' };
    const tree = render(<SignInScreen onBack={() => {}} />);
    expect(texts(tree.root)).toEqual(SIGN_IN_TEXTS);
    expect(a11yLabels(tree.root)).toEqual([
      'button|Back|',
      'image|Pickle Sensei|',
      'button|Continue with Apple|',
      'button|Continue with Google|',
      'button|Dismiss sign-in error|ERRMSG',
    ]);
    authState.busy = false;
    authState.error = null;
  });
});

describe('B — tall phones: the flexGrow chain still pins bottoms like flex:1 did', () => {
  test('Welcome: ScrollView content grows, CourtStory grows, footer is a sibling', () => {
    const tree = render(
      <WelcomeScreen onGetStarted={() => {}} onSignIn={() => {}} />,
    );
    const [scroll] = tree.root.findAllByType(ScrollView);
    expect(flat(scroll!)).toMatchObject({ flex: 1 });
    expect(
      StyleSheet.flatten(scroll!.props.contentContainerStyle),
    ).toMatchObject({ flexGrow: 1 });
    const court = tree.root.find(
      n =>
        typeof n.type === 'string' && n.props.testID === 'welcome-court-story',
    );
    expect(flat(court)).toMatchObject({ flexGrow: 1 });
    // Every ancestor of CourtStory up to the ScrollView content lets it grow.
    let node: ReactTestInstance | null = court.parent;
    while (node && node.type !== ScrollView) {
      const s = node.props.style ? flat(node) : {};
      if (s.flexGrow !== undefined) expect(s.flexGrow).toBe(1);
      node = node.parent;
    }
  });

  test('SignIn: body flexGrow:1 inside a flexGrow:1 content container pushes the trust note to the bottom', () => {
    const tree = render(<SignInScreen onBack={() => {}} />);
    const [scroll] = tree.root.findAllByType(ScrollView);
    expect(
      StyleSheet.flatten(scroll!.props.contentContainerStyle),
    ).toMatchObject({ flexGrow: 1 });
    const body = tree.root.find(
      n => typeof n.type === 'string' && n.props.testID === 'sign-in-body',
    );
    expect(flat(body)).toMatchObject({ flexGrow: 1 });
  });
});

describe('C — SignIn on iPhone SE: the scroll is load-bearing but silent', () => {
  test('at xxLarge (a standard, non-accessibility size) the failure message lands below the fold', () => {
    const m = signInModel(RN_IOS_FONT_SCALE.xxLarge, 3);
    // Both providers still fit…
    expect(m.googleTop + PROVIDER_BUTTON).toBeLessThanOrEqual(SE_HEIGHT);
    // …but the error message text is (at least partly) off the bottom edge.
    expect(m.errorMessageBottom).toBeGreaterThan(SE_HEIGHT);
  });

  test('at AX1 the Google button is already clipped; at AX3 (2.643) BOTH providers start below the fold — the primary action is scroll-only', () => {
    const ax1 = signInModel(RN_IOS_FONT_SCALE.ax1, 0);
    expect(ax1.googleTop + PROVIDER_BUTTON).toBeGreaterThan(SE_HEIGHT);
    const ax3 = signInModel(RN_IOS_FONT_SCALE.ax3, 0);
    expect(ax3.appleTop).toBeGreaterThan(SE_HEIGHT);
    expect(ax3.googleTop).toBeGreaterThan(SE_HEIGHT);
  });

  test('a ScrollView that is the only way to reach the primary action or the error must advertise overflow', () => {
    authState.error = { code: 'auth.failed', message: APPLE_ERROR };
    const tree = render(<SignInScreen onBack={() => {}} />);
    expect(tree.root.findAllByType(ScrollView)).toHaveLength(1);
    // The candidate hard-codes showsVerticalScrollIndicator={false}, wires
    // no onContentSizeChange/onLayout, and holds no ref — so at xxLarge+ on
    // an SE the sign-in failure is rendered where nothing points at it, and
    // at AX sizes the providers themselves are reachable only by a blind
    // scroll. OnboardingScreen's LockedScroll (the neighbouring pre-auth
    // step) already shows the indicator exactly when content overflows.
    expect(advertisesOverflow(tree)).toBe(true);
    authState.error = null;
  });

  test('an error that arrives after the providers is scrolled into view', () => {
    authState.error = null;
    const tree = render(<SignInScreen onBack={() => {}} />);
    const [scroll] = tree.root.findAllByType(ScrollView);
    resetScrollMocks(scroll!);
    act(() => {
      authState.error = { code: 'auth.failed', message: APPLE_ERROR };
      tree.update(<SignInScreen onBack={() => {}} />);
    });
    const card = tree.root.findAll(
      n => n.props.accessibilityLabel === 'Dismiss sign-in error',
    );
    expect(card).not.toHaveLength(0);
    // The screen never calls scrollTo / scrollToEnd / flashScrollIndicators
    // when the card mounts; the modelled xxLarge layout puts it off-screen
    // and accessibilityLiveRegion is Android-only, so iOS gets no signal.
    expect(scrolledOrFlashed(tree.root.findAllByType(ScrollView)[0]!)).toBe(
      true,
    );
    authState.error = null;
  });
});

describe('D — Welcome on iPhone SE', () => {
  test('the pinned footer still fits at the REAL AX3 multiplier (2.643, not the 2.35 the acceptance test uses) and at AX5', () => {
    // Acceptance test's constant is not an iOS content size category value:
    // RCTAccessibilityManager.mm maps AccessibilityExtraLarge to 2.643.
    expect(welcomeFooter(RN_IOS_FONT_SCALE.ax3)).toBeLessThan(SE_VIEWPORT);
    expect(welcomeFooter(RN_IOS_FONT_SCALE.ax5)).toBeLessThan(SE_VIEWPORT);
  });

  test('the body ScrollView overflows at xxLarge (per the candidate model) yet hides every overflow cue', () => {
    const tree = render(
      <WelcomeScreen onGetStarted={() => {}} onSignIn={() => {}} />,
    );
    expect(tree.root.findAllByType(ScrollView)).toHaveLength(1);
    expect(advertisesOverflow(tree)).toBe(true);
  });
});
