/**
 * Rendered-tree inspection for the camera-UI stress campaign.
 *
 * react-test-renderer produces host nodes with their final props but performs
 * NO layout, so this module separates two evidence grades:
 *   - HARD facts read straight off the tree (roles, labels, `accessible`,
 *     `minHeight`, `numberOfLines`, rendered strings);
 *   - ESTIMATES derived from flattened styles with a glyph-width model
 *     (`estimated: true` on every such record). Estimates never fail a test on
 *     their own; they are reported for device confirmation.
 */
import { StyleSheet } from 'react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { space } from '../../src/design/tokens';

type Style = Record<string, unknown>;

export interface HostNode {
  path: string;
  type: string;
  props: Record<string, unknown>;
  style: Style;
  /** Concatenated string children (direct only). */
  text: string;
  ancestors: HostNode[];
  children: HostNode[];
}

export const MIN_HIT_TARGET_PT = 44;

/** Horizontal padding AnalyzeScreen puts around these components (INFERRED). */
export const SCREEN_HORIZONTAL_PADDING = space.lg * 2;

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'togglebutton',
  'tab',
  'menuitem',
  'imagebutton',
  'adjustable',
  'slider',
  'combobox',
  'spinbutton',
  'searchbox',
]);

function flattenStyle(style: unknown): Style {
  const flat = StyleSheet.flatten(style as never);
  return (flat ?? {}) as Style;
}

export function flattenTree(
  json: ReactTestRendererJSON | ReactTestRendererJSON[] | null,
): HostNode[] {
  const out: HostNode[] = [];
  const visit = (
    node: ReactTestRendererJSON | string | null,
    path: string,
    ancestors: HostNode[],
  ): HostNode | null => {
    if (node === null || typeof node === 'string') return null;
    const props = { ...(node.props as Record<string, unknown>) };
    const children = node.children ?? [];
    const text = children
      .filter((c): c is string => typeof c === 'string')
      .join('');
    const host: HostNode = {
      path,
      type: node.type,
      props,
      style: flattenStyle(props['style']),
      text,
      ancestors,
      children: [],
    };
    out.push(host);
    children.forEach((child, index) => {
      const childHost = visit(child, `${path}/${node.type}[${index}]`, [
        ...ancestors,
        host,
      ]);
      if (childHost) host.children.push(childHost);
    });
    return host;
  };
  if (Array.isArray(json)) {
    json.forEach((n, i) => visit(n, `#${i}`, []));
  } else {
    visit(json, '#0', []);
  }
  return out;
}

/** Every string rendered anywhere below (and including) this node. */
export function deepText(node: HostNode): string {
  return [node.text, ...node.children.map(deepText)].filter(Boolean).join(' ');
}

export function isInteractive(node: HostNode): boolean {
  const role = node.props['accessibilityRole'];
  return (
    typeof node.props['onClick'] === 'function' ||
    typeof node.props['onResponderRelease'] === 'function' ||
    (typeof role === 'string' && INTERACTIVE_ROLES.has(role))
  );
}

function isHiddenFromA11y(node: HostNode): boolean {
  return [node, ...node.ancestors].some(
    n =>
      n.props['importantForAccessibility'] === 'no-hide-descendants' ||
      n.props['accessibilityElementsHidden'] === true,
  );
}

export interface HitTarget {
  height: number | null;
  width: number | null;
  estimated: boolean;
  basis: string;
}

/**
 * Hit target from flattened style. Numeric `height`/`minHeight` are HARD
 * facts; `aspectRatio` + percentage width resolve against the window width
 * minus the screen padding and are marked estimated.
 */
export function hitTarget(node: HostNode, windowWidth: number): HitTarget {
  const s = node.style;
  const contentWidth = Math.max(0, windowWidth - SCREEN_HORIZONTAL_PADDING);
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  let width: number | null = num(s['width']) ?? num(s['minWidth']);
  let estimated = false;
  let basis = '';
  if (width === null) {
    if (s['width'] === '100%' || s['alignSelf'] === 'stretch') {
      width = contentWidth;
      estimated = true;
      basis += `width=${s['width'] ?? 'stretch'}→${contentWidth};`;
    }
  }
  let height: number | null = num(s['height']) ?? num(s['minHeight']);
  if (height === null && num(s['aspectRatio']) !== null && width !== null) {
    const ratio = num(s['aspectRatio']) as number;
    height = width / ratio;
    const maxHeight = num(s['maxHeight']);
    if (maxHeight !== null) height = Math.min(height, maxHeight);
    estimated = true;
    basis += `height=width/aspectRatio(${ratio})${
      maxHeight !== null ? `≤maxHeight(${maxHeight})` : ''
    }→${height.toFixed(1)};`;
  }
  if (!basis) basis = `height=${height};width=${width}`;
  return { height, width, estimated, basis };
}

