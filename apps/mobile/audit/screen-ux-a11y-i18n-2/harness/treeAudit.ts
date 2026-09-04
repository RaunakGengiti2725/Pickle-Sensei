/**
 * Rendered-tree audit harness (screen-ux-a11y-i18n-2).
 *
 * Walks a react-test-renderer host tree and extracts every Text and pressable
 * element with its flattened style, then applies deterministic checks that
 * approximate what a device would do at a given font scale / viewport width:
 *
 *  - unlabeled or role-less controls (a11y),
 *  - duplicate control labels within one screen (a11y),
 *  - raw machine strings in labels/copy (undefined / NaN / ISO dates / slugs),
 *  - forbidden product copy (APP_STORE_SUBMISSION.md invariants),
 *  - text that cannot fit its fixed-height container at the cell's font scale
 *    (clip/overlap risk — Yoga does not grow a numeric `height`),
 *  - `numberOfLines` truncation at the cell's font scale and width,
 *  - touch targets whose computable size is below 44pt.
 *
 * Width/height estimates are heuristics (Jest has no layout engine) and are
 * labelled INFERRED in every artifact; presence/absence of props, roles,
 * labels and copy are VERIFIED from the rendered tree.
 */
import { StyleSheet } from 'react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';

export type Cell = { fontScale: number; width: number; rtl: boolean };

/** iOS Dynamic Type: Large (default) · xxxLarge · AX5 (largest). */
export const FONT_SCALES = [1, 1.35, 3.12] as const;
/** iPhone SE (1st gen) · iPhone 13/14/15 · iPhone Pro Max. */
export const WIDTHS = [320, 375, 430] as const;
export const MIN_TARGET_PT = 44;

/** LTR grid plus two RTL cells (I18nManager.isRTL forced true). The app has
 * no I18nManager/writingDirection reads, so RTL mirroring is entirely native;
 * these cells prove the JS tree renders identically (no throw / no blank)
 * and record every hard-coded left/right style that would NOT mirror. */
export const RTL_CELLS: Cell[] = [
  { fontScale: 1, width: 375, rtl: true },
  { fontScale: 1.35, width: 320, rtl: true },
];

export const CELLS: Cell[] = [
  ...FONT_SCALES.flatMap(fontScale =>
    WIDTHS.map(width => ({ fontScale, width, rtl: false })),
  ),
  ...RTL_CELLS,
];

type Style = Record<string, unknown>;

export interface TextRecord {
  path: string;
  text: string;
  fontSize: number;
  lineHeight: number;
  effectiveScale: number;
  numberOfLines: number | null;
  allowFontScaling: boolean;
  maxFontSizeMultiplier: number | null;
  availableWidth: number | null;
  rowShared: boolean;
  estimatedWidth: number;
  estimatedLines: number;
  fixedHeightAncestor: number | null;
  fixedHeightOverflowHidden: boolean;
  estimatedHeight: number;
  textAlign: string | null;
}

export interface ControlRecord {
  path: string;
  role: string | null;
  label: string | null;
  hint: string | null;
  state: Record<string, unknown> | null;
  disabled: boolean;
  testID: string | null;
  innerText: string;
  hitSlop: { top: number; bottom: number; left: number; right: number };
  height: number | null;
  width: number | null;
  heightSource: string;
  widthSource: string;
  effectiveHeight: number | null;
  effectiveWidth: number | null;
}

export interface Issue {
  kind: string;
  severityHint: 'P1' | 'P2' | 'P3';
  confidence: 'VERIFIED' | 'INFERRED';
  path: string;
  detail: string;
  data?: Record<string, unknown>;
}

export interface FocusEntry {
  path: string;
  role: string | null;
  label: string;
}

export interface TreeAudit {
  texts: TextRecord[];
  controls: ControlRecord[];
  focusOrder: FocusEntry[];
  issues: Issue[];
  directionalIcons: number;
  explicitHorizontalStyles: number;
}

