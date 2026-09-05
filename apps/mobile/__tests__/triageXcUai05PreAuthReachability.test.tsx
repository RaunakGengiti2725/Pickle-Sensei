/**
 * Triage pins for xc-ux-a11y-i18n::XC-UAI-05 (Welcome / SignIn primary
 * action reachability at every Dynamic Type size on 375×667).
 *
 * Pins what the finding's acceptance criteria demand and Linux can prove:
 *  - each pre-auth screen's primary action is reachable: either it has a
 *    ScrollView/FlatList ancestor, or it lives in a sibling footer rendered
 *    AFTER a flex:1 ScrollView (pinned, never pushed off by the body);
 *  - SignIn's provider buttons scroll with the body (ScrollView ancestor);
 *  - Welcome's pinned footer fits the SE viewport at 1.0×, xxLarge and AX3
 *    even if the footnote wraps to six lines;
 *  - the AGENTS.md typography canon for pre-auth landings is intact:
 *    `type.hero` title, `type.body` sub with marginTop space.sm, maxWidth 340.
 *
 * Run: cd apps/mobile && npx jest --ci __tests__/triageXcUai05PreAuthReachability.test.tsx
 */
import React from 'react';
import { FlatList, ScrollView, StyleSheet } from 'react-native';
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
    error: null,
    signInWithApple: jest.fn(),
    signInWithGoogle: jest.fn(),
    clearError: jest.fn(),
  }),
}));

function hasScrollAncestor(node: ReactTestInstance): boolean {
  let cur: ReactTestInstance | null = node.parent;
  while (cur) {
    if (cur.type === ScrollView || cur.type === FlatList) return true;
    cur = cur.parent;
  }
  return false;
}

function byLabel(root: ReactTestInstance, label: string) {
  const found = root.findAll(n => n.props.accessibilityLabel === label);
  expect(found.length).toBeGreaterThan(0);
  return found[0]!;
}

/** Text nodes whose (possibly segmented) children join to `text`. */
function byText(root: ReactTestInstance, text: string) {
  const found = root.findAll(n => {
    const children: unknown = n.props.children;
    const joined = Array.isArray(children)
      ? children.every(c => typeof c === 'string')
        ? children.join('')
        : null
      : children;
    return joined === text;
  });
  expect(found.length).toBeGreaterThan(0);
  return found[0]!;
}

function flat(instance: ReactTestInstance) {
  return StyleSheet.flatten(instance.props.style) as Record<string, unknown>;
}

/** True when `node` sits in a sibling of `scroll` rendered after it. */
function pinnedAfter(scroll: ReactTestInstance, node: ReactTestInstance) {
  const container = scroll.parent!;
  let cur: ReactTestInstance | null = node;
  while (cur && cur.parent !== container) cur = cur.parent;
  if (!cur) return false;
  const kids = container.children.filter(
    (c): c is ReactTestInstance => typeof c !== 'string',
  );
  return kids.indexOf(cur) > kids.indexOf(scroll);
}

const SE_VIEWPORT = 667 - 20;
const CTA = 56;
const LINK = 44;

/** Welcome pinned footer: CTA, sign-in link, footnote at `lines` lines. */
function welcomeFooter(scale: number, footnoteLines: number) {
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

describe('Welcome', () => {
  let tree: TestRenderer.ReactTestRenderer;
  beforeAll(() => {
    act(() => {
      tree = TestRenderer.create(
        <WelcomeScreen onGetStarted={() => {}} onSignIn={() => {}} />,
      );
    });
  });

  test('primary CTA and sign-in link are reachable: ScrollView ancestor, or a footer pinned after the flex:1 ScrollView', () => {
    const cta = byLabel(tree.root, 'Start your first read');
    const link = byLabel(tree.root, 'I already have an account');
    const scrolls = tree.root.findAllByType(ScrollView);
    expect(scrolls).toHaveLength(1);
    const scroll = scrolls[0]!;
    expect(flat(scroll)).toMatchObject({ flex: 1 });
    expect(
      StyleSheet.flatten(scroll.props.contentContainerStyle),
    ).toMatchObject({ flexGrow: 1 });
    expect(hasScrollAncestor(cta) || pinnedAfter(scroll, cta)).toBe(true);
    expect(hasScrollAncestor(link) || pinnedAfter(scroll, link)).toBe(true);
  });

  test('the body (hero copy and CourtStory) scrolls; CourtStory pins no fixed height', () => {
    const hero = byText(tree.root, 'See the stroke.\nKnow the fix.');
    expect(hasScrollAncestor(hero)).toBe(true);
    const [court] = tree.root.findAll(
      n =>
        typeof n.type === 'string' && n.props.testID === 'welcome-court-story',
    );
    expect(court).toBeDefined();
    expect(hasScrollAncestor(court!)).toBe(true);
    const s = flat(court!);
    expect(s.minHeight).toBeUndefined();
    expect(s.height).toBeUndefined();
    expect(s.maxHeight).toBeUndefined();
  });

  test('model: pinned footer fits 375×667 at 1.0×, xxLarge and AX3 even with a six-line footnote', () => {
    for (const scale of [1, 1.235, 2.35]) {
      expect(welcomeFooter(scale, 6)).toBeLessThan(SE_VIEWPORT);
    }
  });

  test('typography canon: type.hero title, type.body sub (marginTop space.sm, maxWidth 340)', () => {
    const hero = byText(tree.root, 'See the stroke.\nKnow the fix.');
    expect(flat(hero)).toMatchObject(type.hero);
    const sub = byText(
      tree.root,
      'A private technique coach that guides each capture and turns validated reads into one clear next step.',
    );
    expect(flat(sub)).toMatchObject({
      ...type.body,
      marginTop: space.sm,
      maxWidth: 340,
    });
  });
});

describe('SignIn', () => {
  let tree: TestRenderer.ReactTestRenderer;
  beforeAll(() => {
    act(() => {
      tree = TestRenderer.create(<SignInScreen onBack={() => {}} />);
    });
  });

  test('provider buttons have a ScrollView ancestor; Back is pinned outside it', () => {
    const scrolls = tree.root.findAllByType(ScrollView);
    expect(scrolls).toHaveLength(1);
    const scroll = scrolls[0]!;
    expect(flat(scroll)).toMatchObject({ flex: 1 });
    expect(
      StyleSheet.flatten(scroll.props.contentContainerStyle),
    ).toMatchObject({ flexGrow: 1 });
    expect(hasScrollAncestor(byLabel(tree.root, 'Continue with Apple'))).toBe(
      true,
    );
    expect(hasScrollAncestor(byLabel(tree.root, 'Continue with Google'))).toBe(
      true,
    );
    const back = byLabel(tree.root, 'Back');
    expect(hasScrollAncestor(back)).toBe(false);
    expect(pinnedAfter(scroll, back)).toBe(false); // header, rendered before
  });

  test('typography canon: type.hero title, type.body sub (marginTop space.sm, maxWidth 340)', () => {
    const hero = byText(tree.root, 'Your ratings,\ntied to you.');
    expect(flat(hero)).toMatchObject(type.hero);
    const sub = byText(
      tree.root,
      'A connected account is required for free ratings, membership, and server-verified coaching. Synced progress stays with that account.',
    );
    expect(flat(sub)).toMatchObject({
      ...type.body,
      marginTop: space.sm,
      maxWidth: 340,
    });
  });
});
