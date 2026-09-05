import type { Cell } from './cells';
import { utf8Decode } from './node';

/**
 * Pure-TypeScript model of the SQLite semantics the db.ts fixture-purge
 * statements rely on, so the harness can predict which seeded rows the
 * migration must keep without asking SQLite (the system under test).
 *
 * Model of `json_valid(payload) AND json_extract(payload,'$.source') <> 'real'`:
 *  - text is read up to its first NUL byte (sqlite3_value_text semantics);
 *  - RFC-8259 text only (no JSON5), nesting limited to JSON_MAX_DEPTH = 1000;
 *  - `$.source` resolves to the FIRST top-level member labelled "source";
 *  - a missing member or JSON null makes the comparison NULL (row kept); any
 *    other value that is not exactly the JSON string "real" deletes the row.
 */

export type SourceLookup =
  | { kind: 'invalid' }
  | { kind: 'absent' }
  | { kind: 'null' }
  | { kind: 'string'; value: string }
  | { kind: 'other'; json: string };

const JSON_MAX_DEPTH = 1000;

function truncateAtNul(text: string): string {
  const nul = text.indexOf('\u0000');
  return nul === -1 ? text : text.slice(0, nul);
}

/** Depth of container nesting, ignoring brackets inside string literals. */
function containerDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') {
      depth++;
      if (depth > max) max = depth;
    } else if (ch === '}' || ch === ']') depth--;
  }
  return max;
}

function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** Index just past the JSON value starting at `i` (input already validated). */
function skipValue(text: string, i: number): number {
  while (isWs(text[i])) i++;
  const ch = text[i];
  if (ch === '"') {
    i++;
    for (; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '"') return i + 1;
    }
    return i;
  }
  if (ch === '{' || ch === '[') {
    let depth = 0;
    let inString = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === '\\') i++;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return i;
  }
  while (
    i < text.length &&
    !',}]'.includes(text[i] as string) &&
    !isWs(text[i])
  )
    i++;
  return i;
}

export function sqliteSourceLookup(payload: string): SourceLookup {
  const text = truncateAtNul(payload);
  if (containerDepth(text) > JSON_MAX_DEPTH) return { kind: 'invalid' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'invalid' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'absent' };
  }
  // Walk the top-level members in order; SQLite returns the first match.
  let i = text.indexOf('{') + 1;
  for (;;) {
    while (isWs(text[i])) i++;
    if (text[i] === '}') return { kind: 'absent' };
    if (text[i] === ',') {
      i++;
      continue;
    }
    const keyEnd = skipValue(text, i);
    const key = JSON.parse(text.slice(i, keyEnd)) as string;
    i = keyEnd;
    while (isWs(text[i])) i++;
    i++; // ':'
    while (isWs(text[i])) i++;
    const valueEnd = skipValue(text, i);
    const valueText = text.slice(i, valueEnd);
    i = valueEnd;
    if (key === 'source') {
      const value = JSON.parse(valueText) as unknown;
      if (value === null) return { kind: 'null' };
      if (typeof value === 'string') return { kind: 'string', value };
      return { kind: 'other', json: valueText };
    }
  }
}

/** What JavaScript (`JSON.parse`, last duplicate wins) sees as the source. */
/**
 * True when `payload` is exactly what `JSON.stringify` would emit for its own
 * parse — the only shape the app itself ever writes to `outbox.payload`.
 * Duplicate keys, BOMs, comments, odd whitespace and escapes are all
 * non-canonical: SQLite and JavaScript legitimately disagree on some of them
 * (SQLite's json_extract reads the FIRST duplicate member, JSON.parse keeps
 * the LAST), so those are recorded as divergences, not contract breaks.
 */
export function isCanonicalJson(payload: string): boolean {
  try {
    return JSON.stringify(JSON.parse(payload)) === payload;
  } catch {
    return false;
  }
}

export function jsSource(payload: string): unknown {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return undefined;
    return (parsed as Record<string, unknown>)['source'];
  } catch {
    return undefined;
  }
}

/**
 * Text SQLite's JSON/LIKE functions would see for `cell` (blobs are read as
 * their bytes; `expr` cells are resolved by the caller's table of known
 * expressions — see `exprPayloadText`).
 */
export function cellText(cell: Cell): string | null {
  switch (cell.kind) {
    case 'null':
      return null;
    case 'int':
    case 'real':
      return cell.literal;
    case 'text':
      return cell.value;
    case 'blob':
      return utf8Decode(cell.bytes);
    case 'expr':
      return exprPayloadText(cell.describe);
  }
}

/**
 * JSON text equivalent of the SQL expressions `payloadCell` can emit. JSONB
 * blobs and zero blobs are not RFC-8259 text, so `json_valid` is 0 for them
 * and the purge leaves the row alone; a text-bytes blob is parsed like text.
 */
export function exprPayloadText(describe: string): string | null {
  switch (describe) {
    case 'jsonb(fixture)':
    case 'jsonb(real)':
    case 'zeroblob(70000)':
      return null;
    case 'blob(fixture)':
    case 'json(fixture)':
      return '{"source":"fixture"}';
    default:
      return null;
  }
}

/** `kind = 'shot.sync'` — exact text comparison, blobs never match. */
export function isShotSyncKind(kind: Cell): boolean {
  return kind.kind === 'text' && kind.value === 'shot.sync';
}

/**
 * True when the fixture purge deletes an outbox row holding `payload`.
 * `expr` cells are opaque to the model: the caller supplies their JSON text.
 */
export function outboxRowDeleted(
  kind: Cell,
  payloadText: string | null,
): boolean {
  if (!isShotSyncKind(kind)) return false;
  if (payloadText === null) return false;
  const lookup = sqliteSourceLookup(payloadText);
  switch (lookup.kind) {
    case 'invalid':
    case 'absent':
    case 'null':
      return false;
    case 'string':
      return lookup.value !== 'real';
    case 'other':
      return true;
  }
}

/** `source <> 'real'` on local_shot: only exact text 'real' survives. */
export function shotRowDeleted(source: Cell): boolean {
  return !(source.kind === 'text' && source.value === 'real');
}

/** `completed = 0` with INTEGER affinity applied to the stored cell. */
export function completedIsZero(completed: Cell): boolean {
  switch (completed.kind) {
    case 'int':
      return Number(completed.literal) === 0;
    case 'real':
      return Number(completed.literal) === 0;
    case 'text': {
      const trimmed = completed.value.trim();
      return /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)
        ? Number(trimmed) === 0
        : false;
    }
    default:
      return false;
  }
}

/** `summary LIKE '%fixture%'` — ASCII case-insensitive, stops at NUL. */
export function summaryLooksFixture(summary: Cell): boolean {
  const raw = cellText(summary);
  if (raw === null) return false;
  return truncateAtNul(raw)
    .replace(/[A-Z]/g, c => c.toLowerCase())
    .includes('fixture');
}

/** Cell identity as SQLite compares TEXT-affinity columns (`id NOT IN`). */
export function cellKey(cell: Cell): string {
  switch (cell.kind) {
    case 'null':
      return 'null';
    case 'int':
      return `text:${cell.literal}`;
    case 'real':
      return `real:${cell.literal}`;
    case 'text':
      return `text:${cell.value}`;
    case 'blob':
      return `blob:${utf8Decode(cell.bytes)}`;
    case 'expr':
      return `expr:${cell.sql}`;
  }
}
