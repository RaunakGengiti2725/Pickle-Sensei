/**
 * ADVERSARIAL PASS 3 (tester #2) — mobile-design-components-walkthrough — S3.
 *
 * Two gates decide whether the tour points at a target:
 *   1. `useWalkthroughTarget` (targets.ts) rejects non-finite / non-positive
 *      measurements before they ever become a TargetRect;
 *   2. `rectVisibleInWindow` (FirstRunWalkthrough.tsx) accepts a rect whose
 *      CENTER is inside the inclusive window bounds.
 * The spotlight hole is then `holeForTarget` (+8 padding, circle or rounded).
 *
 * Attacks: sub-pixel rects (0.5×0.5, Number.MIN_VALUE), rects exactly ON the
 * window edge (center == width / height, inclusive), rects one ulp past the
 * edge, negative-zero and negative sizes, and a full end-to-end render of the
 * overlay with those rects registered — asserting the scrim `Path` hole is
 * never degenerate (positive width/height/radius, straight segments >= 0,
 * every number finite).
 */
import React, { useEffect } from 'react';
import { Dimensions, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import {
  FirstRunWalkthrough,
  WALKTHROUGH_STEPS,
  rectVisibleInWindow,
} from '../../src/walkthrough/FirstRunWalkthrough';
import {
  hasWalkthroughTarget,
  measureWalkthroughTarget,
  registerWalkthroughMeasurer,
  useWalkthroughTarget,
  type TargetRect,
  type WalkthroughTargetKey,
} from '../../src/walkthrough/targets';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';

const { width: W, height: H } = Dimensions.get('window');

type Renderer = TestRenderer.ReactTestRenderer;

let unregister: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of unregister) cleanup();
  unregister = [];
  useWalkthroughStore.setState({ visible: false });
});

// ─── Gate 1: useWalkthroughTarget with a fake measureInWindow ──────────────

type MeasureCb = (x: number, y: number, w: number, h: number) => void;

function Probe(props: {
  key_: WalkthroughTargetKey;
  measure: (cb: MeasureCb) => void;
}) {
  const ref = useWalkthroughTarget(props.key_);
  useEffect(() => {
    // Attach a fake host node: only `measureInWindow` is consulted.
    (ref as React.MutableRefObject<unknown>).current = {
      measureInWindow: props.measure,
    };
  }, [ref, props.measure]);
  return <View />;
}

async function measureThroughHook(
  tuple: readonly [number, number, number, number],
): Promise<TargetRect | null> {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(
      <Probe key_="coach-fab" measure={cb => cb(...tuple)} />,
    );
  });
  expect(hasWalkthroughTarget('coach-fab')).toBe(true);
  const rect = await measureWalkthroughTarget('coach-fab');
  act(() => renderer.unmount());
  expect(hasWalkthroughTarget('coach-fab')).toBe(false);
  return rect;
}

