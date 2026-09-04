import fs from 'node:fs';
import path from 'node:path';
import { StyleSheet } from 'react-native';
import type {
  ReactTestRendererJSON,
  ReactTestRendererNode,
} from 'react-test-renderer';

/**
 * Shared harness for the `cmp-stroke-result` stress campaigns
 * (lens `boundary-i18n-a11y`). Everything here is deterministic: a campaign
 * is a range of seeds, each seed rebuilds exactly one scenario, and a JSON
 * seed → outcome table is written when `STRESS_ARTIFACT_DIR` is set.
 *
 * Replay one seed:
 *   STRESS_SEED=<seed> npx jest --ci __tests__/stress/<suite>
 * Scale a campaign:
 *   STRESS_ITER=<n> npx jest --ci __tests__/stress/<suite>
 *
 * Layout notes (read before trusting `estimateLayout`): react-test-renderer
 * runs NO layout engine, so widths / font scales cannot be measured here.
 * `estimateLayout` is a static estimator over the rendered host tree —
 * flattened styles + glyph-width heuristics — and every result it emits is
 * labelled INFERRED. Accessibility roles/labels, hitSlop and fixed style
 * dimensions ARE read directly from the rendered tree (VERIFIED at the
 * rendered-tree level; iOS runtime behaviour still needs the Mac plane).
 */

// ─── Campaign knobs ────────────────────────────────────────────────────────

export function campaignSize(defaultIterations: number): number {
  const raw = process.env['STRESS_ITER'];
  if (!raw) return defaultIterations;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultIterations;
}

/** Seeds to run: a single replay seed when STRESS_SEED is set, else a range. */
export function campaignSeeds(base: number, count: number): number[] {
  const replay = process.env['STRESS_SEED'];
  if (replay) {
    const seeds = replay
      .split(',')
      .map(part => Number.parseInt(part.trim(), 10))
      .filter(value => Number.isFinite(value));
    if (seeds.length > 0) return seeds;
  }
  return Array.from({ length: count }, (_, index) => base + index);
}

export function writeArtifact(name: string, payload: unknown): string | null {
  const dir = process.env['STRESS_ARTIFACT_DIR'];
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

// ─── Seeded RNG (mulberry32) ───────────────────────────────────────────────

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = copy[i] as T;
      copy[i] = copy[j] as T;
      copy[j] = a;
    }
    return copy;
  }
}

// ─── I18N corpora (12 locales + hostile script features) ───────────────────

export const LOCALES = [
  'de-DE',
  'fr-FR',
  'ar-EG',
  'hi-IN',
  'ja-JP',
  'pt-BR',
  'tr-TR',
  'ru-RU',
  'th-TH',
  'zh-CN',
  'en-IN',
  'es-419',
] as const;
export type Locale = (typeof LOCALES)[number];

const ZWJ = '\u200d';
const RLM = '\u200f';
const RLO = '\u202e';
const PDF = '\u202c';
const ZWSP = '\u200b';

/** Per-locale sample strings; each list mixes short, long (≥200) and
 * script-specific hazards (combining marks, compounds, RTL controls). */
