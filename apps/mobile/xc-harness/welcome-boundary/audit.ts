/**
 * Rendered-tree audits for the WelcomeScreen stress campaign.
 *
 * react-test-renderer has no layout engine, so "fits / clipped / crushed"
 * are MODELED from the flattened styles the real components render
 * (fontSize, lineHeight, paddings, minHeight, numberOfLines) at the
 * scenario's fontScale and viewport — the same instrument
 * `adjudicateXcUxA11yI18nPreAuthLayout.test.tsx` uses, generalised to every
 * Text / Pressable in the tree, with text widths taken from the shipped
 * Manrope font files (fontMetrics.ts). Accessibility facts (role, label,
 * state) are read directly from the host props the screen renders.
 */
import type { ComponentType } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { measureText, wrapLines } from './fontMetrics';

/** RN exports Pressable as React.memo(Pressable); the tree holds the inner. */
export const PressableInner = (
  Pressable as unknown as { type: ComponentType<unknown> }
).type;

export interface LayoutContext {
  fontScale: number;
  width: number;
  height: number;
  insetTop: number;
  insetBottom: number;
}

export interface FlatStyle {
  [key: string]: unknown;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  letterSpacing?: number;
  minHeight?: number;
  height?: number;
  minWidth?: number;
  width?: number | string;
  maxWidth?: number;
  padding?: number;
  paddingVertical?: number;
  paddingHorizontal?: number;
  paddingTop?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  paddingRight?: number;
  borderWidth?: number;
  textAlign?: string;
  textTransform?: string;
  position?: string;
  flexGrow?: number;
  flexShrink?: number;
  flex?: number;
  overflow?: string;
}

export function flat(node: ReactTestInstance): FlatStyle {
  const style = (node.props as { style?: unknown }).style;
  return (StyleSheet.flatten(style as never) ?? {}) as FlatStyle;
}

export function textOf(node: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (child: unknown): void => {
    if (child === null || child === undefined || typeof child === 'boolean') {
      return;
    }
    if (typeof child === 'string' || typeof child === 'number') {
      parts.push(String(child));
      return;
    }
    if (Array.isArray(child)) {
      child.forEach(walk);
      return;
    }
    const maybe = child as { props?: { children?: unknown } };
    if (maybe.props) walk(maybe.props.children);
  };
  walk((node.props as { children?: unknown }).children);
  return parts.join('');
}

export function allText(root: ReactTestInstance): string[] {
  return root
    .findAllByType(Text)
    .map(textOf)
    .filter(t => t.trim().length > 0);
}

// ─── Text-width model ────────────────────────────────────────────────────────

/** One-line advance width of `text` in the style's font at `scale`. */
export function textWidth(
  text: string,
  style: FlatStyle,
  scale: number,
): number {
  return measureText(text, {
    fontFamily: style.fontFamily,
    fontSize: (style.fontSize ?? 14) * scale,
    letterSpacing: style.letterSpacing,
  }).widthPt;
}

export function effectiveScale(
  node: ReactTestInstance,
  fontScale: number,
): number {
  const props = node.props as {
    allowFontScaling?: boolean;
    maxFontSizeMultiplier?: number;
  };
  if (props.allowFontScaling === false) return 1;
  const cap = props.maxFontSizeMultiplier;
  if (typeof cap === 'number' && cap > 0) return Math.min(fontScale, cap);
  return fontScale;
}

export interface TextRow {
  text: string;
  fontFamily: string | null;
  fontSize: number;
  lineHeight: number;
  scale: number;
  availableWidth: number;
  /** Single-line advance width in pt from the shipped font's hmtx table. */
  singleLineWidth: number;
  /** Code points Manrope lacks (system-font fallback, estimated width). */
  fallbackGlyphs: number;
  lines: number;
  modeledHeight: number;
  numberOfLines: number | null;
  clipped: boolean;
  textAlign: string | null;
  inScrollView: boolean;
}

