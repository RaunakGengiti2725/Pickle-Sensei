/**
 * DrillLibraryScreen — seeded BOUNDARY / I18N / A11Y stress campaign.
 *
 * The real screen renders inside a real `NavigationContainer` + native stack
 * (Tabs stub beneath it, ConnectAccount stub above it), the real
 * `useApiSessionStore`, the real `createTrainingApi` parser and the real
 * SQLite-backed focus computation (`@op-engineering/op-sqlite` is the only
 * native module replaced — by `node:sqlite`, plus `react-native-webview` as a
 * passthrough View). Only `fetch` is faked.
 *
 * Every seed derives one scenario (see test-support/stress/drillLibraryScenario.ts):
 * locale (12), font scale (3), viewport width (3), session/catalog outcome,
 * catalog payload with boundary titles (200+ chars, CJK, Arabic RTL, ZWJ
 * emoji, combining marks, bidi controls, German compounds, zero-width-only),
 * zero/negative/huge numerics, hosted-media expiry instants around DST edges
 * and UTC±14, local scored reads, and an interaction script (expand, save,
 * search, clear, family filter, open video, browse YouTube, back).
 *
 * Scale:   STRESS_ITER=<n>   seeds per process (default 40)
 *          STRESS_SEED=<n>   first seed (default 1)
 * Replay:  STRESS_ONLY=<seed>
 * Output:  STRESS_OUT=<dir>  seed → outcome JSON table + rendered-tree
 *                            evidence (default artifacts/stress)
 * Zones:   TZ=<zone> npx jest … (jest sandboxes process.env, so a zone is a
 *          process property; the campaign runner loops the 8 zones).
 *
 * Reproduced findings live in KNOWN_FINDINGS below as strict expected
 * failures: they never hide a new break, and they fail once fixed.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  Dimensions,
  I18nManager,
  Linking,
  PixelRatio,
  Text,
  View,
} from 'react-native';
import {
  createNavigationContainerRef,
  NavigationContainer,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import {
  buildScenario,
  catalogPayload,
  detailPayload,
  expectedPlayableMedia,
  expectedVisibleDrills,
  localShotPayload,
  FONT_SCALES,
  VIEWPORT_WIDTHS,
  type DrillSpec,
  type MutationOutcome,
  type Scenario,
} from '../../test-support/stress/drillLibraryScenario';
import {
  auditTree,
  evidenceTree,
  toHostTree,
  type TreeAudit,
} from '../../test-support/stress/renderedTreeAudit';
import { LOCALES } from '../../test-support/stress/boundaryCorpus';

// Node built-ins for the raw artifacts. The mobile tsconfig excludes node
// typings (see __tests__/matrix/networkAuthMatrix.test.ts), so the shims
// stay local.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

interface DatabaseSync {
  prepare(sql: string): {
    all(...params: (string | number | null)[]): unknown[];
  };
  close(): void;
}

// One fresh in-memory database per `open()`, so each scenario's local scored
// reads start from an empty store after the previous scenario closed its DB.
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const sqlite = require('node:sqlite') as {
      DatabaseSync: new (location: string) => DatabaseSync;
    };
    const real = new sqlite.DatabaseSync(':memory:');
    return {
      executeSync: (sql: string) => ({ rows: real.prepare(sql).all() }),
      execute: async (sql: string, params: unknown[] = []) => ({
        rows: real.prepare(sql).all(...(params as (string | number | null)[])),
      }),
      close: () => real.close(),
    };
  },
}));

jest.mock('react-native-webview', () => {
  const ReactModule = require('react') as typeof React;
  const RN = require('react-native') as { View: typeof View };
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(RN.View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { setActiveDataOwner } from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import {
  checkpointDisplayName,
  computeLibraryFocus,
} from '../../src/library/libraryFocus';
import type { RootStackParams } from '../../src/navigation/params';

const ITER = Number(process.env.STRESS_ITER ?? 40);
const SEED_BASE = Number(process.env.STRESS_SEED ?? 1);
const ONLY = process.env.STRESS_ONLY ?? null;
const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');
const ZONE = process.env.TZ ?? 'process-default';
const OWNER = '4f1c2a9e-1b2c-4d3e-8f4a-5b6c7d8e9f01';

const seeds: number[] = ONLY
  ? [Number(ONLY)]
  : Array.from({ length: ITER }, (_, index) => SEED_BASE + index);

if (seeds.some(seed => !Number.isSafeInteger(seed) || seed < 0)) {
  throw new Error(
    `STRESS_ITER/STRESS_SEED/STRESS_ONLY must be non-negative integers`,
  );
}

/**
 * Reproduced findings (see the campaign report). Each entry is an expected
 * failure in the strict sense: a seed that breaks ONLY these checks, with
 * notes matching `pattern`, still passes its own test, and a dedicated test
 * re-runs `seed` and fails as soon as the finding stops reproducing — so a
 * fix must delete the entry. Any other break fails the seed's test.
 */
interface KnownFinding {
  id: string;
  check: string;
  pattern: RegExp;
  seed: number;
}
const KNOWN_FINDINGS: readonly KnownFinding[] = [
  {
    id: 'F1 zero-width-only title yields subject-less a11y labels',
    check: 'interactive-has-label',
    pattern: /^(?:[^|]*label-missing-subject[^|]*(?:\||$))+$/,
    seed: 14,
  },
  {
    id: 'F2 non-positive / non-integer / huge mapping counts rendered verbatim',
    check: 'mapping-counts-positive',
    pattern: /rendered/,
    seed: 3,
  },
  {
    id: 'F3 whitespace-only search re-fetches the catalog',
    check: 'whitespace-query-is-noop',
    pattern: /fetches/,
    seed: 6,
  },
  {
    id: 'F4 out-of-range local scores rendered as "Recent average N out of 100"',
    check: 'focus-score-in-range',
    pattern: /out of 100/,
    seed: 29,
  },
];

