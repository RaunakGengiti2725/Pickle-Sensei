/// <reference types="node" />
/**
 * STRESS — unit `cmp-camera-ui`, lens `boundary-i18n-a11y`.
 *
 * Seeded, replayable rendering campaign over CaptureEvidenceCard,
 * CaptureGuidancePanel and TargetSelector:
 *   - grid lane: 3 widths × 3 font scales × 3 components × 2 content classes
 *     (54 rendered variants, fixed ids);
 *   - campaign lane: STRESS_ITER seeded variants (default 120) drawing
 *     window, locale-tagged hostile strings, numeric extremes, structural
 *     holes and DST-edge instants from the seed alone;
 *   - dst lane: TargetSelector confirm at every DST-edge instant.
 *
 * Every row is inspected on the rendered host tree (roles, labels,
 * `accessible`, `minHeight`, rendered strings) plus a glyph-model clipping
 * ESTIMATE that is reported, never asserted.
 *
 * Replay one row:  STRESS_SEED=<seed> npx jest --ci __tests__/stress/cameraUiBoundaryI18nA11y.stress.test.tsx
 * Replay + reduce: STRESS_SEED=<seed> STRESS_MUTATIONS=<id,id> …
 * Scale:           STRESS_ITER=2000 …
 * Table:           STRESS_OUT=/abs/path/rows.json …   (JSON seed → outcome)
 * Locale/zone are process-level (jest sandboxes env): see run-camera-ui-stress.sh.
 */
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const make = (name: string) => {
    const Mock = (props: { children?: React.ReactNode }) =>
      React.createElement(View, null, props.children);
    Mock.displayName = name;
    return Mock;
  };
  return {
    __esModule: true,
    default: make('Svg'),
    Svg: make('Svg'),
    Circle: make('Circle'),
    Line: make('Line'),
    Path: make('Path'),
    Polyline: make('Polyline'),
    Rect: make('Rect'),
    Defs: make('Defs'),
    RadialGradient: make('RadialGradient'),
    Stop: make('Stop'),
  };
});

const mockWindow = { width: 375, height: 812, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ ...mockWindow }),
}));

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { Image, TouchableWithoutFeedback } from 'react-native';
import { Circle } from 'react-native-svg';
import TestRenderer, {
  act,
  type ReactTestRenderer,
  type ReactTestRendererJSON,
} from 'react-test-renderer';
import { CaptureEvidenceCard } from '../../src/camera/CaptureEvidenceCard';
import { CaptureGuidancePanel } from '../../src/camera/CaptureGuidancePanel';
import {
  TargetSelector,
  type TargetSelection,
} from '../../src/camera/TargetSelector';
import type { EnvelopeVerdict } from '@pickle/shared-types';
import { Button } from '../../src/design/components';
import { space } from '../../src/design/tokens';
import {
  CAMPAIGN_FONT_SCALES,
  CAMPAIGN_WIDTHS,
  DST_EDGE_INSTANTS,
  FORBIDDEN_COPY_TERMS,
  GRID_FONT_SCALES,
  GRID_WIDTHS,
  LOCALES,
  stringsForLocale,
  type StringClass,
} from '../../__harness__/cameraUiStress/corpus';
import {
  clipScenario,
  envelopeScenario,
  selectorScenario,
  type ContentClass,
  type Mutation,
} from '../../__harness__/cameraUiStress/fixtures';
import {
  auditInteractive,
  auditText,
  estimateClipping,
  flattenTree,
  outline,
  type A11yRecord,
  type ClipEstimate,
  type HostNode,
} from '../../__harness__/cameraUiStress/inspect';
import { hashSeed, SeededRng } from '../../__harness__/cameraUiStress/rng';

declare const process: {
  env: Record<string, string | undefined>;
  version: string;
  cwd(): string;
};

const TEST_FILE = '__tests__/stress/cameraUiBoundaryI18nA11y.stress.test.tsx';
const STRESS_ITER = Math.max(0, Number(process.env['STRESS_ITER'] ?? 120));
const CAMPAIGN_SEED = Number(process.env['STRESS_CAMPAIGN_SEED'] ?? 20260904);
const REPLAY_SEED =
  process.env['STRESS_SEED'] !== undefined
    ? Number(process.env['STRESS_SEED'])
    : null;
const REPLAY_MUTATIONS = process.env['STRESS_MUTATIONS']
  ? process.env['STRESS_MUTATIONS'].split(',').map(s => s.trim())
  : undefined;
const STRESS_OUT = process.env['STRESS_OUT'];

type Component =
  'CaptureEvidenceCard' | 'CaptureGuidancePanel' | 'TargetSelector';
const COMPONENTS: readonly Component[] = [
  'CaptureEvidenceCard',
  'CaptureGuidancePanel',
  'TargetSelector',
];

