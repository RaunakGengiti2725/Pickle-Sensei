/**
 * Scenario runner: renders one screen element for one matrix cell, settles
 * async effects, audits the host tree and returns a replayable record.
 *
 * Window size is injected through `getWindow()` (the audit files mock
 * `react-native/Libraries/Utilities/useWindowDimensions` and `Dimensions.get`
 * to read it). Device locale for `toLocale*String(undefined, …)` calls is
 * injected through `withLocale`.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { I18nManager } from 'react-native';
import { auditTree, type Cell, type Issue, type TreeAudit } from './treeAudit';
import type { ScenarioResult } from './fixtures';

let currentWindow = { width: 375, height: 812, scale: 3, fontScale: 1 };

export function getWindow() {
  return currentWindow;
}

export function setCell(cell: Cell): void {
  currentWindow = {
    width: cell.width,
    height: Math.round(cell.width * 2.16),
    scale: 3,
    fontScale: cell.fontScale,
  };
  // I18nManager is a plain module object in the Jest preset; screens do not
  // read it directly, but code under test that does will observe the flag.
  (I18nManager as unknown as { isRTL: boolean }).isRTL = cell.rtl;
}

const nativeToLocaleDateString = Date.prototype.toLocaleDateString;
const nativeToLocaleTimeString = Date.prototype.toLocaleTimeString;
const nativeToLocaleString = Date.prototype.toLocaleString;

/** Simulate the device locale for `toLocale*String(undefined, opts)`. */
export async function withLocale<T>(
  locale: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (!locale) return fn();
  type LocaleFn = typeof nativeToLocaleDateString;
  Date.prototype.toLocaleDateString = function (
    this: Date,
    l?: Intl.LocalesArgument,
    o?: Intl.DateTimeFormatOptions,
  ) {
    return nativeToLocaleDateString.call(this, l ?? locale, o);
  } as LocaleFn;
  Date.prototype.toLocaleTimeString = function (
    this: Date,
    l?: Intl.LocalesArgument,
    o?: Intl.DateTimeFormatOptions,
  ) {
    return nativeToLocaleTimeString.call(this, l ?? locale, o);
  } as LocaleFn;
  Date.prototype.toLocaleString = function (
    this: Date,
    l?: Intl.LocalesArgument,
    o?: Intl.DateTimeFormatOptions,
  ) {
    return nativeToLocaleString.call(this, l ?? locale, o);
  } as LocaleFn;
  try {
    return await fn();
  } finally {
    Date.prototype.toLocaleDateString = nativeToLocaleDateString;
    Date.prototype.toLocaleTimeString = nativeToLocaleTimeString;
    Date.prototype.toLocaleString = nativeToLocaleString;
  }
}

export async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
    });
  }
}

export interface ScenarioSpec {
  id: string;
  screen: string;
  state: string;
  seed: number | null;
  inputs: Record<string, unknown>;
  /** Push fixtures into the mocked modules before rendering. */
  arrange: () => void | Promise<void>;
  element: () => React.ReactElement;
  /** Interact with the rendered tree (tap tabs, etc.) before auditing. */
  interact?: (renderer: TestRenderer.ReactTestRenderer) => Promise<void>;
  /** Text every render of this state must contain (VERIFIED assertions). */
  mustContain?: string[];
  /** Text no render of this state may contain. */
  mustNotContain?: string[];
  contentInset?: number;
  locale?: string | null;
  /** Keep full text/control dumps (large); default only for the base cell. */
  verbose?: boolean;
}

export interface RunOptions {
  cell: Cell;
  verbose: boolean;
}

