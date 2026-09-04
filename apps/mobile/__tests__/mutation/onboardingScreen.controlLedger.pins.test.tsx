import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';

/**
 * Mutation pins for OnboardingScreen (attack branch
 * devin/xc-mutation-launch-gate): an EXACT tap-target ledger per step and per
 * mode.
 *
 * The existing suites prove the controls that exist behave, and that nothing
 * reads "skip" / "Leave setup" pre-auth. They do not prove that NO OTHER
 * control exists — a skip affordance worded "Later" (mutants
 * `OB02-skip-button-euphemism`, `OB03-account-continue-without-setup`)
 * survived the full suite on 4d812e1a. These pins enumerate every tappable
 * node on every step in both modes and require the set to be exactly the
 * questionnaire's own controls, so any added escape hatch — whatever it is
 * called — fails here. They also pin which controls may reach the two store
 * completions at all.
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
jest.mock('../../src/state/appStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  const { focusForGoal } = jest.requireActual<
    typeof import('../../src/state/profile')
  >('../../src/state/profile');
  const useAppStore = create(() => ({
    completeOnboarding: (profile: unknown) => mockCompleteOnboarding(profile),
    completePreAuthOnboarding: (profile: unknown) =>
      mockCompletePreAuthOnboarding(profile),
    onboardingBusy: false,
    onboardingError: null as string | null,
  }));
  return { focusForGoal, useAppStore };
});

const mockSignOut = jest.fn(() => Promise.resolve());
jest.mock('../../src/auth/authStore', () => {
  const state = { signOut: () => mockSignOut() };
  return {
    useAuthStore: (selector: (s: typeof state) => unknown) => selector(state),
  };
});

const mockCompleteNotificationOnboarding = jest.fn<
  Promise<boolean>,
  ['enable' | 'not_now']
>(() => Promise.resolve(true));
jest.mock('../../src/notifications/notificationStore', () => {
  const state = {
    completeOnboardingStep: (choice: 'enable' | 'not_now') =>
      mockCompleteNotificationOnboarding(choice),
  };
  return {
    useNotificationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

import { OnboardingScreen } from '../../src/screens/OnboardingScreen';
import {
  BrandDialog,
  type BrandDialogAction,
} from '../../src/design/components';

type Renderer = TestRenderer.ReactTestRenderer;

const QUESTION_STEPS = [
  {
    step: 'gender',
    title: 'How do you identify?',
    choices: ['Female', 'Male', 'Non-binary', 'Prefer not to say'],
  },
  {
    step: 'level',
    title: 'Where is your game today?',
    choices: ['Brand new', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0+'],
  },
  {
    step: 'handedness',
    title: 'Which side is home?',
    choices: ['Right-handed', 'Left-handed'],
  },
  {
    step: 'goal',
    title: 'What do you want to own?',
    choices: [
      'Dinks',
      'Drives',
      'Third-shot drops',
      'Serve',
      'Volleys',
      'Footwork',
      'All-around',
    ],
  },
  {
    step: 'problem',
    title: 'What breaks down most?',
    choices: [
      'Consistency',
      'Control',
      'Power',
      'Contact',
      'Footwork',
      'Placement',
      'Not sure',
    ],
  },
] as const;

function renderScreen(props?: React.ComponentProps<typeof OnboardingScreen>) {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(<OnboardingScreen {...props} />);
  });
  return renderer;
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join('');
}

function isAncestor(
  ancestor: ReactTestInstance,
  node: ReactTestInstance,
): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function textOf(node: ReactTestInstance): string {
  return node
    .findAllByType(Text)
    .map(t => t.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ')
    .trim();
}

/**
 * Every innermost node carrying an `onPress` handler — RN Pressable,
 * Touchable*, PressableScale, design Button, ChoiceCard, or anything a
 * regression might add — identified by its accessibilityLabel, or, when a
 * control has none, by `<unlabelled:TEXT>` so it still shows up in the diff.
 */
function tapTargets(renderer: Renderer): ReactTestInstance[] {
  const matches = renderer.root.findAll(
    node => typeof node.props?.onPress === 'function',
  );
  return matches.filter(
    node => !matches.some(other => other !== node && isAncestor(node, other)),
  );
}

/** Gesture handlers other than a plain tap. None belongs on this screen: a
 * long-press / double-tap / swipe escape would be invisible to a
 * label-and-onPress ledger, so their mere presence fails the pin. */
const HIDDEN_GESTURE_PROPS = [
  'onLongPress',
  'onDoubleTap',
  'onMagicTap',
  'onAccessibilityEscape',
  'onAccessibilityAction',
] as const;