interface RowSpec {
  id: string;
  seed: number;
  lane: 'grid' | 'campaign' | 'dst' | 'replay' | 'minimize';
  component: Component;
  window: { width: number; fontScale: number };
  localeTag: string;
  contentClass: ContentClass;
  instantId: string;
  forcedMutations?: readonly string[];
}

type CheckStatus = 'HELD' | 'BROKEN' | 'INFO';
interface Check {
  name: string;
  status: CheckStatus;
  detail?: string;
}

interface RowResult {
  id: string;
  seed: number;
  lane: RowSpec['lane'];
  component: Component;
  window: RowSpec['window'];
  locale: string;
  stringClasses: readonly StringClass[];
  contentClass: ContentClass;
  instantId: string;
  mutations: Mutation[];
  /** Clip passes assertCapturedClip / envelope is well-formed / layout usable. */
  inputInContract: boolean;
  inputRejectReason: string | null;
  rendered: boolean;
  renderError: string | null;
  consoleErrors: string[];
  interactive: A11yRecord[];
  textCount: number;
  leaks: Array<{ path: string; leaks: string[]; text: string }>;
  clipEstimates: ClipEstimate[];
  checks: Check[];
  outcome:
    'HELD' | 'BROKEN' | 'HOSTILE_CRASH' | 'HOSTILE_LEAK' | 'HOSTILE_HELD';
  replay: string;
  outline: string[];
  durationMs: number;
}

/* ------------------------------------------------------------------ rows */

function gridRows(): RowSpec[] {
  const rows: RowSpec[] = [];
  const classes: ContentClass[] = ['valid', 'hostile-string'];
  GRID_WIDTHS.forEach(width => {
    GRID_FONT_SCALES.forEach(fontScale => {
      COMPONENTS.forEach(component => {
        classes.forEach((contentClass, variant) => {
          const seed = hashSeed('grid', width, fontScale, component, variant);
          const locale = LOCALES[
            seed % LOCALES.length
          ] as (typeof LOCALES)[number];
          rows.push({
            id: `grid:w${width}:f${fontScale}:${component}:${contentClass}`,
            seed,
            lane: 'grid',
            component,
            window: { width, fontScale },
            localeTag: locale.tag,
            contentClass,
            instantId: (
              DST_EDGE_INSTANTS[
                seed % DST_EDGE_INSTANTS.length
              ] as (typeof DST_EDGE_INSTANTS)[number]
            ).id,
          });
        });
      });
    });
  });
  return rows;
}

/** A campaign row is a pure function of its seed (replayable by seed alone). */
function campaignRow(
  seed: number,
  lane: RowSpec['lane'] = 'campaign',
  forcedMutations?: readonly string[],
): RowSpec {
  const rng = new SeededRng(seed);
  const component = rng.pick(COMPONENTS);
  const roll = rng.next();
  const contentClass: ContentClass =
    roll < 0.3
      ? 'valid'
      : roll < 0.55
        ? 'boundary-numeric'
        : roll < 0.85
          ? 'hostile-string'
          : 'structural';
  const locale = rng.pick(LOCALES);
  const instant = rng.pick(DST_EDGE_INSTANTS);
  return {
    id: `${lane}:${seed}${forcedMutations ? `:${forcedMutations.join('+')}` : ''}`,
    seed,
    lane,
    component,
    window: {
      width: rng.pick(CAMPAIGN_WIDTHS),
      fontScale: rng.pick(CAMPAIGN_FONT_SCALES),
    },
    localeTag: locale.tag,
    contentClass,
    instantId: instant.id,
    forcedMutations,
  };
}

function campaignRows(): RowSpec[] {
  const rows: RowSpec[] = [];
  for (let i = 0; i < STRESS_ITER; i += 1) {
    rows.push(campaignRow(hashSeed(CAMPAIGN_SEED, i)));
  }
  return rows;
}

function dstRows(): RowSpec[] {
  return DST_EDGE_INSTANTS.map((instant, i) => ({
    id: `dst:${instant.id}`,
    seed: hashSeed('dst', instant.iso),
    lane: 'dst' as const,
    component: 'TargetSelector' as const,
    window: {
      width: GRID_WIDTHS[i % GRID_WIDTHS.length] as number,
      fontScale: GRID_FONT_SCALES[i % GRID_FONT_SCALES.length] as number,
    },
    localeTag: (LOCALES[i % LOCALES.length] as (typeof LOCALES)[number]).tag,
    contentClass: 'valid' as const,
    instantId: instant.id,
  }));
}

const ROWS: RowSpec[] =
  REPLAY_SEED !== null
    ? [campaignRow(REPLAY_SEED, 'replay', REPLAY_MUTATIONS)]
    : [...gridRows(), ...campaignRows(), ...dstRows()];

/* --------------------------------------------------------------- helpers */

function instantFor(id: string): string {
  const found = DST_EDGE_INSTANTS.find(i => i.id === id);
  if (!found) throw new Error(`unknown instant ${id}`);
  return found.iso;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  if (!renderer) throw new Error('renderer missing');
  return renderer;
}

