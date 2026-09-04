/**
 * STRESS — cmp-players / ClipPlayer / lens boundary-i18n-a11y.
 *
 * Campaigns (every rendered variant is one row of the JSON evidence table):
 *   1. fallback grid — native view absent: 14 posterUri string classes
 *      (200+ char ASCII, CJK, Arabic RTL, ZWJ emoji, combining marks,
 *      German compounds, Thai, Devanagari, Cyrillic, mixed bidi, control
 *      chars, whitespace, single char, empty) × 3 viewports × 3 font scales.
 *      A truthy poster must render exactly one labelled Image carrying the
 *      uri verbatim; a falsy poster exactly one bare View. Never a spinner,
 *      never a native element.
 *   2. native seeded fuzz — native view registered: STRESS_ITER variants
 *      (default 160) of uri/posterUri string classes × boundary numerics for
 *      seekMs and rate (0, -0, -1, NaN, ±Infinity, 2^31, MAX_SAFE, 1e308,
 *      denormal, fractions, undefined rate) × resizeMode × playing, each
 *      followed by a 20–200 step seek-spam burst (rapid prop updates) and a
 *      callback burst with boundary payloads and i18n error messages. Oracle:
 *      sourceUri/playing/seekMs forwarded verbatim (Object.is), rate
 *      sanitised to a finite positive number (else 1), resizeMode defaults
 *      to 'cover', callbacks unwrapped exactly, undefined error message →
 *      'unreadable', exactly one native element the whole time.
 *
 * Replay one row: `STRESS_SEED=<seed> npx jest __tests__/stress/cmpPlayers.clipPlayer`.
 * Scale: `STRESS_ITER=2000`. Evidence: artifacts/stress/cmp-players/<STRESS_RUN_ID>/.
 */
import React from 'react';
import { Dimensions, Image, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  auditInteractive,
  BASE_SEED,
  FONT_SCALES,
  pick,
  preview,
  randomInt,
  seededRandom,
  seedsFor,
  STRESS_ITER,
  STRING_CLASSES,
  stringOfClass,
  VIEWPORTS,
  writeEvidence,
  type FontScale,
  type StringClass,
  type Viewport,
} from '../../testing/stress/cmpPlayersLens';

type ClipPlayerModule = typeof import('../../src/components/ClipPlayer');

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function setViewport(v: Viewport, fontScale: number) {
  Dimensions.set({
    window: { width: v.width, height: v.height, scale: 3, fontScale },
    screen: { width: v.width, height: v.height, scale: 3, fontScale },
  });
}

/** Boundary numerics for seekMs / rate / native payloads. */
const NUMERICS: readonly number[] = [
  0,
  -0,
  -1,
  1,
  0.25,
  0.5,
  0.1 + 0.2,
  1e-9,
  5e-324,
  1250,
  2 ** 31 - 1,
  2 ** 31,
  -(2 ** 31) - 1,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  1e308,
  -1e308,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

function expectedRate(rate: number | undefined): number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0
    ? rate
    : 1;
}

interface Row {
  seed: number;
  campaign: string;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  verdict: 'pass' | 'fail';
  failures: string[];
}

const rows: Row[] = [];
let executed = 0;

function finish(row: Row) {
  row.verdict = row.failures.length === 0 ? 'pass' : 'fail';
  rows.push(row);
  executed += 1;
  return row;
}

function assertClean(batch: Row[]) {
  const failing = batch.filter(r => r.verdict === 'fail');
  expect(
    failing.map(r => `seed=${r.seed} ${r.campaign}: ${r.failures.join('; ')}`),
  ).toEqual([]);
}

afterAll(() => {
  const file = writeEvidence('clipPlayer.rows.json', rows);
  writeEvidence('clipPlayer.summary.json', {
    unit: 'cmp-players',
    component: 'ClipPlayer',
    lens: 'boundary-i18n-a11y',
    baseSeed: BASE_SEED,
    stressIter: STRESS_ITER,
    executed,
    passed: rows.filter(r => r.verdict === 'pass').length,
    failed: rows.filter(r => r.verdict === 'fail').map(r => r.seed),
    seekSpamUpdates: rows.reduce(
      (sum, r) => sum + Number(r.observed.seekSpamUpdates ?? 0),
      0,
    ),
    rowsFile: file,
  });
});

