/**
 * Rendered-tree audit for react-test-renderer output.
 *
 * jest has no layout engine, so this inspects exactly what the host layer
 * receives: the host `View` / `Text` / `TextInput` props after the
 * accessibility props were resolved. It answers, per rendered tree:
 *
 *   - which host nodes are interactive (responder/press handlers, text inputs)
 *   - whether each has an accessible role and a non-degenerate label
 *   - whether its declared box (style width/height/minWidth/minHeight plus
 *     hitSlop) can reach the 44pt target on each axis it constrains
 *   - which Text nodes opt out of Dynamic Type scaling
 *   - which Text nodes are truncation candidates at the requested font scale
 *     and viewport width (estimate, labelled as such — no layout ran)
 *   - which absolutely positioned nodes could overlap interactive content
 *
 * Everything returned carries the host path so the JSON artifact doubles as
 * rendered-tree evidence.
 */
import { StyleSheet } from 'react-native';
import type {
  ReactTestRenderer,
  ReactTestRendererJSON,
} from 'react-test-renderer';
import type { ScriptWidth } from './boundaryCorpus';

export const MIN_TARGET_PT = 44;

type Json = ReactTestRendererJSON | string | null;

export interface HostNode {
  type: string;
  path: string;
  props: Record<string, unknown>;
  style: Record<string, unknown>;
  children: HostNode[];
  text: string;
}

export interface InteractiveAudit {
  path: string;
  type: string;
  role: string | null;
  label: string | null;
  labelSource: 'accessibilityLabel' | 'text' | 'placeholder' | 'none';
  testID: string | null;
  disabled: boolean;
  /** Declared box per axis (undefined = stretches with content/parent). */
  width: number | null;
  height: number | null;
  hitSlop: number;
  issues: string[];
}

export interface TextAudit {
  path: string;
  text: string;
  numberOfLines: number | null;
  fontSize: number | null;
  allowFontScaling: boolean;
  /** Estimated single-line width at the campaign's font scale (pt). */
  estimatedWidthPt: number | null;
  truncationCandidate: boolean;
}

export interface OverlapAudit {
  path: string;
  pointerEventsNone: boolean;
  role: string | null;
  containsInteractive: boolean;
}

export interface TreeAudit {
  interactive: InteractiveAudit[];
  texts: TextAudit[];
  absolute: OverlapAudit[];
  allText: string[];
  issues: string[];
}

function flatten(style: unknown): Record<string, unknown> {
  const flat = StyleSheet.flatten(style as never) as
    Record<string, unknown> | null | undefined;
  return flat ?? {};
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toHostTree(renderer: ReactTestRenderer): HostNode[] {
  const json = renderer.toJSON();
  const roots: Json[] = Array.isArray(json) ? json : [json];
  return roots
    .map((root, index) => toHostNode(root, `#${index}`))
    .filter((node): node is HostNode => node !== null);
}

function toHostNode(node: Json, path: string): HostNode | null {
  if (node === null || typeof node === 'string') return null;
  const { children: rawChildren, style, ...rest } = node.props ?? {};
  const kids: Json[] = Array.isArray(node.children)
    ? (node.children as Json[])
    : [];
  const children: HostNode[] = [];
  let text = '';
  kids.forEach((kid, index) => {
    if (typeof kid === 'string') {
      text += kid;
      return;
    }
    const child = toHostNode(kid, `${path}/${node.type}[${index}]`);
    if (child) {
      children.push(child);
      text += child.text;
    }
  });
  void rawChildren;
  return {
    type: node.type,
    path: `${path}/${node.type}`,
    props: rest as Record<string, unknown>,
    style: flatten(style),
    children,
    text,
  };
}

/** Serializable evidence: host type, a11y props, flattened style, text. */
export function evidenceTree(nodes: HostNode[]): unknown[] {
  return nodes.map(node => {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.props)) {
      if (typeof value === 'function') continue;
      if (
        key.startsWith('accessib') ||
        key === 'testID' ||
        key === 'numberOfLines' ||
        key === 'allowFontScaling' ||
        key === 'hitSlop' ||
        key === 'pointerEvents' ||
        key === 'placeholder' ||
        key === 'value' ||
        key === 'accessible' ||
        key === 'focusable'
      ) {
        props[key] = value;
      }
    }
    const style: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.style)) {
      if (
        typeof value === 'number' ||
        typeof value === 'string' ||
        value === null
      ) {
        style[key] = value;
      }
    }
    return {
      type: node.type,
      ...(Object.keys(props).length ? { props } : {}),
      ...(Object.keys(style).length ? { style } : {}),
      ...(node.children.length
        ? { children: evidenceTree(node.children) }
        : node.text
          ? { text: node.text }
          : {}),
    };
  });
}

function isInteractive(node: HostNode): boolean {
  if (node.type === 'TextInput') return true;
  const p = node.props;
  return (
    typeof p['onClick'] === 'function' ||
    typeof p['onPress'] === 'function' ||
    typeof p['onResponderRelease'] === 'function' ||
    typeof p['onStartShouldSetResponder'] === 'function' ||
    typeof p['onResponderGrant'] === 'function'
  );
}

function hitSlopOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const rect = value as Record<string, unknown>;
    const sides = ['top', 'bottom', 'left', 'right']
      .map(side => numeric(rect[side]) ?? 0)
      .filter(side => side > 0);
    return sides.length ? Math.min(...sides) : 0;
  }
  return 0;
}

