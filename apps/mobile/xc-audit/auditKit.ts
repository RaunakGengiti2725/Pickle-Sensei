/**
 * xc-screen-ux-a11y-i18n-3 — shared audit kit for the per-screen UX / a11y /
 * i18n harness (AnalyzeScreen, ResultScreen, ResultDetailsScreen,
 * FormReviewScreen).
 *
 * Everything here is pure: rendered-tree walkers, a copy lexicon, WCAG 2.x
 * contrast math, a deterministic PRNG and a JSON artifact writer. Nothing in
 * this module is imported by production code; it is consumed only by the
 * `__tests__/xcScreenAudit*.test.tsx` suites.
 *
 * Artifacts land under `<repo>/artifacts/xc-screen-ux-a11y-i18n-3/` (the root
 * `artifacts/` directory is gitignored) or `$XC_AUDIT_OUT` when set.
 */
import {
  Image,
  Modal,
  Pressable,
  StyleSheet,
  TouchableHighlight,
  TouchableOpacity,
  TouchableWithoutFeedback,
} from 'react-native';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';

// ───────────────────────── artifacts ─────────────────────────
// Node built-ins for the artifact writer. The mobile tsconfig deliberately
// excludes node typings (same shim as importedRealFootageAnalysis.test.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  mkdirSync: (dir: string, opts: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string, enc: 'utf8') => void;
  appendFileSync: (file: string, data: string, enc: 'utf8') => void;
  readFileSync: (file: string, enc: 'utf8') => string;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

export const OUT_DIR =
  process.env['XC_AUDIT_OUT'] ??
  path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'artifacts',
    'xc-screen-ux-a11y-i18n-3',
  );

export function writeArtifact(name: string, data: unknown): string {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
}

export function appendLog(name: string, line: string): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(path.join(OUT_DIR, name), `${line}\n`, 'utf8');
}

// ───────────────────────── PRNG ─────────────────────────

/** mulberry32 — small, deterministic, replayable from a 32-bit seed. */
export function makeRng(seed: number): {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
} {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: maxExclusive => Math.floor(next() * maxExclusive),
    pick: items => {
      const index = Math.floor(next() * items.length);
      const value = items[index];
      if (value === undefined) throw new Error('pick from empty list');
      return value;
    },
    chance: p => next() < p,
  };
}

// ───────────────────────── copy lexicon ─────────────────────────

export interface LexiconRule {
  id: string;
  pattern: RegExp;
  /** Why this matters, quoted from AGENTS.md / APP_STORE_SUBMISSION.md. */
  policy: string;
}

/** Terms `docs/APP_STORE_SUBMISSION.md` forbids in user-facing copy. */
export const FORBIDDEN_TERMS: readonly LexiconRule[] = [
  { id: 'android', pattern: /\bandroid\b/i, policy: 'no Android mention' },
  { id: 'google_play', pattern: /google\s*play/i, policy: 'no Google Play' },
  { id: 'guest_mode', pattern: /guest\s*mode/i, policy: 'no guest mode' },
  { id: 'live_court', pattern: /live\s*court/i, policy: 'no Live Court' },
  {
    id: 'competitor',
    pattern: /swing\s*vision|pb\s*vision|selkirk|joola|onix|franklin/i,
    policy: 'no competitor mention',
  },
];

/**
 * Terms the dossier bans from STORE METADATA but knowingly ships in-app
 * (APP_STORE_SUBMISSION.md §2 optional item: the "DUPR-style estimate"
 * label is a disclaimed, low-probability 5.2.1 risk). Recorded in every
 * matrix as informational so the exposure surface is measured, never
 * counted as a copy failure.
 */
export const KNOWN_ACCEPTED_TERMS: readonly LexiconRule[] = [
  {
    id: 'dupr_in_app',
    pattern: /\bDUPR\b/,
    policy:
      'APP_STORE_SUBMISSION.md §2: in-app DUPR-style estimate is a known, disclaimed risk; keep out of metadata',
  },
];

