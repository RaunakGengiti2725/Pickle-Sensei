/**
 * Rendered-tree inspection for the LibraryScreen stress campaign.
 *
 * Jest has no layout engine, so every size/width figure here is an ESTIMATE
 * derived from flattened styles (declared heights, paddings, font metrics ×
 * font scale, per-script glyph widths). Checks report which method produced
 * a number (`declared` vs `estimated`) so the results table never presents a
 * heuristic as a measured iOS layout.
 */
import { StyleSheet, Text } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

type Style = Record<string, unknown>;

export const MIN_TARGET_PT = 44;

function flatten(raw: unknown): Style {
  const resolved =
    typeof raw === 'function'
      ? (raw as (state: { pressed: boolean }) => unknown)({ pressed: false })
      : raw;
  return (StyleSheet.flatten(resolved as never) ?? {}) as Style;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isHost(node: ReactTestInstance): boolean {
  return typeof node.type === 'string';
}

function hostChildren(node: ReactTestInstance): ReactTestInstance[] {
  const out: ReactTestInstance[] = [];
  const visit = (child: ReactTestInstance | string) => {
    if (typeof child === 'string') return;
    if (isHost(child)) out.push(child);
    else child.children.forEach(visit);
  };
  node.children.forEach(visit);
  return out;
}

/** Concatenated string content of a Text node (nested Text flattened). */
export function textContent(node: ReactTestInstance): string {
  const parts: string[] = [];
  const visit = (child: ReactTestInstance | string) => {
    if (typeof child === 'string') parts.push(child);
    else child.children.forEach(visit);
  };
  node.children.forEach(visit);
  return parts.join('');
}

function paddingH(style: Style): number {
  const all = num(style['padding']) ?? 0;
  const h = num(style['paddingHorizontal']);
  const l = num(style['paddingLeft']) ?? h ?? all;
  const r = num(style['paddingRight']) ?? h ?? all;
  return l + r + (num(style['borderWidth']) ?? 0) * 2;
}

function paddingV(style: Style): number {
  const all = num(style['padding']) ?? 0;
  const v = num(style['paddingVertical']);
  const t = num(style['paddingTop']) ?? v ?? all;
  const b = num(style['paddingBottom']) ?? v ?? all;
  return t + b;
}

const COMBINING = /\p{M}/u;
const WIDE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const PICTO = /\p{Extended_Pictographic}/u;
const THAI_OR_INDIC = /[\p{Script=Thai}\p{Script=Devanagari}]/u;

/**
 * Glyph-advance estimate in points for a run of text. Average advances for
 * a humanist sans at 1em: lowercase Latin ≈ 0.52, uppercase ≈ 0.66, digits ≈
 * 0.58, space ≈ 0.28, CJK = 1.0, emoji ≈ 1.25, Thai/Indic base ≈ 0.6,
 * combining marks 0. Letter-spacing adds per glyph.
 */
export function estimateTextWidth(
  text: string,
  fontSize: number,
  letterSpacing = 0,
): number {
  let em = 0;
  let glyphs = 0;
  for (const ch of text) {
    if (COMBINING.test(ch)) continue;
    if (ch === '\u200d' || ch === '\ufe0f') continue;
    glyphs += 1;
    if (WIDE.test(ch)) em += 1;
    else if (PICTO.test(ch)) em += 1.25;
    else if (THAI_OR_INDIC.test(ch)) em += 0.6;
    else if (ch === ' ') em += 0.28;
    else if (/\d/.test(ch)) em += 0.58;
    else if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) em += 0.66;
    else em += 0.52;
  }
  return em * fontSize + glyphs * letterSpacing;
}

export interface TextMetrics {
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
}

export function textMetrics(style: Style, fontScale: number): TextMetrics {
  const fontSize = (num(style['fontSize']) ?? 14) * fontScale;
  const lineHeight = (num(style['lineHeight']) ?? fontSize * 1.2) * fontScale;
  return {
    fontSize,
    lineHeight,
    letterSpacing: num(style['letterSpacing']) ?? 0,
  };
}

/** Fixed intrinsic width of a host node inside a row, or null when it can
 * shrink (flex / flexShrink) or has no determinable width. */
