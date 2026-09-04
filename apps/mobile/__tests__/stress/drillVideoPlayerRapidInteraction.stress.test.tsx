import React, { useState } from 'react';
import { Linking, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { writeFileSync } from 'node:fs';
import type { InstructionalMedia } from '../../src/training/types';

/**
 * RAPID / CONCURRENT INTERACTION stress campaign for DrillVideoPlayer.
 *
 * A seeded generator scripts interaction bursts against the real component
 * (react-test-renderer + fake timers): double/triple close taps, back during
 * an in-flight Linking.openURL, player events and taps landing in the SAME
 * React batch (one bridge flush), watchdog boundaries, media swaps while the
 * fallback ladder is mid-way, and reopen-after-close. Every iteration is
 * replayable from its seed; the outcome table is written to STRESS_OUT.
 *
 *   STRESS_ITER  iterations per campaign (default 40 — fast enough for CI)
 *   STRESS_SEED  base seed (default 20260904)
 *   STRESS_OUT   optional JSON path for the seed → outcome table
 *   STRESS_ONLY  comma-separated seeds to replay (minimization / triage)
 *
 * Intent-level invariants (implementation-independent):
 *   I1  at most one WebView is mounted at any time
 *   I2  the mounted WebView always belongs to the CURRENT media
 *   I3  every failure event steps the ladder exactly one rung
 *       (embed → watch → failed); only the YouTube shell's own
 *       {kind:"error"} counts as a failure event, and no message ever
 *       regresses a failed ladder; a ready signal never regresses it
 *   I4  the loading overlay is present iff youtube && embed && !ready
 *       (no orphan spinner after ready / on watch / on failed)
 *   I5  a ready signal defuses the watchdog for good (folded into I3)
 *   I6  close: onClose fires once per tap, the host closes, no WebView and
 *       no watchdog timer survive close/unmount
 *   I7  every source-link tap makes exactly one openURL request; an error
 *       is shown only after a rejection and only for the media that was
 *       tapped; rejections never surface as unhandled
 *   I8  nothing throws, no console.error (act warnings included)
 *   I9  a stage change mounts exactly one WebView — no throwaway mounts
 */

interface WebViewSource {
  uri?: string;
  html?: string;
  baseUrl?: string;
}

interface WebViewMount {
  source: WebViewSource;
  alive: boolean;
}

// `mock`-prefixed so the hoisted jest.mock factory may reference it.
const mockMounts: WebViewMount[] = [];

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

// Passthrough View that keeps every WebView prop callable AND records
// mount/unmount so throwaway players (a mount that never should have
// existed) are visible to the harness.
jest.mock('react-native-webview', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockWebView = (props: { source: WebViewSource }) => {
    ReactModule.useEffect(() => {
      const entry: WebViewMount = { source: props.source, alive: true };
      mockMounts.push(entry);
      return () => {
        entry.alive = false;
      };
    }, []);
    return ReactModule.createElement(View, props);
  };
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import {
  DrillVideoPlayer,
  EMBED_READY_TIMEOUT_MS,
} from '../../src/components/DrillVideoPlayer';

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — every iteration is replayable from its seed.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const youtubeA: InstructionalMedia = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  kind: 'embed',
  provider: 'youtube',
  videoId: 'ytA_000001',
  embedUrl: 'https://www.youtube-nocookie.com/embed/ytA_000001',
  sourceUrl: 'https://www.youtube.com/watch?v=ytA_000001',
  creatorName: 'Creator A',
  licenseName: 'YouTube Terms of Service',
  licenseUrl: 'https://www.youtube.com/t/terms',
  attribution: 'Video by Creator A on YouTube',
};

const youtubeB: InstructionalMedia = {
  ...youtubeA,
  id: 'a1b2c3d4-0000-4000-8000-000000000002',
  videoId: 'ytB_000002',
  embedUrl: 'https://www.youtube-nocookie.com/embed/ytB_000002',
  sourceUrl: 'https://www.youtube.com/watch?v=ytB_000002',
  creatorName: 'Creator B',
  attribution: 'Video by Creator B on YouTube',
};

const vimeoC: InstructionalMedia = {
  id: 'a1b2c3d4-0000-4000-8000-000000000003',
  kind: 'embed',
  provider: 'vimeo',
  videoId: '33000003',
  embedUrl: 'https://player.vimeo.com/video/33000003',
  sourceUrl: 'https://vimeo.com/33000003',
  creatorName: 'Creator C',
  licenseName: 'Vimeo Terms of Service',
  licenseUrl: null,
  attribution: 'Video by Creator C on Vimeo',
};

const hostedD: InstructionalMedia = {
  id: 'a1b2c3d4-0000-4000-8000-000000000004',
  kind: 'hosted',
  playbackUrl: 'https://cdn.example.com/drills/d.mp4?sig=abc',
  expiresAt: '2030-01-01T00:00:00.000Z',
  sourceUrl: 'https://example.com/drills/d',
  creatorName: 'Creator D',
  licenseName: 'Licensed to Pickle Sensei',
  licenseUrl: null,
  attribution: 'Video licensed for Pickle Sensei',
};

const MEDIA: readonly InstructionalMedia[] = [
  youtubeA,
  youtubeB,
  vimeoC,
  hostedD,
];

type Stage = 'embed' | 'watch' | 'failed';

function providerName(media: InstructionalMedia): string {
  if (media.kind === 'embed') {
    return media.provider === 'youtube' ? 'YouTube' : 'Vimeo';
  }
  return 'the original source';
}

function isYoutube(media: InstructionalMedia | null): boolean {
  return (
    media !== null && media.kind === 'embed' && media.provider === 'youtube'
  );
}

function mainUrlFor(media: InstructionalMedia, stage: Stage): string {
  if (stage === 'watch') return media.sourceUrl;
  return media.kind === 'embed' ? media.embedUrl : media.playbackUrl;
}

function sourceStage(
  source: WebViewSource,
  media: InstructionalMedia,
): Stage | null {
  if (source.html !== undefined) {
    return media.kind === 'embed' &&
      media.provider === 'youtube' &&
      source.html.includes(JSON.stringify(media.videoId))
      ? 'embed'
      : null;
  }
  if (source.uri === undefined) return null;
  if (source.uri === media.sourceUrl) return 'watch';
  if (media.kind === 'embed' && source.uri.startsWith(media.embedUrl))
    return 'embed';
  if (media.kind === 'hosted' && source.uri === media.playbackUrl)
    return 'embed';
  return null;
}

// ---------------------------------------------------------------------------
// Host: models DrillLibraryScreen's ownership of `playerMedia`
// (onClose → setPlayerMedia(null); a row tap → setPlayerMedia(media)).
// ---------------------------------------------------------------------------

interface HostApi {
  setMedia: (media: InstructionalMedia | null) => void;
}

function Host(props: {
  initial: InstructionalMedia | null;
  onClose: () => void;
  api: { current: HostApi | null };
}) {
  const [media, setMedia] = useState<InstructionalMedia | null>(props.initial);
  props.api.current = { setMedia };
  return (
    <DrillVideoPlayer
      media={media}
      onClose={() => {
        props.onClose();
        setMedia(null);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Intent-level model
// ---------------------------------------------------------------------------

interface Model {
  media: InstructionalMedia | null;
  stage: Stage;
  ready: boolean;
  /** fake-clock ms at which the watchdog fires; null when disarmed */
  watchdogAt: number | null;
  now: number;
  /** media id whose source-link rejection is allowed to show an error */
  errorOwner: string | null;
}

function armWatchdog(model: Model): void {
  model.watchdogAt =
    isYoutube(model.media) && model.stage === 'embed' && !model.ready
      ? model.now + EMBED_READY_TIMEOUT_MS
      : null;
}

function modelOpen(model: Model, media: InstructionalMedia | null): void {
  const changed = (model.media?.id ?? null) !== (media?.id ?? null);
  model.media = media;
  if (!changed) return;
  model.stage = 'embed';
  model.ready = false;
  model.errorOwner = null;
  armWatchdog(model);
}

/** One failure event steps exactly one rung. */
function modelFail(model: Model): void {
  if (!model.media) return;
  model.stage =
    model.stage === 'embed' && model.media.kind === 'embed'
      ? 'watch'
      : 'failed';
  armWatchdog(model);
}

function modelElapse(model: Model, ms: number): void {
  const target = model.now + ms;
  if (model.watchdogAt !== null && model.watchdogAt <= target) {
    model.stage = 'watch';
    model.watchdogAt = null;
  }
  model.now = target;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Action =
  | { kind: 'tapClose'; via: 'button' | 'backdrop' | 'back'; taps: number }
  | { kind: 'msg'; payload: string }
  | { kind: 'wvError' }
  | { kind: 'wvHttp'; frame: 'main' | 'sub' }
  | { kind: 'elapse'; ms: number }
  | { kind: 'tapRetry'; taps: number }
  | {
      kind: 'tapSource';
      via: 'link' | 'errorCard';
      outcome: 'ok' | 'fail' | 'defer';
    }
  | { kind: 'settle'; how: 'ok' | 'fail' }
  | { kind: 'swap'; to: number }
  | { kind: 'reopen'; to: number }
  | { kind: 'batch'; actions: Action[] };

const ELAPSES: readonly number[] = [
  50,
  500,
  EMBED_READY_TIMEOUT_MS - 1,
  EMBED_READY_TIMEOUT_MS,
  EMBED_READY_TIMEOUT_MS + 1,
  EMBED_READY_TIMEOUT_MS * 3,
];

const MESSAGES: readonly string[] = [
  '{"kind":"ready"}',
  '{"kind":"ready"}',
  '{"kind":"error","code":153}',
  '{"kind":"error","code":"api-load-failed"}',
  'not json',
  'null',
  '42',
  '{"kind":"unknown"}',
  '{"kind":{"nested":true}}',
];

/** Events that can plausibly share one bridge flush with each other. */
function genBatchInner(rng: Rng): Action {
  const roll = rng.int(100);
  if (roll < 20) {
    return {
      kind: 'tapClose',
      via: rng.pick(['button', 'backdrop', 'back'] as const),
      taps: 1 + rng.int(3),
    };
  }
  if (roll < 45) return { kind: 'msg', payload: rng.pick(MESSAGES) };
  if (roll < 60) return { kind: 'wvError' };
  if (roll < 72)
    return { kind: 'wvHttp', frame: rng.pick(['main', 'sub'] as const) };
  if (roll < 80) return { kind: 'tapRetry', taps: 1 + rng.int(3) };
  if (roll < 92) {
    return {
      kind: 'tapSource',
      via: rng.pick(['link', 'errorCard'] as const),
      outcome: rng.pick(['ok', 'fail', 'defer'] as const),
    };
  }
  return { kind: 'settle', how: rng.pick(['ok', 'fail'] as const) };
}

function genAction(rng: Rng): Action {
  const roll = rng.int(100);
  if (roll < 12) {
    return {
      kind: 'tapClose',
      via: rng.pick(['button', 'backdrop', 'back'] as const),
      taps: 1 + rng.int(3),
    };
  }
  if (roll < 28) return { kind: 'msg', payload: rng.pick(MESSAGES) };
  if (roll < 35) return { kind: 'wvError' };
  if (roll < 42)
    return { kind: 'wvHttp', frame: rng.pick(['main', 'sub'] as const) };
  if (roll < 55) return { kind: 'elapse', ms: rng.pick(ELAPSES) };
  if (roll < 61) return { kind: 'tapRetry', taps: 1 + rng.int(3) };
  if (roll < 71) {
    return {
      kind: 'tapSource',
      via: rng.pick(['link', 'errorCard'] as const),
      outcome: rng.pick(['ok', 'fail', 'defer'] as const),
    };
  }
  if (roll < 77)
    return { kind: 'settle', how: rng.pick(['ok', 'fail'] as const) };
  if (roll < 83) return { kind: 'swap', to: rng.int(MEDIA.length) };
  if (roll < 90) return { kind: 'reopen', to: rng.int(MEDIA.length) };
  const size = 2 + rng.int(2);
  const actions: Action[] = [];
  for (let i = 0; i < size; i += 1) actions.push(genBatchInner(rng));
  return { kind: 'batch', actions };
}

function genBurst(rng: Rng): Action[] {
  const length = 3 + rng.int(10);
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) actions.push(genAction(rng));
  return actions;
}

// ---------------------------------------------------------------------------
// Tree probes
// ---------------------------------------------------------------------------

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

function webViews(renderer: Renderer): Instance[] {
  return renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      n.props.testID === 'drill-video-webview' &&
      n.props.source !== undefined,
  );
}

function hostNodes(renderer: Renderer, testID: string): Instance[] {
  return renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === testID,
  );
}

function pressables(renderer: Renderer, label: string): Instance[] {
  return renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
}

function modalNode(renderer: Renderer): Instance | null {
  const [node] = renderer.root.findAll(
    n =>
      typeof n.props.onRequestClose === 'function' && n.props.visible === true,
  );
  return node ?? null;
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' | ');
}

function renderedStage(
  renderer: Renderer,
  media: InstructionalMedia,
): Stage | 'closed' | 'ambiguous' {
  const views = webViews(renderer);
  const error = hostNodes(renderer, 'drill-video-error');
  if (hostNodes(renderer, 'drill-video-player').length === 0) return 'closed';
  if (error.length > 0) return views.length === 0 ? 'failed' : 'ambiguous';
  const [view] = views;
  if (!view || views.length !== 1) return 'ambiguous';
  return sourceStage(view.props.source as WebViewSource, media) ?? 'ambiguous';
}

// ---------------------------------------------------------------------------
// Campaign runner
// ---------------------------------------------------------------------------

interface Violation {
  invariant: string;
  step: number;
  action: string;
  detail: string;
}

interface Outcome {
  seed: number;
  initialMedia: string;
  actions: number;
  interactions: number;
  violations: Violation[];
  outcome: 'HELD' | 'BROKEN';
  script: Action[];
}

interface Deferred {
  resolve: () => void;
  reject: (error: Error) => void;
  mediaId: string;
}

async function runIteration(seed: number): Promise<Outcome> {
  const rng = new Rng(seed);
  const initial = MEDIA[rng.int(MEDIA.length)] ?? youtubeA;
  const script = genBurst(rng);
  const violations: Violation[] = [];
  let interactions = 0;
  let step = 0;
  let stepLabel = 'mount';

  const record = (invariant: string, detail: string) => {
    violations.push({ invariant, step, action: stepLabel, detail });
  };

  const consoleErrors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(a => String(a)).join(' '));
    });
  const unhandled: string[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(String(reason));
  };
  process.on('unhandledRejection', onUnhandled);

  const pending: Deferred[] = [];
  let openUrlCalls = 0;
  let nextOutcome: 'ok' | 'fail' | 'defer' = 'ok';
  const openUrl = jest
    .spyOn(Linking, 'openURL')
    .mockImplementation((url: string) => {
      openUrlCalls += 1;
      const owner =
        MEDIA.find(m => m.sourceUrl === url)?.id ?? `unknown:${url}`;
      if (nextOutcome === 'ok') return Promise.resolve();
      if (nextOutcome === 'fail')
        return Promise.reject(new Error('no handler'));
      return new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject, mediaId: owner });
      });
    });

  const onClose = jest.fn();
  const api: { current: HostApi | null } = { current: null };
  const model: Model = {
    media: null,
    stage: 'embed',
    ready: false,
    watchdogAt: null,
    now: 0,
    errorOwner: null,
  };
  mockMounts.length = 0;

  // Track the component's own watchdog timers (identified by their delay)
  // independently of React's internal scheduling timers.
  const watchdogs = new Set<unknown>();
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const trackingSetTimeout = ((
    handler: (...args: unknown[]) => void,
    delay?: number,
    ...rest: unknown[]
  ) => {
    if (delay !== EMBED_READY_TIMEOUT_MS) {
      return realSetTimeout(handler, delay, ...rest);
    }
    const handle: unknown = realSetTimeout(
      (...args: unknown[]) => {
        watchdogs.delete(handle);
        handler(...args);
      },
      delay,
      ...rest,
    );
    watchdogs.add(handle);
    return handle;
  }) as typeof setTimeout;
  const trackingClearTimeout = ((handle: unknown) => {
    watchdogs.delete(handle);
    realClearTimeout(handle as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  global.setTimeout = trackingSetTimeout;
  global.clearTimeout = trackingClearTimeout;

  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Host initial={initial} onClose={onClose} api={api} />,
    );
  });
  modelOpen(model, initial);
  let expectedCloseCalls = 0;
  let mountsSeen = 0;
  let expectedMounts = 1;

  const check = () => {
    const views = webViews(renderer);
    if (views.length > 1) record('I1', `${views.length} WebViews mounted`);
    const media = model.media;
    if (media) {
      for (const view of views) {
        if (sourceStage(view.props.source as WebViewSource, media) === null) {
          record(
            'I2',
            `WebView source ${JSON.stringify(view.props.source).slice(0, 120)} is not ${media.id}`,
          );
        }
      }
      const stage = renderedStage(renderer, media);
      if (stage !== model.stage) {
        record('I3', `rendered stage ${stage}, model ${model.stage}`);
      }
      const overlay = hostNodes(renderer, 'drill-video-embed-loading').length;
      const wantOverlay =
        isYoutube(media) && model.stage === 'embed' && !model.ready;
      if (overlay > 0 !== wantOverlay || overlay > 1) {
        record(
          'I4',
          `overlay count ${overlay}, expected ${wantOverlay ? 1 : 0}`,
        );
      }
      if (hostNodes(renderer, 'drill-video-source-error').length > 0) {
        const shown = allText(renderer);
        const expectedName = providerName(media);
        if (!shown.includes(`${expectedName} could not be opened`)) {
          record(
            'I7',
            `source error text does not name the current media (${expectedName}): ${shown.slice(-140)}`,
          );
        }
        if (model.errorOwner !== media.id) {
          record(
            'I7',
            `source error shown for media ${media.id} but the rejection belonged to ${model.errorOwner ?? 'nobody'}`,
          );
        }
      }
    } else {
      if (renderer.toJSON() !== null)
        record('I6', 'closed player still renders');
      if (views.length > 0) record('I6', 'WebView survives close');
    }
    const wantWatchdogs = model.watchdogAt === null ? 0 : 1;
    if (watchdogs.size !== wantWatchdogs) {
      record(
        media ? 'I5' : 'I6',
        `${watchdogs.size} watchdog timer(s) pending, expected ${wantWatchdogs}`,
      );
    }
    const alive = mockMounts.filter(m => m.alive).length;
    if (alive !== views.length)
      record('I1', `ledger alive=${alive} tree=${views.length}`);
    if (mockMounts.length > mountsSeen) {
      const fresh = mockMounts.slice(mountsSeen);
      mountsSeen = mockMounts.length;
      for (const mount of fresh) {
        if (media && sourceStage(mount.source, media) === null) {
          record(
            'I9',
            `mounted a WebView that is not for ${media.id}: ${JSON.stringify(mount.source).slice(0, 120)}`,
          );
        }
      }
      if (mockMounts.length > expectedMounts) {
        record(
          'I9',
          `${mockMounts.length} WebView mounts so far, only ${expectedMounts} explained by stage changes (throwaway mount: ${fresh
            .map(m => JSON.stringify(m.source).slice(0, 80))
            .join(' -> ')})`,
        );
        expectedMounts = mockMounts.length;
      }
    }
    if (onClose.mock.calls.length !== expectedCloseCalls) {
      record(
        'I6',
        `onClose called ${onClose.mock.calls.length}×, expected ${expectedCloseCalls}`,
      );
      expectedCloseCalls = onClose.mock.calls.length;
    }
  };

  const fireOne = (
    action: Action,
    stageAtStart: Stage,
    viewAtStart: Instance | null,
    inBatch: boolean,
  ) => {
    const media = model.media;
    const view = inBatch ? viewAtStart : (webViews(renderer)[0] ?? null);
    const stageUnchanged = model.stage === stageAtStart;
    switch (action.kind) {
      case 'tapClose': {
        if (!media) return;
        interactions += action.taps;
        for (let i = 0; i < action.taps; i += 1) {
          if (action.via === 'back') {
            modalNode(renderer)?.props.onRequestClose();
          } else {
            const label =
              action.via === 'button' ? 'Close video player' : 'Dismiss video';
            pressables(renderer, label)[0]?.props.onPress();
          }
        }
        // Every tap that lands before the host re-renders reaches onClose;
        // the host's null-set is idempotent so the intent is one close.
        expectedCloseCalls += action.taps;
        modelOpen(model, null);
        return;
      }
      case 'msg': {
        if (!view) return;
        interactions += 1;
        view.props.onMessage({ nativeEvent: { data: action.payload } });
        if (!media) return;
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(action.payload);
        } catch {
          return;
        }
        const kind =
          parsed !== null && typeof parsed === 'object' && 'kind' in parsed
            ? (parsed as { kind: unknown }).kind
            : undefined;
        // Only the YouTube shell (embed stage) speaks the ready/error
        // protocol; a message from any other document is third-party
        // content and must not drive the ladder.
        if (!stageUnchanged || model.stage !== 'embed' || !isYoutube(media)) {
          return;
        }
        if (kind === 'ready') {
          model.ready = true;
          armWatchdog(model);
        } else if (kind === 'error') {
          modelFail(model);
          expectedMounts += 1;
        }
        return;
      }
      case 'wvError': {
        if (!view) return;
        interactions += 1;
        view.props.onError();
        if (!media) return;
        // Each failure signal is its own rung (functional setState), even
        // when two land in one batch.
        modelFail(model);
        if (model.stage === 'watch') expectedMounts += 1;
        return;
      }
      case 'wvHttp': {
        if (!view) return;
        interactions += 1;
        const url =
          action.frame === 'main' && media
            ? mainUrlFor(media, stageAtStart)
            : 'https://ads.example.net/blocked.js';
        view.props.onHttpError({ nativeEvent: { url, statusCode: 404 } });
        if (!media || action.frame !== 'main') return;
        modelFail(model);
        if (model.stage === 'watch') expectedMounts += 1;
        return;
      }
      case 'elapse': {
        const before = model.stage;
        jest.advanceTimersByTime(action.ms);
        modelElapse(model, action.ms);
        if (model.stage !== before) expectedMounts += 1;
        return;
      }
      case 'tapRetry': {
        const nodes = pressables(renderer, 'Try loading the video again');
        if (!media || nodes.length === 0) return;
        interactions += action.taps;
        for (let i = 0; i < action.taps; i += 1) nodes[0]?.props.onPress();
        if (!stageUnchanged) return;
        model.stage = 'embed';
        model.ready = false;
        armWatchdog(model);
        expectedMounts += 1;
        return;
      }
      case 'tapSource': {
        if (!media) return;
        const label =
          action.via === 'link'
            ? `Watch on ${providerName(media)}`
            : `Open on ${providerName(media)}`;
        const nodes = pressables(renderer, label);
        if (nodes.length === 0) return;
        interactions += 1;
        nextOutcome = action.outcome;
        const callsBefore = openUrlCalls;
        nodes[0]?.props.onPress();
        if (openUrlCalls !== callsBefore + 1) {
          record('I7', `one tap → ${openUrlCalls - callsBefore} openURL calls`);
        }
        // A tap clears any previous error; only a rejection brings one back.
        model.errorOwner = action.outcome === 'fail' ? media.id : null;
        return;
      }
      case 'settle': {
        const entry = pending.shift();
        if (!entry) return;
        interactions += 1;
        if (action.how === 'ok') {
          entry.resolve();
        } else {
          entry.reject(new Error('late failure'));
          if (media && media.id === entry.mediaId)
            model.errorOwner = entry.mediaId;
        }
        return;
      }
      case 'swap': {
        const target = MEDIA[action.to] ?? youtubeA;
        if (!media) return;
        interactions += 1;
        api.current?.setMedia(target);
        const changed = media.id !== target.id;
        modelOpen(model, target);
        if (changed) expectedMounts += 1;
        return;
      }
      case 'reopen': {
        const target = MEDIA[action.to] ?? youtubeA;
        if (media) return;
        interactions += 1;
        api.current?.setMedia(target);
        modelOpen(model, target);
        expectedMounts += 1;
        return;
      }
      case 'batch':
        return;
    }
  };

  const flushMicrotasks = async () => {
    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
  };

  const run = async (action: Action) => {
    stepLabel = JSON.stringify(action);
    const stageAtStart = model.stage;
    const viewAtStart = webViews(renderer)[0] ?? null;
    await act(async () => {
      if (action.kind === 'batch') {
        for (const inner of action.actions) {
          fireOne(inner, stageAtStart, viewAtStart, true);
        }
      } else {
        fireOne(action, stageAtStart, viewAtStart, false);
      }
    });
    await flushMicrotasks();
    check();
  };

  try {
    check();
    for (const action of script) {
      step += 1;
      await run(action);
    }
    // Always finish the lifecycle: close (if open) and unmount.
    if (model.media) {
      step += 1;
      await run({ kind: 'tapClose', via: 'button', taps: 1 });
    }
    step += 1;
    stepLabel = 'unmount';
    await act(async () => {
      renderer.unmount();
    });
    if (watchdogs.size !== 0) {
      record('I6', `${watchdogs.size} watchdog timer(s) survive unmount`);
    }
    // Late settlements after unmount must be harmless.
    step += 1;
    stepLabel = 'settle-after-unmount';
    await act(async () => {
      for (const entry of pending.splice(0)) entry.reject(new Error('late'));
    });
    await flushMicrotasks();
  } catch (error) {
    record(
      'I8',
      `threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  } finally {
    await new Promise<void>(resolve => {
      jest
        .requireActual<typeof import('node:timers')>('node:timers')
        .setImmediate(resolve);
    });
    process.off('unhandledRejection', onUnhandled);
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    errorSpy.mockRestore();
    openUrl.mockRestore();
  }
  if (consoleErrors.length > 0) {
    record('I8', `console.error: ${consoleErrors.join(' || ').slice(0, 400)}`);
  }
  if (unhandled.length > 0) {
    record(
      'I7',
      `unhandled rejection(s): ${unhandled.join(' || ').slice(0, 200)}`,
    );
  }

  return {
    seed,
    initialMedia: initial.id,
    actions: script.length,
    interactions,
    violations,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    script,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const ITER = Number(process.env.STRESS_ITER ?? 40);
const BASE_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const ONLY = (process.env.STRESS_ONLY ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);

describe('DrillVideoPlayer — rapid/concurrent interaction campaign', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it(`holds its intent-level invariants across ${ONLY.length > 0 ? ONLY.length : ITER} seeded bursts`, async () => {
    const seeds =
      ONLY.length > 0
        ? ONLY
        : Array.from({ length: ITER }, (_, i) => BASE_SEED + i);
    const outcomes: Outcome[] = [];
    for (const seed of seeds) outcomes.push(await runIteration(seed));

    const broken = outcomes.filter(o => o.outcome === 'BROKEN');
    const table = {
      unit: 'cmp-players/DrillVideoPlayer',
      lens: 'rapid-interaction',
      baseSeed: BASE_SEED,
      iterations: outcomes.length,
      interactions: outcomes.reduce((n, o) => n + o.interactions, 0),
      held: outcomes.length - broken.length,
      broken: broken.length,
      // Classified by the FIRST violation: once the model and the
      // component disagree, later checks in that seed are cascade noise.
      brokenByFirstInvariant: broken.reduce<Record<string, number[]>>(
        (acc, o) => {
          const key = o.violations[0]?.invariant ?? '?';
          (acc[key] ??= []).push(o.seed);
          return acc;
        },
        {},
      ),
      results: outcomes.map(o => ({
        seed: o.seed,
        outcome: o.outcome,
        initialMedia: o.initialMedia,
        actions: o.actions,
        interactions: o.interactions,
        firstViolation: o.violations[0],
        violations: o.violations,
        script: o.outcome === 'BROKEN' ? o.script : undefined,
      })),
    };
    if (process.env.STRESS_OUT) {
      writeFileSync(process.env.STRESS_OUT, JSON.stringify(table, null, 2));
    }
    const summary = broken
      .slice(0, 12)
      .map(
        o =>
          `seed ${o.seed}: ${o.violations
            .map(
              v =>
                `[${v.invariant} @${v.step} ${v.action.slice(0, 90)}] ${v.detail}`,
            )
            .join('; ')}`,
      )
      .join('\n');
    expect(`${broken.length} broken\n${summary}`).toBe('0 broken\n');
  }, 600000);
});
