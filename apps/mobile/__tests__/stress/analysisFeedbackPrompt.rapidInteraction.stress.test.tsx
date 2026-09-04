import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AnalysisFeedbackPrompt } from '../../src/components/AnalysisFeedbackPrompt';
import { ApiError } from '../../src/data/api';
import {
  NoiseRecorder,
  SeededRng,
  campaignConfig,
  describe as describeValue,
  flushMicrotasks,
  iterationSeeds,
  summarise,
  writeTable,
  type ScenarioOutcome,
} from '../../test-support/stress/rapidInteraction';

/**
 * STRESS LENS `rapid-interaction` — AnalysisFeedbackPrompt.
 *
 * The prompt is the only member of the unit with a side effect (one POST per
 * feedback intent). A seeded generator scripts bursts of double/triple taps
 * (same tick and across ticks), taps while a request is in flight, taps on
 * the category sheet, retry spam, sign-out mid-request, unmount mid-request
 * (back during async) and remount (navigate away and back). For every seed
 * the harness asserts:
 *
 *   F1 single-request-per-intent   never more than one request in flight
 *                                  for one mount (taps across ticks — the
 *                                  re-render between discrete presses is
 *                                  what removes the button)
 *   F1b same-tick-dedup            the same, for a burst delivered in ONE
 *                                  tick (before React commits 'sending').
 *                                  Reported separately: the component has
 *                                  no in-flight guard, so this one is
 *                                  pinned below with test.failing.
 *   F2 no-orphan-sending           once every request settled, never 'sending'
 *   F3 accepted-stays-done         a server-accepted (2xx/409) submission is
 *                                  never later shown as failed or re-asked
 *   F4 payload-faithful            each request carries the analysisId and
 *                                  bearer of the render it was tapped on
 *   F5 single-surface              exactly one of ask/categories/sending/
 *                                  done/failed is rendered at any time
 *   F6 quiet                       no console.error/warn (act() warnings,
 *                                  setState-after-unmount) and no unhandled
 *                                  rejections
 *   F7 remount-fresh               a fresh mount starts at 'ask'
 *
 * Replays: STRESS_SEEDS=<seed[,seed]> STRESS_ITER=<n> STRESS_OUT=<json path>.
 */

jest.mock('../../src/data/api', () => {
  const actual = jest.requireActual('../../src/data/api');
  return { ...actual, submitAnalysisFeedback: jest.fn() };
});

const sessionState: {
  current: { apiBaseUrl: string; bearerToken: string } | null;
  /** What the component saw on its most recent render. */
  lastRendered: { apiBaseUrl: string; bearerToken: string } | null;
} = { current: null, lastRendered: null };

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => {
    sessionState.lastRendered = sessionState.current;
    return sessionState.current;
  },
}));

const { submitAnalysisFeedback } = jest.requireMock('../../src/data/api') as {
  submitAnalysisFeedback: jest.Mock;
};

type Settle = 'ok' | 'duplicate' | 'network' | 'server' | 'plain';

interface PendingRequest {
  index: number;
  generation: number;
  analysisId: string;
  token: string;
  rating: 'accurate' | 'not_quite';
  category: string | null;
  resolve: () => void;
  reject: (error: unknown) => void;
  settled: Settle | null;
  /** Fired from a same-tick burst (the second+ press of a multi-press). */
  burst: boolean;
}

type Target =
  | 'feedback-yes'
  | 'feedback-not-quite'
  | 'feedback-category'
  | 'feedback-retry';

type Op =
  | {
      kind: 'tap';
      target: Target;
      categoryIndex: number;
      times: number;
      sameTick: boolean;
    }
  | { kind: 'settle'; which: 'oldest' | 'newest' | 'all'; outcome: Settle }
  | { kind: 'flush' }
  | { kind: 'signOut' }
  | { kind: 'signIn'; token: string }
  | { kind: 'unmount' }
  | { kind: 'remount'; analysisId: string };

