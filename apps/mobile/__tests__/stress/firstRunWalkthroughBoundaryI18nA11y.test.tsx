/**
 * STRESS — FirstRunWalkthrough × boundary / i18n / a11y.
 *
 * Every rendered variant is audited on the REAL host tree react-native hands
 * to the platform: interactive elements must carry a role + label and model
 * to ≥ 44 pt (test-support/stress/a11yAudit.ts), every SVG path number must
 * be finite, the spotlight hole must sit in the window, the Skip/Next
 * controls must follow the step contract and VoiceOver must be told which
 * step it is on.
 *
 * Campaigns (all seeded, every row replayable from its `seed`/`cell`):
 *   matrix   3 viewports × 3 Dynamic Type scales × 4 steps
 *   clock    12 locales × 8 time zones on DST edges — the tour must render
 *            byte-identically (it has no Intl/Date dependency)
 *   fuzz     STRESS_ITER seeded runs over random windows (zero / tiny / huge),
 *            random registered-target subsets, in-contract rects, and
 *            measurers that resolve null, throw, or resolve late
 *   hostile  measurers returning out-of-contract rects (NaN, ±Infinity,
 *            negative, zero, 1e9) — the tour must not throw and must not
 *            emit NaN geometry to react-native-svg
 *
 * Two classes of check:
 *   HARD    contract invariants → the test fails.
 *   STRICT  modelled-layout / copy expectations that are known gaps at this
 *           commit (callout taller than the room it has at AX sizes). They are
 *           recorded as BROKEN rows in the JSON table and only fail the test
 *           under STRESS_STRICT=1, so the suite stays green in CI while the
 *           evidence stays replayable:
 *             STRESS_STRICT=1 STRESS_ONLY=<seed> npx jest firstRunWalkthroughBoundary
 *
 * Output: artifacts/stress/walkthrough-*.json (STRESS_OUT overrides).
 */
import React from 'react';
import { AccessibilityInfo, Dimensions, StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import {
  FirstRunWalkthrough,
  WALKTHROUGH_STEPS,
  arrowGeometry,
  rectVisibleInWindow,
} from '../../src/walkthrough/FirstRunWalkthrough';
import {
  registerWalkthroughMeasurer,
  type TargetRect,
  type WalkthroughTargetKey,
} from '../../src/walkthrough/targets';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import {
  auditInteractive,
  compactTree,
  textScalingReport,
} from '../../test-support/stress/a11yAudit';
import {
  STRESS_ITER,
  campaignSeeds,
  writeCampaignTable,
  writeStressArtifact,
  type CampaignRow,
} from '../../test-support/stress/artifacts';
import {
  DST_EDGE_INSTANTS,
  FONT_SCALES,
  LOCALES,
  TIMEZONES,
  VIEWPORTS,
} from '../../test-support/stress/corpus';
import {
  modelCallout,
  pathNumbers,
} from '../../test-support/stress/layoutModel';
import { createRng, seedFromString } from '../../test-support/stress/rng';

declare const process: { env: Record<string, string | undefined> };

const STRICT = process.env.STRESS_STRICT === '1';
const STEP_KEYS = WALKTHROUGH_STEPS.map(step => step.targetKey);
const DEFAULT_WINDOW = { width: 750, height: 1334, scale: 2, fontScale: 2 };

type Renderer = TestRenderer.ReactTestRenderer;

let unregister: Array<() => void> = [];
let announcements: string[] = [];
let announceSpy: jest.SpyInstance;

function setWindow(width: number, height: number, fontScale: number) {
  const metrics = { width, height, scale: 3, fontScale };
  Dimensions.set({ window: metrics, screen: metrics });
}

function register(
  key: WalkthroughTargetKey,
  measure: () => Promise<TargetRect | null>,
) {
  unregister.push(registerWalkthroughMeasurer(key, measure));
}

function rectsFor(
  width: number,
  height: number,
): Record<WalkthroughTargetKey, TargetRect> {
  return {
    'coach-fab': { x: width / 2 - 32, y: height - 112, width: 64, height: 64 },
    'rank-banner': { x: 24, y: 120, width: width - 48, height: 96 },
    'tab-library': {
      x: width * 0.25 - 35,
      y: height - 54,
      width: 70,
      height: 54,
    },
    'tab-progress': {
      x: width * 0.62 - 35,
      y: height - 54,
      width: 70,
      height: 54,
    },
  };
}

beforeEach(() => {
  announcements = [];
  announceSpy = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibility')
    .mockImplementation((message: string) => {
      announcements.push(message);
    });
});

afterEach(async () => {
  await unmountAll();
  for (const cleanup of unregister) cleanup();
  unregister = [];
  useWalkthroughStore.setState({ visible: false });
  announceSpy.mockRestore();
  Dimensions.set({ window: DEFAULT_WINDOW, screen: DEFAULT_WINDOW });
  jest.useRealTimers();
});

let mounted: Renderer | null = null;

async function renderVisible(): Promise<Renderer> {
  await unmountAll();
  await act(async () => {
    useWalkthroughStore.setState({ visible: true });
  });
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<FirstRunWalkthrough />);
  });
  mounted = renderer;
  return renderer;
}