export function modelText(
  node: ReactTestInstance,
  availableWidth: number,
  ctx: LayoutContext,
  inScrollView: boolean,
): TextRow {
  const style = flat(node);
  const text = textOf(node);
  const fontSize = style.fontSize ?? 14;
  const lineHeight = style.lineHeight ?? Math.round(fontSize * 1.2);
  const scale = effectiveScale(node, ctx.fontScale);
  const avail = Math.max(
    1,
    Math.min(availableWidth, style.maxWidth ?? Number.POSITIVE_INFINITY),
  );
  const opts = {
    fontFamily: style.fontFamily,
    fontSize: fontSize * scale,
    letterSpacing: style.letterSpacing,
  };
  const single = text.split('\n').map(segment => measureText(segment, opts));
  const singleLineWidth = Math.max(0, ...single.map(m => m.widthPt));
  const fallbackGlyphs = single.reduce((n, m) => n + m.fallbackGlyphs, 0);
  const lines = wrapLines(text, avail, opts);
  // Clipping is judged with 5% slack so kerning (ignored by fontMetrics)
  // and sub-point rounding can never manufacture a failure.
  const linesWithSlack = wrapLines(text, avail * 1.05, opts);
  const numberOfLines =
    typeof (node.props as { numberOfLines?: number }).numberOfLines === 'number'
      ? (node.props as { numberOfLines: number }).numberOfLines
      : null;
  return {
    text,
    fontFamily: style.fontFamily ?? null,
    fontSize,
    lineHeight,
    scale,
    availableWidth: avail,
    singleLineWidth,
    fallbackGlyphs,
    lines,
    modeledHeight: lines * lineHeight * scale,
    numberOfLines,
    clipped: numberOfLines !== null && linesWithSlack > numberOfLines,
    textAlign: style.textAlign ?? null,
    inScrollView,
  };
}

// ─── Interactive elements ────────────────────────────────────────────────────

export interface PressableAudit {
  label: string | null;
  role: string | null;
  hint: string | null;
  accessible: boolean;
  disabled: boolean;
  hasOnPress: boolean;
  textContent: string;
  minHeightStyle: number | null;
  modeledHeight: number;
  modeledWidth: number;
  inScrollView: boolean;
  style: Record<string, unknown>;
}

function hostOf(node: ReactTestInstance): ReactTestInstance {
  const hosts = node.findAll(n => typeof n.type === 'string');
  return hosts[0] ?? node;
}

function isInside(
  node: ReactTestInstance,
  ancestors: ReactTestInstance[],
): boolean {
  let cur: ReactTestInstance | null = node.parent;
  while (cur) {
    if (ancestors.includes(cur)) return true;
    cur = cur.parent;
  }
  return false;
}

export function auditPressables(
  root: ReactTestInstance,
  ctx: LayoutContext,
  contentWidth: number,
): PressableAudit[] {
  const scrolls = root.findAllByType(ScrollView);
  return root.findAllByType(PressableInner).map(pressable => {
    const host = hostOf(pressable);
    const props = host.props as {
      accessibilityRole?: string;
      accessibilityLabel?: string;
      accessibilityHint?: string;
      accessible?: boolean;
      accessibilityState?: { disabled?: boolean };
      onClick?: unknown;
      onResponderRelease?: unknown;
    };
    const style = flat(host);
    const texts = pressable.findAllByType(Text);
    const contentHeight = texts.reduce((max, t) => {
      const s = flat(t);
      const lh = s.lineHeight ?? (s.fontSize ?? 14) * 1.2;
      return Math.max(max, lh * effectiveScale(t, ctx.fontScale));
    }, 0);
    const padTop =
      style.paddingTop ?? style.paddingVertical ?? style.padding ?? 0;
    const padBottom =
      style.paddingBottom ?? style.paddingVertical ?? style.padding ?? 0;
    const border = (style.borderWidth ?? 0) * 2;
    const modeledHeight = Math.max(
      style.minHeight ?? 0,
      typeof style.height === 'number' ? style.height : 0,
      padTop + padBottom + border + contentHeight,
    );
    const modeledWidth =
      typeof style.width === 'number'
        ? style.width
        : Math.max(style.minWidth ?? 0, contentWidth);
    const pressableProps = pressable.props as { onPress?: unknown };
    return {
      label: props.accessibilityLabel ?? null,
      role: props.accessibilityRole ?? null,
      hint: props.accessibilityHint ?? null,
      accessible: props.accessible !== false,
      disabled: props.accessibilityState?.disabled === true,
      hasOnPress: typeof pressableProps.onPress === 'function',
      textContent: texts.map(textOf).join(' ').trim(),
      minHeightStyle: style.minHeight ?? null,
      modeledHeight,
      modeledWidth,
      inScrollView: isInside(pressable, scrolls),
      style: compactStyle(style),
    };
  });
}