// ---------------------------------------------------------------------------
// 1. fallback grid (native view absent under this preset)
// ---------------------------------------------------------------------------

describe('fallback grid — native view absent (14 poster classes × 3 viewports × 3 font scales)', () => {
  const { ClipPlayer, clipPlaybackAvailable } =
    require('../../src/components/ClipPlayer') as ClipPlayerModule;

  it('reports playback unavailable under this preset', () => {
    expect(clipPlaybackAvailable()).toBe(false);
  });

  const grid: Array<[StringClass, Viewport, number]> = [];
  for (const cls of STRING_CLASSES) {
    for (const viewport of VIEWPORTS) {
      for (const fontScale of FONT_SCALES)
        grid.push([cls, viewport, fontScale]);
    }
  }

  it.each(grid)(
    'poster %s on %o at fontScale %d',
    (cls, viewport, fontScale) => {
      const seed =
        BASE_SEED * 10 +
        STRING_CLASSES.indexOf(cls) * 9 +
        VIEWPORTS.indexOf(viewport) * 3 +
        FONT_SCALES.indexOf(fontScale as FontScale);
      const random = seededRandom(seed);
      setViewport(viewport, fontScale);
      const posterUri = stringOfClass(random, cls, 240);
      const uri = stringOfClass(random, pick(random, STRING_CLASSES), 240);
      const resizeMode = pick(random, ['cover', 'contain', undefined] as const);
      const row: Row = {
        seed,
        campaign: 'fallback-grid',
        inputs: {
          posterClass: cls,
          posterUri: preview(posterUri),
          posterLength: posterUri.length,
          uri: preview(uri),
          resizeMode: resizeMode ?? null,
          viewport: viewport.name,
          fontScale,
        },
        observed: {},
        verdict: 'fail',
        failures: [],
      };
      const renderer = render(
        <ClipPlayer
          uri={uri}
          posterUri={posterUri}
          playing={random() < 0.5}
          seekMs={pick(random, NUMERICS)}
          rate={pick(random, NUMERICS)}
          resizeMode={resizeMode}
        />,
      );
      try {
        const images = renderer.root.findAllByType(Image);
        const views = renderer.root.findAllByType(View);
        const natives = renderer.root.findAll(
          n => String(n.type) === 'PickleClipPlayerView',
        );
        row.observed.images = images.length;
        row.observed.views = views.length;
        row.observed.natives = natives.length;
        if (natives.length !== 0) row.failures.push('native-element-rendered');
        if (posterUri) {
          if (images.length !== 1) row.failures.push(`images=${images.length}`);
          const image = images[0];
          if (image) {
            const source = image.props.source as { uri?: string };
            if (source?.uri !== posterUri)
              row.failures.push(`poster-uri:${preview(source?.uri)}`);
            if (image.props.accessibilityLabel !== 'Captured clip poster') {
              row.failures.push(
                `poster-label:${preview(image.props.accessibilityLabel)}`,
              );
            }
            if (image.props.resizeMode !== (resizeMode ?? 'cover')) {
              row.failures.push(
                `poster-resizeMode:${String(image.props.resizeMode)}`,
              );
            }
          }
        } else {
          if (images.length !== 0) row.failures.push(`images=${images.length}`);
          if (views.length !== 1) row.failures.push(`views=${views.length}`);
          const json = renderer.toJSON();
          if (!json || Array.isArray(json) || json.children !== null) {
            row.failures.push('fallback-view-has-children');
          }
        }
        const interactive = auditInteractive(renderer.root);
        row.observed.interactive = interactive.length;
        if (interactive.length !== 0)
          row.failures.push('unexpected-interactive-node');
      } catch (error) {
        row.failures.push(`threw:${String(error)}`);
      } finally {
        act(() => renderer.unmount());
      }
      assertClean([finish(row)]);
    },
  );
});

// ---------------------------------------------------------------------------
// 2. native seeded fuzz (native view registered)
// ---------------------------------------------------------------------------