function hiddenGestureNodes(renderer: Renderer): string[] {
  return renderer.root
    .findAll(node =>
      HIDDEN_GESTURE_PROPS.some(
        prop => typeof node.props?.[prop] === 'function',
      ),
    )
    .map(node => {
      const props = HIDDEN_GESTURE_PROPS.filter(
        prop => typeof node.props[prop] === 'function',
      );
      const name =
        typeof node.type === 'string'
          ? node.type
          : ((node.type as { displayName?: string; name?: string })
              .displayName ??
            (node.type as { name?: string }).name ??
            'anonymous');
      return `${name}[${props.join(',')}]`;
    });
}

function ledger(renderer: Renderer): string[] {
  expect(hiddenGestureNodes(renderer)).toEqual([]);
  return tapTargets(renderer)
    .map(node => {
      const label = node.props.accessibilityLabel;
      return typeof label === 'string' && label.length > 0
        ? label
        : `<unlabelled:${textOf(node)}>`;
    })
    .sort();
}

function target(renderer: Renderer, label: string): ReactTestInstance {
  const nodes = tapTargets(renderer).filter(
    node => node.props.accessibilityLabel === label,
  );
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

function press(renderer: Renderer, label: string) {
  const node = target(renderer, label);
  expect(node.props.disabled).toBeFalsy();
  act(() => {
    node.props.onPress();
  });
}

function typeName(renderer: Renderer, text: string) {
  act(() => renderer.root.findByType(TextInput).props.onChangeText(text));
}

function progressNow(renderer: Renderer): number {
  return renderer.root.findByProps({ accessibilityRole: 'progressbar' }).props
    .accessibilityValue.now as number;
}

function dialogActions(renderer: Renderer): readonly BrandDialogAction[] {
  return renderer.root.findByType(BrandDialog).props.actions;
}

const sorted = (labels: readonly string[]) => [...labels].sort();

/** Walks name → every question → reveal → notifications, asserting the exact
 * tap-target ledger on every step. `stepOneControl` is the mode's header
 * control on step one; every later step has a plain Back. */
function walkAssertingLedger(renderer: Renderer, stepOneControl: string) {
  expect(allText(renderer)).toContain('What should we call you?');
  expect(progressNow(renderer)).toBe(1);
  expect(ledger(renderer)).toEqual(sorted([stepOneControl, 'Continue']));
  // Whitespace only: still exactly the same controls, Continue locked.
  typeName(renderer, '   ');
  expect(ledger(renderer)).toEqual(sorted([stepOneControl, 'Continue']));
  expect(target(renderer, 'Continue').props.disabled).toBe(true);
  typeName(renderer, ' Dana ');
  press(renderer, 'Continue');

  QUESTION_STEPS.forEach((question, index) => {
    expect(progressNow(renderer)).toBe(index + 2);
    expect(allText(renderer)).toContain(question.title);
    const expected = sorted(['Back', 'Continue', ...question.choices]);
    expect(ledger(renderer)).toEqual(expected);
    // Nothing is selected yet → Continue is the only locked control and
    // the ledger does not change while locked.
    expect(target(renderer, 'Continue').props.disabled).toBe(true);
    press(renderer, question.choices[0]!);
    expect(ledger(renderer)).toEqual(expected);
    expect(target(renderer, 'Continue').props.disabled).toBe(false);
    press(renderer, 'Continue');
  });

  expect(progressNow(renderer)).toBe(7);
  expect(allText(renderer)).toContain('YOUR STARTING PLAN');
  expect(ledger(renderer)).toEqual(sorted(['Back', 'Continue']));
  press(renderer, 'Continue');

  expect(progressNow(renderer)).toBe(8);
  expect(allText(renderer)).toContain('Stay match-ready.');
  expect(ledger(renderer)).toEqual(
    sorted(['Back', 'Turn on reminders', 'Not now']),
  );
}

describe('OnboardingScreen — exact tap-target ledger (no hidden escape hatch)', () => {
  beforeEach(() => {
    mockCompleteOnboarding.mockClear();
    mockCompletePreAuthOnboarding.mockClear();
    mockCompleteNotificationOnboarding.mockClear();
    mockSignOut.mockClear();
  });

  it('pre-auth: every step exposes exactly the questionnaire controls; step one has only Back + Continue', () => {
    const onBack = jest.fn();
    const onFinished = jest.fn();
    const renderer = renderScreen({ mode: 'preauth', onBack, onFinished });
    walkAssertingLedger(renderer, 'Back');
    // Nothing on the way here reached a completion or a hand-off.
    expect(onFinished).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    expect(mockCompletePreAuthOnboarding).not.toHaveBeenCalled();
    expect(mockCompleteOnboarding).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('in-account: every step exposes exactly the questionnaire controls; step one has only Leave setup + Continue', () => {
    const renderer = renderScreen();
    walkAssertingLedger(renderer, 'Leave setup');
    expect(mockCompleteOnboarding).not.toHaveBeenCalled();
    expect(mockCompletePreAuthOnboarding).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('pre-auth step one: the ONLY non-Continue control is Back, and it hands to onBack — never onFinished', () => {
    const onBack = jest.fn();
    const onFinished = jest.fn();
    const renderer = renderScreen({ mode: 'preauth', onBack, onFinished });
    const others = ledger(renderer).filter(label => label !== 'Continue');
    expect(others).toEqual(['Back']);
    for (const label of others) press(renderer, label);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onFinished).not.toHaveBeenCalled();
    expect(mockCompletePreAuthOnboarding).not.toHaveBeenCalled();
    expect(mockCompleteOnboarding).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('in-account step one: the ONLY non-Continue control is Leave setup; its dialog offers exactly Keep setting up / Sign out and never saves a profile', () => {
    const renderer = renderScreen();
    const others = ledger(renderer).filter(label => label !== 'Continue');
    expect(others).toEqual(['Leave setup']);
    press(renderer, 'Leave setup');
    const dialog = renderer.root.findByType(BrandDialog);
    expect(dialog.props.visible).toBe(true);
    const actions = dialogActions(renderer);
    expect(actions.map(a => a.label)).toEqual(['Keep setting up', 'Sign out']);
    // Press every dialog action: the only side effect anywhere is signOut.
    for (const action of actions) {
      act(() => {
        action.onPress();
      });
    }
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockCompleteOnboarding).not.toHaveBeenCalled();
    expect(mockCompletePreAuthOnboarding).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('pressing EVERY control on every step except the two finish buttons never reaches a completion (either mode)', () => {
    for (const mode of ['preauth', 'account'] as const) {
      const onBack = jest.fn();
      const onFinished = jest.fn();
      const renderer = renderScreen(
        mode === 'preauth' ? { mode, onBack, onFinished } : undefined,
      );
      // Step one: press everything but the header exit and Continue (locked).
      typeName(renderer, 'Dana');
      press(renderer, 'Continue');
      QUESTION_STEPS.forEach(question => {
        // Every choice, then Continue.
        for (const choice of question.choices) press(renderer, choice);
        press(renderer, 'Continue');
      });
      press(renderer, 'Continue'); // reveal → notifications
      expect(allText(renderer)).toContain('Stay match-ready.');
      // Back all the way to step one and forward again: still nothing.
      for (let step = 8; step > 1; step -= 1) press(renderer, 'Back');
      expect(progressNow(renderer)).toBe(1);
      expect(mockCompleteOnboarding).not.toHaveBeenCalled();
      expect(mockCompletePreAuthOnboarding).not.toHaveBeenCalled();
      expect(mockCompleteNotificationOnboarding).not.toHaveBeenCalled();
      expect(onFinished).not.toHaveBeenCalled();
      expect(onBack).not.toHaveBeenCalled();
      expect(mockSignOut).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    }
  });

  it('the name field is the only non-pressable input, and its keyboard Next never leaves the questionnaire (either mode)', () => {
    for (const mode of ['preauth', 'account'] as const) {
      const onBack = jest.fn();
      const onFinished = jest.fn();
      const renderer = renderScreen(
        mode === 'preauth' ? { mode, onBack, onFinished } : undefined,
      );
      const inputs = renderer.root.findAllByType(TextInput);
      expect(inputs).toHaveLength(1);
      const submit = () =>
        act(() => {
          inputs[0]!.props.onSubmitEditing();
        });
      // Empty, whitespace-only: Next is inert.
      submit();
      expect(progressNow(renderer)).toBe(1);
      typeName(renderer, '   ');
      submit();
      expect(progressNow(renderer)).toBe(1);
      // With a name: Next mirrors Continue and goes to question two only.
      typeName(renderer, ' Dana ');
      submit();
      expect(progressNow(renderer)).toBe(2);
      expect(allText(renderer)).toContain(QUESTION_STEPS[0].title);
      expect(onFinished).not.toHaveBeenCalled();
      expect(onBack).not.toHaveBeenCalled();
      expect(mockCompleteOnboarding).not.toHaveBeenCalled();
      expect(mockCompletePreAuthOnboarding).not.toHaveBeenCalled();
      expect(mockSignOut).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    }
  });

  it('the two finish buttons are the only path to a completion, and pre-auth completes through the stash only', async () => {
    const onBack = jest.fn();
    const onFinished = jest.fn();
    const renderer = renderScreen({ mode: 'preauth', onBack, onFinished });
    typeName(renderer, 'Dana');
    press(renderer, 'Continue');
    QUESTION_STEPS.forEach(question => {
      press(renderer, question.choices[0]!);
      press(renderer, 'Continue');
    });
    press(renderer, 'Continue');
    expect(ledger(renderer)).toEqual(
      sorted(['Back', 'Turn on reminders', 'Not now']),
    );
    press(renderer, 'Not now');
    await act(async () => {});
    expect(mockCompletePreAuthOnboarding).toHaveBeenCalledTimes(1);
    expect(mockCompleteOnboarding).not.toHaveBeenCalled();
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