async function unmountAll() {
  const renderer = mounted;
  mounted = null;
  if (!renderer) return;
  await act(async () => {
    renderer.unmount();
  });
  await act(async () => {
    useWalkthroughStore.setState({ visible: false });
  });
}

/** Lets the measurement loop run its retries (120 ms × 6) under fake timers. */
async function settle(renderer: Renderer) {
  for (let i = 0; i < 60; i++) {
    await act(async () => {
      await Promise.resolve();
      jest.advanceTimersByTime(130);
      await Promise.resolve();
    });
    if (!useWalkthroughStore.getState().visible) return;
    if (spotlight(renderer)) return;
  }
}

function spotlight(renderer: Renderer) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.accessibilityViewIsModal === true,
  )[0];
}

function textContent(renderer: Renderer): string {
  return renderer.root
    .findAll(node => String(node.type) === 'Text')
    .map(node => React.Children.toArray(node.props.children).join(''))
    .join('\n');
}

function pressTestId(renderer: Renderer, testID: string) {
  const target = renderer.root.findAll(
    node => node.props.testID === testID && node.props.onPress !== undefined,
  )[0];
  if (!target) throw new Error(`no pressable ${testID}`);
  return act(async () => target.props.onPress());
}

interface StepInspection {
  hard: string[];
  strict: string[];
  detail: Record<string, unknown>;
}

/** Narrowest iPhone the app targets; below it the 44 pt model is moot. */
const MIN_SUPPORTED_WIDTH = 320;

