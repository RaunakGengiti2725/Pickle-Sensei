/**
 * stress/mod-walkthrough-store-util · lens `boundary-malformed` · walkthroughStore
 *
 * Seeded model-based campaign against `useWalkthroughStore` with a hostile KV
 * layer and hostile yield targets. Every iteration is replayable from
 * (STRESS_SEED, index); the per-iteration table is written as JSON so a
 * failing row can be minimised and re-run alone:
 *
 *   STRESS_SEED=<seed> STRESS_ITER=<index+1> npx jest __tests__/stress/walkthroughStore.boundaryMalformed.stress.test.ts
 *
 * What the KV double can hand the store per read (all generated from the
 * seed): the canonical seen record; malformed / truncated JSON; future
 * schema versions (huge / NaN / Infinity / string versions); prototype-
 * pollution keys; numeric-edge strings; NUL bytes; 64 KiB–256 KiB strings;
 * unicode normalisation pairs, ZWJ / bidi controls; path traversal; the
 * repo's `''` clear-sentinel; wrong JS types in the value slot (number,
 * boolean, bigint, symbol, object, array, null, undefined, throwing getter);
 * malformed row shapes (rows not an array, rows of primitives, rows of null,
 * no `value` column, Proxy that throws); malformed execute results (undefined,
 * null, number, string, no `rows`); read rejections and synchronous throws.
 * Writes may succeed, reject, throw synchronously, or return garbage.
 * Yield targets return non-boolean truthy/falsy values from `isShowing`.
 *
 * Oracle: a small model of the documented contract (header of
 * walkthroughStore.ts) — record written BEFORE the overlay shows, unreadable
 * or unwritable state skips, replay never touches the record, the tour
 * queues behind another ceremony and raises when it is dismissed, concurrent
 * landings collapse into one write and one show. The KV read semantics
 * (`getKv` returns null for an empty-string value — the repo-wide "cleared"
 * sentinel, see appStore/notificationStore `setKv(..., '')`) are part of the
 * spec the model encodes, not something the model reverse-engineers.
 *
 * Invariants asserted for EVERY iteration:
 *   I1  `maybeShowFirstRun` / `replay` / `dismiss` never throw or reject
 *       (non-throwing yield targets; throwing targets are a separate,
 *       documented class — see the `throwing yield targets` block).
 *   I2  the store never writes anything except (WALKTHROUGH_KV_KEY,
 *       WALKTHROUGH_SEEN_VALUE): no malformed payload is ever echoed back.
 *   I3  at most ONE successful write per fresh device, regardless of how many
 *       concurrent landings, replays and dismissals interleave.
 *   I4  a read that errors or a write that fails ⇒ no show, no queue.
 *   I5  visible/queued/record match the model after every operation.
 *   I6  the serialisation queue is never poisoned: the operation after a
 *       failing one still completes (a hang here fails the iteration via a
 *       bounded race, not via the jest timeout).
 *
 * Default scale is small so the suite stays fast; the recorded campaign uses
 * STRESS_ITER=3000 (see the JSON artifact for the exact seed/outcome table).
 */

/**
 * Scripted KV double. `read` is the hostile scripted read; once a write the
 * script marks as successful lands, `stored` holds the row exactly like the
 * real `INSERT OR REPLACE` would and later reads return it — so the model's
 * "at most one successful write per device" invariant means the same thing
 * here as against SQLite.
 */
const mockKv: {
  read: () => unknown;
  write: (params: unknown[]) => unknown;
  writeSucceeds: boolean;
  stored: string | undefined;
  writes: unknown[][];
  getDbThrows: boolean;
} = {
  read: () => ({ rows: [] }),
  write: () => ({ rows: [] }),
  writeSucceeds: true,
  stored: undefined,
  writes: [],
  getDbThrows: false,
};

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    if (mockKv.getDbThrows) throw new Error('getDb exploded');
    return {
      execute(sql: string, params: unknown[] = []) {
        if (sql.startsWith('SELECT value FROM kv')) {
          if (mockKv.stored !== undefined) {
            return Promise.resolve({ rows: [{ value: mockKv.stored }] });
          }
          return mockKv.read();
        }
        if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
          mockKv.writes.push(params);
          if (mockKv.writeSucceeds) mockKv.stored = String(params[1]);
          return mockKv.write(params);
        }
        return Promise.resolve({ rows: [] });
      },
      close() {},
    };
  },
}));

