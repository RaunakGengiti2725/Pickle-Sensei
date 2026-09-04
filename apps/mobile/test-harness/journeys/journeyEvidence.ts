import type TestRenderer from 'react-test-renderer';

// Node built-ins, typed the same way be-mobile-security-secrets.test.ts does
// (the RN tsconfig ships no node types).
declare const require: (id: string) => unknown;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number };
};
declare const globalThis: { gc?: () => void };
const fs = require('fs') as {
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string) => void;
  appendFileSync: (p: string, data: string) => void;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
};

/** Evidence root for artifacts; unset → nothing is written to disk. */
export function evidenceRoot(): string | undefined {
  return process.env.JOURNEY_EVIDENCE_DIR;
}

/**
 * Heap in use (MB, one decimal) after a forced GC when node runs with
 * `--expose-gc`; without it the number is the un-collected heap and
 * `forced` is false so the two are never compared as equals.
 */
export function heapSample(): { heapUsedMb: number; forced: boolean } {
  const forced = typeof globalThis.gc === 'function';
  if (forced) globalThis.gc!();
  return {
    heapUsedMb:
      Math.round((process.memoryUsage().heapUsed / 1048576) * 10) / 10,
    forced,
  };
}

/** Read a numeric knob from the environment with a default. */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : Number(raw);
}

/**
 * Evidence utilities shared by the first-launch journey harnesses.
 *
 * - `screenDump` renders a react-test-renderer host tree as a compact
 *   "textual screenshot": one line per accessible element (role, label,
 *   state, value) and per visible string. It is deterministic and small
 *   enough to pin in a jest snapshot, unlike the full host JSON.
 * - `JourneyLog` accumulates a machine-readable step ledger per scenario and,
 *   when JOURNEY_EVIDENCE_DIR is set, writes it plus the raw
 *   `renderer.toJSON()` tree for every step to disk.
 * - `Rng` is a seeded PRNG (mulberry32) so every fuzz run is replayable from
 *   the seed recorded in the ledger.
 */

type HostNode = {
  type: string;
  props: Record<string, unknown>;
  children: (HostNode | string)[] | null;
};

type JsonTree = ReturnType<TestRenderer.ReactTestRenderer['toJSON']>;

function isHostNode(value: unknown): value is HostNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HostNode).type === 'string'
  );
}

function stateSummary(state: unknown): string {
  if (!state || typeof state !== 'object') return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    if (value === undefined || value === false) continue;
    parts.push(value === true ? key : `${key}=${String(value)}`);
  }
  return parts.length > 0 ? ` {${parts.join(' ')}}` : '';
}

function valueSummary(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const v = value as {
    min?: number;
    max?: number;
    now?: number;
    text?: string;
  };
  if (typeof v.now === 'number') {
    return ` value=${v.now}/${v.max ?? '?'}`;
  }
  if (typeof v.text === 'string') return ` value="${v.text}"`;
  return '';
}

function describeNode(node: HostNode): string | null {
  const p = node.props;
  const role =
    typeof p.accessibilityRole === 'string' ? p.accessibilityRole : null;
  const label =
    typeof p.accessibilityLabel === 'string' ? p.accessibilityLabel : null;
  const testID = typeof p.testID === 'string' ? p.testID : null;
  if (node.type === 'TextInput') {
    const placeholder =
      typeof p.placeholder === 'string'
        ? ` placeholder="${p.placeholder}"`
        : '';
    const value = typeof p.value === 'string' ? ` value="${p.value}"` : '';
    const editable = p.editable === false ? ' editable=false' : '';
    return `[TextInput${label ? ` "${label}"` : ''}${placeholder}${value}${editable}]`;
  }
  if (!role && !label && !testID) return null;
  const head = role ?? node.type;
  const parts = [head];
  if (label) parts.push(`"${label}"`);
  if (testID) parts.push(`#${testID}`);
  const hint =
    typeof p.accessibilityHint === 'string'
      ? ` hint="${p.accessibilityHint}"`
      : '';
  return `[${parts.join(' ')}${stateSummary(p.accessibilityState)}${valueSummary(
    p.accessibilityValue,
  )}${hint}]`;
}