function fixedWidth(
  node: ReactTestInstance,
  fontScale: number,
  isTextNode: (n: ReactTestInstance) => boolean,
): number | null {
  const style = flatten(node.props.style);
  if ((num(style['flex']) ?? 0) > 0 || (num(style['flexShrink']) ?? 0) > 0)
    return null;
  const declared = num(style['width']);
  if (declared !== null) return declared;
  if (typeof node.type === 'string' && node.type.startsWith('RNSVG')) {
    return num(node.props.width);
  }
  if (isTextNode(node)) {
    const m = textMetrics(style, fontScale);
    return estimateTextWidth(textContent(node), m.fontSize, m.letterSpacing);
  }
  // A plain View: sum of its row children or max of column children.
  const kids = hostChildren(node);
  if (kids.length === 0) return num(style['minWidth']);
  const widths = kids.map(k => fixedWidth(k, fontScale, isTextNode));
  if (widths.some(w => w === null)) return null;
  const gap = num(style['gap']) ?? 0;
  const inner =
    style['flexDirection'] === 'row'
      ? widths.reduce<number>((a, b) => a + (b ?? 0), 0) +
        gap * Math.max(0, kids.length - 1)
      : Math.max(...widths.map(w => w ?? 0));
  return inner + paddingH(style);
}

export interface WidthEstimate {
  /** Width available to the node after ancestor paddings / row siblings. */
  available: number;
  /** Whether a row ancestor already overflows on fixed siblings alone. */
  rowOverflowBy: number;
  rowPath: string[];
}

function parentOf(node: ReactTestInstance): ReactTestInstance | null {
  return node.parent ?? null;
}

/**
 * Walks from `node` to `root`, subtracting horizontal padding of every host
 * ancestor and, inside row containers, the fixed widths of host siblings
 * plus gaps. `screenWidth` is the window width the variant simulates.
 */
export function availableWidth(
  node: ReactTestInstance,
  root: ReactTestInstance,
  screenWidth: number,
  fontScale: number,
  isTextNode: (n: ReactTestInstance) => boolean,
): WidthEstimate {
  let subtract = 0;
  let cap = Number.POSITIVE_INFINITY;
  let rowOverflowBy = 0;
  const rowPath: string[] = [];
  let child: ReactTestInstance = node;
  let current = parentOf(node);
  const ownStyle = flatten(node.props.style);
  const ownMax = num(ownStyle['maxWidth']);
  if (ownMax !== null) cap = Math.min(cap, ownMax);
  while (current && current !== root) {
    if (isHost(current)) {
      const style = flatten(current.props.style);
      subtract += paddingH(style);
      const max = num(style['maxWidth']);
      if (max !== null) cap = Math.min(cap, max - subtract);
      if (style['flexDirection'] === 'row') {
        const kids = hostChildren(current);
        const gap = num(style['gap']) ?? 0;
        let siblings = gap * Math.max(0, kids.length - 1);
        for (const kid of kids) {
          if (kid === child || kid.children.includes(child)) continue;
          if (containsHost(kid, child)) continue;
          siblings += fixedWidth(kid, fontScale, isTextNode) ?? 0;
        }
        subtract += siblings;
        rowPath.push(describe(current));
      }
    }
    child = current;
    current = parentOf(current);
  }
  const available = Math.min(cap, screenWidth - subtract);
  if (available < 0) rowOverflowBy = -available;
  return { available: Math.max(0, available), rowOverflowBy, rowPath };
}

function containsHost(
  ancestor: ReactTestInstance,
  target: ReactTestInstance,
): boolean {
  let cur: ReactTestInstance | null = target;
  while (cur) {
    if (cur === ancestor) return true;
    cur = parentOf(cur);
  }
  return false;
}

function describe(node: ReactTestInstance): string {
  const style = flatten(node.props.style);
  const keys = ['minHeight', 'height', 'width', 'flexDirection']
    .filter(k => style[k] !== undefined)
    .map(k => `${k}=${String(style[k])}`)
    .join(',');
  const testId =
    typeof node.props.testID === 'string' ? `#${node.props.testID}` : '';
  return `${String(node.type)}${testId}{${keys}}`;
}