describe('ATTACK S3 — gate consistency: useWalkthroughTarget vs rectVisibleInWindow', () => {
  it('sub-pixel 0.5×0.5 at the origin: BOTH gates accept', async () => {
    const rect = await measureThroughHook([0, 0, 0.5, 0.5]);
    expect(rect).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 });
    expect(rectVisibleInWindow(rect!, W, H)).toBe(true);
  });

  it('sub-pixel 0.5×0.5 whose center is EXACTLY the far window corner: both accept (inclusive edge)', async () => {
    const rect = await measureThroughHook([W - 0.25, H - 0.25, 0.5, 0.5]);
    expect(rect).not.toBeNull();
    expect(rect!.x + rect!.width / 2).toBe(W);
    expect(rect!.y + rect!.height / 2).toBe(H);
    expect(rectVisibleInWindow(rect!, W, H)).toBe(true);
  });

  it('sub-pixel rect one ulp past the corner: hook accepts, visibility rejects (consistent: off-screen)', async () => {
    const x = W - 0.25 + Number.EPSILON * W;
    const rect = await measureThroughHook([x, H - 0.25, 0.5, 0.5]);
    expect(rect).not.toBeNull();
    expect(rectVisibleInWindow(rect!, W, H)).toBe(false);
  });

  it('Number.MIN_VALUE sized rect: hook accepts (> 0), visibility accepts', async () => {
    const rect = await measureThroughHook([
      10,
      10,
      Number.MIN_VALUE,
      Number.MIN_VALUE,
    ]);
    expect(rect).not.toBeNull();
    expect(rectVisibleInWindow(rect!, W, H)).toBe(true);
  });

  it.each([
    ['zero width', [10, 10, 0, 40]],
    ['zero height', [10, 10, 40, 0]],
    ['negative zero width', [10, 10, -0, 40]],
    ['negative width', [10, 10, -40, 40]],
    ['NaN width', [10, 10, Number.NaN, 40]],
    ['Infinity height', [10, 10, 40, Number.POSITIVE_INFINITY]],
    ['NaN x', [Number.NaN, 10, 40, 40]],
    ['-Infinity y', [10, Number.NEGATIVE_INFINITY, 40, 40]],
  ] as const)('%s is rejected by the hook (null)', async (_label, tuple) => {
    const rect = await measureThroughHook(
      tuple as unknown as readonly [number, number, number, number],
    );
    expect(rect).toBeNull();
  });

  it('a measureInWindow that never calls back leaves the promise pending (documents the retry loop dependency)', async () => {
    let renderer!: Renderer;
    act(() => {
      renderer = TestRenderer.create(
        <Probe key_="coach-fab" measure={() => undefined} />,
      );
    });
    const race = await Promise.race([
      measureWalkthroughTarget('coach-fab').then(() => 'resolved' as const),
      new Promise<'pending'>(resolve =>
        setTimeout(() => resolve('pending'), 50),
      ),
    ]);
    act(() => renderer.unmount());
    console.log(`[ATTACK S3] silent measureInWindow → ${race}`);
    expect(race).toBe('pending');
  });
});

describe('ATTACK S3 — rectVisibleInWindow at the exact window edges', () => {
  const size = 64;
  it.each([
    [
      'center exactly at x=0',
      { x: -size / 2, y: 100, width: size, height: size },
      true,
    ],
    [
      'center exactly at x=W',
      { x: W - size / 2, y: 100, width: size, height: size },
      true,
    ],
    [
      'center exactly at y=0',
      { x: 100, y: -size / 2, width: size, height: size },
      true,
    ],
    [
      'center exactly at y=H',
      { x: 100, y: H - size / 2, width: size, height: size },
      true,
    ],
    [
      'left edge flush with x=W (fully off-screen right)',
      { x: W, y: 100, width: size, height: size },
      false,
    ],
    [
      'right edge flush with x=0 (fully off-screen left)',
      { x: -size, y: 100, width: size, height: size },
      false,
    ],
    [
      'top edge flush with y=H',
      { x: 100, y: H, width: size, height: size },
      false,
    ],
    [
      'bottom edge flush with y=0',
      { x: 100, y: -size, width: size, height: size },
      false,
    ],
    [
      'center one ulp left of 0',
      { x: -size / 2 - Number.EPSILON * 64, y: 100, width: size, height: size },
      false,
    ],
    [
      'rect larger than the window, centred',
      { x: -W, y: -H, width: 3 * W, height: 3 * H },
      true,
    ],
    [
      'NaN width → rejected',
      { x: 10, y: 10, width: Number.NaN, height: 10 },
      false,
    ],
    [
      'Infinity width → rejected',
      { x: 10, y: 10, width: Number.POSITIVE_INFINITY, height: 10 },
      false,
    ],
    [
      '-Infinity x → rejected',
      { x: Number.NEGATIVE_INFINITY, y: 10, width: 10, height: 10 },
      false,
    ],
  ] as const)('%s → %s', (_label, rect, visible) => {
    expect(rectVisibleInWindow(rect, W, H)).toBe(visible);
  });

  it('zero-size window rejects everything except a rect centred on the origin', () => {
    expect(rectVisibleInWindow({ x: 0, y: 0, width: 0, height: 0 }, 0, 0)).toBe(
      true,
    );
    expect(rectVisibleInWindow({ x: 1, y: 0, width: 0, height: 0 }, 0, 0)).toBe(
      false,
    );
  });
});