function findByStyle(
  nodes: HostNode[],
  predicate: (style: Record<string, unknown>) => boolean,
): HostNode | undefined {
  return nodes.find(n => predicate(n.style));
}

function inspect(
  json: ReactTestRendererJSON | ReactTestRendererJSON[] | null,
  window: RowSpec['window'],
) {
  const nodes = flattenTree(json);
  const texts = auditText(nodes);
  return {
    nodes,
    texts,
    interactive: auditInteractive(nodes, window.width),
    leaks: texts
      .filter(t => t.leaks.length > 0)
      .map(t => ({ path: t.path, leaks: t.leaks, text: t.text.slice(0, 120) })),
    clip: estimateClipping(nodes, window),
    allText: texts.map(t => t.text).join('\n'),
  };
}

/* --------------------------------------------------------- per-component */

interface ComponentRun {
  mutations: Mutation[];
  inputInContract: boolean;
  inputRejectReason: string | null;
  json: ReactTestRendererJSON | ReactTestRendererJSON[] | null;
  checks: Check[];
  renderer: ReactTestRenderer | null;
}

async function runCard(
  rng: SeededRng,
  row: RowSpec,
  classes: readonly StringClass[],
): Promise<ComponentRun> {
  const scenario = clipScenario(
    rng,
    row.contentClass,
    classes,
    row.forcedMutations,
  );
  const checks: Check[] = [];
  const renderer = await render(<CaptureEvidenceCard clip={scenario.clip} />);
  const json = renderer.toJSON();
  const { nodes, interactive, allText } = inspect(json, row.window);

  const root = nodes[0];
  checks.push({
    name: 'card.root-summary-role-and-label',
    status:
      root?.props['accessibilityRole'] === 'summary' &&
      typeof root.props['accessibilityLabel'] === 'string' &&
      (root.props['accessibilityLabel'] as string).length > 0
        ? 'HELD'
        : 'BROKEN',
    detail: `role=${String(root?.props['accessibilityRole'])}`,
  });
  checks.push({
    name: 'card.no-interactive-controls',
    status: interactive.length === 0 ? 'HELD' : 'BROKEN',
    detail: `interactive=${interactive.length}`,
  });

  const compactExpected = row.window.width < 410 || row.window.fontScale > 1.15;
  const stackExpected = row.window.width < 350 || row.window.fontScale > 1.2;
  if (
    scenario.mode === 'measured' &&
    scenario.clip.captureMode === 'automatic_pose_trigger'
  ) {
    const heroRow = findByStyle(
      nodes,
      s =>
        s['gap'] === space.md &&
        s['marginTop'] === space.lg &&
        'flexDirection' in s,
    );
    const factsRow = findByStyle(
      nodes,
      s => s['alignItems'] === 'stretch' && s['marginTop'] === space.lg,
    );
    checks.push({
      name: 'card.responsive-hero-row',
      status:
        heroRow &&
        heroRow.style['flexDirection'] === (compactExpected ? 'column' : 'row')
          ? 'HELD'
          : 'BROKEN',
      detail: `width=${row.window.width} fontScale=${row.window.fontScale} flexDirection=${String(
        heroRow?.style['flexDirection'],
      )} compactExpected=${compactExpected}`,
    });
    checks.push({
      name: 'card.responsive-facts-row',
      status:
        factsRow &&
        factsRow.style['flexDirection'] === (stackExpected ? 'column' : 'row')
          ? 'HELD'
          : 'BROKEN',
      detail: `flexDirection=${String(factsRow?.style['flexDirection'])} stackExpected=${stackExpected}`,
    });
    if (scenario.validatorAccepts) {
      const evidence = scenario.clip.captureEvidence;
      const label = String(root?.props['accessibilityLabel']);
      checks.push({
        name: 'card.a11y-label-carries-measured-facts',
        status:
          label.includes(`${evidence.poseFrameCount} usable pose frames`) &&
          label.includes(
            `${Math.round(evidence.meanJointCoverage * 100)} percent average joint coverage`,
          )
            ? 'HELD'
            : 'BROKEN',
        detail: label.slice(0, 160),
      });
      // Free-string round trip: model/algorithm versions are validator-clean
      // arbitrary non-empty strings and must render verbatim in the trace.
      for (const key of [
        'poseModelVersion',
        'triggerAlgorithmVersion',
      ] as const) {
        const value = evidence[key];
        checks.push({
          name: `card.string-roundtrip.${key}`,
          status: allText.includes(value) ? 'HELD' : 'BROKEN',
          detail: `len=${value.length} cps=${[...value].length}`,
        });
      }
      const top = [...evidence.jointMotion].sort(
        (a, b) => b.peakNormalizedPerSecond - a.peakNormalizedPerSecond,
      )[0];
      if (top) {
        checks.push({
          name: 'card.string-roundtrip.mostMovementJoint',
          status: allText.includes(top.joint.replace(/_/g, ' '))
            ? 'HELD'
            : 'BROKEN',
          detail: top.joint,
        });
      }
    }
  }
  if (scenario.contentClass === 'valid') {
    const hit = FORBIDDEN_COPY_TERMS.filter(t =>
      allText.toLowerCase().includes(t.toLowerCase()),
    );
    checks.push({
      name: 'copy.no-forbidden-store-terms',
      status: hit.length === 0 ? 'HELD' : 'BROKEN',
      detail: hit.join(','),
    });
  }
  return {
    mutations: scenario.mutations,
    inputInContract: scenario.validatorAccepts,
    inputRejectReason: scenario.validatorError,
    json,
    checks,
    renderer,
  };
}

