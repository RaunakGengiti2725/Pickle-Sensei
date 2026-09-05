/**
 * STRESS — cmp-players / DrillVideoPlayer / lens boundary-i18n-a11y.
 *
 * Campaigns (every rendered variant is one row of the JSON evidence table):
 *   1. a11y+layout grid — 3 media kinds × 3 viewports × 3 font scales, each
 *      rendered in the playing stage AND driven to the error card: every
 *      interactive host node must carry role=button + a non-empty label and
 *      a style-derived ≥ 44pt target; the rendered `playerBox` geometry
 *      feeds the arithmetic column model (recorded; asserted only under
 *      STRESS_STRICT_LAYOUT=1 because Linux has no Yoga/CoreText).
 *   2. locale × timezone grid — 12 locales × 8 timezones; creator/attribution
 *      strings drawn from the locale's script (CJK, Arabic RTL, Devanagari,
 *      Thai, Cyrillic, German compounds, combining marks…) and `expiresAt`
 *      on a DST edge / ±14h offset. Strings must reach the tree verbatim.
 *   3. seeded fuzz — STRESS_ITER variants (default 160) mixing string
 *      classes (200–600 chars, empty, whitespace, control chars, ZWJ emoji),
 *      viewports, font scales, boundary numerics inside URLs/ids, and a
 *      random 0–8 step lifecycle script (ready / player error / WebView
 *      error / main-vs-subresource HTTP error / garbage messages / watchdog /
 *      retry / open-source with a refusing Linking / close / dismiss /
 *      same-media re-render / media swap) checked against a stage oracle.
 *   4. null media — every viewport × font scale renders nothing.
 *
 * Replay one row: `STRESS_SEED=<seed> npx jest __tests__/stress/cmpPlayers.drillVideoPlayer`.
 * Scale: `STRESS_ITER=2000`. Evidence: artifacts/stress/cmp-players/<STRESS_RUN_ID>/.
 */
import React from 'react';
import { Dimensions, Linking, StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { InstructionalMedia } from '../../src/training/types';
import {
  auditInteractive,
  BASE_SEED,
  collectText,
  expiresAtFor,
  FONT_SCALES,
  forbiddenCopyHits,
  LOCALE_DECOR,
  LOCALE_SCRIPT,
  LOCALES,
  modelAttributionBlock,
  modelErrorCard,
  pick,
  preview,
  randomInt,
  seededRandom,
  seedsFor,
  STRESS_ITER,
  STRICT_LAYOUT,
  STRING_CLASSES,
  stringOfClass,
  TIMEZONES,
  VIEWPORTS,
  writeEvidence,
  type InteractiveAudit,
  type FontScale,
  type StringClass,
  type Viewport,
} from '../../testing/stress/cmpPlayersLens';

const mockInsets = { top: 0, bottom: 0 };
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ ...mockInsets, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

// Passthrough View keeps every WebView prop (source, onMessage, onError,
// onHttpError) inspectable and callable from the tree.
jest.mock('react-native-webview', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import {
  DrillVideoPlayer,
  EMBED_READY_TIMEOUT_MS,
} from '../../src/components/DrillVideoPlayer';

type Kind = 'youtube' | 'vimeo' | 'hosted';
const KINDS: readonly Kind[] = ['youtube', 'vimeo', 'hosted'];

/** The component clamps insets to the iOS fallbacks (safeArea.ts). */
function effectiveInsets(v: Viewport) {
  return {
    top: Math.max(v.insets.top, 44),
    bottom: Math.max(v.insets.bottom, 34),
  };
}

function setViewport(v: Viewport, fontScale: number) {
  mockInsets.top = v.insets.top;
  mockInsets.bottom = v.insets.bottom;
  Dimensions.set({
    window: { width: v.width, height: v.height, scale: 3, fontScale },
    screen: { width: v.width, height: v.height, scale: 3, fontScale },
  });
}

const BOUNDARY_NUMERICS = [
  0,
  -0,
  -1,
  1,
  2 ** 31 - 1,
  2 ** 31,
  -(2 ** 31) - 1,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  1e308,
  -1e308,
  5e-324,
  0.1 + 0.2,
] as const;

interface MediaSpec {
  kind: Kind;
  id: string;
  creatorName: string;
  attribution: string;
  licenseName: string;
  expiresAt: string;
  /** Numeric boundary spliced into the URL query (t=… seconds). */
  numeric: number;
  extraQuery: string;
}

function buildMedia(spec: MediaSpec): InstructionalMedia {
  const base = {
    id: spec.id,
    creatorName: spec.creatorName,
    licenseName: spec.licenseName,
    licenseUrl: null,
    attribution: spec.attribution,
  };
  const q = `t=${String(spec.numeric)}s${spec.extraQuery}`;
  if (spec.kind === 'youtube') {
    return {
      ...base,
      kind: 'embed',
      provider: 'youtube',
      videoId: 'dQw4w9WgXcQ',
      embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      sourceUrl: `https://www.youtube.com/watch?v=dQw4w9WgXcQ&${q}`,
    };
  }
  if (spec.kind === 'vimeo') {
    return {
      ...base,
      kind: 'embed',
      provider: 'vimeo',
      videoId: '76979871',
      embedUrl: 'https://player.vimeo.com/video/76979871',
      sourceUrl: `https://vimeo.com/76979871?${q}`,
    };
  }
  return {
    ...base,
    kind: 'hosted',
    playbackUrl: `https://cdn.example.com/drills/${encodeURIComponent(spec.id)}.mp4?${q}`,
    sourceUrl: `https://example.com/drills/${encodeURIComponent(spec.id)}?${q}`,
    expiresAt: spec.expiresAt,
  };
}

function sourceNameOf(media: InstructionalMedia): string {
  if (media.kind === 'embed') {
    return media.provider === 'youtube' ? 'YouTube' : 'Vimeo';
  }
  return 'the original source';
}

function render(media: InstructionalMedia | null, onClose: () => void) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <DrillVideoPlayer media={media} onClose={onClose} />,
    );
  });
  return renderer;
}