export async function runScenario(
  spec: ScenarioSpec,
  opts: RunOptions,
): Promise<ScenarioResult> {
  setCell(opts.cell);
  const consoleErrors: string[] = [];
  const errSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(a => String(a))
          .join(' ')
          .slice(0, 300),
      );
    });
  const warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        '[warn] ' +
          args
            .map(a => String(a))
            .join(' ')
            .slice(0, 300),
      );
    });

  let json: ReactTestRendererJSON | ReactTestRendererJSON[] | null = null;
  let threw: string | null = null;
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  const started = Date.now();
  try {
    await withLocale(spec.locale ?? null, async () => {
      await spec.arrange();
      await act(async () => {
        renderer = TestRenderer.create(spec.element());
      });
      await flush();
      if (spec.interact && renderer) {
        await spec.interact(renderer);
        await flush();
      }
      json = renderer ? renderer.toJSON() : null;
    });
  } catch (error) {
    threw =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  }
  const renderMs = Date.now() - started;

  let audit: TreeAudit = {
    texts: [],
    controls: [],
    focusOrder: [],
    issues: [],
    directionalIcons: 0,
    explicitHorizontalStyles: 0,
  };
  if (json !== null) {
    audit = auditTree(json, opts.cell, { contentInset: spec.contentInset });
  }
  const issues: Issue[] = [...audit.issues];
  if (threw) {
    issues.push({
      kind: 'render.threw',
      severityHint: 'P1',
      confidence: 'VERIFIED',
      path: '',
      detail: threw,
    });
  }
  const fullText = audit.texts.map(t => t.text).join(' \u241E ');
  for (const needle of spec.mustContain ?? []) {
    if (!fullText.includes(needle)) {
      issues.push({
        kind: 'state.expectedCopyMissing',
        severityHint: 'P2',
        confidence: 'VERIFIED',
        path: '',
        detail: `expected "${needle}" in state "${spec.state}"`,
      });
    }
  }
  for (const needle of spec.mustNotContain ?? []) {
    if (fullText.includes(needle)) {
      issues.push({
        kind: 'state.unexpectedCopyPresent',
        severityHint: 'P2',
        confidence: 'VERIFIED',
        path: '',
        detail: `unexpected "${needle}" in state "${spec.state}"`,
      });
    }
  }
  if (json !== null && audit.texts.length === 0) {
    issues.push({
      kind: 'render.blank',
      severityHint: 'P1',
      confidence: 'VERIFIED',
      path: '',
      detail: 'screen rendered no text at all',
    });
  }
  const realErrors = consoleErrors.filter(
    e =>
      !/not wrapped in act|ReactDOMTestUtils|Animated: `useNativeDriver`/.test(
        e,
      ),
  );
  for (const e of realErrors) {
    issues.push({
      kind: 'render.consoleError',
      severityHint: 'P3',
      confidence: 'VERIFIED',
      path: '',
      detail: e,
    });
  }

  try {
    if (renderer) {
      const r = renderer as TestRenderer.ReactTestRenderer;
      act(() => r.unmount());
    }
  } catch {
    // unmount failures are recorded through consoleErrors already
  }
  errSpy.mockRestore();
  warnSpy.mockRestore();

  const cellTag = `fs${opts.cell.fontScale}@${opts.cell.width}${opts.cell.rtl ? '-rtl' : ''}`;
  return {
    id: `${spec.id}#${cellTag}${spec.locale ? `#${spec.locale}` : ''}`,
    screen: spec.screen,
    state: spec.state,
    seed: spec.seed,
    cell: opts.cell,
    inputs: { ...spec.inputs, locale: spec.locale ?? 'default' },
    renderMs,
    threw,
    textCount: audit.texts.length,
    controlCount: audit.controls.length,
    issues,
    focusOrder: opts.verbose ? audit.focusOrder : undefined,
    texts: opts.verbose ? audit.texts : undefined,
    controls: opts.verbose ? audit.controls : undefined,
    notes: consoleErrors.length ? consoleErrors.slice(0, 20) : undefined,
  };
}

/** Run one spec across every matrix cell; verbose dump on the base cell. */
export async function runMatrix(
  spec: ScenarioSpec,
  cells: Cell[],
): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = [];
  for (const cell of cells) {
    const verbose =
      spec.verbose ?? (cell.fontScale === 1 && cell.width === 375 && !cell.rtl);
    out.push(await runScenario(spec, { cell, verbose }));
  }
  return out;
}

export function findByProp(
  renderer: TestRenderer.ReactTestRenderer,
  predicate: (props: Record<string, unknown>) => boolean,
) {
  return renderer.root.findAll(
    node =>
      predicate(node.props as Record<string, unknown>) &&
      typeof node.type === 'string',
  );
}

export async function press(
  node: TestRenderer.ReactTestInstance,
): Promise<void> {
  const onPress = node.props.onPress ?? node.props.onClick;
  if (typeof onPress !== 'function')
    throw new Error(`node ${String(node.type)} has no onPress`);
  await act(async () => {
    onPress();
  });
  await flush();
}