const SURFACES = [
  'feedback-ask',
  'feedback-categories',
  'feedback-sending',
  'feedback-thanks',
  'feedback-failed',
] as const;
type Surface = (typeof SURFACES)[number];

const ANALYSIS_IDS = ['a-100', 'a-200', 'a-300'] as const;
const TOKENS = ['tok-alpha', 'tok-beta', 'tok-gamma'] as const;

function generateScript(rng: SeededRng): Op[] {
  const length = rng.int(6, 24);
  const ops: Op[] = [];
  for (let i = 0; i < length; i += 1) {
    const kind = rng.weighted({
      tap: 46,
      settle: 22,
      flush: 10,
      signOut: 4,
      signIn: 4,
      unmount: 6,
      remount: 8,
    });
    switch (kind) {
      case 'tap':
        ops.push({
          kind: 'tap',
          target: rng.weighted<Target>({
            'feedback-yes': 30,
            'feedback-not-quite': 25,
            'feedback-category': 30,
            'feedback-retry': 15,
          }),
          categoryIndex: rng.int(0, 5),
          times: Number(rng.weighted({ '1': 40, '2': 35, '3': 25 })),
          sameTick: rng.chance(0.5),
        });
        break;
      case 'settle':
        ops.push({
          kind: 'settle',
          which: rng.weighted({ oldest: 45, newest: 30, all: 25 }),
          outcome: rng.weighted<Settle>({
            ok: 40,
            duplicate: 15,
            network: 20,
            server: 15,
            plain: 10,
          }),
        });
        break;
      case 'flush':
        ops.push({ kind: 'flush' });
        break;
      case 'signOut':
        ops.push({ kind: 'signOut' });
        break;
      case 'signIn':
        ops.push({ kind: 'signIn', token: rng.pick(TOKENS) });
        break;
      case 'unmount':
        ops.push({ kind: 'unmount' });
        break;
      case 'remount':
        ops.push({ kind: 'remount', analysisId: rng.pick(ANALYSIS_IDS) });
        break;
    }
  }
  return ops;
}

