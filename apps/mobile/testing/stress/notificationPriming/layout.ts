/**
 * stress-cmp-notification-priming — flexbox/typography model of the
 * NotificationPrimingCard row as it is mounted on HomeScreen.
 *
 * react-test-renderer produces a tree with no geometry, so an accessibility
 * claim about Dynamic Type ("does the 'Not now' pill still fit at
 * AccessibilityLarge on a 320pt screen?") cannot be read off the tree. This
 * module reconstructs the geometry from
 *   (a) the STYLES taken off the rendered tree (never hard-coded here: the
 *       caller flattens `props.style` of the real rendered nodes), and
 *   (b) real glyph advances of the TTFs bundled in assets/fonts
 *       (`fontMetrics.fixture.json`).
 * The reconstruction is pinned against real Yoga (`yogaLayout.fixture.json`,
 * produced by yoga-layout@3 — the engine React Native embeds) in
 * `__tests__/stress/notificationPrimingLayoutModel.test.ts`.
 *
 * Scope: the actions row is the only place the card can overflow, because it
 * is the only horizontal run of intrinsically-sized, non-shrinking children
 * (`actionSlot: { flexGrow: 0, alignSelf: 'flex-start', minWidth: 96 }` inside
 * `actions: { flexDirection: 'row', gap: 8 }`, with no `flexWrap`).
 */
import fontMetrics from './fontMetrics.fixture.json';

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

export interface PillStyle {
  minHeight: number;
  paddingHorizontal: number;
  borderWidth: number;
}

export interface SlotStyle {
  minWidth: number;
}

export interface ActionsRowStyle {
  gap: number;
  flexWrap?: 'wrap' | 'nowrap';
}

export interface CardStyle {
  padding: number;
  gap: number;
  borderWidth: number;
}

export interface CardChrome {
  /** Screen width in points (logical pixels). */
  screenWidth: number;
  /** HomeScreen ScrollView contentContainer paddingHorizontal. */
  screenPaddingHorizontal: number;
  /** Leading icon slot width (bell chip). */
  iconWidth: number;
  card: CardStyle;
  actions: ActionsRowStyle;
  slot: SlotStyle;
  pill: PillStyle;
  /** Text style of the pill labels. */
  pillLabel: TextStyle;
}

export interface PillBox {
  label: string;
  /** Intrinsic width of the pill (label + padding + borders), clamped up by minWidth. */
  width: number;
  /** Rendered height, honouring wrapped label lines and minHeight. */
  height: number;
  /** Left edge, relative to the screen's left edge. */
  left: number;
  /** Number of label lines after wrapping inside the available width. */
  labelLines: number;
}

export interface ActionsLayout {
  /** Width available to the copy column (card width minus icon, gaps, padding). */
  copyColumnWidth: number;
  /** Sum of the pill widths plus the gaps between them. */
  rowContentWidth: number;
  pills: PillBox[];
  /** Points by which the row exceeds the copy column (0 when it fits). */
  overflowPastCopyColumn: number;
  /** Points by which the row exceeds the card's outer border. */
  overflowPastCardBorder: number;
  /** Points of the row that fall outside the screen (i.e. are clipped away). */
  overflowPastScreen: number;
}

const FONT_KEY_BY_FAMILY: Record<string, string> = {
  Manrope_400Regular: 'Manrope_400Regular',
  Manrope_500Medium: 'Manrope_500Medium',
  Manrope_600SemiBold: 'Manrope_600SemiBold',
  Manrope_700Bold: 'Manrope_700Bold',
};

interface FontMetrics {
  advanceEm: Record<string, number>;
  stringEm: Record<string, number>;
}

function metricsFor(fontFamily: string): FontMetrics {
  const key = FONT_KEY_BY_FAMILY[fontFamily] ?? 'Manrope_500Medium';
  const fonts = fontMetrics.fonts as Record<string, FontMetrics | undefined>;
  const found = fonts[key] ?? fonts['Manrope_500Medium'];
  if (!found) throw new Error(`no font metrics for ${fontFamily}`);
  return found;
}