export interface A11yRecord {
  path: string;
  role: string | null;
  label: string | null;
  accessible: boolean;
  disabled: boolean;
  target: HitTarget;
  hiddenFromA11y: boolean;
  problems: string[];
}

export function auditInteractive(
  nodes: HostNode[],
  windowWidth: number,
): A11yRecord[] {
  return nodes.filter(isInteractive).map(node => {
    const role =
      typeof node.props['accessibilityRole'] === 'string'
        ? (node.props['accessibilityRole'] as string)
        : null;
    const explicitLabel =
      typeof node.props['accessibilityLabel'] === 'string'
        ? (node.props['accessibilityLabel'] as string)
        : null;
    const label = explicitLabel ?? (deepText(node).trim() || null);
    const state = node.props['accessibilityState'] as
      { disabled?: boolean } | undefined;
    const target = hitTarget(node, windowWidth);
    const problems: string[] = [];
    if (!role || !INTERACTIVE_ROLES.has(role)) {
      problems.push(`missing or non-interactive accessibilityRole (${role})`);
    }
    if (!label || !label.trim()) problems.push('no accessible label');
    if (node.props['accessible'] !== true) problems.push('accessible!==true');
    if (target.height === null) {
      problems.push('hit-target height not derivable from style');
    } else if (target.height < MIN_HIT_TARGET_PT) {
      problems.push(
        `hit-target height ${target.height} < ${MIN_HIT_TARGET_PT}`,
      );
    }
    if (target.width !== null && target.width < MIN_HIT_TARGET_PT) {
      problems.push(`hit-target width ${target.width} < ${MIN_HIT_TARGET_PT}`);
    }
    return {
      path: node.path,
      role,
      label,
      accessible: node.props['accessible'] === true,
      disabled: state?.disabled === true || node.props['disabled'] === true,
      target,
      hiddenFromA11y: isHiddenFromA11y(node),
      problems,
    };
  });
}

/** Tokens that betray an unformatted or failed numeric/string conversion. */
const LEAK_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['NaN', /\bNaN\b/],
  ['undefined', /\bundefined\b/],
  ['null', /\bnull\b/],
  ['Infinity', /\bInfinity\b/],
  ['[object Object]', /\[object Object\]/],
  ['exponent', /\d(?:\.\d+)?e[+-]\d+/],
  ['negative-duration', /-\d+(?:\.\d+)?(?:s|ms)\b/],
  ['negative-percent', /-\d+%/],
];

function percentOver100(text: string): boolean {
  return [...text.matchAll(/(\d+(?:\.\d+)?)%/g)].some(m => Number(m[1]) > 100);
}

export interface TextRecord {
  path: string;
  text: string;
  fontSize: number | null;
  lineHeight: number | null;
  numberOfLines: number | null;
  allowFontScaling: boolean;
  maxFontSizeMultiplier: number | null;
  leaks: string[];
}

export function auditText(nodes: HostNode[]): TextRecord[] {
  return nodes
    .filter(n => n.type === 'Text')
    .map(node => {
      const text = deepText(node);
      const leaks = LEAK_PATTERNS.filter(([, re]) => re.test(text)).map(
        ([name]) => name,
      );
      if (percentOver100(text)) leaks.push('over-100-percent');
      const num = (v: unknown): number | null =>
        typeof v === 'number' ? v : null;
      return {
        path: node.path,
        text,
        fontSize: num(node.style['fontSize']),
        lineHeight: num(node.style['lineHeight']),
        numberOfLines: num(node.props['numberOfLines']),
        allowFontScaling: node.props['allowFontScaling'] !== false,
        maxFontSizeMultiplier: num(node.props['maxFontSizeMultiplier']),
        leaks,
      };
    });
}

/** Wide glyphs (CJK, emoji, fullwidth) occupy ~1em; others ~0.55em. */
function glyphAdvanceEm(codePoint: number): number {
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 1;
  }
  // Combining marks and format controls add no advance.
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfe0f ||
    codePoint === 0xfeff ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return 0;
  }
  return 0.55;
}

export function estimateTextWidthPx(text: string, fontSizePx: number): number {
  let em = 0;
  for (const ch of text) em += glyphAdvanceEm(ch.codePointAt(0) ?? 0);
  return em * fontSizePx;
}