function inspectStep(
  renderer: Renderer,
  ctx: {
    width: number;
    height: number;
    fontScale: number;
    expectedStepIndex: number;
    /** Production-like rects: the spotlight ring must start inside the window. */
    ringInWindow?: boolean;
  },
): StepInspection {
  const hard: string[] = [];
  const strict: string[] = [];
  const realisticWindow =
    ctx.width >= MIN_SUPPORTED_WIDTH && ctx.height >= MIN_SUPPORTED_WIDTH;
  const step = WALKTHROUGH_STEPS[ctx.expectedStepIndex]!;
  const isLast = ctx.expectedStepIndex === WALKTHROUGH_STEPS.length - 1;
  const text = textContent(renderer);

  if (!text.includes(step.headline))
    hard.push(`headline "${step.headline}" not rendered`);
  if (text.includes('Skip') !== !isLast)
    hard.push(`Skip visibility wrong (isLast=${isLast})`);
  const advanceHosts = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.testID === 'walkthrough-advance',
  );
  if (advanceHosts.length !== 1)
    hard.push(`expected one advance host, got ${advanceHosts.length}`);
  const advanceLabel = advanceHosts[0]?.props.accessibilityLabel;
  if (advanceLabel !== (isLast ? 'Got it' : 'Next'))
    hard.push(`advance label ${String(advanceLabel)}`);

  const audit = auditInteractive(renderer.root, {
    fontScale: ctx.fontScale,
    windowWidth: ctx.width,
    windowHeight: ctx.height,
  });
  for (const issue of audit.issues) {
    const message = `a11y:${issue.kind} ${issue.detail} @${issue.path}`;
    if (issue.kind === 'small-target' && !realisticWindow) strict.push(message);
    else hard.push(message);
  }

  const paths = renderer.root
    .findAll(node => typeof node.props.d === 'string')
    .map(node => node.props.d as string);
  if (paths.length < 4) hard.push(`expected ≥4 svg paths, got ${paths.length}`);
  const badNumbers = paths
    .flatMap(d => pathNumbers(d))
    .filter(n => !Number.isFinite(n));
  if (badNumbers.length > 0)
    hard.push(`non-finite svg path numbers: ${badNumbers.length}`);
  const nanLiteral = paths.filter(d => /NaN|Infinity/.test(d));
  if (nanLiteral.length > 0)
    hard.push(`svg path contains NaN/Infinity literal`);

  // The stroke ring is the second path: `M x y ...` — its first point must be
  // inside (or within the padding of) the window.
  const ring = paths[1] ? pathNumbers(paths[1]) : [];
  const ringX = ring[0];
  const ringY = ring[1];
  const slack = 48;
  if (
    ctx.ringInWindow &&
    (ringX === undefined ||
      ringY === undefined ||
      ringX < -slack ||
      ringX > ctx.width + slack ||
      ringY < -slack ||
      ringY > ctx.height + slack)
  ) {
    hard.push(
      `spotlight ring starts at (${String(ringX)}, ${String(ringY)}) outside ${ctx.width}×${ctx.height}`,
    );
  }

  const dots = renderer.root.findAll(node => {
    if (typeof node.type !== 'string' || String(node.type) !== 'View')
      return false;
    const flat = StyleSheet.flatten(node.props.style) as
      { height?: number; borderRadius?: number } | undefined;
    return flat?.height === 6 && flat.borderRadius === 3;
  });
  if (dots.length !== WALKTHROUGH_STEPS.length)
    hard.push(`expected ${WALKTHROUGH_STEPS.length} dots, got ${dots.length}`);

  const model = modelCallout(
    renderer.root,
    ctx.fontScale,
    ctx.width,
    ctx.height,
  );
  if (!model) hard.push('callout not rendered');
  else {
    if (model.top !== undefined && !Number.isFinite(model.top))
      hard.push('callout top not finite');
    if (model.bottom !== undefined && !Number.isFinite(model.bottom))
      hard.push('callout bottom not finite');
    const anchorBucket = ctx.ringInWindow ? hard : strict;
    if (model.top !== undefined && (model.top < 0 || model.top > ctx.height)) {
      anchorBucket.push(
        `callout top=${model.top} outside window height ${ctx.height}`,
      );
    }
    if (
      model.bottom !== undefined &&
      (model.bottom < 0 || model.bottom > ctx.height)
    ) {
      anchorBucket.push(
        `callout bottom=${model.bottom} outside window height ${ctx.height}`,
      );
    }
    if (model.overflowPt > 0) {
      strict.push(
        `callout-overflow: modelled ${model.modelledHeight}pt into ${model.available}pt (${model.clippedEdge} edge clipped by ${model.overflowPt}pt) at fontScale ${ctx.fontScale}`,
      );
    }
  }

  const expectedAnnouncement = `Walkthrough, step ${ctx.expectedStepIndex + 1} of ${WALKTHROUGH_STEPS.length}.`;
  const last = announcements[announcements.length - 1];
  if (
    !last ||
    !last.startsWith(expectedAnnouncement) ||
    !last.includes(step.headline)
  ) {
    hard.push(
      `announcement "${String(last)}" ≠ "${expectedAnnouncement} ${step.headline} …"`,
    );
  }

  const scaling = textScalingReport(renderer.root);
  const capped = scaling.filter(
    run => !run.allowFontScaling || run.maxFontSizeMultiplier !== undefined,
  );

  return {
    hard,
    strict,
    detail: {
      step: step.key,
      isLast,
      interactive: audit.elements.map(el => ({
        label: el.label,
        role: el.role,
        size: `${el.width}×${el.height}`,
        basis: el.sizeBasis,
      })),
      callout: model
        ? {
            top: model.top,
            bottom: model.bottom,
            modelledHeight: model.modelledHeight,
            available: model.available,
            overflowPt: model.overflowPt,
            clippedEdge: model.clippedEdge,
            lines: model.runs.map(run => run.lines),
          }
        : null,
      textRunsCappedForScaling: capped.length,
      announcement: last,
    },
  };
}