// ─── Copy policy (APP_STORE_SUBMISSION.md) ───────────────────────────────────

export const FORBIDDEN_COPY = [
  /android/i,
  /google play/i,
  /\bguest\b/i,
  /live court/i,
  /\bdupr\b/i,
  /swingvision/i,
  /pb vision/i,
  /selkirk/i,
  /joola/i,
  /\d+\s?%/,
  /\b(best|#1|most accurate|world[- ]class|revolutionary)\b/i,
  /\bAI coach\b/i,
  /TODO|FIXME|lorem ipsum|\{\{|\}\}|undefined|\[object Object\]|NaN/,
];

export function copyViolations(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const re of FORBIDDEN_COPY) {
      if (re.test(t))
        out.push(`${re.source} ⇐ ${JSON.stringify(t.slice(0, 80))}`);
    }
  }
  return out;
}

// ─── Evidence ────────────────────────────────────────────────────────────────

const STYLE_KEYS = [
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'minHeight',
  'height',
  'minWidth',
  'width',
  'maxWidth',
  'padding',
  'paddingVertical',
  'paddingHorizontal',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'marginTop',
  'marginHorizontal',
  'borderWidth',
  'textAlign',
  'textTransform',
  'position',
  'flex',
  'flexGrow',
  'flexShrink',
  'flexDirection',
  'alignItems',
  'justifyContent',
  'overflow',
  'gap',
] as const;

export function compactStyle(style: FlatStyle): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of STYLE_KEYS) {
    if (style[key] !== undefined) out[key] = style[key];
  }
  return out;
}

export interface CompactNode {
  type: string;
  a11y?: Record<string, unknown>;
  text?: string;
  testID?: string;
  numberOfLines?: number;
  style?: Record<string, unknown>;
  children?: CompactNode[];
}

type JsonNode = ReturnType<ReactTestRenderer['toJSON']>;

/** Host tree with only the props that matter for a11y / layout evidence. */
export function compactTree(json: JsonNode): CompactNode[] {
  if (json === null) return [];
  const list = Array.isArray(json) ? json : [json];
  return list.map(node => {
    const props = node.props as Record<string, unknown>;
    const out: CompactNode = { type: node.type };
    const a11y: Record<string, unknown> = {};
    for (const key of [
      'accessibilityRole',
      'accessibilityLabel',
      'accessibilityHint',
      'accessible',
      'accessibilityState',
      'role',
    ]) {
      if (props[key] !== undefined) a11y[key] = props[key];
    }
    if (Object.keys(a11y).length > 0) out.a11y = a11y;
    if (typeof props['testID'] === 'string') out.testID = props['testID'];
    if (typeof props['numberOfLines'] === 'number') {
      out.numberOfLines = props['numberOfLines'];
    }
    const style = compactStyle(
      (StyleSheet.flatten(props['style'] as never) ?? {}) as FlatStyle,
    );
    if (Object.keys(style).length > 0) out.style = style;
    const children = node.children ?? [];
    const strings = children.filter(c => typeof c === 'string') as string[];
    if (strings.length > 0) out.text = strings.join('');
    const kids = compactTree(
      children.filter(c => typeof c !== 'string') as JsonNode,
    );
    if (kids.length > 0) out.children = kids;
    return out;
  });
}