describe(`native seeded fuzz — view registered (STRESS_ITER=${STRESS_ITER})`, () => {
  let mod: ClipPlayerModule;

  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock('react-native', () => {
        const actual =
          jest.requireActual<typeof import('react-native')>('react-native');
        // react-native's index exposes lazy getters; spreading it would
        // force every native module. Override only the two lookups.
        const overrides: Record<string, unknown> = {
          UIManager: {
            getViewManagerConfig: (name: string) =>
              name === 'PickleClipPlayerView' ? { Commands: {} } : null,
          },
          requireNativeComponent: (name: string) => name,
        };
        return new Proxy(actual, {
          get: (target, prop: string) =>
            prop in overrides
              ? overrides[prop]
              : (target as unknown as Record<string, unknown>)[prop],
        });
      });
      mod = require('../../src/components/ClipPlayer') as ClipPlayerModule;
    });
  });

  afterAll(() => {
    jest.dontMock('react-native');
  });

  it('reports playback available once the view manager is registered', () => {
    expect(mod.clipPlaybackAvailable()).toBe(true);
  });

  const seeds = seedsFor(STRESS_ITER);

  it(`runs ${seeds.length} seeded boundary + seek-spam variants`, () => {
    const { ClipPlayer } = mod;
    const batch: Row[] = [];
    for (const seed of seeds) {
      const random = seededRandom(seed);
      const viewport = pick(random, VIEWPORTS);
      const fontScale = pick(random, FONT_SCALES);
      setViewport(viewport, fontScale);
      const uriClass = pick(random, STRING_CLASSES);
      const uri = stringOfClass(
        random,
        uriClass,
        pick(random, [200, 400, 1000]),
      );
      const posterUri =
        random() < 0.3
          ? undefined
          : stringOfClass(random, pick(random, STRING_CLASSES), 200);
      const playing = random() < 0.5;
      const seekMs = pick(random, NUMERICS);
      const rate = random() < 0.15 ? undefined : pick(random, NUMERICS);
      const resizeMode = pick(random, ['cover', 'contain', undefined] as const);
      const spamSteps = randomInt(random, 20, 200);

      const onProgress = jest.fn();
      const onLoad = jest.fn();
      const onEnd = jest.fn();
      const onError = jest.fn();
      const withCallbacks = random() < 0.8;

      const row: Row = {
        seed,
        campaign: 'native-fuzz',
        inputs: {
          viewport: viewport.name,
          fontScale,
          uriClass,
          uri: preview(uri),
          uriLength: uri.length,
          posterUri: posterUri === undefined ? null : preview(posterUri),
          playing,
          seekMs,
          rate: rate === undefined ? 'undefined' : rate,
          resizeMode: resizeMode ?? null,
          spamSteps,
          withCallbacks,
        },
        observed: {},
        verdict: 'fail',
        failures: [],
      };

      const element = (props: {
        playing: boolean;
        seekMs: number;
        rate: number | undefined;
      }) => (
        <ClipPlayer
          uri={uri}
          posterUri={posterUri}
          playing={props.playing}
          seekMs={props.seekMs}
          rate={props.rate}
          resizeMode={resizeMode}
          onProgress={withCallbacks ? onProgress : undefined}
          onLoad={withCallbacks ? onLoad : undefined}
          onEnd={withCallbacks ? onEnd : undefined}
          onError={withCallbacks ? onError : undefined}
        />
      );
      const renderer = render(element({ playing, seekMs, rate }));
      try {
        const findNative = () =>
          renderer.root.findAll(n => String(n.type) === 'PickleClipPlayerView');
        let natives = findNative();
        if (natives.length !== 1)
          row.failures.push(`natives=${natives.length}`);
        if (renderer.root.findAllByType(Image).length !== 0)
          row.failures.push('poster-drawn-over-native');
        const native = natives[0];
        if (native) {
          if (!Object.is(native.props.sourceUri, uri))
            row.failures.push(`sourceUri:${preview(native.props.sourceUri)}`);
          if (native.props.playing !== playing)
            row.failures.push('playing-not-forwarded');
          if (!Object.is(native.props.seekMs, seekMs))
            row.failures.push(
              `seekMs ${String(native.props.seekMs)} ≠ ${String(seekMs)}`,
            );
          if (!Object.is(native.props.rate, expectedRate(rate))) {
            row.failures.push(
              `rate ${String(native.props.rate)} ≠ ${String(expectedRate(rate))}`,
            );
          }
          if (native.props.resizeMode !== (resizeMode ?? 'cover'))
            row.failures.push(`resizeMode:${String(native.props.resizeMode)}`);
          row.observed.initial = {
            seekMsForwarded: native.props.seekMs,
            rateForwarded: native.props.rate,
            resizeMode: native.props.resizeMode,
          };
        }

        // Seek spam: rapid prop churn with boundary values.
        let last = { playing, seekMs, rate };
        for (let i = 0; i < spamSteps; i += 1) {
          last = {
            playing: random() < 0.5,
            seekMs:
              random() < 0.7
                ? randomInt(random, -5, 600_000)
                : pick(random, NUMERICS),
            rate:
              random() < 0.1
                ? undefined
                : random() < 0.6
                  ? pick(random, [0.25, 0.5, 1])
                  : pick(random, NUMERICS),
          };
          act(() => {
            renderer.update(element(last));
          });
        }
        row.observed.seekSpamUpdates = spamSteps;
        natives = findNative();
        if (natives.length !== 1)
          row.failures.push(`natives-after-spam=${natives.length}`);
        const after = natives[0];
        if (after) {
          if (!Object.is(after.props.seekMs, last.seekMs))
            row.failures.push(
              `spam seekMs ${String(after.props.seekMs)} ≠ ${String(last.seekMs)}`,
            );
          if (after.props.playing !== last.playing)
            row.failures.push('spam playing-not-forwarded');
          if (!Object.is(after.props.rate, expectedRate(last.rate))) {
            row.failures.push(
              `spam rate ${String(after.props.rate)} ≠ ${String(expectedRate(last.rate))}`,
            );
          }
          row.observed.afterSpam = {
            seekMs: after.props.seekMs,
            rate: after.props.rate,
            playing: after.props.playing,
          };

          // Callback burst with boundary payloads and i18n error messages.
          const durationMs = pick(random, NUMERICS);
          const positionMs = pick(random, NUMERICS);
          const messageClass = pick(random, [
            ...STRING_CLASSES,
            'undefined',
          ] as const);
          const message =
            messageClass === 'undefined'
              ? undefined
              : stringOfClass(random, messageClass, 200);
          act(() => {
            after.props.onClipLoad({ nativeEvent: { durationMs } });
            after.props.onClipProgress({ nativeEvent: { positionMs } });
            after.props.onClipEnd();
            after.props.onClipError({ nativeEvent: { message } });
          });
          row.inputs.callbackPayload = {
            durationMs,
            positionMs,
            messageClass,
            message: preview(message),
          };
          if (withCallbacks) {
            if (
              onLoad.mock.calls.length !== 1 ||
              !Object.is(onLoad.mock.calls[0]?.[0], durationMs)
            )
              row.failures.push('onLoad-payload');
            if (
              onProgress.mock.calls.length !== 1 ||
              !Object.is(onProgress.mock.calls[0]?.[0], positionMs)
            )
              row.failures.push('onProgress-payload');
            if (onEnd.mock.calls.length !== 1) row.failures.push('onEnd-count');
            const expectedMessage = message ?? 'unreadable';
            if (
              onError.mock.calls.length !== 1 ||
              onError.mock.calls[0]?.[0] !== expectedMessage
            ) {
              row.failures.push(
                `onError ${preview(onError.mock.calls[0]?.[0])} ≠ ${preview(expectedMessage)}`,
              );
            }
            row.observed.onErrorMessage = preview(onError.mock.calls[0]?.[0]);
          } else if (
            onLoad.mock.calls.length +
              onProgress.mock.calls.length +
              onEnd.mock.calls.length +
              onError.mock.calls.length !==
            0
          ) {
            row.failures.push('callbacks-called-without-handlers');
          }
        }
        const interactive = auditInteractive(renderer.root);
        row.observed.interactive = interactive.length;
        if (interactive.length !== 0)
          row.failures.push('unexpected-interactive-node');
      } catch (error) {
        row.failures.push(`threw:${String(error)}`);
      } finally {
        act(() => renderer.unmount());
      }
      batch.push(finish(row));
    }
    assertClean(batch);
  });
});
