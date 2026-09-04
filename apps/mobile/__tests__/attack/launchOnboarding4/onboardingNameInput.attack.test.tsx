import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * ADVERSARIAL PASS 3 / tester #4 — scenario S8 against 4d812e1a.
 *
 * The name step of the REAL OnboardingScreen (pre-auth mode) is fed hostile
 * values straight through `onChangeText` — the JS seam that dictation,
 * autofill, and the test renderer all use, and which the native
 * `maxLength={40}` prop does NOT guard (that prop is enforced by the native
 * text view only; under jest there is no native view, so this exercises the
 * JS layer's own bounds). Assertions: Continue enables only for a trimmed
 * non-empty value, the stashed firstName is trimmed and bounded, and the
 * reveal copy never renders an empty "Built for ." line.
 *
 * Server contract for comparison (supabase/functions/api/index.ts:3054-3070):
 * `sanitizeUserText` strips control/zero-width/bidi chars, collapses
 * whitespace, and the result must be 1-40 chars or the PUT is 400.
 */

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: {
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  },
}));

const mockCompleteOnboarding = jest.fn<Promise<void>, [unknown]>(() =>
  Promise.resolve(),
);
const mockCompletePreAuthOnboarding = jest.fn<Promise<boolean>, [unknown]>(() =>
  Promise.resolve(true),
);
jest.mock('../../../src/state/appStore', () => {
  const { focusForGoal } = jest.requireActual<
    typeof import('../../../src/state/profile')
  >('../../../src/state/profile');
  const state = {
    completeOnboarding: (profile: unknown) => mockCompleteOnboarding(profile),
    completePreAuthOnboarding: (profile: unknown) =>
      mockCompletePreAuthOnboarding(profile),
    onboardingBusy: false,
    onboardingError: null,
  };
  return {
    focusForGoal,
    useAppStore: (selector: (s: typeof state) => unknown) => selector(state),
  };
});
jest.mock('../../../src/auth/authStore', () => {
  const state = { signOut: () => {} };
  return {
    useAuthStore: (selector: (s: typeof state) => unknown) => selector(state),
  };
});
const mockCompleteNotificationOnboarding = jest.fn<
  Promise<boolean>,
  ['enable' | 'not_now']
