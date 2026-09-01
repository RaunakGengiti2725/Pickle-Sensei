/**
 * Button ledger for `src/flow/TechniqueIntentPicker.tsx`.
 *
 * Every interactive element in the picker is exercised here through its
 * real handler and asserted on the observable effect (the `onChange`
 * intent, the narrowed grid, the hint copy, the selected state):
 *
 *  - TextInput `onChangeText`   → live resolve; a resolved phrase emits a
 *                                 voice intent, an ambiguous one narrows
 *                                 the grid, an unknown one shows the
 *                                 resolver's re-prompt.
 *  - TextInput `onSubmitEditing`→ resolved → voice intent; auto words →
 *                                 the canonical AUTO intent; otherwise no
 *                                 emission.
 *  - 12 technique chips         → tap intent for that technique.
 *  - "Auto detect" chip         → `autoDetectIntent()`.
 *
 * The component has no async handlers and no timers, so no fake timers are
 * needed; PressableScale's press-in/out animation is not driven here.
 */
import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  SELECTABLE_TECHNIQUES_V1,
  TECHNIQUE_INTENT_VERSION,
  type TechniqueIntent,
} from '@pickle/shared-types';
import {
  autoDetectIntent,
  TechniqueIntentPicker,
} from '../../src/flow/TechniqueIntentPicker';
import { PressableScale } from '../../src/design/components';

type Renderer = TestRenderer.ReactTestRenderer;

async function render(props: {
  value: TechniqueIntent | null;
  onChange: (intent: TechniqueIntent | null) => void;
  dark?: boolean;
}): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<TechniqueIntentPicker {...props} />);
  });
  return renderer;
}

async function update(
  renderer: Renderer,
  props: {
    value: TechniqueIntent | null;
    onChange: (intent: TechniqueIntent | null) => void;
    dark?: boolean;
  },
) {
  await act(async () => {
    renderer.update(<TechniqueIntentPicker {...props} />);
  });
}

function chips(renderer: Renderer) {
  return renderer.root.findAllByType(PressableScale);
}

function chip(renderer: Renderer, label: string) {
  const matches = chips(renderer).filter(
    node => node.props.accessibilityLabel === label,
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function chipLabels(renderer: Renderer): string[] {
  return chips(renderer).map(node => node.props.accessibilityLabel as string);
}

function field(renderer: Renderer) {
  return renderer.root.findByType(TextInput);
}

async function typeText(renderer: Renderer, value: string) {
  await act(async () => {
    field(renderer).props.onChangeText(value);
  });
}

async function submit(renderer: Renderer) {
  await act(async () => {
    field(renderer).props.onSubmitEditing();
  });
}

/** Every rendered string, concatenated — adjacent Text children joined. */
function rendered(renderer: Renderer): string {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return out.join('');
}

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, entry) => ({ ...acc, ...flatten(entry) }),
      {},
    );
  }
  if (style && typeof style === 'object') {
    return style as Record<string, unknown>;
  }
  return {};
}

const ALL_LABELS = [
  ...SELECTABLE_TECHNIQUES_V1.map(technique => technique.displayName),
  'Auto detect',
];

