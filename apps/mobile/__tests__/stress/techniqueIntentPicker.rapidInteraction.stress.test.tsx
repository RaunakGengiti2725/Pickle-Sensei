/**
 * Seeded rapid-interaction stress campaign for
 * `src/flow/TechniqueIntentPicker.tsx`.
 *
 * Each seed drives a fresh picker (inside a real stateful parent) through a
 * burst script generated from `mulberry32(seed)`: double/triple/quad taps,
 * press-in/press/press-out storms on `PressableScale`, typing that narrows
 * or clears the grid, submits, dark-mode re-renders, re-tapping the selected
 * chip — either one action per `act()` ("sequential") or a whole burst inside
 * a single `act()` ("simultaneous", the batched-event shape a fast thumb or
 * dictation + tap produces).
 *
 * Oracle: a pure model of the picker (same resolver the component uses)
 * predicts the exact `onChange` emission list for every burst. Invariants
 * checked after every act():
 *
 *   - emissions === predicted, in order (one side effect per intent — a tap
 *     is one intent, N taps are N intents, a narrowing keystroke is zero)
 *   - grid labels === predicted visible set, unique, Auto Detect last
 *   - exactly the chips matching `value.canonical` are `selected`
 *   - the TextInput echoes the model text; at most one hint Text
 *   - no console.error / console.warn (act() warnings, unmounted-update
 *     warnings) and no unhandled rejections
 *
 * Replay one seed:  STRESS_SEED=<seed> npx jest --ci techniqueIntentPicker.rapidInteraction
 * Widen campaign:   STRESS_ITER=3000 STRESS_OUT=/tmp/stress npx jest --ci techniqueIntentPicker.rapidInteraction
 */
import React, { useState } from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  projectVoiceResolution,
  resolveVoiceTechniqueIntent,
  SELECTABLE_TECHNIQUES_V1,
  TECHNIQUE_INTENT_VERSION,
  type IntentResolution,
  type SelectableTechnique,
  type TechniqueIntent,
} from '@pickle/shared-types';
import {
  autoDetectIntent,
  TechniqueIntentPicker,
} from '../../src/flow/TechniqueIntentPicker';
import { PressableScale } from '../../src/design/components';
import {
  campaignSeeds,
  ConsoleGuard,
  makeRng,
  ResultTable,
  runSeed,
  type Rng,
  type Trace,
} from '../../__harness__/stress/rapidInteraction';

type Renderer = TestRenderer.ReactTestRenderer;

const AUTO_LABEL = 'Auto detect';
const DEFAULT_ITERATIONS = 300;
/** PressableScale press-in/out animations are 90/180ms; flush generously. */
const ANIMATION_FLUSH_MS = 400;

const PHRASES: readonly string[] = [
  // resolves to a single technique
  'forehand drive',
  'backhand dink',
  'serve',
  'third shot drop',
  'overhead smash',
  'forehand volley',
  'backhand volley',
  'bh drive',
  'fh dink',
  'reset',
  'speed up',
  'return',
  // ambiguous (narrows the grid)
  'dink',
  'volley',
  'drive',
  'backhand',
  'forehand',
  // unknown / idiom
  'lob',
  'hello there',
  'serve dinner',
  'zzz qqq',
  // auto words
  'not sure',
  'auto detect',
  'whatever',
  // below the 3-char threshold / whitespace
  'di',
  'a',
  '   ',
  '',
];

// ---------------------------------------------------------------------------
// Host: a real stateful parent so batched emissions inside one act() resolve
// through React's own last-write-wins, exactly as AnalyzeScreen would.
// ---------------------------------------------------------------------------

type HostMode = 'adopt' | 'ignore' | 'fixed';