function byTestId(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === testID,
  );
}

function webView(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n => n.props.testID === 'drill-video-webview' && n.props.source,
  );
  return node ?? null;
}

function pressTestId(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const node = renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  )[0];
  if (!node) return false;
  act(() => {
    node.props.onPress();
  });
  return true;
}

type Stage = 'embed' | 'watch' | 'failed';

/** Stage as visible in the tree, cross-checked against the WebView source. */
function observedStage(
  renderer: TestRenderer.ReactTestRenderer,
  media: InstructionalMedia,
): Stage | 'unknown' {
  if (byTestId(renderer, 'drill-video-error').length > 0) return 'failed';
  const wv = webView(renderer);
  if (!wv) return 'unknown';
  const source = wv.props.source as { uri?: string; html?: string };
  if (source.uri === media.sourceUrl) return 'watch';
  if (media.kind === 'embed' && media.provider === 'youtube') {
    return typeof source.html === 'string' &&
      source.html.includes('dQw4w9WgXcQ')
      ? 'embed'
      : 'unknown';
  }
  if (media.kind === 'embed') {
    return source.uri === `${media.embedUrl}?playsinline=1`
      ? 'embed'
      : 'unknown';
  }
  return source.uri === media.playbackUrl ? 'embed' : 'unknown';
}

function playerBoxGeometry(renderer: TestRenderer.ReactTestRenderer) {
  const wv = webView(renderer);
  const errorCard = byTestId(renderer, 'drill-video-error')[0];
  const box = (wv ?? errorCard)?.parent;
  if (!box) throw new Error('playerBox not found in tree');
  const flat = StyleSheet.flatten(box.props.style) as {
    width?: number;
    height?: number;
    overflow?: string;
  };
  return {
    width: flat.width ?? NaN,
    height: flat.height ?? NaN,
    overflow: flat.overflow ?? null,
  };
}

interface TreeChecks {
  interactive: InteractiveAudit[];
  a11yProblems: string[];
  verbatim: boolean;
  literalGarbage: string[];
  forbidden: string[];
}