/** Compact, deterministic textual screenshot of the host tree. */
export function screenDump(tree: JsonTree): string {
  const lines: string[] = [];
  const walk = (node: HostNode | string, depth: number) => {
    if (typeof node === 'string') {
      const text = node.trim();
      if (text) lines.push(`${'  '.repeat(depth)}"${text}"`);
      return;
    }
    const line = describeNode(node);
    const nextDepth = line ? depth + 1 : depth;
    if (line) lines.push(`${'  '.repeat(depth)}${line}`);
    // Adjacent string children of a Text node are one visual run.
    const children = node.children ?? [];
    let run: string[] = [];
    const flushRun = () => {
      const text = run.join('').trim();
      if (text) lines.push(`${'  '.repeat(nextDepth)}"${text}"`);
      run = [];
    };
    for (const child of children) {
      if (typeof child === 'string') {
        run.push(child);
      } else {
        flushRun();
        walk(child, nextDepth);
      }
    }
    flushRun();
  };
  if (tree === null) return '(empty)';
  const roots = Array.isArray(tree) ? tree : [tree];
  for (const root of roots) {
    if (isHostNode(root)) walk(root, 0);
  }
  return lines.join('\n');
}

/** Every string rendered anywhere in the host tree, joined with newlines. */
export function visibleText(tree: JsonTree): string {
  const out: string[] = [];
  const walk = (node: HostNode | string) => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  if (tree === null) return '';
  for (const root of Array.isArray(tree) ? tree : [tree]) {
    if (isHostNode(root)) walk(root);
  }
  return out.join('\n');
}

/** Every accessibilityLabel / accessibilityHint / placeholder in the tree. */
export function accessibleStrings(tree: JsonTree): string[] {
  const out: string[] = [];
  const walk = (node: HostNode | string) => {
    if (typeof node === 'string') return;
    for (const key of [
      'accessibilityLabel',
      'accessibilityHint',
      'placeholder',
    ]) {
      const value = node.props[key];
      if (typeof value === 'string') out.push(value);
    }
    for (const child of node.children ?? []) walk(child);
  };
  if (tree === null) return out;
  for (const root of Array.isArray(tree) ? tree : [tree]) {
    if (isHostNode(root)) walk(root);
  }
  return out;
}

export interface PressableRecord {
  label: string;
  role: string | null;
  disabled: boolean;
  selected: boolean | null;
  hint: string | null;
}

/**
 * Innermost node per accessibilityLabel that has an onPress (design wrappers
 * forward the label down to the react-native Pressable, so the leaf is where
 * disabled / role are finally resolved).
 */
export function pressables(
  renderer: TestRenderer.ReactTestRenderer,
): TestRenderer.ReactTestInstance[] {
  const isMatch = (node: TestRenderer.ReactTestInstance) =>
    typeof node.props?.accessibilityLabel === 'string' &&
    typeof node.props?.onPress === 'function';
  return renderer.root
    .findAll(isMatch)
    .filter(
      node =>
        node.findAll(child => child !== node && isMatch(child)).length === 0,
    );
}

export function pressableRecords(
  renderer: TestRenderer.ReactTestRenderer,
): PressableRecord[] {
  return pressables(renderer).map(node => ({
    label: String(node.props.accessibilityLabel),
    role:
      typeof node.props.accessibilityRole === 'string'
        ? node.props.accessibilityRole
        : null,
    disabled: Boolean(
      node.props.disabled ?? node.props.accessibilityState?.disabled,
    ),
    selected:
      typeof node.props.accessibilityState?.selected === 'boolean'
        ? node.props.accessibilityState.selected
        : null,
    hint:
      typeof node.props.accessibilityHint === 'string'
        ? node.props.accessibilityHint
        : null,
  }));
}

/**
 * Copy the dossier forbids anywhere user-facing (APP_STORE_SUBMISSION.md):
 * platforms/competitors/guest mode and accuracy/superlative claims.
 */
