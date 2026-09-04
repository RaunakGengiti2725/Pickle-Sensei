/**
 * Rendered-tree audit for React Native component stress campaigns.
 *
 * Works on the HOST tree (`renderer.toJSON()`), i.e. what the native side
 * receives: resolved accessibility props, flattened style arrays, Svg host
 * views with numeric width/height.
 *
 * Two kinds of check:
 *  1. Accessibility (VERIFIED against the host props): every node that
 *     carries a press responder must expose a role, a non-blank label, be
 *     `accessible`, and declare a hit target of at least MIN_TARGET_PT on
 *     both axes from its own resolved style (or, when no explicit size is
 *     set, from the estimated content box).
 *  2. Layout model (INFERRED — a deterministic Yoga approximation):
 *     - a row container whose children have flexShrink 0 (RN default) and
 *       whose measured flex bases exceed its inner width overflows;
 *     - a fixed-size box whose text content is wider/taller than its inner
 *       box clips that text.
 *     Text is measured with a per-script em-advance table scaled by the
 *     font scale (RN `allowFontScaling` default). Nothing here is a
 *     substitute for a device run; the numbers are reported so the
 *     reviewer can confirm on the M4 runner.
 */
import { StyleSheet } from 'react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';

export const MIN_TARGET_PT = 44;

export type HostNode = ReactTestRendererJSON;
export type HostChild = HostNode | string;

export type ViolationKind =
  | 'A11Y_MISSING_ROLE'
  | 'A11Y_MISSING_LABEL'
  | 'A11Y_LABEL_BLANK_SUBJECT'
  | 'A11Y_DUPLICATE_LABEL'
  | 'A11Y_NOT_ACCESSIBLE'
  | 'A11Y_TARGET_TOO_SMALL'
  | 'A11Y_DISABLED_STATE_MISMATCH'
  | 'LAYOUT_ROW_OVERFLOW'
  | 'LAYOUT_ROW_PADDING_INTRUSION'
  | 'LAYOUT_FIXED_BOX_CLIP'
  | 'TEXT_SENTINEL_LEAK'
  | 'TEXT_POSITION_LABEL'
  | 'TEXT_OUT_OF_DOMAIN_NUMERIC';

export interface Violation {
  kind: ViolationKind;
  /** Path of host node types + child indexes from the root, e.g. View[0]/View[3]/Text[1]. */
  path: string;
  detail: string;
  /** Trimmed rendered-tree excerpt around the offending node. */
  evidence: string;
}

type Style = Record<string, unknown>;

function flatten(style: unknown): Style {
  const flat = StyleSheet.flatten(
    style as Parameters<typeof StyleSheet.flatten>[0],
  );
  return (flat ?? {}) as Style;
}