function opLabel(op: Op): string {
  switch (op.kind) {
    case 'tap':
      return `tap(${op.target}${
        op.target === 'feedback-category' ? `#${op.categoryIndex}` : ''
      } x${op.times} ${op.sameTick ? 'same-tick' : 'across-ticks'})`;
    case 'settle':
      return `settle(${op.which} → ${op.outcome})`;
    case 'signIn':
      return `signIn(${op.token})`;
    case 'remount':
      return `remount(${op.analysisId})`;
    default:
      return op.kind;
  }
}

function surfacesOf(renderer: ReactTestRenderer | null): Surface[] {
  if (!renderer) return [];
  const json = renderer.toJSON();
  if (!json) return [];
  const found = new Set<Surface>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const element = node as {
      props?: { testID?: string };
      children?: unknown[] | null;
    };
    const id = element.props?.testID;
    if (id && (SURFACES as readonly string[]).includes(id)) {
      found.add(id as Surface);
    }
    element.children?.forEach(walk);
  };
  walk(json);
  return [...found];
}

function pressHandlers(
  renderer: ReactTestRenderer | null,
  target: Target,
  categoryIndex: number,
): Array<() => void> {
  if (!renderer) return [];
  if (target === 'feedback-category') {
    const chips = renderer.root.findAll(
      node =>
        typeof node.props.testID === 'string' &&
        node.props.testID.startsWith('feedback-category-') &&
        typeof node.props.onPress === 'function',
    );
    const chip = chips[categoryIndex % Math.max(chips.length, 1)];
    return chip ? [chip.props.onPress as () => void] : [];
  }
  const [node] = renderer.root.findAll(
    node =>
      node.props.testID === target && typeof node.props.onPress === 'function',
  );
  return node ? [node.props.onPress as () => void] : [];
}

/** The one press handler a deterministic test expects to exist. */
function mustPress(
  renderer: ReactTestRenderer | null,
  target: Target,
  categoryIndex: number,
): () => void {
  const [press] = pressHandlers(renderer, target, categoryIndex);
  if (!press) throw new Error(`no pressable ${target} rendered`);
  return press;
}

async function runScenario(seed: number): Promise<ScenarioOutcome> {
  const rng = new SeededRng(seed);
  const script = generateScript(rng);
  const violations: Record<string, string> = {};
  const counters = {
    taps: 0,
    tapsLanded: 0,
    requests: 0,
    maxInFlight: 0,
    settles: 0,
    remounts: 0,
    unmounts: 0,
    sameTickDuplicates: 0,
    staleBurstCascades: 0,
    consoleErrors: 0,
    consoleWarnings: 0,
    unhandledRejections: 0,
  };
  const pending: PendingRequest[] = [];
  /** `${generation}:${analysisId}` the server accepted (2xx or 409). */
  const accepted = new Set<string>();
  /** Generations in which a same-tick burst produced concurrent requests. */
  const sameTickDupGenerations = new Set<number>();
  const noise = new NoiseRecorder();
  let renderer = null as ReactTestRenderer | null;
  let mountedAnalysisId: string = ANALYSIS_IDS[0];
  let generation = 0;
  let inSameTickBurst = false;
  let threw: string | null = null;
  const renderedToken = () => sessionState.lastRendered?.bearerToken ?? null;

  const violate = (id: string, message: string) => {
    if (!(id in violations)) violations[id] = message;
  };

  sessionState.current = {
    apiBaseUrl: 'https://api.test',
    bearerToken: TOKENS[0],
  };
  sessionState.lastRendered = null;
  submitAnalysisFeedback.mockReset();
  submitAnalysisFeedback.mockImplementation(
    (
      config: { token: string },
      analysisId: string,
      rating: 'accurate' | 'not_quite',
      category: string | null,
    ) =>
      new Promise<void>((resolve, reject) => {
        counters.requests += 1;
        pending.push({
          index: counters.requests,
          generation,
          analysisId,
          token: config.token,
          rating,
          category,
          resolve,
          reject,
          settled: null,
          burst: inSameTickBurst,
        });
        const open = pending.filter(
          p => p.settled === null && p.generation === generation,
        );
        const inFlight = open.length;
        counters.maxInFlight = Math.max(counters.maxInFlight, inFlight);
        if (inFlight > 1) {
          const staleBurst = open.find(
            p => p.index !== counters.requests && p.burst,
          );
          if (inSameTickBurst) {
            sameTickDupGenerations.add(generation);
            counters.sameTickDuplicates += 1;
            violate(
              'F1b_same_tick_dedup',
              `${inFlight} requests in flight after same-tick burst (request #${counters.requests})`,
            );
          } else if (staleBurst) {
            // Cascade of F1b: the orphan duplicate from an earlier same-tick
            // burst is still pending while the user legitimately retries.
            counters.staleBurstCascades += 1;
            violate(
              'F1b_same_tick_dedup',
              `request #${counters.requests} sent while orphan same-tick duplicate #${staleBurst.index} is still in flight`,
            );
          } else {
            violate(
              'F1_single_request',
              `${inFlight} requests in flight after request #${counters.requests}`,
            );
          }
        }
        if ((rating === 'not_quite') !== (category !== null)) {
          violate(
            'F4_payload',
            `rating ${rating} with category ${String(category)}`,
          );
        }
        if (analysisId !== mountedAnalysisId) {
          violate(
            'F4_payload',
            `request for ${analysisId} while ${mountedAnalysisId} is mounted`,
          );
        }
        if (config.token !== renderedToken()) {
          violate(
            'F4_payload',
            `request bearer ${config.token} but rendered session ${String(
              renderedToken(),
            )}`,
          );
        }
      }),
  );

  const mount = async (analysisId: string) => {
    mountedAnalysisId = analysisId;
    generation += 1;
    await act(async () => {
      renderer = TestRenderer.create(
        <AnalysisFeedbackPrompt analysisId={analysisId} />,
      );
    });
    const surfaces = surfacesOf(renderer);
    if (renderedToken() !== null && !surfaces.includes('feedback-ask')) {
      violate('F7_remount_fresh', `fresh mount rendered ${surfaces.join(',')}`);
    }
    if (renderedToken() === null && surfaces.length > 0) {
      violate(
        'F7_remount_fresh',
        `signed-out mount rendered ${surfaces.join(',')}`,
      );
    }
  };

  const checkSurfaces = (when: string) => {
    const surfaces = surfacesOf(renderer);
    if (!renderer) return;
    if (renderedToken() === null) {
      if (surfaces.length !== 0) {
        violate(
          'F5_single_surface',
          `${when}: signed-out render shows [${surfaces.join(',')}]`,
        );
      }
      return;
    }
    if (surfaces.length !== 1) {
      violate('F5_single_surface', `${when}: surfaces=[${surfaces.join(',')}]`);
    }
    if (
      accepted.has(`${generation}:${mountedAnalysisId}`) &&
      !sameTickDupGenerations.has(generation) &&
      (surfaces.includes('feedback-failed') ||
        surfaces.includes('feedback-ask'))
    ) {
      violate(
        'F3_accepted_stays_done',
        `${when}: ${mountedAnalysisId} accepted by server but surface=[${surfaces.join(',')}]`,
      );
    }
    const inFlight = pending.filter(
      p => p.settled === null && p.generation === generation,
    ).length;
    if (inFlight === 0 && surfaces.includes('feedback-sending')) {
      violate('F2_no_orphan_sending', `${when}: sending with 0 in flight`);
    }
  };

  const settleOne = async (request: PendingRequest, outcome: Settle) => {
    request.settled = outcome;
    counters.settles += 1;
    await act(async () => {
      switch (outcome) {
        case 'ok':
          accepted.add(`${request.generation}:${request.analysisId}`);
          request.resolve();
          break;
        case 'duplicate':
          accepted.add(`${request.generation}:${request.analysisId}`);
          request.reject(
            new ApiError(409, 'analysis.feedback_exists', 'exists'),
          );
          break;
        case 'network':
          request.reject(new TypeError('Network request failed'));
          break;
        case 'server':
          request.reject(new ApiError(503, 'server.unavailable', 'busy'));
          break;
        case 'plain':
          request.reject('string rejection');
          break;
      }
      await flushMicrotasks();
    });
  };

  noise.start();
  try {
    await mount(mountedAnalysisId);
    checkSurfaces('after mount');
    for (const op of script) {
      switch (op.kind) {
        case 'tap': {
          counters.taps += op.times;
          if (op.sameTick) {
            const handlers = pressHandlers(
              renderer,
              op.target,
              op.categoryIndex,
            );
            const [press] = handlers;
            if (press) {
              counters.tapsLanded += op.times;
              inSameTickBurst = op.times > 1;
              try {
                await act(async () => {
                  for (let i = 0; i < op.times; i += 1) press();
                });
              } finally {
                inSameTickBurst = false;
              }
            }
          } else {
            for (let i = 0; i < op.times; i += 1) {
              const handlers = pressHandlers(
                renderer,
                op.target,
                op.categoryIndex,
              );
              const [press] = handlers;
              if (!press) break;
              counters.tapsLanded += 1;
              await act(async () => {
                press();
              });
            }
          }
          checkSurfaces(`after ${opLabel(op)}`);
          break;
        }
        case 'settle': {
          const open = pending.filter(p => p.settled === null);
          if (open.length === 0) break;
          const chosen =
            op.which === 'all'
              ? open
              : op.which === 'oldest'
                ? open.slice(0, 1)
                : open.slice(-1);
          for (const request of chosen) {
            await settleOne(request, op.outcome);
          }
          checkSurfaces(`after ${opLabel(op)}`);
          break;
        }
        case 'flush':
          await act(async () => {
            await flushMicrotasks();
            jest.runOnlyPendingTimers();
          });
          checkSurfaces('after flush');
          break;
        case 'signOut':
          sessionState.current = null;
          break;
        case 'signIn':
          sessionState.current = {
            apiBaseUrl: 'https://api.test',
            bearerToken: op.token,
          };
          break;
        case 'unmount':
          if (renderer) {
            counters.unmounts += 1;
            const current = renderer;
            await act(async () => {
              current.unmount();
            });
            renderer = null;
          }
          break;
        case 'remount':
          if (renderer) {
            counters.unmounts += 1;
            const current = renderer;
            await act(async () => {
              current.unmount();
            });
            renderer = null;
          }
          counters.remounts += 1;
          await mount(op.analysisId);
          checkSurfaces(`after ${opLabel(op)}`);
          break;
      }
    }
    // Drain: settle whatever is still open as success, then require the
    // surface to be terminal.
    for (const request of pending.filter(p => p.settled === null)) {
      await settleOne(request, 'ok');
    }
    await act(async () => {
      await flushMicrotasks();
      jest.runOnlyPendingTimers();
    });
    checkSurfaces('after drain');
    if (renderer) {
      const current = renderer as ReactTestRenderer;
      await act(async () => {
        current.unmount();
      });
      renderer = null;
    }
    await act(async () => {
      await flushMicrotasks();
    });
  } catch (error) {
    threw = describeValue(error);
    if (renderer) {
      try {
        const current = renderer as ReactTestRenderer;
        await act(async () => {
          current.unmount();
        });
      } catch {
        // already torn down
      }
      renderer = null;
    }
  } finally {
    noise.stop();
  }
  if (noise.consoleErrors.length) {
    violate('F6_quiet', `console.error: ${noise.consoleErrors[0]}`);
  }
  if (noise.consoleWarnings.length) {
    violate('F6_quiet', `console.warn: ${noise.consoleWarnings[0]}`);
  }
  if (noise.unhandledRejections.length) {
    violate('F6_quiet', `unhandledRejection: ${noise.unhandledRejections[0]}`);
  }
  counters.consoleErrors = noise.consoleErrors.length;
  counters.consoleWarnings = noise.consoleWarnings.length;
  counters.unhandledRejections = noise.unhandledRejections.length;
  return { seed, script: script.map(opLabel), violations, counters, threw };
}