>(() => Promise.resolve(true));
jest.mock('../../../src/notifications/notificationStore', () => {
  const state = {
    completeOnboardingStep: (choice: 'enable' | 'not_now') =>
      mockCompleteNotificationOnboarding(choice),
  };
  return {
    useNotificationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

import { OnboardingScreen } from '../../../src/screens/OnboardingScreen';
import type { Profile } from '../../../src/state/profile';

type Renderer = TestRenderer.ReactTestRenderer;

const NAME_MAX = 40;

function renderPreAuth(onFinished = jest.fn()) {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(
      <OnboardingScreen
        mode="preauth"
        onFinished={onFinished}
        onBack={() => {}}
      />,
    );
  });
  return { renderer, onFinished };
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter(
      (c): c is string | number =>
        typeof c === 'string' || typeof c === 'number',
    )
    .map(String)
    .join('');
}

function findPressable(renderer: Renderer, label: string) {
  const nodes = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
  expect(nodes.length).toBeGreaterThan(0);
  return nodes[0]!;
}

function continueDisabled(renderer: Renderer): boolean {
  return Boolean(findPressable(renderer, 'Continue').props.disabled);
}

function typeName(renderer: Renderer, value: string) {
  act(() => renderer.root.findByType(TextInput).props.onChangeText(value));
}

function press(renderer: Renderer, label: string) {
  const node = findPressable(renderer, label);
  expect(node.props.disabled).toBeFalsy();
  act(() => node.props.onPress());
}

/** From the name step (already typed), walk to the reveal and finish. */
async function finishFromName(renderer: Renderer) {
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
  const revealText = allText(renderer);
  press(renderer, 'Continue');
  await act(async () => {
    findPressable(renderer, 'Not now').props.onPress();
    await Promise.resolve();
  });
  expect(mockCompletePreAuthOnboarding).toHaveBeenCalledTimes(1);
  const stashed = mockCompletePreAuthOnboarding.mock.calls[0]![0] as Profile;
  return { stashed, revealText };
}

// Server-equivalent sanitizer (supabase/functions/api/http.ts) used only to
// PREDICT what the backend would do with the client's stash. Kept literal so
// the comparison is auditable; not imported to avoid a Deno dependency.
const CONTROL_AND_SPOOFING =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
function predictServerAccepts(firstName: string | undefined): boolean {
  if (firstName === undefined) return true;
  const cleaned = firstName
    .replace(CONTROL_AND_SPOOFING, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length >= 1 && cleaned.length <= NAME_MAX;
}

beforeEach(() => {
  mockCompleteOnboarding.mockClear();
  mockCompletePreAuthOnboarding.mockClear();
  mockCompletePreAuthOnboarding.mockResolvedValue(true);
  mockCompleteNotificationOnboarding.mockClear();
  mockCompleteNotificationOnboarding.mockResolvedValue(true);
});

describe('S8 — hostile names on the onboarding name step', () => {
  it('Continue is disabled for empty and whitespace-only input (spaces, tabs, newlines, NBSP, ideographic space)', () => {
    const { renderer } = renderPreAuth();
    expect(continueDisabled(renderer)).toBe(true);
    for (const ws of [
      ' ',
      '   ',
      '\t\t',
      '\n\n',
      ' \n\t ',
      '\u00A0\u00A0',
      '\u3000',
      '\u2003\u2009',
      '\uFEFF',
    ]) {
      typeName(renderer, ws);
      expect(continueDisabled(renderer)).toBe(true);
    }
    typeName(renderer, ' D ');
    expect(continueDisabled(renderer)).toBe(false);
    typeName(renderer, '');
    expect(continueDisabled(renderer)).toBe(true);
    act(() => renderer.unmount());
  });

  it('a padded name is stashed trimmed and the reveal greets the trimmed name', async () => {
    const { renderer, onFinished } = renderPreAuth();
    typeName(renderer, '  \n Dana \t ');
    const { stashed, revealText } = await finishFromName(renderer);
    expect(stashed.firstName).toBe('Dana');
    expect(revealText).toContain('Built for Dana.');
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('CONTRACT (fails on 4d812e1a): a 10 000-char name pushed through onChangeText is stashed UNBOUNDED (JS layer has no length guard beyond the native maxLength prop)', async () => {
    const huge = 'A'.repeat(10_000);
    const { renderer } = renderPreAuth();
    typeName(renderer, huge);
    expect(continueDisabled(renderer)).toBe(false);
    const { stashed, revealText } = await finishFromName(renderer);

    console.log(
      JSON.stringify({
        probe: 'S8/huge-name',
        stashedLength: stashed.firstName?.length,
        revealLength: revealText.length,
        serverWouldAccept: predictServerAccepts(stashed.firstName),
      }),
    );
    expect(stashed.firstName?.length ?? 0).toBeLessThanOrEqual(NAME_MAX);
    act(() => renderer.unmount());
  });

  it('a 10 000-char name of ONLY whitespace keeps Continue disabled (trim is O(n) safe)', () => {
    const { renderer } = renderPreAuth();
    const started = Date.now();
    typeName(renderer, ' \n\t'.repeat(3_334));
    expect(continueDisabled(renderer)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    act(() => renderer.unmount());
  });

  it('emoji-only and RTL-only names enable Continue (non-empty after trim) and are stashed verbatim', async () => {
    for (const name of ['🏓🏓🏓', 'שלום', 'مرحبا', 'ボーム']) {
      mockCompletePreAuthOnboarding.mockClear();
      const { renderer } = renderPreAuth();
      typeName(renderer, name);
      expect(continueDisabled(renderer)).toBe(false);
      const { stashed, revealText } = await finishFromName(renderer);
      expect(stashed.firstName).toBe(name);
      expect(revealText).toContain(`Built for ${name}.`);
      expect(predictServerAccepts(stashed.firstName)).toBe(true);
      act(() => renderer.unmount());
    }
  });

  it('CONTRACT (fails on 4d812e1a): zero-width / bidi-control-only names pass the client check, render an empty "Built for ." reveal, and the server would 400 them', async () => {
    const outcomes: Array<Record<string, unknown>> = [];
    for (const [label, name] of [
      ['zero-width-space x3', '\u200B\u200B\u200B'],
      ['zero-width-joiner', '\u200D'],
      ['RTL override only', '\u202E\u202E'],
      ['word-joiner', '\u2060'],
      ['soft hyphen', '\u00AD'],
    ] as const) {
      mockCompletePreAuthOnboarding.mockClear();
      const { renderer } = renderPreAuth();
      typeName(renderer, name);
      const disabled = continueDisabled(renderer);
      let stashedName: string | undefined;
      let reveal = '';
      if (!disabled) {
        const { stashed, revealText } = await finishFromName(renderer);
        stashedName = stashed.firstName;
        reveal = revealText;
      }
      outcomes.push({
        label,
        continueDisabled: disabled,
        stashedCodePoints: stashedName
          ? [...stashedName].map(c => c.codePointAt(0)!.toString(16))
          : null,
        revealShowsEmptyName: reveal.includes(`Built for ${name}.`),
        serverWouldAccept: predictServerAccepts(stashedName),
      });
      act(() => renderer.unmount());
    }

    console.log(JSON.stringify({ probe: 'S8/invisible-names', outcomes }));
    for (const outcome of outcomes) {
      // HOLD expectation: an invisible name is not a name — Continue stays
      // disabled exactly like whitespace-only input.
      expect(outcome['continueDisabled']).toBe(true);
    }
  });

  it('PROBE: a 40-char name whose bidi controls the server strips still fits the server bound, but client and server disagree on what was saved', async () => {
    // 38 visible letters + 2 bidi controls = 40 code units (fits client
    // maxLength); server strips to 38 → accepted, stored differently.
    const name = `\u202E${'a'.repeat(38)}\u202C`;
    const { renderer } = renderPreAuth();
    typeName(renderer, name);
    const { stashed } = await finishFromName(renderer);
    expect(stashed.firstName).toBe(name);
    expect(predictServerAccepts(stashed.firstName)).toBe(true);
    act(() => renderer.unmount());
  });

  it('rapid repeats: 500 alternating edits between whitespace and a real name settle on the last value', () => {
    const { renderer } = renderPreAuth();
    for (let i = 0; i < 500; i += 1) {
      typeName(renderer, i % 2 === 0 ? '   ' : `Dana${i}`);
    }
    expect(continueDisabled(renderer)).toBe(false);
    expect(renderer.root.findByType(TextInput).props.value).toBe('Dana499');
    typeName(renderer, '\n');
    expect(continueDisabled(renderer)).toBe(true);
    act(() => renderer.unmount());
  });
});
