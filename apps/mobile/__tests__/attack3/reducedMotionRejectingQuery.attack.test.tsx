import React from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { useReducedMotion } from '../../src/design/components';

/**
 * Attack pass 3 extra — the reduce-motion observer starts on the FIRST
 * consumer mount and does `void isReduceMotionEnabled().then(...)` with no
 * catch. Own file so the module-level "started" latch is fresh.
 */

function Probe() {
  const reduced = useReducedMotion();
  return <Text>{reduced ? 'reduced' : 'motion'}</Text>;
}

it('the native query is chained with NO rejection handler: a rejecting isReduceMotionEnabled would be an unhandled rejection; consumers stay on "motion" and the change listener still recovers', async () => {
  const info = AccessibilityInfo as unknown as {
    isReduceMotionEnabled: jest.Mock;
    addEventListener: jest.Mock;
  };
  const original = info.isReduceMotionEnabled.getMockImplementation();
  // A thenable that records how the module chains it. Returning a real
  // rejected promise here makes jest itself report the unhandled rejection
  // as a test failure (see extras-reducedMotion-unhandledRejection-evidence
  // artifact), so the shape of the chain is asserted instead.
  const thenCalls: Array<{ hasRejectionHandler: boolean }> = [];
  const thenable = {
    then(
      onFulfilled?: (v: boolean) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) {
      thenCalls.push({ hasRejectionHandler: typeof onRejected === 'function' });
      void onFulfilled;
      return {
        then: () => undefined,
        catch: () => {
          throw new Error('module attached a catch — update this test');
        },
      };
    },
  };
  info.isReduceMotionEnabled.mockImplementation(() => thenable);
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(<Probe />);
    });
  } finally {
    if (original) info.isReduceMotionEnabled.mockImplementation(original);
  }
  expect(info.isReduceMotionEnabled).toHaveBeenCalledTimes(1);
  expect(thenCalls).toEqual([{ hasRejectionHandler: false }]);
  expect(renderer.root.findByType(Text).props.children).toBe('motion');
  // The change listener is attached regardless, so a later OS toggle recovers.
  const listener = info.addEventListener.mock.calls.find(
    c => c[0] === 'reduceMotionChanged',
  )?.[1] as ((v: boolean) => void) | undefined;
  expect(listener).toBeDefined();
  act(() => listener!(true));
  expect(renderer.root.findByType(Text).props.children).toBe('reduced');
  act(() => renderer.unmount());
});