const FORBIDDEN_COPY: Array<{ re: RegExp; why: string }> = [
  { re: /\bandroid\b/i, why: 'Android mention (iOS-only product)' },
  { re: /google play/i, why: 'Google Play mention' },
  { re: /guest mode/i, why: 'guest mode mention' },
  { re: /live court/i, why: 'Live Court mention' },
  { re: /\bDUPR\b/, why: 'DUPR mention (third-party rating brand)' },
  {
    re: /swingvision|pb ?vision|selkirk|joola|onix/i,
    why: 'competitor mention',
  },
  { re: /\d+(\.\d+)?\s*%\s*accura/i, why: 'accuracy percentage claim' },
  {
    re: /\b(most accurate|world[- ]class|#1|number one)\b/i,
    why: 'superlative',
  },
  { re: /\bAI coach\b/i, why: 'AI-coach equivalence claim' },
];

const MACHINE_TOKENS: Array<{ re: RegExp; why: string }> = [
  { re: /\bundefined\b/, why: 'literal "undefined"' },
  { re: /\bNaN\b/, why: 'literal "NaN"' },
  { re: /\bnull\b/, why: 'literal "null"' },
  { re: /\[object /, why: 'stringified object' },
  { re: /\bInfinity\b/, why: 'literal "Infinity"' },
  { re: /\d{4}-\d{2}-\d{2}T\d{2}/, why: 'raw ISO timestamp' },
];

const INTERACTIVE_ROLES = new Set([
  'button',
  'tab',
  'link',
  'switch',
  'checkbox',
  'radio',
  'menuitem',
  'togglebutton',
  'adjustable',
  'imagebutton',
  'search',
]);

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function flatten(style: unknown): Style {
  const flat = StyleSheet.flatten(style as never);
  return (flat ?? {}) as Style;
}

function horizontalInset(s: Style, key: 'padding' | 'margin'): number {
  const left =
    num(s[`${key}Left`]) ??
    num(s[`${key}Start`]) ??
    num(s[`${key}Horizontal`]) ??
    num(s[key]) ??
    0;
  const right =
    num(s[`${key}Right`]) ??
    num(s[`${key}End`]) ??
    num(s[`${key}Horizontal`]) ??
    num(s[key]) ??
    0;
  return left + right;
}

function verticalInset(s: Style, key: 'padding' | 'margin'): number {
  const top =
    num(s[`${key}Top`]) ?? num(s[`${key}Vertical`]) ?? num(s[key]) ?? 0;
  const bottom =
    num(s[`${key}Bottom`]) ?? num(s[`${key}Vertical`]) ?? num(s[key]) ?? 0;
  return top + bottom;
}

/** Approximate advance width of one glyph as a multiple of font size. */
function glyphFactor(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (ch === ' ') return 0.28;
  if (/[.,:;'’|!]/.test(ch)) return 0.28;
  if (/[0-9]/.test(ch)) return 0.6;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[a-z]/.test(ch)) return 0.53;
  // CJK unified, Hiragana/Katakana, Hangul, fullwidth forms.
  if (
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xff00 && cp <= 0xffef)
  ) {
    return 1.0;
  }
  // Cyrillic.
  if (cp >= 0x0400 && cp <= 0x04ff) return 0.6;
  // Arabic.
  if (cp >= 0x0600 && cp <= 0x06ff) return 0.5;
  // Emoji / astral.
  if (cp > 0xffff) return 1.2;
  return 0.58;
}

export function estimateTextWidth(
  text: string,
  fontSize: number,
  letterSpacing: number,
): number {
  let w = 0;
  for (const ch of text) w += glyphFactor(ch) * fontSize + letterSpacing;
  return w;
}

function longestWordWidth(
  text: string,
  fontSize: number,
  letterSpacing: number,
): number {
  return text
    .split(/\s+/)
    .reduce(
      (max, word) =>
        Math.max(max, estimateTextWidth(word, fontSize, letterSpacing)),
      0,
    );
}

type Node = ReactTestRendererJSON;

function isNode(v: unknown): v is Node {
  return !!v && typeof v === 'object' && 'type' in (v as object);
}

function childNodes(node: Node): Array<Node | string> {
  const raw: unknown[] = node.children ?? [];
  return raw.filter(
    (c): c is Node | string => isNode(c) || typeof c === 'string',
  );
}

function collectStrings(node: Node): string {
  let out = '';
  for (const c of childNodes(node)) {
    if (typeof c === 'string') out += c;
    else out += collectStrings(c);
  }
  return out;
}

function isPressable(node: Node): boolean {
  const p = node.props ?? {};
  if (typeof p.onStartShouldSetResponder === 'function') return true;
  if (typeof p.onClick === 'function') return true;
  if (typeof p.onPress === 'function') return true;
  return false;
}

function normalizeHitSlop(v: unknown): ControlRecord['hitSlop'] {
  if (typeof v === 'number') return { top: v, bottom: v, left: v, right: v };
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return {
      top: num(o.top) ?? 0,
      bottom: num(o.bottom) ?? 0,
      left: num(o.left) ?? 0,
      right: num(o.right) ?? 0,
    };
  }
  return { top: 0, bottom: 0, left: 0, right: 0 };
}

interface Frame {
  style: Style;
  parentStyle: Style;
  availableWidth: number | null;
  rowShared: boolean;
  fixedHeight: number | null;
  fixedHeightOverflowHidden: boolean;
  fixedHeightVerticalPadding: number;
  /** Height comes from an aspectRatio box (own or a flex-filled ancestor). */
  aspectDriven: boolean;
}

function pushFrame(parent: Frame, style: Style): Frame {
  const width = num(style.width);
  const maxWidth = num(style.maxWidth);
  let availableWidth = parent.availableWidth;
  let rowShared = parent.rowShared;
  if (width !== null) {
    availableWidth = width;
    rowShared = false;
  } else if (availableWidth !== null) {
    availableWidth -= horizontalInset(style, 'margin');
  }
  if (maxWidth !== null && availableWidth !== null) {
    availableWidth = Math.min(availableWidth, maxWidth);
  }
  if (availableWidth !== null) {
    availableWidth -= horizontalInset(style, 'padding');
  }
  if (style.flexDirection === 'row' || style.flexDirection === 'row-reverse') {
    rowShared = true;
  }
  const height = num(style.height);
  let fixedHeight = parent.fixedHeight;
  let overflowHidden = parent.fixedHeightOverflowHidden;
  let fixedPad = parent.fixedHeightVerticalPadding;
  if (height !== null) {
    fixedHeight = height;
    overflowHidden = style.overflow === 'hidden';
    fixedPad = verticalInset(style, 'padding');
  } else if (fixedHeight !== null) {
    fixedPad +=
      verticalInset(style, 'padding') + verticalInset(style, 'margin');
    if (style.overflow === 'hidden') overflowHidden = true;
  }
  const flex = num(style.flex);
  const aspectDriven =
    height === null &&
    (num(style.aspectRatio) !== null ||
      (parent.aspectDriven && flex !== null && flex > 0));
  return {
    style,
    parentStyle: parent.style,
    availableWidth,
    rowShared,
    fixedHeight,
    fixedHeightOverflowHidden: overflowHidden,
    fixedHeightVerticalPadding: fixedPad,
    aspectDriven,
  };
}

interface Walker {
  cell: Cell;
  texts: TextRecord[];
  controls: ControlRecord[];
  focusOrder: FocusEntry[];
  directionalIcons: number;
  explicitHorizontalStyles: number;
}

function textRecord(
  node: Node,
  frame: Frame,
  path: string,
  cell: Cell,
): TextRecord {
  const style = frame.style;
  const p = node.props ?? {};
  const fontSize = num(style.fontSize) ?? 14;
  const lineHeight = num(style.lineHeight) ?? Math.round(fontSize * 1.2);
  const letterSpacing = num(style.letterSpacing) ?? 0;
  const allowFontScaling = p.allowFontScaling !== false;
  const maxMult = num(p.maxFontSizeMultiplier);
  const effectiveScale = allowFontScaling
    ? maxMult !== null && maxMult >= 1
      ? Math.min(cell.fontScale, maxMult)
      : cell.fontScale
    : 1;
  const text = collectStrings(node);
  const estimatedWidth = estimateTextWidth(
    text,
    fontSize * effectiveScale,
    letterSpacing,
  );
  const numberOfLines = num(p.numberOfLines);
  const avail = frame.availableWidth;
  let lines = 1;
  if (avail !== null && avail > 0 && text.length > 0) {
    // Yoga wraps at word boundaries; a single word longer than the line is
    // broken by character, so total lines ≈ width / available.
    lines = Math.max(1, Math.ceil(estimatedWidth / avail));
    const explicitBreaks = (text.match(/\n/g) ?? []).length;
    lines += explicitBreaks;
  }
  const renderedLines =
    numberOfLines !== null && numberOfLines > 0
      ? Math.min(lines, numberOfLines)
      : lines;
  return {
    path,
    text,
    fontSize,
    lineHeight,
    effectiveScale,
    numberOfLines,
    allowFontScaling,
    maxFontSizeMultiplier: maxMult,
    availableWidth: avail,
    rowShared: frame.rowShared,
    estimatedWidth: Math.round(estimatedWidth),
    estimatedLines: lines,
    fixedHeightAncestor: frame.fixedHeight,
    fixedHeightOverflowHidden: frame.fixedHeightOverflowHidden,
    estimatedHeight: Math.round(renderedLines * lineHeight * effectiveScale),
    textAlign: typeof style.textAlign === 'string' ? style.textAlign : null,
  };
}

/** Sum the estimated heights of the text/svg content in a control. */
function contentSize(
  node: Node,
  frame: Frame,
  cell: Cell,
): { height: number | null; width: number | null } {
  const style = frame.style;
  const row =
    style.flexDirection === 'row' || style.flexDirection === 'row-reverse';
  const heights: number[] = [];
  const widths: number[] = [];
  const visit = (n: Node, f: Frame): void => {
    if (n.type === 'Text') {
      const rec = textRecord(
        n,
        pushFrame(f, flatten(n.props?.style)),
        '',
        cell,
      );
      heights.push(rec.estimatedHeight);
      widths.push(rec.estimatedWidth);
      return;
    }
    const w = num(n.props?.width);
    const h = num(n.props?.height);
    if (w !== null && h !== null && n.type !== 'View') {
      heights.push(h);
      widths.push(w);
      return;
    }
    const childFrame = pushFrame(f, flatten(n.props?.style));
    const fixedH = num(childFrame.style.height);
    const fixedW = num(childFrame.style.width);
    if (fixedH !== null && fixedW !== null) {
      heights.push(fixedH);
      widths.push(fixedW);
      return;
    }
    for (const c of childNodes(n)) if (isNode(c)) visit(c, childFrame);
  };
  for (const c of childNodes(node)) if (isNode(c)) visit(c, frame);
  if (heights.length === 0) return { height: null, width: null };
  const pad = verticalInset(style, 'padding');
  const hpad = horizontalInset(style, 'padding');
  return {
    height:
      (row ? Math.max(...heights) : heights.reduce((a, b) => a + b, 0)) + pad,
    width:
      (row ? widths.reduce((a, b) => a + b, 0) : Math.max(...widths)) + hpad,
  };
}

function controlRecord(
  node: Node,
  frame: Frame,
  path: string,
  cell: Cell,
): ControlRecord {
  const p = node.props ?? {};
  const style = frame.style;
  const hitSlop = normalizeHitSlop(p.hitSlop);
  const content = contentSize(node, frame, cell);
  let height = num(style.height);
  let heightSource = 'style.height';
  // Yoga derives the height of an aspectRatio box (or of a flex child
  // filling one) from its laid-out width. Row-shared widths are only an
  // upper bound here, so the height is unknowable without native layout.
  if (height === null && frame.aspectDriven) {
    heightSource = 'unknown';
  } else if (height === null) {
    const minH = num(style.minHeight);
    if (minH !== null) {
      height = Math.max(minH, content.height ?? 0);
      heightSource =
        content.height && content.height > minH ? 'content' : 'style.minHeight';
    } else if (content.height !== null) {
      height = content.height;
      heightSource = 'content';
    } else {
      heightSource = 'unknown';
    }
  }
  let width = num(style.width);
  let widthSource = 'style.width';
  if (width === null) {
    const minW = num(style.minWidth);
    const parentRow =
      frame.parentStyle.flexDirection === 'row' ||
      frame.parentStyle.flexDirection === 'row-reverse';
    const alignSelf = style.alignSelf;
    const parentAlign = frame.parentStyle.alignItems;
    // Yoga: a child of a column container stretches to the container's
    // width unless it (alignSelf) or the container (alignItems) opts out.
    const columnStretch =
      !parentRow &&
      (alignSelf === undefined ||
        alignSelf === 'auto' ||
        alignSelf === 'stretch') &&
      (parentAlign === undefined || parentAlign === 'stretch');
    const stretches =
      (num(style.flex) !== null && (num(style.flex) as number) > 0) ||
      alignSelf === 'stretch' ||
      columnStretch;
    if (minW !== null) {
      width = Math.max(minW, content.width ?? 0);
      widthSource = 'style.minWidth';
    } else if (stretches && frame.availableWidth !== null) {
      width = frame.availableWidth + horizontalInset(style, 'padding');
      widthSource =
        columnStretch &&
        !(num(style.flex) !== null && (num(style.flex) as number) > 0)
          ? 'column-stretch (parent width)'
          : 'flex/stretch (available width)';
    } else if (content.width !== null) {
      width = content.width;
      widthSource = 'content';
    } else {
      widthSource = 'unknown';
    }
  }
  const state =
    p.accessibilityState && typeof p.accessibilityState === 'object'
      ? (p.accessibilityState as Record<string, unknown>)
      : null;
  return {
    path,
    role: typeof p.accessibilityRole === 'string' ? p.accessibilityRole : null,
    label:
      typeof p.accessibilityLabel === 'string' ? p.accessibilityLabel : null,
    hint: typeof p.accessibilityHint === 'string' ? p.accessibilityHint : null,
    state,
    disabled: state?.disabled === true,
    testID: typeof p.testID === 'string' ? p.testID : null,
    innerText: collectStrings(node).replace(/\s+/g, ' ').trim(),
    hitSlop,
    height,
    width,
    heightSource,
    widthSource,
    effectiveHeight:
      height === null
        ? null
        : Math.round(height + hitSlop.top + hitSlop.bottom),
    effectiveWidth:
      width === null ? null : Math.round(width + hitSlop.left + hitSlop.right),
  };
}

function walk(node: Node, frame: Frame, path: string, w: Walker): void {
  const p = node.props ?? {};
  const style = flatten(p.style);
  const next = pushFrame(frame, style);

  if (
    style.textAlign === 'left' ||
    style.textAlign === 'right' ||
    num(style.left) !== null ||
    num(style.right) !== null
  ) {
    w.explicitHorizontalStyles += 1;
  }

  const pressable = isPressable(node);
  const role =
    typeof p.accessibilityRole === 'string' ? p.accessibilityRole : null;
  const label =
    typeof p.accessibilityLabel === 'string' ? p.accessibilityLabel : null;

  if (pressable || (role && INTERACTIVE_ROLES.has(role))) {
    w.controls.push(controlRecord(node, next, path, w.cell));
  }

  if (
    pressable ||
    label ||
    p.accessible === true ||
    role === 'alert' ||
    role === 'header'
  ) {
    w.focusOrder.push({
      path,
      role,
      label: (label ?? collectStrings(node)).replace(/\s+/g, ' ').trim(),
    });
  }

  if (node.type === 'Text') {
    w.texts.push(textRecord(node, next, path, w.cell));
    return;
  }

  childNodes(node).forEach((c, i) => {
    if (isNode(c)) walk(c, next, `${path}/${c.type}[${i}]`, w);
  });
}

export function auditTree(
  json: Node | Node[] | null,
  cell: Cell,
  options: { contentInset?: number } = {},
): TreeAudit {
  const w: Walker = {
    cell,
    texts: [],
    controls: [],
    focusOrder: [],
    directionalIcons: 0,
    explicitHorizontalStyles: 0,
  };
  const root: Frame = {
    style: {},
    parentStyle: {},
    availableWidth: cell.width - (options.contentInset ?? 0),
    rowShared: false,
    fixedHeight: null,
    fixedHeightOverflowHidden: false,
    fixedHeightVerticalPadding: 0,
    aspectDriven: false,
  };
  const roots = json === null ? [] : Array.isArray(json) ? json : [json];
  roots.forEach((n, i) => walk(n, root, `${n.type}[${i}]`, w));

  const issues: Issue[] = [];

  // ---- a11y: controls ----------------------------------------------------
  const labelCounts = new Map<string, ControlRecord[]>();
  for (const c of w.controls) {
    const name = c.label ?? c.innerText;
    if (!c.label && !c.innerText) {
      issues.push({
        kind: 'control.unlabeled',
        severityHint: 'P2',
        confidence: 'VERIFIED',
        path: c.path,
        detail: `Pressable without accessibilityLabel or text content (role=${c.role ?? 'none'}, testID=${c.testID ?? 'none'})`,
      });
    }
    if (!c.role) {
      issues.push({
        kind: 'control.roleMissing',
        severityHint: 'P3',
        confidence: 'VERIFIED',
        path: c.path,
        detail: `Pressable "${name}" has no accessibilityRole`,
      });
    }
    if (c.label) {
      for (const t of MACHINE_TOKENS) {
        if (t.re.test(c.label)) {
          issues.push({
            kind: 'control.labelMachineToken',
            severityHint: 'P2',
            confidence: 'VERIFIED',
            path: c.path,
            detail: `${t.why} in accessibilityLabel "${c.label}"`,
          });
        }
      }
      if (/[a-z]_[a-z]/.test(c.label)) {
        issues.push({
          kind: 'control.labelSlug',
          severityHint: 'P3',
          confidence: 'VERIFIED',
          path: c.path,
          detail: `snake_case slug read aloud in accessibilityLabel "${c.label}"`,
        });
      }
    }
    if (name && !c.disabled) {
      const arr = labelCounts.get(`${c.role}|${name}`) ?? [];
      arr.push(c);
      labelCounts.set(`${c.role}|${name}`, arr);
    }
    if (
      c.effectiveHeight !== null &&
      c.effectiveHeight < MIN_TARGET_PT &&
      c.heightSource !== 'unknown'
    ) {
      issues.push({
        kind: 'control.targetHeightBelow44',
        severityHint: 'P3',
        confidence: c.heightSource.startsWith('style')
          ? 'VERIFIED'
          : 'INFERRED',
        path: c.path,
        detail: `"${name}" effective height ${c.effectiveHeight}pt (${c.heightSource}${
          c.hitSlop.top + c.hitSlop.bottom
            ? ` + hitSlop ${c.hitSlop.top + c.hitSlop.bottom}`
            : ''
        }) < ${MIN_TARGET_PT}pt`,
        data: { height: c.height, hitSlop: c.hitSlop, role: c.role },
      });
    }
    if (
      c.effectiveWidth !== null &&
      c.effectiveWidth < MIN_TARGET_PT &&
      c.widthSource !== 'unknown'
    ) {
      issues.push({
        kind: 'control.targetWidthBelow44',
        severityHint: 'P3',
        confidence: c.widthSource.startsWith('style') ? 'VERIFIED' : 'INFERRED',
        path: c.path,
        detail: `"${name}" effective width ${c.effectiveWidth}pt (${c.widthSource}) < ${MIN_TARGET_PT}pt`,
        data: { width: c.width, hitSlop: c.hitSlop, role: c.role },
      });
    }
  }
  for (const [key, arr] of labelCounts) {
    if (arr.length > 1) {
      issues.push({
        kind: 'control.duplicateLabel',
        severityHint: 'P3',
        confidence: 'VERIFIED',
        path: arr.map(c => c.path).join(' | '),
        detail: `${arr.length} enabled controls share the accessible name "${key.split('|')[1]}" (role=${key.split('|')[0]})`,
        data: { count: arr.length },
      });
    }
  }

  // ---- copy ----------------------------------------------------------------
  for (const t of w.texts) {
    const text = t.text;
    if (text.length === 0) continue;
    for (const f of FORBIDDEN_COPY) {
      if (f.re.test(text)) {
        issues.push({
          kind: 'copy.forbidden',
          severityHint: 'P2',
          confidence: 'VERIFIED',
          path: t.path,
          detail: `${f.why}: "${text}"`,
        });
      }
    }
    for (const m of MACHINE_TOKENS) {
      if (m.re.test(text)) {
        issues.push({
          kind: 'copy.machineToken',
          severityHint: 'P2',
          confidence: 'VERIFIED',
          path: t.path,
          detail: `${m.why}: "${text}"`,
        });
      }
    }
    if (/^\s|\s$/.test(text) && text.trim().length > 0) {
      issues.push({
        kind: 'copy.strayWhitespace',
        severityHint: 'P3',
        confidence: 'VERIFIED',
        path: t.path,
        detail: `leading/trailing whitespace: ${JSON.stringify(text)}`,
      });
    }
    if (/\S {2,}\S/.test(text)) {
      issues.push({
        kind: 'copy.doubleSpace',
        severityHint: 'P3',
        confidence: 'VERIFIED',
        path: t.path,
        detail: `double space: ${JSON.stringify(text)}`,
      });
    }
  }

  // ---- layout at this cell ---------------------------------------------------
  for (const t of w.texts) {
    if (t.text.length === 0) continue;
    if (
      t.fixedHeightAncestor !== null &&
      t.estimatedHeight > t.fixedHeightAncestor
    ) {
      issues.push({
        kind: t.fixedHeightOverflowHidden
          ? 'layout.textClippedByFixedHeight'
          : 'layout.textOverflowsFixedHeight',
        severityHint: 'P2',
        confidence: 'INFERRED',
        path: t.path,
        detail: `"${t.text}" needs ≈${t.estimatedHeight}pt (${t.estimatedLines}×${t.lineHeight}×${t.effectiveScale}) inside height:${t.fixedHeightAncestor} ${
          t.fixedHeightOverflowHidden
            ? '(overflow hidden → clipped)'
            : '(overflow visible → overlaps neighbours)'
        }`,
        data: {
          fontScale: cell.fontScale,
          width: cell.width,
          estimatedHeight: t.estimatedHeight,
          fixedHeight: t.fixedHeightAncestor,
          lines: t.estimatedLines,
        },
      });
    }
    if (
      t.numberOfLines !== null &&
      t.numberOfLines > 0 &&
      t.estimatedLines > t.numberOfLines &&
      t.availableWidth !== null
    ) {
      issues.push({
        kind: 'layout.textTruncated',
        severityHint: 'P3',
        confidence: 'INFERRED',
        path: t.path,
        detail: `"${t.text}" ≈${t.estimatedWidth}pt vs ${Math.round(t.availableWidth)}pt available${
          t.rowShared ? ' (upper bound; row-shared)' : ''
        } → ${t.estimatedLines} lines, numberOfLines=${t.numberOfLines}`,
        data: {
          fontScale: cell.fontScale,
          width: cell.width,
          estimatedWidth: t.estimatedWidth,
          availableWidth: Math.round(t.availableWidth),
          numberOfLines: t.numberOfLines,
        },
      });
    }
    if (t.availableWidth !== null && !t.rowShared && t.numberOfLines === null) {
      const longest = longestWordWidth(
        t.text,
        t.fontSize * t.effectiveScale,
        0,
      );
      if (longest > t.availableWidth) {
        issues.push({
          kind: 'layout.wordWiderThanColumn',
          severityHint: 'P3',
          confidence: 'INFERRED',
          path: t.path,
          detail: `longest word in "${t.text.slice(0, 60)}" ≈${Math.round(longest)}pt > ${Math.round(t.availableWidth)}pt column → character-wrapped`,
          data: { fontScale: cell.fontScale, width: cell.width },
        });
      }
    }
  }

  return {
    texts: w.texts,
    controls: w.controls,
    focusOrder: w.focusOrder,
    issues,
    directionalIcons: w.directionalIcons,
    explicitHorizontalStyles: w.explicitHorizontalStyles,
  };
}

export function allText(json: Node | Node[] | null): string {
  const roots = json === null ? [] : Array.isArray(json) ? json : [json];
  return roots.map(collectStrings).join(' ').replace(/\s+/g, ' ').trim();
}
