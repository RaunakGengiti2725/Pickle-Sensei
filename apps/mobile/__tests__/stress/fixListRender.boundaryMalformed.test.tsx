import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ShotAnalysis } from '@pickle/shared-types';
import { FixList } from '../../src/review/FixList';
import { coachingCue } from '../../src/review/formReviewModel';
import {
  PROTO_KEYS,
  Rng,
  jsonRoundTrip,
  validAnalysis,
} from '../../test-support/stress/reviewMalformed';

/**
 * STRESS · boundary/malformed input · FixList render.
 *
 * `fixList()` is the seam between unvalidated persisted analysis JSON and
 * React: whatever `coachingCue` returns becomes a `<Text>` child. A string
 * (even an odd one) renders; a plain object throws inside React ("Objects
 * are not valid as a React child") and takes the Result / breakdown screen
 * down with it. This pins that the seam holds for prototype-named directions
 * and shot types.
 */

const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

afterAll(() => {
  consoleError.mockRestore();
});

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function faultyAnalysis(direction: string, shotType: string): ShotAnalysis {
  const analysis = validAnalysis(new Rng(7));
  return jsonRoundTrip({
    ...analysis,
    shotType: shotType as ShotAnalysis['shotType'],
    checkpoints: analysis.checkpoints.map((cp, index) =>
      index === 0
        ? {
            ...cp,
            applicable: true,
            band: 'red' as const,
            score: 35,
            direction: direction as never,
          }
        : { ...cp, applicable: true, band: 'green' as const, score: 90 },
    ),
    priorityFix: null,
  });
}

const CASES: [string, string][] = [
  ...PROTO_KEYS.map((key): [string, string] => [key, 'dink']),
  ...PROTO_KEYS.map((key): [string, string] => ['late', key]),
  ['constructor', 'prototype'],
  ['constructor', '__proto__'],
  ['__proto__', 'constructor'],
];

describe('FixList · render with prototype-named persisted direction/shotType', () => {
  it.each(CASES)(
    'direction=%p shotType=%p → coachingCue is a string and FixList renders',
    async (direction, shotType) => {
      const key = faultyAnalysis(direction, shotType).checkpoints[0]!.key;
      const cue: unknown = coachingCue(
        key,
        direction as never,
        shotType as never,
      );
      let renderError: string | null = null;
      let renderer: TestRenderer.ReactTestRenderer | null = null;
      try {
        renderer = await render(
          <FixList analysis={faultyAnalysis(direction, shotType)} />,
        );
      } catch (error) {
        renderError = error instanceof Error ? error.message : String(error);
      }
      expect({
        cueType: typeof cue,
        cue: typeof cue === 'function' ? `[function ${cue.name}]` : cue,
        renderError,
      }).toEqual({ cueType: 'string', cue, renderError: null });
      if (renderer) {
        expect(renderer.toJSON()).not.toBeNull();
        const mounted = renderer;
        await act(async () => {
          mounted.unmount();
        });
      }
    },
  );
});