async function runPanel(
  rng: SeededRng,
  row: RowSpec,
  classes: readonly StringClass[],
): Promise<ComponentRun> {
  const scenario = envelopeScenario(
    rng,
    row.contentClass,
    classes,
    row.forcedMutations,
  );
  const checks: Check[] = [];
  const renderer = await render(
    <CaptureGuidancePanel
      envelope={scenario.envelope as EnvelopeVerdict | null}
    />,
  );
  const json = renderer.toJSON();
  const { nodes, texts, interactive, allText } = inspect(json, row.window);
  checks.push({
    name: 'panel.no-interactive-controls',
    status: interactive.length === 0 ? 'HELD' : 'BROKEN',
  });
  if (scenario.expectedLines !== null) {
    const lineTexts = texts.filter(t => t.fontSize === 13);
    const gate = texts.find(t => t.fontSize === 11);
    if (scenario.expectedLines.length === 0) {
      checks.push({
        name: 'panel.renders-nothing-when-clean',
        status: json === null ? 'HELD' : 'BROKEN',
        detail: `json=${json === null ? 'null' : 'tree'}`,
      });
    } else {
      const root = nodes[0];
      checks.push({
        name: 'panel.root-text-role-and-label',
        status:
          root?.props['accessibilityRole'] === 'text' &&
          root.props['accessibilityLabel'] === 'Capture guidance'
            ? 'HELD'
            : 'BROKEN',
      });
      const distinct = new Set(lineTexts.map(t => t.text));
      checks.push({
        name: 'panel.one-line-per-degraded-dimension',
        status:
          lineTexts.length === scenario.expectedLines.length &&
          distinct.size === lineTexts.length &&
          lineTexts.every(t => t.text.trim().length > 0)
            ? 'HELD'
            : 'BROKEN',
        detail: `expected=${scenario.expectedLines.length} rendered=${lineTexts.length} distinct=${distinct.size}`,
      });
      const blockedCopy = 'Ready is on hold until the items above are fixed.';
      const openCopy =
        'Ready is not blocked — fixing the items above improves the read.';
      checks.push({
        name: 'panel.gate-copy-matches-unsupported',
        status:
          gate?.text === (scenario.expectedBlocked ? blockedCopy : openCopy)
            ? 'HELD'
            : 'BROKEN',
        detail: `blocked=${String(scenario.expectedBlocked)} gate="${gate?.text ?? ''}"`,
      });
      const hit = FORBIDDEN_COPY_TERMS.filter(t =>
        allText.toLowerCase().includes(t.toLowerCase()),
      );
      checks.push({
        name: 'copy.no-forbidden-store-terms',
        status: hit.length === 0 ? 'HELD' : 'BROKEN',
        detail: hit.join(','),
      });
    }
  }
  return {
    mutations: scenario.mutations,
    inputInContract: scenario.wellFormed,
    inputRejectReason: scenario.wellFormed
      ? null
      : 'envelope shape outside EnvelopeVerdict',
    json,
    checks,
    renderer,
  };
}