const CHAR_WIDTH_FACTOR: Record<ScriptWidth, number> = {
  latin: 0.52,
  wide: 1.0,
  arabic: 0.5,
  indic: 0.62,
  thai: 0.55,
};

export interface AuditOptions {
  fontScale: number;
  viewportWidthPt: number;
  /** Horizontal chrome (page + card padding) subtracted from the viewport. */
  horizontalInsetPt: number;
  script: ScriptWidth;
}

export function auditTree(nodes: HostNode[], options: AuditOptions): TreeAudit {
  const audit: TreeAudit = {
    interactive: [],
    texts: [],
    absolute: [],
    allText: [],
    issues: [],
  };
  const visit = (node: HostNode) => {
    if (node.type === 'Text') auditText(node, options, audit);
    if (isInteractive(node)) auditInteractive(node, audit);
    if (node.style['position'] === 'absolute') {
      audit.absolute.push({
        path: node.path,
        pointerEventsNone:
          node.props['pointerEvents'] === 'none' ||
          node.style['pointerEvents'] === 'none',
        role: (node.props['accessibilityRole'] as string | undefined) ?? null,
        containsInteractive: subtreeHasInteractive(node),
      });
    }
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  audit.allText = collectText(nodes);
  return audit;
}

function subtreeHasInteractive(node: HostNode): boolean {
  return node.children.some(
    child => isInteractive(child) || subtreeHasInteractive(child),
  );
}

function collectText(nodes: HostNode[]): string[] {
  const out: string[] = [];
  const visit = (node: HostNode) => {
    if (node.type === 'Text' && node.text) out.push(node.text);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

function auditInteractive(node: HostNode, audit: TreeAudit) {
  const p = node.props;
  const issues: string[] = [];
  const explicitLabel =
    typeof p['accessibilityLabel'] === 'string'
      ? (p['accessibilityLabel'] as string)
      : null;
  let label: string | null = explicitLabel;
  let labelSource: InteractiveAudit['labelSource'] = 'accessibilityLabel';
  if (label === null) {
    if (node.text.trim()) {
      label = node.text;
      labelSource = 'text';
    } else if (typeof p['placeholder'] === 'string') {
      label = p['placeholder'] as string;
      labelSource = 'placeholder';
    } else {
      labelSource = 'none';
    }
  }
  const role =
    typeof p['accessibilityRole'] === 'string'
      ? (p['accessibilityRole'] as string)
      : node.type === 'TextInput'
        ? 'textinput(host)'
        : null;
  if (role === null) issues.push('missing-role');
  if (label === null) issues.push('missing-label');
  else if (label.replace(/[\u200B-\u200D\u2060\uFEFF\s]/g, '') === '') {
    issues.push('label-invisible-only');
  } else if (
    labelSource === 'accessibilityLabel' &&
    /^(Save|Show detail for|Hide detail for|Retry detail for|Remove)\s*$/.test(
      label.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim(),
    )
  ) {
    issues.push(`label-missing-subject ${JSON.stringify(label)}`);
  }

  const style = node.style;
  const hitSlop = hitSlopOf(p['hitSlop']);
  const width = numeric(style['width']) ?? numeric(style['minWidth']);
  const height = numeric(style['height']) ?? numeric(style['minHeight']);
  if (width !== null && width + 2 * hitSlop < MIN_TARGET_PT) {
    issues.push(`target-width-${width}+${2 * hitSlop}<${MIN_TARGET_PT}`);
  }
  if (height !== null && height + 2 * hitSlop < MIN_TARGET_PT) {
    issues.push(`target-height-${height}+${2 * hitSlop}<${MIN_TARGET_PT}`);
  }
  const state = p['accessibilityState'] as Record<string, unknown> | undefined;
  const disabled =
    p['disabled'] === true ||
    (state !== undefined && state['disabled'] === true);
  audit.interactive.push({
    path: node.path,
    type: node.type,
    role,
    label,
    labelSource,
    testID: typeof p['testID'] === 'string' ? (p['testID'] as string) : null,
    disabled,
    width,
    height,
    hitSlop,
    issues,
  });
  audit.issues.push(...issues.map(issue => `${node.path}: ${issue}`));
}

function auditText(node: HostNode, options: AuditOptions, audit: TreeAudit) {
  const p = node.props;
  const numberOfLines = numeric(p['numberOfLines']);
  const fontSize = numeric(node.style['fontSize']);
  const allowFontScaling = p['allowFontScaling'] !== false;
  const text = node.text;
  let estimatedWidthPt: number | null = null;
  let truncationCandidate = false;
  if (fontSize !== null && text) {
    const glyphs = Array.from(text.normalize('NFC')).filter(
      ch => !/[\u0300-\u036F\u200B-\u200D\u2060\uFEFF\u202A-\u202E]/.test(ch),
    ).length;
    estimatedWidthPt =
      glyphs * fontSize * options.fontScale * CHAR_WIDTH_FACTOR[options.script];
    if (numberOfLines !== null) {
      const available = Math.max(
        1,
        options.viewportWidthPt - options.horizontalInsetPt,
      );
      truncationCandidate = estimatedWidthPt > available * numberOfLines;
    }
  }
  if (!allowFontScaling) {
    audit.issues.push(`${node.path}: allowFontScaling=false`);
  }
  audit.texts.push({
    path: node.path,
    text,
    numberOfLines,
    fontSize,
    allowFontScaling,
    estimatedWidthPt,
    truncationCandidate,
  });
}
