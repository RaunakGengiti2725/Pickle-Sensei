jest.mock('../src/design/components', () => ({
  useReducedMotion: () => mockReducedMotion,
}));

import React from 'react';
import {
  AppState,
  StyleSheet,
  Text,
  View,
  type AppStateStatus,
} from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import Svg, { Circle, Line } from 'react-native-svg';
import {
  prepare3DComparison,
  project3DFrame,
  projectXYZ,
  sample3DComparison,
  type Comparison3DInput,
  type Estimated3DSequence,
  type Frame3D,
  type Prepared3DComparison,
  type Reference3DReview,
  type XYZ,
} from '../src/review/experimental3DComparisonModel';
import { color, type as typography } from '../src/design/tokens';
import { Experimental3DComparison } from '../src/review/Experimental3DComparison';

let mockReducedMotion = false;

function softwareFrame(timestampMs: number, movement = 0): Frame3D {
  return {
    timestampMs,
    joints: [
      { name: 'a', x: -0.4, y: 0.3, z: -0.7 },
      { name: 'b', x: 0.5 + movement, y: -0.1, z: 0.6 },
      { name: 'c', x: 0.2, y: 0.8, z: 0.1 + movement },
    ],
  };
}

function softwareSequence(
  id: string,
  timestamps: readonly number[],
): Estimated3DSequence {
  return {
    kind: 'estimated-3d',
    units: 'm',
    jointSchema: 'software-only-three-node-graph',
    coordinateFrame: {
      id: 'software-only-shared-frame',
      origin: 'Explicit software origin, not an anatomical landmark',
      axes: 'right-handed-x-right-y-up-z-toward-viewer',
      view: 'side',
      mirrored: false,
    },
    provenance: {
      source: 'software-only-fixture',
      sourceId: `software-only-${id}`,
      description: `Software-only ${id} fixture`,
      estimator: 'Synthetic XYZ generator, not a validated pose estimator',
      recordedAtIso: '2026-09-04T00:00:00.000Z',
      timebaseId: `software-only-${id}-clock`,
      timestampUnit: 'ms',
    },
    frames: timestamps.map((timestamp, index) =>
      softwareFrame(timestamp, index * 0.04),
    ),
  };
}

function softwareFixture(): Comparison3DInput {
  return {
    user: softwareSequence('motion', [101.25, 141.25, 501.25, 541.25]),
    reference: softwareSequence('reference', [900.5, 970.5, 1400.5, 1440.5]),
    bones: [
      ['a', 'b'],
      ['b', 'c'],
    ],
    projection: { center: { x: 0, y: 0, z: 0 }, radius: 2 },
    alignment: {
      method: 'caller-supplied',
      provenance:
        'Software-only exact timestamp pairs; no athletic phase alignment claim',
      spatialProvenance:
        'Software-only coordinates share an explicit origin and scale; no body registration',
      durationMs: 400,
      intervals: [
        {
          startMs: 0,
          endMs: 80,
          userTimestampMs: 101.25,
          referenceTimestampMs: 900.5,
        },
        {
          startMs: 80,
          endMs: 160,
          userTimestampMs: 141.25,
          referenceTimestampMs: 970.5,
        },
        {
          startMs: 240,
          endMs: 320,
          userTimestampMs: 501.25,
          referenceTimestampMs: 1400.5,
        },
        {
          startMs: 320,
          endMs: 400,
          userTimestampMs: 541.25,
          referenceTimestampMs: 1440.5,
        },
      ],
    },
  };
}

function prepared(input: unknown = softwareFixture()): Prepared3DComparison {
  const result = prepare3DComparison(input);
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error(result.message);
  return result;
}

function softwareReview(): Reference3DReview {
  return {
    referenceSourceId: 'software-only-reference',
    reviewId: 'software-only-review-shape',
    coachName: 'Software-only reviewer, not a real coach approval',
    reviewedAtIso: '2026-09-04T01:00:00.000Z',
    scope: 'Software contract test only; not a coaching recommendation',
  };
}

function simulatedRecordingMetadata(): Comparison3DInput {
  const fixture = softwareFixture();
  return {
    ...fixture,
    user: {
      ...fixture.user,
      provenance: {
        ...fixture.user.provenance,
        source: 'recorded-3d-estimate',
      },
    },
    reference: {
      ...fixture.reference,
      provenance: {
        ...fixture.reference.provenance,
        source: 'recorded-3d-estimate',
      },
      coachReview: softwareReview(),
    },
  };
}

