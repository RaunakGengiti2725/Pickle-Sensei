/**
 * Rendered-tree accessibility + hit-target audit.
 *
 * Walks the HOST nodes of a react-test-renderer tree (the props React Native
 * hands to the native views) and reports every interactive element that is
 * missing an accessible role/label or whose modelled hit target is below
 * Apple's 44 × 44 pt minimum.
 *
 * Interactive = a `TextInput`, or a `View` carrying the Pressability
 * responder handlers (`onResponderGrant`) that `Pressable` installs.
 *
 * Size model (documented, deterministic — Linux has no Yoga/CoreText):
 *   height = style.height ?? style.minHeight ?? paddingV + Σ text lineHeight·scale
 *   width  = style.width  ?? style.minWidth  ?? paddingH + Σ text chars·em·fontSize·scale
 *   absolute-fill (`position:absolute, top/bottom/left/right = 0`) = window
 *   hitSlop (number or Insets) extends both axes.
 * Text advances use 0.55 em per code point (Manrope averages ≈ 0.52–0.58 em
 * for Latin; a conservative middle keeps the estimate honest for uppercase
 * and letter-spaced labels).
 */
import { StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

export const MIN_TARGET_PT = 44;
const AVG_CHAR_EM = 0.55;

export interface ElementReport {
  path: string;
  type: string;
  role: string | undefined;
  label: string | undefined;
  visibleText: string;
  width: number;
  height: number;
  hitSlop: { top: number; bottom: number; left: number; right: number };
  sizeBasis: string;
}

export interface A11yIssue {
  kind: 'no-role' | 'unlabeled' | 'small-target' | 'not-accessible';
  path: string;
  detail: string;
}

export interface A11yAudit {
  elements: ElementReport[];
  issues: A11yIssue[];
}

type FlatStyle = Record<string, unknown>;

function flat(style: unknown): FlatStyle {
  const flattened = StyleSheet.flatten(style as never) as
    FlatStyle | null | undefined;
  return flattened ?? {};
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function isHost(node: ReactTestInstance): boolean {
  return typeof node.type === 'string';
}

function hostChildren(node: ReactTestInstance): ReactTestInstance[] {
  const out: ReactTestInstance[] = [];
  const visit = (child: ReactTestInstance | string) => {
    if (typeof child === 'string') return;
    if (isHost(child)) {
      out.push(child);
      return;
    }
    for (const grandchild of child.children) visit(grandchild);
  };
  for (const child of node.children) visit(child);
  return out;
}

function textOf(node: ReactTestInstance): string {
  const parts: string[] = [];
  const visit = (child: ReactTestInstance | string) => {
    if (typeof child === 'string') {
      parts.push(child);
      return;
    }
    for (const grandchild of child.children) visit(grandchild);
  };
  for (const child of node.children) visit(child);
  return parts.join('');
}

interface TextRun {
  text: string;
  fontSize: number;
  lineHeight: number;
  scalable: boolean;
  maxMultiplier: number | undefined;
}

function textRuns(node: ReactTestInstance): TextRun[] {
  return node
    .findAll(child => isHost(child) && String(child.type) === 'Text')
    .filter(child => child !== node)
    .map(child => {
      const style = flat(child.props.style);
      const fontSize = num(style.fontSize) ?? 14;
      return {
        text: textOf(child),
        fontSize,
        lineHeight: num(style.lineHeight) ?? Math.round(fontSize * 1.2),
        scalable: child.props.allowFontScaling !== false,
        maxMultiplier: num(child.props.maxFontSizeMultiplier),
      };
    });
}

function effectiveScale(run: TextRun, fontScale: number): number {
  if (!run.scalable) return 1;
  if (run.maxMultiplier !== undefined && run.maxMultiplier >= 1) {
    return Math.min(fontScale, run.maxMultiplier);
  }
  return fontScale;
}

export function estimateTextWidth(
  text: string,
  fontSize: number,
  fontScale: number,
  letterSpacing = 0,
): number {
  const codePoints = Array.from(text).length;
  return codePoints * (AVG_CHAR_EM * fontSize * fontScale + letterSpacing);
}

function hitSlopOf(node: ReactTestInstance) {
  const raw = node.props.hitSlop as
    | number
    | { top?: number; bottom?: number; left?: number; right?: number }
    | undefined;
  if (typeof raw === 'number') {
    return { top: raw, bottom: raw, left: raw, right: raw };
  }
  return {
    top: raw?.top ?? 0,
    bottom: raw?.bottom ?? 0,
    left: raw?.left ?? 0,
    right: raw?.right ?? 0,
  };
}

function pathTo(node: ReactTestInstance, root: ReactTestInstance): string {
  const segments: string[] = [];
  let current: ReactTestInstance | null = node;
  while (current && current !== root) {
    const parent: ReactTestInstance | null = current.parent;
    if (!parent) break;
    const index = parent.children.indexOf(current);
    const name =
      typeof current.type === 'string'
        ? current.type
        : ((current.type as { name?: string }).name ?? 'Component');
    segments.unshift(`${name}[${index}]`);
    current = parent;
  }
  return segments.join('/');
}

export interface AuditOptions {
  fontScale: number;
  windowWidth: number;
  windowHeight: number;
  /** Width available to a wrapping element (defaults to the window width). */
  containerWidth?: number;
}

export function isInteractiveHost(node: ReactTestInstance): boolean {
  if (!isHost(node)) return false;
  const type = String(node.type);
  if (type === 'TextInput') return true;
  return (
    typeof node.props.onResponderGrant === 'function' ||
    typeof node.props.onClick === 'function'
  );
}

function nearestComposite(node: ReactTestInstance): ReactTestInstance | null {
  let current = node.parent;
  while (current) {
    if (!isHost(current)) return current;
    current = current.parent;
  }
  return null;
}

interface Box {
  paddingV: number;
  paddingH: number;
  border: number;
}

function boxOf(style: Record<string, unknown>): Box {
  const paddingV =
    (num(style.paddingTop) ??
      num(style.paddingVertical) ??
      num(style.padding) ??
      0) +
    (num(style.paddingBottom) ??
      num(style.paddingVertical) ??
      num(style.padding) ??
      0);
  const paddingH =
    (num(style.paddingLeft) ??
      num(style.paddingHorizontal) ??
      num(style.padding) ??
      0) +
    (num(style.paddingRight) ??
      num(style.paddingHorizontal) ??
      num(style.padding) ??
      0);
  return { paddingV, paddingH, border: (num(style.borderWidth) ?? 0) * 2 };
}

/** Sum of padding/border along the host chain from `leaf` up to `node`. */
function chainBox(leaf: ReactTestInstance, node: ReactTestInstance): Box {
  const total: Box = { paddingV: 0, paddingH: 0, border: 0 };
  let current: ReactTestInstance | null = leaf.parent;
  while (current) {
    if (isHost(current)) {
      const box = boxOf(flat(current.props.style));
      total.paddingV += box.paddingV;
      total.paddingH += box.paddingH;
      total.border += box.border;
    }
    if (current === node) break;
    current = current.parent;
  }
  return total;
}

/**
 * Deterministic size model for a pressable host: the largest of its own
 * explicit/min size, any descendant container's explicit/min size (e.g. the
 * shared Button's inner content row) and every text run's padded extent.
 * Text advance uses the documented 0.55 em per code point approximation.
 */
function intrinsicSize(
  node: ReactTestInstance,
  runs: readonly TextRun[],
  fontScale: number,
  containerWidth: number,
): { width: number; height: number; basis: string } {
  const style = flat(node.props.style);
  const explicitHeight = num(style.height);
  const explicitWidth = num(style.width);
  const heightCandidates: Array<[number, string]> = [
    [num(style.minHeight) ?? 0, 'minHeight'],
  ];
  const widthCandidates: Array<[number, string]> = [
    [num(style.minWidth) ?? 0, 'minWidth'],
  ];
  for (const child of node.findAll(isHost)) {
    if (child === node || String(child.type) === 'Text') continue;
    const childStyle = flat(child.props.style);
    const h = num(childStyle.height) ?? num(childStyle.minHeight);
    const w = num(childStyle.width) ?? num(childStyle.minWidth);
    if (h !== undefined) heightCandidates.push([h, 'descendant-minHeight']);
    if (w !== undefined) widthCandidates.push([w, 'descendant-minWidth']);
  }
  const textNodes = node
    .findAll(child => isHost(child) && String(child.type) === 'Text')
    .filter(child => child !== node);
  textNodes.forEach((textNode, index) => {
    const run = runs[index];
    if (!run) return;
    const box = chainBox(textNode, node);
    const scale = effectiveScale(run, fontScale);
    const advance = estimateTextWidth(run.text, run.fontSize, scale);
    const contentWidth = Math.max(
      1,
      containerWidth - box.paddingH - box.border,
    );
    const lines =
      run.text.length === 0
        ? 0
        : Math.max(1, Math.ceil(advance / contentWidth));
    heightCandidates.push([
      box.paddingV + box.border + lines * run.lineHeight * scale,
      'padding+text',
    ]);
    widthCandidates.push([
      box.paddingH + box.border + Math.min(advance, contentWidth),
      'padding+text',
    ]);
  });
  if (String(node.type) === 'TextInput') {
    const box = boxOf(style);
    const fontSize = num(style.fontSize) ?? 14;
    heightCandidates.push([
      box.paddingV +
        box.border +
        (num(style.lineHeight) ?? fontSize * 1.2) * fontScale,
      'padding+text',
    ]);
    widthCandidates.push([containerWidth, 'container']);
  }
  const best = (candidates: Array<[number, string]>) =>
    candidates.reduce((a, b) => (b[0] > a[0] ? b : a));
  const bestH = best(heightCandidates);
  const bestW = best(widthCandidates);
  return {
    height: explicitHeight ?? bestH[0],
    width: explicitWidth ?? bestW[0],
    basis: `height:${explicitHeight !== undefined ? 'explicit' : bestH[1]},width:${explicitWidth !== undefined ? 'explicit' : bestW[1]}`,
  };
}

export function auditInteractive(
  root: ReactTestInstance,
  options: AuditOptions,
): A11yAudit {
  const elements: ElementReport[] = [];
  const issues: A11yIssue[] = [];
  const nodes = root.findAll(isInteractiveHost);

  for (const node of nodes) {
    const path = pathTo(node, root);
    const type = String(node.type);
    const style = flat(node.props.style);
    const composite = nearestComposite(node);
    const hitSlop = hitSlopOf(node);
    const compositeSlop = composite ? hitSlopOf(composite) : hitSlop;
    const slop = {
      top: Math.max(hitSlop.top, compositeSlop.top),
      bottom: Math.max(hitSlop.bottom, compositeSlop.bottom),
      left: Math.max(hitSlop.left, compositeSlop.left),
      right: Math.max(hitSlop.right, compositeSlop.right),
    };
    const role = (node.props.accessibilityRole ?? node.props.role) as
      string | undefined;
    const label = node.props.accessibilityLabel as string | undefined;
    const visibleText = textOf(node);
    const runs = textRuns(node);
    const containerWidth = options.containerWidth ?? options.windowWidth;

    let width: number;
    let height: number;
    let sizeBasis: string;
    const absoluteFill =
      style.position === 'absolute' &&
      num(style.top) === 0 &&
      num(style.bottom) === 0 &&
      num(style.left) === 0 &&
      num(style.right) === 0;
    if (absoluteFill) {
      width = options.windowWidth;
      height = options.windowHeight;
      sizeBasis = 'absolute-fill=window';
    } else {
      const size = intrinsicSize(node, runs, options.fontScale, containerWidth);
      width = size.width;
      height = size.height;
      sizeBasis = size.basis;
    }
    const hitWidth = width + slop.left + slop.right;
    const hitHeight = height + slop.top + slop.bottom;

    elements.push({
      path,
      type,
      role,
      label,
      visibleText,
      width: Math.round(hitWidth * 100) / 100,
      height: Math.round(hitHeight * 100) / 100,
      hitSlop: slop,
      sizeBasis,
    });

    if (type !== 'TextInput') {
      if (!role) {
        issues.push({
          kind: 'no-role',
          path,
          detail: `interactive ${type} without accessibilityRole`,
        });
      }
      if (node.props.accessible === false) {
        issues.push({
          kind: 'not-accessible',
          path,
          detail: 'interactive element marked accessible=false',
        });
      }
    }
    const hasLabel = typeof label === 'string' && label.trim().length > 0;
    const hasText = visibleText.trim().length > 0;
    if (!hasLabel && !hasText) {
      issues.push({
        kind: 'unlabeled',
        path,
        detail: `interactive ${type} has neither accessibilityLabel nor text`,
      });
    }
    if (
      sizeBasis !== 'absolute-fill=window' &&
      (hitWidth < MIN_TARGET_PT || hitHeight < MIN_TARGET_PT)
    ) {
      issues.push({
        kind: 'small-target',
        path,
        detail: `${label ?? visibleText ?? type}: ${hitWidth.toFixed(1)}×${hitHeight.toFixed(1)}pt (${sizeBasis}) < ${MIN_TARGET_PT}`,
      });
    }
  }

  return { elements, issues };
}

/** Every `Text` node in the tree with its scaling posture, for evidence. */
export function textScalingReport(root: ReactTestInstance) {
  return root
    .findAll(node => isHost(node) && String(node.type) === 'Text')
    .map(node => {
      const style = flat(node.props.style);
      return {
        text: textOf(node),
        fontSize: num(style.fontSize),
        lineHeight: num(style.lineHeight),
        numberOfLines: num(node.props.numberOfLines),
        allowFontScaling: node.props.allowFontScaling !== false,
        maxFontSizeMultiplier: num(node.props.maxFontSizeMultiplier),
      };
    });
}

/** Compact host-only rendered tree (evidence artifact for failures). */
export function compactTree(node: ReactTestInstance): unknown {
  const children = hostChildren(node).map(compactTree);
  const style = flat(node.props.style);
  const picked: Record<string, unknown> = {};
  for (const key of [
    'accessibilityRole',
    'accessibilityLabel',
    'accessibilityState',
    'accessibilityViewIsModal',
    'testID',
    'hitSlop',
    'numberOfLines',
    'allowFontScaling',
    'value',
    'placeholder',
    'd',
  ]) {
    if (node.props[key] !== undefined) picked[key] = node.props[key];
  }
  const text = String(node.type) === 'Text' ? textOf(node) : undefined;
  return {
    type: String(node.type),
    ...(text !== undefined ? { text } : {}),
    ...(Object.keys(picked).length > 0 ? { props: picked } : {}),
    ...(Object.keys(style).length > 0 ? { style } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}