// ─── Scrim hole: render the overlay end-to-end and parse the Path ──────────

interface Hole {
  r: number;
  straightW: number;
  straightH: number;
  numbers: number[];
}

/** The scrim path is `M 0 0 H w V h H 0 Z` + `M x+r y h (w-2r) a r r 0 0 1 r r v (ht-2r) …`. */
function parseHole(d: string): Hole {
  const holePart = d.slice(d.indexOf('Z') + 1).trim();
  const tokens = holePart.split(/\s+/);
  const numbers = tokens
    .filter(t => /^-?[0-9.]+(e-?\d+)?$|^NaN$|^-?Infinity$/.test(t))
    .map(Number);
  const hIndex = tokens.indexOf('h');
  const aIndex = tokens.indexOf('a');
  const vIndex = tokens.indexOf('v');
  return {
    straightW: Number(tokens[hIndex + 1]),
    r: Number(tokens[aIndex + 1]),
    straightH: Number(tokens[vIndex + 1]),
    numbers,
  };
}

function registerAll(rects: Partial<Record<WalkthroughTargetKey, TargetRect>>) {
  for (const key of Object.keys(rects) as WalkthroughTargetKey[]) {
    unregister.push(
      registerWalkthroughMeasurer(key, () => Promise.resolve(rects[key]!)),
    );
  }
}

async function renderVisible(): Promise<Renderer> {
  useWalkthroughStore.setState({ visible: true });
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<FirstRunWalkthrough />);
  });
  return renderer;
}

function scrimPathD(renderer: Renderer): string | null {
  const paths = renderer.root.findAll(
    n => typeof n.props.d === 'string' && n.props.fillRule === 'evenodd',
  );
  return paths.length ? (paths[0]!.props.d as string) : null;
}

function expectNonDegenerate(hole: Hole) {
  expect(hole.numbers.every(n => Number.isFinite(n))).toBe(true);
  expect(hole.r).toBeGreaterThan(0);
  expect(hole.straightW).toBeGreaterThanOrEqual(0);
  expect(hole.straightH).toBeGreaterThanOrEqual(0);
  // Enclosed area: (straight + 2r)² > 0.
  expect(
    (hole.straightW + 2 * hole.r) * (hole.straightH + 2 * hole.r),
  ).toBeGreaterThan(0);
}