export const LOCALE_CORPUS: Record<Locale, readonly string[]> = {
  'de-DE': [
    'Vorhand',
    'Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz',
    'Donaudampfschifffahrtselektrizitätenhauptbetriebswerkbauunterbeamtengesellschaft',
    'Straßenbahnhaltestellenüberdachungskonstruktionszeichnung'.repeat(4),
    'ßtraße — Großbuchstaben ẞ',
  ],
  'fr-FR': [
    'Coup droit',
    'Œuvre cœur naïve façade — élève à l’aîné',
    'Le revers à deux mains n’a pas été établi avec certitude '.repeat(5),
  ],
  'ar-EG': [
    'ضربة أمامية',
    `${RLM}تحليل الحركة — لم يتم تأكيد لحظة التلامس${RLM}`,
    'لم يتم التعرّف على الضربة ولم نخمّن — تم قياس الحركة فقط '.repeat(6),
    `${RLO}reversed-by-override${PDF}`,
  ],
  'hi-IN': [
    'फोरहैंड ड्राइव',
    'संपर्क का क्षण स्थापित नहीं हुआ — कुछ भी अनुमानित नहीं किया गया',
    'गति के साक्ष्य से स्विंग के चरण मापे गए '.repeat(8),
  ],
  'ja-JP': [
    'フォアハンド',
    'ｽﾄﾛｰｸ解析（半角カナ）— 接触の瞬間は確定していません',
    '測定された証拠のみが表示されます。何も捏造されていません。'.repeat(8),
  ],
  'pt-BR': [
    'Forehand de ataque',
    'Ação não confirmada — a estimativa não tinha evidência de confirmação',
    'Nada além do que é mostrado pôde ser estabelecido a partir desta captura '.repeat(
      4,
    ),
  ],
  'tr-TR': [
    'İleri vuruş',
    'ıİiI — noktasız ı ve noktalı İ karışımı',
    'Vuruş tanımlanamadı ve tahmin yürütülmedi — hareket ölçüldü '.repeat(5),
  ],
  'ru-RU': [
    'Удар справа',
    'Момент контакта не установлен — ничего не придумано',
    'Фазы замаха измерены по данным о движении, но точный момент контакта не установлен '.repeat(
      4,
    ),
  ],
  'th-TH': [
    'โฟร์แฮนด์',
    'ไม่สามารถระบุจังหวะสัมผัสได้จึงไม่มีการวาดเครื่องหมาย',
    'วัดเฉพาะหลักฐานที่ปรากฏเท่านั้นไม่มีการสร้างข้อมูลขึ้นมาเอง'.repeat(8),
  ],
  'zh-CN': [
    '正手击球',
    '未能确定触球时刻——未绘制标记',
    '仅显示测量到的证据，不会凭空捏造任何内容。'.repeat(12),
  ],
  'en-IN': [
    'Forehand drive',
    'Contact not established — ₹1,00,000 style grouping 12,34,567',
    'Only measured evidence is shown, nothing is invented in this read '.repeat(
      4,
    ),
  ],
  'es-419': [
    'Derecha',
    '¿Contacto? ¡No establecido! — señal ñandú',
    'Nada más allá de lo que se muestra pudo establecerse a partir de esta captura '.repeat(
      4,
    ),
  ],
};

/** Script hazards independent of locale. */
export const HAZARD_STRINGS: readonly string[] = [
  '',
  ' ',
  '   \t\n  ',
  `👨${ZWJ}👩${ZWJ}👧${ZWJ}👦 👩🏽${ZWJ}💻 🏳️${ZWJ}🌈`,
  '🏓'.repeat(120),
  'Z\u0335\u0327\u033b\u032f\u0359\u0320\u0332\u0348\u0347\u0353\u032a\u032e\u0332\u032d\u0349\u033c\u0317a\u0337\u0322\u0321\u033c\u0333\u032b\u0318\u0349\u032a\u031c\u0317\u0359\u0348\u031c\u0323\u032e\u032f\u032d\u031c\u0353\u032b\u032f\u0326\u0320\u035a\u032f\u0319\u031c\u031f\u0354\u0349\u0333\u031c\u0347\u0319\u031cl\u0334\u0327\u033b\u032f\u0359\u0320g\u0338\u0327\u033b\u032fo\u0336\u0327\u033b',
  `a${ZWSP}b${ZWSP}c`.repeat(40),
  'x'.repeat(260),
  'W'.repeat(240),
  'lower_snake_case_token_with_many_segments_exceeding_two_hundred_characters_'.repeat(
    3,
  ),
  'colon:separated:token:with:many:segments',
  `${RLO}${'ـ'.repeat(200)}${PDF}`,
  '\u0000\u0001\u0002 control',
];

/** Literal words that would count as a copy leak if rendered. Inputs that
 * contain them are excluded so the leak check stays unambiguous. */
export const LEAK_WORDS = [
  'undefined',
  'NaN',
  'null',
  '[object Object]',
  'Infinity',
] as const;

