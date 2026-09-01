/**
 * Static design components must never masquerade as disabled controls, and
 * ErrorState's action label must describe what the tap does.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';

import { CheckpointRow, ErrorState } from '../../src/design/components';

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function hostByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.accessibilityLabel === label,
  );
  if (!node) throw new Error(`No host node labeled ${label}`);
  return node;
}

function pressByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labeled ${label}`);
  act(() => {
    node.props.onPress();
  });
}

function flattenedOpacity(node: TestRenderer.ReactTestInstance) {
  const style = StyleSheet.flatten(
    typeof node.props.style === 'function'
      ? node.props.style({ pressed: false })
      : node.props.style,
  ) as { opacity?: number };
  return style.opacity;
}

describe('fix-12: CheckpointRow', () => {
  it('without onPress is static text, not a dimmed disabled control', () => {
    const renderer = render(
      <CheckpointRow name="Paddle prep" score={72} band="green" />,
    );
    const row = hostByLabel(renderer, 'Paddle prep, 72 out of 100');

    expect(row.props.accessibilityRole).toBe('text');
    expect(row.props.accessibilityState?.disabled).toBeUndefined();
    expect(row.props.onPress).toBeUndefined();
    expect(flattenedOpacity(row)).not.toBe(0.42);
    expect(
      renderer.root.findAll(
        n => typeof n.props.onPressIn === 'function' || 'disabled' in n.props,
      ),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('with onPress is an enabled button', () => {
    const onPress = jest.fn();
    const renderer = render(
      <CheckpointRow
        name="Contact point"
        score={null}
        band="unscored"
        onPress={onPress}
      />,
    );
    const row = hostByLabel(renderer, 'Contact point, not read');

    expect(row.props.accessibilityRole).toBe('button');
    expect(row.props.accessibilityState?.disabled).toBeFalsy();
    pressByLabel(renderer, 'Contact point, not read');
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});

describe('fix-12: ErrorState', () => {
  it('labels the action with retryLabel when provided', () => {
    const onRetry = jest.fn();
    const renderer = render(
      <ErrorState
        title="Result missing"
        detail="This analysis is no longer on this device."
        onRetry={onRetry}
        retryLabel="Go back"
      />,
    );
    expect(hostByLabel(renderer, 'Go back').props.accessibilityRole).toBe(
      'button',
    );
    expect(
      renderer.root.findAll(
        n => typeof n.type === 'string' && n.props.accessibilityLabel,
      ),
    ).toHaveLength(1);
    pressByLabel(renderer, 'Go back');
    expect(onRetry).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('keeps "Try again" as the default action label', () => {
    const renderer = render(
      <ErrorState title="Offline" detail="Retry later." onRetry={() => {}} />,
    );
    expect(hostByLabel(renderer, 'Try again')).toBeDefined();
    act(() => renderer.unmount());
  });
});