describe('ATTACK S3 — scrim hole is never degenerate for accepted rects', () => {
  const circleStep = WALKTHROUGH_STEPS[0]!;
  const roundedStep = WALKTHROUGH_STEPS[1]!;

  it('precondition: step 1 is a circle spotlight and step 2 a rounded one', () => {
    expect(circleStep.shape).toBe('circle');
    expect(roundedStep.shape).toBe('rounded');
  });

  it.each([
    ['0.5×0.5 at origin', { x: 0, y: 0, width: 0.5, height: 0.5 }],
    [
      '0.5×0.5 centred on the far corner',
      { x: W - 0.25, y: H - 0.25, width: 0.5, height: 0.5 },
    ],
    [
      'MIN_VALUE square',
      { x: 200, y: 300, width: Number.MIN_VALUE, height: Number.MIN_VALUE },
    ],
    [
      '64px square half off the left edge',
      { x: -32, y: 600, width: 64, height: 64 },
    ],
    ['1×400 sliver', { x: 100, y: 100, width: 1, height: 400 }],
    [
      'huge rect (3 windows wide)',
      { x: -W, y: -H, width: 3 * W, height: 3 * H },
    ],
  ] as const)(
    'circle hole for %s is positive, finite and has a rendered callout',
    async (_label, rect) => {
      registerAll({ [circleStep.targetKey]: rect });
      const renderer = await renderVisible();
      const d = scrimPathD(renderer);
      expect(d).not.toBeNull();
      const hole = parseHole(d!);
      console.log(
        `[ATTACK S3] circle ${_label}: r=${hole.r} h=${hole.straightW} v=${hole.straightH}`,
      );
      expectNonDegenerate(hole);
      // Circle: straight segments collapse to 0 (side = 2r) — exactly, never negative.
      expect(hole.straightW).toBeCloseTo(0, 6);
      expect(hole.straightH).toBeCloseTo(0, 6);
      expect(
        renderer.root.findAll(n => n.props.testID === 'walkthrough-advance')
          .length,
      ).toBeGreaterThan(0);
      act(() => renderer.unmount());
    },
  );

  it.each([
    ['0.5×0.5 at origin', { x: 0, y: 0, width: 0.5, height: 0.5 }],
    [
      '0.5×0.5 centred on the far corner',
      { x: W - 0.25, y: H - 0.25, width: 0.5, height: 0.5 },
    ],
    [
      'MIN_VALUE square',
      { x: 200, y: 300, width: Number.MIN_VALUE, height: Number.MIN_VALUE },
    ],
    ['1×400 sliver', { x: 100, y: 100, width: 1, height: 400 }],
    ['400×1 sliver', { x: 100, y: 100, width: 400, height: 1 }],
    [
      'banner half off the bottom edge',
      { x: 24, y: H - 48, width: 345, height: 96 },
    ],
  ] as const)(
    'rounded hole for %s is positive and finite',
    async (_label, rect) => {
      registerAll({
        [circleStep.targetKey]: { x: 165, y: 700, width: 64, height: 64 },
        [roundedStep.targetKey]: rect,
      });
      const renderer = await renderVisible();
      // Advance to the rounded step.
      const next = renderer.root.findAll(
        n => n.props.testID === 'walkthrough-advance' && n.props.onPress,
      )[0]!;
      await act(async () => next.props.onPress());
      const d = scrimPathD(renderer);
      expect(d).not.toBeNull();
      const hole = parseHole(d!);
      console.log(
        `[ATTACK S3] rounded ${_label}: r=${hole.r} h=${hole.straightW} v=${hole.straightH}`,
      );
      expectNonDegenerate(hole);
      act(() => renderer.unmount());
    },
  );

  it('a target one ulp past the far corner is skipped (step advances) rather than drawn off-screen', async () => {
    registerAll({
      [circleStep.targetKey]: {
        x: W - 0.25 + Number.EPSILON * W,
        y: H - 0.25,
        width: 0.5,
        height: 0.5,
      },
      [roundedStep.targetKey]: { x: 24, y: 120, width: 345, height: 96 },
    });
    const renderer = await renderVisible();
    // Off-screen registered targets burn the 6×120ms retry budget first.
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 950));
    });
    const text = renderer.root
      .findAll(n => String(n.type) === 'Text')
      .map(n => React.Children.toArray(n.props.children).join(''))
      .join('\n');
    expect(text).toContain(roundedStep.headline);
    expect(text).not.toContain(circleStep.headline);
    act(() => renderer.unmount());
  });

  it('hostile registered measurer (negative width bypassing the hook) — records whether the hole inverts', async () => {
    // Production measurers all come from useWalkthroughTarget, which rejects
    // this; a direct registerWalkthroughMeasurer caller could not. Recorded
    // as a contract observation for the report.
    registerAll({
      [circleStep.targetKey]: { x: 200, y: 300, width: -40, height: -40 },
    });
    const renderer = await renderVisible();
    const d = scrimPathD(renderer);
    if (d) {
      const hole = parseHole(d);
      console.log(
        `[ATTACK S3] negative rect drawn: r=${hole.r} h=${hole.straightW} v=${hole.straightH}`,
      );
      expect(hole.r).toBeLessThan(0); // pins the current behaviour: inverted hole
    } else {
      console.log('[ATTACK S3] negative rect was rejected before drawing');
    }
    act(() => renderer.unmount());
  });
});