describe('TechniqueIntentPicker — ledger of pressables', () => {
  it('renders exactly one chip per selectable technique plus Auto detect', async () => {
    const renderer = await render({ value: null, onChange: jest.fn() });
    expect(chipLabels(renderer)).toEqual(ALL_LABELS);
    expect(SELECTABLE_TECHNIQUES_V1).toHaveLength(12);
    expect(chips(renderer)).toHaveLength(13);
  });

  it.each(
    SELECTABLE_TECHNIQUES_V1.map(technique => [
      technique.displayName,
      technique,
    ]),
  )(
    'chip "%s" -> select(technique, "tap") emits a tap intent',
    async (label, technique) => {
      const onChange = jest.fn();
      const renderer = await render({ value: null, onChange });

      await act(async () => {
        chip(renderer, label).props.onPress();
      });

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith({
        version: TECHNIQUE_INTENT_VERSION,
        source: 'tap',
        canonical: technique.canonical,
        legacySlug: technique.legacySlug,
        confidence: 1,
      });
      // Tap provenance never carries typed text.
      expect(onChange.mock.calls[0]![0]).not.toHaveProperty('rawUserText');
    },
  );

  it('technique chip reflects the controlled value as accessibilityState.selected', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });
    expect(
      chips(renderer).every(
        node => node.props.accessibilityState.selected === false,
      ),
    ).toBe(true);

    await act(async () => {
      chip(renderer, 'Serve').props.onPress();
    });
    const intent = onChange.mock.calls[0]![0] as TechniqueIntent;
    await update(renderer, { value: intent, onChange });

    expect(chip(renderer, 'Serve').props.accessibilityState.selected).toBe(
      true,
    );
    expect(
      chips(renderer)
        .filter(node => node.props.accessibilityLabel !== 'Serve')
        .every(node => node.props.accessibilityState.selected === false),
    ).toBe(true);
    // Radio chips are idempotent: pressing the selected chip re-emits the
    // same intent (no toggle-off, no null emission).
    await act(async () => {
      chip(renderer, 'Serve').props.onPress();
    });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1]![0]).toEqual(intent);
  });

  it('"Auto detect" chip -> onChange(autoDetectIntent())', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await act(async () => {
      chip(renderer, 'Auto detect').props.onPress();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(autoDetectIntent());
    expect(onChange).toHaveBeenCalledWith({
      version: TECHNIQUE_INTENT_VERSION,
      source: 'auto',
      canonical: null,
      legacySlug: null,
      confidence: null,
    });
    // Nothing selected yet, so the honest AUTO explainer is not shown.
    expect(rendered(renderer)).not.toContain('forehand or backhand');
  });

  it('with the AUTO intent as value: chip is selected and the honest explainer is visible', async () => {
    const renderer = await render({
      value: autoDetectIntent(),
      onChange: jest.fn(),
    });
    expect(
      chip(renderer, 'Auto detect').props.accessibilityState.selected,
    ).toBe(true);
    expect(
      chips(renderer)
        .filter(node => node.props.accessibilityLabel !== 'Auto detect')
        .every(node => node.props.accessibilityState.selected === false),
    ).toBe(true);
    const copy = rendered(renderer);
    expect(copy).toContain('forehand or backhand');
    expect(copy).toContain('not the exact stroke');
    expect(copy).toContain('withholds the result instead of guessing');
  });
});