async function runSelector(
  rng: SeededRng,
  row: RowSpec,
  classes: readonly StringClass[],
): Promise<ComponentRun> {
  const scenario = selectorScenario(
    rng,
    row.contentClass,
    classes,
    row.window,
    row.forcedMutations,
  );
  const checks: Check[] = [];
  const confirms: TargetSelection[] = [];
  let skips = 0;
  const renderer = await render(
    <TargetSelector
      frameUri={scenario.frameUri}
      posterUri={scenario.posterUri}
      sourceWidth={scenario.sourceWidth}
      sourceHeight={scenario.sourceHeight}
      onConfirm={selection => confirms.push(selection)}
      onSkip={() => {
        skips += 1;
      }}
    />,
  );
  const buttons = () => renderer.root.findAllByType(Button);
  const analyze = () =>
    buttons().find(b => b.props.label === 'Analyze this player');
  const skip = () =>
    buttons().find(b => b.props.label === 'Skip — pick automatically');

  // Pre-tap: Analyze disabled and a no-op.
  await act(async () => {
    analyze()?.props.onPress();
  });
  checks.push({
    name: 'selector.analyze-disabled-before-tap',
    status:
      analyze()?.props.disabled === true && confirms.length === 0
        ? 'HELD'
        : 'BROKEN',
    detail: `disabled=${String(analyze()?.props.disabled)} confirms=${confirms.length}`,
  });

  const initialImage = renderer.root.findAllByType(Image)[0];
  const expectedUri = scenario.posterUri ?? scenario.frameUri;
  checks.push({
    name: 'selector.image-source-roundtrip',
    status:
      initialImage && initialImage.props.source?.uri === expectedUri
        ? 'HELD'
        : 'BROKEN',
    detail: `uri.len=${expectedUri.length}`,
  });

  if (scenario.failPreview && initialImage) {
    await act(async () => {
      initialImage.props.onError();
    });
    const afterText = inspect(renderer.toJSON(), row.window).allText;
    checks.push({
      name: 'selector.preview-fallback-copy',
      status: afterText.includes(
        'Preview unavailable — tap where you are in the video',
      )
        ? 'HELD'
        : 'BROKEN',
    });
  }

  const frame = renderer.root.findByType(TouchableWithoutFeedback);
  const layoutTarget = renderer.root.findAll(
    n => typeof n.props.onLayout === 'function',
  )[0];
  await act(async () => {
    layoutTarget?.props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, ...scenario.layout } },
    });
  });
  await act(async () => {
    frame.props.onPress({
      nativeEvent: { locationX: scenario.tap.x, locationY: scenario.tap.y },
    });
  });
  // The selection ring is the r=26 Circle; the preview-fallback person icon
  // also draws a Circle (its head) and must not be counted.
  const rings = renderer.root
    .findAllByType(Circle)
    .filter(c => c.props.r === 26).length;
  const tapRegistered = analyze()?.props.disabled === false;
  const layoutFinite =
    Number.isFinite(scenario.layout.width) &&
    Number.isFinite(scenario.layout.height);

  if (scenario.layoutUsable) {
    checks.push({
      name: 'selector.tap-registers-with-usable-layout',
      status: tapRegistered && rings === 1 ? 'HELD' : 'BROKEN',
      detail: `layout=${JSON.stringify(scenario.layout)} rings=${rings}`,
    });
  } else if (layoutFinite) {
    checks.push({
      name: 'selector.tap-ignored-without-positive-layout',
      status: !tapRegistered && rings === 0 ? 'HELD' : 'BROKEN',
      detail: `layout=${JSON.stringify(scenario.layout)} registered=${tapRegistered}`,
    });
  } else {
    checks.push({
      name: 'selector.tap-with-non-finite-layout',
      status: 'INFO',
      detail: `layout=${JSON.stringify(scenario.layout)} registered=${tapRegistered} rings=${rings}`,
    });
  }

  const iso = instantFor(row.instantId);
  jest.useFakeTimers({ now: Date.parse(iso) });
  try {
    await act(async () => {
      analyze()?.props.onPress();
    });
  } finally {
    jest.useRealTimers();
  }
  if (tapRegistered) {
    const selection = confirms[0];
    const point = selection?.point;
    const finite =
      point !== undefined &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      point.x >= 0 &&
      point.x <= 1 &&
      point.y >= 0 &&
      point.y <= 1;
    checks.push({
      name: 'selector.confirm-point-normalized-finite',
      status: confirms.length === 1 && finite ? 'HELD' : 'BROKEN',
      detail: `confirms=${confirms.length} point=${JSON.stringify(point)} source=${String(
        scenario.sourceWidth,
      )}x${String(scenario.sourceHeight)} tap=${JSON.stringify(scenario.tap)}`,
    });
    checks.push({
      name: 'selector.selectedAtIso-utc-under-process-zone',
      status:
        selection !== undefined &&
        selection.selectedAtIso === new Date(iso).toISOString() &&
        /Z$/.test(selection.selectedAtIso) &&
        Date.parse(selection.selectedAtIso) === Date.parse(iso)
          ? 'HELD'
          : 'BROKEN',
      detail: `instant=${row.instantId} tz=${Intl.DateTimeFormat().resolvedOptions().timeZone} offsetMin=${new Date(
        iso,
      ).getTimezoneOffset()} got=${selection?.selectedAtIso ?? 'none'}`,
    });
  } else {
    checks.push({
      name: 'selector.no-confirm-without-tap',
      status: confirms.length === 0 ? 'HELD' : 'BROKEN',
      detail: `confirms=${confirms.length}`,
    });
  }

  await act(async () => {
    skip()?.props.onPress();
  });
  checks.push({
    name: 'selector.skip-calls-onSkip-once',
    status: skips === 1 ? 'HELD' : 'BROKEN',
    detail: `skips=${skips}`,
  });

  const json = renderer.toJSON();
  const { interactive, allText } = inspect(json, row.window);
  checks.push({
    name: 'selector.exactly-three-controls',
    status: interactive.length === 3 ? 'HELD' : 'BROKEN',
    detail: interactive.map(i => `${i.role}:${i.label}`).join(' | '),
  });
  const hit = FORBIDDEN_COPY_TERMS.filter(t =>
    allText.toLowerCase().includes(t.toLowerCase()),
  );
  if (scenario.contentClass !== 'hostile-string') {
    checks.push({
      name: 'copy.no-forbidden-store-terms',
      status: hit.length === 0 ? 'HELD' : 'BROKEN',
      detail: hit.join(','),
    });
  }
  const inContract = scenario.inContract;
  return {
    mutations: scenario.mutations,
    inputInContract: inContract,
    inputRejectReason: inContract
      ? null
      : 'layout/tap outside what a device delivers (non-finite, <1pt, >1e5pt) or empty file uri',
    json,
    checks,
    renderer,
  };
}