// ─── Interactive elements ────────────────────────────────────────────────────

export interface InteractiveReport {
  index: number;
  role: string | null;
  label: string;
  labelSource: 'accessibilityLabel' | 'content' | 'none';
  hint: string | null;
  disabled: boolean;
  selected: boolean | null;
  height: number | null;
  heightMethod: 'declared' | 'estimated' | 'unknown';
  width: number | null;
  widthMethod: 'declared' | 'stretch' | 'estimated';
  hitSlop: number;
  meetsTarget: boolean;
  path: string;
}

function hitSlopOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return Math.min(num(v['top']) ?? 0, num(v['bottom']) ?? 0);
  }
  return 0;
}

function pathTo(node: ReactTestInstance, root: ReactTestInstance): string {
  const parts: string[] = [];
  let cur: ReactTestInstance | null = node;
  while (cur && cur !== root) {
    if (typeof cur.type !== 'string') {
      const name =
        (cur.type as { displayName?: string; name?: string }).displayName ??
        (cur.type as { name?: string }).name ??
        'Anonymous';
      parts.push(name);
    }
    cur = parentOf(cur);
  }
  return parts.reverse().join(' > ');
}

/**
 * Every Pressable under `root`: role, label, and a ≥44pt target estimate.
 * Height is `declared` when the flattened style fixes height/minHeight,
 * `estimated` from vertical padding + the tallest text line height × font
 * scale + the tallest fixed-size icon, `unknown` when nothing is known.
 */
/**
 * React Native exports `Pressable` as `memo(forwardRef(Pressable))`; the test
 * renderer exposes only the inner function component, so identity comparison
 * against the import never matches. Match the inner component by name and
 * require an `onPress` so plain wrappers named alike are excluded.
 */
export function isPressable(node: ReactTestInstance): boolean {
  if (typeof node.type !== 'function') return false;
  const fn = node.type as { name?: string; displayName?: string };
  return (
    (fn.displayName ?? fn.name) === 'Pressable' &&
    typeof node.props.onPress === 'function'
  );
}

export function inspectInteractive(
  root: ReactTestInstance,
  fontScale: number,
): InteractiveReport[] {
  const pressables = root.findAll(isPressable);
  return pressables.map((node, index) => {
    const style = flatten(node.props.style);
    const role =
      typeof node.props.accessibilityRole === 'string'
        ? node.props.accessibilityRole
        : typeof node.props.role === 'string'
          ? node.props.role
          : null;
    const explicit =
      typeof node.props.accessibilityLabel === 'string'
        ? node.props.accessibilityLabel
        : null;
    const content = node
      .findAllByType(Text)
      .map(textContent)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const label = explicit ?? content;
    const labelSource: InteractiveReport['labelSource'] =
      explicit !== null && explicit.trim().length > 0
        ? 'accessibilityLabel'
        : content.length > 0
          ? 'content'
          : 'none';
    const state = (node.props.accessibilityState ?? {}) as Record<
      string,
      unknown
    >;
    const hitSlop = hitSlopOf(node.props.hitSlop);

    let height: number | null = null;
    let heightMethod: InteractiveReport['heightMethod'] = 'unknown';
    const declaredH = Math.max(
      num(style['height']) ?? 0,
      num(style['minHeight']) ?? 0,
    );
    if (declaredH > 0) {
      height = declaredH;
      heightMethod = 'declared';
    } else {
      const texts = node.findAllByType(Text);
      const tallestText = texts.reduce((acc, t) => {
        const m = textMetrics(flatten(t.props.style), fontScale);
        const lines = num(t.props.numberOfLines) ?? 1;
        return Math.max(acc, m.lineHeight * Math.min(lines, 1));
      }, 0);
      const icons = node
        .findAll(n => typeof n.type === 'string' && n.type.startsWith('RNSVG'))
        .map(n => num(n.props.height) ?? 0);
      const tallestIcon = icons.length ? Math.max(...icons) : 0;
      const inner = Math.max(tallestText, tallestIcon);
      if (inner > 0) {
        height = paddingV(style) + inner;
        heightMethod = 'estimated';
      }
    }

    let width: number | null = null;
    let widthMethod: InteractiveReport['widthMethod'] = 'stretch';
    const declaredW = Math.max(
      num(style['width']) ?? 0,
      num(style['minWidth']) ?? 0,
    );
    if (declaredW > 0) {
      width = declaredW;
      widthMethod = 'declared';
    } else if (
      style['alignSelf'] === 'flex-start' ||
      style['alignSelf'] === 'center'
    ) {
      widthMethod = 'estimated';
      const texts = node.findAllByType(Text);
      width =
        paddingH(style) +
        texts.reduce((acc, t) => {
          const m = textMetrics(flatten(t.props.style), fontScale);
          return Math.max(
            acc,
            estimateTextWidth(textContent(t), m.fontSize, m.letterSpacing),
          );
        }, 0);
    }

    const effectiveH = height === null ? null : height + hitSlop * 2;
    const effectiveW = width === null ? null : width + hitSlop * 2;
    const meetsTarget =
      effectiveH !== null &&
      effectiveH >= MIN_TARGET_PT &&
      (effectiveW === null || effectiveW >= MIN_TARGET_PT);

    return {
      index,
      role,
      label,
      labelSource,
      hint:
        typeof node.props.accessibilityHint === 'string'
          ? node.props.accessibilityHint
          : null,
      disabled: node.props.disabled === true || state['disabled'] === true,
      selected:
        typeof state['selected'] === 'boolean'
          ? (state['selected'] as boolean)
          : null,
      height,
      heightMethod,
      width,
      widthMethod,
      hitSlop,
      meetsTarget,
      path: pathTo(node, root),
    };
  });
}

