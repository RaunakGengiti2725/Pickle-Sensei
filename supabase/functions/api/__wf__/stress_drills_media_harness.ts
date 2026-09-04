// stress-edge-drills-media (lens: concurrency) — shared helpers for the two
// stress files that drive drills.ts + drillMedia.ts through the REAL edge
// handler (stress_drills_media_concurrency.test.ts) and the saved-drill table
// on a real postgres:16 with every migration applied
// (stress_drills_media_pg.test.ts).
//
// The stateful fake in xc_concurrency_harness.ts has no `user_saved_drills`
// table and resolves `on_conflict` by a SINGLE column, so the composite
// (user_id, slug) primary key the saved-drill routes upsert against is
// modelled here, statement-for-statement on what PostgREST does for
//   POST /rest/v1/user_saved_drills?on_conflict=user_id,slug
//     Prefer: resolution=ignore-duplicates    → INSERT … ON CONFLICT DO NOTHING
//   GET  …?select=…&user_id=eq.…[&slug=eq.…]  (+ Accept: vnd.pgrst.object+json → PGRST116 unless exactly 1 row)
//   DELETE …?user_id=eq.…&slug=eq.…
// with owner-only RLS (20260829140000_permits_sync_consent.sql §7) and the
// NOT VALID slug check `user_saved_drills_slug_bounds`
// (20260831160000_defense_in_depth.sql) applied to every new row.
//
// Scale knobs (all seeded, every run replayable):
//   STRESS_SEED       base seed (default 20260904)
//   STRESS_ITER       campaign multiplier — rounds per scenario (default 1;
//                     the default already executes > 500 interleavings)
//   STRESS_BURST      concurrent requests per Promise.all burst (default 24)
//   STRESS_LATENCY_MS max seeded upstream latency per fake call (default 8)
//   STRESS_OUT_DIR    where <scenario>.json reports go
//                     (default artifacts/stress-edge-drills-media/latest/)

import {
  envInt,
  type Invariant,
  Prng,
  readJson,
  sleep,
  SUPABASE_URL,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
export const STRESS_ITER = envInt("STRESS_ITER", 1);
export const STRESS_BURST = envInt("STRESS_BURST", 24);
export const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 8);
/** Hard ceiling for one Promise.all burst — a burst that does not settle in
 * this long is reported as a deadlock/hang, never waited out. */
export const STRESS_DEADLINE_MS = envInt("STRESS_DEADLINE_MS", 30_000);

/** Mirror of DRILL_SLUG_RE in ../index.ts (module-private there) and of the
 * DB check `slug ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$'`. The PG stress file
 * cross-checks this oracle against the real constraint on every fuzz slug. */
export const DRILL_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i;

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ── user_saved_drills model over the xc fake ────────────────────────────────

export interface SavedDrillRow extends Record<string, unknown> {
  user_id: string;
  slug: string;
  saved_at: string;
}

/** Deterministic interleaving hooks for targeted REPRO tests: awaited by the
 * fake right before it evaluates the given statement kind on
 * user_saved_drills (the real handler is mid-request at that moment). */
export const stressHooks: {
  beforeSelect?: (
    who: { role: string; userId: string | null },
    url: URL,
  ) => Promise<void>;
  beforeUpsert?: (
    who: { role: string; userId: string | null },
    url: URL,
  ) => Promise<void>;
} = {};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Install the composite-key `user_saved_drills` table on the loaded xc fake.
 * Idempotent; the table participates in fake.reset() like every other. */
export function installSavedDrillsTable(h: XcHarness): void {
  const fake = h.fake;
  if (!("user_saved_drills" in fake.tables)) fake.tables.user_saved_drills = [];
  const marker = fake as unknown as { __stressSavedDrills?: boolean };
  if (marker.__stressSavedDrills) return;
  marker.__stressSavedDrills = true;
  const orig = fake.handleFetch.bind(fake);
  fake.handleFetch = (request: Request, rawBody: string): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.origin === SUPABASE_URL &&
      url.pathname === "/rest/v1/user_saved_drills"
    ) {
      return savedDrillsRest(h, request, rawBody, url);
    }
    return orig(request, rawBody);
  };
}

function rows(h: XcHarness): SavedDrillRow[] {
  return h.fake.tables.user_saved_drills as SavedDrillRow[];
}

function eqFilters(params: URLSearchParams): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [col, raw] of params.entries()) {
    if (
      ["select", "order", "limit", "offset", "on_conflict", "columns"].includes(
        col,
      )
    ) continue;
    if (!raw.startsWith("eq.")) {
      throw new Error(
        `stress harness: unsupported PostgREST filter ${col}=${raw}`,
      );
    }
    out.push([col, raw.slice(3)]);
  }
  return out;
}