function num(style: Style, key: string): number | undefined {
  const value = style[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function squash(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function isNode(child: HostChild | null | undefined): child is HostNode {
  return typeof child === 'object' && child !== null && 'type' in child;
}

export function childrenOf(node: HostNode): HostChild[] {
  return node.children ?? [];
}

export function textOf(node: HostChild): string {
  if (typeof node === 'string') return node;
  return childrenOf(node).map(textOf).join('');
}

export function walk(
  node: HostChild,
  visit: (node: HostNode, path: string, parent: HostNode | null) => void,
  path = `${typeof node === 'string' ? 'text' : node.type}`,
  parent: HostNode | null = null,
): void {
  if (!isNode(node)) return;
  visit(node, path, parent);
  childrenOf(node).forEach((child, index) => {
    if (isNode(child))
      walk(child, visit, `${path}/${child.type}[${index}]`, node);
  });
}

/** All Text-type host nodes (including nested Text) with their concatenated text. */
export function collectTexts(
  root: HostChild,
): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  walk(root, (node, path) => {
    if (node.type === 'Text') out.push({ path, text: textOf(node) });
  });
  return out;
}

const PROPS_TO_KEEP = new Set([
  'accessibilityRole',
  'accessibilityLabel',
  'accessibilityHint',
  'accessibilityState',
  'accessible',
  'focusable',
  'width',
  'height',
  'numberOfLines',
  'allowFontScaling',
  'maxFontSizeMultiplier',
]);

/** Compact JSON excerpt of a host node: kept props + flattened style + text children. */
export function excerpt(node: HostNode, depth = 2): string {
  const render = (n: HostChild, d: number): unknown => {
    if (typeof n === 'string') return n.length > 80 ? `${n.slice(0, 77)}…` : n;
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(n.props)) {
      if (PROPS_TO_KEEP.has(key)) props[key] = value;
    }
    const style = flatten(n.props.style);
    if (Object.keys(style).length > 0) props.style = style;
    return {
      type: n.type,
      props,
      children:
        d <= 0
          ? childrenOf(n).length > 0
            ? `…${childrenOf(n).length} children`
            : undefined
          : childrenOf(n).map(child => render(child, d - 1)),
    };
  };
  return JSON.stringify(render(node, depth));
}

// ---------------------------------------------------------------------------
// Text measurement model
// ---------------------------------------------------------------------------

export interface TextMetricsInput {
  text: string;
  fontSize: number;
  letterSpacing: number;
  lineHeight: number;
  availableWidth: number;
  numberOfLines?: number;
}

export interface TextMetrics {
  singleLineWidth: number;
  lines: number;
  width: number;
  height: number;
}

/** Combining marks (Mn/Mc/Me) and format controls (ZWJ/ZWNJ/bidi marks/BOM/VS16) have no advance. */
const ZERO_WIDTH_RE = /[\p{M}\p{Cf}\u2028\u2029]/u;
const CJK_RE = /[\u3000-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\uAC00-\uD7AF]/u;
const THAI_RE = /[\u0E00-\u0E7F]/u;
const ARABIC_RE = /[\u0600-\u06FF]/u;
const DEVANAGARI_RE = /[\u0900-\u097F]/u;
const CYRILLIC_RE = /[\u0400-\u04FF]/u;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const UPPER_RE = /[A-ZÀ-ÞĀ-Ž]/u;
const LOWER_RE = /[a-zß-öø-ÿ]/u;
const PUNCT_RE = /[.,:;'"!¡?¿()[\]{}|/\\·•\-–—]/u;

/** Advance width in em for one code point (approximate Manrope SemiBold metrics). */
export function emAdvance(cp: string): number {
  if (cp === '\n') return 0;
  if (ZERO_WIDTH_RE.test(cp)) return 0;
  if (cp === ' ' || cp === '\u00A0') return 0.26;
  if (cp === '\t') return 1.0;
  if (EMOJI_RE.test(cp)) return 1.3;
  if (CJK_RE.test(cp)) return 1.0;
  if (THAI_RE.test(cp)) return 0.55;
  if (ARABIC_RE.test(cp)) return 0.55;
  if (DEVANAGARI_RE.test(cp)) return 0.6;
  if (CYRILLIC_RE.test(cp)) return 0.6;
  if (/[0-9]/.test(cp)) return 0.6;
  if (cp === '×') return 0.6;
  if (PUNCT_RE.test(cp)) return 0.3;
  if (UPPER_RE.test(cp)) return 0.68;
  if (LOWER_RE.test(cp)) return 0.55;
  return 0.6;
}

function isBreakEverywhere(cp: string): boolean {
  return CJK_RE.test(cp) || EMOJI_RE.test(cp);
}

/**
 * Greedy word-wrap. Words that do not fit on an empty line are broken by
 * character (UIKit falls back to character wrapping for over-long words), so
 * an unbroken 240-char run never overflows a column — it wraps.
 */
export function measureText(input: TextMetricsInput): TextMetrics {
  const { fontSize, letterSpacing, lineHeight, availableWidth } = input;
  const cps = [...input.text];
  const advance = (cp: string): number => {
    const em = emAdvance(cp);
    return em === 0 ? 0 : em * fontSize + letterSpacing;
  };

  type Segment = { width: number; chars: number[]; endsWithSpace: boolean };
  const segments: Array<Segment | 'newline'> = [];
  let current: Segment | null = null;
  const flush = () => {
    if (current) segments.push(current);
    current = null;
  };
  for (const cp of cps) {
    if (cp === '\n' || cp === '\u2028' || cp === '\u2029') {
      flush();
      segments.push('newline');
      continue;
    }
    const w = advance(cp);
    if (cp === ' ' || cp === '\u00A0' || cp === '\t' || cp === '\u200B') {
      if (!current) current = { width: 0, chars: [], endsWithSpace: false };
      current.width += w;
      current.chars.push(w);
      current.endsWithSpace = true;
      flush();
      continue;
    }
    if (isBreakEverywhere(cp)) {
      flush();
      segments.push({ width: w, chars: [w], endsWithSpace: false });
      continue;
    }
    if (!current) current = { width: 0, chars: [], endsWithSpace: false };
    current.width += w;
    current.chars.push(w);
    // UIKit breaks after hyphens as well as at spaces.
    if (cp === '-' || cp === '\u2010' || cp === '\u2011' || cp === '\u00AD')
      flush();
  }
  flush();

  const singleLineWidth = segments.reduce(
    (sum, s) => (s === 'newline' ? sum : sum + s.width),
    0,
  );

  const width = Math.max(0, availableWidth);
  let lines = 1;
  let lineWidth = 0;
  let maxLineWidth = 0;
  const newline = () => {
    maxLineWidth = Math.max(maxLineWidth, lineWidth);
    lines += 1;
    lineWidth = 0;
  };
  for (const seg of segments) {
    if (seg === 'newline') {
      newline();
      continue;
    }
    if (lineWidth + seg.width <= width || seg.width === 0) {
      lineWidth += seg.width;
      continue;
    }
    if (lineWidth > 0 && seg.width <= width) {
      newline();
      lineWidth = seg.width;
      continue;
    }
    // Segment wider than a whole line: character wrap.
    if (lineWidth > 0) newline();
    for (const cw of seg.chars) {
      if (lineWidth + cw > width && lineWidth > 0) newline();
      lineWidth += cw;
    }
  }
  maxLineWidth = Math.max(maxLineWidth, lineWidth);
  if (cps.length === 0) {
    return { singleLineWidth: 0, lines: 1, width: 0, height: lineHeight };
  }
  const shown =
    input.numberOfLines && input.numberOfLines > 0
      ? Math.min(lines, input.numberOfLines)
      : lines;
  return {
    singleLineWidth,
    lines: shown,
    width: Math.min(maxLineWidth, width),
    height: shown * lineHeight,
  };
}

// ---------------------------------------------------------------------------
// Layout model
// ---------------------------------------------------------------------------

export interface LayoutOptions {
  /** Device width in pt. */
  deviceWidth: number;
  /** iOS Dynamic Type multiplier applied to fontSize/lineHeight (allowFontScaling default). */
  fontScale: number;
  /** Horizontal padding the hosting screen applies around the card. */
  screenPaddingHorizontal: number;
}

interface Box {
  /** Outer width including margins. */
  width: number;
  /** Outer height including margins. */
  height: number;
  /** flexShrink > 0 or flex > 0 (RN `flex: n` sets shrink 1). */
  shrinkable: boolean;
  /** flexGrow > 0 or flex > 0. */
  growable: boolean;
  basisZero: boolean;
}

function horizontalPadding(style: Style): number {
  const p = num(style, 'padding') ?? 0;
  const ph = num(style, 'paddingHorizontal') ?? p;
  return (num(style, 'paddingLeft') ?? ph) + (num(style, 'paddingRight') ?? ph);
}

function verticalPadding(style: Style): number {
  const p = num(style, 'padding') ?? 0;
  const pv = num(style, 'paddingVertical') ?? p;
  return (num(style, 'paddingTop') ?? pv) + (num(style, 'paddingBottom') ?? pv);
}

function horizontalMargin(style: Style): number {
  const m = num(style, 'margin') ?? 0;
  const mh = num(style, 'marginHorizontal') ?? m;
  return (num(style, 'marginLeft') ?? mh) + (num(style, 'marginRight') ?? mh);
}

function verticalMargin(style: Style): number {
  const m = num(style, 'margin') ?? 0;
  const mv = num(style, 'marginVertical') ?? m;
  return (num(style, 'marginTop') ?? mv) + (num(style, 'marginBottom') ?? mv);
}

function textStyleOf(node: HostNode, fontScale: number) {
  const style = flatten(node.props.style);
  const allow = node.props.allowFontScaling;
  const maxMul = node.props.maxFontSizeMultiplier;
  let scale = allow === false ? 1 : fontScale;
  if (typeof maxMul === 'number' && maxMul > 0) scale = Math.min(scale, maxMul);
  const fontSize = (num(style, 'fontSize') ?? 14) * scale;
  const lineHeight =
    (num(style, 'lineHeight') ?? (num(style, 'fontSize') ?? 14) * 1.2) * scale;
  const letterSpacing = num(style, 'letterSpacing') ?? 0;
  const nol = node.props.numberOfLines;
  return {
    fontSize,
    lineHeight,
    letterSpacing,
    numberOfLines: typeof nol === 'number' ? nol : undefined,
    style,
  };
}

/** Explicit width of a host node when it is fixed (style width or Svg width prop). */
function fixedWidth(node: HostNode, style: Style): number | undefined {
  const w = num(style, 'width');
  if (w !== undefined) return w;
  const propW = node.props.width;
  if (typeof propW === 'number' && node.type.startsWith('RNSVG')) return propW;
  return undefined;
}

function fixedHeight(node: HostNode, style: Style): number | undefined {
  const h = num(style, 'height');
  if (h !== undefined) return h;
  const propH = node.props.height;
  if (typeof propH === 'number' && node.type.startsWith('RNSVG')) return propH;
  return undefined;
}

export function estimateLayout(
  root: HostChild,
  options: LayoutOptions,
): Violation[] {
  const violations: Violation[] = [];
  const rootWidth = options.deviceWidth - options.screenPaddingHorizontal * 2;

  const layout = (
    node: HostChild,
    availableWidth: number,
    path: string,
    inRow: boolean,
  ): Box => {
    if (typeof node === 'string') {
      return {
        width: 0,
        height: 0,
        shrinkable: false,
        growable: false,
        basisZero: false,
      };
    }
    const style = flatten(node.props.style);
    const flex = num(style, 'flex') ?? 0;
    const shrinkable = (num(style, 'flexShrink') ?? 0) > 0 || flex > 0;
    const growable = (num(style, 'flexGrow') ?? 0) > 0 || flex > 0;
    const mh = horizontalMargin(style);
    const mv = verticalMargin(style);

    if (node.type === 'Text') {
      const ts = textStyleOf(node, options.fontScale);
      const inner = Math.max(0, availableWidth - mh);
      const metrics = measureText({
        text: textOf(node),
        fontSize: ts.fontSize,
        letterSpacing: ts.letterSpacing,
        lineHeight: ts.lineHeight,
        availableWidth: inner,
        numberOfLines: ts.numberOfLines,
      });
      const w = fixedWidth(node, style) ?? metrics.width;
      return {
        width: w + mh,
        height: (fixedHeight(node, style) ?? metrics.height) + mv,
        shrinkable,
        growable,
        basisZero: flex > 0,
      };
    }

    const fw = fixedWidth(node, style);
    const fh = fixedHeight(node, style);
    const ph = horizontalPadding(style);
    const pv = verticalPadding(style);
    const maxOuterW = fw ?? Math.max(0, availableWidth - mh);
    const innerW = Math.max(0, maxOuterW - ph);
    const gap = num(style, 'gap') ?? 0;
    const isRow =
      style.flexDirection === 'row' || style.flexDirection === 'row-reverse';
    const kids = childrenOf(node).filter(isNode);
    const boxes = kids.map(kid => {
      const kidStyle = flatten(kid.props.style);
      const kidIndex = childrenOf(node).indexOf(kid);
      const kidPath = `${path}/${kid.type}[${kidIndex}]`;
      // Yoga measures an undefined-width child AtMost(container inner width).
      const box = layout(kid, innerW, kidPath, isRow);
      const kidFlex = num(kidStyle, 'flex') ?? 0;
      return { box, kid, kidPath, basisZero: kidFlex > 0 };
    });

    let contentW: number;
    let contentH: number;
    if (isRow) {
      const bases = boxes.map(b => (b.basisZero ? 0 : b.box.width));
      const totalGap = boxes.length > 1 ? gap * (boxes.length - 1) : 0;
      const sum = bases.reduce((a, b) => a + b, 0) + totalGap;
      const anyShrinkable = boxes.some(b => b.box.shrinkable || b.basisZero);
      const shrinkCapacity = boxes
        .filter(b => b.box.shrinkable && !b.basisZero)
        .reduce((a, b) => a + b.box.width, 0);
      const overflow = sum - innerW;
      if (overflow > 0.5 && (!anyShrinkable || overflow > shrinkCapacity)) {
        const excess = anyShrinkable ? overflow - shrinkCapacity : overflow;
        // Overflow first eats the row's own padding (split when centred),
        // and only past that spills outside the border box.
        const p = num(style, 'padding') ?? 0;
        const pHoriz = num(style, 'paddingHorizontal') ?? p;
        const pl = num(style, 'paddingLeft') ?? pHoriz;
        const pr = num(style, 'paddingRight') ?? pHoriz;
        const centred = style.justifyContent === 'center';
        const slack = centred ? 2 * Math.min(pl, pr) : pr;
        const beyondBorder = excess - slack;
        violations.push({
          kind:
            beyondBorder > 0.5
              ? 'LAYOUT_ROW_OVERFLOW'
              : 'LAYOUT_ROW_PADDING_INTRUSION',
          path,
          detail:
            `row inner width ${innerW.toFixed(1)}pt < flex-basis sum ${sum.toFixed(1)}pt ` +
            `(children ${bases.map(b => b.toFixed(1)).join(' + ')}, gap ${totalGap}); ` +
            `overflow ${excess.toFixed(1)}pt past content box, ${Math.max(0, beyondBorder).toFixed(1)}pt past border box ` +
            `at deviceWidth=${options.deviceWidth} fontScale=${options.fontScale}; ` +
            `no child can shrink (RN flexShrink default 0)`,
          evidence: excerpt(node, 2),
        });
      }
      contentW = Math.min(sum, innerW);
      contentH = boxes.reduce((m, b) => Math.max(m, b.box.height), 0);
    } else {
      contentW = boxes.reduce((m, b) => Math.max(m, b.box.width), 0);
      const totalGap = boxes.length > 1 ? gap * (boxes.length - 1) : 0;
      contentH = boxes.reduce((a, b) => a + b.box.height, 0) + totalGap;
    }

    if (fw !== undefined || fh !== undefined) {
      const innerH = fh !== undefined ? fh - pv : undefined;
      const overW = fw !== undefined ? contentW - innerW : 0;
      const overH = innerH !== undefined ? contentH - innerH : 0;
      const hasText = kids.some(k => k.type === 'Text');
      if (hasText && (overW > 0.5 || overH > 0.5)) {
        violations.push({
          kind: 'LAYOUT_FIXED_BOX_CLIP',
          path,
          detail:
            `fixed box ${fw ?? '?'}×${fh ?? '?'}pt (inner ${innerW.toFixed(1)}×${
              innerH?.toFixed(1) ?? '?'
            }) holds text content ${contentW.toFixed(1)}×${contentH.toFixed(1)}pt ` +
            `(text "${textOf(node).slice(0, 40)}") at fontScale=${options.fontScale}; ` +
            `overflow w=${Math.max(0, overW).toFixed(1)} h=${Math.max(0, overH).toFixed(1)}`,
          evidence: excerpt(node, 2),
        });
      }
    }

    const minH = num(style, 'minHeight') ?? 0;
    const height = fh ?? Math.max(minH, contentH + pv);
    // In a row an auto-width view shrinks to its content; in a column it stretches.
    const outerW =
      fw ?? (inRow ? Math.min(contentW + ph, maxOuterW) : maxOuterW);
    return {
      width: outerW + mh,
      height: height + mv,
      shrinkable,
      growable,
      basisZero: flex > 0,
    };
  };

  layout(root, rootWidth, typeof root === 'string' ? 'text' : root.type, false);
  return violations;
}

// ---------------------------------------------------------------------------
// Accessibility audit
// ---------------------------------------------------------------------------

export interface InteractiveNode {
  path: string;
  node: HostNode;
  role: string | undefined;
  label: string | undefined;
  hint: string | undefined;
  disabled: boolean | undefined;
  width: number | undefined;
  height: number | undefined;
}

export function isInteractive(node: HostNode): boolean {
  const p = node.props;
  return (
    typeof p.onClick === 'function' ||
    typeof p.onPress === 'function' ||
    typeof p.onStartShouldSetResponder === 'function'
  );
}

export function collectInteractive(
  root: HostChild,
  options: LayoutOptions,
): InteractiveNode[] {
  const out: InteractiveNode[] = [];
  walk(root, (node, path) => {
    if (!isInteractive(node)) return;
    const style = flatten(node.props.style);
    const state = node.props.accessibilityState as
      { disabled?: boolean } | undefined;
    const explicitW = num(style, 'width') ?? num(style, 'minWidth');
    const explicitH = num(style, 'height') ?? num(style, 'minHeight');
    // Without an explicit size the control fills its column (alignSelf stretch
    // via PressableScale) and is as tall as its content: estimate from text.
    let height = explicitH;
    if (height === undefined) {
      let tallest = 0;
      walk(node, inner => {
        if (inner.type === 'Text') {
          tallest = Math.max(
            tallest,
            textStyleOf(inner, options.fontScale).lineHeight,
          );
        }
      });
      height = tallest + verticalPadding(style);
    }
    out.push({
      path,
      node,
      role:
        typeof node.props.accessibilityRole === 'string'
          ? node.props.accessibilityRole
          : undefined,
      label:
        typeof node.props.accessibilityLabel === 'string'
          ? node.props.accessibilityLabel
          : undefined,
      hint:
        typeof node.props.accessibilityHint === 'string'
          ? node.props.accessibilityHint
          : undefined,
      disabled: state?.disabled,
      width:
        explicitW ?? options.deviceWidth - options.screenPaddingHorizontal * 2,
      height,
    });
  });
  return out;
}

export interface A11yAuditOptions extends LayoutOptions {
  /**
   * Static label templates the component uses; a label that equals one of
   * these after trimming means the dynamic subject (drill title) was blank.
   */
  staticLabelPrefixes: readonly string[];
  /** Controls whose `disabled` flag the caller expects (by label predicate). */
  expectDisabled?: (label: string | undefined) => boolean | undefined;
}

export function auditAccessibility(
  root: HostChild,
  options: A11yAuditOptions,
): { violations: Violation[]; controls: InteractiveNode[] } {
  const violations: Violation[] = [];
  const controls = collectInteractive(root, options);
  const seenLabels = new Map<string, string>();
  for (const control of controls) {
    const ev = excerpt(control.node, 1);
    if (control.node.props.accessible !== true) {
      violations.push({
        kind: 'A11Y_NOT_ACCESSIBLE',
        path: control.path,
        detail: 'interactive host view is not accessible=true',
        evidence: ev,
      });
    }
    if (!control.role) {
      violations.push({
        kind: 'A11Y_MISSING_ROLE',
        path: control.path,
        detail: 'interactive host view has no accessibilityRole',
        evidence: ev,
      });
    }
    const label = control.label ?? textOf(control.node);
    if (label.trim().length === 0) {
      violations.push({
        kind: 'A11Y_MISSING_LABEL',
        path: control.path,
        detail:
          'interactive host view has neither accessibilityLabel nor text content',
        evidence: ev,
      });
    } else if (
      options.staticLabelPrefixes.some(
        prefix => squash(label) === squash(prefix),
      )
    ) {
      violations.push({
        kind: 'A11Y_LABEL_BLANK_SUBJECT',
        path: control.path,
        detail: `label "${label}" has no subject (title was blank)`,
        evidence: ev,
      });
    }
    const key = label.trim();
    if (key.length > 0) {
      const previous = seenLabels.get(key);
      if (previous !== undefined) {
        violations.push({
          kind: 'A11Y_DUPLICATE_LABEL',
          path: control.path,
          detail: `label "${key.slice(0, 60)}" also used by ${previous}`,
          evidence: ev,
        });
      } else {
        seenLabels.set(key, control.path);
      }
    }
    if (
      control.width === undefined ||
      control.height === undefined ||
      control.width < MIN_TARGET_PT ||
      control.height < MIN_TARGET_PT
    ) {
      violations.push({
        kind: 'A11Y_TARGET_TOO_SMALL',
        path: control.path,
        detail: `target ${control.width ?? '?'}×${control.height ?? '?'}pt < ${MIN_TARGET_PT}pt`,
        evidence: ev,
      });
    }
    const expected = options.expectDisabled?.(control.label);
    if (expected !== undefined && Boolean(control.disabled) !== expected) {
      violations.push({
        kind: 'A11Y_DISABLED_STATE_MISMATCH',
        path: control.path,
        detail: `accessibilityState.disabled=${String(
          control.disabled,
        )} but expected ${String(expected)} for "${control.label ?? ''}"`,
        evidence: ev,
      });
    }
  }
  return { violations, controls };
}

// ---------------------------------------------------------------------------
// Text sanity
// ---------------------------------------------------------------------------

const SENTINELS = [
  'undefined',
  'null',
  'NaN',
  'Infinity',
  '[object Object]',
  'Invalid Date',
];

/**
 * Flags JS sentinels that leaked into rendered text, unless the fixture
 * itself legitimately contained that literal.
 */
export function auditSentinels(
  root: HostChild,
  fixtureStrings: readonly string[],
): Violation[] {
  const violations: Violation[] = [];
  for (const { path, text } of collectTexts(root)) {
    for (const sentinel of SENTINELS) {
      if (!text.includes(sentinel)) continue;
      if (fixtureStrings.some(s => s.includes(sentinel))) continue;
      violations.push({
        kind: 'TEXT_SENTINEL_LEAK',
        path,
        detail: `rendered text contains "${sentinel}": "${text.slice(0, 80)}"`,
        evidence: text,
      });
    }
  }
  return violations;
}
