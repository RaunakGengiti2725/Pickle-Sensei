/**
 * Rendered-tree audits for the StreakCalendarScreen stress campaign.
 *
 * react-test-renderer gives us the full host tree with every prop and style
 * but NO layout engine, so the audit distinguishes two kinds of facts:
 *
 *  - VERIFIED (read straight off the tree): accessibility role / label /
 *    state on every pressable, explicit width/height/hitSlop, numberOfLines,
 *    the text actually rendered.
 *  - INFERRED (style arithmetic in the manner of
 *    __tests__/adjudicateXcUxA11yI18nPreAuthLayout.test.tsx): the size a
 *    `flex: 1` calendar day cell resolves to at a given window width, and
 *    whether its children fit at a given fontScale. Yoga would produce the
 *    same numbers for these simple row/column boxes, but the device is the
 *    only truth — every inferred value is labelled as such in the rows.
 */
import { Pressable, StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { MIN_TARGET_PT } from './corpus';

type Style = Record<string, unknown>;

export function flatStyle(instance: ReactTestInstance | null): Style {
  if (!instance) return {};
  const style: unknown = instance.props.style;
  if (style === undefined || style === null) return {};
  return (StyleSheet.flatten(style as never) ?? {}) as Style;
}

function num(style: Style, key: string): number | null {
  const value = style[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function isHost(instance: ReactTestInstance): boolean {
  return typeof instance.type === 'string';
}

/** Host type name ('View', 'Text', 'RCTScrollView', …) or null for composites. */
export function hostType(instance: ReactTestInstance): string | null {
  return typeof instance.type === 'string' ? instance.type : null;
}

/**
 * RN exports `Pressable` as `React.memo(forwardRef(...))`; the composite in
 * the test tree is the memo's inner `type`, so a plain `findAllByType` misses.
 */
const PRESSABLE_TYPES: ReadonlySet<unknown> = new Set(
  [Pressable, (Pressable as unknown as { type?: unknown }).type].filter(
    t => t !== undefined,
  ),
);

export function isPressableNode(instance: ReactTestInstance): boolean {
  return PRESSABLE_TYPES.has(instance.type);
}

function isTextHost(instance: ReactTestInstance): boolean {
  const type = hostType(instance);
  return type === 'Text' || type === 'RCTText';
}

/** First host node rendered by (or at) `instance`. */
export function firstHost(
  instance: ReactTestInstance,
): ReactTestInstance | null {
  if (isHost(instance)) return instance;
  for (const child of instance.children) {
    if (typeof child === 'string') continue;
    const found = firstHost(child);
    if (found) return found;
  }
  return null;
}

/** Every string rendered under `instance`, in tree order. */
export function collectText(instance: ReactTestInstance): string[] {
  const out: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(instance);
  return out;
}

export interface HitSlop {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function hitSlopOf(value: unknown): HitSlop {
  if (typeof value === 'number') {
    return { top: value, bottom: value, left: value, right: value };
  }
  if (value && typeof value === 'object') {
    const insets = value as Partial<HitSlop>;
    return {
      top: insets.top ?? 0,
      bottom: insets.bottom ?? 0,
      left: insets.left ?? 0,
      right: insets.right ?? 0,
    };
  }
  return { top: 0, bottom: 0, left: 0, right: 0 };
}

export interface PressableAudit {
  index: number;
  role: string | null;
  label: string | null;
  /** Text rendered inside the control (the fallback VoiceOver reads). */
  innerText: string;
  disabled: boolean;
  selected: boolean | null;
  hitSlop: HitSlop;
  /** Explicit `width`/`height` on the pressed host node (VERIFIED) or null
   * when the size comes from flex (see `estimatedSize`). */
  explicitWidth: number | null;
  explicitHeight: number | null;
  /** Style-arithmetic estimate for flex-sized controls (INFERRED). */
  estimatedWidth: number | null;
  estimatedHeight: number | null;
  sizeSource: 'explicit' | 'estimated' | 'unknown';
  visualMeetsMin: boolean | null;
  effectiveMeetsMin: boolean | null;
  hasNameForAt: boolean;
  hasRole: boolean;
  isDayCell: boolean;
}

const DAY_LABEL = /^\d{4}-\d{2}-\d{2}/;

/**
 * Horizontal inset (padding + border + margin on both sides) between `node`
 * and the ScrollView content box, summed over host ancestors. Used to solve
 * the width a `flex: 1` cell resolves to inside a 7-column row.
 */
function horizontalInsetToScroll(node: ReactTestInstance): number {
  let inset = 0;
  let current: ReactTestInstance | null = node.parent;
  while (current) {
    if (isHost(current)) {
      if (
        hostType(current) === 'RCTScrollView' ||
        hostType(current) === 'ScrollView'
      ) {
        const content = (StyleSheet.flatten(
          current.props.contentContainerStyle as never,
        ) ?? {}) as Style;
        inset += horizontalPadding(content);
        return inset;
      }
      inset += horizontalPadding(flatStyle(current));
    }
    current = current.parent;
  }
  return inset;
}

function horizontalPadding(style: Style): number {
  const ph = num(style, 'paddingHorizontal');
  const p = num(style, 'padding');
  const left = num(style, 'paddingLeft') ?? ph ?? p ?? 0;
  const right = num(style, 'paddingRight') ?? ph ?? p ?? 0;
  const bw = num(style, 'borderWidth') ?? 0;
  const bl = num(style, 'borderLeftWidth') ?? bw;
  const br = num(style, 'borderRightWidth') ?? bw;
  const mh = num(style, 'marginHorizontal');
  const m = num(style, 'margin');
  const ml = num(style, 'marginLeft') ?? mh ?? m ?? 0;
  const mr = num(style, 'marginRight') ?? mh ?? m ?? 0;
  return left + right + bl + br + ml + mr;
}

/** The 7-column week row is the nearest ancestor with `flexDirection: 'row'`. */
function columnsInRow(node: ReactTestInstance): number | null {
  let current: ReactTestInstance | null = node.parent;
  while (current) {
    if (isHost(current) && flatStyle(current)['flexDirection'] === 'row') {
      const hostChildren = current.children
        .filter((c): c is ReactTestInstance => typeof c !== 'string')
        .map(c => firstHost(c))
        .filter((c): c is ReactTestInstance => c !== null);
      const allFlex = hostChildren.every(c => num(flatStyle(c), 'flex') === 1);
      return allFlex ? hostChildren.length : null;
    }
    current = current.parent;
  }
  return null;
}

export interface DayCellGeometry {
  cellWidth: number;
  cellHeight: number;
  innerWidth: number;
  innerHeight: number;
  /** Height of icon + gap + label line + vertical padding at `fontScale`. */
  contentHeight: number;
  contentFits: boolean;
  /** Widest two-digit day number at `fontScale` vs. the inner width. */
  labelWidthEstimate: number;
  labelFits: boolean;
}

/** Nearest host ancestor satisfying `predicate`. */
export function hostAncestor(
  node: ReactTestInstance,
  predicate: (host: ReactTestInstance) => boolean,
): ReactTestInstance | null {
  let current: ReactTestInstance | null = node.parent;
  while (current) {
    if (isHost(current) && predicate(current)) return current;
    current = current.parent;
  }
  return null;
}

/**
 * Style arithmetic for one calendar day cell (INFERRED). `pressHost` is the
 * host View PressableScale renders for the cell; the enclosing
 * `styles.dayCell` host (`flex: 1`, `aspectRatio`) fixes its box.
 */
export function dayCellGeometry(
  pressHost: ReactTestInstance,
  windowWidth: number,
  fontScale: number,
): DayCellGeometry | null {
  const cellHostNode = hostAncestor(
    pressHost,
    h => num(flatStyle(h), 'aspectRatio') !== null,
  );
  if (!cellHostNode) return null;
  const cellStyle = flatStyle(cellHostNode);
  const aspect = num(cellStyle, 'aspectRatio');
  const columns = columnsInRow(cellHostNode);
  if (!aspect || !columns) return null;
  const rowWidth = windowWidth - horizontalInsetToScroll(cellHostNode);
  const cellWidth = rowWidth / columns;
  const cellHeight = cellWidth / aspect;
  const inner = flatStyle(pressHost);
  const margin = num(inner, 'margin') ?? 0;
  const innerWidth = cellWidth - 2 * margin;
  const innerHeight = cellHeight - 2 * margin;
  const gap = num(inner, 'gap') ?? 0;
  const padV = num(inner, 'paddingVertical') ?? num(inner, 'padding') ?? 0;
  const borderV = 2 * (num(inner, 'borderWidth') ?? 0);
  let iconHeight = 0;
  let lineHeight = 0;
  let fontSize = 0;
  let labelText = '';
  for (const child of pressHost.children) {
    if (typeof child === 'string') continue;
    const host = firstHost(child);
    if (!host) continue;
    if (isTextHost(host)) {
      const ts = flatStyle(host);
      const allow = host.props.allowFontScaling !== false;
      const scale = allow ? fontScale : 1;
      lineHeight = (num(ts, 'lineHeight') ?? num(ts, 'fontSize') ?? 0) * scale;
      fontSize = (num(ts, 'fontSize') ?? 0) * scale;
      labelText = collectText(host).join('');
    } else {
      const s = flatStyle(host);
      const h =
        num(s, 'height') ??
        (typeof host.props.height === 'number' ? host.props.height : null) ??
        (typeof host.props.size === 'number' ? host.props.size : null) ??
        0;
      iconHeight = Math.max(iconHeight, h);
    }
  }
  const contentHeight = iconHeight + gap + lineHeight + 2 * padV + borderV;
  // Tabular digits are ~0.6em wide in the SF/Inter class of faces.
  const labelWidthEstimate = fontSize * 0.6 * Math.max(labelText.length, 1);
  return {
    cellWidth: round2(cellWidth),
    cellHeight: round2(cellHeight),
    innerWidth: round2(innerWidth),
    innerHeight: round2(innerHeight),
    contentHeight: round2(contentHeight),
    contentFits: contentHeight <= innerHeight + 0.01,
    labelWidthEstimate: round2(labelWidthEstimate),
    labelFits: labelWidthEstimate <= innerWidth + 0.01,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Height a column container resolves to from its tallest explicitly sized
 * descendant plus its own vertical padding/border (INFERRED). Returns null
 * when no descendant carries an explicit height/minHeight/size.
 */
function childDrivenHeight(host: ReactTestInstance): number | null {
  const style = flatStyle(host);
  const padV =
    (num(style, 'paddingTop') ??
      num(style, 'paddingVertical') ??
      num(style, 'padding') ??
      0) +
    (num(style, 'paddingBottom') ??
      num(style, 'paddingVertical') ??
      num(style, 'padding') ??
      0) +
    2 * (num(style, 'borderWidth') ?? 0);
  let tallest: number | null = null;
  for (const child of host.children) {
    if (typeof child === 'string') continue;
    const childHost = firstHost(child);
    if (!childHost) continue;
    const cs = flatStyle(childHost);
    const explicit =
      num(cs, 'height') ??
      num(cs, 'minHeight') ??
      (typeof childHost.props.height === 'number'
        ? childHost.props.height
        : null) ??
      (typeof childHost.props.size === 'number'
        ? childHost.props.size
        : null) ??
      childDrivenHeight(childHost);
    if (explicit !== null) tallest = Math.max(tallest ?? 0, explicit);
  }
  return tallest === null ? null : tallest + padV;
}

/**
 * Width of a block that stretches to its column parent (INFERRED): the
 * window width minus every horizontal inset up to the ScrollView content
 * box. Null when any ancestor lays out in a row or the block does not
 * stretch (`alignSelf`/`alignItems` other than stretch).
 */
function stretchWidthEstimate(
  host: ReactTestInstance,
  windowWidth: number,
): number | null {
  const own = flatStyle(host);
  if (own['alignSelf'] !== undefined && own['alignSelf'] !== 'stretch')
    return null;
  let current: ReactTestInstance | null = host.parent;
  while (current) {
    if (isHost(current)) {
      const type = hostType(current);
      if (type === 'RCTScrollView' || type === 'ScrollView') break;
      const s = flatStyle(current);
      if (s['flexDirection'] === 'row' || s['flexDirection'] === 'row-reverse')
        return null;
      if (s['alignItems'] !== undefined && s['alignItems'] !== 'stretch')
        return null;
      if (num(s, 'width') !== null) return null;
    }
    current = current.parent;
  }
  return windowWidth - horizontalInsetToScroll(host);
}

/** Audit every Pressable in the tree (PressableScale, Button, day cells). */
export function auditPressables(
  root: ReactTestInstance,
  windowWidth: number,
  fontScale: number,
): PressableAudit[] {
  const pressables = root.findAll(isPressableNode);
  return pressables.map((pressable, index) => {
    const host = firstHost(pressable);
    const props = host?.props ?? pressable.props;
    const style = flatStyle(host);
    const role =
      typeof props.accessibilityRole === 'string'
        ? props.accessibilityRole
        : typeof props.role === 'string'
          ? props.role
          : null;
    const label =
      typeof props.accessibilityLabel === 'string'
        ? props.accessibilityLabel
        : null;
    const state = (props.accessibilityState ?? {}) as {
      disabled?: boolean;
      selected?: boolean;
    };
    const innerText = host ? collectText(host).join('').trim() : '';
    const hitSlop = hitSlopOf(props.hitSlop);
    const explicitWidth = num(style, 'width');
    const explicitHeight = num(style, 'height') ?? num(style, 'minHeight');
    const isDayCell = label !== null && DAY_LABEL.test(label);
    let estimatedWidth: number | null = null;
    let estimatedHeight: number | null = null;
    if (isDayCell && host) {
      const geometry = dayCellGeometry(host, windowWidth, fontScale);
      if (geometry) {
        estimatedWidth = geometry.innerWidth;
        estimatedHeight = geometry.innerHeight;
      }
    } else if (host) {
      if (explicitHeight === null) estimatedHeight = childDrivenHeight(host);
      if (explicitWidth === null) {
        estimatedWidth = stretchWidthEstimate(host, windowWidth);
      }
    }
    const width = explicitWidth ?? estimatedWidth;
    const height = explicitHeight ?? estimatedHeight;
    const sizeSource: PressableAudit['sizeSource'] =
      explicitWidth !== null && explicitHeight !== null
        ? 'explicit'
        : width !== null && height !== null
          ? 'estimated'
          : 'unknown';
    const visualMeetsMin =
      width !== null && height !== null
        ? width >= MIN_TARGET_PT && height >= MIN_TARGET_PT
        : null;
    const effectiveMeetsMin =
      width !== null && height !== null
        ? width + hitSlop.left + hitSlop.right >= MIN_TARGET_PT &&
          height + hitSlop.top + hitSlop.bottom >= MIN_TARGET_PT
        : null;
    return {
      index,
      role,
      label,
      innerText,
      disabled: state.disabled === true || pressable.props.disabled === true,
      selected: typeof state.selected === 'boolean' ? state.selected : null,
      hitSlop,
      explicitWidth,
      explicitHeight,
      estimatedWidth,
      estimatedHeight,
      sizeSource,
      visualMeetsMin,
      effectiveMeetsMin,
      hasNameForAt:
        (label !== null && label.trim().length > 0) || innerText.length > 0,
      hasRole: role !== null,
      isDayCell,
    };
  });
}

export interface TextAudit {
  text: string;
  numberOfLines: number | null;
  ellipsizeMode: string | null;
  fontSize: number | null;
  lineHeight: number | null;
  allowFontScaling: boolean;
  maxFontSizeMultiplier: number | null;
  /** True when this text node contains one of the campaign's hostile payloads. */
  carriesPayload: boolean;
}

export function auditTexts(
  root: ReactTestInstance,
  payloads: readonly string[],
): TextAudit[] {
  const nodes = root.findAll(n => isTextHost(n));
  const seen = new Set<ReactTestInstance>();
  const out: TextAudit[] = [];
  for (const node of nodes) {
    // Nested <Text> inside <Text> renders as one host; keep the outermost.
    let ancestor = node.parent;
    let nested = false;
    while (ancestor) {
      if (seen.has(ancestor)) {
        nested = true;
        break;
      }
      ancestor = ancestor.parent;
    }
    if (nested) continue;
    seen.add(node);
    const text = collectText(node).join('');
    const style = flatStyle(node);
    out.push({
      text,
      numberOfLines:
        typeof node.props.numberOfLines === 'number'
          ? node.props.numberOfLines
          : null,
      ellipsizeMode:
        typeof node.props.ellipsizeMode === 'string'
          ? node.props.ellipsizeMode
          : null,
      fontSize: num(style, 'fontSize'),
      lineHeight: num(style, 'lineHeight'),
      allowFontScaling: node.props.allowFontScaling !== false,
      maxFontSizeMultiplier:
        typeof node.props.maxFontSizeMultiplier === 'number'
          ? node.props.maxFontSizeMultiplier
          : null,
      carriesPayload: payloads.some(p => p.length > 0 && text.includes(p)),
    });
  }
  return out;
}

/** Compact JSON of the host tree under `instance` (props minus functions). */
export function serializeHost(instance: ReactTestInstance | null): unknown {
  if (!instance) return null;
  const walk = (node: ReactTestInstance | string): unknown => {
    if (typeof node === 'string') return node;
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      node.props as Record<string, unknown>,
    )) {
      if (key === 'children' || typeof value === 'function') continue;
      props[key] = key === 'style' ? flatStyle(node) : value;
    }
    const type =
      typeof node.type === 'string'
        ? node.type
        : ((node.type as { displayName?: string; name?: string }).displayName ??
          (node.type as { name?: string }).name ??
          'Component');
    return { type, props, children: node.children.map(walk) };
  };
  return walk(instance);
}