export function localeString(rng: Rng, locale: Locale): string {
  return rng.bool(0.8)
    ? rng.pick(LOCALE_CORPUS[locale])
    : rng.pick(HAZARD_STRINGS);
}

// ─── Numeric pools ─────────────────────────────────────────────────────────

/** Finite, type-valid boundary numbers. */
export const FINITE_BOUNDARY: readonly number[] = [
  0,
  -0,
  1,
  -1,
  0.1,
  1e-9,
  0.6,
  0.5999999,
  0.6000001,
  1e6,
  1e15,
  2 ** 53,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_VALUE,
  -1e15,
  -Number.MAX_VALUE,
  Number.MIN_VALUE,
  123456.789,
];

/** Type-valid `number`, but not finite. Kept in a separate tier so the
 * table can say which tier a failure came from. */
export const NON_FINITE: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

export function boundaryNumber(rng: Rng, allowNonFinite: boolean): number {
  if (allowNonFinite && rng.bool(0.15)) return rng.pick(NON_FINITE);
  return rng.pick(FINITE_BOUNDARY);
}

// ─── Layout matrix ─────────────────────────────────────────────────────────

/** iOS Dynamic Type multipliers: Large (default), xxxLarge, AX5. */
export const FONT_SCALES = [1, 1.35, 3.12] as const;
/** iPhone SE (3rd gen) 320 → the widest 430 (Pro Max) in points. */
export const WIDTHS = [320, 393, 430] as const;
/** Host inset the Result route applies around the surface (space.lg). */
export const HOST_HORIZONTAL_INSET = 24;

/** 8 zones: UTC−12, UTC+14, DST edges (US spring-forward, EU fall-back,
 * Lord Howe 30-min DST), and half/quarter-hour offsets. */
export const TIMEZONES = [
  'Etc/GMT+12',
  'Pacific/Kiritimati',
  'America/New_York',
  'Europe/London',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'Asia/Kathmandu',
] as const;

// ─── Host-tree utilities ───────────────────────────────────────────────────

export type HostJSON = ReactTestRendererJSON;

export interface HostVisit {
  node: HostJSON;
  path: string;
  ancestors: HostJSON[];
}

export function hostRoots(
  json: ReactTestRendererNode | ReactTestRendererNode[] | null,
): HostJSON[] {
  if (json === null) return [];
  const list = Array.isArray(json) ? json : [json];
  return list.filter((entry): entry is HostJSON => typeof entry !== 'string');
}

export function walkHost(
  json: ReactTestRendererNode | ReactTestRendererNode[] | null,
  visit: (entry: HostVisit) => void,
): void {
  const recurse = (node: HostJSON, path: string, ancestors: HostJSON[]) => {
    visit({ node, path, ancestors });
    const children = node.children ?? [];
    children.forEach((child, index) => {
      if (typeof child === 'string') return;
      recurse(child, `${path}/${child.type}[${index}]`, [...ancestors, node]);
    });
  };
  hostRoots(json).forEach((root, index) =>
    recurse(root, `${root.type}[${index}]`, []),
  );
}

export type FlatStyle = Record<string, unknown>;