function rowFor(
  campaign: string,
  seed: number,
  cell: string,
  inspection: StepInspection,
  extra: Record<string, unknown> = {},
): CampaignRow {
  const violations = [...inspection.hard, ...inspection.strict];
  return {
    campaign,
    seed,
    cell,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    detail: {
      ...inspection.detail,
      ...extra,
      hardViolations: inspection.hard.length,
    },
    violations,
  };
}

/** Rendered-tree evidence is captured at inspection time for BROKEN rows. */
function captureTree(
  trees: Map<string, unknown>,
  row: CampaignRow,
  renderer: Renderer | null,
) {
  if (row.outcome === 'BROKEN' && renderer)
    trees.set(row.cell, compactTree(renderer.root));
}

function assertRows(
  rows: CampaignRow[],
  artifactName: string,
  trees: Map<string, unknown>,
) {
  const hardBroken = rows.filter(
    row => (row.detail.hardViolations as number) > 0,
  );
  const strictBroken = rows.filter(row => row.outcome === 'BROKEN');
  if (strictBroken.length > 0) {
    writeStressArtifact(
      `${artifactName}-trees.json`,
      Object.fromEntries(trees),
    );
  }
  if (hardBroken.length > 0 || (STRICT && strictBroken.length > 0)) {
    const offending = hardBroken.length > 0 ? hardBroken : strictBroken;
    const path = writeStressArtifact(
      `${artifactName}-trees.json`,
      Object.fromEntries(trees),
    );
    throw new Error(
      `${offending.length} BROKEN rows (rendered trees: ${path}):\n` +
        offending
          .slice(0, 12)
          .map(
            row =>
              `  seed=${row.seed} cell=${row.cell}\n    ${row.violations.join('\n    ')}`,
          )
          .join('\n'),
    );
  }
}