/**
 * Width of `text` at `fontSize`, from the bundled TTF. Kerned whole-string
 * advances are used for the strings the card actually renders (they are ~1%
 * narrower than the sum of the per-glyph advances); anything else falls back
 * to the per-glyph sum, with the average Latin advance for unmapped code
 * points (CJK/Arabic/emoji resolve to an iOS system fallback face at runtime,
 * so no claim is made about their exact width).
 */
export function measureText(
  text: string,
  style: TextStyle,
  fontScale: number,
): number {
  const m = metricsFor(style.fontFamily);
  const kerned = m.stringEm[text];
  const em =
    kerned ?? [...text].reduce((acc, ch) => acc + (m.advanceEm[ch] ?? 0.6), 0);
  return em * style.fontSize * fontScale;
}

/** Greedy word wrap, matching how RN breaks a Text at whitespace. */
export function wrapLines(
  text: string,
  style: TextStyle,
  fontScale: number,
  maxWidth: number,
): string[] {
  if (measureText(text, style, fontScale) <= maxWidth) return [text];
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && measureText(candidate, style, fontScale) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Lays out the actions row for one (screen width × Dynamic Type scale ×
 * primary label) variant and reports where it overflows.
 */
export function layoutActionsRow(
  chrome: CardChrome,
  labels: string[],
  fontScale: number,
): ActionsLayout {
  const cardOuterWidth =
    chrome.screenWidth - 2 * chrome.screenPaddingHorizontal;
  const cardInnerWidth =
    cardOuterWidth - 2 * (chrome.card.padding + chrome.card.borderWidth);
  const copyColumnWidth = cardInnerWidth - chrome.iconWidth - chrome.card.gap;
  const copyLeft =
    chrome.screenPaddingHorizontal +
    chrome.card.borderWidth +
    chrome.card.padding +
    chrome.iconWidth +
    chrome.card.gap;

  const pillChrome =
    2 * (chrome.pill.paddingHorizontal + chrome.pill.borderWidth);
  // Yoga measures each child of an overflowing row against the space the
  // CONTAINER offers (the whole copy column), not against what the previous
  // children left behind: intrinsically-sized, non-shrinking slots keep their
  // width and the row overflows. Past the column the label wraps instead.
  const available = Math.max(0, copyColumnWidth - pillChrome);
  const pills: PillBox[] = [];
  let cursor = copyLeft;
  for (const label of labels) {
    const intrinsic = measureText(label, chrome.pillLabel, fontScale);
    let lines = [label];
    let labelWidth = intrinsic;
    if (intrinsic > available) {
      lines = wrapLines(label, chrome.pillLabel, fontScale, available);
      labelWidth = Math.min(
        available,
        Math.max(
          ...lines.map(l => measureText(l, chrome.pillLabel, fontScale)),
        ),
      );
    }
    const width = Math.max(chrome.slot.minWidth, labelWidth + pillChrome);
    const contentHeight =
      lines.length * chrome.pillLabel.lineHeight * fontScale +
      2 * chrome.pill.borderWidth;
    pills.push({
      label,
      width,
      height: Math.max(chrome.pill.minHeight, contentHeight),
      left: cursor,
      labelLines: lines.length,
    });
    cursor += width + chrome.actions.gap;
  }

  const rowContentWidth =
    pills.reduce((acc, p) => acc + p.width, 0) +
    chrome.actions.gap * Math.max(0, pills.length - 1);
  const last = pills[pills.length - 1];
  const rowRight = last ? last.left + last.width : copyLeft;
  const cardPaddingRight = copyLeft + copyColumnWidth;
  const cardBorderRight = chrome.screenPaddingHorizontal + cardOuterWidth;

  return {
    copyColumnWidth,
    rowContentWidth,
    pills,
    overflowPastCopyColumn: Math.max(0, rowRight - cardPaddingRight),
    overflowPastCardBorder: Math.max(0, rowRight - cardBorderRight),
    overflowPastScreen: Math.max(0, rowRight - chrome.screenWidth),
  };
}

/** Visible width of a pill once the screen edge clips it. */
export function visibleWidth(pill: PillBox, screenWidth: number): number {
  return Math.max(0, Math.min(pill.left + pill.width, screenWidth) - pill.left);
}
