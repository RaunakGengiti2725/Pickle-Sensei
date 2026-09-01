import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  resolveVoiceTechniqueIntent,
  projectVoiceResolution,
  type TechniqueIntent,
} from '@pickle/shared-types';
import { TechniqueIntentPicker } from '../../src/flow/TechniqueIntentPicker';

/**
 * Voice/text provenance and grid-narrowing honesty: the emitted intent
 * carries the words that actually resolved (not the previous keystroke) and
 * the resolver's own confidence; narrowing never hides the technique the
 * parent still holds, and the "pick one below" prompt clears once one is
 * picked.
 */

const serveIntent: TechniqueIntent = {
  version: 'technique-intent-v1',
  source: 'tap',
  canonical: 'SERVE',
  legacySlug: 'serve',
  confidence: 1,
};

async function render(value: TechniqueIntent | null, onChange = jest.fn()) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <TechniqueIntentPicker value={value} onChange={onChange} />,
    );
  });
  return { renderer, onChange };
}

function input(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType(TextInput);
}

async function type(renderer: TestRenderer.ReactTestRenderer, value: string) {
  await act(async () => {
    input(renderer).props.onChangeText(value);
  });
}

function radios(renderer: TestRenderer.ReactTestRenderer) {
  const byLabel = new Map<
    string,
    { label: string; selected: boolean; press: () => void }
  >();
  for (const node of renderer.root.findAll(
    node =>
      node.props.accessibilityRole === 'radio' &&
      typeof node.props.onPress === 'function',
  )) {
    const label = String(node.props.accessibilityLabel);
    if (byLabel.has(label)) continue;
    byLabel.set(label, {
      label,
      selected: Boolean(node.props.accessibilityState?.selected),
      press: node.props.onPress as () => void,
    });
  }
  return [...byLabel.values()];
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string => typeof child === 'string')
    .join(' ');
}

describe('TechniqueIntentPicker voice provenance', () => {
  it('records the words that resolved, not the previous keystroke', async () => {
    const { renderer, onChange } = await render(null);
    await type(renderer, 'serv');
    await type(renderer, 'serve');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[0]![0]).toMatchObject({
      source: 'voice',
      canonical: 'SERVE',
      rawUserText: 'serv',
    });
    expect(onChange.mock.calls[1]![0]).toMatchObject({
      source: 'voice',
      canonical: 'SERVE',
      rawUserText: 'serve',
    });
    act(() => renderer.unmount());
  });

  it('carries a one-shot dictation verbatim', async () => {
    const { renderer, onChange } = await render(null);
    await type(renderer, ' backhand dink ');
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'voice',
        canonical: 'BACKHAND_DINK',
        rawUserText: 'backhand dink',
      }),
    );
    act(() => renderer.unmount());
  });

  it('uses the resolver confidence instead of a constant', async () => {
    const { renderer, onChange } = await render(null);
    for (const phrase of ['serve', 'backhand dink', 'forehand drive']) {
      onChange.mockClear();
      await type(renderer, phrase);
      const projected = projectVoiceResolution(
        resolveVoiceTechniqueIntent(phrase),
      );
      expect(projected.status).toBe('resolved');
      if (projected.status !== 'resolved') return;
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          canonical: projected.technique.canonical,
          confidence: projected.confidence,
        }),
      );
    }
    act(() => renderer.unmount());
  });

  it('submit emits the current text with the resolver confidence', async () => {
    const { renderer, onChange } = await render(null);
    await type(renderer, 'serve');
    onChange.mockClear();
    await act(async () => {
      input(renderer).props.onSubmitEditing();
    });
    const projected = projectVoiceResolution(
      resolveVoiceTechniqueIntent('serve'),
    );
    expect(projected.status).toBe('resolved');
    if (projected.status !== 'resolved') return;
    expect(onChange).toHaveBeenCalledWith({
      version: 'technique-intent-v1',
      source: 'voice',
      canonical: 'SERVE',
      legacySlug: 'serve',
      confidence: projected.confidence,
      rawUserText: 'serve',
    });
    act(() => renderer.unmount());
  });
});

describe('TechniqueIntentPicker narrowing vs. current selection', () => {
  it('keeps the held technique visible and selected while the grid narrows', async () => {
    const { renderer } = await render(serveIntent);
    await type(renderer, 'dink');
    const chips = radios(renderer);
    expect(chips.map(chip => chip.label)).toEqual(
      expect.arrayContaining(['Forehand Dink', 'Backhand Dink', 'Serve']),
    );
    expect(chips.filter(chip => chip.selected).map(chip => chip.label)).toEqual(
      ['Serve'],
    );
    expect(allText(renderer)).toContain('pick one below');
    act(() => renderer.unmount());
  });

  it('drops the "pick one below" prompt once a narrowed option is picked', async () => {
    const onChange = jest.fn();
    const { renderer } = await render(serveIntent, onChange);
    await type(renderer, 'dink');
    const forehandDink = radios(renderer).find(
      chip => chip.label === 'Forehand Dink',
    )!;
    await act(async () => {
      forehandDink.press();
    });
    const picked = onChange.mock.calls.at(-1)![0] as TechniqueIntent;
    expect(picked).toMatchObject({ source: 'tap', canonical: 'FOREHAND_DINK' });

    await act(async () => {
      renderer.update(
        <TechniqueIntentPicker value={picked} onChange={onChange} />,
      );
    });
    expect(allText(renderer)).not.toContain('pick one below');
    const chips = radios(renderer);
    expect(chips.map(chip => chip.label)).not.toContain('Serve');
    expect(chips.filter(chip => chip.selected).map(chip => chip.label)).toEqual(
      ['Forehand Dink'],
    );
    act(() => renderer.unmount());
  });
});
