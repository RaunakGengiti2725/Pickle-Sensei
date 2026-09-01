import React from 'react';
import { StyleSheet, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Accessibility workflow audit — shared design primitives.
 *
 * Every screen's pressables are built on `PressableScale` / `Button` /
 * `ScreenHeader` / `ErrorState`, so their semantics are the floor for the
 * whole app: default button role, visible label mirrored to VoiceOver,
 * `disabled` mirrored into `accessibilityState` AND enforced on activation,
 * ≥44pt targets, and text that can grow under Dynamic Type (no fixed height,
 * no single-line clipping on primary buttons).
 */

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

import {
  Button,
  ErrorState,
  PressableScale,
  ScreenHeader,
} from '../../src/design/components';

const MIN_TARGET_PT = 44;

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function hostPressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' && typeof node.props.onClick === 'function',
  );
}

function onlyPressable(renderer: TestRenderer.ReactTestRenderer) {
  const nodes = hostPressables(renderer);
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

function flat(node: TestRenderer.ReactTestInstance) {
  return StyleSheet.flatten(node.props.style) ?? {};
}

describe('Design primitives — accessibility floor', () => {
  it('PressableScale defaults to the button role and merges disabled into accessibilityState', () => {
    const onPress = jest.fn();
    const renderer = render(
      <PressableScale accessibilityLabel="Open" onPress={onPress}>
        <Text>Open</Text>
      </PressableScale>,
    );
    const node = onlyPressable(renderer);
    expect(node.props.accessibilityRole).toBe('button');
    expect(node.props.accessibilityLabel).toBe('Open');
    expect(node.props.accessibilityState).toEqual({ disabled: undefined });
    act(() => node.props.onClick());
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('PressableScale keeps caller roles/states (radio + selected) and forwards hitSlop', () => {
    const renderer = render(
      <PressableScale
        accessibilityRole="radio"
        accessibilityLabel="Forehand"
        accessibilityState={{ selected: true }}
        hitSlop={12}
        onPress={() => undefined}
      >
        <Text>Forehand</Text>
      </PressableScale>,
    );
    const node = onlyPressable(renderer);
    expect(node.props.accessibilityRole).toBe('radio');
    expect(node.props.accessibilityState).toEqual({
      selected: true,
      disabled: undefined,
    });
    expect(node.props.hitSlop).toBe(12);
    act(() => renderer.unmount());
  });

  it('disabled PressableScale announces disabled and swallows activation', () => {
    const onPress = jest.fn();
    const renderer = render(
      <PressableScale accessibilityLabel="Save" disabled onPress={onPress}>
        <Text>Save</Text>
      </PressableScale>,
    );
    const node = onlyPressable(renderer);
    expect(node.props.accessibilityState.disabled).toBe(true);
    act(() => node.props.onClick());
    expect(onPress).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('Button mirrors its visible label to VoiceOver and meets the 44pt floor in every size', () => {
    for (const compact of [false, true]) {
      const renderer = render(
        <Button
          label="Start your first read"
          compact={compact}
          onPress={() => undefined}
        />,
      );
      const node = onlyPressable(renderer);
      expect(node.props.accessibilityRole).toBe('button');
      expect(node.props.accessibilityLabel).toBe('Start your first read');
      const style = flat(node);
      expect(Number(style.minHeight)).toBeGreaterThanOrEqual(MIN_TARGET_PT);
      // Dynamic Type: height is a minimum, never fixed, and the label is
      // not clamped to one line.
      expect(style.height).toBeUndefined();
      const labelText = renderer.root
        .findAllByType(Text)
        .find(t => t.props.children === 'Start your first read')!;
      expect(labelText.props.numberOfLines).toBeUndefined();
      expect(labelText.props.allowFontScaling).not.toBe(false);
      act(() => renderer.unmount());
    }
  });

  it('disabled Button is announced disabled and inert on activation', () => {
    const onPress = jest.fn();
    const renderer = render(
      <Button label="Continue" disabled onPress={onPress} />,
    );
    const node = onlyPressable(renderer);
    expect(node.props.accessibilityState.disabled).toBe(true);
    act(() => node.props.onClick());
    expect(onPress).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('ScreenHeader Back/Close are labelled 44pt icon buttons with hitSlop', () => {
    const onBack = jest.fn();
    const onClose = jest.fn();
    for (const [props, label, handler] of [
      [{ onBack }, 'Back', onBack],
      [{ onClose }, 'Close', onClose],
    ] as const) {
      const renderer = render(<ScreenHeader title="Sub page" {...props} />);
      const node = onlyPressable(renderer);
      expect(node.props.accessibilityRole).toBe('button');
      expect(node.props.accessibilityLabel).toBe(label);
      expect(node.props.hitSlop).toBeGreaterThanOrEqual(8);
      const style = flat(node);
      expect(Number(style.width ?? style.minWidth)).toBeGreaterThanOrEqual(
        MIN_TARGET_PT,
      );
      expect(Number(style.height ?? style.minHeight)).toBeGreaterThanOrEqual(
        MIN_TARGET_PT,
      );
      act(() => node.props.onClick());
      expect(handler).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    }
  });

  it('ErrorState always renders a wired retry button (no dead end)', () => {
    const onRetry = jest.fn();
    const renderer = render(
      <ErrorState
        title="Something went wrong"
        detail="Could not load."
        onRetry={onRetry}
      />,
    );
    const node = onlyPressable(renderer);
    expect(node.props.accessibilityRole).toBe('button');
    expect(String(node.props.accessibilityLabel).length).toBeGreaterThan(0);
    act(() => node.props.onClick());
    expect(onRetry).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