// ─── Text checks ─────────────────────────────────────────────────────────────

export interface TextReport {
  text: string;
  numberOfLines: number | null;
  fontSize: number;
  lineHeight: number;
  availableWidth: number;
  estimatedWidth: number;
  estimatedLines: number;
  /** Text with a line cap that the estimate says needs more lines: it is
   * ellipsized (by design for the cap), recorded as an observation. */
  truncated: boolean;
  /** A row ancestor's fixed children alone exceed the row: siblings overlap
   * or get squeezed to zero width. */
  rowOverflowBy: number;
  rowPath: string[];
  path: string;
}

export function inspectTexts(
  root: ReactTestInstance,
  screenWidth: number,
  fontScale: number,
): TextReport[] {
  const isTextNode = (n: ReactTestInstance) => n.type === Text;
  // Only the outermost Text of a nested run — inner Texts inherit the box.
  const texts = root
    .findAllByType(Text)
    .filter(t => !t.parent || !ancestorIsText(t.parent, root));
  return texts.map(t => {
    const style = flatten(t.props.style);
    const m = textMetrics(style, fontScale);
    const text = textContent(t);
    const { available, rowOverflowBy, rowPath } = availableWidth(
      t,
      root,
      screenWidth,
      fontScale,
      isTextNode,
    );
    const estimatedWidth = estimateTextWidth(text, m.fontSize, m.letterSpacing);
    const estimatedLines =
      text.length === 0
        ? 0
        : Math.max(1, Math.ceil(estimatedWidth / Math.max(1, available)));
    const cap = num(t.props.numberOfLines);
    return {
      text: text.length > 120 ? `${text.slice(0, 117)}…` : text,
      numberOfLines: cap,
      fontSize: m.fontSize,
      lineHeight: m.lineHeight,
      availableWidth: Math.round(available),
      estimatedWidth: Math.round(estimatedWidth),
      estimatedLines,
      truncated: cap !== null && estimatedLines > cap,
      rowOverflowBy: Math.round(rowOverflowBy),
      rowPath,
      path: pathTo(t, root),
    };
  });
}

function ancestorIsText(node: ReactTestInstance, root: ReactTestInstance) {
  let cur: ReactTestInstance | null = node;
  while (cur && cur !== root) {
    if (cur.type === Text) return true;
    cur = parentOf(cur);
  }
  return false;
}

/**
 * Fixed-size boxes whose text content cannot fit at this font scale: e.g. a
 * 48×58 date block holding two lines whose scaled line heights sum past 58.
 * Returns one entry per offending host View.
 */
