// Shared plumbing for the stress_*.test.ts campaigns (lens: boundary /
// malformed input against cache.ts + rateLimit.ts and the real handler).
//
//   Rng           — splitmix32; every campaign iteration is derived from ONE
//                   32-bit iteration seed, so `STRESS_REPLAY=<seed>` rebuilds
//                   the exact same case without the rest of the campaign.
//   generators    — malformed / boundary strings, numbers, JSON payloads and
//                   raw Upstash pipeline replies (built as raw JSON TEXT so
//                   `__proto__` keys, `1e400`, `-0` … survive serialisation).
//   campaignSize  — STRESS_ITER (default small enough for the normal suite;
//                   the reported 3000+ campaign sets it explicitly).
//   writeTable    — seed → outcome JSON table under STRESS_OUT_DIR when set.
//
// Nothing here touches a network or production code.

export interface CampaignConfig {
  /** Campaign seed (STRESS_SEED). */
  seed: number;
  /** Iterations to run (STRESS_ITER). */
  iterations: number;
  /** When set, only these iteration seeds run (STRESS_REPLAY=seed,seed…). */
  replay: number[] | null;
  /** When set, the seed → outcome table is written here (STRESS_OUT_DIR). */
  outDir: string | null;
}

export function campaignConfig(defaultIterations: number): CampaignConfig {
  const seedRaw = Deno.env.get("STRESS_SEED");
  const iterRaw = Deno.env.get("STRESS_ITER");
  const replayRaw = Deno.env.get("STRESS_REPLAY");
  const seed = seedRaw && /^\d+$/.test(seedRaw)
    ? Number(seedRaw) >>> 0
    : 0x20260905;
  const iterations = iterRaw && /^\d+$/.test(iterRaw)
    ? Math.max(1, Number(iterRaw))
    : defaultIterations;
  const replay = replayRaw
    ? replayRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map((s) => Number(s) >>> 0)
    : null;
  return {
    seed,
    iterations,
    replay,
    outDir: Deno.env.get("STRESS_OUT_DIR") ?? null,
  };
}

/** Deterministic 32-bit PRNG (splitmix32). */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = (z ^ (z >>> 15)) >>> 0;
    return z;
  }
  /** Float in [0, 1). */
  float(): number {
    return this.next() / 4294967296;
  }
  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }
  bool(p = 0.5): boolean {
    return this.float() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
}