function knownFindingFor(
  check: string,
  notes: readonly string[],
): KnownFinding | null {
  const known = KNOWN_FINDINGS.find(k => k.check === check);
  if (!known) return null;
  const note = notes.find(n => n.startsWith(`${check}:`));
  const body = note ? note.slice(check.length + 1).trim() : '';
  return known.pattern.test(body) ? known : null;
}

const Stack = createNativeStackNavigator<RootStackParams>();
const TabsStub = () => <Text>Tabs stub</Text>;
const ConnectAccountStub = () => <Text>Connect account stub</Text>;

type CheckState = 'held' | 'broken' | 'n/a';

interface ScenarioResult {
  seed: number;
  replay: string;
  zone: string;
  locale: string;
  rtl: boolean;
  fontScale: number;
  viewportWidthPt: number;
  session: string;
  catalog: string;
  drillCount: number;
  titleShapes: string[];
  detailOutcome: string;
  actions: Scenario['actions'];
  outcome: 'held' | 'broken';
  checks: Record<string, CheckState>;
  broken: string[];
  knownFindings: string[];
  notes: string[];
  consoleErrors: string[];
  a11y: {
    interactiveCount: number;
    issues: string[];
    truncationCandidates: {
      path: string;
      text: string;
      numberOfLines: number | null;
      estimatedWidthPt: number | null;
    }[];
  };
  requests: string[];
  durationMs: number;
}

type Renderer = TestRenderer.ReactTestRenderer;

async function settle(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {});
  }
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await settle(1);
}

function allText(renderer: Renderer): string[] {
  return renderer.root.findAllByType(Text).map(node =>
    React.Children.toArray(node.props.children)
      .map(child =>
        typeof child === 'string' || typeof child === 'number'
          ? String(child)
          : '',
      )
      .join(''),
  );
}

function hasText(renderer: Renderer, needle: string): boolean {
  return allText(renderer).some(text => text.includes(needle));
}

function findByLabel(renderer: Renderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  return node ?? null;
}

/** Host nodes only — composites (View/PressableScale wrappers) share props. */
function hostNodes(
  renderer: Renderer,
  predicate: (node: TestRenderer.ReactTestInstance) => boolean,
) {
  return renderer.root.findAll(n => typeof n.type === 'string' && predicate(n));
}

function hostByTestId(renderer: Renderer, testID: string) {
  return hostNodes(renderer, n => n.props.testID === testID);
}

function hostCards(renderer: Renderer) {
  return hostNodes(
    renderer,
    n =>
      typeof n.props.testID === 'string' &&
      n.props.testID.startsWith('drill-card-'),
  );
}

function findAllByLabel(renderer: Renderer, label: string) {
  return renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
}

function hostByLabel(renderer: Renderer, label: string) {
  return hostNodes(renderer, n => n.props.accessibilityLabel === label);
}

function press(node: TestRenderer.ReactTestInstance) {
  act(() => {
    node.props.onPress();
  });
}

function saveLabel(drill: DrillSpec, saved: boolean): string {
  return saved
    ? `Remove ${drill.title} from saved drills`
    : `Save ${drill.title}`;
}

