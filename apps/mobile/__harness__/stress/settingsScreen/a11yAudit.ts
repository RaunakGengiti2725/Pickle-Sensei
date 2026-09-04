import { StyleSheet, Text } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { estimateLines, graphemes } from './textCorpus';

export const MIN_TARGET_PT = 44;

/** Horizontal chrome around a Settings group-card row at a given screen width:
 * screen padding 24×2, group card paddingHorizontal 16×2. */
const CARD_CHROME_PT = 48 + 32;
/** Dark account card keeps the default Card padding (24×2). */
const ACCOUNT_CARD_CHROME_PT = 48 + 48;
const AVATAR_PT = 54;
const ROW_VALUE_MAX_WIDTH_PT = 130;

export interface PressableAudit {
  label: string | null;
  role: string | null;
  /** Height guaranteed by style (height or minHeight), null when unconstrained. */
  heightPt: number | null;
  widthPt: number | null;
  /** position:absolute with all four edges pinned (a full-bleed scrim). */
  fullBleed: boolean;
  /** Excluded from VoiceOver (behind an accessibilityViewIsModal sibling or
   * explicitly hidden) — not counted against the a11y invariants. */
  voiceOverHidden: boolean;
  disabled: boolean;
  issues: string[];
}

export interface TextAudit {
  text: string;
  numberOfLines: number | null;
  fontSizePt: number;
  scaledFontSizePt: number;
  allowFontScaling: boolean;
  maxFontSizeMultiplier: number | null;
  boxWidthPt: number;
  estimatedLines: number;
  /** INFERRED: estimated line count exceeds numberOfLines. */
  estimatedClipped: boolean;
  context: 'row_value' | 'account_name' | 'pill' | 'other';
}

export interface AvatarAudit {
  accountName: string;
  rendered: string;
  expectedInitial: string;
  issues: string[];
}

export interface AuditReport {
  pressables: PressableAudit[];
  texts: TextAudit[];
  garbageText: string[];
  avatar: AvatarAudit | null;
  /** Deterministic violations of the a11y contract (VERIFIED from the tree). */
  hardViolations: string[];
  /** Heuristic layout estimates (INFERRED — no layout engine under Jest). */
  estimatedClips: string[];
  unscaledTextCount: number;
  uncappedScaledTextCount: number;
}

type Style = Record<string, unknown>;