export function flatStyle(node: HostJSON): FlatStyle {
  const style: unknown = node.props['style'];
  const flat = StyleSheet.flatten(style as never);
  return (flat ?? {}) as FlatStyle;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function textOf(node: HostJSON): string {
  let out = '';
  const walk = (entry: ReactTestRendererNode) => {
    if (typeof entry === 'string') {
      out += entry;
      return;
    }
    (entry.children ?? []).forEach(walk);
  };
  (node.children ?? []).forEach(walk);
  return out;
}

export function allStrings(
  json: ReactTestRendererNode | ReactTestRendererNode[] | null,
): string[] {
  const out: string[] = [];
  const walk = (entry: ReactTestRendererNode) => {
    if (typeof entry === 'string') {
      out.push(entry);
      return;
    }
    (entry.children ?? []).forEach(walk);
  };
  if (json === null) return out;
  (Array.isArray(json) ? json : [json]).forEach(walk);
  return out;
}

/** Copy leak: a placeholder word appears in the rendered text (or an
 * accessibility label) without any input string carrying it. */
export function copyLeaks(
  json: ReactTestRendererNode | ReactTestRendererNode[] | null,
  inputs: readonly string[],
): string[] {
  const rendered = allStrings(json);
  walkHost(json, ({ node }) => {
    for (const key of ['accessibilityLabel', 'accessibilityHint'] as const) {
      const value = node.props[key];
      if (typeof value === 'string') rendered.push(value);
    }
    const acValue = node.props['accessibilityValue'];
    if (acValue && typeof acValue === 'object') {
      const text = (acValue as { text?: unknown }).text;
      if (typeof text === 'string') rendered.push(text);
    }
  });
  const leaks: string[] = [];
  for (const word of LEAK_WORDS) {
    if (inputs.some(input => input.includes(word))) continue;
    for (const text of rendered) {
      if (text.includes(word))
        leaks.push(`${word} in ${JSON.stringify(text.slice(0, 80))}`);
    }
  }
  return leaks;
}

// ─── Accessibility audit ───────────────────────────────────────────────────

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'tab',
  'switch',
  'adjustable',
  'checkbox',
  'radio',
  'slider',
  'togglebutton',
  'menuitem',
]);

export function isInteractive(node: HostJSON): boolean {
  const props = node.props;
  if (typeof props['onClick'] === 'function') return true;
  if (typeof props['onPress'] === 'function') return true;
  if (typeof props['onStartShouldSetResponder'] === 'function') return true;
  if (typeof props['onAccessibilityAction'] === 'function') return true;
  const role = props['accessibilityRole'];
  return typeof role === 'string' && INTERACTIVE_ROLES.has(role);
}

export interface InteractiveAudit {
  path: string;
  role: string | null;
  label: string | null;
  hasRole: boolean;
  hasLabel: boolean;
  /** Explicit style width/height/minWidth/minHeight (points, unscaled). */
  width: number | null;
  height: number | null;
  hitSlop: number;
  /** Smallest touch-target edge that can be resolved from the tree, with
   * hitSlop added on both sides; null when the edge depends on content. */
  effectiveMinEdge: number | null;
  meets44: boolean | 'unresolved';
  evidence: { style: FlatStyle; hitSlop: unknown; accessibilityState: unknown };
}

function hitSlopAmount(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const insets = value as Record<string, unknown>;
    const edges = ['top', 'bottom', 'left', 'right'].map(
      edge => num(insets[edge]) ?? 0,
    );
    return Math.min(...edges);
  }
  return 0;
}

export function auditInteractive(
  json: ReactTestRendererNode | ReactTestRendererNode[] | null,
): InteractiveAudit[] {
  const out: InteractiveAudit[] = [];
  walkHost(json, ({ node, path, ancestors }) => {
    if (!isInteractive(node)) return;
    const style = flatStyle(node);
    // PressableScale wraps the Pressable in an Animated.View that carries
    // the container style (e.g. the 44pt play container) — fold it in.
    const container = ancestors[ancestors.length - 1];
    const containerStyle = container ? flatStyle(container) : {};
    const width =
      num(style['width']) ??
      num(style['minWidth']) ??
      num(containerStyle['width']);
    const height =
      num(style['height']) ??
      num(style['minHeight']) ??
      num(containerStyle['height']);
    const slop = hitSlopAmount(node.props['hitSlop']);
    const edges = [width, height].filter((v): v is number => v !== null);
    const role =
      typeof node.props['accessibilityRole'] === 'string'
        ? (node.props['accessibilityRole'] as string)
        : null;
    const label =
      typeof node.props['accessibilityLabel'] === 'string'
        ? (node.props['accessibilityLabel'] as string)
        : null;
    // Height is the edge that is fixed by style for every target here; a
    // missing width means "content / stretch width", which is never the
    // limiting edge for a full-width row control, so only a resolved edge
    // below 44 counts as a failure and "no resolved edge" is unresolved.
    const effective = edges.length > 0 ? Math.min(...edges) + 2 * slop : null;
    out.push({
      path,
      role,
      label,
      hasRole: role !== null,
      hasLabel: label !== null && label.trim().length > 0,
      width,
      height,
      hitSlop: slop,
      effectiveMinEdge: effective,
      meets44: effective === null ? 'unresolved' : effective >= 44,
      evidence: {
        style,
        hitSlop: node.props['hitSlop'],
        accessibilityState: node.props['accessibilityState'],
      },
    });
  });
  return out;
}