function response(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

function mutationResponse(
  outcome: MutationOutcome,
  scenario: Scenario,
  method: string,
  slug: string,
): ReturnType<typeof response> {
  switch (outcome) {
    case 'ok':
      return method === 'PUT'
        ? response(200, { slug, saved: true })
        : response(204, null);
    case 'http500':
      return response(500, {
        error: { code: 'catalog.failed', message: scenario.serverErrorMessage },
      });
    case 'invalidShape':
      return method === 'PUT'
        ? response(200, { slug: 'other', saved: false })
        : response(200, {});
    case 'network':
      throw new TypeError('Network request failed');
  }
}

function expectedErrorMessage(
  outcome: MutationOutcome | 'http401',
  scenario: Scenario,
): string {
  switch (outcome) {
    case 'ok':
      return '';
    case 'http500':
      return scenario.serverErrorMessage;
    case 'http401':
      return 'Your sign-in expired. Sign in again to continue.';
    case 'network':
      return 'Training is temporarily offline. Your existing reads are still safe.';
    case 'invalidShape':
      return 'The training server returned an invalid response.';
  }
}

function mappingTargetLine(
  mapping: Scenario['detail']['mappings'][number],
): string {
  const sets =
    mapping.reps !== null
      ? `${mapping.targetSets} × ${mapping.reps}`
      : mapping.duration !== null
        ? `${mapping.targetSets} × ${mapping.duration}s`
        : `${mapping.targetSets} set${mapping.targetSets === 1 ? '' : 's'}`;
  const parts = [sets];
  if (mapping.rest !== null) parts.push(`rest ${mapping.rest}s`);
  return parts.join(' · ');
}

function countIsSane(value: number | null): boolean {
  return (
    value === null || (Number.isInteger(value) && value > 0 && value < 1e6)
  );
}

/** Facts exactly as `listScoredCheckpointFacts` reads them back. */
function expectedFocus(scenario: Scenario) {
  return computeLibraryFocus(
    scenario.localShots.map(shot => ({
      id: shot.id,
      shotType: shot.shotType,
      capturedAt: shot.capturedAt,
      checkpoints: shot.checkpoints.map(checkpoint => ({
        key: checkpoint.key,
        score:
          typeof checkpoint.score === 'number' &&
          Number.isFinite(checkpoint.score)
            ? checkpoint.score
            : null,
        applicable: checkpoint.applicable === true,
      })),
    })),
  );
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const started = Date.now();
  const checks: Record<string, CheckState> = {};
  const notes: string[] = [];
  const consoleErrors: string[] = [];
  const requests: string[] = [];
  const audits: TreeAudit[] = [];
  const truncation: ScenarioResult['a11y']['truncationCandidates'] = [];
  const check = (name: string, held: boolean, detail?: string) => {
    checks[name] = held ? 'held' : 'broken';
    if (!held && detail) notes.push(`${name}: ${detail}`);
  };
  const skip = (name: string) => {
    checks[name] = 'n/a';
  };

  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(arg => (arg instanceof Error ? arg.message : String(arg)))
          .join(' '),
      );
    });
  const fontSpy = jest
    .spyOn(PixelRatio, 'getFontScale')
    .mockReturnValue(scenario.fontScale);
  const openUrlSpy = jest
    .spyOn(Linking, 'openURL')
    .mockResolvedValue(undefined);
  const previousRtl = I18nManager.isRTL;
  (I18nManager as { isRTL: boolean }).isRTL = scenario.locale.rtl;
  const window = {
    width: scenario.viewportWidthPt,
    height: 844,
    scale: 3,
    fontScale: scenario.fontScale,
  };
  Dimensions.set({ window, screen: window });
  jest.setSystemTime(scenario.nowMs);

  if (scenario.session === 'configured') {
    establishApiSession({
      apiBaseUrl: 'https://api.stress.test',
      bearerToken: 'stress-bearer',
      canonicalAppUserId: OWNER,
      provider: 'apple',
    });
  } else if (scenario.session === 'blankToken') {
    establishApiSession({
      apiBaseUrl: 'https://api.stress.test',
      bearerToken: '   ',
      canonicalAppUserId: OWNER,
      provider: 'apple',
    });
  } else {
    clearApiSession();
  }
  setActiveDataOwner(OWNER);
  const db = getDb();
  for (const shot of scenario.localShots) {
    await db.execute(
      `INSERT OR REPLACE INTO local_shot
       (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
       VALUES (?, ?, NULL, ?, ?, 50, 0.9, 'scored', 'real', ?)`,
      [OWNER, shot.id, shot.shotType, shot.capturedAt, localShotPayload(shot)],
    );
  }

  const fetchMock = jest.fn(
    async (input: string, init?: { method?: string }) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${url.pathname}${url.search}`);
      const catalogMatch = url.pathname === '/v1/catalog/drills';
      const detailMatch = url.pathname.match(/^\/v1\/catalog\/drills\/(.+)$/);
      const savedMatch = url.pathname.match(/^\/v1\/me\/saved-drills\/(.+)$/);
      if (catalogMatch) {
        switch (scenario.catalog) {
          case 'http500':
            return response(500, {
              error: {
                code: 'catalog.down',
                message: scenario.serverErrorMessage,
              },
            });
          case 'http401':
            return response(401, {
              error: { code: 'unauthorized', message: 'nope' },
            });
          case 'network':
            throw new TypeError('Network request failed');
          case 'invalidShape':
            return response(200, catalogPayload(scenario));
          case 'ok': {
            const family = url.searchParams.get('family');
            const payload = catalogPayload(scenario) as {
              items: { families: string[] }[];
            };
            return response(200, {
              items: family
                ? payload.items.filter(item => item.families.includes(family))
                : payload.items,
            });
          }
        }
      }
      if (detailMatch) {
        const slug = decodeURIComponent(detailMatch[1] ?? '');
        const drill = scenario.drills.find(item => item.slug === slug);
        if (!drill)
          return response(404, {
            error: { code: 'not_found', message: 'unknown slug' },
          });
        switch (scenario.detail.outcome) {
          case 'http500':
            return response(500, {
              error: {
                code: 'detail.down',
                message: scenario.serverErrorMessage,
              },
            });
          case 'network':
            throw new TypeError('Network request failed');
          default:
            return response(200, detailPayload(scenario, drill));
        }
      }
      if (savedMatch) {
        const slug = decodeURIComponent(savedMatch[1] ?? '');
        const outcome = scenario.actions.save?.outcome ?? 'ok';
        return mutationResponse(outcome, scenario, method, slug);
      }
      return response(404, {
        error: { code: 'not_found', message: url.pathname },
      });
    },
  );
  const previousFetch = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch: unknown }).fetch = fetchMock;

  const navRef = createNavigationContainerRef<RootStackParams>();
  let renderer: Renderer | null = null;
  let threw: string | null = null;

  const audit = (label: string) => {
    if (!renderer) return;
    const tree = toHostTree(renderer);
    const result = auditTree(tree, {
      fontScale: scenario.fontScale,
      viewportWidthPt: scenario.viewportWidthPt,
      horizontalInsetPt: 48 + 32,
      script: scenario.locale.width,
    });
    audits.push(result);
    for (const text of result.texts) {
      if (text.truncationCandidate) {
        truncation.push({
          path: `${label}:${text.path}`,
          text: text.text.slice(0, 40),
          numberOfLines: text.numberOfLines,
          estimatedWidthPt:
            text.estimatedWidthPt === null
              ? null
              : Math.round(text.estimatedWidthPt),
        });
      }
    }
  };

  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <NavigationContainer
          ref={navRef}
          initialState={{
            routes: [{ name: 'Tabs' }, { name: 'DrillLibrary' }],
          }}
        >
          <Stack.Navigator>
            <Stack.Screen name="Tabs" component={TabsStub} />
            <Stack.Screen name="DrillLibrary" component={DrillLibraryScreen} />
            <Stack.Screen
              name="ConnectAccount"
              component={ConnectAccountStub}
            />
          </Stack.Navigator>
        </NavigationContainer>,
      );
    });
    if (!renderer) throw new Error('renderer missing');
    const r: Renderer = renderer;
    await settle(4);
    check('render-no-throw', true);
    check(
      'route-is-drill-library',
      navRef.getCurrentRoute()?.name === 'DrillLibrary',
    );

    // ---- Phase A: initial state -------------------------------------------------
    if (scenario.session !== 'configured') {
      const connect = findByLabel(r, 'Connect account');
      check(
        'unconfigured-state',
        connect !== null &&
          hasText(r, 'The drill catalog needs a synced account.'),
      );
      check(
        'unconfigured-no-fetch',
        fetchMock.mock.calls.length === 0,
        `${fetchMock.mock.calls.length} fetches`,
      );
      audit('unconfigured');
      if (connect) {
        press(connect);
        await settle(3);
        check(
          'connect-account-navigates',
          navRef.getCurrentRoute()?.name === 'ConnectAccount',
          navRef.getCurrentRoute()?.name,
        );
      }
    } else if (scenario.catalog !== 'ok') {
      const retry = findByLabel(r, 'Try again');
      const expected = expectedErrorMessage(scenario.catalog, scenario);
      check(
        'error-state-present',
        retry !== null && hasText(r, 'The drill catalog could not load.'),
      );
      check(
        'error-state-message-verbatim',
        hasText(r, expected),
        expected.slice(0, 60),
      );
      audit('error-state');
      if (retry) {
        const before = fetchMock.mock.calls.length;
        press(retry);
        await settle(3);
        check(
          'error-retry-refetches',
          fetchMock.mock.calls.length === before + 1,
        );
      }
    } else if (scenario.drills.length === 0) {
      check('empty-catalog-state', hasText(r, 'No drills published yet'));
      check(
        'empty-catalog-no-focus-hint',
        hostByTestId(r, 'library-focus-hint').length === 0,
      );
      audit('empty');
    } else {
      const texts = allText(r);
      const verbatim = scenario.drills.every(
        drill =>
          texts.some(t => t.includes(drill.title)) &&
          texts.some(t => t.includes(drill.description)),
      );
      check('strings-verbatim', verbatim);
      check(
        'draft-byline-hidden',
        !texts.some(t => /engineering draft/i.test(t)),
      );
      check(
        'coach-name-verbatim',
        scenario.drills
          .filter(d => !d.draftByline)
          .every(d => texts.some(t => t === d.coachName)),
      );
      const cards = hostCards(r);
      check(
        'all-cards-rendered',
        cards.length === scenario.drills.length,
        `${cards.length}/${scenario.drills.length}`,
      );
      check(
        'save-label-reflects-state',
        scenario.drills.every(drill => {
          const node = findByLabel(r, saveLabel(drill, drill.saved));
          return (
            node !== null &&
            node.props.accessibilityState?.selected === drill.saved
          );
        }),
      );
      const focus = expectedFocus(scenario);
      if (focus) {
        const card = hostByTestId(r, 'library-focus');
        const scoreShown = hasText(r, String(focus.averageScore));
        check(
          'focus-card-present',
          card.length > 0 &&
            hasText(r, checkpointDisplayName(focus.checkpoint)) &&
            scoreShown,
        );
        check(
          'focus-score-in-range',
          focus.averageScore >= 0 && focus.averageScore <= 100,
          `rendered "${focus.averageScore}" with label "Recent average ${focus.averageScore} out of 100"`,
        );
        check(
          'focus-bar-label-matches-score',
          hostByLabel(r, `Recent average ${focus.averageScore} out of 100`)
            .length === 1,
        );
      } else {
        check(
          'focus-hint-when-no-evidence',
          hostByTestId(r, 'library-focus-hint').length === 1,
        );
        skip('focus-score-in-range');
      }
      audit('loaded');

      // ---- Phase B: expand + detail --------------------------------------------
      const expandIndex = scenario.actions.expandIndex;
      const target =
        expandIndex === null ? null : (scenario.drills[expandIndex] ?? null);
      if (target) {
        const expand = findByLabel(r, `Show detail for ${target.title}`);
        check('expand-control-labeled', expand !== null);
        if (expand) {
          press(expand);
          await settle(3);
          await advance(250);
          const hide = findByLabel(r, `Hide detail for ${target.title}`);
          check(
            'expand-state-announced',
            hide !== null && hide.props.accessibilityState?.expanded === true,
          );
          if (scenario.detail.outcome === 'ok') {
            const detailTexts = allText(r);
            check(
              'mapping-cues-verbatim',
              scenario.detail.mappings.every(m =>
                detailTexts.some(t => t.includes(m.cueText)),
              ),
            );
            check(
              'mapping-target-line-verbatim',
              scenario.detail.mappings.every(m =>
                detailTexts.some(t => t.includes(mappingTargetLine(m))),
              ),
            );
            // Only the numbers the target line actually prints: reps wins over
            // duration, and rest is appended when present.
            const insane = scenario.detail.mappings.filter(
              m =>
                !countIsSane(m.targetSets) ||
                (m.reps !== null
                  ? !countIsSane(m.reps)
                  : !countIsSane(m.duration)) ||
                !countIsSane(m.rest),
            );
            if (insane.length > 0) {
              check(
                'mapping-counts-positive',
                false,
                insane
                  .map(m => `rendered "${mappingTargetLine(m)}"`)
                  .join('; '),
              );
            } else {
              check('mapping-counts-positive', true);
            }
            const playable = expectedPlayableMedia(scenario);
            const watchRows = findAllByLabel(
              r,
              `Watch demonstration for ${target.title}`,
            );
            const watchHosts = hostByLabel(
              r,
              `Watch demonstration for ${target.title}`,
            );
            check(
              'media-expiry-instant',
              watchHosts.length === playable.length,
              `${watchHosts.length} rows for ${playable.length} playable (zone ${ZONE}, now ${new Date(scenario.nowMs).toISOString()})`,
            );
            check(
              'media-attribution-verbatim',
              playable.every(
                m =>
                  detailTexts.some(t => t === m.attribution) &&
                  detailTexts.some(t => t === m.creatorName),
              ),
            );
            const browse = findByLabel(
              r,
              `Browse YouTube videos for ${target.title}`,
            );
            check('browse-row-labeled', browse !== null);
            audit('expanded');
            if (scenario.actions.openMediaIndex !== null && watchRows[0]) {
              press(watchRows[0]);
              await settle(3);
              const close = findByLabel(r, 'Close video player');
              check('video-player-close-labeled', close !== null);
              audit('player');
              if (close) {
                press(close);
                await settle(2);
                check(
                  'video-player-closes',
                  findByLabel(r, 'Close video player') === null,
                );
              }
            }
            if (scenario.actions.browseVideos && browse) {
              press(browse);
              await settle(2);
              const url = String(openUrlSpy.mock.calls.at(-1)?.[0] ?? '');
              const q = new URL(url).searchParams.get('search_query');
              check(
                'youtube-url-roundtrip',
                q === `${target.title} pickleball drill`,
                url.slice(0, 120),
              );
            }
          } else {
            const retry = findByLabel(r, `Retry detail for ${target.title}`);
            const expected = expectedErrorMessage(
              scenario.detail.outcome,
              scenario,
            );
            check('detail-error-retry-labeled', retry !== null);
            check(
              'detail-error-message-verbatim',
              hasText(r, expected),
              expected.slice(0, 60),
            );
            audit('detail-error');
            if (retry) {
              const before = fetchMock.mock.calls.length;
              press(retry);
              await settle(3);
              check(
                'detail-retry-refetches',
                fetchMock.mock.calls.length === before + 1,
              );
            }
          }
        }
      }

      // ---- Phase C: save toggle -------------------------------------------------
      const save = scenario.actions.save;
      const saveTarget = save ? (scenario.drills[save.index] ?? null) : null;
      if (save && saveTarget) {
        const toggle = findByLabel(r, saveLabel(saveTarget, saveTarget.saved));
        check('save-control-present', toggle !== null);
        if (toggle) {
          press(toggle);
          await settle(4);
          const unsaveAlwaysSucceeds =
            saveTarget.saved && save.outcome === 'invalidShape';
          const succeeded = save.outcome === 'ok' || unsaveAlwaysSucceeds;
          const finalSaved = succeeded ? !saveTarget.saved : saveTarget.saved;
          const after = findByLabel(r, saveLabel(saveTarget, finalSaved));
          check(
            'save-optimistic-rollback',
            after !== null &&
              after.props.accessibilityState?.selected === finalSaved &&
              after.props.disabled !== true,
            `expected saved=${finalSaved} after ${save.outcome}`,
          );
          if (succeeded) {
            check(
              'save-toast-announced',
              hasText(
                r,
                finalSaved
                  ? 'Saved to your library'
                  : 'Removed from saved drills',
              ),
            );
            const toast = r.root.findAll(
              n =>
                n.props.accessibilityLiveRegion === 'polite' &&
                n.props.pointerEvents === 'none',
            );
            check('toast-does-not-capture-touch', toast.length >= 1);
            await advance(2600);
            check(
              'save-toast-dismisses',
              !hasText(r, 'Saved to your library') &&
                !hasText(r, 'Removed from saved drills'),
            );
          } else {
            const expected = expectedErrorMessage(save.outcome, scenario);
            check(
              'inline-error-verbatim',
              hasText(r, expected),
              expected.slice(0, 60),
            );
            const dismiss = findByLabel(r, 'Dismiss error');
            check('inline-error-dismiss-labeled', dismiss !== null);
            audit('inline-error');
            if (dismiss) {
              press(dismiss);
              await settle(1);
              check(
                'inline-error-dismisses',
                hostByTestId(r, 'drill-library-inline-error').length === 0,
              );
            }
          }
        }
      }

      // ---- Phase D: search ------------------------------------------------------
      const query = scenario.actions.query;
      if (query) {
        const [input] = r.root.findAll(
          n => n.props.testID === 'drill-search-input',
        );
        check('search-input-present', input !== undefined);
        if (input) {
          const before = fetchMock.mock.calls.length;
          act(() => {
            input.props.onChangeText(query.text);
          });
          await advance(300);
          await settle(3);
          const trimmed = query.text.trim();
          const drillsAfterSave = scenario.drills.map(d =>
            save && saveTarget && d.slug === saveTarget.slug
              ? {
                  ...d,
                  saved:
                    save.outcome === 'ok' ||
                    (saveTarget.saved && save.outcome === 'invalidShape')
                      ? !d.saved
                      : d.saved,
                }
              : d,
          );
          const visible = expectedVisibleDrills(
            { ...scenario, drills: drillsAfterSave },
            query.text,
            null,
          );
          if (trimmed.length > 0) {
            const countLine = `${visible.length} of ${scenario.drills.length} drill${scenario.drills.length === 1 ? '' : 's'}`;
            check('search-result-count-line', hasText(r, countLine), countLine);
            const lastRequest = requests.at(-1) ?? '';
            const sent = new URL(
              `https://x${lastRequest.split(' ')[1] ?? ''}`,
            ).searchParams.get('q');
            check(
              'query-encoded-in-request',
              fetchMock.mock.calls.length === before + 1 && sent === trimmed,
              `sent ${JSON.stringify(sent)}`,
            );
            check(
              'search-youtube-row-labeled',
              findByLabel(
                r,
                `Search YouTube: "${trimmed}" pickleball drills`,
              ) !== null,
            );
            const searchedCards = hostCards(r);
            check(
              'search-filters-client-side',
              searchedCards.length === visible.length,
              `${searchedCards.length} cards for ${visible.length} expected`,
            );
            if (visible.length === 0)
              check('search-no-match-state', hasText(r, 'No drills match'));
            const clear = findByLabel(r, 'Clear search');
            check('clear-search-labeled', clear !== null);
            audit('searched');
            if (scenario.actions.clearQuery && clear) {
              press(clear);
              await advance(300);
              await settle(2);
              check(
                'clear-search-restores',
                !hasText(r, countLine) &&
                  findByLabel(r, 'Clear search') === null,
              );
            }
          } else {
            check(
              'whitespace-query-is-noop',
              fetchMock.mock.calls.length === before && !hasText(r, ' of '),
              `${fetchMock.mock.calls.length - before} fetches`,
            );
          }
        }
      }

      // ---- Phase E: family filter -----------------------------------------------
      const family = scenario.actions.familyFilter;
      if (family) {
        const chip = findByLabel(
          r,
          `Filter ${family.replace(/_/g, ' ')} drills`,
        );
        check('family-chip-labeled', chip !== null);
        if (chip) {
          press(chip);
          await settle(4);
          const selected = hostNodes(
            r,
            n =>
              typeof n.props.accessibilityLabel === 'string' &&
              (n.props.accessibilityLabel.startsWith('Filter ') ||
                n.props.accessibilityLabel === 'Show all drill families') &&
              n.props.accessibilityState?.selected === true,
          );
          check(
            'family-chip-selected-state',
            selected.length === 1 &&
              selected[0]?.props.accessibilityLabel ===
                `Filter ${family.replace(/_/g, ' ')} drills`,
          );
          const lastRequest = requests.at(-1) ?? '';
          check(
            'family-sent-to-server',
            lastRequest.includes(`family=${encodeURIComponent(family)}`),
            lastRequest,
          );
          const activeQuery =
            query && !scenario.actions.clearQuery ? query.text : null;
          const expected = expectedVisibleDrills(scenario, activeQuery, family);
          const filteredCards = hostCards(r);
          check(
            'family-filter-results',
            filteredCards.length === expected.length,
            `${filteredCards.length} cards for ${expected.length}`,
          );
          audit('filtered');
        }
      }
    }

    // ---- Phase F: back -----------------------------------------------------------
    if (
      scenario.actions.pressBack &&
      navRef.getCurrentRoute()?.name === 'DrillLibrary'
    ) {
      const back = findByLabel(r, 'Back');
      check('back-control-labeled', back !== null);
      if (back) {
        press(back);
        await settle(3);
        const routeName: string | undefined = navRef.getCurrentRoute()?.name;
        check('back-navigates', routeName === 'Tabs', routeName);
      }
    }
  } catch (error) {
    threw =
      error instanceof Error
        ? `${error.message}\n${error.stack ?? ''}`
        : String(error);
    check('render-no-throw', false, threw.split('\n')[0]);
  } finally {
    try {
      if (renderer) {
        act(() => {
          (renderer as Renderer).unmount();
        });
      }
    } catch (error) {
      notes.push(
        `unmount: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    db.close();
    clearApiSession();
    (globalThis as { fetch?: unknown }).fetch = previousFetch;
    (I18nManager as { isRTL: boolean }).isRTL = previousRtl;
    fontSpy.mockRestore();
    openUrlSpy.mockRestore();
    errorSpy.mockRestore();
  }

  // ---- Rendered-tree audit rollup ------------------------------------------------
  const a11yIssues = Array.from(new Set(audits.flatMap(a => a.issues)));
  const interactive = audits.flatMap(a => a.interactive);
  check(
    'interactive-has-role',
    !a11yIssues.some(i => i.includes('missing-role')),
    a11yIssues.filter(i => i.includes('missing-role')).join(' | '),
  );
  check(
    'interactive-has-label',
    !a11yIssues.some(i =>
      /missing-label|label-invisible-only|label-missing-subject/.test(i),
    ),
    a11yIssues.filter(i => /label/.test(i)).join(' | '),
  );
  check(
    'interactive-target-44pt',
    !a11yIssues.some(i => i.includes('target-')),
    a11yIssues.filter(i => i.includes('target-')).join(' | '),
  );
  check(
    'text-keeps-font-scaling',
    !a11yIssues.some(i => i.includes('allowFontScaling')),
  );
  const overlapping = audits.flatMap(a =>
    a.absolute.filter(
      node =>
        !node.path.includes('RNSScreen') &&
        !node.pointerEventsNone &&
        node.containsInteractive,
    ),
  );
  check(
    'absolute-overlays-are-inert',
    overlapping.length === 0,
    overlapping.map(o => o.path).join(' | '),
  );
  check(
    'no-console-error',
    consoleErrors.length === 0,
    consoleErrors[0]?.slice(0, 200),
  );

  const broken = Object.entries(checks)
    .filter(([, state]) => state === 'broken')
    .map(([name]) => name);
  return {
    seed: scenario.seed,
    replay: `cd apps/mobile && TZ=${ZONE} STRESS_ONLY=${scenario.seed} npx jest --ci __tests__/stress/drillLibraryScreen.boundaryI18nA11y.stress.test.tsx`,
    zone: ZONE,
    locale: scenario.locale.tag,
    rtl: scenario.locale.rtl,
    fontScale: scenario.fontScale,
    viewportWidthPt: scenario.viewportWidthPt,
    session: scenario.session,
    catalog: scenario.catalog,
    drillCount: scenario.drills.length,
    titleShapes: scenario.drills.map(d => d.titleShape),
    detailOutcome: scenario.detail.outcome,
    actions: scenario.actions,
    outcome: broken.length === 0 ? 'held' : 'broken',
    checks,
    broken,
    knownFindings: broken
      .map(check => knownFindingFor(check, notes)?.id ?? null)
      .filter((id): id is string => id !== null),
    notes,
    consoleErrors,
    a11y: {
      interactiveCount: interactive.length,
      issues: a11yIssues,
      truncationCandidates: truncation,
    },
    requests,
    durationMs: Date.now() - started,
  };
}

/* ------------------------------------------------------------------------------ */

const results: ScenarioResult[] = [];
const evidence: Record<string, unknown> = {};

describe('DrillLibraryScreen boundary/i18n/a11y stress campaign', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    mkdirSync(OUT_DIR, { recursive: true });
    const stamp = `${ZONE.replace(/[^A-Za-z0-9+-]/g, '_')}-${SEED_BASE}-${seeds.length}`;
    writeFileSync(
      join(OUT_DIR, `drillLibrary-boundary-i18n-a11y-${stamp}.json`),
      JSON.stringify(
        {
          unit: 'scr-drilllibraryscreen',
          lens: 'boundary-i18n-a11y',
          zone: ZONE,
          seeds: { base: SEED_BASE, count: seeds.length },
          executed: results.length,
          held: results.filter(r => r.outcome === 'held').length,
          broken: results
            .filter(r => r.outcome === 'broken')
            .map(r => ({
              seed: r.seed,
              broken: r.broken,
              knownFindings: r.knownFindings,
              notes: r.notes,
              replay: r.replay,
            })),
          knownFindingTotals: KNOWN_FINDINGS.map(k => ({
            id: k.id,
            seeds: results
              .filter(r => r.knownFindings.includes(k.id))
              .map(r => r.seed),
          })),
          coverage: {
            locales: Array.from(new Set(results.map(r => r.locale))).sort(),
            fontScales: Array.from(
              new Set(results.map(r => r.fontScale)),
            ).sort(),
            viewportWidths: Array.from(
              new Set(results.map(r => r.viewportWidthPt)),
            ).sort(),
            titleShapes: Array.from(
              new Set(results.flatMap(r => r.titleShapes)),
            ).sort(),
            sessions: Array.from(new Set(results.map(r => r.session))).sort(),
            catalogOutcomes: Array.from(
              new Set(results.map(r => r.catalog)),
            ).sort(),
          },
          checkTotals: results.reduce<
            Record<string, { held: number; broken: number }>
          >((acc, r) => {
            for (const [name, state] of Object.entries(r.checks)) {
              if (state === 'n/a') continue;
              const entry = acc[name] ?? { held: 0, broken: 0 };
              entry[state] += 1;
              acc[name] = entry;
            }
            return acc;
          }, {}),
          results,
        },
        null,
        1,
      ),
    );
    writeFileSync(
      join(OUT_DIR, `drillLibrary-rendered-trees-${stamp}.json`),
      JSON.stringify(evidence, null, 1),
    );
  });

  test('scenario generation is a pure function of the seed', () => {
    for (const seed of seeds.slice(0, 5)) {
      expect(buildScenario(seed)).toEqual(buildScenario(seed));
    }
  });

  test('the seed range covers every locale, font scale and viewport width it can', () => {
    // Locale/scale/width are stratified over the seed (12 × 3 × 3 = 108
    // consecutive seeds cover the full matrix), so coverage is a property of
    // the range length, not of luck.
    const scenarios = seeds.map(buildScenario);
    const missing: string[] = [];
    if (seeds.length >= LOCALES.length) {
      for (const locale of LOCALES) {
        if (!scenarios.some(s => s.locale.tag === locale.tag))
          missing.push(locale.tag);
      }
    }
    if (seeds.length >= LOCALES.length * FONT_SCALES.length) {
      for (const scale of FONT_SCALES) {
        if (!scenarios.some(s => s.fontScale === scale))
          missing.push(`fontScale ${scale}`);
      }
    }
    if (
      seeds.length >=
      LOCALES.length * FONT_SCALES.length * VIEWPORT_WIDTHS.length
    ) {
      for (const width of VIEWPORT_WIDTHS) {
        if (!scenarios.some(s => s.viewportWidthPt === width))
          missing.push(`width ${width}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test.each(seeds)(
    'seed %d holds every boundary/i18n/a11y invariant',
    async seed => {
      const scenario = buildScenario(seed);
      const result = await runScenario(scenario);
      results.push(result);
      if (result.outcome === 'broken' || results.length <= 2) {
        // Rendered-tree evidence: broken seeds always, plus the first two held
        // seeds so the artifact shows what a healthy tree looks like.
        evidence[`seed-${seed}`] = await captureTree(scenario);
      }
      const unexpected = result.broken.filter(
        check => knownFindingFor(check, result.notes) === null,
      );
      expect({
        seed,
        broken: unexpected,
        notes: result.notes.filter(n =>
          unexpected.some(check => n.startsWith(`${check}:`)),
        ),
        knownFindings: result.knownFindings,
        replay: result.replay,
      }).toEqual({
        seed,
        broken: [],
        notes: [],
        knownFindings: result.knownFindings,
        replay: result.replay,
      });
    },
  );

  test.each(KNOWN_FINDINGS.map(k => [k.id, k] as const))(
    'known finding still reproduces: %s (delete its KNOWN_FINDINGS entry once fixed)',
    async (_id, known) => {
      const observed =
        results.find(
          r =>
            r.seed === known.seed &&
            knownFindingFor(known.check, r.notes)?.id === known.id,
        ) ?? (await runScenario(buildScenario(known.seed)));
      expect({
        seed: known.seed,
        check: known.check,
        reproduced: knownFindingFor(known.check, observed.notes)?.id ?? null,
      }).toEqual({
        seed: known.seed,
        check: known.check,
        reproduced: known.id,
      });
    },
  );
});

/** Re-renders the scenario's initial state and returns its host tree. */
async function captureTree(scenario: Scenario): Promise<unknown> {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const fontSpy = jest
    .spyOn(PixelRatio, 'getFontScale')
    .mockReturnValue(scenario.fontScale);
  jest.setSystemTime(scenario.nowMs);
  if (scenario.session === 'configured') {
    establishApiSession({
      apiBaseUrl: 'https://api.stress.test',
      bearerToken: 'stress-bearer',
      canonicalAppUserId: OWNER,
      provider: 'apple',
    });
  } else {
    clearApiSession();
  }
  setActiveDataOwner(OWNER);
  const db = getDb();
  for (const shot of scenario.localShots) {
    await db.execute(
      `INSERT OR REPLACE INTO local_shot
       (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
       VALUES (?, ?, NULL, ?, ?, 50, 0.9, 'scored', 'real', ?)`,
      [OWNER, shot.id, shot.shotType, shot.capturedAt, localShotPayload(shot)],
    );
  }
  const previousFetch = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/v1/catalog/drills') {
      if (scenario.catalog === 'http500') {
        return response(500, {
          error: { code: 'catalog.down', message: scenario.serverErrorMessage },
        });
      }
      if (scenario.catalog === 'http401') return response(401, {});
      if (scenario.catalog === 'network')
        throw new TypeError('Network request failed');
      return response(200, catalogPayload(scenario));
    }
    const drill = scenario.drills[0];
    return drill
      ? response(200, detailPayload(scenario, drill))
      : response(404, {});
  });
  let renderer: Renderer | null = null;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <NavigationContainer
          initialState={{
            routes: [{ name: 'Tabs' }, { name: 'DrillLibrary' }],
          }}
        >
          <Stack.Navigator>
            <Stack.Screen name="Tabs" component={TabsStub} />
            <Stack.Screen name="DrillLibrary" component={DrillLibraryScreen} />
            <Stack.Screen
              name="ConnectAccount"
              component={ConnectAccountStub}
            />
          </Stack.Navigator>
        </NavigationContainer>,
      );
    });
    await settle(4);
    const r = renderer as Renderer | null;
    if (!r) return null;
    const expandTarget =
      scenario.actions.expandIndex === null
        ? null
        : (scenario.drills[scenario.actions.expandIndex] ?? null);
    if (expandTarget) {
      const expand = findByLabel(r, `Show detail for ${expandTarget.title}`);
      if (expand) {
        press(expand);
        await settle(3);
        await advance(250);
      }
    }
    return {
      scenario: {
        seed: scenario.seed,
        locale: scenario.locale.tag,
        fontScale: scenario.fontScale,
        viewportWidthPt: scenario.viewportWidthPt,
        session: scenario.session,
        catalog: scenario.catalog,
        drills: scenario.drills.map(d => ({
          slug: d.slug,
          titleShape: d.titleShape,
          title: d.title.slice(0, 80),
        })),
        mappings: scenario.detail.mappings,
        media: scenario.detail.media.map(m => ({
          kind: m.kind,
          expiresAt: m.expiry.expiresAt,
          relation: m.relation,
        })),
        nowMs: scenario.nowMs,
      },
      tree: evidenceTree(toHostTree(r)),
    };
  } finally {
    if (renderer) {
      act(() => {
        (renderer as Renderer).unmount();
      });
    }
    db.close();
    clearApiSession();
    (globalThis as { fetch?: unknown }).fetch = previousFetch;
    fontSpy.mockRestore();
    jest.restoreAllMocks();
  }
}