/** Invariants already pinned as findings via test.failing below. */
const PINNED_INVARIANTS: string[] = ['F1b_same_tick_dedup'];

describe('AnalysisFeedbackPrompt — rapid-interaction stress', () => {
  const config = campaignConfig({ iterations: 40, baseSeed: 0x5eed0001 });
  const seeds = iterationSeeds(config);
  const rows: ScenarioOutcome[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  afterAll(() => {
    writeTable(
      config,
      summarise('AnalysisFeedbackPrompt', config, rows, PINNED_INVARIANTS),
    );
  });

  it.each(seeds.map(seed => [seed]))(
    'seed %d: one request per intent, no orphan sending, quiet',
    async seed => {
      const row = await runScenario(seed);
      rows.push(row);
      expect(row.threw).toBeNull();
      // F1b is the pinned finding below; every other invariant must hold.
      const held = Object.fromEntries(
        Object.entries(row.violations).filter(
          ([id]) => !PINNED_INVARIANTS.includes(id),
        ),
      );
      expect(held).toEqual({});
    },
  );

  /**
   * FINDING (pinned): two presses of "Yes" delivered in ONE tick — before
   * React commits `sending` and unmounts the button — fire TWO
   * submitAnalysisFeedback requests. submit() has no in-flight guard
   * (AnalysisFeedbackPrompt.tsx:40-63); the second request is de-duplicated
   * server-side (409 analysis.feedback_exists → 'done'), so the user-visible
   * effect is a duplicate POST, and — if the two settle differently — a
   * "couldn't be sent" surface for feedback the server already accepted.
   * Flip to a plain `it` once submit() ignores re-entry while sending.
   */
  test.failing(
    'same-tick double tap on "Yes" sends exactly one request',
    async () => {
      sessionState.current = {
        apiBaseUrl: 'https://api.test',
        bearerToken: TOKENS[0],
      };
      submitAnalysisFeedback.mockReset();
      submitAnalysisFeedback.mockImplementation(() => new Promise(() => {}));
      let renderer = null as ReactTestRenderer | null;
      await act(async () => {
        renderer = TestRenderer.create(
          <AnalysisFeedbackPrompt analysisId="a-dup" />,
        );
      });
      const press = mustPress(renderer, 'feedback-yes', 0);
      await act(async () => {
        press();
        press();
      });
      expect(submitAnalysisFeedback).toHaveBeenCalledTimes(1);
      await act(async () => {
        renderer?.unmount();
      });
    },
  );

  test.failing(
    'same-tick double tap on a category sends exactly one request',
    async () => {
      sessionState.current = {
        apiBaseUrl: 'https://api.test',
        bearerToken: TOKENS[0],
      };
      submitAnalysisFeedback.mockReset();
      submitAnalysisFeedback.mockImplementation(() => new Promise(() => {}));
      let renderer = null as ReactTestRenderer | null;
      await act(async () => {
        renderer = TestRenderer.create(
          <AnalysisFeedbackPrompt analysisId="a-dup" />,
        );
      });
      const openCategories = mustPress(renderer, 'feedback-not-quite', 0);
      await act(async () => {
        openCategories();
      });
      const press = mustPress(renderer, 'feedback-category', 1);
      await act(async () => {
        press();
        press();
      });
      expect(submitAnalysisFeedback).toHaveBeenCalledTimes(1);
      await act(async () => {
        renderer?.unmount();
      });
    },
  );

  it('harness sensitivity: a state update outside act() is caught as F6 noise', async () => {
    const noise = new NoiseRecorder();
    let setValue: ((value: number) => void) | null = null;
    function Probe() {
      const [value, set] = React.useState(0);
      setValue = set;
      return <>{value}</>;
    }
    let renderer = null as ReactTestRenderer | null;
    await act(async () => {
      renderer = TestRenderer.create(<Probe />);
    });
    noise.start();
    try {
      (setValue as unknown as (value: number) => void)(1);
      await flushMicrotasks();
    } finally {
      noise.stop();
    }
    expect(noise.consoleErrors.some(line => line.includes('act('))).toBe(true);
    await act(async () => {
      renderer?.unmount();
    });
  });

  it('double tap on "Yes" across ticks sends exactly one request (the re-render removes the button)', async () => {
    sessionState.current = {
      apiBaseUrl: 'https://api.test',
      bearerToken: TOKENS[0],
    };
    submitAnalysisFeedback.mockReset();
    submitAnalysisFeedback.mockImplementation(() => new Promise(() => {}));
    let renderer = null as ReactTestRenderer | null;
    await act(async () => {
      renderer = TestRenderer.create(
        <AnalysisFeedbackPrompt analysisId="a-seq" />,
      );
    });
    const first = mustPress(renderer, 'feedback-yes', 0);
    await act(async () => {
      first();
    });
    expect(pressHandlers(renderer, 'feedback-yes', 0)).toHaveLength(0);
    expect(surfacesOf(renderer)).toEqual(['feedback-sending']);
    expect(submitAnalysisFeedback).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer?.unmount();
    });
  });
});