/** Iteration seed i of a campaign — stable, independent of iteration order. */
export function iterationSeed(campaignSeed: number, i: number): number {
  let z = (campaignSeed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

export function iterationSeeds(config: CampaignConfig): number[] {
  if (config.replay) return config.replay;
  const seeds: number[] = [];
  for (let i = 0; i < config.iterations; i += 1) {
    seeds.push(iterationSeed(config.seed, i));
  }
  return seeds;
}

// ─── Strings ─────────────────────────────────────────────────────────────────

export const STRING_CATEGORIES = [
  "empty",
  "ascii",
  "realistic-key",
  "nul",
  "control",
  "unicode-nfc",
  "unicode-nfd",
  "grapheme",
  "lone-surrogate",
  "bidi",
  "traversal",
  "proto",
  "jsonish",
  "long-64k-bytes",
  "long-64k-codepoints",
  "long-64k-multibyte",
  "long-1m",
  "whitespace",
  "numericish",
  "redis-syntax",
  "template",
  "homoglyph",
  "future-version",
] as const;
export type StringCategory = (typeof STRING_CATEGORIES)[number];

const ASCII = "abcdefghijklmnopqrstuvwxyz0123456789:-_./";
const ZALGO =
  "\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u0309\u030a";

export function genAscii(rng: Rng, lo: number, hi: number): string {
  const n = rng.int(lo, hi);
  let out = "";
  for (let i = 0; i < n; i += 1) out += ASCII[rng.int(0, ASCII.length - 1)];
  return out;
}

export function genHex(rng: Rng, n: number): string {
  let out = "";
  for (let i = 0; i < n; i += 1) out += rng.int(0, 15).toString(16);
  return out;
}

/** NFC / NFD pairs — same visible text, different code points. */
const NORMALIZATION_BASES = [
  "café",
  "naïve",
  "Ångström",
  "한글",
  "ẛ̣",
  "ﬁ",
  "Ⅸ",
];

export function genString(rng: Rng, category: StringCategory): string {
  switch (category) {
    case "empty":
      return "";
    case "ascii":
      return genAscii(rng, 1, 48);
    case "realistic-key":
      return rng.pick([
        "auth:",
        "auth:revoked:",
        "rank:",
        "progress:",
        "rl:ip:1234:",
        "gen:",
      ]) +
        genHex(rng, rng.pick([8, 36, 64]));
    case "nul": {
      const body = genAscii(rng, 0, 12);
      return rng.pick([
        `\u0000${body}`,
        `${body}\u0000`,
        `${body}\u0000${body}`,
        "\u0000",
      ]);
    }
    case "control":
      return rng.pick([
        "a\r\nb",
        "a\nSET x y\n",
        "\t\t",
        "\u001b[31mred\u001b[0m",
        "\u007f",
        "line\u2028sep\u2029",
        "\u0001\u0002\u0003",
        "bell\u0007",
      ]);
    case "unicode-nfc":
      return rng.pick(NORMALIZATION_BASES).normalize("NFC");
    case "unicode-nfd":
      return rng.pick(NORMALIZATION_BASES).normalize("NFD");
    case "grapheme":
      return rng.pick([
        "👨‍👩‍👧‍👦",
        "🇺🇸🇯🇵",
        "🏳️‍🌈",
        "👍🏽",
        `e${ZALGO.repeat(rng.int(1, 8))}`,
        "ก้้้้้้้้้้้้้้้้้้้้",
        "\u200d\u200d\u200d",
        "\ufe0f",
      ]);
    case "lone-surrogate":
      return rng.pick([
        "\ud800",
        "\udfff",
        "a\ud83d",
        "\ude00b",
        "\ud800\ud800",
      ]);
    case "bidi":
      return rng.pick(["\u202eabc", "abc\u202d", "\u2066x\u2069", "\u061cy"]);
    case "traversal":
      return rng.pick([
        "../../etc/passwd",
        "..\\..\\windows\\system32",
        "%2e%2e%2f%2e%2e%2f",
        "auth:../revoked:x",
        "/",
        "//",
        "..;/",
        "%00",
        "auth:revoked:%00",
        "....//....//",
        "file:///etc/hosts",
        "auth:revoked:*",
      ]);
    case "proto":
      return rng.pick([
        "__proto__",
        "constructor",
        "prototype",
        "hasOwnProperty",
        "toString",
        "valueOf",
        "__defineGetter__",
        "constructor.prototype.polluted",
      ]);
    case "jsonish":
      return rng.pick([
        '{"a":1}',
        "[",
        "{",
        '{"__proto__":{"polluted":1}}',
        "null",
        "NaN",
        '"',
        "[[[[[[[[[[",
        '{"userId":"x","provider":"google","expiresAtMs":9e999}',
      ]);
    case "long-64k-bytes":
      return "k".repeat(rng.pick([65535, 65536, 65537]));
    case "long-64k-codepoints":
      // 4-byte code points: 65536 code points = 262144 bytes.
      return "😀".repeat(rng.pick([16384, 65536]));
    case "long-64k-multibyte":
      // 2-byte code points: 65536 bytes = 32768 code points.
      return "é".repeat(32768);
    case "long-1m":
      return "m".repeat(1 << 20);
    case "whitespace":
      return rng.pick([" ", "   ", "\u00a0", "\ufeff", "\u3000", " a "]);
    case "numericish":
      return rng.pick([
        "0",
        "-0",
        "1e400",
        "NaN",
        "Infinity",
        "-Infinity",
        "0x10",
        "1_000",
        "1e-400",
      ]);
    case "redis-syntax":
      return rng.pick([
        "*",
        "KEYS *",
        "FLUSHALL",
        "a b c",
        "key\r\nSET x y",
        "$-1",
        '"quoted"',
      ]);
    case "template":
      return rng.pick([
        "${x}",
        "%s%s%n",
        "{{7*7}}",
        "#{1+1}",
        "<script>",
        "'; DROP TABLE x;--",
      ]);
    case "homoglyph":
      return rng.pick(["аuth:x", "rаnk:u1", "ⓐuth", "ａuth:x"]);
    case "future-version":
      return rng.pick([
        "v2",
        "schema:99",
        "auth:v9999:x",
        "cache/v3/rank",
        "rank:u1:v2",
      ]);
  }
}

export interface GenString {
  category: StringCategory;
  value: string;
}

/** Long strings are rare so a campaign stays fast; the 1 MiB one rarest. */
export function genWeightedString(rng: Rng): GenString {
  const r = rng.float();
  let category: StringCategory;
  if (r < 0.01) category = "long-1m";
  else if (r < 0.06) {
    category = rng.pick([
      "long-64k-bytes",
      "long-64k-codepoints",
      "long-64k-multibyte",
    ]);
  } else {
    const short = STRING_CATEGORIES.filter((c) => !c.startsWith("long-"));
    category = rng.pick(short);
  }
  return { category, value: genString(rng, category) };
}

// ─── Numbers ─────────────────────────────────────────────────────────────────

export const BOUNDARY_NUMBERS: readonly number[] = [
  0,
  -0,
  -1,
  -1e9,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  1e-9,
  Number.MIN_VALUE,
  Number.EPSILON,
  0.4,
  0.5,
  0.999,
  1,
  59,
  60,
  61,
  599,
  600,
  601,
  660,
  900,
  2 ** 31 - 1,
  2 ** 31,
  2 ** 32,
  2 ** 53 - 1,
  2 ** 53,
  1e15,
  9.3e15,
  1e16,
  1e21,
  1e300,
  1e308,
  Number.MAX_VALUE,
];

export function genNumber(rng: Rng): number {
  const r = rng.float();
  if (r < 0.7) return rng.pick(BOUNDARY_NUMBERS);
  if (r < 0.85) return rng.int(1, 100_000);
  return rng.float() * 1e6 - 5e5;
}

export function describeNumber(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (Object.is(n, -0)) return "-0";
  return String(n);
}

// ─── Raw JSON values (text) for hostile Upstash replies ──────────────────────

/** JSON TEXT snippets — several are unreachable through JSON.stringify. */
export function genRawJsonValue(rng: Rng): string {
  const pool = [
    "null",
    "true",
    "false",
    "0",
    "-0",
    "-1",
    "-2",
    "1",
    "60",
    "1e400",
    "-1e400",
    "9007199254740993",
    "1e21",
    "1e-400",
    '"NaN"',
    '"Infinity"',
    '"-Infinity"',
    '"1e400"',
    '"0x3c"',
    '" 7 "',
    '""',
    '"[]"',
    '"{}"',
    '"-2"',
    '"OK"',
    '"ok"',
    '"O\\u0000K"',
    "[]",
    "{}",
    "[7]",
    '["OK"]',
    '{"result":"OK"}',
    '{"__proto__":{"polluted":"via-reply"}}',
    '{"constructor":{"prototype":{"polluted":"via-reply"}}}',
    "[[[[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]]]",
    JSON.stringify("v".repeat(70_000)),
    JSON.stringify(
      '{"userId":"poison","provider":"google","expiresAtMs":9e999}',
    ),
  ];
  return rng.pick(pool);
}

/** A whole reply SLOT as JSON text. */
export function genRawSlot(rng: Rng): string {
  const r = rng.float();
  if (r < 0.35) return `{"result":${genRawJsonValue(rng)}}`;
  if (r < 0.5) {
    return `{"error":${
      rng.pick(['"ERR wrongtype"', "7", "null", "{}", '""'])
    }}`;
  }
  if (r < 0.58) return `{"error":"ERR both","result":"OK"}`;
  if (r < 0.66) {
    return `{"__proto__":{"polluted":"via-slot"},"result":${
      genRawJsonValue(rng)
    }}`;
  }
  if (r < 0.72) {
    return `{"constructor":{"prototype":{"polluted":"via-slot"}},"result":"OK"}`;
  }
  if (r < 0.8) return "{}";
  if (r < 0.86) return "null";
  if (r < 0.92) return "7";
  if (r < 0.96) return '"OK"';
  return "[]";
}

export const REPLY_MODES = [
  "faithful",
  "http-4xx",
  "http-5xx",
  "body-nonjson",
  "body-truncated",
  "body-empty",
  "body-object",
  "body-scalar",
  "body-future-schema",
  "slots-wrong-types",
  "slots-proto",
  "slots-short",
  "slots-long",
  "slots-errors",
  "slots-nonobject",
  "ttl-weird",
  "value-huge",
  "value-nonstring",
] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];

export function genReplyMode(rng: Rng): ReplyMode {
  // Faithful replies are a third of the campaign so write/read invariants
  // (TTL, eviction, revocation) are checked against a truthful L2 too.
  if (rng.float() < 0.33) return "faithful";
  return rng.pick(REPLY_MODES.filter((m) => m !== "faithful"));
}

// ─── Prototype pollution probe ──────────────────────────────────────────────

const PROBE_KEYS = [
  "polluted",
  "result",
  "error",
  "value",
  "revoked",
  "allowed",
];

/** Throws when a hostile reply / key reached Object.prototype or Array.prototype. */
export function assertPrototypesClean(): void {
  const plain: Record<string, unknown> = {};
  const arr: unknown[] = [];
  for (const key of PROBE_KEYS) {
    if (key in plain) {
      throw new Error(`Object.prototype polluted: "${key}" in {}`);
    }
    if (key in arr) throw new Error(`Array.prototype polluted: "${key}" in []`);
  }
  if (Object.getPrototypeOf(plain) !== Object.prototype) {
    throw new Error("plain object prototype replaced");
  }
}

// ─── Outcome table ──────────────────────────────────────────────────────────

export type Outcome = "HELD" | "BROKEN" | `DEFECT:${string}`;

export interface OutcomeRow {
  i: number;
  seed: number;
  outcome: Outcome;
  op: string;
  detail: Record<string, unknown>;
  /** Present for BROKEN / DEFECT rows. */
  violation?: string;
}

export interface OutcomeTable {
  campaign: string;
  commit: string | null;
  campaignSeed: number;
  iterations: number;
  replayCommand: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: {
    held: number;
    broken: number;
    defects: Record<string, number>;
    byOp: Record<string, number>;
    byViolation: Record<string, number>;
  };
  /** Campaign-specific measurements (heap, counters …). */
  extra: Record<string, unknown>;
  rows: OutcomeRow[];
}

function count(
  rows: OutcomeRow[],
  pick: (row: OutcomeRow) => string | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = pick(row);
    if (key === null) continue;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export async function buildTable(
  campaign: string,
  config: CampaignConfig,
  rows: OutcomeRow[],
  startedAt: Date,
  testFile: string,
  extra: Record<string, unknown> = {},
): Promise<OutcomeTable> {
  const finished = new Date();
  let commit: string | null = null;
  try {
    const proc = new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      stdout: "piped",
      stderr: "null",
    });
    const out = await proc.output();
    commit = out.success ? new TextDecoder().decode(out.stdout).trim() : null;
  } catch {
    commit = null;
  }
  return {
    campaign,
    commit,
    campaignSeed: config.seed,
    iterations: rows.length,
    replayCommand:
      `cd supabase/functions/api/__wf__ && STRESS_REPLAY=<seed> deno test -A --no-check --config deno.json ${testFile}`,
    startedAt: startedAt.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - startedAt.getTime(),
    summary: {
      held: rows.filter((r) => r.outcome === "HELD").length,
      broken: rows.filter((r) => r.outcome === "BROKEN").length,
      defects: count(
        rows,
        (r) => (r.outcome.startsWith("DEFECT:") ? r.outcome : null),
      ),
      byOp: count(rows, (r) => r.op),
      byViolation: count(rows, (r) => r.violation ?? null),
    },
    extra,
    rows,
  };
}