function Host(props: {
  mode: HostMode;
  fixed: TechniqueIntent | null;
  dark: boolean;
  spy: (intent: TechniqueIntent | null) => void;
}) {
  const [adopted, setAdopted] = useState<TechniqueIntent | null>(null);
  const value = props.mode === 'adopt' ? adopted : props.fixed;
  return (
    <TechniqueIntentPicker
      value={value}
      dark={props.dark}
      onChange={intent => {
        props.spy(intent);
        if (props.mode === 'adopt') setAdopted(intent);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

function tapIntent(technique: SelectableTechnique): TechniqueIntent {
  return {
    version: TECHNIQUE_INTENT_VERSION,
    source: 'tap',
    canonical: technique.canonical,
    legacySlug: technique.legacySlug,
    confidence: 1,
  };
}

function voiceIntent(
  technique: SelectableTechnique,
  confidence: number,
  raw: string,
): TechniqueIntent {
  return {
    version: TECHNIQUE_INTENT_VERSION,
    source: 'voice',
    canonical: technique.canonical,
    legacySlug: technique.legacySlug,
    confidence,
    rawUserText: raw.trim(),
  };
}

function resolve(text: string): IntentResolution | null {
  return text.trim().length >= 3
    ? projectVoiceResolution(resolveVoiceTechniqueIntent(text))
    : null;
}

/** What onChangeText(value) emits (the component resolves live). */
function emissionsForType(value: string): TechniqueIntent[] {
  const res = resolve(value);
  return res?.status === 'resolved'
    ? [voiceIntent(res.technique, res.confidence, value)]
    : [];
}

/** What onSubmitEditing emits for the text the rendered closure saw. */
function emissionsForSubmit(text: string): TechniqueIntent[] {
  const res = resolve(text);
  if (!res) return [];
  if (res.status === 'resolved')
    return [voiceIntent(res.technique, res.confidence, text)];
  if (res.status === 'auto') return [autoDetectIntent()];
  return [];
}

interface Expected {
  labels: string[];
  selectedLabels: string[];
  autoSelected: boolean;
  hintCount: number;
}

function expectedView(text: string, value: TechniqueIntent | null): Expected {
  const res = resolve(text);
  const selectedTechnique =
    SELECTABLE_TECHNIQUES_V1.find(t => t.canonical === value?.canonical) ??
    null;
  const narrowed = res?.status === 'ambiguous' ? res.options : null;
  const selectionInNarrowed =
    narrowed !== null &&
    selectedTechnique !== null &&
    narrowed.some(o => o.canonical === selectedTechnique.canonical);
  const visible: readonly SelectableTechnique[] =
    narrowed === null
      ? SELECTABLE_TECHNIQUES_V1
      : selectedTechnique !== null && !selectionInNarrowed
        ? [...narrowed, selectedTechnique]
        : narrowed;
  const autoSelected = value?.source === 'auto';
  let hintCount = 0;
  if (res?.status === 'ambiguous' && !selectionInNarrowed) hintCount += 1;
  else if (res?.status === 'unknown') hintCount += 1;
  if (autoSelected) hintCount += 1;
  return {
    labels: [...visible.map(t => t.displayName), AUTO_LABEL],
    selectedLabels: visible
      .filter(t => t.canonical === value?.canonical)
      .map(t => t.displayName),
    autoSelected,
    hintCount,
  };
}

// ---------------------------------------------------------------------------
// Tree access
// ---------------------------------------------------------------------------

function chips(renderer: Renderer) {
  return renderer.root.findAllByType(PressableScale);
}

function chipLabels(renderer: Renderer): string[] {
  return chips(renderer).map(n => n.props.accessibilityLabel as string);
}

function chipByLabel(renderer: Renderer, label: string) {
  const matches = chips(renderer).filter(
    n => n.props.accessibilityLabel === label,
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one chip "${label}", found ${matches.length}`,
    );
  }
  return matches[0]!;
}

/** The host Pressable inside a PressableScale (owns press-in/out). */
function innerPressable(chipNode: TestRenderer.ReactTestInstance) {
  const hosts = chipNode.findAll(
    n =>
      n !== chipNode &&
      typeof n.props.onPressIn === 'function' &&
      typeof n.props.onPressOut === 'function' &&
      typeof n.props.onPress === 'function',
  );
  if (hosts.length === 0) throw new Error('PressableScale has no Pressable');
  return hosts[0]!;
}

function field(renderer: Renderer) {
  return renderer.root.findByType(TextInput);
}

function insideChip(node: TestRenderer.ReactTestInstance): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === PressableScale) return true;
  }
  return false;
}

/** Hint copy = Text nodes that are not chip labels. */
function hintTexts(renderer: Renderer) {
  return renderer.root.findAllByType(Text).filter(node => !insideChip(node));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Action =
  | { kind: 'tap'; label: string; times: number }
  | { kind: 'pressCycle'; label: string; times: number }
  | { kind: 'type'; value: string }
  | { kind: 'submit' }
  | { kind: 'toggleDark' };

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'tap':
      return `tap(${action.label})x${action.times}`;
    case 'pressCycle':
      return `pressCycle(${action.label})x${action.times}`;
    case 'type':
      return `type(${JSON.stringify(action.value)})`;
    case 'submit':
      return 'submit';
    case 'toggleDark':
      return 'toggleDark';
  }
}

function generateAction(rng: Rng, visibleLabels: readonly string[]): Action {
  const roll = rng.next();
  if (roll < 0.34) {
    return {
      kind: 'tap',
      label: rng.pick(visibleLabels),
      times: rng.chance(0.5) ? 1 : rng.int(2, 4),
    };
  }
  if (roll < 0.5) {
    return {
      kind: 'pressCycle',
      label: rng.pick(visibleLabels),
      times: rng.int(1, 3),
    };
  }
  if (roll < 0.78) return { kind: 'type', value: rng.pick(PHRASES) };
  if (roll < 0.92) return { kind: 'submit' };
  return { kind: 'toggleDark' };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

const table = new ResultTable('techniqueIntentPicker.rapidInteraction');
const guard = new ConsoleGuard();

beforeEach(() => {
  jest.useFakeTimers();
  guard.arm();
});

afterEach(() => {
  guard.disarm();
  jest.useRealTimers();
});

afterAll(() => {
  table.flush();
});

async function runIteration(seed: number, trace: Trace): Promise<void> {
  const rng = makeRng(seed);
  const mode: HostMode = rng.pick([
    'adopt',
    'adopt',
    'adopt',
    'ignore',
    'fixed',
  ]);
  const fixed: TechniqueIntent | null =
    mode !== 'fixed'
      ? null
      : rng.chance(0.2)
        ? autoDetectIntent()
        : rng.chance(0.2)
          ? {
              version: TECHNIQUE_INTENT_VERSION,
              source: 'tap',
              canonical: 'FOREIGN_TECHNIQUE',
              legacySlug: null,
              confidence: 1,
            }
          : tapIntent(rng.pick(SELECTABLE_TECHNIQUES_V1));
  let dark = rng.chance(0.3);
  trace.step(
    `host(${mode}${fixed ? `:${fixed.canonical ?? 'auto'}` : ''},dark=${dark})`,
  );

  const emitted: Array<TechniqueIntent | null> = [];
  let totalEmitted = 0;
  const spy = (intent: TechniqueIntent | null) => {
    emitted.push(intent);
    totalEmitted += 1;
  };

  // Model state.
  let actionCount = 0;
  let text = '';
  let value: TechniqueIntent | null = mode === 'adopt' ? null : fixed;

  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Host mode={mode} fixed={fixed} dark={dark} spy={spy} />,
    );
  });

  const check = (where: string) => {
    const expected = expectedView(text, value);
    const labels = chipLabels(renderer);
    expect({ where, labels }).toEqual({ where, labels: expected.labels });
    expect(new Set(labels).size).toBe(labels.length);
    const selected = chips(renderer)
      .filter(
        n =>
          n.props.accessibilityLabel !== AUTO_LABEL &&
          n.props.accessibilityState?.selected === true,
      )
      .map(n => n.props.accessibilityLabel as string);
    expect({ where, selected }).toEqual({
      where,
      selected: expected.selectedLabels,
    });
    expect(
      chipByLabel(renderer, AUTO_LABEL).props.accessibilityState?.selected,
    ).toBe(expected.autoSelected);
    expect(renderer.root.findAllByType(TextInput)).toHaveLength(1);
    expect(field(renderer).props.value).toBe(text);
    expect(hintTexts(renderer)).toHaveLength(expected.hintCount);
    const diagnostics = guard.drain();
    expect({ where, diagnostics }).toEqual({ where, diagnostics: [] });
  };

  check('initial');

  const bursts = rng.int(1, 6);
  for (let b = 0; b < bursts; b++) {
    const simultaneous = rng.chance(0.45);
    const count = rng.int(1, 5);

    const applyModel = (action: Action, textAtRender: string) => {
      const expectedEmissions: TechniqueIntent[] = [];
      switch (action.kind) {
        case 'tap':
        case 'pressCycle': {
          const technique = SELECTABLE_TECHNIQUES_V1.find(
            t => t.displayName === action.label,
          );
          const single =
            action.label === AUTO_LABEL
              ? autoDetectIntent()
              : tapIntent(technique!);
          for (let i = 0; i < action.times; i++) expectedEmissions.push(single);
          break;
        }
        case 'type':
          text = action.value;
          expectedEmissions.push(...emissionsForType(action.value));
          break;
        case 'submit':
          expectedEmissions.push(...emissionsForSubmit(textAtRender));
          break;
        case 'toggleDark':
          dark = !dark;
          break;
      }
      if (mode === 'adopt' && expectedEmissions.length > 0) {
        value = expectedEmissions[expectedEmissions.length - 1]!;
      }
      return expectedEmissions;
    };

    const fire = (action: Action) => {
      actionCount += 1;
      switch (action.kind) {
        case 'tap': {
          const node = chipByLabel(renderer, action.label);
          for (let i = 0; i < action.times; i++) node.props.onPress();
          break;
        }
        case 'pressCycle': {
          const host = innerPressable(chipByLabel(renderer, action.label));
          for (let i = 0; i < action.times; i++) {
            host.props.onPressIn();
            host.props.onPress();
            host.props.onPressOut();
          }
          break;
        }
        case 'type':
          field(renderer).props.onChangeText(action.value);
          break;
        case 'submit':
          field(renderer).props.onSubmitEditing();
          break;
        case 'toggleDark':
          renderer.update(
            <Host mode={mode} fixed={fixed} dark={dark} spy={spy} />,
          );
          break;
      }
    };

    if (simultaneous) {
      // Every handler in the burst comes from the tree rendered at burst
      // start, so labels are sampled from that view and submit sees that
      // render's text (setText has not committed yet).
      const textAtRender = text;
      const visibleAtStart = expectedView(text, value).labels;
      const actions: Action[] = [];
      for (let i = 0; i < count; i++) {
        actions.push(generateAction(rng, visibleAtStart));
      }
      trace.step(`SIM[${actions.map(describeAction).join(',')}]`);
      const expectedEmissions: TechniqueIntent[] = [];
      for (const action of actions) {
        expectedEmissions.push(...applyModel(action, textAtRender));
      }
      emitted.length = 0;
      await act(async () => {
        for (const action of actions) fire(action);
      });
      expect(emitted).toEqual(expectedEmissions);
      await act(async () => {
        jest.advanceTimersByTime(ANIMATION_FLUSH_MS);
      });
      check(`burst ${b} (simultaneous)`);
    } else {
      const described: string[] = [];
      trace.step('SEQ[...]');
      for (let i = 0; i < count; i++) {
        const action = generateAction(rng, expectedView(text, value).labels);
        described.push(describeAction(action));
        trace.steps[trace.steps.length - 1] = `SEQ[${described.join(',')}]`;
        const expectedEmissions = applyModel(action, text);
        emitted.length = 0;
        await act(async () => {
          fire(action);
        });
        expect(emitted).toEqual(expectedEmissions);
        if (rng.chance(0.5)) {
          await act(async () => {
            jest.advanceTimersByTime(rng.int(0, ANIMATION_FLUSH_MS));
          });
        }
        check(`burst ${b} action ${describeAction(action)}`);
      }
    }
  }

  // Tear down mid-animation on some seeds: an in-flight PressableScale
  // timing must not warn or throw once the tree is gone.
  if (rng.chance(0.5)) {
    const label = rng.pick(expectedView(text, value).labels);
    trace.step(`pressIn(${label}) then unmount`);
    await act(async () => {
      innerPressable(chipByLabel(renderer, label)).props.onPressIn();
    });
  }
  await act(async () => {
    renderer.unmount();
  });
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  expect(guard.drain()).toEqual([]);
  trace.extra.emissionsTotal = totalEmitted;
  trace.extra.actionCount = actionCount;
  trace.extra.finalText = text;
  trace.extra.finalValue = value?.canonical ?? (value ? 'auto' : null);
}

describe('TechniqueIntentPicker rapid-interaction stress (seeded)', () => {
  const seeds = campaignSeeds(DEFAULT_ITERATIONS);

  it.each(seeds)('seed %i holds every invariant', async seed => {
    await runSeed(table, seed, trace => runIteration(seed, trace));
  });
});
