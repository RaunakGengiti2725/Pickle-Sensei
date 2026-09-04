/**
 * ADVERSARIAL PASS 3 (tester #2) — S7 side probe (NOT part of the jest suite).
 *
 * `startReducedMotionObserver` (src/design/components.tsx:50-55) does
 *   void AccessibilityInfo.isReduceMotionEnabled().then(setReducedMotion);
 * with no rejection handler. If the accessibility bridge rejects, the
 * rejection is unhandled. Inside a multi-suite jest run that took the worker
 * down (observed once: `Error: accessibility bridge unavailable` +
 * `Node.js v22.12.0`, exit 1 before the reporter summarised), so this probe
 * lives outside `__tests__` and is executed on its own:
 *
 *   cd apps/mobile && npx jest --ci --testMatch '**\/attack-harness/*.probe.tsx' \
 *     attack-harness/dcw2-reducedMotion-rejection.probe.tsx
 *
 * Expected if the observer handled rejection: the test passes and jest exits
 * 0. Observed on 4d812e1a: jest attributes the unhandled rejection to the
 * test as an uncaught error (exit 1) even though the ring itself renders —
 * i.e. the ring survives, the rejection does not get swallowed. (In a RN
 * release build an unhandled rejection is logged, not fatal — INFERRED, not
 * verified here.)
 */
import React from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { ScoreRing } from '../src/design/components';

const isReduceMotionEnabled =
  AccessibilityInfo.isReduceMotionEnabled as jest.MockedFunction<
    typeof AccessibilityInfo.isReduceMotionEnabled
  >;

it('PROBE — isReduceMotionEnabled rejects: the ring must still render and the process must survive', async () => {
  const failure = new Error('accessibility bridge unavailable');
  isReduceMotionEnabled.mockReturnValue(Promise.reject(failure));
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ScoreRing score={5.5} />);
  });
  await new Promise<void>(resolve => setTimeout(resolve, 50));
  const text = renderer.root
    .findAllByType(Text)
    .map(n => String(n.props.children))
    .join('|');
  // The number is mid count-up under real timers; any numeric text proves
  // the ring rendered despite the rejected accessibility read.
  expect(text).toMatch(/^\d+\.\d$/);
  act(() => renderer.unmount());
});