async function savedDrillsRest(
  h: XcHarness,
  request: Request,
  rawBody: string,
  url: URL,
): Promise<Response> {
  const fake = h.fake;
  const who = fake.principal(request.headers);
  if (fake.latencyMaxMs > 0) await sleep(fake.prng.int(0, fake.latencyMaxMs));
  fake.count(`rest.${request.method.toLowerCase()}.user_saved_drills`);
  // RLS: owner-only for `authenticated`; anon has no grant at all (42501).
  if (who.role === "anon") {
    return jsonResponse(401, {
      code: "42501",
      message: "permission denied for table user_saved_drills",
    });
  }
  const visible = who.role === "service"
    ? rows(h)
    : rows(h).filter((r) => r.user_id === who.userId);
  const filters = eqFilters(url.searchParams);
  const matches = (r: SavedDrillRow) =>
    filters.every(([col, v]) => String(r[col]) === v);

  if (request.method === "GET") {
    if (stressHooks.beforeSelect) await stressHooks.beforeSelect(who, url);
    // re-read after the hook: it may have mutated the table through the handler
    const nowVisible = who.role === "service"
      ? rows(h)
      : rows(h).filter((r) => r.user_id === who.userId);
    let out = nowVisible.filter(matches);
    const order = url.searchParams.get("order");
    if (order) {
      const [col, dir] = order.split(".");
      out = [...out].sort((a, b) => {
        const av = String(a[col]);
        const bv = String(b[col]);
        return (av < bv ? -1 : av > bv ? 1 : 0) * (dir === "desc" ? -1 : 1);
      });
    }
    const accept = request.headers.get("accept") ?? "";
    if (accept.includes("application/vnd.pgrst.object+json")) {
      if (out.length !== 1) {
        return jsonResponse(406, {
          code: "PGRST116",
          message: `JSON object requested, multiple (or no) rows returned`,
          details: `The result contains ${out.length} rows`,
          hint: null,
        });
      }
      return jsonResponse(200, out[0]);
    }
    return jsonResponse(200, out);
  }

  if (request.method === "POST") {
    if (stressHooks.beforeUpsert) await stressHooks.beforeUpsert(who, url);
    const prefer = request.headers.get("prefer") ?? "";
    let parsed: unknown = {};
    try {
      parsed = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return jsonResponse(400, { code: "PGRST102", message: "invalid json" });
    }
    const incoming = (Array.isArray(parsed) ? parsed : [parsed]).filter(
      isRecord,
    );
    const conflict = url.searchParams.get("on_conflict");
    if (conflict !== "user_id,slug") {
      return jsonResponse(400, {
        code: "42P10",
        message:
          `there is no unique or exclusion constraint matching the ON CONFLICT specification (${conflict})`,
      });
    }
    const inserted: SavedDrillRow[] = [];
    // One statement: all-or-nothing, evaluated atomically (no await below).
    for (const row of incoming) {
      const userId = String(row.user_id ?? "");
      const slug = String(row.slug ?? "");
      if (who.role === "user" && userId !== who.userId) {
        return jsonResponse(403, {
          code: "42501",
          message:
            'new row violates row-level security policy for table "user_saved_drills"',
        });
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(slug)) {
        return jsonResponse(400, {
          code: "23514",
          message:
            'new row for relation "user_saved_drills" violates check constraint "user_saved_drills_slug_bounds"',
        });
      }
      const existing = rows(h).find((r) =>
        r.user_id === userId && r.slug === slug
      );
      if (existing) {
        if (prefer.includes("resolution=ignore-duplicates")) {
          fake.log(
            "rest.upsert.user_saved_drills",
            `ignored duplicate ${userId.slice(0, 8)}/${slug}`,
          );
          continue;
        }
        if (prefer.includes("resolution=merge-duplicates")) {
          Object.assign(existing, row);
          continue;
        }
        return jsonResponse(409, {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "user_saved_drills_pkey"',
        });
      }
      const fresh: SavedDrillRow = {
        user_id: userId,
        slug,
        saved_at: new Date().toISOString(),
      };
      rows(h).push(fresh);
      inserted.push(fresh);
      fake.log(
        "rest.insert.user_saved_drills",
        `${userId.slice(0, 8)}/${slug}`,
      );
    }
    return prefer.includes("return=representation")
      ? jsonResponse(201, inserted)
      : new Response(null, { status: 201 });
  }

  if (request.method === "DELETE") {
    const doomed = new Set(visible.filter(matches));
    fake.tables.user_saved_drills = rows(h).filter((r) => !doomed.has(r));
    fake.log("rest.delete.user_saved_drills", `${doomed.size} rows`);
    return new Response(null, { status: 204 });
  }

  if (request.method === "PATCH") {
    return jsonResponse(405, {
      code: "PGRST",
      message: "stress harness: saved drills never PATCH",
    });
  }
  return new Response(
    `stress harness: unexpected ${request.method} ${request.url}`,
    { status: 599 },
  );
}