/** Write the table when STRESS_OUT_DIR is set; returns the path or null. */
export async function writeTable(
  table: OutcomeTable,
  config: CampaignConfig,
): Promise<string | null> {
  if (!config.outDir) return null;
  await Deno.mkdir(config.outDir, { recursive: true });
  const path =
    `${config.outDir}/${table.campaign}.seed-${table.campaignSeed}.json`;
  await Deno.writeTextFile(path, JSON.stringify(table, null, 1));
  return path;
}

/** Strings longer than this are abbreviated in the table (the seed rebuilds them). */
export function abbreviate(value: string, max = 64): string {
  if (value.length <= max) return JSON.stringify(value);
  return `${JSON.stringify(value.slice(0, max))}…(len=${value.length})`;
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function codePoints(value: string): number {
  return [...value].length;
}

export function graphemes(value: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let n = 0;
  for (const _ of segmenter.segment(value)) n += 1;
  return n;
}

export function heapUsedMb(): number {
  return Math.round((Deno.memoryUsage().heapUsed / 1_048_576) * 10) / 10;
}

// ─── Hostile Upstash replies ─────────────────────────────────────────────────

export interface PipelineSlot {
  result?: unknown;
  error?: string;
}

const WEIRD_TTL_RAW = [
  "-1",
  "-2",
  "0",
  "-0",
  "1e400",
  "-1e400",
  '"abc"',
  '"1e400"',
  "0.5",
  "60.000001",
  "9007199254740993",
  "null",
  "true",
  "[]",
  "{}",
  '"-2"',
  '" 30 "',
];

/** Turn a faithful Upstash pipeline reply into the hostile variant `mode`
 * describes (the fake stores are still mutated faithfully — only what the
 * client SEES changes). */
export function mutateReply(
  mode: ReplyMode,
  rng: Rng,
  commands: unknown,
  faithful: PipelineSlot[],
): { status: number; text: string } {
  const truthful = JSON.stringify(faithful);
  const slots = faithful.map((slot) => JSON.stringify(slot));
  const cmdName = (index: number): string =>
    Array.isArray(commands) && Array.isArray(commands[index])
      ? String(commands[index][0]).toUpperCase()
      : "";
  switch (mode) {
    case "faithful":
      return { status: 200, text: truthful };
    case "http-4xx":
      return {
        status: rng.pick([400, 401, 403, 404, 429]),
        text: '{"error":"Unauthorized"}',
      };
    case "http-5xx":
      return { status: rng.pick([500, 502, 503, 504]), text: "upstream error" };
    case "body-nonjson":
      return {
        status: 200,
        text: rng.pick([
          "<html>bad gateway</html>",
          "OK",
          "undefined",
          "{results:[]}",
          "\ufeff[]",
          "[]]",
          "[1,]",
        ]),
      };
    case "body-truncated":
      return {
        status: 200,
        text: truthful.slice(0, rng.int(0, Math.max(0, truthful.length - 1))),
      };
    case "body-empty":
      return { status: 200, text: "" };
    case "body-object":
      return {
        status: 200,
        text: rng.pick([`{"results":${truthful}}`, '{"result":"OK"}', "{}"]),
      };
    case "body-scalar":
      return {
        status: 200,
        text: rng.pick(['"OK"', "0", "null", "true", "1e400"]),
      };
    case "body-future-schema":
      return {
        status: 200,
        text:
          `{"version":2,"results":${truthful},"meta":{"__proto__":{"polluted":"via-body"}}}`,
      };
    case "slots-wrong-types":
      return {
        status: 200,
        text: `[${
          slots.map((
            s,
          ) => (rng.bool(0.7) ? `{"result":${genRawJsonValue(rng)}}` : s)).join(
            ",",
          )
        }]`,
      };
    case "slots-proto":
      return {
        status: 200,
        text: `[${
          slots
            .map((s) =>
              rng.bool(0.7)
                ? rng.pick([
                  `{"__proto__":{"polluted":"via-slot"},"result":${
                    genRawJsonValue(rng)
                  }}`,
                  `{"constructor":{"prototype":{"polluted":"via-slot"}},"result":"OK"}`,
                  `{"result":{"__proto__":{"polluted":"via-result"}}}`,
                ])
                : s
            )
            .join(",")
        }]`,
      };
    case "slots-short":
      return {
        status: 200,
        text: `[${
          slots.slice(0, rng.int(0, Math.max(0, slots.length - 1))).join(",")
        }]`,
      };
    case "slots-long": {
      const extra: string[] = [];
      for (let i = rng.int(1, 3); i > 0; i -= 1) extra.push(genRawSlot(rng));
      return { status: 200, text: `[${[...slots, ...extra].join(",")}]` };
    }
    case "slots-errors":
      return {
        status: 200,
        text: `[${
          slots
            .map((s) =>
              rng.bool(0.6)
                ? rng.pick([
                  '{"error":"ERR max requests limit exceeded"}',
                  '{"error":"WRONGTYPE Operation against a key holding the wrong kind of value"}',
                  '{"error":7}',
                  '{"error":null}',
                  '{"error":"ERR both","result":"OK"}',
                  '{"error":""}',
                ])
                : s
            )
            .join(",")
        }]`,
      };
    case "slots-nonobject":
      return {
        status: 200,
        text: `[${
          slots.map((s) => (rng.bool(0.6)
            ? rng.pick(["null", "7", '"OK"', "[]", "true", "-0"])
            : s)
          ).join(",")
        }]`,
      };
    case "ttl-weird":
      return {
        status: 200,
        text: `[${
          slots.map((s, i) => (cmdName(i) === "TTL"
            ? `{"result":${rng.pick(WEIRD_TTL_RAW)}}`
            : s)
          ).join(",")
        }]`,
      };
    case "value-huge":
      return {
        status: 200,
        text: `[${
          slots
            .map((s, i) =>
              cmdName(i) === "GET"
                ? `{"result":${
                  JSON.stringify("v".repeat(rng.bool(0.9) ? 65_537 : 1 << 20))
                }}`
                : s
            )
            .join(",")
        }]`,
      };
    case "value-nonstring":
      return {
        status: 200,
        text: `[${
          slots
            .map((s, i) =>
              cmdName(i) === "GET"
                ? `{"result":${
                  rng.pick([
                    "1",
                    "true",
                    "[]",
                    "{}",
                    '{"userId":"poison"}',
                    "null",
                    "-0",
                    "1e400",
                    '["1"]',
                  ])
                }}`
                : s
            )
            .join(",")
        }]`,
      };
  }
}