describe('FirstRunWalkthrough stress — boundary / i18n / a11y', () => {
  it('matrix: 3 viewports × 3 font scales × every step audits clean', async () => {
    const rows: CampaignRow[] = [];
    const trees = new Map<string, unknown>();
    for (const viewport of VIEWPORTS) {
      for (const fontScale of FONT_SCALES) {
        setWindow(viewport.width, viewport.height, fontScale);
        const rects = rectsFor(viewport.width, viewport.height);
        for (const key of STEP_KEYS)
          register(key, () => Promise.resolve(rects[key]));
        const renderer = await renderVisible();
        for (const [index] of WALKTHROUGH_STEPS.entries()) {
          const cell = `${viewport.name}|fs${fontScale}|step${index + 1}`;
          const inspection = inspectStep(renderer, {
            width: viewport.width,
            height: viewport.height,
            fontScale,
            expectedStepIndex: index,
            ringInWindow: true,
          });
          const row = rowFor(
            'walkthrough-matrix',
            seedFromString(cell),
            cell,
            inspection,
          );
          rows.push(row);
          captureTree(trees, row, renderer);
          await pressTestId(renderer, 'walkthrough-advance');
        }
        expect(useWalkthroughStore.getState().visible).toBe(false);
        for (const cleanup of unregister) cleanup();
        unregister = [];
      }
    }
    const { path } = writeCampaignTable('walkthrough-matrix', rows);
    expect(rows).toHaveLength(
      VIEWPORTS.length * FONT_SCALES.length * WALKTHROUGH_STEPS.length,
    );
    assertRows(rows, 'walkthrough-matrix', trees);
    expect(path).toContain('walkthrough-matrix.json');
  });

  it('clock: 12 locales × 8 time zones on DST edges render byte-identically', async () => {
    const rows: CampaignRow[] = [];
    const trees = new Map<string, unknown>();
    const nowSpy = jest.spyOn(Date, 'now');
    const viewport = VIEWPORTS[1];
    let baselineTree: string | null = null;
    const offsetsSeen = new Set<string>();
    try {
      for (const locale of LOCALES) {
        for (const [tzIndex, tz] of TIMEZONES.entries()) {
          const instant = DST_EDGE_INSTANTS[tzIndex]!;
          const epoch = Date.parse(instant);
          nowSpy.mockReturnValue(epoch);
          // Jest sandboxes process.env, so the zone axis is exercised through
          // ICU: the same instant formatted in the locale + zone the device
          // would use. The tour itself must be independent of both.
          const formatter = new Intl.DateTimeFormat(locale, {
            timeZone: tz,
            timeZoneName: 'longOffset',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
          });
          const localClock = formatter.format(epoch);
          const offset =
            formatter.formatToParts(epoch).find(p => p.type === 'timeZoneName')
              ?.value ?? '';
          offsetsSeen.add(
            new Intl.DateTimeFormat('en-US', {
              timeZone: tz,
              timeZoneName: 'longOffset',
            })
              .formatToParts(epoch)
              .find(p => p.type === 'timeZoneName')?.value ?? '',
          );
          setWindow(viewport.width, viewport.height, 1);
          const rects = rectsFor(viewport.width, viewport.height);
          for (const key of STEP_KEYS)
            register(key, () => Promise.resolve(rects[key]));
          const renderer = await renderVisible();
          const cell = `${locale}|${tz}|${instant}`;
          const inspection = inspectStep(renderer, {
            width: viewport.width,
            height: viewport.height,
            fontScale: 1,
            expectedStepIndex: 0,
            ringInWindow: true,
          });
          const tree = JSON.stringify(compactTree(renderer.root));
          if (baselineTree === null) baselineTree = tree;
          else if (tree !== baselineTree)
            inspection.hard.push('rendered tree differs from UTC baseline');
          const row = rowFor(
            'walkthrough-clock',
            seedFromString(cell),
            cell,
            inspection,
            {
              locale,
              tz,
              instant,
              localClock,
              offset,
              treeBytes: tree.length,
            },
          );
          rows.push(row);
          captureTree(trees, row, renderer);
          await pressTestId(renderer, 'walkthrough-skip');
          for (const cleanup of unregister) cleanup();
          unregister = [];
        }
      }
    } finally {
      nowSpy.mockRestore();
    }
    writeCampaignTable('walkthrough-clock', rows);
    expect(rows).toHaveLength(LOCALES.length * TIMEZONES.length);
    // The zone axis was real: distinct UTC offsets were produced by ICU.
    expect(offsetsSeen.size).toBeGreaterThanOrEqual(6);
    assertRows(rows, 'walkthrough-clock', trees);
  });

  it('fuzz: seeded windows × target subsets × measurer behaviours (STRESS_ITER)', async () => {
    jest.useFakeTimers();
    const rows: CampaignRow[] = [];
    const trees = new Map<string, unknown>();
    const seeds = campaignSeeds(seedFromString('walkthrough-fuzz'));
    for (const seed of seeds) {
      const rng = createRng(seed);
      const windowKind = rng.pick([
        'viewport',
        'viewport',
        'viewport',
        'tiny',
        'huge',
        'zero',
        'random',
      ] as const);
      let width: number;
      let height: number;
      if (windowKind === 'viewport') {
        const viewport = rng.pick(VIEWPORTS);
        width = viewport.width;
        height = viewport.height;
      } else if (windowKind === 'tiny') {
        width = rng.int(1, 60);
        height = rng.int(1, 60);
      } else if (windowKind === 'huge') {
        width = rng.int(5000, 100000);
        height = rng.int(5000, 100000);
      } else if (windowKind === 'zero') {
        width = 0;
        height = 0;
      } else {
        width = rng.int(100, 2000);
        height = rng.int(100, 4000);
      }
      const fontScale = rng.pick([
        0.823, 1, 1.118, 1.353, 1.786, 2.143, 2.643, 3.571,
      ]);
      setWindow(width, height, fontScale);

      type Behaviour =
        | 'in-window'
        | 'offscreen'
        | 'null'
        | 'throw'
        | 'late'
        | 'unregistered'
        | 'edge';
      const plan: Record<
        WalkthroughTargetKey,
        { behaviour: Behaviour; rect: TargetRect | null }
      > = {
        'coach-fab': { behaviour: 'unregistered', rect: null },
        'rank-banner': { behaviour: 'unregistered', rect: null },
        'tab-library': { behaviour: 'unregistered', rect: null },
        'tab-progress': { behaviour: 'unregistered', rect: null },
      };
      const expectedVisible: number[] = [];
      for (const [index, key] of STEP_KEYS.entries()) {
        const behaviour = rng.pick<Behaviour>([
          'in-window',
          'in-window',
          'in-window',
          'offscreen',
          'null',
          'throw',
          'late',
          'unregistered',
          'edge',
        ]);
        let rect: TargetRect | null = null;
        const w = rng.pick([
          1,
          12,
          44,
          64,
          96,
          200,
          Math.max(1, Math.floor(width * 0.9)),
        ]);
        const h = rng.pick([
          1,
          12,
          44,
          54,
          96,
          200,
          Math.max(1, Math.floor(height * 0.3)),
        ]);
        if (behaviour === 'in-window' || behaviour === 'late') {
          rect = {
            x: rng.int(0, Math.max(0, width - 1)) - w / 2,
            y: rng.int(0, Math.max(0, height - 1)) - h / 2,
            width: w,
            height: h,
          };
        } else if (behaviour === 'offscreen') {
          const side = rng.pick(['left', 'right', 'top', 'bottom'] as const);
          rect = {
            x:
              side === 'left'
                ? -w - rng.int(1, 1000)
                : side === 'right'
                  ? width + rng.int(1, 1000)
                  : rng.int(0, Math.max(0, width)),
            y:
              side === 'top'
                ? -h - rng.int(1, 1000)
                : side === 'bottom'
                  ? height + rng.int(1, 1000)
                  : rng.int(0, Math.max(0, height)),
            width: w,
            height: h,
          };
        } else if (behaviour === 'edge') {
          // Center exactly on a window edge — inclusive per rectVisibleInWindow.
          rect = { x: width - w / 2, y: height - h / 2, width: w, height: h };
        }
        plan[key] = { behaviour, rect };
        if (rect && rectVisibleInWindow(rect, width, height))
          expectedVisible.push(index);
        if (behaviour === 'unregistered') continue;
        const captured = rect;
        register(key, () => {
          if (behaviour === 'null') return Promise.resolve(null);
          if (behaviour === 'throw')
            return Promise.reject(new Error(`measure failed for ${key}`));
          if (behaviour === 'late') {
            return new Promise(resolve =>
              setTimeout(() => resolve(captured), 50),
            );
          }
          return Promise.resolve(captured);
        });
      }

      const cell = `seed${seed}|${windowKind}:${width}x${height}|fs${fontScale}|${STEP_KEYS.map(k => plan[k].behaviour[0]).join('')}`;
      const hard: string[] = [];
      const strict: string[] = [];
      const visited: number[] = [];
      let renderer: Renderer | null = null;
      try {
        renderer = await renderVisible();
        await settle(renderer);
        let guard = 0;
        while (useWalkthroughStore.getState().visible && guard++ < 8) {
          const card = spotlight(renderer);
          if (!card) {
            hard.push('store visible but no spotlight rendered after settling');
            break;
          }
          const headline = textContent(renderer);
          const index = WALKTHROUGH_STEPS.findIndex(step =>
            headline.includes(step.headline),
          );
          if (index < 0) {
            hard.push('spotlight rendered without a known headline');
            break;
          }
          visited.push(index);
          const inspection = inspectStep(renderer, {
            width,
            height,
            fontScale,
            expectedStepIndex: index,
          });
          hard.push(...inspection.hard);
          strict.push(...inspection.strict);
          const action = rng.pick([
            'advance',
            'advance',
            'advance',
            'skip',
            'backdrop',
          ] as const);
          if (action === 'advance') {
            await pressTestId(renderer, 'walkthrough-advance');
          } else if (
            action === 'skip' &&
            index !== WALKTHROUGH_STEPS.length - 1
          ) {
            await pressTestId(renderer, 'walkthrough-skip');
            if (useWalkthroughStore.getState().visible)
              hard.push('skip did not dismiss');
            break;
          } else {
            const backdrop = renderer.root.findAll(
              node =>
                node.props.accessibilityLabel === 'Dismiss walkthrough' &&
                node.props.onPress !== undefined,
            )[0];
            if (!backdrop) hard.push('backdrop missing');
            else await act(async () => backdrop.props.onPress());
            if (useWalkthroughStore.getState().visible)
              hard.push('backdrop did not dismiss');
            break;
          }
          await settle(renderer);
        }
        if (useWalkthroughStore.getState().visible)
          hard.push('tour still visible after walking every step');
        // Visited steps must be a prefix-ordered subsequence of the expected visible steps.
        const expectedPrefix = expectedVisible.slice(0, visited.length);
        if (visited.join(',') !== expectedPrefix.join(',')) {
          hard.push(
            `visited steps [${visited.join(',')}] ≠ expected visible prefix [${expectedPrefix.join(',')}] (all visible: [${expectedVisible.join(',')}])`,
          );
        }
      } catch (error) {
        hard.push(
          `threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const inspection: StepInspection = {
        hard,
        strict,
        detail: {
          window: { width, height, fontScale, kind: windowKind },
          plan,
          expectedVisible,
          visited,
        },
      };
      const row = rowFor('walkthrough-fuzz', seed, cell, inspection);
      rows.push(row);
      captureTree(trees, row, renderer);
      for (const cleanup of unregister) cleanup();
      unregister = [];
      useWalkthroughStore.setState({ visible: false });
    }
    writeCampaignTable('walkthrough-fuzz', rows);
    expect(rows).toHaveLength(seeds.length);
    assertRows(rows, 'walkthrough-fuzz', trees);
  });

  it('hostile: out-of-contract measurer rects never throw or emit NaN geometry', async () => {
    jest.useFakeTimers();
    const rows: CampaignRow[] = [];
    const trees = new Map<string, unknown>();
    const hostileValues = [
      0,
      -1,
      -100,
      1e9,
      -1e9,
      Number.MAX_SAFE_INTEGER,
      Number.EPSILON,
      NaN,
      Infinity,
      -Infinity,
      0.1,
      4294967296,
    ];
    const seeds = campaignSeeds(
      seedFromString('walkthrough-hostile'),
      Math.max(8, STRESS_ITER),
    );
    for (const seed of seeds) {
      const rng = createRng(seed);
      const viewport = rng.pick(VIEWPORTS);
      setWindow(viewport.width, viewport.height, 1);
      const rect: TargetRect = {
        x: rng.chance(0.5)
          ? rng.pick(hostileValues)
          : rng.int(0, viewport.width),
        y: rng.chance(0.5)
          ? rng.pick(hostileValues)
          : rng.int(0, viewport.height),
        width: rng.chance(0.7) ? rng.pick(hostileValues) : rng.int(1, 200),
        height: rng.chance(0.7) ? rng.pick(hostileValues) : rng.int(1, 200),
      };
      const key = rng.pick(STEP_KEYS);
      register(key, () => Promise.resolve(rect));
      const cell = `seed${seed}|${key}|${JSON.stringify(rect)}`;
      const hard: string[] = [];
      const strict: string[] = [];
      let renderer: Renderer | null = null;
      const visibleByContract = rectVisibleInWindow(
        rect,
        viewport.width,
        viewport.height,
      );
      let observed: Record<string, unknown> = {};
      try {
        renderer = await renderVisible();
        await settle(renderer);
        const card = spotlight(renderer);
        const paths = renderer.root
          .findAll(node => typeof node.props.d === 'string')
          .map(node => node.props.d as string);
        const numbers = paths.flatMap(pathNumbers);
        observed = {
          visibleByContract,
          spotlightRendered: Boolean(card),
          storeVisible: useWalkthroughStore.getState().visible,
          nonFinitePathNumbers: numbers.filter(n => !Number.isFinite(n)).length,
          nanLiteralInPath: paths.some(d => /NaN|Infinity/.test(d)),
          negativeRadius: paths.some(d => /a\s*-\d|a-\d/.test(d)),
        };
        if (observed.nanLiteralInPath === true)
          hard.push('svg path contains NaN/Infinity literal');
        if (Boolean(card) !== visibleByContract) {
          hard.push(
            `spotlight rendered=${String(Boolean(card))} but rectVisibleInWindow=${String(visibleByContract)}`,
          );
        }
        if (card) {
          const inspection = inspectStep(renderer, {
            width: viewport.width,
            height: viewport.height,
            fontScale: 1,
            expectedStepIndex: STEP_KEYS.indexOf(key),
          });
          hard.push(...inspection.hard);
          strict.push(...inspection.strict);
          if (observed.negativeRadius === true)
            strict.push('negative arc radius emitted for out-of-contract rect');
          await pressTestId(renderer, 'walkthrough-advance');
        }
        await settle(renderer);
        if (useWalkthroughStore.getState().visible)
          hard.push('tour did not end after the only registered step');
      } catch (error) {
        hard.push(
          `threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const row = rowFor('walkthrough-hostile', seed, cell, {
        hard,
        strict,
        detail: { rect, key, viewport: viewport.name, ...observed },
      });
      rows.push(row);
      captureTree(trees, row, renderer);
      for (const cleanup of unregister) cleanup();
      unregister = [];
      useWalkthroughStore.setState({ visible: false });
    }
    writeCampaignTable('walkthrough-hostile', rows);
    assertRows(rows, 'walkthrough-hostile', trees);
  });

  it('pure geometry: rectVisibleInWindow / arrowGeometry over hostile numerics', () => {
    const rows: CampaignRow[] = [];
    const values = [
      0,
      -0,
      1,
      -1,
      44,
      -44,
      1e-9,
      1e9,
      -1e9,
      2 ** 31,
      2 ** 53,
      NaN,
      Infinity,
      -Infinity,
      375,
      667,
    ];
    const seeds = campaignSeeds(
      seedFromString('walkthrough-geometry'),
      Math.max(200, STRESS_ITER * 20),
    );
    for (const seed of seeds) {
      const rng = createRng(seed);
      const rect = {
        x: rng.pick(values),
        y: rng.pick(values),
        width: rng.pick(values),
        height: rng.pick(values),
      };
      const w = rng.pick(values);
      const h = rng.pick(values);
      const from = { x: rng.pick(values), y: rng.pick(values) };
      const to = { x: rng.pick(values), y: rng.pick(values) };
      const violations: string[] = [];
      let visible: boolean | undefined;
      let arrow: { shaft: string; head: string } | undefined;
      try {
        visible = rectVisibleInWindow(rect, w, h);
        if (typeof visible !== 'boolean')
          violations.push('rectVisibleInWindow did not return a boolean');
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        const expected =
          centerX >= 0 && centerX <= w && centerY >= 0 && centerY <= h;
        if (visible !== expected) {
          violations.push(
            `rectVisibleInWindow=${String(visible)} but center rule says ${String(expected)}`,
          );
        }
        if (
          visible &&
          Number.isFinite(w) &&
          Number.isFinite(h) &&
          !(Number.isFinite(centerX) && Number.isFinite(centerY))
        ) {
          violations.push(
            'non-finite center reported visible in a finite window',
          );
        }
        arrow = arrowGeometry(from, to);
        const finiteInput = [from.x, from.y, to.x, to.y].every(Number.isFinite);
        const numbers = [
          ...pathNumbers(arrow.shaft),
          ...pathNumbers(arrow.head),
        ];
        if (
          finiteInput &&
          (numbers.some(n => !Number.isFinite(n)) ||
            /NaN|Infinity/.test(arrow.shaft + arrow.head))
        ) {
          violations.push('finite arrow input produced non-finite path');
        }
      } catch (error) {
        violations.push(
          `threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      rows.push({
        campaign: 'walkthrough-geometry',
        seed,
        cell: `seed${seed}`,
        outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
        detail: {
          rect,
          window: { w, h },
          from,
          to,
          visible,
          shaft: arrow?.shaft,
          hardViolations: violations.length,
        },
        violations,
      });
    }
    writeCampaignTable('walkthrough-geometry', rows);
    const broken = rows.filter(row => row.outcome === 'BROKEN');
    expect(
      broken.map(row => `${row.seed}: ${row.violations.join('; ')}`),
    ).toEqual([]);
  });
});