/** Claims the dossier forbids: accuracy %, superlatives, AI-coach parity. */
export const UNSUPPORTED_CLAIMS: readonly LexiconRule[] = [
  {
    id: 'accuracy_percent',
    pattern: /\d+(?:\.\d+)?\s*%\s*(?:accura|precis|correct|reliab)/i,
    policy: 'no accuracy percentage',
  },
  {
    // Asserted accuracy only; a question to the player ("Was this analysis
    // accurate?") is feedback collection, not a claim.
    id: 'accuracy_claim',
    pattern:
      /\b(?:accuracy (?:of|rate|guarantee)|(?:highly|extremely|clinically|professionally|pro-level|lab-grade|perfectly)\s+accurate|accurate (?:to|within)\b|(?:is|are|was|were)\s+(?:\d+%\s+)?accurate\b(?!\?))/i,
    policy: 'no accuracy claims',
  },
  {
    id: 'superlative',
    pattern:
      /\b(?:the best|most accurate|perfect(?:ly)?|guaranteed?|world[- ]class|#1|number one|flawless|unbeatable|pro-level accuracy)\b/i,
    policy: 'no superlatives',
  },
  {
    id: 'ai_coach_equivalence',
    pattern:
      /\b(?:ai coach|like a (?:real|human|pro) coach|replaces? (?:a|your) coach|as good as a coach)\b/i,
    policy: 'no AI-coach-equivalence',
  },
];

/**
 * Raw machine identifiers that must never reach a user: snake_case tokens
 * (`paddle_track_unavailable`), dotted codes (`camera.import_too_long`,
 * `shot.sync_unacknowledged`) and JS runtime leaks.
 */
export const MACHINE_TOKEN_PATTERNS: readonly LexiconRule[] = [
  {
    id: 'snake_case_token',
    pattern: /(?:^|[^A-Za-z0-9_])([a-z0-9]+(?:_[a-z0-9]+)+)(?![A-Za-z0-9_])/,
    policy: 'AGENTS.md: map machine tokens through user-facing copy',
  },
  {
    id: 'dotted_code',
    pattern: /(?:^|[^A-Za-z0-9_.])([a-z]+\.[a-z]+(?:_[a-z]+)+)(?![A-Za-z0-9_])/,
    policy: 'AGENTS.md: map machine tokens through user-facing copy',
  },
  {
    id: 'js_leak',
    pattern:
      /\b(?:undefined|NaN|\[object Object\]|Infinity|-Infinity|function\s*\(|=>)\b|\bnull\b(?!\s*(?:hypothesis|and void))/,
    policy: 'runtime values leaked into copy',
  },
  {
    id: 'error_prefix',
    pattern: /\b(?:Error|TypeError|RangeError|ApiError|SyntaxError):\s/,
    policy: 'String(error) prefix leaked into copy',
  },
];

export interface LexiconHit {
  rule: string;
  policy: string;
  match: string;
  text: string;
}

export function scanText(
  text: string,
  rules: readonly LexiconRule[],
): LexiconHit[] {
  const hits: LexiconHit[] = [];
  for (const rule of rules) {
    const m = rule.pattern.exec(text);
    if (m) {
      hits.push({
        rule: rule.id,
        policy: rule.policy,
        match: (m[1] ?? m[0]).trim(),
        text,
      });
    }
  }
  return hits;
}

/** Typographic hygiene for generated sentences. */
export function copyHygieneIssues(text: string): string[] {
  const issues: string[] = [];
  if (text.trim().length === 0) issues.push('empty');
  if (/ {2,}/.test(text)) issues.push('double_space');
  if (/\s[,.;:!?]/.test(text)) issues.push('space_before_punctuation');
  if (/\(\s*\)/.test(text)) issues.push('empty_parentheses');
  const open = (text.match(/\(/g) ?? []).length;
  const close = (text.match(/\)/g) ?? []).length;
  if (open !== close) issues.push('unbalanced_parentheses');
  if (/[.!?]{2,}(?!\.)/.test(text.replace(/…/g, '')))
    issues.push('doubled_terminal');
  if (/\s$/.test(text)) issues.push('trailing_whitespace');
  return issues;
}

// ───────────────────────── color / contrast ─────────────────────────

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(value: unknown): Rgba | null {
  if (typeof value !== 'string') return null;
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim());
  if (hex) {
    const n = parseInt(hex[1] ?? '0', 16);
    const alpha = hex[2] !== undefined ? parseInt(hex[2], 16) / 255 : 1;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: alpha };
  }
  const short = /^#([0-9a-f]{3})$/i.exec(value.trim());
  if (short) {
    const s = short[1] ?? '000';
    return {
      r: parseInt(`${s[0]}${s[0]}`, 16),
      g: parseInt(`${s[1]}${s[1]}`, 16),
      b: parseInt(`${s[2]}${s[2]}`, 16),
      a: 1,
    };
  }
  const rgba =
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i.exec(
      value.trim(),
    );
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (value === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (value === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  return null;
}

/** Source-over composite of `top` onto an opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG 2.x contrast ratio between two opaque colors. */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export function isLargeText(
  fontSize: number,
  weight: unknown,
  fontFamily?: unknown,
): boolean {
  const bold =
    (typeof fontFamily === 'string' &&
      /semibold|bold|heavy|black/i.test(fontFamily)) ||
    weight === 'bold' ||
    weight === '600' ||
    weight === '700' ||
    weight === '800' ||
    weight === '900' ||
    weight === 600 ||
    weight === 700 ||
    weight === 800 ||
    weight === 900;
  // WCAG: 18pt (~24px) regular, or 14pt (~18.66px) bold.
  return fontSize >= 24 || (bold && fontSize >= 18.66);
}

// ───────────────────────── rendered-tree walker ─────────────────────────

type Style = Record<string, unknown>;

export function flatStyle(node: ReactTestInstance): Style {
  const flattened = StyleSheet.flatten(node.props['style']);
  return flattened && typeof flattened === 'object' ? (flattened as Style) : {};
}

export function isHost(node: ReactTestInstance, name: string): boolean {
  return typeof node.type === 'string' && node.type === name;
}

/** Concatenated string children of a host <Text>. */
export function textOf(node: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (child: unknown): void => {
    if (typeof child === 'string' || typeof child === 'number') {
      parts.push(String(child));
    } else if (Array.isArray(child)) {
      child.forEach(walk);
    }
  };
  walk(node.props['children']);
  return parts.join('');
}

/** Every visible text string, in tree order. */
export function allText(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => isHost(node, 'Text'))
    .map(textOf)
    .map(t => t.trim())
    .filter(t => t.length > 0);
}

function descendantText(node: ReactTestInstance): string {
  return node
    .findAll(n => isHost(n, 'Text'))
    .map(textOf)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nearestBackground(node: ReactTestInstance, fallback: Rgba): Rgba {
  let cursor: ReactTestInstance | null = node.parent;
  const layers: Rgba[] = [];
  while (cursor) {
    const bg = parseColor(flatStyle(cursor)['backgroundColor']);
    if (bg && bg.a > 0) {
      layers.push(bg);
      if (bg.a >= 1) break;
    }
    cursor = cursor.parent;
  }
  let result = fallback;
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const layer = layers[i];
    if (layer) result = composite(layer, result);
  }
  return result;
}

export interface ControlRow {
  name: string;
  role: string | null;
  disabledProp: boolean;
  a11yDisabled: boolean;
  hitSlop: boolean;
  minHeight: number | null;
  height: number | null;
  width: number | null;
  testID: string | null;
  issues: string[];
}

export interface TextRow {
  text: string;
  fontSize: number | null;
  fontWeight: string | null;
  color: string | null;
  background: string;
  contrast: number | null;
  threshold: number | null;
  passes: boolean | null;
  numberOfLines: number | null;
  allowFontScaling: boolean | null;
  maxFontSizeMultiplier: number | null;
  issues: string[];
}

export interface StateAudit {
  screen: string;
  state: string;
  seed: number | null;
  input: unknown;
  texts: TextRow[];
  controls: ControlRow[];
  roles: Record<string, number>;
  /** Every progressbar/adjustable node: label + accessibilityValue. */
  valued: { role: string; label: string | null; value: unknown }[];
  liveRegions: string[];
  alerts: number;
  modals: { count: number; withViewIsModal: number };
  imagesWithoutLabel: number;
  lexicon: LexiconHit[];
  /** KNOWN_ACCEPTED_TERMS exposures — measured, never counted as failures. */
  informational: LexiconHit[];
  hygiene: { text: string; issues: string[] }[];
  issues: string[];
}

/**
 * React.memo / forwardRef wrappers are unwrapped by react-test-renderer, so
 * the instance `type` is the INNER component (e.g. `Pressable.type`). Match
 * both the exported symbol and its inner type.
 */
function unwrapTypes(component: unknown): unknown[] {
  const out: unknown[] = [component];
  if (typeof component === 'object' && component !== null) {
    const inner = component as { type?: unknown; render?: unknown };
    if (inner.type !== undefined) out.push(inner.type);
    if (inner.render !== undefined) out.push(inner.render);
  }
  return out;
}

const PRESSABLE_TYPES: readonly unknown[] = [
  Pressable,
  TouchableOpacity,
  TouchableHighlight,
  TouchableWithoutFeedback,
].flatMap(unwrapTypes);

export interface AuditOptions {
  screen: string;
  state: string;
  seed?: number;
  input?: unknown;
  /** Opaque screen background used when no ancestor declares one. */
  screenBackground: string;
  /** Text patterns that are allowed to look like machine tokens (e.g. testID-only). */
  allowTokens?: readonly RegExp[];
}

export function auditRenderedTree(
  renderer: ReactTestRenderer,
  options: AuditOptions,
): StateAudit {
  const fallbackBg = parseColor(options.screenBackground) ?? {
    r: 255,
    g: 255,
    b: 255,
    a: 1,
  };
  const root = renderer.root;
  const issues: string[] = [];

  // ---- text ----
  const texts: TextRow[] = [];
  const lexicon: LexiconHit[] = [];
  const informational: LexiconHit[] = [];
  const hygiene: { text: string; issues: string[] }[] = [];
  for (const node of root.findAll(n => isHost(n, 'Text'))) {
    const text = textOf(node).replace(/\s+/g, ' ').trim();
    if (text.length === 0) continue;
    const style = flatStyle(node);
    const fontSize =
      typeof style['fontSize'] === 'number' ? style['fontSize'] : null;
    const weight = style['fontWeight'];
    const fg = parseColor(style['color']);
    const bg = nearestBackground(node, fallbackBg);
    const rowIssues: string[] = [];
    let contrast: number | null = null;
    let threshold: number | null = null;
    let passes: boolean | null = null;
    if (fg) {
      const opaqueFg = fg.a < 1 ? composite(fg, bg) : fg;
      contrast = Number(contrastRatio(opaqueFg, bg).toFixed(2));
      threshold = isLargeText(fontSize ?? 16, weight, style['fontFamily'])
        ? 3
        : 4.5;
      passes = contrast >= threshold;
      if (!passes) rowIssues.push('contrast_below_aa');
    } else {
      rowIssues.push('color_unresolved');
    }
    const numberOfLines =
      typeof node.props['numberOfLines'] === 'number'
        ? (node.props['numberOfLines'] as number)
        : null;
    if (numberOfLines === 1) rowIssues.push('single_line_clamp');
    const allowFontScaling =
      typeof node.props['allowFontScaling'] === 'boolean'
        ? (node.props['allowFontScaling'] as boolean)
        : null;
    if (allowFontScaling === false) rowIssues.push('font_scaling_disabled');
    const maxFontSizeMultiplier =
      typeof node.props['maxFontSizeMultiplier'] === 'number'
        ? (node.props['maxFontSizeMultiplier'] as number)
        : null;
    if (maxFontSizeMultiplier !== null && maxFontSizeMultiplier < 1.3) {
      rowIssues.push('font_scaling_capped_below_1_3');
    }
    const allowed = (options.allowTokens ?? []).some(p => p.test(text));
    const hits = [
      ...scanText(text, FORBIDDEN_TERMS),
      ...scanText(text, UNSUPPORTED_CLAIMS),
      ...(allowed ? [] : scanText(text, MACHINE_TOKEN_PATTERNS)),
    ];
    if (hits.length > 0) {
      lexicon.push(...hits);
      rowIssues.push(...hits.map(h => `lexicon:${h.rule}`));
    }
    informational.push(...scanText(text, KNOWN_ACCEPTED_TERMS));
    const hy = copyHygieneIssues(text);
    if (hy.length > 0) hygiene.push({ text, issues: hy });
    texts.push({
      text,
      fontSize,
      fontWeight: weight === undefined ? null : String(weight),
      color: typeof style['color'] === 'string' ? style['color'] : null,
      background: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`,
      contrast,
      threshold,
      passes,
      numberOfLines,
      allowFontScaling,
      maxFontSizeMultiplier,
      issues: rowIssues,
    });
  }

  // ---- controls ----
  const controls: ControlRow[] = [];
  // `accessible={false}` pressables (dialog backdrops) are not VoiceOver
  // elements; they are excluded from the control audit on purpose.
  const pressables = root.findAll(
    n => PRESSABLE_TYPES.includes(n.type) && n.props['accessible'] !== false,
  );
  for (const node of pressables) {
    const label = node.props['accessibilityLabel'];
    const name =
      typeof label === 'string' && label.trim().length > 0
        ? label.trim()
        : descendantText(node);
    const role =
      typeof node.props['accessibilityRole'] === 'string'
        ? (node.props['accessibilityRole'] as string)
        : null;
    const state = node.props['accessibilityState'];
    const a11yDisabled =
      typeof state === 'object' &&
      state !== null &&
      (state as { disabled?: unknown }).disabled === true;
    const disabledProp = node.props['disabled'] === true;
    // Pressable resolves a function style onto its host View; measure the
    // rendered host box, not the composite's unresolved prop.
    const hostBox = node.findAll(n => isHost(n, 'View'))[0];
    const style = hostBox ? flatStyle(hostBox) : flatStyle(node);
    const num = (k: string): number | null =>
      typeof style[k] === 'number' ? (style[k] as number) : null;
    const minHeight = num('minHeight');
    const height = num('height');
    const width = num('width');
    const hitSlop = node.props['hitSlop'] !== undefined;
    const rowIssues: string[] = [];
    if (name.length === 0) rowIssues.push('unnamed_control');
    if (role === null) rowIssues.push('missing_role');
    if (disabledProp && !a11yDisabled) rowIssues.push('disabled_not_announced');
    const effectiveHeight = Math.max(minHeight ?? 0, height ?? 0);
    if (!hitSlop) {
      if (effectiveHeight > 0 && effectiveHeight < 44) {
        rowIssues.push('height_below_44');
      }
      if (width !== null && width < 44) rowIssues.push('width_below_44');
      if (effectiveHeight === 0 && width === null) {
        rowIssues.push('hit_target_unknown');
      }
    }
    controls.push({
      name,
      role,
      disabledProp,
      a11yDisabled,
      hitSlop,
      minHeight,
      height,
      width,
      testID:
        typeof node.props['testID'] === 'string'
          ? (node.props['testID'] as string)
          : null,
      issues: rowIssues,
    });
  }
  const enabledNames = new Map<string, number>();
  for (const c of controls) {
    if (c.disabledProp || c.name.length === 0) continue;
    enabledNames.set(c.name, (enabledNames.get(c.name) ?? 0) + 1);
  }
  for (const [name, count] of enabledNames) {
    if (count > 1) issues.push(`duplicate_control_name:${name}`);
  }

  // ---- semantics ----
  const roles: Record<string, number> = {};
  const valued: StateAudit['valued'] = [];
  const liveRegions: string[] = [];
  let alerts = 0;
  for (const node of root.findAll(n => typeof n.type === 'string')) {
    const role = node.props['accessibilityRole'];
    if (typeof role === 'string') {
      roles[role] = (roles[role] ?? 0) + 1;
      if (role === 'alert') alerts += 1;
      if (role === 'progressbar' || role === 'adjustable') {
        const label = node.props['accessibilityLabel'];
        const value = node.props['accessibilityValue'];
        valued.push({
          role,
          label: typeof label === 'string' ? label : null,
          value: value ?? null,
        });
        if (value === undefined) issues.push(`${role}_without_value`);
      }
    }
    const live = node.props['accessibilityLiveRegion'];
    if (typeof live === 'string' && live !== 'none') {
      const label = node.props['accessibilityLabel'];
      liveRegions.push(
        `${live}:${typeof label === 'string' ? label : descendantText(node)}`,
      );
    }
  }
  const modalNodes = root
    .findAllByType(Modal)
    .filter(m => m.props['visible'] !== false);
  const withViewIsModal = modalNodes.filter(
    m =>
      m.findAll(n => n.props['accessibilityViewIsModal'] === true).length > 0,
  ).length;
  if (modalNodes.length > withViewIsModal)
    issues.push('modal_without_view_is_modal');
  // An image is exposed on its own only when no ancestor groups it under a
  // label (an `accessible`/labelled container is ONE VoiceOver element).
  const groupedByAncestor = (node: ReactTestInstance): boolean => {
    let cursor = node.parent;
    while (cursor) {
      if (
        cursor.props['accessible'] === true ||
        typeof cursor.props['accessibilityLabel'] === 'string' ||
        cursor.props['accessibilityElementsHidden'] === true ||
        cursor.props['importantForAccessibility'] === 'no-hide-descendants'
      ) {
        return true;
      }
      cursor = cursor.parent;
    }
    return false;
  };
  const imagesWithoutLabel = root
    .findAllByType(Image)
    .filter(
      img =>
        img.props['accessible'] !== false &&
        img.props['accessibilityLabel'] === undefined &&
        img.props['accessibilityRole'] !== 'none' &&
        img.props['accessibilityElementsHidden'] !== true &&
        img.props['importantForAccessibility'] !== 'no-hide-descendants' &&
        !groupedByAncestor(img),
    ).length;

  for (const t of texts) {
    for (const i of t.issues) {
      if (i.startsWith('lexicon:') || i === 'font_scaling_disabled') {
        issues.push(`${i}:${t.text.slice(0, 80)}`);
      }
    }
  }
  for (const c of controls) {
    for (const i of c.issues) {
      if (i === 'unnamed_control' || i === 'disabled_not_announced') {
        issues.push(`${i}:${c.testID ?? c.name}`);
      }
    }
  }

  return {
    screen: options.screen,
    state: options.state,
    seed: options.seed ?? null,
    input: options.input ?? null,
    texts,
    controls,
    roles,
    valued,
    liveRegions,
    alerts,
    modals: { count: modalNodes.length, withViewIsModal },
    imagesWithoutLabel,
    lexicon,
    informational,
    hygiene,
    issues,
  };
}

/** Compact per-state summary for the matrix artifact. */
export function summarize(a: StateAudit): Record<string, unknown> {
  return {
    screen: a.screen,
    state: a.state,
    seed: a.seed,
    texts: a.texts.length,
    controls: a.controls.length,
    unnamedControls: a.controls.filter(c =>
      c.issues.includes('unnamed_control'),
    ).length,
    roleless: a.controls.filter(c => c.issues.includes('missing_role')).length,
    smallTargets: a.controls.filter(
      c =>
        c.issues.includes('height_below_44') ||
        c.issues.includes('width_below_44'),
    ).length,
    contrastFailures: a.texts.filter(t => t.passes === false).length,
    contrastUnresolved: a.texts.filter(t => t.passes === null).length,
    lexiconHits: a.lexicon.length,
    informationalHits: a.informational.length,
    roles: a.roles,
    liveRegions: a.liveRegions.length,
    alerts: a.alerts,
    modals: a.modals,
    imagesWithoutLabel: a.imagesWithoutLabel,
    issues: a.issues,
  };
}