export interface ClipEstimate {
  path: string;
  textPreview: string;
  estimated: true;
  scaledFontSize: number;
  availableWidth: number;
  estimatedLines: number;
  estimatedHeight: number;
  container: { path: string; height: number; overflowHidden: boolean } | null;
  fixedNumberOfLines: number | null;
  verdict: 'fits' | 'wraps' | 'estimated-clip' | 'truncated-by-numberOfLines';
}

/**
 * Glyph-model estimate of whether each Text fits, wraps, or is clipped by a
 * fixed-height `overflow: 'hidden'` ancestor at this window/font scale.
 */
export function estimateClipping(
  nodes: HostNode[],
  window: { width: number; fontScale: number },
): ClipEstimate[] {
  const contentWidth = Math.max(0, window.width - SCREEN_HORIZONTAL_PADDING);
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return nodes
    .filter(n => n.type === 'Text')
    .map(node => {
      const text = deepText(node);
      const baseFont = num(node.style['fontSize']) ?? 14;
      const baseLine = num(node.style['lineHeight']) ?? baseFont * 1.3;
      const scaling = node.props['allowFontScaling'] !== false;
      const cap = num(node.props['maxFontSizeMultiplier']);
      const factor = scaling
        ? cap !== null
          ? Math.min(window.fontScale, cap)
          : window.fontScale
        : 1;
      const scaledFontSize = baseFont * factor;
      const scaledLine = baseLine * factor;

      let available = contentWidth;
      let container: ClipEstimate['container'] = null;
      for (const anc of [...node.ancestors].reverse()) {
        const w = num(anc.style['width']);
        if (w !== null) available = Math.min(available, w);
        const padH =
          (num(anc.style['paddingHorizontal']) ??
            num(anc.style['padding']) ??
            0) *
            2 +
          (num(anc.style['paddingLeft']) ?? 0) +
          (num(anc.style['paddingRight']) ?? 0);
        available -= padH;
        const left = num(anc.style['left']);
        const right = num(anc.style['right']);
        if (
          anc.style['position'] === 'absolute' &&
          left !== null &&
          right !== null
        ) {
          available -= left + right;
        }
        const h = num(anc.style['height']) ?? num(anc.style['maxHeight']);
        if (
          container === null &&
          h !== null &&
          anc.style['overflow'] === 'hidden'
        ) {
          container = { path: anc.path, height: h, overflowHidden: true };
        }
      }
      available = Math.max(1, available);
      const widthPx = estimateTextWidthPx(text, scaledFontSize);
      const lines = Math.max(1, Math.ceil(widthPx / available));
      const fixedLines = num(node.props['numberOfLines']);
      const estimatedHeight = lines * scaledLine;
      let verdict: ClipEstimate['verdict'] = lines > 1 ? 'wraps' : 'fits';
      if (fixedLines !== null && lines > fixedLines) {
        verdict = 'truncated-by-numberOfLines';
      } else if (container && estimatedHeight > container.height) {
        verdict = 'estimated-clip';
      }
      return {
        path: node.path,
        textPreview: text.length > 60 ? `${text.slice(0, 57)}…` : text,
        estimated: true,
        scaledFontSize,
        availableWidth: available,
        estimatedLines: lines,
        estimatedHeight,
        container,
        fixedNumberOfLines: fixedLines,
        verdict,
      };
    });
}

/** Serializable outline of the host tree (types, key a11y props, text). */
export function outline(nodes: HostNode[]): string[] {
  return nodes.map(n => {
    const depth = n.ancestors.length;
    const bits: string[] = [];
    for (const key of [
      'accessibilityRole',
      'accessibilityLabel',
      'accessible',
      'importantForAccessibility',
      'numberOfLines',
    ]) {
      if (n.props[key] !== undefined) {
        bits.push(`${key}=${JSON.stringify(n.props[key])}`);
      }
    }
    const state = n.props['accessibilityState'];
    if (state && Object.keys(state as object).length > 0) {
      bits.push(`accessibilityState=${JSON.stringify(state)}`);
    }
    for (const key of ['minHeight', 'height', 'width', 'overflow']) {
      if (n.style[key] !== undefined) {
        bits.push(`${key}:${JSON.stringify(n.style[key])}`);
      }
    }
    const text = n.text
      ? ` "${n.text.length > 80 ? `${n.text.slice(0, 77)}…` : n.text}"`
      : '';
    return `${'  '.repeat(depth)}<${n.type}>${bits.length ? ' ' + bits.join(' ') : ''}${text}`;
  });
}