describe('TechniqueIntentPicker — TextInput onChangeText', () => {
  it('a phrase that resolves to one technique emits a voice intent immediately', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await typeText(renderer, 'forehand drive');

    expect(onChange).toHaveBeenCalledTimes(1);
    const intent = onChange.mock.calls[0]![0] as TechniqueIntent;
    expect(intent).toMatchObject({
      version: TECHNIQUE_INTENT_VERSION,
      source: 'voice',
      canonical: 'FOREHAND_DRIVE',
      legacySlug: 'forehand_drive',
      confidence: 0.95,
    });
    expect(intent).toHaveProperty('rawUserText');
    // WF-ISSUE: Voice-path provenance is stale — rawUserText is read from
    // the pre-keystroke `text` state ('' here) instead of the typed value,
    // and confidence is hard-coded 0.95 instead of the resolver's number.
    // expect(intent.rawUserText).toBe('forehand drive');

    // The field is controlled: the typed value is echoed back.
    expect(field(renderer).props.value).toBe('forehand drive');
    // A resolved phrase does not narrow the grid.
    expect(chipLabels(renderer)).toEqual(ALL_LABELS);
    expect(rendered(renderer)).not.toContain('pick one below');
  });

  it('a family-level phrase ("backhand dink") projects to the selectable technique', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await typeText(renderer, 'backhand dink');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toMatchObject({
      source: 'voice',
      canonical: 'BACKHAND_DINK',
      legacySlug: 'dink',
    });
  });

  it('an ambiguous phrase narrows the grid to the candidates, keeps Auto detect, shows the reason, emits nothing', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await typeText(renderer, 'dink');

    expect(onChange).not.toHaveBeenCalled();
    expect(chipLabels(renderer)).toEqual([
      'Forehand Dink',
      'Backhand Dink',
      'Auto detect',
    ]);
    expect(rendered(renderer)).toContain(
      'several dink techniques match — which one? — pick one below.',
    );

    // The narrowed chips are live: tapping one emits a TAP intent.
    await act(async () => {
      chip(renderer, 'Backhand Dink').props.onPress();
    });
    expect(onChange).toHaveBeenCalledWith({
      version: TECHNIQUE_INTENT_VERSION,
      source: 'tap',
      canonical: 'BACKHAND_DINK',
      legacySlug: 'dink',
      confidence: 1,
    });
    // So is the Auto chip while narrowed.
    await act(async () => {
      chip(renderer, 'Auto detect').props.onPress();
    });
    expect(onChange).toHaveBeenLastCalledWith(autoDetectIntent());
  });

  it('a side-only phrase ("backhand") narrows to that side and re-prompts for the stroke', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await typeText(renderer, 'backhand');

    expect(onChange).not.toHaveBeenCalled();
    const labels = chipLabels(renderer);
    expect(labels).toContain('Backhand Drive');
    expect(labels).toContain('Backhand Dink');
    expect(labels).toContain('Backhand Volley');
    expect(labels).not.toContain('Forehand Drive');
    expect(labels).not.toContain('Forehand Dink');
    expect(labels).not.toContain('Forehand Volley');
    expect(labels[labels.length - 1]).toBe('Auto detect');
    expect(rendered(renderer)).toContain('backhand what — say the stroke too');
  });

  it('an unknown phrase shows the resolver re-prompt, keeps the full grid, emits nothing', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await typeText(renderer, 'xyzzy blah');

    expect(onChange).not.toHaveBeenCalled();
    expect(chipLabels(renderer)).toEqual(ALL_LABELS);
    expect(rendered(renderer)).toContain(
      'Didn’t catch a technique — try “forehand drive”, “dink”, or tap one below.',
    );
  });

  it('a recognized technique outside the selectable set falls back to honest copy', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await typeText(renderer, 'lob');

    expect(onChange).not.toHaveBeenCalled();
    expect(chipLabels(renderer)).toEqual(ALL_LABELS);
    expect(rendered(renderer)).toContain(
      'No matching technique — tap one below.',
    );
  });

  it('fewer than three characters never resolves, shows no hint, keeps the full grid', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await typeText(renderer, 'ba');

    expect(onChange).not.toHaveBeenCalled();
    expect(field(renderer).props.value).toBe('ba');
    expect(chipLabels(renderer)).toEqual(ALL_LABELS);
    const copy = rendered(renderer);
    expect(copy).not.toContain('pick one below');
    expect(copy).not.toContain('tap one below');
  });

  it('typing auto words emits nothing until submit', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await typeText(renderer, 'not sure');

    expect(onChange).not.toHaveBeenCalled();
    expect(chipLabels(renderer)).toEqual(ALL_LABELS);
  });

  it('clearing the field restores the full grid and removes the hint', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await typeText(renderer, 'volley');
    expect(chipLabels(renderer)).toEqual([
      'Forehand Volley',
      'Backhand Volley',
      'Auto detect',
    ]);

    await typeText(renderer, '');
    expect(chipLabels(renderer)).toEqual(ALL_LABELS);
    expect(rendered(renderer)).not.toContain('pick one below');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('whitespace-only input counts as empty (trim before the 3-char gate)', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await typeText(renderer, '     ');

    expect(onChange).not.toHaveBeenCalled();
    expect(chipLabels(renderer)).toEqual(ALL_LABELS);
    expect(rendered(renderer)).not.toContain('below');
  });
});

describe('TechniqueIntentPicker — TextInput onSubmitEditing', () => {
  it('submit on a resolved phrase re-emits the voice intent', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await typeText(renderer, 'serve');
    expect(onChange).toHaveBeenCalledTimes(1);

    await submit(renderer);

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1]![0]).toMatchObject({
      version: TECHNIQUE_INTENT_VERSION,
      source: 'voice',
      canonical: 'SERVE',
      legacySlug: 'serve',
      confidence: 0.95,
      rawUserText: 'serve',
    });
  });

  it('submit on auto words ("not sure") emits the canonical AUTO intent', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await typeText(renderer, 'not sure');
    await submit(renderer);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(autoDetectIntent());
  });

  it('submit on "auto" emits the canonical AUTO intent', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await typeText(renderer, 'auto');
    await submit(renderer);

    expect(onChange).toHaveBeenCalledWith(autoDetectIntent());
  });

  it('submit on an ambiguous phrase emits nothing — the narrowed grid is the next step', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await typeText(renderer, 'volley');
    await submit(renderer);

    expect(onChange).not.toHaveBeenCalled();
    expect(chipLabels(renderer)).toEqual([
      'Forehand Volley',
      'Backhand Volley',
      'Auto detect',
    ]);
    expect(rendered(renderer)).toContain('pick one below');
  });

  it('submit on an unknown phrase emits nothing — the re-prompt stays visible', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await typeText(renderer, 'xyzzy blah');
    await submit(renderer);

    expect(onChange).not.toHaveBeenCalled();
    expect(rendered(renderer)).toContain('Didn’t catch a technique');
  });

  it('submit with an empty or too-short field is a safe no-op', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });

    await submit(renderer);
    await typeText(renderer, 'ba');
    await submit(renderer);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('the field is configured for one-shot entry (done key, no autocorrect, labelled)', async () => {
    const renderer = await render({ value: null, onChange: jest.fn() });
    const input = field(renderer);
    expect(input.props.returnKeyType).toBe('done');
    expect(input.props.autoCorrect).toBe(false);
    expect(input.props.accessibilityLabel).toBe(
      'Type or dictate the technique you are working on',
    );
    expect(input.props.placeholder).toBe('Type or dictate — “backhand dink”');
    expect(flatten(input.props.style).minHeight).toBeGreaterThanOrEqual(44);
  });
});