export interface FixedBoxReport {
  box: string;
  declaredHeight: number;
  declaredWidth: number | null;
  contentHeight: number;
  contentWidth: number;
  path: string;
}

export function inspectFixedBoxes(
  root: ReactTestInstance,
  fontScale: number,
): FixedBoxReport[] {
  const out: FixedBoxReport[] = [];
  const views = root.findAll(n => String(n.type) === 'View');
  for (const view of views) {
    const style = flatten(view.props.style);
    const h = num(style['height']);
    if (h === null) continue;
    const texts = hostChildren(view).filter(c => String(c.type) === 'Text');
    if (texts.length === 0) continue;
    const contentHeight =
      paddingV(style) +
      texts.reduce((acc, t) => {
        const m = textMetrics(flatten(t.props.style), fontScale);
        return acc + m.lineHeight * (num(t.props.numberOfLines) ?? 1);
      }, 0);
    const w = num(style['width']);
    const contentWidth =
      paddingH(style) +
      texts.reduce((acc, t) => {
        const m = textMetrics(flatten(t.props.style), fontScale);
        return Math.max(
          acc,
          estimateTextWidth(textContent(t), m.fontSize, m.letterSpacing),
        );
      }, 0);
    if (contentHeight > h || (w !== null && contentWidth > w)) {
      out.push({
        box: describe(view),
        declaredHeight: h,
        declaredWidth: w,
        contentHeight: Math.round(contentHeight),
        contentWidth: Math.round(contentWidth),
        path: pathTo(view, root),
      });
    }
  }
  return out;
}

const LEAK_TOKENS = [
  'NaN',
  'undefined',
  'null',
  'Invalid Date',
  '[object Object]',
];
/** `Number.prototype.toFixed` falls back to exponent notation at >= 1e21. */
const EXPONENT_NOTATION = /^-?\d(?:\.\d+)?e[+-]\d+$/;

/** Rendered strings that expose a JS placeholder the seeded inputs never
 * contained literally. */
export function textLeaks(
  root: ReactTestInstance,
  seededInputs: string[],
): { token: string; text: string; path: string }[] {
  const leaks: { token: string; text: string; path: string }[] = [];
  for (const t of root.findAllByType(Text)) {
    const text = textContent(t);
    for (const token of LEAK_TOKENS) {
      if (!text.includes(token)) continue;
      if (seededInputs.some(input => input.includes(token))) continue;
      leaks.push({ token, text, path: pathTo(t, root) });
    }
    if (EXPONENT_NOTATION.test(text.trim())) {
      leaks.push({ token: 'exponent-notation', text, path: pathTo(t, root) });
    }
  }
  return leaks;
}

// ─── Evidence serialisation ──────────────────────────────────────────────────

export interface HostTreeNode {
  type: string;
  props: Record<string, unknown>;
  style: Style;
  children: (HostTreeNode | string)[];
}

const KEEP_PROPS = [
  'accessibilityRole',
  'accessibilityLabel',
  'accessibilityHint',
  'accessibilityState',
  'accessibilityLiveRegion',
  'accessible',
  'numberOfLines',
  'testID',
  'width',
  'height',
];

function typeName(node: ReactTestInstance): string {
  if (typeof node.type === 'string') return node.type;
  const fn = node.type as { displayName?: string; name?: string };
  return fn.displayName ?? fn.name ?? 'Anonymous';
}

/** Host-only rendered tree with accessibility props and flattened styles. */
export function serializeHostTree(node: ReactTestInstance): HostTreeNode {
  const props: Record<string, unknown> = {};
  for (const key of KEEP_PROPS) {
    if (node.props[key] !== undefined) props[key] = node.props[key];
  }
  const children: (HostTreeNode | string)[] = [];
  const visit = (child: ReactTestInstance | string) => {
    if (typeof child === 'string') children.push(child);
    else if (isHost(child)) children.push(serializeHostTree(child));
    else child.children.forEach(visit);
  };
  node.children.forEach(visit);
  return {
    type: typeName(node),
    props,
    style: flatten(node.props.style),
    children,
  };
}
