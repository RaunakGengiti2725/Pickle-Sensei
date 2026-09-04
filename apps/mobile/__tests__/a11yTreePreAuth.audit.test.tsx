/**
 * Static RN-tree accessibility audit for the four pre-auth screens
 * (Welcome, Splash, SignIn, Onboarding — all 8 steps, busy/error states,
 * long Cyrillic/CJK/Arabic/German names).
 *
 * The rendered trees are walked for every host element that is a control
 * (has onPress / is a TextInput) or an accessible image, and the audit pins:
 *   - every control has an accessible name (accessibilityLabel or descendant
 *     text) and an accessibilityRole;
 *   - every accessible image has a label;
 *   - static minimum sizes (minHeight/height/width + hitSlop) reach 44pt
 *     where the style declares them (geometry is INFERRED from styles here;
 *     the measured numbers come from tools/ux-audit, the Chromium harness);
 *   - the progress bar exposes min/max/now on every step, radios expose
 *     `selected`, error cards are assertive live regions.
 *
 * Evidence: the full ledger (per screen/state: controls, roles, labels,
 * static sizes, images) is written to
 * `artifacts/ux-audit/static-a11y-tree.json` (override with
 * UX_AUDIT_STATIC_OUT) so it can be attached to the audit report. Writing the
 * file is best-effort; assertions never depend on it.
 */
import React from 'react';
import { Platform, StyleSheet, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';

// The mobile tsconfig has no node types; the evidence writer uses the same
// CommonJS seam as fix-9-privacyManifestCollectedData.test.ts.
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
};
const { dirname, join } = require('path') as {
  dirname: (file: string) => string;
  join: (...parts: string[]) => string;
};