/* ------------------------------------------------------------------- run */

async function runRow(row: RowSpec): Promise<RowResult> {
  const started = Date.now();
  mockWindow.width = row.window.width;
  mockWindow.fontScale = row.window.fontScale;
  const classes = stringsForLocale(row.localeTag);
  const rng = new SeededRng(hashSeed(row.seed, row.component));
  const consoleErrors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(
      args
        .map(a => (typeof a === 'string' ? a : errorText(a)))
        .join(' ')
        .slice(0, 300),
    );
  };
  let run: ComponentRun | null = null;
  let renderError: string | null = null;
  try {
    run =
      row.component === 'CaptureEvidenceCard'
        ? await runCard(rng, row, classes)
        : row.component === 'CaptureGuidancePanel'
          ? await runPanel(rng, row, classes)
          : await runSelector(rng, row, classes);
  } catch (error) {
    renderError = errorText(error);
  } finally {
    console.error = originalError;
    jest.useRealTimers();
  }

  const checks: Check[] = run ? [...run.checks] : [];
  const inspected = run ? inspect(run.json, row.window) : null;
  const interactive = inspected?.interactive ?? [];
  const leaks = inspected?.leaks ?? [];
  const clipEstimates = (inspected?.clip ?? []).filter(
    c => c.verdict !== 'fits',
  );

  checks.unshift({
    name: 'render.no-throw',
    status: renderError === null ? 'HELD' : 'BROKEN',
    detail: renderError ?? undefined,
  });
  if (run) {
    checks.push({
      name: 'a11y.every-control-has-role-label-and-44pt-target',
      status: interactive.every(i => i.problems.length === 0)
        ? 'HELD'
        : 'BROKEN',
      detail: interactive
        .map(
          i =>
            `${i.role}:"${i.label}" h=${i.target.height}${i.target.estimated ? '~' : ''} ${i.problems.join(';')}`,
        )
        .join(' | '),
    });
    checks.push({
      name: 'a11y.no-control-hidden-from-assistive-tech',
      status: interactive.every(i => !i.hiddenFromA11y) ? 'HELD' : 'BROKEN',
    });
    const texts = inspected?.texts ?? [];
    checks.push({
      name: 'a11y.font-scaling-not-disabled-or-capped',
      status: texts.every(
        t => t.allowFontScaling && t.maxFontSizeMultiplier === null,
      )
        ? 'HELD'
        : 'INFO',
      detail: texts
        .filter(t => !t.allowFontScaling || t.maxFontSizeMultiplier !== null)
        .map(
          t =>
            `${t.path}:allow=${t.allowFontScaling},max=${t.maxFontSizeMultiplier}`,
        )
        .join(';'),
    });
    checks.push({
      name: 'text.no-numberOfLines-truncation',
      status: texts.every(t => t.numberOfLines === null) ? 'HELD' : 'BROKEN',
      detail: texts
        .filter(t => t.numberOfLines !== null)
        .map(t => t.path)
        .join(';'),
    });
    checks.push({
      name: 'text.no-conversion-leaks',
      status: leaks.length === 0 ? 'HELD' : 'BROKEN',
      detail: leaks
        .map(l => `${l.leaks.join('+')}@${l.path}:"${l.text.slice(0, 60)}"`)
        .join(' | '),
    });
    checks.push({
      name: 'react.no-console-errors',
      status: consoleErrors.length === 0 ? 'HELD' : 'BROKEN',
      detail: consoleErrors[0],
    });
    checks.push({
      name: 'layout.glyph-model-clip-estimate',
      status: clipEstimates.some(c => c.verdict !== 'wraps') ? 'INFO' : 'HELD',
      detail: clipEstimates
        .filter(c => c.verdict !== 'wraps')
        .map(
          c =>
            `${c.verdict}@${c.path} lines=${c.estimatedLines} h=${c.estimatedHeight.toFixed(0)}>${c.container?.height ?? '-'} "${c.textPreview}"`,
        )
        .join(' | '),
    });
  }

  // iOS delivers window widths >= 320pt and Dynamic Type scales roughly
  // 0.82–3.6; outside that the row is a robustness probe, not a device state.
  const windowInContract =
    Number.isFinite(row.window.width) &&
    row.window.width >= 320 &&
    row.window.width <= 1400 &&
    Number.isFinite(row.window.fontScale) &&
    row.window.fontScale >= 0.5 &&
    row.window.fontScale <= 4;
  const inputInContract = run ? run.inputInContract && windowInContract : false;
  const inputRejectReason = run
    ? (run.inputRejectReason ??
      (windowInContract ? null : 'window outside device range'))
    : null;
  const broken = checks.filter(c => c.status === 'BROKEN');
  let outcome: RowResult['outcome'];
  if (renderError !== null) {
    outcome = inputInContract ? 'BROKEN' : 'HOSTILE_CRASH';
  } else if (broken.length === 0) {
    outcome = inputInContract ? 'HELD' : 'HOSTILE_HELD';
  } else {
    outcome = inputInContract ? 'BROKEN' : 'HOSTILE_LEAK';
  }
  // A crashed row never reached the validator: classify against the payload
  // grade the same seed produces without rendering.
  if (renderError !== null && run === null) {
    const probe = new SeededRng(hashSeed(row.seed, row.component));
    let grade = false;
    let reason: string | null = 'unknown';
    try {
      if (row.component === 'CaptureEvidenceCard') {
        const s = clipScenario(
          probe,
          row.contentClass,
          classes,
          row.forcedMutations,
        );
        grade = s.validatorAccepts;
        reason = s.validatorError;
      } else if (row.component === 'CaptureGuidancePanel') {
        const s = envelopeScenario(
          probe,
          row.contentClass,
          classes,
          row.forcedMutations,
        );
        grade = s.wellFormed;
        reason = grade ? null : 'envelope shape outside EnvelopeVerdict';
      } else {
        const s = selectorScenario(
          probe,
          row.contentClass,
          classes,
          row.window,
          row.forcedMutations,
        );
        grade = s.inContract;
        reason = grade ? null : 'layout/tap outside device contract';
      }
    } catch (error) {
      reason = errorText(error);
    }
    grade = grade && windowInContract;
    outcome = grade ? 'BROKEN' : 'HOSTILE_CRASH';
    return finish(row, classes, started, {
      mutations: [],
      inputInContract: grade,
      inputRejectReason: reason,
      renderError,
      consoleErrors,
      interactive,
      textCount: 0,
      leaks,
      clipEstimates,
      checks,
      outcome,
      outline: [],
    });
  }
  run?.renderer?.unmount();
  return finish(row, classes, started, {
    mutations: run?.mutations ?? [],
    inputInContract,
    inputRejectReason,
    renderError,
    consoleErrors,
    interactive,
    textCount: inspected?.texts.length ?? 0,
    leaks,
    clipEstimates,
    checks,
    outcome,
    outline: outline(inspected?.nodes ?? []),
  });
}

