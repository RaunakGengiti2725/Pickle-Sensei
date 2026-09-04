/**
 * Rendered-tree inspection for the SplashScreen stress campaign.
 *
 * Everything is read from the react-test-renderer HOST tree (what the native
 * side would receive), never from component internals. Layout numbers are a
 * MODEL derived from flattened styles + Dynamic Type math — Linux cannot run
 * Yoga/UIKit, so the campaign only asserts what the style tree pins.
 */
import { StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { fs, nodeProcess, path } from '../lifecycle-persistence/nodeShim';

declare const __dirname: string;

// ─── Traversal ───────────────────────────────────────────────────────────────

export function hostNodes(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string');
}

export function byTestId(
  root: ReactTestInstance,
  testID: string,
): ReactTestInstance[] {
  return hostNodes(root).filter(node => node.props.testID === testID);
}

/** Innermost host node carrying the testID (Pressable → its host View). */
export function innermostByTestId(
  root: ReactTestInstance,
  testID: string,
): ReactTestInstance | null {
  const matches = byTestId(root, testID);
  return matches.length ? (matches[matches.length - 1] ?? null) : null;
}

export function flat(node: ReactTestInstance): Record<string, unknown> {
  return (StyleSheet.flatten(node.props.style) ?? {}) as Record<
    string,
    unknown
  >;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A host node is "interactive" when it will receive presses from the
 * responder system: Pressable/Touchable render onClick + responder handlers.
 */
export function isInteractive(node: ReactTestInstance): boolean {
  const props = node.props as Record<string, unknown>;
  return (
    typeof props.onClick === 'function' ||
    typeof props.onResponderRelease === 'function' ||
    typeof props.onStartShouldSetResponder === 'function'
  );
}

export function interactiveNodes(root: ReactTestInstance): ReactTestInstance[] {
  return hostNodes(root).filter(isInteractive);
}

export function textContent(node: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (child: ReactTestInstance | string): void => {
    if (typeof child === 'string') {
      parts.push(child);
      return;
    }
    for (const grandchild of child.children) walk(grandchild);
  };
  walk(node);
  return parts.join('');
}

export function isDescendantOf(
  node: ReactTestInstance,
  ancestor: ReactTestInstance,
): boolean {
  let cursor: ReactTestInstance | null = node.parent;
  while (cursor) {
    if (cursor === ancestor) return true;
    cursor = cursor.parent;
  }
  return false;
}

// ─── Accessibility audit ─────────────────────────────────────────────────────

export interface A11yAudit {
  interactive: number;
  unlabeled: string[];
  unroled: string[];
  /** interactive nodes whose modelled box is < 44 pt in either dimension */
  under44: string[];
}

export interface LayoutContext {
  fontScale: number;
  width: number;
  height: number;
}

export interface BoxModel {
  width: number;
  height: number;
  /** modelled text line height after Dynamic Type */
  scaledLineHeight: number | null;
  scaledFontSize: number | null;
  hitSlop: number;
  /** effective touch box incl. hitSlop */
  touchWidth: number;
  touchHeight: number;
}

/**
 * Models the pressed box of a control from its flattened style and the text
 * it contains. Text scale honours `allowFontScaling` and
 * `maxFontSizeMultiplier` exactly the way RN's Text does.
 */
export function modelBox(
  node: ReactTestInstance,
  ctx: LayoutContext,
): BoxModel {
  const style = flat(node);
  const texts = node.findAll(child => {
    const type: unknown = child.type;
    return type === 'Text' || type === 'RCTText';
  });
  let scaledLineHeight: number | null = null;
  let scaledFontSize: number | null = null;
  let textWidth = 0;
  for (const text of texts) {
    const tStyle = flat(text);
    const allow = (text.props as { allowFontScaling?: boolean })
      .allowFontScaling;
    const maxMult = (text.props as { maxFontSizeMultiplier?: number })
      .maxFontSizeMultiplier;
    let mult = allow === false ? 1 : ctx.fontScale;
    if (typeof maxMult === 'number' && maxMult >= 1) {
      mult = Math.min(mult, maxMult);
    }
    const fontSize = num(tStyle.fontSize) ?? 14;
    const lineHeight = num(tStyle.lineHeight) ?? fontSize * 1.2;
    scaledFontSize = Math.max(scaledFontSize ?? 0, fontSize * mult);
    scaledLineHeight = Math.max(scaledLineHeight ?? 0, lineHeight * mult);
    const chars = Array.from(textContent(text)).length;
    // 0.6 em average advance is a conservative Latin bold estimate.
    textWidth = Math.max(textWidth, chars * fontSize * mult * 0.6);
  }
  const padV =
    (num(style.paddingVertical) ?? num(style.paddingTop) ?? 0) +
    (num(style.paddingVertical) ?? num(style.paddingBottom) ?? 0);
  const padH =
    (num(style.paddingHorizontal) ?? num(style.paddingLeft) ?? 0) +
    (num(style.paddingHorizontal) ?? num(style.paddingRight) ?? 0);
  const contentHeight = (scaledLineHeight ?? 0) + padV;
  const contentWidth = textWidth + padH;
  const height = Math.max(
    num(style.height) ?? 0,
    num(style.minHeight) ?? 0,
    contentHeight,
  );
  const width = Math.max(
    num(style.width) ?? 0,
    num(style.minWidth) ?? 0,
    contentWidth,
  );
  const rawSlop = (node.props as { hitSlop?: number | Record<string, number> })
    .hitSlop;
  const hitSlop =
    typeof rawSlop === 'number'
      ? rawSlop
      : rawSlop
        ? Math.min(...Object.values(rawSlop))
        : 0;
  return {
    width,
    height,
    scaledLineHeight,
    scaledFontSize,
    hitSlop,
    touchWidth: width + 2 * hitSlop,
    touchHeight: height + 2 * hitSlop,
  };
}

export function auditAccessibility(
  root: ReactTestInstance,
  ctx: LayoutContext,
): A11yAudit {
  const audit: A11yAudit = {
    interactive: 0,
    unlabeled: [],
    unroled: [],
    under44: [],
  };
  for (const node of interactiveNodes(root)) {
    audit.interactive += 1;
    const props = node.props as Record<string, unknown>;
    const id = String(props.testID ?? `<${String(node.type)}>`);
    const label =
      typeof props.accessibilityLabel === 'string'
        ? props.accessibilityLabel.trim()
        : textContent(node).trim();
    if (!label) audit.unlabeled.push(id);
    if (typeof props.accessibilityRole !== 'string') audit.unroled.push(id);
    const box = modelBox(node, ctx);
    if (box.width < 44 || box.height < 44) {
      audit.under44.push(
        `${id}:${box.width.toFixed(1)}x${box.height.toFixed(1)}`,
      );
    }
  }
  return audit;
}

// ─── Compact tree dumps (rendered-tree evidence) ─────────────────────────────

const KEEP_PROPS = [
  'testID',
  'accessible',
  'accessibilityRole',
  'accessibilityLabel',
  'accessibilityViewIsModal',
  'accessibilityElementsHidden',
  'importantForAccessibility',
  'pointerEvents',
  'hitSlop',
  'allowFontScaling',
  'maxFontSizeMultiplier',
  'volume',
  'paused',
  'resizeMode',
] as const;

export interface TreeDump {
  type: string;
  props?: Record<string, unknown>;
  style?: Record<string, unknown>;
  text?: string;
  children?: TreeDump[];
}

export function dumpTree(node: ReactTestInstance | string): TreeDump {
  if (typeof node === 'string') return { type: '#text', text: node };
  const props: Record<string, unknown> = {};
  const raw = node.props as Record<string, unknown>;
  for (const key of KEEP_PROPS) {
    if (raw[key] !== undefined) props[key] = raw[key];
  }
  if (isInteractive(node)) props.interactive = true;
  const style = flat(node);
  const dump: TreeDump = { type: String(node.type) };
  if (Object.keys(props).length) dump.props = props;
  if (Object.keys(style).length) dump.style = style;
  const children = hostChildren(node).map(dumpTree);
  if (children.length) dump.children = children;
  return dump;
}

/** Nearest host (or text) descendants, looking through composite wrappers. */
function hostChildren(node: ReactTestInstance): (ReactTestInstance | string)[] {
  const out: (ReactTestInstance | string)[] = [];
  for (const child of node.children) {
    if (typeof child === 'string' || typeof child.type === 'string') {
      out.push(child);
    } else {
      out.push(...hostChildren(child));
    }
  }
  return out;
}

/** Hosts only; composite wrappers are skipped so the dump mirrors natives. */
export function dumpHostTree(root: ReactTestInstance): TreeDump[] {
  const out: TreeDump[] = [];
  const visit = (node: ReactTestInstance): void => {
    if (typeof node.type === 'string') {
      out.push(dumpTree(node));
      return;
    }
    for (const child of node.children) {
      if (typeof child !== 'string') visit(child);
    }
  };
  visit(root);
  return out;
}

/** Stable fingerprint of the a11y-relevant tree (roles, labels, ids, order). */
export function a11yFingerprint(root: ReactTestInstance): string {
  return hostNodes(root)
    .map(node => {
      const p = node.props as Record<string, unknown>;
      return [
        String(node.type),
        p.testID ?? '',
        p.accessibilityRole ?? '',
        p.accessibilityLabel ?? '',
        p.accessible ? 'a' : '',
        p.pointerEvents ?? '',
        isInteractive(node) ? 'i' : '',
      ].join('|');
    })
    .join('\n');
}

// ─── Artifacts ───────────────────────────────────────────────────────────────

/**
 * Wall-clock milliseconds unaffected by `jest.useFakeTimers()` /
 * `jest.setSystemTime()` (bound at module load, before any suite fakes the
 * clock) so per-row durations stay real while scenarios pin the system time.
 */
export const realNow: () => number = Date.now.bind(Date);

export function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress-splashscreen');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJsonArtifact(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

export interface StressRow {
  suite: string;
  scenario: string;
  seed: number | null;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  ok: boolean;
  failed: string[];
  durationMs: number;
}

export function finishRow(row: Omit<StressRow, 'ok' | 'failed'>): StressRow {
  const failed = Object.entries(row.invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  return { ...row, ok: failed.length === 0, failed };
}

export function summarizeRows(rows: StressRow[]): Record<string, unknown> {
  const byInvariant: Record<string, { checked: number; failed: number }> = {};
  for (const row of rows) {
    for (const [name, held] of Object.entries(row.invariants)) {
      const slot = (byInvariant[name] ??= { checked: 0, failed: 0 });
      slot.checked += 1;
      if (!held) slot.failed += 1;
    }
  }
  const failed = rows.filter(row => !row.ok);
  return {
    scenarios: rows.length,
    passed: rows.length - failed.length,
    failed: failed.length,
    byInvariant,
    failedScenarios: failed.map(row => ({
      scenario: row.scenario,
      seed: row.seed,
      failed: row.failed,
      inputs: row.inputs,
      observed: row.observed,
    })),
    totalDurationMs: rows.reduce((sum, row) => sum + row.durationMs, 0),
    node: nodeProcess.version,
    generatedAt: new Date().toISOString(),
  };
}
