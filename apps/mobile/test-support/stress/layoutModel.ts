/**
 * Deterministic layout model for the FirstRunWalkthrough callout card.
 *
 * The callout is `position: 'absolute'` with either `top` (target in the
 * upper 52 % of the window → card below it) or `bottom` (card above it) and
 * no `maxHeight`/ScrollView. Its height is the sum of its text runs, so at
 * larger Dynamic Type sizes it can extend past the window edge. Linux has
 * no CoreText, so this model reproduces the arithmetic from the rendered
 * tree's own style values (paddings, margins, lineHeights) plus a text
 * advance of 0.55 em per code point — the same constant the a11y audit
 * uses — and reports how many points overflow.
 *
 * Inputs come from the rendered tree (the `top`/`bottom` the component
 * chose, the text runs and their styles), not from re-implemented layout
 * logic, so a change to the component changes the model's answer.
 */
import { StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { estimateTextWidth } from './a11yAudit';

type FlatStyle = Record<string, unknown>;

function flat(style: unknown): FlatStyle {
  return (
    (StyleSheet.flatten(style as never) as FlatStyle | null | undefined) ?? {}
  );
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
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

export interface CalloutModel {
  /** `top` chosen by the component, or undefined when anchored by `bottom`. */
  top: number | undefined;
  bottom: number | undefined;
  cardWidth: number;
  contentWidth: number;
  /** Modelled height of the whole card at the requested font scale. */
  modelledHeight: number;
  /** Vertical room between the card's anchor edge and the window edge. */
  available: number;
  /** Points of the card that fall outside the window (0 when it fits). */
  overflowPt: number;
  /** Which edge is clipped when overflowPt > 0. */
  clippedEdge: 'top' | 'bottom' | null;
  runs: { text: string; fontSize: number; lineHeight: number; lines: number }[];
  controlsHeight: number;
}

/**
 * Finds the callout host View (the one with `accessibilityViewIsModal`) and
 * models its height at `fontScale` for a window of `windowWidth × windowHeight`.
 */
export function modelCallout(
  root: ReactTestInstance,
  fontScale: number,
  windowWidth: number,
  windowHeight: number,
): CalloutModel | null {
  const callout = root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.accessibilityViewIsModal === true,
  )[0];
  if (!callout) return null;
  const style = flat(callout.props.style);
  const left = num(style.left) ?? 0;
  const right = num(style.right) ?? 0;
  const border = (num(style.borderWidth) ?? 0) * 2;
  const paddingH = (num(style.paddingHorizontal) ?? 0) * 2;
  const cardWidth = windowWidth - left - right;
  const contentWidth = Math.max(1, cardWidth - paddingH - border);
  const paddingTop = num(style.paddingTop) ?? num(style.paddingVertical) ?? 0;
  const paddingBottom =
    num(style.paddingBottom) ?? num(style.paddingVertical) ?? 0;

  // Direct text children of the card (eyebrow, headline, body, fine print):
  // the controls row is modelled separately because it is a flex row.
  const controls = callout.findAll(
    node =>
      typeof node.type === 'string' &&
      flat(node.props.style).justifyContent === 'space-between',
  )[0];
  const controlsSubtree = controls
    ? new Set(controls.findAll(() => true))
    : new Set<ReactTestInstance>();

  const runs: CalloutModel['runs'] = [];
  let textHeight = 0;
  for (const textNode of callout.findAll(
    node => typeof node.type === 'string' && String(node.type) === 'Text',
  )) {
    if (controlsSubtree.has(textNode)) continue;
    const textStyle = flat(textNode.props.style);
    const fontSize = num(textStyle.fontSize) ?? 14;
    const lineHeight = num(textStyle.lineHeight) ?? fontSize * 1.2;
    const scale = textNode.props.allowFontScaling === false ? 1 : fontScale;
    const letterSpacing = num(textStyle.letterSpacing) ?? 0;
    const text = textOf(textNode);
    const advance = estimateTextWidth(
      text,
      fontSize,
      scale,
      letterSpacing * scale,
    );
    const lines = Math.max(1, Math.ceil(advance / contentWidth));
    runs.push({ text, fontSize, lineHeight, lines });
    textHeight +=
      lines * lineHeight * scale +
      (num(textStyle.marginTop) ?? 0) +
      (num(textStyle.marginBottom) ?? 0);
  }

  // Controls row: max(dots, skip text + padding, button content minHeight
  // scaled by its label line height growth).
  let controlsHeight = 0;
  if (controls) {
    const controlsStyle = flat(controls.props.style);
    controlsHeight += num(controlsStyle.marginTop) ?? 0;
    let rowHeight = 0;
    for (const child of controls.findAll(
      node => typeof node.type === 'string',
    )) {
      const childStyle = flat(child.props.style);
      const explicit = num(childStyle.height) ?? num(childStyle.minHeight);
      const paddingV =
        (num(childStyle.paddingTop) ?? num(childStyle.paddingVertical) ?? 0) +
        (num(childStyle.paddingBottom) ?? num(childStyle.paddingVertical) ?? 0);
      let text = 0;
      if (String(child.type) === 'Text') {
        const lineHeight =
          num(childStyle.lineHeight) ?? (num(childStyle.fontSize) ?? 14) * 1.2;
        text =
          lineHeight * (child.props.allowFontScaling === false ? 1 : fontScale);
      }
      rowHeight = Math.max(rowHeight, explicit ?? 0, paddingV + text);
    }
    controlsHeight += rowHeight;
  }

  const modelledHeight =
    border + paddingTop + textHeight + controlsHeight + paddingBottom;
  const top = num(style.top);
  const bottom = num(style.bottom);
  let available: number;
  let clippedEdge: 'top' | 'bottom' | null = null;
  if (top !== undefined) {
    available = windowHeight - top;
    if (modelledHeight > available) clippedEdge = 'bottom';
  } else {
    available = windowHeight - (bottom ?? 0);
    if (modelledHeight > available) clippedEdge = 'top';
  }
  const overflowPt = Math.max(0, modelledHeight - available);
  return {
    top,
    bottom,
    cardWidth,
    contentWidth,
    modelledHeight: Math.round(modelledHeight * 10) / 10,
    available: Math.round(available * 10) / 10,
    overflowPt: Math.round(overflowPt * 10) / 10,
    clippedEdge: overflowPt > 0 ? clippedEdge : null,
    runs,
    controlsHeight: Math.round(controlsHeight * 10) / 10,
  };
}

/** Parses every numeric token of an SVG path `d` attribute. */
export function pathNumbers(d: string): number[] {
  return (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
}