jest.mock('react-native-safe-area-context', () => {
  const { View: RNView } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: RNView,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

jest.mock('react-native-svg', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { View: RNView } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(RNView, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});

const appState = {
  completeOnboarding: () => Promise.resolve(),
  completePreAuthOnboarding: () => Promise.resolve(true),
  onboardingBusy: false,
  onboardingError: null as string | null,
};
jest.mock('../src/state/appStore', () => {
  const { focusForGoal } = jest.requireActual<
    typeof import('../src/state/profile')
  >('../src/state/profile');
  return {
    focusForGoal,
    useAppStore: (selector: (s: typeof appState) => unknown) =>
      selector(appState),
  };
});

const authState = {
  busy: false,
  error: null as { code: string; message: string } | null,
  signInWithApple: () => Promise.resolve(),
  signInWithGoogle: () => Promise.resolve(),
  clearError: () => undefined,
  signOut: () => Promise.resolve(),
};
jest.mock('../src/auth/authStore', () => ({
  useAuthStore: (selector?: (s: typeof authState) => unknown) =>
    selector ? selector(authState) : authState,
}));

jest.mock('../src/notifications/notificationStore', () => {
  const state = {
    completeOnboardingStep: () => Promise.resolve(true),
    onboardingBusy: false,
    onboardingError: null,
  };
  return {
    useNotificationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

import { WelcomeScreen } from '../src/screens/WelcomeScreen';
import { SplashScreen } from '../src/screens/SplashScreen';
import { SignInScreen } from '../src/screens/SignInScreen';
import { OnboardingScreen } from '../src/screens/OnboardingScreen';

const MIN_TARGET = 44;

const LONG_NAMES = {
  german40: 'Donaudampfschifffahrtsgesellschaftskapit',
  cjk40:
    '匹克球教练匹克球教练匹克球教练匹克球教练匹克球教练匹克球教练匹克球教练匹克球教练',
  arabic40: 'محمد عبد الرحمن بن عبد العزيز آل سعود ال',
  cyrillic40: 'Александровнаконстантинопольскаяпетровна',
};

const LONG_ERROR =
  'Не удалось завершить вход через выбранного поставщика удостоверений, потому что сервер вернул неожиданный ответ. Попробуйте ещё раз через несколько минут.';

interface ControlRecord {
  kind: 'pressable' | 'textinput';
  role: string | null;
  label: string | null;
  name: string;
  hint: string | null;
  state: Record<string, unknown> | null;
  value: Record<string, unknown> | null;
  liveRegion: string | null;
  disabled: boolean;
  testID: string | null;
  hitSlop: unknown;
  staticMinHeight: number | null;
  staticMinWidth: number | null;
  staticHeight: number | null;
  staticWidth: number | null;
}

interface ImageRecord {
  label: string | null;
  accessible: boolean;
  hidden: boolean;
  hasSource: boolean;
  testID: string | null;
}

interface ScreenLedger {
  screen: string;
  state: string;
  controls: ControlRecord[];
  images: ImageRecord[];
  progressbar: Record<string, unknown> | null;
  liveRegions: string[];
  /** Pressables with accessible={false} (dialog backdrops) — not VoiceOver
   * elements, listed so the count is visible in the evidence. */
  nonAccessiblePressables: number;
  textCount: number;
}

const ledger: ScreenLedger[] = [];

function isHost(node: ReactTestInstance): boolean {
  return typeof node.type === 'string';
}

function hostType(node: ReactTestInstance): string | null {
  return typeof node.type === 'string' ? node.type : null;
}

function flatten(style: unknown): Record<string, unknown> {
  return (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function descendantText(node: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (n: ReactTestInstance) => {
    for (const child of n.children) {
      if (typeof child === 'string') parts.push(child);
      else walk(child);
    }
  };
  walk(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** The nearest host ancestor that carries the composite's a11y props. */
function hostAncestorProps(node: ReactTestInstance): Record<string, unknown> {
  let cursor: ReactTestInstance | null = node;
  while (cursor && !isHost(cursor)) cursor = cursor.parent;
  return (cursor?.props ?? {}) as Record<string, unknown>;
}

function isHiddenFromA11y(node: ReactTestInstance): boolean {
  let cursor: ReactTestInstance | null = node;
  while (cursor) {
    const p = cursor.props as Record<string, unknown>;
    if (
      p.accessibilityElementsHidden === true ||
      p.importantForAccessibility === 'no-hide-descendants' ||
      p['aria-hidden'] === true
    ) {
      return true;
    }
    cursor = cursor.parent;
  }
  return false;
}

/**
 * Controls are host Views that got an onPress/onClick through Pressable
 * (RN's Pressable renders a host View with `onClick` + a11y props) and every
 * TextInput host element.
 */
function collect(
  renderer: TestRenderer.ReactTestRenderer,
  screen: string,
  state: string,
): ScreenLedger {
  const controls: ControlRecord[] = [];
  const images: ImageRecord[] = [];
  const liveRegions: string[] = [];
  let progressbar: Record<string, unknown> | null = null;
  let nonAccessiblePressables = 0;

  const hosts = renderer.root.findAll(isHost);
  for (const node of hosts) {
    const p = node.props as Record<string, unknown>;
    if (isHiddenFromA11y(node)) continue;
    if (p.accessible === false && typeof p.onClick === 'function') {
      nonAccessiblePressables += 1;
      continue;
    }
    const style = flatten(p.style);

    if (p.accessibilityRole === 'progressbar') {
      progressbar = {
        label: p.accessibilityLabel ?? null,
        value: p.accessibilityValue ?? null,
      };
    }
    if (typeof p.accessibilityLiveRegion === 'string') {
      liveRegions.push(
        `${p.accessibilityLiveRegion}:${String(p.accessibilityLabel ?? descendantText(node)).slice(0, 60)}`,
      );
    }

    const isTextInput = hostType(node) === 'TextInput';
    const isPressable =
      typeof p.onClick === 'function' ||
      typeof p.onPress === 'function' ||
      typeof p.onResponderRelease === 'function';
    if (isTextInput || isPressable) {
      const label =
        typeof p.accessibilityLabel === 'string' ? p.accessibilityLabel : null;
      const text = isTextInput
        ? String(p.value || p.placeholder || '')
        : descendantText(node);
      const slop = p.hitSlop;
      controls.push({
        kind: isTextInput ? 'textinput' : 'pressable',
        role:
          typeof p.accessibilityRole === 'string'
            ? p.accessibilityRole
            : typeof p.role === 'string'
              ? p.role
              : null,
        label,
        name: label ?? text,
        hint:
          typeof p.accessibilityHint === 'string' ? p.accessibilityHint : null,
        state: (p.accessibilityState as Record<string, unknown>) ?? null,
        value: (p.accessibilityValue as Record<string, unknown>) ?? null,
        liveRegion:
          typeof p.accessibilityLiveRegion === 'string'
            ? p.accessibilityLiveRegion
            : null,
        disabled:
          p.disabled === true ||
          (p.accessibilityState as { disabled?: boolean } | undefined)
            ?.disabled === true,
        testID: typeof p.testID === 'string' ? p.testID : null,
        hitSlop: slop ?? null,
        staticMinHeight: num(style.minHeight),
        staticMinWidth: num(style.minWidth),
        staticHeight: num(style.height),
        staticWidth: num(style.width),
      });
    }

    if (hostType(node) === 'Image') {
      const owner = hostAncestorProps(node.parent ?? node);
      images.push({
        label:
          typeof p.accessibilityLabel === 'string'
            ? p.accessibilityLabel
            : typeof owner.accessibilityLabel === 'string'
              ? owner.accessibilityLabel
              : null,
        accessible: p.accessible === true || owner.accessible === true,
        hidden: isHiddenFromA11y(node),
        hasSource: p.source != null,
        testID: typeof p.testID === 'string' ? p.testID : null,
      });
    }
  }
  const textCount = renderer.root.findAllByType(Text).length;
  const record: ScreenLedger = {
    screen,
    state,
    controls,
    images,
    progressbar,
    liveRegions,
    nonAccessiblePressables,
    textCount,
  };
  ledger.push(record);
  return record;
}

function assertControls(record: ScreenLedger) {
  for (const c of record.controls) {
    // Name + role are the VoiceOver contract.
    expect({
      screen: record.screen,
      state: record.state,
      c,
      hasName: c.name.length > 0,
    }).toMatchObject({ hasName: true });
    if (c.kind === 'pressable') {
      expect({
        screen: record.screen,
        state: record.state,
        name: c.name,
        role: c.role,
      }).not.toMatchObject({ role: null });
    }
    // Static size: when the style declares a height/minHeight it must be ≥44
    // or be topped up by hitSlop. Undeclared sizes are measured by the
    // Chromium harness, not here.
    const slopY =
      typeof c.hitSlop === 'number'
        ? c.hitSlop * 2
        : c.hitSlop && typeof c.hitSlop === 'object'
          ? ((c.hitSlop as { top?: number }).top ?? 0) +
            ((c.hitSlop as { bottom?: number }).bottom ?? 0)
          : 0;
    const declaredH = c.staticMinHeight ?? c.staticHeight;
    if (declaredH !== null) {
      expect({
        screen: record.screen,
        state: record.state,
        name: c.name,
        effectiveHeight: declaredH + slopY,
      }).toMatchObject({ effectiveHeight: expect.any(Number) });
      expect(declaredH + slopY).toBeGreaterThanOrEqual(MIN_TARGET);
    }
  }
  for (const img of record.images) {
    if (img.accessible && !img.hidden) {
      expect({ screen: record.screen, state: record.state, img }).toMatchObject(
        {
          img: { label: expect.any(String) },
        },
      );
    }
  }
}

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function press(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const nodes = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
  expect(nodes.length).toBeGreaterThan(0);
  expect(nodes[0]!.props.disabled).toBeFalsy();
  act(() => {
    nodes[0]!.props.onPress();
  });
}

function typeName(renderer: TestRenderer.ReactTestRenderer, value: string) {
  act(() => renderer.root.findByType(TextInput).props.onChangeText(value));
}

afterAll(() => {
  const out =
    process.env.UX_AUDIT_STATIC_OUT ??
    join(
      __dirname,
      '..',
      '..',
      '..',
      'artifacts',
      'ux-audit',
      'static-a11y-tree.json',
    );
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      JSON.stringify(
        {
          generatedBy: '__tests__/a11yTreePreAuth.audit.test.tsx',
          platform: Platform.OS,
          minTarget: MIN_TARGET,
          screens: ledger,
        },
        null,
        1,
      ),
    );
  } catch {
    // Evidence file is best-effort (read-only CI checkouts).
  }
});

beforeEach(() => {
  appState.onboardingBusy = false;
  appState.onboardingError = null;
  authState.busy = false;
  authState.error = null;
});

describe('pre-auth a11y tree audit', () => {
  it('WelcomeScreen: both CTAs named + role button, brand image labeled', () => {
    const renderer = render(
      <WelcomeScreen
        onGetStarted={() => undefined}
        onSignIn={() => undefined}
      />,
    );
    const record = collect(renderer, 'welcome', 'default');
    assertControls(record);
    const names = record.controls.map(c => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Start your first read',
        'I already have an account',
      ]),
    );
    expect(record.images.some(i => i.label === 'Pickle Sensei')).toBe(true);
    act(() => renderer.unmount());
  });

  it('WelcomeScreen without onSignIn: no dead sign-in target remains', () => {
    const renderer = render(<WelcomeScreen onGetStarted={() => undefined} />);
    const record = collect(renderer, 'welcome', 'no-signin');
    assertControls(record);
    expect(record.controls.map(c => c.name)).not.toContain(
      'I already have an account',
    );
    act(() => renderer.unmount());
  });

  it('SplashScreen: video wrapper is a labeled image; Skip appears only after 1s and is ≥44pt', async () => {
    jest.useFakeTimers();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SplashScreen ready={true} onFinished={() => undefined} />,
      );
    });
    const before = collect(renderer, 'splash', 'before-1s');
    expect(
      before.controls.filter(c => c.testID === 'splash-skip'),
    ).toHaveLength(0);
    const wrapper = renderer.root.findAll(
      n =>
        isHost(n) &&
        n.props.accessibilityRole === 'image' &&
        n.props.accessibilityLabel === 'Pickle Sensei intro animation',
    );
    expect(wrapper.length).toBeGreaterThan(0);

    const video = renderer.root.findAll(
      n => n.props.testID === 'splash-video' && isHost(n),
    )[0]!;
    await act(async () => {
      video.props.onProgress({
        currentTime: 1.5,
        playableDuration: 5,
        seekableDuration: 5,
      });
    });
    const after = collect(renderer, 'splash', 'after-1s-skip-visible');
    assertControls(after);
    const skip = after.controls.find(c => c.testID === 'splash-skip');
    expect(skip).toBeDefined();
    expect(skip!.name).toBe('Skip intro');
    expect(skip!.role).toBe('button');
    expect(
      (skip!.staticMinHeight ?? skip!.staticHeight ?? 0) + 2 * 12,
    ).toBeGreaterThanOrEqual(MIN_TARGET);
    await act(async () => {
      renderer.unmount();
    });
    jest.useRealTimers();
  });

  it('SignInScreen idle: Back + two providers named, roles button, no unlabeled images', () => {
    const renderer = render(<SignInScreen onBack={() => undefined} />);
    const record = collect(renderer, 'signin', 'idle');
    assertControls(record);
    const names = record.controls.map(c => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Back',
        'Continue with Apple',
        'Continue with Google',
      ]),
    );
    act(() => renderer.unmount());
  });

  it('SignInScreen busy: providers disabled via accessibilityState/disabled, still named', () => {
    authState.busy = true;
    const renderer = render(<SignInScreen onBack={() => undefined} />);
    const record = collect(renderer, 'signin', 'busy');
    assertControls(record);
    const providers = record.controls.filter(c =>
      c.name.startsWith('Continue with'),
    );
    expect(providers.length).toBe(2);
    for (const p of providers) expect(p.disabled).toBe(true);
    act(() => renderer.unmount());
  });

  it('SignInScreen long Cyrillic error: dismiss control is an assertive live region carrying the message as hint', () => {
    authState.error = { code: 'auth.failed', message: LONG_ERROR };
    const renderer = render(<SignInScreen onBack={() => undefined} />);
    const record = collect(renderer, 'signin', 'error-cyrillic');
    assertControls(record);
    const dismiss = record.controls.find(
      c => c.name === 'Dismiss sign-in error',
    );
    expect(dismiss).toBeDefined();
    expect(dismiss!.liveRegion).toBe('assertive');
    expect(dismiss!.hint).toBe(LONG_ERROR);
    // The message itself is rendered (no numberOfLines truncation prop).
    const messageNodes = renderer.root.findAll(
      n =>
        hostType(n) === 'Text' &&
        typeof n.props.children === 'string' &&
        n.props.children === LONG_ERROR,
    );
    expect(messageNodes.length).toBe(1);
    expect(messageNodes[0]!.props.numberOfLines).toBeUndefined();
    act(() => renderer.unmount());
  });

  it('OnboardingScreen: every step exposes progressbar min/max/now, named+role controls, radios with selected state', () => {
    const renderer = render(
      <OnboardingScreen
        onFinished={() => undefined}
        onBack={() => undefined}
      />,
    );
    const steps: Array<{ name: string; choose?: string }> = [
      { name: 'name' },
      { name: 'gender', choose: 'Female' },
      { name: 'level', choose: '3.5' },
      { name: 'handedness', choose: 'Right-handed' },
      { name: 'goal', choose: 'Third-shot drops' },
      { name: 'problem', choose: 'Control' },
      { name: 'reveal' },
      { name: 'notifications' },
    ];
    steps.forEach((step, index) => {
      const record = collect(
        renderer,
        'onboarding',
        `step-${index + 1}-${step.name}`,
      );
      assertControls(record);
      expect(record.progressbar).toEqual({
        label: `Onboarding step ${index + 1} of 8`,
        value: { min: 1, max: 8, now: index + 1 },
      });
      if (step.choose) {
        const radios = record.controls.filter(c => c.role === 'radio');
        expect(radios.length).toBeGreaterThanOrEqual(2);
        for (const r of radios) {
          expect(r.state).toEqual({ selected: false });
        }
        press(renderer, step.choose);
        const afterChoice = collect(
          renderer,
          'onboarding',
          `step-${index + 1}-${step.name}-selected`,
        );
        const selected = afterChoice.controls.filter(
          c => c.role === 'radio' && c.state?.selected === true,
        );
        expect(selected.map(c => c.name)).toEqual([step.choose]);
      }
      if (step.name === 'name') {
        const input = record.controls.find(c => c.kind === 'textinput');
        expect(input?.label).toBe('First name');
        typeName(renderer, 'Sam');
      }
      if (index < steps.length - 1) press(renderer, 'Continue');
    });
    const last = collect(
      renderer,
      'onboarding',
      'step-8-notifications-controls',
    );
    expect(last.controls.map(c => c.name)).toEqual(
      expect.arrayContaining(['Turn on reminders', 'Not now', 'Back']),
    );
    act(() => renderer.unmount());
  });

  it.each(Object.entries(LONG_NAMES))(
    'OnboardingScreen name step + reveal with %s: value kept whole (maxLength 40) and read back',
    (_key, value) => {
      const renderer = render(
        <OnboardingScreen
          onFinished={() => undefined}
          onBack={() => undefined}
        />,
      );
      typeName(renderer, value);
      const input = renderer.root.findByType(TextInput);
      expect(input.props.value).toBe(value);
      expect(input.props.maxLength).toBe(40);
      expect([...value].length).toBeLessThanOrEqual(40);
      const record = collect(renderer, 'onboarding', `name-${_key}`);
      assertControls(record);
      press(renderer, 'Continue');
      press(renderer, 'Female');
      press(renderer, 'Continue');
      press(renderer, '3.5');
      press(renderer, 'Continue');
      press(renderer, 'Right-handed');
      press(renderer, 'Continue');
      press(renderer, 'Third-shot drops');
      press(renderer, 'Continue');
      press(renderer, 'Control');
      press(renderer, 'Continue');
      const reveal = collect(renderer, 'onboarding', `reveal-${_key}`);
      assertControls(reveal);
      const builtFor = renderer.root.findAll(
        n =>
          hostType(n) === 'Text' &&
          Array.isArray(n.props.children) &&
          n.props.children.join('') === `Built for ${value}.`,
      );
      expect(builtFor.length).toBe(1);
      expect(builtFor[0]!.props.numberOfLines).toBeUndefined();
      act(() => renderer.unmount());
    },
  );

  it('OnboardingScreen account mode: Leave setup opens a modal dialog whose controls are named; backdrop is accessible={false}', () => {
    const renderer = render(
      <OnboardingScreen
        mode="account"
        onFinished={() => undefined}
        onBack={() => undefined}
      />,
    );
    const before = collect(renderer, 'onboarding', 'account-name');
    assertControls(before);
    expect(before.controls.map(c => c.name)).toContain('Leave setup');
    press(renderer, 'Leave setup');
    const dialog = collect(renderer, 'onboarding', 'account-leave-dialog');
    assertControls(dialog);
    expect(dialog.controls.map(c => c.name)).toEqual(
      expect.arrayContaining(['Close dialog', 'Keep setting up', 'Sign out']),
    );
    const modalViews = renderer.root.findAll(
      n => isHost(n) && n.props.accessibilityViewIsModal === true,
    );
    expect(modalViews.length).toBe(1);
    expect(dialog.nonAccessiblePressables).toBeGreaterThanOrEqual(1);
    act(() => renderer.unmount());
  });

  it('OnboardingScreen onboarding error: message rendered whole beside the CTA', () => {
    appState.onboardingError =
      'Authentifizierungsdienstkonfigurationsfehler: Die Anmeldeinformationsüberprüfungsinfrastruktur ist vorübergehend nicht erreichbar.';
    const renderer = render(
      <OnboardingScreen
        onFinished={() => undefined}
        onBack={() => undefined}
      />,
    );
    typeName(renderer, 'Sam');
    press(renderer, 'Continue');
    press(renderer, 'Female');
    press(renderer, 'Continue');
    press(renderer, '3.5');
    press(renderer, 'Continue');
    press(renderer, 'Right-handed');
    press(renderer, 'Continue');
    press(renderer, 'Third-shot drops');
    press(renderer, 'Continue');
    press(renderer, 'Control');
    press(renderer, 'Continue');
    press(renderer, 'Continue');
    const record = collect(
      renderer,
      'onboarding',
      'notifications-error-german',
    );
    assertControls(record);
    const errorText = renderer.root.findAll(
      n =>
        hostType(n) === 'Text' &&
        typeof n.props.children === 'string' &&
        n.props.children === appState.onboardingError,
    );
    expect(errorText.length).toBe(1);
    expect(errorText[0]!.props.numberOfLines).toBeUndefined();
    act(() => renderer.unmount());
  });

  it('no unlabeled Image anywhere in the four screens', () => {
    const unlabeled = ledger.flatMap(l =>
      l.images
        .filter(i => i.accessible && !i.hidden && !i.label)
        .map(i => `${l.screen}/${l.state}:${i.testID ?? '?'}`),
    );
    expect(unlabeled).toEqual([]);
    expect(ledger.some(l => l.images.length > 0)).toBe(true);
  });
});
