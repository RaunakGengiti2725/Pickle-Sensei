/**
 * First-run walkthrough + technique intent picker driven as a user would.
 *
 * Walkthrough: the device-scoped store persists the seen marker BEFORE the
 * overlay shows, shows once, fails closed on KV errors, replays from Settings;
 * the overlay's Skip / Next / Got it / backdrop / hardware-back all dismiss or
 * advance, every control is a labeled button, a target that never measures
 * ends the tour instead of leaving a blank scrim, and target registration is
 * released on unmount.
 *
 * Picker: tap chips, Auto Detect, typed/dictated text resolving to a chip,
 * ambiguous text narrowing the grid, unknown text re-prompting, and the
 * submit path — all radio-role controls with selected state.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockGetKv = jest.fn<Promise<string | null>, unknown[]>();
const mockSetKv = jest.fn<Promise<void>, unknown[]>();
jest.mock('../../src/data/repository', () => ({
  getKv: (...args: unknown[]) => mockGetKv(...args),
  setKv: (...args: unknown[]) => mockSetKv(...args),
}));
jest.mock('../../src/data/db', () => ({ getDb: () => ({}) }));

import {
  FirstRunWalkthrough,
  WALKTHROUGH_STEPS,
} from '../../src/walkthrough/FirstRunWalkthrough';
import {
  hasWalkthroughTarget,
  registerWalkthroughMeasurer,
  useWalkthroughTarget,
  type WalkthroughTargetKey,
} from '../../src/walkthrough/targets';
import {
  useWalkthroughStore,
  WALKTHROUGH_KV_KEY,
  WALKTHROUGH_SEEN_VALUE,
} from '../../src/walkthrough/walkthroughStore';
import {
  autoDetectIntent,
  TechniqueIntentPicker,
} from '../../src/flow/TechniqueIntentPicker';
import type { TechniqueIntent } from '@pickle/shared-types';

const RECTS: Record<
  WalkthroughTargetKey,
  { x: number; y: number; width: number; height: number }
> = {
  'coach-fab': { x: 165, y: 700, width: 64, height: 64 },
  'rank-banner': { x: 24, y: 120, width: 345, height: 96 },
  'tab-library': { x: 96, y: 760, width: 70, height: 54 },
  'tab-progress': { x: 236, y: 760, width: 70, height: 54 },
};

function step(index: number) {
  const found = WALKTHROUGH_STEPS[index];
  if (!found) throw new Error(`no walkthrough step ${index}`);
  return found;
}

let cleanups: Array<() => void> = [];
function registerTargets(keys: WalkthroughTargetKey[]) {
  for (const key of keys) {
    cleanups.push(
      registerWalkthroughMeasurer(key, () => Promise.resolve(RECTS[key])),
    );
  }
}

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  useWalkthroughStore.setState({ visible: false });
  jest.useRealTimers();
});

beforeEach(() => {
  mockGetKv.mockReset().mockResolvedValue(null);
  mockSetKv.mockReset().mockResolvedValue(undefined);
});

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAll(node => String(node.type) === 'Text')
    .map(node => React.Children.toArray(node.props.children).join(''))
    .join('\n');
}

function deepestPressable(
  renderer: TestRenderer.ReactTestRenderer,
  predicate: (node: TestRenderer.ReactTestInstance) => boolean,
) {
  const node = renderer.root
    .findAll(n => predicate(n) && typeof n.props.onPress === 'function')
    .at(-1);
  if (!node) throw new Error('pressable not found');
  return node;
}

async function press(node: TestRenderer.ReactTestInstance) {
  await act(async () => {
    node.props.onPress();
  });
}

async function renderVisible() {
  useWalkthroughStore.setState({ visible: true });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<FirstRunWalkthrough />);
  });
  return renderer;
}

describe('Walkthrough store — device-scoped, shown once, fail closed', () => {
  it('first run: persists the seen marker BEFORE showing, then shows exactly once', async () => {
    const order: string[] = [];
    mockSetKv.mockImplementation(async () => {
      order.push('setKv');
    });
    const unsubscribe = useWalkthroughStore.subscribe(state => {
      if (state.visible) order.push('visible');
    });
    await useWalkthroughStore.getState().maybeShowFirstRun();
    unsubscribe();

    expect(order).toEqual(['setKv', 'visible']);
    expect(mockGetKv).toHaveBeenCalledWith({}, WALKTHROUGH_KV_KEY);
    expect(mockSetKv).toHaveBeenCalledWith(
      {},
      WALKTHROUGH_KV_KEY,
      WALKTHROUGH_SEEN_VALUE,
    );
    expect(useWalkthroughStore.getState().visible).toBe(true);

    // Re-evaluation while visible is a no-op (no second write).
    await useWalkthroughStore.getState().maybeShowFirstRun();
    expect(mockSetKv).toHaveBeenCalledTimes(1);

    // Dismissed and the device marker is now present → never shows again.
    useWalkthroughStore.getState().dismiss();
    mockGetKv.mockResolvedValue(WALKTHROUGH_SEEN_VALUE);
    await useWalkthroughStore.getState().maybeShowFirstRun();
    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(mockSetKv).toHaveBeenCalledTimes(1);
  });

  it('concurrent mounts serialize into a single show and a single write', async () => {
    await Promise.all([
      useWalkthroughStore.getState().maybeShowFirstRun(),
      useWalkthroughStore.getState().maybeShowFirstRun(),
      useWalkthroughStore.getState().maybeShowFirstRun(),
    ]);
    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(mockSetKv).toHaveBeenCalledTimes(1);
  });

  it('unreadable or unwritable KV never raises the blocking overlay', async () => {
    mockGetKv.mockRejectedValueOnce(new Error('sqlite read failed'));
    await useWalkthroughStore.getState().maybeShowFirstRun();
    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(mockSetKv).not.toHaveBeenCalled();

    mockSetKv.mockRejectedValueOnce(new Error('sqlite write failed'));
    await useWalkthroughStore.getState().maybeShowFirstRun();
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });

  it('Settings replay shows the tour without touching the seen record', async () => {
    useWalkthroughStore.getState().replay();
    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(mockGetKv).not.toHaveBeenCalled();
    expect(mockSetKv).not.toHaveBeenCalled();
    useWalkthroughStore.getState().dismiss();
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });
});

describe('Walkthrough overlay — controls', () => {
  it('renders nothing while hidden and never registers a stage', () => {
    registerTargets(Object.keys(RECTS) as WalkthroughTargetKey[]);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<FirstRunWalkthrough />);
    });
    expect(
      renderer.root.findAll(n => n.props.testID === 'first-run-walkthrough'),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('step one anchors to the Coach button with labeled Skip and Next buttons', async () => {
    registerTargets(Object.keys(RECTS) as WalkthroughTargetKey[]);
    const renderer = await renderVisible();
    const text = textOf(renderer);
    expect(text).toContain(step(0).headline);
    expect(text).toContain('Every read starts here.');

    const skip = deepestPressable(
      renderer,
      n => n.props.testID === 'walkthrough-skip',
    );
    expect(skip.props.accessibilityRole).toBe('button');
    expect(skip.props.accessibilityLabel).toBe('Skip walkthrough');

    const next = deepestPressable(
      renderer,
      n => n.props.testID === 'walkthrough-advance',
    );
    expect(next.props.accessibilityRole).toBe('button');
    expect(next.props.accessibilityLabel).toBe('Next');
    act(() => renderer.unmount());
  });

  it('Next walks all four steps in order; the last step offers only "Got it" which dismisses', async () => {
    registerTargets(Object.keys(RECTS) as WalkthroughTargetKey[]);
    const renderer = await renderVisible();
    expect(WALKTHROUGH_STEPS).toHaveLength(4);

    for (const [index, step] of WALKTHROUGH_STEPS.entries()) {
      const text = textOf(renderer);
      expect(text).toContain(step.headline);
      expect(text).toContain(step.body);
      const isLast = index === WALKTHROUGH_STEPS.length - 1;
      expect(
        renderer.root.findAll(n => n.props.testID === 'walkthrough-skip')
          .length > 0,
      ).toBe(!isLast);
      const advance = deepestPressable(
        renderer,
        n => n.props.testID === 'walkthrough-advance',
      );
      expect(advance.props.accessibilityLabel).toBe(isLast ? 'Got it' : 'Next');
      await press(advance);
    }
    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(
      renderer.root.findAll(n => n.props.testID === 'first-run-walkthrough'),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('Skip dismisses from any step', async () => {
    registerTargets(Object.keys(RECTS) as WalkthroughTargetKey[]);
    const renderer = await renderVisible();
    await press(
      deepestPressable(renderer, n => n.props.testID === 'walkthrough-advance'),
    );
    expect(textOf(renderer)).toContain(step(1).headline);
    await press(
      deepestPressable(renderer, n => n.props.testID === 'walkthrough-skip'),
    );
    expect(useWalkthroughStore.getState().visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('tapping the backdrop dismisses; hardware back (onRequestClose) dismisses', async () => {
    registerTargets(Object.keys(RECTS) as WalkthroughTargetKey[]);
    let renderer = await renderVisible();
    await press(
      deepestPressable(
        renderer,
        n => n.props.accessibilityLabel === 'Dismiss walkthrough',
      ),
    );
    expect(useWalkthroughStore.getState().visible).toBe(false);
    act(() => renderer.unmount());

    renderer = await renderVisible();
    const modal = renderer.root.find(
      n => typeof n.props.onRequestClose === 'function',
    );
    expect(modal.props.visible).toBe(true);
    await act(async () => {
      modal.props.onRequestClose();
    });
    expect(useWalkthroughStore.getState().visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('a registered target that never measures is retried briefly, then skipped — no blank scrim', async () => {
    jest.useFakeTimers();
    let attempts = 0;
    cleanups.push(
      registerWalkthroughMeasurer('coach-fab', async () => {
        attempts += 1;
        return null;
      }),
    );
    registerTargets(['rank-banner', 'tab-library', 'tab-progress']);
    const renderer = await renderVisible();
    expect(textOf(renderer)).toBe('');
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        jest.advanceTimersByTime(120);
        await Promise.resolve();
      });
    }
    expect(attempts).toBeGreaterThanOrEqual(6);
    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(textOf(renderer)).toContain(step(1).headline);
    expect(textOf(renderer)).not.toContain(step(0).headline);
    act(() => renderer.unmount());
  });

  it('when NO target can be measured the tour ends itself instead of hanging', async () => {
    const renderer = await renderVisible();
    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(
      renderer.root.findAll(n => n.props.testID === 'first-run-walkthrough'),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('useWalkthroughTarget registers on mount and releases on unmount', () => {
    function Anchor() {
      const ref = useWalkthroughTarget('tab-progress');
      return React.createElement('View', { ref });
    }
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Anchor />);
    });
    expect(hasWalkthroughTarget('tab-progress')).toBe(true);
    act(() => renderer.unmount());
    expect(hasWalkthroughTarget('tab-progress')).toBe(false);
  });
});

describe('Technique intent picker', () => {
  function renderPicker(value: TechniqueIntent | null = null) {
    const onChange = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <TechniqueIntentPicker value={value} onChange={onChange} />,
      );
    });
    return { renderer, onChange };
  }

  const radios = (renderer: TestRenderer.ReactTestRenderer) =>
    renderer.root.findAll(
      n => typeof n.type === 'string' && n.props.accessibilityRole === 'radio',
    );

  const input = (renderer: TestRenderer.ReactTestRenderer) =>
    renderer.root.find(
      n =>
        n.props.accessibilityLabel ===
          'Type or dictate the technique you are working on' &&
        typeof n.props.onChangeText === 'function',
    );

  it('renders the full registry as a radiogroup plus Auto Detect, none selected', () => {
    const { renderer } = renderPicker();
    const group = renderer.root.find(
      n =>
        typeof n.type === 'string' &&
        n.props.accessibilityRole === 'radiogroup',
    );
    expect(group.props.accessibilityLabel).toBe(
      'Which technique are you working on?',
    );
    const chips = radios(renderer);
    expect(chips.length).toBeGreaterThan(5);
    expect(chips.at(-1)!.props.accessibilityLabel).toBe('Auto detect');
    expect(
      chips.every(c => c.props.accessibilityState.selected === false),
    ).toBe(true);
    act(() => renderer.unmount());
  });

  it('tapping a chip emits a tap intent with confidence 1; the selected chip reports selected', () => {
    const { renderer, onChange } = renderPicker();
    const chip = deepestPressable(
      renderer,
      n => n.props.accessibilityLabel === 'Backhand Dink',
    );
    act(() => chip.props.onPress());
    expect(onChange).toHaveBeenCalledTimes(1);
    const intent = onChange.mock.calls[0][0] as TechniqueIntent;
    expect(intent).toMatchObject({
      source: 'tap',
      canonical: 'BACKHAND_DINK',
      legacySlug: 'dink',
      confidence: 1,
    });
    act(() => renderer.unmount());

    const selected = renderPicker(intent);
    const states = radios(selected.renderer).map(c => [
      c.props.accessibilityLabel,
      c.props.accessibilityState.selected,
    ]);
    expect(states.filter(([, s]) => s)).toEqual([['Backhand Dink', true]]);
    act(() => selected.renderer.unmount());
  });

  it('Auto Detect emits the canonical auto intent, is marked selected, and explains its limits honestly', () => {
    const { renderer, onChange } = renderPicker();
    act(() =>
      deepestPressable(
        renderer,
        n => n.props.accessibilityLabel === 'Auto detect',
      ).props.onPress(),
    );
    expect(onChange).toHaveBeenCalledWith(autoDetectIntent());
    expect(autoDetectIntent()).toMatchObject({
      source: 'auto',
      canonical: null,
      legacySlug: null,
      confidence: null,
    });
    act(() => renderer.unmount());

    const auto = renderPicker(autoDetectIntent());
    const autoChip = radios(auto.renderer).at(-1)!;
    expect(autoChip.props.accessibilityState).toEqual({ selected: true });
    expect(textOf(auto.renderer)).toContain(
      'When it can’t classify, it says so and withholds the result instead of guessing.',
    );
    act(() => auto.renderer.unmount());
  });

  it('typing/dictating a specific technique selects it immediately as a voice intent', () => {
    const { renderer, onChange } = renderPicker();
    act(() => input(renderer).props.onChangeText('backhand dink'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({
      source: 'voice',
      canonical: 'BACKHAND_DINK',
      legacySlug: 'dink',
      confidence: 0.9,
    });
    act(() => renderer.unmount());
  });

  it('short text does nothing; ambiguous text narrows the grid and asks to pick; unknown text re-prompts', () => {
    const { renderer, onChange } = renderPicker();
    act(() => input(renderer).props.onChangeText('di'));
    expect(onChange).not.toHaveBeenCalled();
    expect(radios(renderer).length).toBeGreaterThan(5);

    act(() => input(renderer).props.onChangeText('dink'));
    expect(onChange).not.toHaveBeenCalled();
    expect(radios(renderer).map(c => c.props.accessibilityLabel)).toEqual([
      'Forehand Dink',
      'Backhand Dink',
      'Auto detect',
    ]);
    expect(textOf(renderer)).toContain(
      'several dink techniques match — which one? — pick one below.',
    );
    // Submitting an ambiguous phrase must not guess.
    act(() => input(renderer).props.onSubmitEditing());
    expect(onChange).not.toHaveBeenCalled();

    act(() => input(renderer).props.onChangeText('zzqq banana'));
    expect(onChange).not.toHaveBeenCalled();
    expect(textOf(renderer)).toContain(
      'Didn’t catch a technique — try “forehand drive”, “dink”, or tap one below.',
    );
    // The full grid is back so the user is never stranded.
    expect(radios(renderer).length).toBeGreaterThan(5);
    act(() => renderer.unmount());
  });

  it('submitting "not sure" selects Auto Detect; submitting a resolved phrase selects it', () => {
    const { renderer, onChange } = renderPicker();
    act(() => input(renderer).props.onChangeText('not sure'));
    expect(onChange).not.toHaveBeenCalled();
    act(() => input(renderer).props.onSubmitEditing());
    expect(onChange).toHaveBeenCalledWith(autoDetectIntent());

    act(() => input(renderer).props.onChangeText('forehand volley'));
    act(() => input(renderer).props.onSubmitEditing());
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({
      source: 'voice',
      canonical: 'FOREHAND_VOLLEY',
      rawUserText: 'forehand volley',
    });
    act(() => renderer.unmount());
  });
});