const sourceOrientation = { yawDegrees: 0, pitchDegrees: 0 };
const volume = { center: { x: 0, y: 0, z: 0 }, radius: 2 };

describe('software-only XYZ projection math, not recording or biomechanical validation', () => {
  it('uses genuine supplied Z for depth and for X after yaw, without lifting XY', () => {
    const far = projectXYZ(
      { x: 0.4, y: 0.2, z: -1 },
      volume,
      sourceOrientation,
    )!;
    const near = projectXYZ(
      { x: 0.4, y: 0.2, z: 1 },
      volume,
      sourceOrientation,
    )!;
    expect(far.x).toBe(near.x);
    expect(far.y).toBe(near.y);
    expect(far.depth).toBe(-0.5);
    expect(near.depth).toBe(0.5);
    const turned = projectXYZ({ x: 0.4, y: 0.2, z: 1 }, volume, {
      yawDegrees: 90,
      pitchDegrees: 0,
    })!;
    expect(turned.x).toBeCloseTo(0.5);
    expect(turned.y).toBeCloseTo(0.1);
    expect(turned.depth).toBeCloseTo(-0.2);
  });

  it('pins right-handed pitch, full turns, translation and one common scale', () => {
    const point = { x: 0.4, y: 0.2, z: 1 };
    const pitched = projectXYZ(point, volume, {
      yawDegrees: 0,
      pitchDegrees: 90,
    })!;
    expect(pitched.y).toBeCloseTo(-0.5);
    expect(pitched.depth).toBeCloseTo(0.1);
    for (const yawDegrees of [-360, -90, 0, 45, 90, 360]) {
      const rotated = projectXYZ(point, volume, {
        yawDegrees,
        pitchDegrees: 20,
      })!;
      expect(Math.hypot(rotated.x, rotated.y, rotated.depth)).toBeCloseTo(
        Math.hypot(point.x, point.y, point.z) / 2,
      );
    }
    const fullTurn = projectXYZ(point, volume, {
      yawDegrees: 360,
      pitchDegrees: 360,
    })!;
    expect(fullTurn).toEqual(projectXYZ(point, volume, sourceOrientation));
    const shifted = projectXYZ(
      { x: 10.4, y: 10.2, z: 11 },
      { center: { x: 10, y: 10, z: 10 }, radius: 2 },
      sourceOrientation,
    )!;
    expect(shifted.x).toBeCloseTo(0.2);
    expect(shifted.y).toBeCloseTo(0.1);
    expect(shifted.depth).toBe(0.5);
    expect(
      projectXYZ({ x: 0.8, y: 0, z: 0 }, volume, sourceOrientation)!.x,
    ).toBe(
      2 * projectXYZ({ x: 0.4, y: 0, z: 0 }, volume, sourceOrientation)!.x,
    );
  });

  it.each([undefined, null, NaN, Infinity, -Infinity, '0'])(
    'rejects absent or non-finite Z: %s',
    z => {
      expect(
        projectXYZ({ x: 0, y: 0, z } as XYZ, volume, sourceOrientation),
      ).toBeNull();
    },
  );

  it('abstains on invalid bounds, out-of-view evidence and invalid orientation', () => {
    expect(
      projectXYZ(
        { x: 0, y: 0, z: 1 },
        { ...volume, radius: 0 },
        sourceOrientation,
      ),
    ).toBeNull();
    expect(
      projectXYZ({ x: 0, y: 0, z: 3 }, volume, sourceOrientation),
    ).toBeNull();
    expect(
      projectXYZ({ x: 0, y: 0, z: 1 }, volume, {
        yawDegrees: NaN,
        pitchDegrees: 0,
      }),
    ).toBeNull();
    expect(
      projectXYZ({ x: 0, y: 0, z: 1 }, volume, {
        yawDegrees: 0,
        pitchDegrees: Infinity,
      }),
    ).toBeNull();
  });

  it('depth-orders only supplied joints/connections and never completes a missing joint', () => {
    const frame = softwareFrame(101.25);
    const before = JSON.stringify(frame);
    const primitives = project3DFrame(
      frame,
      [
        ['a', 'b'],
        ['b', 'missing'],
      ],
      volume,
      sourceOrientation,
    )!;
    expect(primitives.filter(item => item.kind === 'bone')).toHaveLength(1);
    expect(
      primitives
        .filter(item => item.kind === 'joint')
        .map(item => item.id)
        .sort(),
    ).toEqual(['a', 'b', 'c']);
    const depths = primitives.map(item => item.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    expect(JSON.stringify(frame)).toBe(before);
  });
});

describe('software-only strict evidence boundary', () => {
  it.each([null, {}, { user: null, reference: null }])(
    'rejects missing evidence: %s',
    input => {
      expect(prepare3DComparison(input)).toMatchObject({
        status: 'unavailable',
        reason: 'missing-evidence',
      });
    },
  );

  it('rejects the shipping-style normalized XY shape and never creates a reference', () => {
    const input = softwareFixture();
    const flat = {
      coordinateSystem: 'normalized_image_top_left',
      frames: [
        {
          timestampMs: 101.25,
          landmarks: [{ name: 'a', x: 0.2, y: 0.3, visibility: 0.9 }],
        },
      ],
    };
    expect(prepare3DComparison({ ...input, user: flat })).toMatchObject({
      status: 'unavailable',
      reason: 'invalid-evidence',
    });
    expect(
      prepare3DComparison({ ...input, reference: undefined }),
    ).toMatchObject({ status: 'unavailable', reason: 'missing-evidence' });
  });

  it.each([undefined, null, NaN, Infinity, -Infinity, '0'])(
    'rejects a claimed 3D sample without finite explicit Z in either source: %s',
    z => {
      for (const key of ['user', 'reference'] as const) {
        const input = softwareFixture();
        const source = input[key];
        const frames = source.frames.map(frame => ({
          ...frame,
          joints: frame.joints.map(joint => ({ ...joint, z })),
        }));
        expect(
          prepare3DComparison({ ...input, [key]: { ...source, frames } }),
        ).toMatchObject({ status: 'unavailable', reason: 'invalid-evidence' });
      }
    },
  );

  it('accepts explicitly supplied zero Z, without inventing nonzero depth', () => {
    const input = softwareFixture();
    const user = {
      ...input.user,
      frames: input.user.frames.map(frame => ({
        ...frame,
        joints: frame.joints.map(joint => ({ ...joint, z: 0 })),
      })),
    };
    const model = prepared({ ...input, user });
    expect(
      sample3DComparison(model, 0).user?.joints.every(joint => joint.z === 0),
    ).toBe(true);
  });

  it.each([
    ['kind', 'lifted-2d'],
    ['units', 'normalized'],
    ['units', undefined],
    ['units', { toString: () => 'm' }],
    ['jointSchema', ''],
    ['frames', []],
  ])('rejects invalid source field %s', (key, value) => {
    const input = softwareFixture();
    expect(
      prepare3DComparison({ ...input, user: { ...input.user, [key]: value } }),
    ).toMatchObject({ status: 'unavailable' });
  });

  it.each([
    ['source', 'inferred-from-xy'],
    ['sourceId', ''],
    ['description', ''],
    ['estimator', ''],
    ['recordedAtIso', 'tomorrow'],
    ['recordedAtIso', '2026-02-30T00:00:00.000Z'],
    ['timebaseId', ''],
    ['timestampUnit', 'seconds'],
  ])('rejects absent or incompatible provenance field %s', (key, value) => {
    const input = softwareFixture();
    expect(
      prepare3DComparison({
        ...input,
        user: {
          ...input.user,
          provenance: { ...input.user.provenance, [key]: value },
        },
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'invalid-evidence' });
  });

  it('rejects mixed software/recording sources and mismatched units rather than converting', () => {
    const input = softwareFixture();
    expect(
      prepare3DComparison({
        ...input,
        reference: { ...input.reference, units: 'mm' },
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'incompatible-units' });
    expect(
      prepare3DComparison({
        ...input,
        reference: {
          ...input.reference,
          provenance: {
            ...input.reference.provenance,
            source: 'recorded-3d-estimate',
          },
        },
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'incompatible-source' });
  });

  it.each([
    ['id', 'unregistered-other-frame'],
    ['origin', 'other-origin'],
    ['view', 'front'],
    ['mirrored', true],
    ['axes', 'left-handed-image-down'],
    ['axes', undefined],
  ])('rejects mismatched or unknown coordinate %s', (key, value) => {
    const input = softwareFixture();
    expect(
      prepare3DComparison({
        ...input,
        reference: {
          ...input.reference,
          coordinateFrame: { ...input.reference.coordinateFrame, [key]: value },
        },
      }),
    ).toMatchObject({ status: 'unavailable' });
  });

  it('rejects a different joint schema and refuses independent projection fitting', () => {
    const input = softwareFixture();
    expect(
      prepare3DComparison({
        ...input,
        reference: { ...input.reference, jointSchema: 'other-joints' },
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'incompatible-frame' });
    expect(
      prepare3DComparison({
        ...input,
        projection: { ...input.projection, radius: 0.1 },
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'invalid-projection' });
  });

  it('rejects bad timestamps, non-finite XY, duplicate joints and duplicate bones', () => {
    const input = softwareFixture();
    for (const frames of [
      [...input.user.frames].reverse(),
      [input.user.frames[0], input.user.frames[0]],
      [softwareFrame(NaN)],
      [softwareFrame(-1)],
      [
        {
          ...softwareFrame(0),
          joints: [{ name: 'a', x: Infinity, y: 0, z: 0 }],
        },
      ],
      [{ ...softwareFrame(0), joints: [{ name: 'a', x: 0, y: NaN, z: 0 }] }],
      [
        {
          ...softwareFrame(0),
          joints: [softwareFrame(0).joints[0], softwareFrame(0).joints[0]],
        },
      ],
    ]) {
      expect(
        prepare3DComparison({ ...input, user: { ...input.user, frames } }),
      ).toMatchObject({ status: 'unavailable', reason: 'invalid-evidence' });
    }
    expect(
      prepare3DComparison({
        ...input,
        bones: [
          ['a', 'b'],
          ['b', 'a'],
        ],
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'invalid-bones' });
  });

  it('rejects sparse, empty or malformed connections rather than generating geometry', () => {
    const input = softwareFixture();
    for (const bones of [[], new Array(1), [['a']], [['a', 'a']]]) {
      expect(prepare3DComparison({ ...input, bones })).toMatchObject({
        status: 'unavailable',
        reason: 'invalid-bones',
      });
    }
  });

  it('defaults to Illustrative reference and requires a specific matching review record for the alternative label', () => {
    expect(prepared().referenceLabel).toBe('Illustrative reference');
    const input = softwareFixture();
    expect(
      prepared({
        ...input,
        reference: { ...input.reference, coachReview: softwareReview() },
      }).referenceLabel,
    ).toBe('Illustrative reference');
    const simulated = simulatedRecordingMetadata();
    expect(prepared(simulated).referenceLabel).toBe('Coach-reviewed reference');
    for (const coachReview of [
      {},
      { ...softwareReview(), referenceSourceId: 'some-other-reference' },
      { ...softwareReview(), scope: '' },
      { ...softwareReview(), reviewedAtIso: undefined },
    ]) {
      expect(
        prepare3DComparison({
          ...simulated,
          reference: { ...simulated.reference, coachReview },
        }),
      ).toMatchObject({
        status: 'unavailable',
        reason: 'invalid-reference-review',
      });
    }
  });
});

describe('software-only caller timing and gap abstention', () => {
  it('preserves unequal original timestamps, holds only explicit intervals and never interpolates', () => {
    const input = softwareFixture();
    const before = JSON.stringify(input);
    const model = prepared(input);
    for (const time of [0, 79.999]) {
      expect(sample3DComparison(model, time)).toEqual({
        status: 'paired',
        user: input.user.frames[0],
        reference: input.reference.frames[0],
      });
    }
    expect(sample3DComparison(model, 80)).toEqual({
      status: 'paired',
      user: input.user.frames[1],
      reference: input.reference.frames[1],
    });
    for (const time of [160, 200, 239.999, -1, NaN, Infinity, 401]) {
      expect(sample3DComparison(model, time)).toEqual({
        status: 'gap',
        user: null,
        reference: null,
      });
    }
    expect(sample3DComparison(model, 240).user?.timestampMs).toBe(501.25);
    expect(sample3DComparison(model, 400).reference?.timestampMs).toBe(1440.5);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('uses exact timestamps rather than array index, nearest frame or rate assumptions', () => {
    const input = softwareFixture();
    const user = {
      ...input.user,
      frames: [
        input.user.frames[0]!,
        softwareFrame(121.25, 0.2),
        ...input.user.frames.slice(1),
      ],
    };
    expect(
      sample3DComparison(prepared({ ...input, user }), 80).user?.timestampMs,
    ).toBe(141.25);
    for (const referenceTimestampMs of [970.5001, null]) {
      const alignment = {
        ...input.alignment,
        intervals: input.alignment.intervals.map((interval, index) =>
          index === 1 ? { ...interval, referenceTimestampMs } : interval,
        ),
      };
      expect(sample3DComparison(prepared({ ...input, alignment }), 80)).toEqual(
        { status: 'gap', user: null, reference: null },
      );
    }
  });

  it('abstains for recorded empty frames or no common observed joint, but never fills missing joints', () => {
    const input = softwareFixture();
    for (const joints of [[], [{ name: 'unshared', x: 0, y: 0, z: 0 }]]) {
      const reference = {
        ...input.reference,
        frames: input.reference.frames.map((frame, index) =>
          index === 1 ? { ...frame, joints } : frame,
        ),
      };
      expect(sample3DComparison(prepared({ ...input, reference }), 80)).toEqual(
        { status: 'gap', user: null, reference: null },
      );
    }
    const reference = {
      ...input.reference,
      frames: input.reference.frames.map(frame => ({
        ...frame,
        joints: frame.joints.slice(0, 1),
      })),
    };
    const sample = sample3DComparison(prepared({ ...input, reference }), 0);
    expect(sample.status).toBe('paired');
    expect(
      project3DFrame(sample.reference!, input.bones, volume, sourceOrientation),
    ).toHaveLength(1);
  });

  it('rejects automatic alignment, overlaps, backwards mappings, missing provenance and an entirely unpaired timeline', () => {
    const input = softwareFixture();
    const base = input.alignment;
    for (const alignment of [
      undefined,
      { ...base, method: 'dtw' },
      { ...base, provenance: '' },
      { ...base, spatialProvenance: '' },
      { ...base, durationMs: NaN },
      { ...base, intervals: [...base.intervals].reverse() },
      {
        ...base,
        intervals: [
          { ...base.intervals[0], endMs: 81 },
          ...base.intervals.slice(1),
        ],
      },
      {
        ...base,
        intervals: base.intervals.map((interval, index) =>
          index === 1 ? { ...interval, userTimestampMs: 100 } : interval,
        ),
      },
      {
        ...base,
        intervals: base.intervals.map((interval, index) =>
          index === 1 ? { ...interval, referenceTimestampMs: 900 } : interval,
        ),
      },
      {
        ...base,
        intervals: [{ ...base.intervals[0], referenceTimestampMs: undefined }],
      },
    ]) {
      expect(prepare3DComparison({ ...input, alignment })).toMatchObject({
        status: 'unavailable',
        reason: 'invalid-alignment',
      });
    }
    expect(
      prepare3DComparison({
        ...input,
        alignment: {
          ...base,
          intervals: base.intervals.map(interval => ({
            ...interval,
            referenceTimestampMs: null,
          })),
        },
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'no-paired-samples' });
  });

  it('does not extend first/last samples outside explicitly supplied bounds', () => {
    const input = softwareFixture();
    const alignment = {
      ...input.alignment,
      durationMs: 500,
      intervals: input.alignment.intervals.map((interval, index) =>
        index === 0 ? { ...interval, startMs: 20 } : interval,
      ),
    };
    const model = prepared({ ...input, alignment });
    expect(sample3DComparison(model, 0).status).toBe('gap');
    expect(sample3DComparison(model, 20).status).toBe('paired');
    expect(sample3DComparison(model, 400).status).toBe('gap');
    expect(sample3DComparison(model, 500).status).toBe('gap');
  });
});

const renderers: ReactTestRenderer[] = [];

function render(
  input: Comparison3DInput | null = softwareFixture(),
  offlinePreview = true,
) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <Experimental3DComparison
        input={input}
        offlinePreview={offlinePreview}
      />,
    );
  });
  renderers.push(renderer);
  return renderer;
}

function controls(renderer: ReactTestRenderer) {
  const nodes = renderer.root.findAll(
    node =>
      typeof node.props.onPress === 'function' &&
      ['button', 'adjustable'].includes(node.props.accessibilityRole),
  );
  return [...new Map(nodes.map(node => [node.props.testID, node])).values()];
}

function control(renderer: ReactTestRenderer, id: string) {
  const result = controls(renderer).find(
    node => node.props.testID === `comparison3d-${id}`,
  );
  if (!result) throw new Error(`Missing control: ${id}`);
  return result;
}

function press(renderer: ReactTestRenderer, id: string) {
  act(() => control(renderer, id).props.onPress());
}

function textAt(renderer: ReactTestRenderer, id: string): string {
  return renderer.root
    .findAllByType(Text)
    .find(node => node.props.testID === `comparison3d-${id}`)!.props.children;
}

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(child => typeof child === 'string')
    .join('\n');
}

function stage(renderer: ReactTestRenderer, id: 'user' | 'reference') {
  return renderer.root
    .findAllByType(Svg)
    .find(node => node.props.testID === `comparison3d-${id}-svg`)!;
}

describe('software-only offline comparison UI, not an enabled app feature', () => {
  let appStateChanged: (state: AppStateStatus) => void;
  const removeListener = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    mockReducedMotion = false;
    removeListener.mockClear();
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((event, listener) => {
        if (event === 'change')
          appStateChanged = listener as (state: AppStateStatus) => void;
        return { remove: removeListener };
      });
  });

  afterEach(() => {
    act(() => renderers.splice(0).forEach(renderer => renderer.unmount()));
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('is disabled by default, remains disabled outside development, and draws nothing when evidence is absent', () => {
    const disabled = render(softwareFixture(), false);
    expect(allText(disabled)).toContain('3D comparison disabled');
    expect(disabled.root.findAllByType(Svg)).toHaveLength(0);
    expect(controls(disabled)).toHaveLength(0);
    act(() =>
      disabled.update(<Experimental3DComparison input={softwareFixture()} />),
    );
    expect(allText(disabled)).toContain('3D comparison disabled');
    const runtime = globalThis as unknown as { __DEV__: boolean };
    const previous = runtime.__DEV__;
    try {
      runtime.__DEV__ = false;
      expect(allText(render())).toContain('3D comparison disabled');
    } finally {
      runtime.__DEV__ = previous;
    }
    const unavailable = render(null);
    expect(allText(unavailable)).toContain('3D comparison unavailable');
    expect(unavailable.root.findAllByType(Svg)).toHaveLength(0);
  });

  it('labels software-only sources and reference honestly, uses brand tokens and keeps text outside both bodies', () => {
    const renderer = render();
    expect(allText(renderer)).toContain('Illustrative reference');
    expect(allText(renderer)).toContain('Software-only motion');
    expect(allText(renderer)).toContain('XYZ in m');
    expect(allText(renderer)).toContain('Not a recording or validated 3D');
    expect(allText(renderer)).not.toMatch(
      /measured corrected you|ideal form|score/i,
    );
    const headings = renderer.root
      .findAllByType(View)
      .find(node => node.props.testID === 'comparison3d-headings')!;
    const stages = renderer.root
      .findAllByType(View)
      .find(node => node.props.testID === 'comparison3d-stages')!;
    expect(headings.parent).toBe(stages.parent);
    expect(StyleSheet.flatten(stages.props.style).flexDirection).toBe('row');
    expect(StyleSheet.flatten(headings.props.style).alignItems).toBe('stretch');
    for (const id of ['user', 'reference'] as const) {
      const svg = stage(renderer, id);
      expect(svg.findAllByType(Text)).toHaveLength(0);
      expect(svg.findAllByType(Circle)).toHaveLength(3);
      expect(svg.findAllByType(Line)).toHaveLength(2);
      const opacities = svg
        .findAllByType(Circle)
        .map(node => node.props.opacity);
      expect(new Set(opacities).size).toBeGreaterThan(1);
      expect(opacities.every(value => value >= 0.55 && value <= 0.9)).toBe(
        true,
      );
    }
    expect(stage(renderer, 'user').findAllByType(Circle)[0]!.props.fill).toBe(
      color.mint,
    );
    expect(
      stage(renderer, 'reference').findAllByType(Circle)[0]!.props.fill,
    ).toBe(color.volt);
    for (const node of renderer.root.findAllByType(Text)) {
      expect(StyleSheet.flatten(node.props.style).fontFamily).toMatch(
        /^Manrope_/,
      );
    }
    const heading = renderer.root
      .findAllByType(Text)
      .find(node => node.props.accessibilityRole === 'header')!;
    expect(StyleSheet.flatten(heading.props.style).fontSize).toBe(
      typography.h3.fontSize,
    );
    press(renderer, 'details');
    expect(allText(renderer)).toContain('software-only-motion-clock');
    expect(allText(renderer)).toContain('2026-09-04T00:00:00.000Z');
    expect(allText(renderer)).toContain('not independently verified here');
    expect(allText(renderer)).toContain('Software-only exact timestamp pairs');
  });

  it('retains size differences and only displays the reviewed label for supplied matching review metadata', () => {
    const input = simulatedRecordingMetadata();
    const reference = {
      ...input.reference,
      frames: input.reference.frames.map(frame => ({
        ...frame,
        joints: frame.joints.map(joint =>
          joint.name === 'b' ? { ...joint, x: 1.2 } : joint,
        ),
      })),
    };
    const renderer = render({ ...input, reference });
    expect(allText(renderer)).toContain('Coach-reviewed reference');
    expect(allText(renderer)).not.toContain('Illustrative reference');
    expect(
      stage(renderer, 'user')
        .findAllByType(Circle)
        .some(node => node.props.cx === 0.25),
    ).toBe(true);
    expect(
      stage(renderer, 'reference')
        .findAllByType(Circle)
        .some(node => node.props.cx === 0.6),
    ).toBe(true);
    press(renderer, 'details');
    expect(allText(renderer)).toContain('not a real coach approval');
    expect(allText(renderer)).toContain('Software contract test only');
    expect(allText(renderer)).toContain('not independently verified here');
  });

  it('uses one paused-by-default clock and advances both panels at original, unequal timestamps', () => {
    const renderer = render();
    act(() => jest.advanceTimersByTime(1000));
    expect(textAt(renderer, 'clock')).toBe('Comparison time 0 ms');
    expect(textAt(renderer, 'user-timestamp')).toBe('Original 101.25 ms');
    expect(textAt(renderer, 'reference-timestamp')).toBe('Original 900.5 ms');
    press(renderer, 'play');
    act(() => jest.advanceTimersByTime(120));
    expect(textAt(renderer, 'clock')).toBe('Comparison time 120 ms');
    expect(textAt(renderer, 'user-timestamp')).toBe('Original 141.25 ms');
    expect(textAt(renderer, 'reference-timestamp')).toBe('Original 970.5 ms');
    act(() => jest.advanceTimersByTime(80));
    expect(textAt(renderer, 'sample-status')).toContain('Both panels abstain');
    expect(stage(renderer, 'user').findAllByType(Circle)).toHaveLength(0);
    expect(stage(renderer, 'reference').findAllByType(Line)).toHaveLength(0);
    act(() => jest.advanceTimersByTime(80));
    expect(textAt(renderer, 'user-timestamp')).toBe('Original 501.25 ms');
    expect(textAt(renderer, 'reference-timestamp')).toBe('Original 1400.5 ms');
    act(() => jest.advanceTimersByTime(120));
    expect(textAt(renderer, 'clock')).toBe('Comparison time 400 ms');
    expect(control(renderer, 'play').props.accessibilityLabel).toBe(
      'Play both panels',
    );
    press(renderer, 'play');
    expect(textAt(renderer, 'clock')).toBe('Comparison time 0 ms');
    press(renderer, 'play');
    act(() => jest.advanceTimersByTime(1000));
    expect(textAt(renderer, 'clock')).toBe('Comparison time 0 ms');
  });

  it('has accessible 44-point controls, one adjustable timeline and shared orientation with no mirroring', () => {
    const renderer = render();
    expect(controls(renderer)).toHaveLength(8);
    for (const node of controls(renderer)) {
      const style = StyleSheet.flatten(
        typeof node.props.style === 'function'
          ? node.props.style({ pressed: false })
          : node.props.style,
      );
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
      expect(style.minWidth).toBeGreaterThanOrEqual(44);
      expect(node.props.accessibilityLabel).toBeTruthy();
      expect(['button', 'adjustable']).toContain(node.props.accessibilityRole);
    }
    expect(
      control(renderer, 'previous').props.accessibilityState.disabled,
    ).toBe(true);
    press(renderer, 'next');
    expect(textAt(renderer, 'user-timestamp')).toBe('Original 141.25 ms');
    act(() =>
      control(renderer, 'timeline').props.onAccessibilityAction({
        nativeEvent: { actionName: 'increment' },
      }),
    );
    expect(textAt(renderer, 'clock')).toBe('Comparison time 160 ms');
    expect(
      control(renderer, 'timeline').props.accessibilityValue.text,
    ).toContain('No paired evidence');
    act(() =>
      control(renderer, 'timeline').props.onAccessibilityAction({
        nativeEvent: { actionName: 'decrement' },
      }),
    );
    expect(textAt(renderer, 'clock')).toBe('Comparison time 80 ms');
    press(renderer, 'previous');
    const before = stage(renderer, 'user')
      .findAllByType(Circle)
      .map(node => node.props.cx);
    press(renderer, 'view-1');
    expect(control(renderer, 'view-1').props.accessibilityState.selected).toBe(
      true,
    );
    expect(control(renderer, 'view-0').props.accessibilityState.selected).toBe(
      false,
    );
    expect(
      stage(renderer, 'user')
        .findAllByType(Circle)
        .map(node => node.props.cx),
    ).not.toEqual(before);
    expect(
      stage(renderer, 'user')
        .findAllByType(Circle)
        .map(node => [node.props.cx, node.props.cy]),
    ).toEqual(
      stage(renderer, 'reference')
        .findAllByType(Circle)
        .map(node => [node.props.cx, node.props.cy]),
    );
    press(renderer, 'view-2');
    expect(control(renderer, 'view-2').props.accessibilityLabel).toContain(
      'pitch 20 degrees',
    );
    press(renderer, 'view-0');
    expect(
      stage(renderer, 'user')
        .findAllByType(Circle)
        .map(node => node.props.cx),
    ).toEqual(before);
    expect(textAt(renderer, 'clock')).toBe('Comparison time 0 ms');
  });

  it('seeks both panels on the shared track and pauses instead of retaining stale poses over a gap', () => {
    const renderer = render();
    act(() =>
      control(renderer, 'timeline').props.onLayout({
        nativeEvent: { layout: { width: 200 } },
      }),
    );
    press(renderer, 'play');
    act(() =>
      control(renderer, 'timeline').props.onPress({
        nativeEvent: { locationX: 100 },
      }),
    );
    expect(textAt(renderer, 'clock')).toBe('Comparison time 200 ms');
    expect(textAt(renderer, 'user-timestamp')).toBe('No paired timestamp');
    expect(textAt(renderer, 'reference-timestamp')).toBe('No paired timestamp');
    expect(control(renderer, 'play').props.accessibilityLabel).toBe(
      'Play both panels',
    );
    act(() => jest.advanceTimersByTime(400));
    expect(textAt(renderer, 'clock')).toBe('Comparison time 200 ms');
  });

  it('honors Reduce Motion with step-only playback and pauses immediately when the preference changes', () => {
    const input = softwareFixture();
    const renderer = render(input);
    press(renderer, 'play');
    act(() => jest.advanceTimersByTime(120));
    mockReducedMotion = true;
    act(() =>
      renderer.update(
        <Experimental3DComparison input={input} offlinePreview />,
      ),
    );
    expect(control(renderer, 'play').props.accessibilityState.disabled).toBe(
      true,
    );
    expect(allText(renderer)).toContain('Reduce Motion is on');
    press(renderer, 'play');
    act(() => jest.advanceTimersByTime(800));
    expect(textAt(renderer, 'clock')).toBe('Comparison time 120 ms');
    press(renderer, 'next');
    expect(textAt(renderer, 'clock')).toBe('Comparison time 160 ms');
    press(renderer, 'next');
    expect(textAt(renderer, 'user-timestamp')).toBe('Original 501.25 ms');
    press(renderer, 'view-1');
    expect(control(renderer, 'view-1').props.accessibilityState.selected).toBe(
      true,
    );
    mockReducedMotion = false;
    act(() =>
      renderer.update(
        <Experimental3DComparison input={input} offlinePreview />,
      ),
    );
    act(() => jest.advanceTimersByTime(400));
    expect(textAt(renderer, 'clock')).toBe('Comparison time 240 ms');
    mockReducedMotion = true;
    const initialReduced = render(input);
    expect(control(initialReduced, 'play').props.disabled).toBe(true);
    act(() => jest.advanceTimersByTime(400));
    expect(textAt(initialReduced, 'clock')).toBe('Comparison time 0 ms');
  });

  it('stops on background, resets on new evidence and removes playback/listeners on unavailable or unmount', () => {
    const renderer = render();
    press(renderer, 'play');
    act(() => jest.advanceTimersByTime(120));
    act(() => appStateChanged('background'));
    act(() => jest.advanceTimersByTime(400));
    expect(textAt(renderer, 'clock')).toBe('Comparison time 120 ms');
    act(() => appStateChanged('active'));
    expect(control(renderer, 'play').props.accessibilityLabel).toBe(
      'Play both panels',
    );
    press(renderer, 'view-2');
    press(renderer, 'play');
    act(() =>
      renderer.update(
        <Experimental3DComparison input={softwareFixture()} offlinePreview />,
      ),
    );
    expect(textAt(renderer, 'clock')).toBe('Comparison time 0 ms');
    expect(control(renderer, 'view-0').props.accessibilityState.selected).toBe(
      true,
    );
    expect(control(renderer, 'play').props.accessibilityLabel).toBe(
      'Play both panels',
    );
    press(renderer, 'play');
    act(() => renderer.update(<Experimental3DComparison offlinePreview />));
    expect(allText(renderer)).toContain('3D comparison unavailable');
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