// ─── INFERRED layout estimator (no Yoga here) ──────────────────────────────

export interface LayoutOptions {
  width: number;
  fontScale: number;
}

export type LayoutIssueKind =
  'row_text_overflow_x' | 'fixed_height_clip_y' | 'absolute_overlap';

export interface LayoutIssue {
  kind: LayoutIssueKind;
  path: string;
  text: string;
  detail: string;
  /** How far past the limit the estimate lands (1.0 = exactly at limit). */
  ratio: number;
  fontScale: number;
  width: number;
}

const WIDE_SCRIPT =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;
const COMBINING_MARK = /\p{M}/u;
const FORMAT_CONTROL = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/u;
const THAI_OR_INDIC = /[\p{Script=Thai}\p{Script=Devanagari}]/u;
const ARABIC = /\p{Script=Arabic}/u;

/** Approximate advance width of one code point in em. */
export function glyphEm(codePoint: string): number {
  if (COMBINING_MARK.test(codePoint) || FORMAT_CONTROL.test(codePoint))
    return 0;
  if (WIDE_SCRIPT.test(codePoint)) return 1.0;
  if (THAI_OR_INDIC.test(codePoint)) return 0.6;
  if (ARABIC.test(codePoint)) return 0.5;
  if (codePoint === ' ') return 0.3;
  if (/[A-ZÀ-ÞĀ-Ž]/u.test(codePoint)) return 0.68;
  if (/[0-9]/.test(codePoint)) return 0.6;
  if (/[a-z]/.test(codePoint)) return 0.53;
  return 0.55;
}

export function estimateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const cp of text) em += glyphEm(cp);
  return em * fontSize;
}

interface Frame {
  availableWidth: number;
  /** Nearest ancestor with a numeric height + overflow hidden. */
  fixed: { path: string; height: number; used: number } | null;
  /** Parent is a row and does not let this child shrink. */
  rowNoShrink: boolean;
}

function horizontalInset(style: FlatStyle): number {
  const padding = num(style['padding']) ?? 0;
  const horizontal = num(style['paddingHorizontal']) ?? padding;
  const left = num(style['paddingLeft']) ?? horizontal;
  const right = num(style['paddingRight']) ?? horizontal;
  const border = (num(style['borderWidth']) ?? 0) * 2;
  return left + right + border;
}

function verticalInset(style: FlatStyle): number {
  const padding = num(style['padding']) ?? 0;
  const vertical = num(style['paddingVertical']) ?? padding;
  const top = num(style['paddingTop']) ?? vertical;
  const bottom = num(style['paddingBottom']) ?? vertical;
  return top + bottom;
}

function siblingFixedWidths(parent: HostJSON, self: HostJSON): number {
  let total = 0;
  const gap = num(flatStyle(parent)['gap']) ?? 0;
  const children = (parent.children ?? []).filter(
    (child): child is HostJSON => typeof child !== 'string',
  );
  for (const child of children) {
    if (child === self) continue;
    const style = flatStyle(child);
    const width = num(style['width']) ?? num(child.props['width']);
    if (width !== null) total += width;
  }
  return total + gap * Math.max(0, children.length - 1);
}

/**
 * Static layout estimate: for every Text node, decide whether it can wrap
 * (parent not a row, or the Text carries flex/flexShrink) and estimate its
 * single-line width from glyph heuristics × fontSize × fontScale. Reports
 * (a) row-embedded non-shrinking text wider than the available width,
 * (b) fixed-height + overflow-hidden containers whose estimated content
 * height exceeds the box, (c) absolutely positioned siblings whose
 * estimated boxes intersect. INFERRED — no layout engine ran.
 */