import {
  WALKTHROUGH_KV_KEY,
  WALKTHROUGH_SEEN_VALUE,
  useWalkthroughStore,
  walkthroughYieldsTo,
  type WalkthroughYieldTarget,
} from '../../src/walkthrough/walkthroughStore';

// Node built-ins, typed the way __tests__/xc/deepLinks.webviewGateAdversarial.test.ts
// does (the RN tsconfig ships no node types).
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  writeFileSync: (p: string, data: string) => void;
  mkdirSync: (p: string, options: { recursive: true }) => void;
};
const path = require('path') as { join: (...parts: string[]) => string };
const os = require('os') as { tmpdir: () => string };

const ARTIFACT_DIR =
  process.env.STRESS_ARTIFACT_DIR ??
  path.join(os.tmpdir(), 'stress-mod-walkthrough-store-util');
const STRESS_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const STRESS_ITER = Number(process.env.STRESS_ITER ?? 200);

function writeArtifact(name: string, data: unknown) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, name), JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Seeded PRNG (xorshift32) — iteration i uses seed STRESS_SEED ^ hash(i) so a
// single iteration is replayable without regenerating the ones before it.
// ---------------------------------------------------------------------------

function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function iterationSeed(index: number): number {
  let h = (STRESS_SEED ^ (index * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function int(rand: () => number, min: number, maxInclusive: number): number {
  return min + Math.floor(rand() * (maxInclusive - min + 1));
}

// ---------------------------------------------------------------------------
// Payload generators
// ---------------------------------------------------------------------------

const UNICODE_ATOMS = [
  'é',
  'e\u0301', // NFD of é
  'ﬁ',
  'ﬀ',
  '\u200d', // ZWJ
  '\u200b', // ZWSP
  '\u202e', // RTL override
  '\u2066', // LRI
  '\ufeff', // BOM
  '👩‍👩‍👧‍👦',
  '🏓',
  '\ud83d', // lone high surrogate
  '\udc00', // lone low surrogate
  '\u0000',
  'ａ', // fullwidth a
  'Å',
  'A\u030a',
  '\u00a0',
  '\t',
  '\n',
  '\r\n',
  '\\',
  '"',
  "'",
  '{',
  '}',
  '[',
  ']',
];

function unicodeSoup(rand: () => number, atoms: number): string {
  let out = '';
  for (let i = 0; i < atoms; i += 1) out += pick(rand, UNICODE_ATOMS);
  return out;
}

function hugeString(rand: () => number): string {
  const kib = pick(rand, [64, 65, 96, 128, 256]);
  const filler = pick(rand, ['a', '\u0000', 'é', '🏓', '{"version":1}', ' ']);
  const target = kib * 1024;
  let out = '';
  while (out.length < target) out += filler;
  return out.slice(0, target + int(rand, 0, 3));
}

interface ValuePayload {
  kind: string;
  value: unknown;
  /** Contract-level reading of this row: does the device have a record? */
  seen: boolean;
}

/** String values that the contract reads as "record present". */
function seenString(rand: () => number): ValuePayload {
  const kind = pick(rand, [
    'canonical',
    'truncated-json',
    'malformed-json',
    'future-version',
    'proto-pollution',
    'numeric-edge',
    'nul-bytes',
    'huge',
    'unicode',
    'path-traversal',
    'whitespace',
  ]);
  switch (kind) {
    case 'canonical':
      return { kind, value: WALKTHROUGH_SEEN_VALUE, seen: true };
    case 'truncated-json':
      return {
        kind,
        value: WALKTHROUGH_SEEN_VALUE.slice(
          0,
          int(rand, 1, WALKTHROUGH_SEEN_VALUE.length - 1),
        ),
        seen: true,
      };
    case 'malformed-json':
      return {
        kind,
        value: pick(rand, [
          '{version:1}',
          '{"version":1,}',
          '{"version":01}',
          '{"version":1}}',
          '[{"version":1}]',
          'undefined',
          'null',
          'true',
          '{"version":"1"}',
          '{"version":1e309}',
          '{"version":-0}',
          '{"version":NaN}',
          '{"version":Infinity}',
          '\ufeff{"version":1}',
        ]),
        seen: true,
      };
    case 'future-version':
      return {
        kind,
        value: JSON.stringify({
          version: pick(rand, [
            2,
            3,
            99,
            2 ** 31,
            2 ** 53,
            Number.MAX_SAFE_INTEGER + 2,
            Number.MAX_VALUE,
            -1,
            '2',
            null,
            [1],
            { major: 2 },
          ]),
          extra: unicodeSoup(rand, int(rand, 0, 4)),
        }),
        seen: true,
      };
    case 'proto-pollution':
      return {
        kind,
        value: pick(rand, [
          '{"__proto__":{"visible":true}}',
          '{"constructor":{"prototype":{"queued":true}}}',
          '{"version":1,"__proto__":{"polluted":1}}',
          '{"prototype":{"visible":true}}',
        ]),
        seen: true,
      };
    case 'numeric-edge':
      return {
        kind,
        value: pick(rand, [
          '0',
          '-0',
          '1',
          'NaN',
          'Infinity',
          '-Infinity',
          '1e309',
          '9007199254740993',
          '0x10',
          '0b1',
          ' 0 ',
          '0.0',
        ]),
        seen: true,
      };
    case 'nul-bytes':
      return {
        kind,
        value: pick(rand, [
          '\u0000',
          '\u0000\u0000',
          'a\u0000b',
          `${WALKTHROUGH_SEEN_VALUE}\u0000`,
          `\u0000${WALKTHROUGH_SEEN_VALUE}`,
        ]),
        seen: true,
      };
    case 'huge':
      return { kind, value: hugeString(rand), seen: true };
    case 'unicode':
      return { kind, value: unicodeSoup(rand, int(rand, 1, 40)), seen: true };
    case 'path-traversal':
      return {
        kind,
        value: pick(rand, [
          '../../etc/passwd',
          '..\\..\\windows\\system32',
          '%2e%2e/%2e%2e/',
          '/dev/null',
          'file:///var/mobile/Containers',
          '..%00/',
        ]),
        seen: true,
      };
    default:
      return {
        kind,
        value: pick(rand, [' ', '\t', '\n', '  \n  ']),
        seen: true,
      };
  }
}

/** Value slots the contract (`getKv` → null for a falsy value) reads as
 * "no record": the repo-wide `''` clear sentinel plus wrong-typed falsy
 * cells that SQLite's `value TEXT NOT NULL` column cannot produce but a
 * misbehaving driver could. */
function absentValue(rand: () => number): ValuePayload {
  return {
    kind: pick(rand, ['clear-sentinel', 'wrong-type-falsy']),
    value: pick(rand, ['', '', '', 0, -0, NaN, false, null, undefined, 0n]),
    seen: false,
  };
}

/** Wrong-typed TRUTHY cells: `String(value)` is non-empty → record present. */
function wrongTypeTruthy(rand: () => number): ValuePayload {
  return {
    kind: 'wrong-type-truthy',
    value: pick(rand, [
      1,
      -1,
      Infinity,
      2 ** 53,
      true,
      1n,
      Symbol('kv'),
      {},
      { version: 1 },
      [],
      [1],
      new Date(0),
      () => 'fn',
      Object.create(null),
    ]),
    seen: true,
  };
}

interface ReadScript {
  kind: string;
  /** What the model expects the store to conclude from this read. */
  expect: 'seen' | 'absent' | 'error';
  payloadKind: string;
  payloadPreview: string;
  read: () => unknown;
}

function preview(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 80
      ? `${JSON.stringify(value.slice(0, 40))}…(len ${value.length})`
      : JSON.stringify(value);
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return 'function';
  if (value instanceof Date) return 'Date';
  try {
    return String(JSON.stringify(value));
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function readScript(rand: () => number): ReadScript {
  const shape = pick(rand, [
    'row-string-seen',
    'row-string-seen',
    'row-string-seen',
    'row-absent-value',
    'row-wrong-type-truthy',
    'empty-rows',
    'row-no-value-column',
    'row-null',
    'row-primitive',
    'rows-not-array',
    'multi-rows',
    'row-throwing-getter',
    'rows-proxy-throws',
    'result-malformed',
    'read-rejects',
    'read-throws-sync',
    'getdb-throws',
  ]);
  switch (shape) {
    case 'row-string-seen': {
      const p = seenString(rand);
      return {
        kind: shape,
        expect: 'seen',
        payloadKind: p.kind,
        payloadPreview: preview(p.value),
        read: () => Promise.resolve({ rows: [{ value: p.value }] }),
      };
    }
    case 'row-absent-value': {
      const p = absentValue(rand);
      return {
        kind: shape,
        expect: 'absent',
        payloadKind: p.kind,
        payloadPreview: preview(p.value),
        read: () => Promise.resolve({ rows: [{ value: p.value }] }),
      };
    }
    case 'row-wrong-type-truthy': {
      const p = wrongTypeTruthy(rand);
      return {
        kind: shape,
        expect: 'seen',
        payloadKind: p.kind,
        payloadPreview: preview(p.value),
        read: () => Promise.resolve({ rows: [{ value: p.value }] }),
      };
    }
    case 'empty-rows':
      return {
        kind: shape,
        expect: 'absent',
        payloadKind: 'rows:[]',
        payloadPreview: '[]',
        read: () => Promise.resolve({ rows: [] }),
      };
    case 'row-no-value-column':
      return {
        kind: shape,
        expect: 'absent',
        payloadKind: 'rows:[{}]',
        payloadPreview: pick(rand, ['{}', '{"key":"x"}', '{"VALUE":"x"}']),
        read: () =>
          Promise.resolve({
            rows: [
              pick(rand, [{}, { key: WALKTHROUGH_KV_KEY }, { VALUE: 'x' }]),
            ],
          }),
      };
    case 'row-null':
      return {
        kind: shape,
        expect: 'absent',
        payloadKind: 'rows:[null|undefined]',
        payloadPreview: 'null',
        read: () => Promise.resolve({ rows: [pick(rand, [null, undefined])] }),
      };
    case 'row-primitive': {
      const prim = pick(rand, ['seen', 42, true, 0n]);
      return {
        kind: shape,
        expect: 'absent',
        payloadKind: 'rows:[primitive]',
        payloadPreview: preview(prim),
        read: () => Promise.resolve({ rows: [prim] }),
      };
    }
    case 'rows-not-array': {
      const rows = pick(rand, [{}, 'rows', 7, true, { 0: { value: 'x' } }]);
      // `rows[0]` on `{0:{value:'x'}}` yields the row → seen; every other
      // non-array has no index 0 → absent.
      const seen = typeof rows === 'object' && rows !== null && 0 in rows;
      return {
        kind: shape,
        expect: seen ? 'seen' : 'absent',
        payloadKind: 'rows:non-array',
        payloadPreview: preview(rows),
        read: () => Promise.resolve({ rows }),
      };
    }
    case 'multi-rows': {
      const first = pick(rand, [WALKTHROUGH_SEEN_VALUE, 'x', '']);
      return {
        kind: shape,
        expect: first === '' ? 'absent' : 'seen',
        payloadKind: 'rows:[a,b,c]',
        payloadPreview: preview(first),
        read: () =>
          Promise.resolve({
            rows: [{ value: first }, { value: 'second' }, { value: '' }],
          }),
      };
    }
    case 'row-throwing-getter':
      return {
        kind: shape,
        expect: 'error',
        payloadKind: 'getter-throws',
        payloadPreview: 'get value() { throw }',
        read: () =>
          Promise.resolve({
            rows: [
              {
                get value(): unknown {
                  throw new Error('column getter exploded');
                },
              },
            ],
          }),
      };
    case 'rows-proxy-throws':
      return {
        kind: shape,
        expect: 'error',
        payloadKind: 'proxy-throws',
        payloadPreview: 'Proxy get→throw',
        read: () =>
          Promise.resolve({
            rows: new Proxy([], {
              get() {
                throw new Error('proxy exploded');
              },
            }),
          }),
      };
    case 'result-malformed': {
      const result = pick(rand, [undefined, null, 42, 'rows', { rows: null }]);
      // `{rows:null}` → `rows[0]` TypeError → error; scalar results also
      // fail to destructure; `'rows'`.rows is undefined → TypeError.
      return {
        kind: shape,
        expect: 'error',
        payloadKind: 'execute-result',
        payloadPreview: preview(result),
        read: () => Promise.resolve(result),
      };
    }
    case 'read-rejects':
      return {
        kind: shape,
        expect: 'error',
        payloadKind: 'reject',
        payloadPreview: 'Promise.reject',
        read: () => Promise.reject(new Error('kv read failed')),
      };
    case 'read-throws-sync':
      return {
        kind: shape,
        expect: 'error',
        payloadKind: 'throw',
        payloadPreview: 'throw',
        read: () => {
          throw new Error('kv read threw synchronously');
        },
      };
    default:
      return {
        kind: 'getdb-throws',
        expect: 'error',
        payloadKind: 'getDb',
        payloadPreview: 'getDb throws',
        read: () => Promise.resolve({ rows: [] }),
      };
  }
}

interface WriteScript {
  kind: string;
  ok: boolean;
  write: (params: unknown[]) => unknown;
}

function writeScript(rand: () => number): WriteScript {
  const kind = pick(rand, [
    'ok',
    'ok',
    'ok',
    'ok-garbage-result',
    'rejects',
    'throws-sync',
  ]);
  switch (kind) {
    case 'ok':
      return { kind, ok: true, write: () => Promise.resolve({ rows: [] }) };
    case 'ok-garbage-result':
      return {
        kind,
        ok: true,
        write: () => Promise.resolve(pick(rand, [undefined, null, 0, 'ok'])),
      };
    case 'rejects':
      return {
        kind,
        ok: false,
        write: () => Promise.reject(new Error('kv write failed')),
      };
    default:
      return {
        kind,
        ok: false,
        write: () => {
          throw new Error('kv write threw synchronously');
        },
      };
  }
}

/** Non-boolean `isShowing` results; the contract reads them by truthiness. */
const SHOWING_VALUES: readonly unknown[] = [
  true,
  false,
  'yes',
  '',
  0,
  1,
  -0,
  NaN,
  null,
  undefined,
  {},
  [],
  0n,
  1n,
];

interface FakeTarget {
  showing: unknown;
  listeners: Set<() => void>;
  target: WalkthroughYieldTarget;
  unregister: () => void;
}

function makeTarget(showing: unknown): FakeTarget {
  const listeners = new Set<() => void>();
  const fake: FakeTarget = {
    showing,
    listeners,
    target: {
      isShowing: () => fake.showing as boolean,
      subscribe: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    unregister: () => {},
  };
  fake.unregister = walkthroughYieldsTo(fake.target);
  return fake;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

interface Model {
  visible: boolean;
  queued: boolean;
  /** Contract-level record state: absent until a successful write. */
  record: 'absent' | 'present';
  successfulWrites: number;
}

type Op =
  | { op: 'land'; concurrency: number }
  | { op: 'replay' }
  | { op: 'dismiss' }
  | { op: 'ceremony'; target: number; showing: unknown };

function anyShowing(targets: FakeTarget[]): boolean {
  return targets.some(t => Boolean(t.showing));
}

function modelRaise(model: Model, targets: FakeTarget[]) {
  if (anyShowing(targets)) model.queued = true;
  else {
    model.queued = false;
    model.visible = true;
  }
}

function modelLand(
  model: Model,
  targets: FakeTarget[],
  read: ReadScript,
  write: WriteScript,
) {
  if (model.visible || model.queued) return;
  if (model.record === 'present') return;
  if (read.expect === 'error') return;
  if (read.expect === 'seen') return;
  if (!write.ok) return;
  model.record = 'present';
  model.successfulWrites += 1;
  modelRaise(model, targets);
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: queue did not settle within 2s`)),
      2000,
    );
    promise.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface Row {
  seed: number;
  index: number;
  read: string;
  payloadKind: string;
  payload: string;
  write: string;
  targets: string[];
  ops: string[];
  outcome: 'HELD' | 'BROKEN';
  detail?: string;
  writes: number;
  finalVisible: boolean;
  finalQueued: boolean;
}

async function runIteration(index: number): Promise<Row> {
  const seed = iterationSeed(index);
  const rand = xorshift32(seed);
  const read = readScript(rand);
  const write = writeScript(rand);

  mockKv.read = read.read;
  mockKv.write = write.write;
  mockKv.writeSucceeds = write.ok;
  mockKv.stored = undefined;
  mockKv.writes = [];
  mockKv.getDbThrows = read.kind === 'getdb-throws';
  useWalkthroughStore.setState({ visible: false, queued: false });

  const targetCount = int(rand, 0, 3);
  const targets: FakeTarget[] = [];
  for (let i = 0; i < targetCount; i += 1) {
    targets.push(makeTarget(pick(rand, SHOWING_VALUES)));
  }

  const opCount = int(rand, 1, 7);
  const ops: Op[] = [{ op: 'land', concurrency: int(rand, 1, 6) }];
  for (let i = 1; i < opCount; i += 1) {
    const choice = rand();
    if (choice < 0.45) ops.push({ op: 'land', concurrency: int(rand, 1, 6) });
    else if (choice < 0.6) ops.push({ op: 'replay' });
    else if (choice < 0.75) ops.push({ op: 'dismiss' });
    else if (targets.length > 0) {
      ops.push({
        op: 'ceremony',
        target: int(rand, 0, targets.length - 1),
        showing: pick(rand, SHOWING_VALUES),
      });
    } else ops.push({ op: 'land', concurrency: 1 });
  }

  const model: Model = {
    visible: false,
    queued: false,
    record: 'absent',
    successfulWrites: 0,
  };
  const row: Row = {
    seed,
    index,
    read: read.kind,
    payloadKind: read.payloadKind,
    payload: read.payloadPreview,
    write: write.kind,
    targets: targets.map(t => preview(t.showing)),
    ops: ops.map(o =>
      o.op === 'land'
        ? `land×${o.concurrency}`
        : o.op === 'ceremony'
          ? `ceremony[${o.target}]=${preview(o.showing)}`
          : o.op,
    ),
    outcome: 'HELD',
    writes: 0,
    finalVisible: false,
    finalQueued: false,
  };

  const fail = (detail: string) => {
    row.outcome = 'BROKEN';
    row.detail = row.detail ? `${row.detail}; ${detail}` : detail;
  };

  try {
    for (const op of ops) {
      const store = useWalkthroughStore.getState();
      if (op.op === 'land') {
        const calls: Promise<void>[] = [];
        for (let c = 0; c < op.concurrency; c += 1) {
          calls.push(store.maybeShowFirstRun());
        }
        await withTimeout(Promise.all(calls), `land×${op.concurrency}`);
        for (let c = 0; c < op.concurrency; c += 1) {
          modelLand(model, targets, read, write);
        }
      } else if (op.op === 'replay') {
        store.replay();
        modelRaise(model, targets);
      } else if (op.op === 'dismiss') {
        store.dismiss();
        model.visible = false;
        model.queued = false;
      } else {
        const t = targets[op.target]!;
        t.showing = op.showing;
        for (const listener of Array.from(t.listeners)) listener();
        if (model.queued && !anyShowing(targets)) {
          model.queued = false;
          model.visible = true;
        }
      }
      const after = useWalkthroughStore.getState();
      if (after.visible !== model.visible || after.queued !== model.queued) {
        fail(
          `I5 after ${JSON.stringify(op)}: store visible=${after.visible} queued=${after.queued}, model visible=${model.visible} queued=${model.queued}`,
        );
        break;
      }
    }
  } catch (error) {
    fail(
      `I1/I6 threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // I2: every write attempt carries exactly the canonical key/value.
  for (const params of mockKv.writes) {
    if (
      !Array.isArray(params) ||
      params.length !== 2 ||
      params[0] !== WALKTHROUGH_KV_KEY ||
      params[1] !== WALKTHROUGH_SEEN_VALUE
    ) {
      fail(`I2 non-canonical write params: ${preview(params)}`);
    }
  }
  // I3: successful writes ≤ 1 (attempts may exceed it only when the write
  // path fails, which never raises the overlay).
  const successful = write.ok ? mockKv.writes.length : 0;
  if (successful > 1) fail(`I3 ${successful} successful writes`);
  if (successful !== model.successfulWrites) {
    fail(
      `I3 successful writes ${successful} ≠ model ${model.successfulWrites}`,
    );
  }
  // I4: an erroring read or failing write never raises (unless replay did).
  if (
    (read.expect === 'error' || !write.ok) &&
    !ops.some(o => o.op === 'replay') &&
    (useWalkthroughStore.getState().visible ||
      useWalkthroughStore.getState().queued)
  ) {
    fail('I4 raised despite unreadable/unwritable record');
  }

  // I6: the queue still serves the next caller after this iteration.
  mockKv.stored = undefined;
  mockKv.read = () => Promise.reject(new Error('probe'));
  try {
    await withTimeout(
      useWalkthroughStore.getState().maybeShowFirstRun(),
      'I6 probe',
    );
  } catch (error) {
    fail(`I6 ${error instanceof Error ? error.message : String(error)}`);
  }

  row.writes = mockKv.writes.length;
  row.finalVisible = useWalkthroughStore.getState().visible;
  row.finalQueued = useWalkthroughStore.getState().queued;
  for (const t of targets) t.unregister();
  useWalkthroughStore.setState({ visible: false, queued: false });
  return row;
}

describe('walkthroughStore · boundary-malformed stress (seeded, model-based)', () => {
  afterEach(() => {
    useWalkthroughStore.setState({ visible: false, queued: false });
  });

  it(`campaign: STRESS_ITER=${STRESS_ITER} seeded hostile-KV iterations hold I1–I6`, async () => {
    const rows: Row[] = [];
    const byRead: Record<string, number> = {};
    const byPayload: Record<string, number> = {};
    let landings = 0;
    for (let index = 0; index < STRESS_ITER; index += 1) {
      const row = await runIteration(index);
      rows.push(row);
      byRead[row.read] = (byRead[row.read] ?? 0) + 1;
      byPayload[row.payloadKind] = (byPayload[row.payloadKind] ?? 0) + 1;
      for (const op of row.ops) {
        const m = /^land×(\d+)$/.exec(op);
        landings += m ? Number(m[1]) : 1;
      }
    }
    const broken = rows.filter(r => r.outcome === 'BROKEN');
    writeArtifact('walkthrough-store-boundary-malformed.json', {
      seed: STRESS_SEED,
      iterations: STRESS_ITER,
      operations: landings,
      held: rows.length - broken.length,
      broken: broken.length,
      byRead,
      byPayload,
      replay:
        'STRESS_SEED=<seed> STRESS_ITER=<index+1> npx jest __tests__/stress/walkthroughStore.boundaryMalformed.stress.test.ts',
      brokenRows: broken,
      rows,
    });
    expect(
      broken.slice(0, 20).map(r => ({
        seed: r.seed,
        index: r.index,
        read: r.read,
        payload: r.payload,
        write: r.write,
        ops: r.ops,
        detail: r.detail,
      })),
    ).toEqual([]);
    expect(rows.length).toBe(STRESS_ITER);
  });

  it('replays a single iteration deterministically (same seed ⇒ same row)', async () => {
    const a = await runIteration(7);
    const b = await runIteration(7);
    expect(a).toEqual(b);
    expect(a.outcome).toBe('HELD');
  });

  it('never echoes a malformed payload back into the KV table (64 KiB NUL string, proto keys)', async () => {
    for (const hostile of [
      '\u0000'.repeat(65_537),
      '{"__proto__":{"visible":true}}',
      '{"version":1e309}',
    ]) {
      mockKv.writes = [];
      mockKv.stored = undefined;
      mockKv.getDbThrows = false;
      mockKv.writeSucceeds = true;
      mockKv.write = () => Promise.resolve({ rows: [] });
      // First read: the hostile value is PRESENT → seen, no write.
      mockKv.read = () => Promise.resolve({ rows: [{ value: hostile }] });
      useWalkthroughStore.setState({ visible: false, queued: false });
      await useWalkthroughStore.getState().maybeShowFirstRun();
      expect(useWalkthroughStore.getState().visible).toBe(false);
      expect(mockKv.writes).toEqual([]);
      // Prototype pollution never leaked into the store state.
      expect(Object.prototype.hasOwnProperty.call({}, 'visible')).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'),
      ).toBe(false);
    }
  });

  describe('throwing yield targets (documented class, not fuzzed)', () => {
    // A registrant whose `isShowing` throws is a contract violation by the
    // registrant; the block records the store's actual behaviour so a change
    // in either direction is visible. The single production registrant
    // (src/progress/rankCelebration.ts) reads zustand state and cannot throw.
    it('`replay()` propagates the registrant error synchronously', () => {
      const unregister = walkthroughYieldsTo({
        isShowing: () => {
          throw new Error('registrant exploded');
        },
        subscribe: () => () => {},
      });
      try {
        expect(() => useWalkthroughStore.getState().replay()).toThrow(
          'registrant exploded',
        );
        expect(useWalkthroughStore.getState().visible).toBe(false);
      } finally {
        unregister();
      }
    });

    it('`maybeShowFirstRun()` rejects AFTER the seen record was written (tour lost for that device, recoverable via Settings replay)', async () => {
      mockKv.writes = [];
      mockKv.stored = undefined;
      mockKv.getDbThrows = false;
      mockKv.writeSucceeds = true;
      mockKv.read = () => Promise.resolve({ rows: [] });
      mockKv.write = () => Promise.resolve({ rows: [] });
      const unregister = walkthroughYieldsTo({
        isShowing: () => {
          throw new Error('registrant exploded');
        },
        subscribe: () => () => {},
      });
      try {
        await expect(
          useWalkthroughStore.getState().maybeShowFirstRun(),
        ).rejects.toThrow('registrant exploded');
        expect(mockKv.writes).toEqual([
          [WALKTHROUGH_KV_KEY, WALKTHROUGH_SEEN_VALUE],
        ]);
        expect(useWalkthroughStore.getState().visible).toBe(false);
        expect(useWalkthroughStore.getState().queued).toBe(false);
        // The serialisation queue recovers: the next landing still runs and
        // the record written before the throw is now read back as seen.
        await useWalkthroughStore.getState().maybeShowFirstRun();
        expect(mockKv.writes).toHaveLength(1);
      } finally {
        unregister();
      }
    });

    it('a registrant whose `subscribe` throws stays registered (leaks into every later raise)', () => {
      const target: WalkthroughYieldTarget = {
        isShowing: () => true,
        subscribe: () => {
          throw new Error('subscribe exploded');
        },
      };
      expect(() => walkthroughYieldsTo(target)).toThrow('subscribe exploded');
      // No unsubscribe handle was returned, and the target is still consulted.
      useWalkthroughStore.getState().replay();
      const leaked = useWalkthroughStore.getState().queued === true;
      useWalkthroughStore.setState({ visible: false, queued: false });
      expect(leaked).toBe(true);
      // Recover for the rest of the suite: registering a benign target and
      // unregistering it does not remove the leaked one, so make it inert.
      target.isShowing = () => false;
    });
  });
});