// ── Timed requests + bounded bursts ────────────────────────────────────────

export interface Row {
  round: number;
  i: number;
  op: string;
  /** actor:slug the request targets — lets a 5xx be matched to the write it raced */
  tag?: string;
  status: number;
  code?: string;
  startedAt: number;
  endedAt: number;
}

export interface StressInvariant extends Invariant {
  /** Set when the invariant is BROKEN only by an already-classified defect
   * (see the finding of that id); assertReport() reports but does not fail
   * on these so the suite stays green while the defect is open. */
  known?: string;
}

export async function timed(
  rows: Row[],
  round: number,
  i: number,
  op: string,
  fn: () => Promise<Response>,
  tag?: string,
): Promise<{ status: number; body: Record<string, unknown>; row: Row }> {
  const startedAt = performance.now();
  const response = await fn();
  const body = await readJson(response);
  const err = body.error;
  const nested = err && typeof err === "object"
    ? (err as Record<string, unknown>).code
    : undefined;
  const code = typeof nested === "string"
    ? nested
    : typeof body.code === "string"
    ? body.code
    : undefined;
  const row: Row = {
    round,
    i,
    op,
    tag,
    status: response.status,
    code,
    startedAt: Math.round(startedAt * 100) / 100,
    endedAt: Math.round(performance.now() * 100) / 100,
  };
  rows.push(row);
  return { status: response.status, body, row };
}

export class DeadlineExceeded extends Error {
  constructor(public readonly ms: number, public readonly label: string) {
    super(`stress: ${label} did not settle within ${ms}ms (deadlock/hang)`);
  }
}