export function estimateLayout(
  json: ReactTestRendererNode | ReactTestRendererNode[] | null,
  options: LayoutOptions,
): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const fixedBoxes = new Map<
    string,
    { height: number; used: number; path: string }
  >();

  const visit = (
    node: HostJSON,
    path: string,
    frame: Frame,
    parent: HostJSON | null,
  ) => {
    const style = flatStyle(node);
    const isText = node.type === 'Text';
    const explicitWidth = num(style['width']);
    const available = explicitWidth ?? frame.availableWidth;
    const insetH = horizontalInset(style);
    const contentWidth = Math.max(1, available - insetH);

    let fixed = frame.fixed;
    const height = num(style['height']);
    if (!isText && height !== null && style['overflow'] === 'hidden') {
      const box = { height, used: verticalInset(style), path };
      fixedBoxes.set(path, box);
      fixed = box;
    }

    if (isText) {
      const text = textOf(node);
      const fontSize = (num(style['fontSize']) ?? 14) * options.fontScale;
      const lineHeight =
        (num(style['lineHeight']) ?? fontSize * 1.3) * options.fontScale;
      const singleLine = estimateTextWidth(text, fontSize);
      const shrinks =
        (num(style['flex']) ?? 0) > 0 || (num(style['flexShrink']) ?? 0) > 0;
      if (frame.rowNoShrink && !shrinks && parent) {
        const room = Math.max(1, available - siblingFixedWidths(parent, node));
        if (singleLine > room) {
          issues.push({
            kind: 'row_text_overflow_x',
            path,
            text: text.slice(0, 60),
            detail: `est ${Math.round(singleLine)}pt single-line text in a row that does not let it shrink; ${Math.round(room)}pt available`,
            ratio: singleLine / room,
            fontScale: options.fontScale,
            width: options.width,
          });
        }
        if (fixed) fixed.used += lineHeight;
      } else {
        const lines = Math.max(
          1,
          Math.ceil(singleLine / Math.max(1, available)),
        );
        if (fixed) fixed.used += lines * lineHeight;
      }
      return;
    }

    const row = style['flexDirection'] === 'row';
    const children = (node.children ?? []).filter(
      (child): child is HostJSON => typeof child !== 'string',
    );
    if (fixed && !isText) fixed.used += num(style['marginTop']) ?? 0;
    children.forEach((child, index) => {
      const childStyle = flatStyle(child);
      const childShrinks =
        (num(childStyle['flex']) ?? 0) > 0 ||
        (num(childStyle['flexShrink']) ?? 0) > 0;
      let childAvailable = contentWidth;
      if (childStyle['position'] === 'absolute') {
        const left = num(childStyle['left']) ?? 0;
        const right = num(childStyle['right']) ?? 0;
        childAvailable = Math.max(
          1,
          contentWidth - left - (num(childStyle['right']) !== null ? right : 0),
        );
      }
      visit(
        child,
        `${path}/${child.type}[${index}]`,
        {
          availableWidth: childAvailable,
          fixed,
          rowNoShrink: row && !childShrinks,
        },
        node,
      );
    });

    // Absolute siblings inside a fixed box: estimate boxes and intersect.
    if (height !== null) {
      const absolute = children
        .map((child, index) => ({ child, index, style: flatStyle(child) }))
        .filter(entry => entry.style['position'] === 'absolute');
      const boxes = absolute.map(entry => {
        const s = entry.style;
        const w =
          num(s['width']) ??
          estimateAbsoluteWidth(entry.child, options.fontScale);
        const h =
          num(s['height']) ??
          estimateAbsoluteHeight(entry.child, options.fontScale);
        const top = num(s['top']);
        const bottom = num(s['bottom']);
        const left = num(s['left']);
        const right = num(s['right']);
        const x =
          left !== null ? left : right !== null ? contentWidth - right - w : 0;
        const y =
          top !== null ? top : bottom !== null ? height - bottom - h : 0;
        return {
          path: `${path}/${entry.child.type}[${entry.index}]`,
          x,
          y,
          w: Math.min(w, contentWidth - x),
          h,
          text: textOf(entry.child),
        };
      });
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (overlapX > 0 && overlapY > 0) {
            issues.push({
              kind: 'absolute_overlap',
              path: a.path,
              text: (a.text || b.text).slice(0, 60),
              detail: `est boxes ${JSON.stringify({ a: [a.x, a.y, a.w, a.h].map(Math.round), b: [b.x, b.y, b.w, b.h].map(Math.round) })} intersect (${Math.round(overlapX)}×${Math.round(overlapY)}pt) with ${b.path}`,
              ratio:
                (overlapX * overlapY) /
                Math.max(1, Math.min(a.w * a.h, b.w * b.h)),
              fontScale: options.fontScale,
              width: options.width,
            });
          }
        }
      }
    }
  };

  const estimateAbsoluteWidth = (node: HostJSON, fontScale: number): number => {
    const style = flatStyle(node);
    let total = horizontalInset(style);
    const children = (node.children ?? []).filter(
      (child): child is HostJSON => typeof child !== 'string',
    );
    const gap = num(style['gap']) ?? 0;
    children.forEach((child, index) => {
      const cs = flatStyle(child);
      if (child.type === 'Text') {
        total += estimateTextWidth(
          textOf(child),
          (num(cs['fontSize']) ?? 14) * fontScale,
        );
      } else {
        total += num(cs['width']) ?? num(child.props['width']) ?? 0;
      }
      if (index > 0) total += gap;
    });
    return total;
  };

  const estimateAbsoluteHeight = (
    node: HostJSON,
    fontScale: number,
  ): number => {
    const style = flatStyle(node);
    let tallest = 0;
    const children = (node.children ?? []).filter(
      (child): child is HostJSON => typeof child !== 'string',
    );
    for (const child of children) {
      const cs = flatStyle(child);
      const h =
        child.type === 'Text'
          ? (num(cs['lineHeight']) ?? (num(cs['fontSize']) ?? 14) * 1.3) *
            fontScale
          : (num(cs['height']) ?? num(child.props['height']) ?? 0);
      tallest = Math.max(tallest, h);
    }
    return tallest + verticalInset(style);
  };

  hostRoots(json).forEach((root, index) =>
    visit(
      root,
      `${root.type}[${index}]`,
      {
        availableWidth: options.width - 2 * HOST_HORIZONTAL_INSET,
        fixed: null,
        rowNoShrink: false,
      },
      null,
    ),
  );

  for (const box of fixedBoxes.values()) {
    if (box.used > box.height) {
      issues.push({
        kind: 'fixed_height_clip_y',
        path: box.path,
        text: '',
        detail: `est content height ${Math.round(box.used)}pt inside a ${box.height}pt overflow-hidden box`,
        ratio: box.used / box.height,
        fontScale: options.fontScale,
        width: options.width,
      });
    }
  }
  return issues;
}