function checkTree(
  renderer: TestRenderer.ReactTestRenderer,
  media: InstructionalMedia,
): TreeChecks {
  const interactive = auditInteractive(renderer.root);
  const a11yProblems = interactive.flatMap(i =>
    i.problems.map(p => `${i.testID ?? i.label ?? '?'}:${p}`),
  );
  const texts = collectText(renderer.root);
  // React emits no text instance for '' — an empty Text is still a Text.
  const present = (s: string) => s === '' || texts.includes(s);
  const verbatim =
    present(media.creatorName) &&
    present(media.attribution) &&
    texts.includes(`Watch on ${sourceNameOf(media)}`);
  const literalGarbage = texts.filter(
    t =>
      t === 'undefined' ||
      t === 'null' ||
      t === 'NaN' ||
      t.includes('[object Object]'),
  );
  const appCopy = texts.filter(
    t => t !== media.creatorName && t !== media.attribution,
  );
  const forbidden = appCopy.flatMap(forbiddenCopyHits);
  const labels = interactive.map(i => i.label ?? '');
  return {
    interactive,
    a11yProblems,
    verbatim,
    literalGarbage,
    forbidden: forbidden.concat(labels.flatMap(forbiddenCopyHits)),
  };
}

function driveToFailed(
  renderer: TestRenderer.ReactTestRenderer,
  media: InstructionalMedia,
) {
  // Two main-document failures walk any media down to the error card
  // (embed → watch → failed; hosted → failed).
  for (let i = 0; i < 2; i += 1) {
    const wv = webView(renderer);
    if (!wv) break;
    act(() => {
      wv.props.onError({ nativeEvent: { description: 'stress' } });
    });
  }
  return observedStage(renderer, media);
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
const onClose = jest.fn();
let openUrl: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  onClose.mockReset();
  openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

afterEach(() => {
  openUrl.mockRestore();
  jest.useRealTimers();
});

afterAll(() => {
  const summary = {
    unit: 'cmp-players',
    component: 'DrillVideoPlayer',
    lens: 'boundary-i18n-a11y',
    baseSeed: BASE_SEED,
    stressIter: STRESS_ITER,
    strictLayout: STRICT_LAYOUT,
    executed,
    passed: rows.filter(r => r.verdict === 'pass').length,
    failed: rows.filter(r => r.verdict === 'fail').map(r => r.seed),
    modelErrorCardClipping: rows
      .filter(
        r =>
          (r.observed.errorCardModel as { overflowPt?: number } | undefined)
            ?.overflowPt,
      )
      .map(r => ({
        seed: r.seed,
        viewport: r.inputs.viewport,
        fontScale: r.inputs.fontScale,
        overflowPt: (r.observed.errorCardModel as { overflowPt: number })
          .overflowPt,
      })),
    modelAttributionOverflow: rows
      .filter(
        r =>
          (r.observed.attributionModel as { overflowPt?: number } | undefined)
            ?.overflowPt,
      )
      .map(r => ({
        seed: r.seed,
        viewport: r.inputs.viewport,
        fontScale: r.inputs.fontScale,
        overflowPt: (r.observed.attributionModel as { overflowPt: number })
          .overflowPt,
      })),
  };
  const file = writeEvidence('drillVideoPlayer.rows.json', rows);
  writeEvidence('drillVideoPlayer.summary.json', {
    ...summary,
    rowsFile: file,
  });
});

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

// ---------------------------------------------------------------------------
// 1. a11y + layout grid
// ---------------------------------------------------------------------------

describe('a11y + layout grid (3 kinds × 3 viewports × 3 font scales, playing + error card)', () => {
  const grid: Array<[Kind, Viewport, number]> = [];
  for (const kind of KINDS) {
    for (const viewport of VIEWPORTS) {
      for (const fontScale of FONT_SCALES)
        grid.push([kind, viewport, fontScale]);
    }
  }

  it.each(grid)('%s on %o at fontScale %d', (kind, viewport, fontScale) => {
    const seed =
      BASE_SEED * 10 +
      KINDS.indexOf(kind) * 9 +
      VIEWPORTS.indexOf(viewport) * 3 +
      FONT_SCALES.indexOf(fontScale as FontScale);
    const random = seededRandom(seed);
    setViewport(viewport, fontScale);
    const media = buildMedia({
      kind,
      id: `grid-${seed}`,
      creatorName: 'Pickleball Coach Collective',
      attribution: stringOfClass(random, 'ascii-long', 220),
      licenseName: 'CC BY 4.0',
      expiresAt: '2030-01-01T00:00:00Z',
      numeric: 42,
      extraQuery: '',
    });
    const row: Row = {
      seed,
      campaign: 'a11y-layout-grid',
      inputs: {
        kind,
        viewport: viewport.name,
        width: viewport.width,
        height: viewport.height,
        fontScale,
      },
      observed: {},
      verdict: 'fail',
      failures: [],
    };
    const renderer = render(media, onClose);
    try {
      const playing = checkTree(renderer, media);
      const geometry = playerBoxGeometry(renderer);
      row.observed.playerBox = geometry;
      row.observed.playingInteractive = playing.interactive;
      row.failures.push(...playing.a11yProblems.map(p => `playing:${p}`));
      if (!playing.verbatim) row.failures.push('playing:strings-not-verbatim');
      if (playing.forbidden.length)
        row.failures.push(`forbidden-copy:${playing.forbidden.join(',')}`);
      if (geometry.overflow !== 'hidden')
        row.failures.push('playerBox-overflow-not-hidden');

      const stage = driveToFailed(renderer, media);
      if (stage !== 'failed')
        row.failures.push(`error-card-unreachable:${stage}`);
      const failed = checkTree(renderer, media);
      row.observed.errorInteractive = failed.interactive;
      row.failures.push(...failed.a11yProblems.map(p => `failed:${p}`));
      if (!failed.verbatim) row.failures.push('failed:strings-not-verbatim');
      const buttons = failed.interactive.filter(
        i =>
          i.testID === 'drill-video-open-source' ||
          i.testID === 'drill-video-retry',
      );
      if (buttons.length !== 2)
        row.failures.push(`error-card-buttons:${buttons.length}`);

      const insets = effectiveInsets(viewport);
      const errorCardModel = modelErrorCard(
        geometry.width,
        geometry.height,
        fontScale,
        'This video could not load in the app.',
        `Open on ${sourceNameOf(media)}`,
      );
      const attributionModel = modelAttributionBlock({
        width: viewport.width,
        height: viewport.height,
        insets,
        boxHeight: geometry.height,
        fontScale,
        creatorName: media.creatorName,
        attribution: media.attribution,
        sourceError: null,
      });
      row.observed.errorCardModel = errorCardModel;
      row.observed.attributionModel = attributionModel;
      if (STRICT_LAYOUT) {
        if (errorCardModel.styleFloorPt > geometry.height) {
          row.failures.push(
            `MODEL:error-card-style-floor ${errorCardModel.styleFloorPt}pt > box ${geometry.height}pt`,
          );
        }
        if (attributionModel.overflowPt > 0) {
          row.failures.push(
            `MODEL:attribution-overflow ${attributionModel.overflowPt}pt`,
          );
        }
      }
    } catch (error) {
      row.failures.push(`threw:${String(error)}`);
    } finally {
      act(() => renderer.unmount());
    }
    assertClean([finish(row)]);
  });
});

// ---------------------------------------------------------------------------
// 2. locale × timezone grid
// ---------------------------------------------------------------------------

describe('locale × timezone grid (12 × 8)', () => {
  const grid: Array<[string, string]> = [];
  for (const locale of LOCALES)
    for (const tz of TIMEZONES) grid.push([locale, tz.name]);

  it.each(grid)(
    '%s / %s renders the locale strings verbatim',
    (localeName, tzName) => {
      const locale = LOCALES.find(l => l === localeName)!;
      const tz = TIMEZONES.find(t => t.name === tzName)!;
      const seed =
        BASE_SEED * 100 + LOCALES.indexOf(locale) * 8 + TIMEZONES.indexOf(tz);
      const random = seededRandom(seed);
      const viewport = pick(random, VIEWPORTS);
      const fontScale = pick(random, FONT_SCALES);
      setViewport(viewport, fontScale);
      const script = LOCALE_SCRIPT[locale];
      const creatorName = `${LOCALE_DECOR[locale]} ${stringOfClass(random, script, 24)}`;
      const attribution = `${stringOfClass(random, script, 200)} — ${LOCALE_DECOR[locale]}`;
      const kind = pick(random, KINDS);
      const media = buildMedia({
        kind,
        id: `${locale}-${tz.name}-${seed}`,
        creatorName,
        attribution,
        licenseName: LOCALE_DECOR[locale],
        expiresAt: expiresAtFor(tz),
        numeric: pick(random, BOUNDARY_NUMERICS),
        extraQuery: '',
      });
      const row: Row = {
        seed,
        campaign: 'locale-tz-grid',
        inputs: {
          locale,
          timezone: tz.name,
          expiresAt: expiresAtFor(tz),
          tzNote: tz.note,
          kind,
          viewport: viewport.name,
          fontScale,
          creatorName: preview(creatorName),
          attribution: preview(attribution),
          creatorLength: creatorName.length,
          attributionLength: attribution.length,
        },
        observed: {},
        verdict: 'fail',
        failures: [],
      };
      const renderer = render(media, onClose);
      try {
        const checks = checkTree(renderer, media);
        row.observed.interactive = checks.interactive;
        row.failures.push(...checks.a11yProblems);
        if (!checks.verbatim) row.failures.push('strings-not-verbatim');
        if (checks.literalGarbage.length)
          row.failures.push(
            `literal-garbage:${checks.literalGarbage.join(',')}`,
          );
        if (checks.forbidden.length)
          row.failures.push(`forbidden-copy:${checks.forbidden.join(',')}`);
        const stage = observedStage(renderer, media);
        row.observed.stage = stage;
        if (stage !== 'embed') row.failures.push(`initial-stage:${stage}`);
        const geometry = playerBoxGeometry(renderer);
        row.observed.attributionModel = modelAttributionBlock({
          width: viewport.width,
          height: viewport.height,
          insets: effectiveInsets(viewport),
          boxHeight: geometry.height,
          fontScale,
          creatorName,
          attribution,
          sourceError: null,
        });
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
// 3. seeded fuzz — strings × numerics × viewport × lifecycle script
// ---------------------------------------------------------------------------

type Action =
  | 'ready'
  | 'player-error'
  | 'garbage-message'
  | 'webview-error'
  | 'http-error-main'
  | 'http-error-sub'
  | 'http-error-no-url'
  | 'watchdog'
  | 'retry'
  | 'open-source'
  | 'close'
  | 'dismiss'
  | 'rerender-same'
  | 'swap-media';

const ACTIONS: readonly Action[] = [
  'ready',
  'player-error',
  'garbage-message',
  'webview-error',
  'http-error-main',
  'http-error-sub',
  'http-error-no-url',
  'watchdog',
  'retry',
  'open-source',
  'close',
  'dismiss',
  'rerender-same',
  'swap-media',
];

interface Oracle {
  stage: Stage;
  embedReady: boolean;
  closes: number;
  opens: number;
  sourceError: boolean;
}

function mainUrlOf(media: InstructionalMedia, stage: Stage): string {
  if (stage === 'watch') return media.sourceUrl;
  return media.kind === 'embed' ? media.embedUrl : media.playbackUrl;
}

function randomSpec(random: () => number, idClass: StringClass): MediaSpec {
  const creatorClass = pick(random, STRING_CLASSES);
  const attributionClass = pick(random, STRING_CLASSES);
  const length = pick(random, [200, 320, 600]);
  return {
    kind: pick(random, KINDS),
    id: idClass === 'empty' ? '' : stringOfClass(random, idClass, 8),
    creatorName: stringOfClass(random, creatorClass, length),
    attribution: stringOfClass(random, attributionClass, length),
    licenseName: stringOfClass(random, pick(random, STRING_CLASSES), 12),
    expiresAt: expiresAtFor(pick(random, TIMEZONES)),
    numeric: pick(random, BOUNDARY_NUMERICS),
    extraQuery: `&q=${encodeURIComponent(stringOfClass(random, pick(random, STRING_CLASSES), 24))}`,
  };
}

describe(`seeded fuzz (STRESS_ITER=${STRESS_ITER})`, () => {
  const seeds = seedsFor(STRESS_ITER);

  it(`runs ${seeds.length} seeded lifecycle variants against the stage oracle`, async () => {
    const batch: Row[] = [];
    for (const seed of seeds) {
      const random = seededRandom(seed);
      const viewport = pick(random, VIEWPORTS);
      const fontScale = pick(random, FONT_SCALES);
      setViewport(viewport, fontScale);
      const spec = randomSpec(random, pick(random, STRING_CLASSES));
      let media = buildMedia(spec);
      const refuseOpen = random() < 0.5;
      openUrl.mockImplementation(() =>
        refuseOpen
          ? Promise.reject(new Error('refused'))
          : Promise.resolve(undefined),
      );
      const scriptLength = randomInt(random, 0, 8);
      const script: Action[] = [];
      for (let i = 0; i < scriptLength; i += 1)
        script.push(pick(random, ACTIONS));

      const row: Row = {
        seed,
        campaign: 'seeded-fuzz',
        inputs: {
          kind: spec.kind,
          viewport: viewport.name,
          fontScale,
          id: preview(spec.id),
          creatorName: preview(spec.creatorName),
          creatorLength: spec.creatorName.length,
          attribution: preview(spec.attribution),
          attributionLength: spec.attribution.length,
          numeric: spec.numeric,
          expiresAt: spec.expiresAt,
          refuseOpen,
          script,
        },
        observed: {},
        verdict: 'fail',
        failures: [],
      };

      const oracle: Oracle = {
        stage: 'embed',
        embedReady: false,
        closes: 0,
        opens: 0,
        sourceError: false,
      };
      const renderer = render(media, onClose);
      const trace: string[] = [];
      try {
        const initial = checkTree(renderer, media);
        row.failures.push(...initial.a11yProblems.map(p => `initial:${p}`));
        if (!initial.verbatim)
          row.failures.push('initial:strings-not-verbatim');
        if (initial.literalGarbage.length)
          row.failures.push(
            `literal-garbage:${initial.literalGarbage.join(',')}`,
          );
        if (initial.forbidden.length)
          row.failures.push(`forbidden-copy:${initial.forbidden.join(',')}`);

        for (const action of script) {
          const wv = webView(renderer);
          const youtube =
            media.kind === 'embed' && media.provider === 'youtube';
          switch (action) {
            case 'ready':
              if (wv) {
                act(() =>
                  wv.props.onMessage({
                    nativeEvent: { data: JSON.stringify({ kind: 'ready' }) },
                  }),
                );
                // The message handler is stage-agnostic.
                oracle.embedReady = true;
              }
              break;
            case 'player-error':
              if (wv) {
                act(() =>
                  wv.props.onMessage({
                    nativeEvent: {
                      data: JSON.stringify({
                        kind: 'error',
                        code: spec.numeric,
                      }),
                    },
                  }),
                );
                // The message handler is stage-agnostic: any player error moves to watch.
                oracle.stage = 'watch';
              }
              break;
            case 'garbage-message':
              if (wv) {
                const garbage = pick(random, [
                  stringOfClass(random, 'cjk', 40),
                  '',
                  'null',
                  '123',
                  '{"kind":123}',
                  '[]',
                  '{"kind":"ready"',
                  JSON.stringify({
                    kind: stringOfClass(random, 'zwj-emoji', 20),
                  }),
                ]);
                act(() =>
                  wv.props.onMessage({ nativeEvent: { data: garbage } }),
                );
              }
              break;
            case 'webview-error':
              if (wv) {
                act(() =>
                  wv.props.onError({
                    nativeEvent: {
                      code: spec.numeric,
                      description: spec.creatorName,
                    },
                  }),
                );
                oracle.stage =
                  oracle.stage === 'embed' && media.kind === 'embed'
                    ? 'watch'
                    : 'failed';
              }
              break;
            case 'http-error-main':
              if (wv) {
                const url = `${mainUrlOf(media, oracle.stage)}${mainUrlOf(media, oracle.stage).includes('?') ? '&' : '?'}stress=1`;
                act(() =>
                  wv.props.onHttpError({
                    nativeEvent: { url, statusCode: 404 },
                  }),
                );
                oracle.stage =
                  oracle.stage === 'embed' && media.kind === 'embed'
                    ? 'watch'
                    : 'failed';
              }
              break;
            case 'http-error-sub':
              if (wv) {
                act(() =>
                  wv.props.onHttpError({
                    nativeEvent: {
                      url: 'https://ads.example.net/px.gif',
                      statusCode: 403,
                    },
                  }),
                );
              }
              break;
            case 'http-error-no-url':
              if (wv) {
                act(() =>
                  wv.props.onHttpError({ nativeEvent: { statusCode: 500 } }),
                );
              }
              break;
            case 'watchdog':
              act(() => {
                jest.advanceTimersByTime(EMBED_READY_TIMEOUT_MS + 1);
              });
              if (youtube && oracle.stage === 'embed' && !oracle.embedReady)
                oracle.stage = 'watch';
              break;
            case 'retry':
              if (pressTestId(renderer, 'drill-video-retry')) {
                oracle.stage = 'embed';
                oracle.embedReady = false;
              }
              break;
            case 'open-source': {
              const pressed =
                pressTestId(renderer, 'drill-video-open-source') ||
                pressTestId(renderer, 'drill-video-source-link');
              if (pressed) {
                oracle.opens += 1;
                // openSource awaits Linking; flush the microtask queue.
                await act(async () => {
                  await Promise.resolve();
                  await Promise.resolve();
                });
                oracle.sourceError = refuseOpen;
              }
              break;
            }
            case 'close':
              if (pressTestId(renderer, 'drill-video-close'))
                oracle.closes += 1;
              break;
            case 'dismiss': {
              const backdrop = renderer.root.findAll(
                n =>
                  n.props.accessibilityLabel === 'Dismiss video' &&
                  typeof n.props.onPress === 'function',
              )[0];
              if (backdrop) {
                act(() => backdrop.props.onPress());
                oracle.closes += 1;
              }
              break;
            }
            case 'rerender-same':
              act(() => {
                renderer.update(
                  <DrillVideoPlayer media={{ ...media }} onClose={onClose} />,
                );
              });
              break;
            case 'swap-media': {
              const next = buildMedia({
                ...randomSpec(random, pick(random, STRING_CLASSES)),
                id: `${spec.id}-swap-${trace.length}`,
              });
              media = next;
              act(() => {
                renderer.update(
                  <DrillVideoPlayer media={media} onClose={onClose} />,
                );
              });
              oracle.stage = 'embed';
              oracle.embedReady = false;
              oracle.sourceError = false;
              break;
            }
          }
          const stage = observedStage(renderer, media);
          trace.push(`${action}→${stage}`);
          if (stage !== oracle.stage) {
            row.failures.push(
              `after ${action}: stage ${stage} ≠ oracle ${oracle.stage}`,
            );
            break;
          }
          const overlay =
            byTestId(renderer, 'drill-video-embed-loading').length > 0;
          const nowYoutube =
            media.kind === 'embed' && media.provider === 'youtube';
          const expectOverlay =
            nowYoutube && oracle.stage === 'embed' && !oracle.embedReady;
          if (overlay !== expectOverlay)
            row.failures.push(
              `after ${action}: loading overlay ${overlay} ≠ ${expectOverlay}`,
            );
          const alert = byTestId(renderer, 'drill-video-source-error');
          if (alert.length > 0 !== oracle.sourceError) {
            row.failures.push(
              `after ${action}: source alert ${alert.length > 0} ≠ ${oracle.sourceError}`,
            );
          }
          if (alert[0] && alert[0].props.accessibilityRole !== 'alert')
            row.failures.push('source-alert-missing-role');
          if (alert[0]) {
            const text = collectText(alert[0]).join('');
            if (
              text !==
              `${sourceNameOf(media)} could not be opened on this device.`
            )
              row.failures.push(`alert-text:${preview(text)}`);
          }
        }

        const final = checkTree(renderer, media);
        row.observed.finalInteractive = final.interactive.map(i => ({
          testID: i.testID,
          role: i.role,
          label: preview(i.label),
          effectiveWidth: i.effectiveWidth,
          effectiveHeight: i.effectiveHeight,
          fillsParent: i.fillsParent,
        }));
        row.failures.push(...final.a11yProblems.map(p => `final:${p}`));
        if (!final.verbatim) row.failures.push('final:strings-not-verbatim');
        if (final.literalGarbage.length)
          row.failures.push(
            `final-literal-garbage:${final.literalGarbage.join(',')}`,
          );
        if (onClose.mock.calls.length !== oracle.closes)
          row.failures.push(
            `onClose ${onClose.mock.calls.length} ≠ ${oracle.closes}`,
          );
        if (openUrl.mock.calls.length !== oracle.opens)
          row.failures.push(
            `openURL ${openUrl.mock.calls.length} ≠ ${oracle.opens}`,
          );
        for (const call of openUrl.mock.calls) {
          if (
            call[0] !== media.sourceUrl &&
            !trace.some(t => t.startsWith('swap-media'))
          ) {
            row.failures.push(`openURL arg ${preview(call[0])} ≠ sourceUrl`);
          }
        }
        row.observed.trace = trace;
        row.observed.stage = oracle.stage;
        const geometry = playerBoxGeometry(renderer);
        row.observed.playerBox = geometry;
        row.observed.attributionModel = modelAttributionBlock({
          width: viewport.width,
          height: viewport.height,
          insets: effectiveInsets(viewport),
          boxHeight: geometry.height,
          fontScale,
          creatorName: media.creatorName,
          attribution: media.attribution,
          sourceError: oracle.sourceError
            ? `${sourceNameOf(media)} could not be opened on this device.`
            : null,
        });
        if (oracle.stage === 'failed') {
          row.observed.errorCardModel = modelErrorCard(
            geometry.width,
            geometry.height,
            fontScale,
            'This video could not load in the app.',
            `Open on ${sourceNameOf(media)}`,
          );
        }
      } catch (error) {
        row.failures.push(`threw:${String(error)}`);
        row.observed.trace = trace;
      } finally {
        act(() => renderer.unmount());
        onClose.mockReset();
        openUrl.mockClear();
      }
      batch.push(finish(row));
    }
    assertClean(batch);
  });
});

// ---------------------------------------------------------------------------
// 4. null media
// ---------------------------------------------------------------------------

describe('null media', () => {
  const grid: Array<[Viewport, number]> = [];
  for (const viewport of VIEWPORTS)
    for (const fontScale of FONT_SCALES) grid.push([viewport, fontScale]);

  it.each(grid)(
    'renders nothing on %o at fontScale %d',
    (viewport, fontScale) => {
      const seed =
        BASE_SEED * 1000 +
        VIEWPORTS.indexOf(viewport) * 3 +
        FONT_SCALES.indexOf(fontScale as FontScale);
      setViewport(viewport, fontScale);
      const row: Row = {
        seed,
        campaign: 'null-media',
        inputs: { viewport: viewport.name, fontScale },
        observed: {},
        verdict: 'fail',
        failures: [],
      };
      const renderer = render(null, onClose);
      try {
        const json = renderer.toJSON();
        row.observed.tree = json;
        if (json !== null) row.failures.push('null-media-rendered-tree');
        act(() => {
          jest.advanceTimersByTime(EMBED_READY_TIMEOUT_MS * 2);
        });
        if (onClose.mock.calls.length !== 0)
          row.failures.push('onClose-called');
      } catch (error) {
        row.failures.push(`threw:${String(error)}`);
      } finally {
        act(() => renderer.unmount());
      }
      assertClean([finish(row)]);
    },
  );
});