function finish(
  row: RowSpec,
  classes: readonly StringClass[],
  started: number,
  partial: Omit<
    RowResult,
    | 'id'
    | 'seed'
    | 'lane'
    | 'component'
    | 'window'
    | 'locale'
    | 'stringClasses'
    | 'contentClass'
    | 'instantId'
    | 'rendered'
    | 'replay'
    | 'durationMs'
  >,
): RowResult {
  const replay =
    row.lane === 'grid' || row.lane === 'dst'
      ? `cd apps/mobile && npx jest --ci ${TEST_FILE} -t "${row.id}"`
      : `cd apps/mobile && STRESS_SEED=${row.seed}${
          row.forcedMutations
            ? ` STRESS_MUTATIONS=${row.forcedMutations.join(',')}`
            : ''
        } npx jest --ci ${TEST_FILE}`;
  return {
    id: row.id,
    seed: row.seed,
    lane: row.lane,
    component: row.component,
    window: row.window,
    locale: row.localeTag,
    stringClasses: classes,
    contentClass: row.contentClass,
    instantId: row.instantId,
    rendered: partial.renderError === null,
    replay,
    durationMs: Date.now() - started,
    ...partial,
  };
}

/* ----------------------------------------------------------------- suite */

const results: RowResult[] = [];
const minimized: RowResult[] = [];

