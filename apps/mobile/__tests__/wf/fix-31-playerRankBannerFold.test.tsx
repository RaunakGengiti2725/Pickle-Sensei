import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { PlayerRankBanner } from '../../src/components/PlayerRankBanner';

/**
 * The fold-out must stay mounted while its 180ms collapse animation runs,
 * then leave the tree; a reopen during the collapse cancels the unmount.
 */

function toggleNode(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      node.props.testID === 'player-rank-banner-toggle' &&
      typeof node.props.onPress === 'function',
  )[0]!;
}

function foldOutCount(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      node.props.testID === 'player-rank-banner-fold-out' &&
      typeof node.type === 'string',
  ).length;
}

async function render() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlayerRankBanner shots={[]} streakDays={0} />,
    );
  });
  return renderer;
}

describe('PlayerRankBanner fold-out lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps the fold-out mounted through the collapse animation, then unmounts it', async () => {
    const renderer = await render();
    expect(foldOutCount(renderer)).toBe(0);

    await act(async () => {
      toggleNode(renderer).props.onPress();
    });
    expect(foldOutCount(renderer)).toBe(1);
    expect(toggleNode(renderer).props.accessibilityState).toMatchObject({
      expanded: true,
    });

    await act(async () => {
      toggleNode(renderer).props.onPress();
    });
    expect(toggleNode(renderer).props.accessibilityState).toMatchObject({
      expanded: false,
    });
    expect(foldOutCount(renderer)).toBe(1);
    expect(
      renderer.root.findAll(
        node => node.props.testID === 'player-rank-banner-fold-out',
      )[0]!.props.pointerEvents,
    ).toBe('none');

    await act(async () => {
      jest.advanceTimersByTime(179);
    });
    expect(foldOutCount(renderer)).toBe(1);

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(foldOutCount(renderer)).toBe(0);
    act(() => renderer.unmount());
  });

  it('reopening mid-collapse cancels the pending unmount', async () => {
    const renderer = await render();
    await act(async () => {
      toggleNode(renderer).props.onPress();
    });
    await act(async () => {
      toggleNode(renderer).props.onPress();
    });
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    await act(async () => {
      toggleNode(renderer).props.onPress();
    });
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(foldOutCount(renderer)).toBe(1);
    expect(toggleNode(renderer).props.accessibilityState).toMatchObject({
      expanded: true,
    });
    act(() => renderer.unmount());
  });

  it('unmounting during the collapse does not fire a late state update', async () => {
    const renderer = await render();
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      toggleNode(renderer).props.onPress();
    });
    await act(async () => {
      toggleNode(renderer).props.onPress();
    });
    act(() => renderer.unmount());
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