/** Promise.all with a hard wall-clock ceiling. */
export async function burst<T>(
  label: string,
  lanes: Array<Promise<T>>,
  deadlineMs = STRESS_DEADLINE_MS,
): Promise<T[]> {
  let timer: number | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DeadlineExceeded(deadlineMs, label)),
      deadlineMs,
    );
  });
  try {
    return await Promise.race([Promise.all(lanes), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function inv(
  invariants: StressInvariant[],
  name: string,
  holds: boolean,
  detail: string,
  known?: string,
): void {
  invariants.push(
    holds || !known ? { name, holds, detail } : { name, holds, detail, known },
  );
}

export const no5xx = (rows: Row[]) => rows.filter((r) => r.status >= 500);

export const PUT_DELETE_RACE = "put-delete-race-503";

/** The one classified defect of this unit: PUT /v1/me/saved-drills/:slug
 * answers 503 when the SAME user's DELETE of that slug lands between the
 * route's upsert and its read-back select (../index.ts saveDrill). A 5xx is
 * "explained" by that race when a DELETE with the same round+tag overlapped
 * it in time; anything else is an unexplained 5xx and fails hard. */
export function split5xx(
  rows: Row[],
): { explained: Row[]; unexplained: Row[] } {
  const explained: Row[] = [];
  const unexplained: Row[] = [];
  const deletes = rows.filter((r) =>
    r.op === "delete" || r.op.endsWith(".delete")
  );
  for (const r of no5xx(rows)) {
    const isPut = r.op === "put" || r.op.endsWith(".put");
    const racing = deletes.some(
      (d) =>
        d.round === r.round &&
        d.tag === r.tag &&
        d.startedAt <= r.endedAt &&
        d.endedAt >= r.startedAt,
    );
    (isPut && r.status === 503 && racing ? explained : unexplained).push(r);
  }
  return { explained, unexplained };
}

// ── Seeded slug fuzz ────────────────────────────────────────────────────────

export interface FuzzSlug {
  /** id used in reports (deterministic from the seed) */
  id: string;
  /** the RAW path segment as sent on the wire */
  wire: string;
  /** what decodeURIComponent yields, or null when malformed */
  decoded: string | null;
  /** class label for the histogram */
  kind: string;
}

const CATALOG_SLUGS = [
  "wall-dink-rally",
  "dink-target-boxes",
  "crosscourt-dink-battle",
  "figure-eight-dinks",
  "skinny-singles",
  "midcourt-reset-blocks",
  "volley-wall-ready",
  "transition-zone-crawl",
];

const PROTO_KEYS = [
  "__proto__",
  "constructor",
  "toString",
  "hasOwnProperty",
  "valueOf",
  "prototype",
];

function randomAscii(prng: Prng, n: number, alphabet: string): string {
  return Array.from(
    { length: n },
    () => alphabet[prng.int(0, alphabet.length - 1)],
  ).join("");
}

/** Deterministic slug corpus: catalog slugs, case/length/encoding variants,
 * prototype keys, unicode, control bytes and malformed escapes. */
export function fuzzSlugs(prng: Prng, count: number): FuzzSlug[] {
  const out: FuzzSlug[] = [];
  const push = (kind: string, wire: string) => {
    let decoded: string | null;
    try {
      decoded = decodeURIComponent(wire);
    } catch {
      decoded = null;
    }
    out.push({ id: `${kind}#${out.length}`, wire, decoded, kind });
  };
  const alpha = "abcdefghijklmnopqrstuvwxyz0123456789-_";
  for (let i = 0; i < count; i++) {
    const roll = prng.int(0, 15);
    const cat = CATALOG_SLUGS[prng.int(0, CATALOG_SLUGS.length - 1)];
    switch (roll) {
      case 0:
      case 1:
        push("catalog", cat);
        break;
      case 2:
        push("catalog.upper", cat.toUpperCase());
        break;
      case 3:
        push("catalog.pct", cat.replace(/-/g, "%2D"));
        break;
      case 4:
        push("valid.random", randomAscii(prng, prng.int(1, 40), alpha));
        break;
      case 5:
        push("valid.len120", randomAscii(prng, 120, alpha));
        break;
      case 6:
        push("invalid.len121", randomAscii(prng, 121, alpha));
        break;
      case 7:
        push(
          "invalid.leading",
          `${"-_"[prng.int(0, 1)]}${randomAscii(prng, 5, alpha)}`,
        );
        break;
      case 8:
        push("proto", PROTO_KEYS[prng.int(0, PROTO_KEYS.length - 1)]);
        break;
      case 9:
        push(
          "invalid.unicode",
          encodeURIComponent(
            `${cat}${
              ["é", "ß", "\u017f", "\u212a", "日本", "😀"][prng.int(0, 5)]
            }`,
          ),
        );
        break;
      case 10:
        push("invalid.control", `${cat}%00`);
        break;
      case 11:
        push(
          "malformed.pct",
          ["%E0%A4%A", "%", "%zz", "%C3%28", "abc%"][prng.int(0, 4)],
        );
        break;
      case 12:
        push(
          "invalid.traversal",
          ["..", "%2E%2E", `${cat}%2F..`, "%2Fetc%2Fpasswd"][prng.int(0, 3)],
        );
        break;
      case 13:
        push("invalid.space", `${cat}%20x`);
        break;
      case 14:
        push("invalid.sqlish", encodeURIComponent(`${cat}' or 1=1--`));
        break;
      default:
        push(
          "valid.mixedcase",
          cat.replace(/[a-z]/g, (c) => (prng.int(0, 1) ? c.toUpperCase() : c)),
        );
    }
  }
  return out;
}

/** True when the WHATWG URL parser folds the segment away (`..`, `%2E%2E`):
 * the route regex never sees such a path and the handler answers 404. */
export function segmentNormalizesAway(wire: string): boolean {
  return !/^\/v1\/x\/[^/]+$/.test(
    new URL(`http://edge.test/v1/x/${wire}`).pathname,
  );
}

/** Route oracle for PUT /v1/me/saved-drills/:wire on the tree under test. */
export function expectedPutStatus(slug: FuzzSlug): number {
  if (segmentNormalizesAway(slug.wire)) return 404;
  if (slug.decoded === null) return 400;
  return DRILL_SLUG_RE.test(slug.decoded) ? 200 : 400;
}

// ── Reporting ────────────────────────────────────────────────────────────────

export interface StressReport {
  scenario: string;
  seed: number;
  scale: Record<string, number>;
  inputs: Record<string, unknown>;
  statusHistogram: Record<string, number>;
  counters: Record<string, number>;
  invariants: StressInvariant[];
  observations: Record<string, unknown>;
  requests: number;
  durationMs: number;
  heap: { before: Deno.MemoryUsage; after: Deno.MemoryUsage };
  replay: string;
  rows: Row[];
}

export function stressOutDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-edge-drills-media/latest/",
    import.meta.url,
  ).pathname;
}

export async function writeStressReport(report: StressReport): Promise<string> {
  const dir = stressOutDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${report.scenario}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

export function replay(file: string, filter: string, seed: number): string {
  return `STRESS_SEED=${seed} STRESS_ITER=${STRESS_ITER} STRESS_BURST=${STRESS_BURST} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json ${file} --filter "${filter}"`;
}