describe(`stress cmp-camera-ui boundary-i18n-a11y (${ROWS.length} rows)`, () => {
  test.each(ROWS.map(row => [row.id, row] as const))('%s', async (_id, row) => {
    const result = await runRow(row);
    results.push(result);
    if (result.outcome === 'BROKEN') {
      const broken = result.checks.filter(c => c.status === 'BROKEN');
      throw new Error(
        `BROKEN seed=${result.seed} ${result.component} ${JSON.stringify(result.window)} locale=${result.locale} class=${result.contentClass}\n` +
          broken.map(c => `  ${c.name}: ${c.detail ?? ''}`).join('\n') +
          `\n  mutations=${JSON.stringify(result.mutations)}\n  replay: ${result.replay}`,
      );
    }
  });

  afterAll(async () => {
    // Minimize: every failing seed-derived row is re-run with each mutation
    // alone (same seed, same drawn values) plus a zero-mutation control, so
    // the smallest reproducing payload is on record.
    for (const result of results) {
      if (
        (result.outcome === 'BROKEN' ||
          result.outcome === 'HOSTILE_CRASH' ||
          result.outcome === 'HOSTILE_LEAK') &&
        (result.lane === 'campaign' ||
          (result.lane === 'replay' && REPLAY_MUTATIONS === undefined))
      ) {
        const ids = [...new Set(result.mutations.map(m => m.id))];
        if (ids.length > 1) {
          for (const id of ids) {
            minimized.push(
              await runRow(campaignRow(result.seed, 'minimize', [id])),
            );
          }
        }
        if (ids.length > 0) {
          // Zero-mutation control: does the base payload alone reproduce?
          minimized.push(
            await runRow(campaignRow(result.seed, 'minimize', [])),
          );
        }
      }
    }
    const count = (outcome: RowResult['outcome']) =>
      results.filter(r => r.outcome === outcome).length;
    const byComponent = Object.fromEntries(
      COMPONENTS.map(c => [
        c,
        {
          rows: results.filter(r => r.component === c).length,
          held: results.filter(
            r =>
              r.component === c &&
              (r.outcome === 'HELD' || r.outcome === 'HOSTILE_HELD'),
          ).length,
          broken: results.filter(
            r => r.component === c && r.outcome === 'BROKEN',
          ).length,
          hostileCrash: results.filter(
            r => r.component === c && r.outcome === 'HOSTILE_CRASH',
          ).length,
          hostileLeak: results.filter(
            r => r.component === c && r.outcome === 'HOSTILE_LEAK',
          ).length,
        },
      ]),
    );
    const checkTotals: Record<
      string,
      { held: number; broken: number; info: number }
    > = {};
    for (const r of results) {
      for (const c of r.checks) {
        const t = (checkTotals[c.name] ??= { held: 0, broken: 0, info: 0 });
        if (c.status === 'HELD') t.held += 1;
        else if (c.status === 'BROKEN') t.broken += 1;
        else t.info += 1;
      }
    }
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    const report = {
      unit: 'cmp-camera-ui',
      lens: 'boundary-i18n-a11y',
      testFile: TEST_FILE,
      run: {
        startedAt: new Date().toISOString(),
        node: process.version,
        icuLocale: resolved.locale,
        timeZone: resolved.timeZone,
        tzOffsetMinutesNow: new Date().getTimezoneOffset(),
        env: {
          STRESS_ITER,
          STRESS_CAMPAIGN_SEED: CAMPAIGN_SEED,
          STRESS_SEED: REPLAY_SEED,
          STRESS_MUTATIONS: REPLAY_MUTATIONS ?? null,
          TZ: process.env['TZ'] ?? null,
          LC_ALL: process.env['LC_ALL'] ?? null,
          LANG: process.env['LANG'] ?? null,
        },
      },
      summary: {
        rows: results.length,
        rendered: results.filter(r => r.rendered).length,
        held: count('HELD'),
        hostileHeld: count('HOSTILE_HELD'),
        broken: count('BROKEN'),
        hostileCrash: count('HOSTILE_CRASH'),
        hostileLeak: count('HOSTILE_LEAK'),
        locales: [...new Set(results.map(r => r.locale))].sort(),
        windows: [
          ...new Set(
            results.map(r => `${r.window.width}x${r.window.fontScale}`),
          ),
        ].sort(),
        instants: [...new Set(results.map(r => r.instantId))].sort(),
        byComponent,
        checkTotals,
        minimizedRows: minimized.length,
      },
      seedsFailed: [...results, ...minimized]
        .filter(
          r =>
            r.outcome === 'BROKEN' ||
            r.outcome === 'HOSTILE_CRASH' ||
            r.outcome === 'HOSTILE_LEAK',
        )
        .map(r => ({
          id: r.id,
          seed: r.seed,
          outcome: r.outcome,
          component: r.component,
          inputInContract: r.inputInContract,
          mutations: r.mutations,
          broken: r.checks
            .filter(c => c.status === 'BROKEN')
            .map(c => `${c.name}: ${c.detail ?? ''}`),
          renderError: r.renderError,
          replay: r.replay,
        })),
      rows: results,
      minimized,
    };
    if (STRESS_OUT) {
      fs.mkdirSync(path.dirname(STRESS_OUT), { recursive: true });
      fs.writeFileSync(STRESS_OUT, JSON.stringify(report, null, 2));
    }
  });
});