export const FORBIDDEN_COPY: RegExp[] = [
  /\bandroid\b/i,
  /google play/i,
  /guest mode/i,
  /live court/i,
  /\bdupr\b/i,
  /swingvision/i,
  /pb vision/i,
  /selkirk/i,
  /joola/i,
  /\d+(\.\d+)?\s?%/,
  /\b(best|most accurate|#1|number one|world[- ]class)\b/i,
  /\bskip\b/i,
];

export function forbiddenCopyHits(strings: string[]): string[] {
  const hits: string[] = [];
  for (const s of strings) {
    for (const re of FORBIDDEN_COPY) {
      if (re.test(s)) hits.push(`${re.source} :: ${s}`);
    }
  }
  return hits;
}

/** mulberry32 — tiny, deterministic, good enough for replayable fuzzing. */
export class Rng {
  private state: number;
  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

export interface JourneyStep {
  index: number;
  action: string;
  stage: string;
  progress: { now: number; max: number } | null;
  pressables: PressableRecord[];
  textInput: { value: string; placeholder: string | null } | null;
  kv: Record<string, string>;
  stores: Record<string, unknown>;
  counters: Record<string, number>;
  screen: string;
}

export class JourneyLog {
  readonly steps: JourneyStep[] = [];
  readonly meta: Record<string, unknown> = {};
  private readonly dir: string | null;
  private lastTree: JsonTree | null = null;

  /**
   * `trees: 'every'` writes a react-test-renderer JSON tree per step (the
   * explicit scenarios); `'last'` keeps only the most recent tree in memory
   * and writes it on `finish()` (the fuzz walks, thousands of steps).
   */
  constructor(
    public readonly scenario: string,
    private readonly trees: 'every' | 'last' = 'every',
    root: string | undefined = evidenceRoot(),
  ) {
    this.dir = root ? path.join(root, scenario) : null;
    if (this.dir) fs.mkdirSync(this.dir, { recursive: true });
  }

  record(step: Omit<JourneyStep, 'index'>, tree: JsonTree): JourneyStep {
    const full: JourneyStep = { index: this.steps.length, ...step };
    this.steps.push(full);
    this.lastTree = tree;
    if (this.dir) {
      const stem = `${String(full.index).padStart(3, '0')}-${full.action
        .replace(/[^a-z0-9]+/gi, '_')
        .slice(0, 60)}`;
      if (this.trees === 'every') {
        fs.writeFileSync(
          path.join(this.dir, `${stem}.tree.json`),
          JSON.stringify(tree, null, 1),
        );
        fs.writeFileSync(
          path.join(this.dir, `${stem}.screen.txt`),
          full.screen,
        );
      }
    }
    return full;
  }

  finish(extra: Record<string, unknown> = {}): void {
    Object.assign(this.meta, extra);
    if (!this.dir) return;
    if (this.trees === 'last' && this.lastTree) {
      fs.writeFileSync(
        path.join(this.dir, 'final.tree.json'),
        JSON.stringify(this.lastTree, null, 1),
      );
      const last = this.steps[this.steps.length - 1];
      if (last) {
        fs.writeFileSync(path.join(this.dir, 'final.screen.txt'), last.screen);
      }
    }
    fs.writeFileSync(
      path.join(this.dir, 'journey.json'),
      JSON.stringify(
        {
          scenario: this.scenario,
          meta: this.meta,
          steps: this.steps.map(({ screen: _screen, ...rest }) => rest),
        },
        null,
        2,
      ),
    );
  }
}

/** Appends one row to a JSON-lines table under the evidence root. */
export function appendTableRow(
  table: string,
  row: Record<string, unknown>,
  root: string | undefined = evidenceRoot(),
): void {
  if (!root) return;
  fs.mkdirSync(root, { recursive: true });
  fs.appendFileSync(
    path.join(root, `${table}.jsonl`),
    `${JSON.stringify(row)}\n`,
  );
}