function flat(style: unknown): Style {
  return (StyleSheet.flatten(style as never) ?? {}) as Style;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isHost(node: ReactTestInstance): boolean {
  return typeof node.type === 'string';
}

function isHostPressable(node: ReactTestInstance): boolean {
  return isHost(node) && typeof node.props.onClick === 'function';
}

function hostParent(node: ReactTestInstance): ReactTestInstance | null {
  let current = node.parent;
  while (current && !isHost(current)) current = current.parent;
  return current;
}

function within(node: ReactTestInstance, ancestor: ReactTestInstance): boolean {
  let current: ReactTestInstance | null = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function explicitlyHidden(node: ReactTestInstance): boolean {
  let current: ReactTestInstance | null = node;
  while (current) {
    const p = current.props;
    if (
      p.accessibilityElementsHidden === true ||
      p['aria-hidden'] === true ||
      p.importantForAccessibility === 'no-hide-descendants'
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/** Host nodes VoiceOver skips because a sibling declares accessibilityViewIsModal. */
function modalShadowed(root: ReactTestInstance): Set<ReactTestInstance> {
  const shadowed = new Set<ReactTestInstance>();
  const modals = root.findAll(
    n => isHost(n) && n.props.accessibilityViewIsModal === true,
  );
  for (const modal of modals) {
    const parent = hostParent(modal);
    if (!parent) continue;
    for (const node of parent.findAll(isHostPressable)) {
      if (!within(node, modal)) shadowed.add(node);
    }
  }
  return shadowed;
}

export function hostPressables(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(isHostPressable);
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

const GARBAGE = /\b(undefined|null|NaN|Infinity|\[object Object\])\b/;

function auditPressable(
  node: ReactTestInstance,
  hidden: boolean,
): PressableAudit {
  const style = flat(node.props.style);
  const label =
    typeof node.props.accessibilityLabel === 'string'
      ? node.props.accessibilityLabel
      : null;
  const role =
    typeof node.props.accessibilityRole === 'string'
      ? node.props.accessibilityRole
      : null;
  const heightPt = num(style.height) ?? num(style.minHeight);
  const widthPt = num(style.width) ?? num(style.minWidth);
  const fullBleed =
    style.position === 'absolute' &&
    num(style.top) !== null &&
    num(style.bottom) !== null &&
    num(style.left) !== null &&
    num(style.right) !== null;
  const disabled = node.props.accessibilityState?.disabled === true;
  const issues: string[] = [];
  if (!hidden) {
    if (!role) issues.push('missing accessibilityRole');
    if (!label || label.trim().length === 0)
      issues.push('missing accessibilityLabel');
    if (label && GARBAGE.test(label))
      issues.push(`label leaks a JS value: ${JSON.stringify(label)}`);
    if (!fullBleed && (heightPt === null || heightPt < MIN_TARGET_PT)) {
      issues.push(
        `target height ${heightPt ?? 'unconstrained'}pt < ${MIN_TARGET_PT}pt`,
      );
    }
    if (!fullBleed && widthPt !== null && widthPt < MIN_TARGET_PT) {
      issues.push(`target width ${widthPt}pt < ${MIN_TARGET_PT}pt`);
    }
  }
  return {
    label,
    role,
    heightPt,
    widthPt,
    fullBleed,
    voiceOverHidden: hidden,
    disabled,
    issues,
  };
}

function textContext(
  style: Style,
  numberOfLines: number | null,
): TextAudit['context'] {
  if (num(style.maxWidth) === ROW_VALUE_MAX_WIDTH_PT) return 'row_value';
  if (numberOfLines === 1 && num(style.fontSize) === 21) return 'account_name';
  if (numberOfLines === 1 && (num(style.fontSize) ?? 0) <= 12) return 'pill';
  return 'other';
}

function boxWidthFor(
  context: TextAudit['context'],
  style: Style,
  screenWidth: number,
): number {
  const maxWidth = num(style.maxWidth);
  switch (context) {
    case 'row_value':
      return ROW_VALUE_MAX_WIDTH_PT;
    case 'account_name':
      return screenWidth - ACCOUNT_CARD_CHROME_PT;
    case 'pill':
      // Pill sits right of the 54pt avatar with its own 10pt side padding.
      return screenWidth - ACCOUNT_CARD_CHROME_PT - AVATAR_PT - 12 - 20;
    case 'other':
      return Math.min(
        maxWidth ?? Number.POSITIVE_INFINITY,
        screenWidth - CARD_CHROME_PT,
      );
  }
}

function auditText(
  node: ReactTestInstance,
  fontScale: number,
  screenWidth: number,
): TextAudit {
  const style = flat(node.props.style);
  const text = textContent(node);
  const numberOfLines = num(node.props.numberOfLines);
  const fontSizePt = num(style.fontSize) ?? 14;
  const allowFontScaling = node.props.allowFontScaling !== false;
  const maxFontSizeMultiplier = num(node.props.maxFontSizeMultiplier);
  const effectiveScale = allowFontScaling
    ? Math.min(fontScale, maxFontSizeMultiplier ?? Number.POSITIVE_INFINITY)
    : 1;
  const scaledFontSizePt = fontSizePt * effectiveScale;
  const context = textContext(style, numberOfLines);
  const boxWidthPt = boxWidthFor(context, style, screenWidth);
  const estimatedLines = estimateLines(text, scaledFontSizePt, boxWidthPt);
  return {
    text,
    numberOfLines,
    fontSizePt,
    scaledFontSizePt,
    allowFontScaling,
    maxFontSizeMultiplier,
    boxWidthPt,
    estimatedLines,
    estimatedClipped: numberOfLines !== null && estimatedLines > numberOfLines,
    context,
  };
}

function auditAvatar(
  root: ReactTestInstance,
  accountName: string,
): AvatarAudit | null {
  const avatar = root.findAll(
    n =>
      isHost(n) &&
      String(n.type) === 'View' &&
      num(flat(n.props.style).width) === AVATAR_PT &&
      num(flat(n.props.style).borderRadius) === AVATAR_PT / 2 &&
      flat(n.props.style).backgroundColor === '#D7FA45',
  )[0];
  if (!avatar) return null;
  const rendered = textContent(avatar);
  const clusters = graphemes(accountName);
  const expectedInitial = (clusters[0] ?? '').toUpperCase();
  const issues: string[] = [];
  if (accountName.trim().length === 0) {
    issues.push(
      'account name is blank (empty/whitespace) — nothing to initial',
    );
  } else if (/^[\ud800-\udfff]$/u.test(rendered)) {
    issues.push(
      `avatar initial is a lone UTF-16 surrogate U+${rendered.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } else if (rendered.trim().length === 0) {
    issues.push('avatar initial is blank for a non-blank name');
  } else if (rendered !== expectedInitial) {
    issues.push(
      `avatar initial ${JSON.stringify(rendered)} splits grapheme ${JSON.stringify(expectedInitial)}`,
    );
  }
  return { accountName, rendered, expectedInitial, issues };
}

export function auditSettingsTree(
  root: ReactTestInstance,
  options: { fontScale: number; width: number; accountName: string | null },
): AuditReport {
  const shadowed = modalShadowed(root);
  const pressables = hostPressables(root).map(node =>
    auditPressable(node, shadowed.has(node) || explicitlyHidden(node)),
  );
  const texts = root
    .findAllByType(Text)
    .map(node => auditText(node, options.fontScale, options.width));
  const garbageText = texts.map(t => t.text).filter(t => GARBAGE.test(t));
  const avatar =
    options.accountName === null
      ? null
      : auditAvatar(root, options.accountName);

  const hardViolations: string[] = [];
  for (const p of pressables) {
    for (const issue of p.issues) {
      hardViolations.push(
        `pressable ${JSON.stringify(p.label ?? '<unlabelled>')}: ${issue}`,
      );
    }
  }
  for (const g of garbageText)
    hardViolations.push(`text leaks a JS value: ${JSON.stringify(g)}`);
  if (avatar)
    for (const issue of avatar.issues) hardViolations.push(`avatar: ${issue}`);

  const estimatedClips = texts
    .filter(t => t.estimatedClipped)
    .map(
      t =>
        `${t.context} ${JSON.stringify(t.text.slice(0, 60))}: ~${t.estimatedLines} lines at ${t.scaledFontSizePt.toFixed(1)}pt in ${t.boxWidthPt}pt > numberOfLines=${t.numberOfLines}`,
    );

  return {
    pressables,
    texts,
    garbageText,
    avatar,
    hardViolations,
    estimatedClips,
    unscaledTextCount: texts.filter(t => !t.allowFontScaling).length,
    uncappedScaledTextCount: texts.filter(
      t => t.allowFontScaling && t.maxFontSizeMultiplier === null,
    ).length,
  };
}