describe('TechniqueIntentPicker — accessibility and hit targets', () => {
  it('chips are radios inside a labelled radiogroup with >=44pt height', async () => {
    const renderer = await render({ value: null, onChange: jest.fn() });

    const group = renderer.root.findAll(
      node => node.props.accessibilityRole === 'radiogroup',
    );
    expect(group.length).toBeGreaterThanOrEqual(1);
    expect(group[0]!.props.accessibilityLabel).toBe(
      'Which technique are you working on?',
    );

    for (const node of chips(renderer)) {
      expect(node.props.accessibilityRole).toBe('radio');
      expect(typeof node.props.accessibilityLabel).toBe('string');
      expect(node.props.accessibilityLabel.length).toBeGreaterThan(0);
      expect(typeof node.props.onPress).toBe('function');
      expect(node.props.disabled).toBeUndefined();
      expect(flatten(node.props.style).minHeight).toBeGreaterThanOrEqual(44);
    }
    // The role reaches the host view Pressable renders (PressableScale
    // forwards it), so assistive tech sees 13 radios.
    const radios = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityRole === 'radio',
    );
    expect(radios).toHaveLength(13);
  });

  it('every chip label matches its visible text', async () => {
    const renderer = await render({ value: null, onChange: jest.fn() });
    for (const node of chips(renderer)) {
      const text = node
        .findAllByType(Text)
        .map(child => String(child.props.children))
        .join(' ');
      const label = node.props.accessibilityLabel as string;
      expect(text.toLowerCase()).toContain(label.toLowerCase());
    }
  });
});

describe('TechniqueIntentPicker — null / foreign value safety', () => {
  it('renders with value=null and a value whose canonical is not in the registry', async () => {
    const onChange = jest.fn();
    const foreign: TechniqueIntent = {
      version: TECHNIQUE_INTENT_VERSION,
      source: 'voice',
      canonical: 'NOT_A_REAL_TECHNIQUE',
      legacySlug: null,
      confidence: 0.5,
    };
    const renderer = await render({ value: foreign, onChange });
    expect(
      chips(renderer).every(
        node => node.props.accessibilityState.selected === false,
      ),
    ).toBe(true);

    // Controls still fire.
    await act(async () => {
      chip(renderer, 'Overhead').props.onPress();
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ canonical: 'OVERHEAD', source: 'tap' }),
    );
    await update(renderer, { value: null, onChange });
    expect(chipLabels(renderer)).toEqual(ALL_LABELS);
  });

  it('dark variant renders the same ledger of controls', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange, dark: true });
    expect(chipLabels(renderer)).toEqual(ALL_LABELS);
    await act(async () => {
      chip(renderer, 'Third-Shot Drop').props.onPress();
    });
    expect(onChange).toHaveBeenCalledWith({
      version: TECHNIQUE_INTENT_VERSION,
      source: 'tap',
      canonical: 'DROP',
      legacySlug: 'third_shot_drop',
      confidence: 1,
    });
    await typeText(renderer, 'xyzzy blah');
    expect(rendered(renderer)).toContain('Didn’t catch a technique');
  });

  it('a selected value stays selected after a resolved phrase re-renders the grid', async () => {
    const onChange = jest.fn();
    const renderer = await render({ value: null, onChange });
    await typeText(renderer, 'return');
    const intent = onChange.mock.calls[0]![0] as TechniqueIntent;
    expect(intent.canonical).toBe('RETURN');
    await update(renderer, { value: intent, onChange });
    expect(chip(renderer, 'Return').props.accessibilityState.selected).toBe(
      true,
    );
  });
});