/** Compact rendered-tree dump (type + a11y props + flattened style) for
 * attaching as evidence beside a failing seed. */
export function renderedTreeEvidence(
  json: ReactTestRendererNode | ReactTestRendererNode[] | null,
): string[] {
  const lines: string[] = [];
  walkHost(json, ({ node, ancestors }) => {
    const indent = '  '.repeat(ancestors.length);
    const props = node.props;
    const a11y = Object.keys(props)
      .filter(
        key =>
          key.startsWith('accessib') || key === 'hitSlop' || key === 'testID',
      )
      .map(key => `${key}=${JSON.stringify(props[key])}`)
      .join(' ');
    const style = flatStyle(node);
    const dims = [
      'width',
      'height',
      'minHeight',
      'minWidth',
      'flexDirection',
      'flex',
      'flexShrink',
      'overflow',
      'position',
      'numberOfLines',
    ]
      .filter(key => style[key] !== undefined)
      .map(key => `${key}:${JSON.stringify(style[key])}`)
      .join(',');
    const text = node.type === 'Text' ? ` "${textOf(node).slice(0, 50)}"` : '';
    lines.push(
      `${indent}<${node.type}${a11y ? ` ${a11y}` : ''}${dims ? ` {${dims}}` : ''}>${text}`,
    );
  });
  return lines;
}
