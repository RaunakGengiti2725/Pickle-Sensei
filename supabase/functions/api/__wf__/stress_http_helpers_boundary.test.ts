/**
 * stress-edge-http / boundary-malformed — helper-level campaigns against the
 * exported functions of ../http.ts (sanitizeUserText, clientIp,
 * resolveRequestId, routeTemplate, accessLogEntry, errorCodeOf, withRequestId,
 * constantTimeEqual, legalTextResponse).
 *
 * Every iteration is seeded (see stress_boundary_harness.ts); a seed→outcome
 * table is written to STRESS_OUT_DIR/<campaign>.json. Default STRESS_ITER=200
 * keeps the file fast inside `deno task test`; the reported runs used
 * STRESS_ITER≥3000.
 *
 *   STRESS_ITER=3000 deno test -A --no-check --config deno.json stress_http_helpers_boundary.test.ts
 */
import { assert, assertEquals } from "@std/assert";
import {
  accessLogEntry,
  clientIp,
  constantTimeEqual,
  errorCodeOf,
  JSON_SECURITY_HEADERS,
  legalTextResponse,
  REQUEST_ID_HEADER,
  resolveRequestId,
  routeTemplate,
  sanitizeUserText,
  withRequestId,
} from "../http.ts";
import {
  ATOM_KINDS,
  atom,
  brokenSummary,
  C0_CLASS,
  codePoints,
  genHeaderValue,
  genPathSegment,
  genRawBody,
  genString,
  INVISIBLE_KEPT_RE,
  type IterationRow,
  NORMALIZATION_PAIRS,
  PATH_KINDS,
  preview,
  RAW_BODY_KINDS,
  refSanitize,
  runCampaign,
  STRESS_ITER,
  STRIPPED_RE,
  writeCampaign,
} from "./stress_boundary_harness.ts";

const FILE = "stress_http_helpers_boundary.test.ts";
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

type Check = readonly [name: string, ok: boolean, detail?: string];

function judge(
  caseName: string,
  input: unknown,
  checks: Check[],
  metrics?: Record<string, unknown>,
): Omit<IterationRow, "i" | "seed"> {
  const failed = checks.filter((c) => !c[1]);
  return {
    case: caseName,
    input: preview(input),
    outcome: failed.length === 0 ? "HELD" : "BROKEN",
    detail: failed.length
      ? failed.map((c) => `${c[0]}${c[2] ? `: ${c[2]}` : ""}`).join(" | ")
      : undefined,
    metrics,
  };
}

// ── Campaign 1: sanitizeUserText ─────────────────────────────────────────────

const CAPS = [1, 3, 40, 64, 120, 128, 200, 256, 500, 512, 1000];

Deno.test(
  "stress: sanitizeUserText — unicode / caps / control / surrogate boundary campaign",
  async () => {
    const campaign = "sanitize_user_text";
    const metrics = {
      graphemeSplitAtCap: 0,
      invisibleKept: 0,
      nfcNfdDiffer: 0,
      emptyFromNonEmpty: 0,
      surrogateFusion: 0,
      surrogateFusionSeeds: [] as number[],
      maxMs: 0,
      largestInputCodePoints: 0,
      byLengthClass: {} as Record<string, number>,
    };
    const report = await runCampaign(
      campaign,
      FILE,
      (p, _i, seed) => {
        // bias: sometimes a single atom kind so each class gets isolated coverage
        const single = p.chance(0.25) ? p.pick(ATOM_KINDS) : null;
        const cap = p.chance(0.15) ? p.int(1, 2_000) : p.pick(CAPS);
        const input = single
          ? Array.from({ length: p.int(1, 400) }, () => atom(p, single)).join("")
          : genString(p, { cap });
        const inputPoints = codePoints(input);
        metrics.largestInputCodePoints = Math.max(metrics.largestInputCodePoints, inputPoints);

        const t0 = performance.now();
        let out: string;
        try {
          out = sanitizeUserText(input, cap);
        } catch (error) {
          return judge("sanitize/throw", input, [["no-throw", false, String(error)]]);
        }
        const ms = performance.now() - t0;
        metrics.maxMs = Math.max(metrics.maxMs, ms);

        const ref = refSanitize(input, cap);
        const again = sanitizeUserText(out, cap);
        const wellFormed = (out as unknown as { isWellFormed(): boolean }).isWellFormed();
        const outPoints = codePoints(out);
        const strippable = new RegExp(`${STRIPPED_RE.source}|\\s`, "u");
        const hasKeepable = Array.from(input).some(
          (ch) =>
            !strippable.test(ch) &&
            !(ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff && ch.length === 1),
        );
        const inputSet = new Set(Array.from(input));
        const onlyFromInput = Array.from(out).every((ch) => ch === " " || inputSet.has(ch));

        if (out.length === 0 && hasKeepable) metrics.emptyFromNonEmpty += 1;
        if (!onlyFromInput) {
          // P3 characterization (not asserted): lone high + stripped char(s) +
          // lone low fuse into an astral code point absent from the input.
          metrics.surrogateFusion += 1;
          if (metrics.surrogateFusionSeeds.length < 20) metrics.surrogateFusionSeeds.push(seed);
        }
        if (INVISIBLE_KEPT_RE.test(out)) metrics.invisibleKept += 1;
        // grapheme split: the cap fell inside a cluster (last grapheme of the
        // uncapped cleaned text differs from the last grapheme of the output)
        const uncapped = refSanitize(input, Number.MAX_SAFE_INTEGER);
        if (codePoints(uncapped) > cap && out.length > 0) {
          const g = graphemes(uncapped);
          const outG = graphemes(out);
          const boundaryIntact = g.slice(0, outG.length).join("") === out;
          if (!boundaryIntact) metrics.graphemeSplitAtCap += 1;
        }

        return judge(
          single ? `sanitize/${single}` : `sanitize/mixed`,
          input,
          [
            ["well-formed UTF-16", wellFormed, preview(out)],
            ["code points ≤ cap", outPoints <= cap, `${outPoints} > ${cap}`],
            ["no control/zero-width/bidi/BOM", !STRIPPED_RE.test(out), preview(out)],
            ["single-space runs only", !/\s\s/u.test(out) && !/[^\S ]/u.test(out), preview(out)],
            ["trimmed", out === out.trim(), preview(out)],
            ["header/JSON safe", !/[\r\n]/.test(out) && !out.includes("\u0000")],
            ["idempotent", again === out, `re-sanitize changed: ${preview(again)}`],
            ["JSON round-trip", JSON.parse(JSON.stringify(out)) === out],
            [
              "non-empty when keepable input",
              !(hasKeepable && cap >= 1 && out.length === 0),
              preview(input),
            ],
            [
              "matches reference implementation",
              out === ref,
              `got ${preview(out)} want ${preview(ref)}`,
            ],
            ["≤ 2s even for MB inputs", ms < 2_000, `${ms.toFixed(1)}ms for ${inputPoints} cp`],
          ],
          { cap, inputPoints, outPoints, ms: Math.round(ms * 100) / 100 },
        );
      },
      { metrics: () => metrics },
    );
    const path = await writeCampaign(report);
    console.error(
      `[stress] ${campaign}: ${report.executed} executed, ${report.broken} broken → ${path}\n${JSON.stringify(metrics)}`,
    );
    assertEquals(report.broken, 0, brokenSummary(report));
    assert(report.executed >= Math.min(STRESS_ITER, 1));
  },
);

Deno.test(
  "directed (P3 characterization): sanitizeUserText fuses surrogate halves separated by stripped characters",
  () => {
    // Pass order is controls/spoofing THEN lone surrogates, so U+D823 U+0000
    // U+DE80 becomes the single code point U+18E80 — a character that was not in
    // the input. Reachable from any JSON body ("\ud823\u0000\ude80"). Output is
    // still well-formed, capped, and control-free; pinned so a future fix is
    // visible rather than silent. Same behaviour on origin/main (not a regression).
    assertEquals(sanitizeUserText("\ud823\u0000\ude80", 10), "\u{18E80}");
    assertEquals(sanitizeUserText("\ud823\u200b\ude80", 10), "\u{18E80}");
    assertEquals(sanitizeUserText("\ud823 \ude80", 10), ""); // a kept separator: both halves are lone and dropped
    assertEquals(sanitizeUserText("\ud823\ude80", 10), "\u{18E80}");
  },
);

Deno.test(
  "stress: sanitizeUserText — NFC/NFD pairs are both preserved and cap by code points, never bytes",
  () => {
    for (const [nfc, nfd] of NORMALIZATION_PAIRS) {
      for (const cap of [1, 2, 3, 64]) {
        const a = sanitizeUserText(nfc, cap);
        const b = sanitizeUserText(nfd, cap);
        assertEquals(a, Array.from(nfc).slice(0, cap).join("").trimEnd());
        assertEquals(b, Array.from(nfd).slice(0, cap).join("").trimEnd());
        assert(!STRIPPED_RE.test(a) && !STRIPPED_RE.test(b));
      }
    }
    // 64 KiB+ of 4-byte code points is capped by code points, not bytes.
    const emoji = "\u{1F3D3}".repeat(70_000);
    const capped = sanitizeUserText(emoji, 512);
    assertEquals(codePoints(capped), 512);
    assertEquals(new TextEncoder().encode(capped).byteLength, 2_048);
  },
);

// ── Campaign 2: request-scoped helpers ───────────────────────────────────────

Deno.test(
  "stress: clientIp / resolveRequestId / routeTemplate / accessLogEntry header+path fuzz",
  async () => {
    const campaign = "request_helpers";
    const metrics = {
      requestIdHonoured: 0,
      requestIdReplaced: 0,
      ipUnknown: 0,
      ipFromCf: 0,
      ipFromXff: 0,
    };
    const report = await runCampaign(
      campaign,
      FILE,
      (p) => {
        const headers = new Headers();
        const cf = p.chance(0.5) ? genHeaderValue(p, 80) : null;
        const xffHops = p.chance(0.7)
          ? Array.from({ length: p.int(0, 12) }, () =>
              p.chance(0.2) ? p.pick(["", " ", "\t", ",,"]) : genHeaderValue(p, 60),
            )
          : null;
        const rid = p.chance(0.8) ? genHeaderValue(p, 120) : null;
        if (cf !== null) headers.set("cf-connecting-ip", cf);
        if (xffHops !== null) headers.set("x-forwarded-for", xffHops.join(","));
        if (rid !== null) headers.set(REQUEST_ID_HEADER, rid);
        const segments = Array.from({ length: p.int(1, 5) }, () =>
          genPathSegment(p, p.pick(PATH_KINDS)),
        );
        const query = p.chance(0.5) ? `?token=${p.uuid()}&email=a%40b.c` : "";
        let request: Request;
        try {
          request = new Request(
            `http://edge.test/functions/v1/api/v1/${segments.join("/")}${query}`,
            {
              method: p.pick(["GET", "POST", "PUT", "DELETE", "PATCH"]),
              headers,
            },
          );
        } catch (error) {
          // An unparseable URL cannot reach the handler at all; not a helper property.
          return judge("request/unconstructible", segments, [
            ["url unconstructible (skip)", true, String(error)],
          ]);
        }

        const checks: Check[] = [];

        // clientIp
        let ip = "";
        try {
          ip = clientIp(request);
        } catch (error) {
          checks.push(["clientIp no-throw", false, String(error)]);
        }
        const cfTrim = cf?.trim() ?? "";
        // hops as the wire sees them: the header value split on commas (a hop
        // that itself contains a comma is two hops)
        const hops = (xffHops ?? [])
          .join(",")
          .split(",")
          .map((h) => h.trim())
          .filter(Boolean);
        const expectIp = cfTrim || hops[hops.length - 1] || "unknown";
        if (ip === "unknown") metrics.ipUnknown += 1;
        else if (cfTrim) metrics.ipFromCf += 1;
        else metrics.ipFromXff += 1;
        checks.push([
          "clientIp non-empty & trimmed",
          ip.length > 0 && ip === ip.trim(),
          preview(ip),
        ]);
        checks.push([
          "clientIp contract (cf → last xff hop → unknown)",
          ip === expectIp,
          `got ${preview(ip)} want ${preview(expectIp)}`,
        ]);
        checks.push([
          "clientIp from x-forwarded-for is a single hop",
          cfTrim !== "" || !ip.includes(","),
          preview(ip),
        ]);

        // resolveRequestId
        let resolved = "";
        try {
          resolved = resolveRequestId(request);
        } catch (error) {
          checks.push(["resolveRequestId no-throw", false, String(error)]);
        }
        const incoming = rid?.trim() ?? "";
        const conforms = REQUEST_ID_RE.test(incoming);
        if (conforms) metrics.requestIdHonoured += 1;
        else metrics.requestIdReplaced += 1;
        checks.push([
          "request id is conforming or UUID",
          REQUEST_ID_RE.test(resolved) || UUID_RE.test(resolved),
          preview(resolved),
        ]);
        checks.push([
          "conforming incoming id echoed, anything else replaced by a fresh UUID",
          conforms ? resolved === incoming : UUID_RE.test(resolved) && resolved !== rid,
          `incoming ${preview(rid)} → ${preview(resolved)}`,
        ]);
        checks.push(["request id header-safe", !/[^\x21-\x7e]/.test(resolved), preview(resolved)]);

        // routeTemplate + accessLogEntry
        const pathname = new URL(request.url).pathname;
        let template = "";
        try {
          template = routeTemplate(pathname);
        } catch (error) {
          checks.push(["routeTemplate no-throw", false, String(error)]);
        }
        const tplSegments = template.split("/");
        checks.push([
          "routeTemplate keeps segment count",
          tplSegments.length === pathname.split("/").length,
          template,
        ]);
        checks.push([
          "routeTemplate hides UUID and ≥4-digit segments",
          tplSegments.every(
            (s) =>
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) &&
              !/^\d{4,}$/.test(s),
          ),
          template,
        ]);
        checks.push(["routeTemplate deterministic", routeTemplate(pathname) === template]);

        const response = new Response(null, {
          status: p.pick([200, 204, 400, 401, 404, 413, 429, 500, 503]),
        });
        let line = "";
        try {
          const entry = accessLogEntry(
            request,
            response,
            resolved,
            performance.now() - p.int(0, 5_000),
            p.chance(0.5) ? "validation.x" : undefined,
          );
          line = JSON.stringify(entry);
          checks.push([
            "access log has no query string / token",
            !line.includes("token=") && !line.includes("a%40b.c") && !line.includes("?"),
            line,
          ]);
          checks.push([
            "access log has no IP",
            !line.includes(ip) || ip === "unknown" || ip.length < 4,
            line,
          ]);
          checks.push(["access log requestId matches", entry.requestId === resolved]);
          checks.push([
            "access log durationMs is a non-negative integer",
            Number.isInteger(entry.durationMs) && entry.durationMs >= 0,
            String(entry.durationMs),
          ]);
          checks.push(["access log route is the template", entry.route === template]);
          checks.push([
            "access log JSON has no raw control chars",
            !new RegExp(`[${C0_CLASS}]`).test(line),
            line,
          ]);
        } catch (error) {
          checks.push(["accessLogEntry no-throw", false, String(error)]);
        }

        return judge(
          "request/helpers",
          { cf, xff: xffHops?.join(","), rid, path: pathname },
          checks,
          { ip: preview(ip), template },
        );
      },
      { metrics: () => metrics },
    );
    const path = await writeCampaign(report);
    console.error(
      `[stress] ${campaign}: ${report.executed} executed, ${report.broken} broken → ${path}\n${JSON.stringify(metrics)}`,
    );
    assertEquals(report.broken, 0, brokenSummary(report));
  },
);

// ── Campaign 3: response-side helpers ────────────────────────────────────────

Deno.test(
  "stress: errorCodeOf / withRequestId / legalTextResponse malformed-body fuzz",
  async () => {
    const campaign = "response_helpers";
    const metrics = { codeExtracted: 0, codeUndefined: 0 };
    const report = await runCampaign(
      campaign,
      FILE,
      async (p) => {
        const status = p.pick([200, 204, 400, 401, 402, 404, 409, 413, 429, 500, 503]);
        const bodyKind = p.pick(RAW_BODY_KINDS);
        const code = p.chance(0.6)
          ? genString(p, { lengthClass: p.pick(["short", "medium"]) })
          : p.chance(0.5)
            ? genString(p, { lengthClass: "one" })
            : null;
        const payload: Record<string, unknown> = p.weighted<Record<string, unknown>>([
          [6, { error: { code, message: genString(p, { lengthClass: "medium" }) } }],
          [1, { error: { code: 42, message: "n" } }],
          [1, { error: null }],
          [1, { error: "string" }],
          [1, { error: [] }],
          [1, { error: { code: null } }],
          [1, { code: "top-level-code" }],
          [1, { __proto__: { code: "polluted" } }],
        ]);
        const raw =
          bodyKind === "deep_nesting" && p.chance(0.5)
            ? genRawBody(p, payload, "valid")
            : genRawBody(p, payload, bodyKind);
        const contentType = p.weighted<string | null>([
          [6, "application/json"],
          [2, "application/json; charset=utf-8"],
          [1, "text/plain"],
          [1, "text/html"],
          [1, "application/problem+json"],
          [1, null],
        ]);
        const headers = new Headers({ "x-existing": "1", "x-request-id": "stale-request-id" });
        if (contentType) headers.set("content-type", contentType);
        const hasBody = status !== 204;
        const response = new Response(hasBody ? (raw.bytes as BodyInit) : null, {
          status,
          headers,
        });

        const checks: Check[] = [];
        let extracted: string | undefined;
        try {
          extracted = await errorCodeOf(response);
        } catch (error) {
          checks.push(["errorCodeOf no-throw", false, String(error)]);
        }
        // oracle: string error.code iff the body is JSON parseable to an object
        // whose error.code is a string; anything else → undefined.
        let expected: string | undefined;
        if (hasBody && status >= 400 && (contentType ?? "").includes("application/json")) {
          try {
            const parsed = JSON.parse(new TextDecoder().decode(raw.bytes)) as {
              error?: { code?: unknown };
            } | null;
            const c = parsed?.error?.code;
            expected = typeof c === "string" ? c : undefined;
          } catch {
            expected = undefined;
          }
        }
        if (extracted !== undefined) metrics.codeExtracted += 1;
        else metrics.codeUndefined += 1;
        checks.push([
          "errorCodeOf string|undefined",
          extracted === undefined || typeof extracted === "string",
        ]);
        checks.push([
          "errorCodeOf matches oracle",
          extracted === expected,
          `got ${preview(extracted)} want ${preview(expected)}`,
        ]);
        checks.push(["errorCodeOf leaves the body readable", !response.bodyUsed]);

        const requestId = p.chance(0.5) ? crypto.randomUUID() : `req-${p.int(1_000, 9_999_999)}`;
        let stamped: Response | null = null;
        try {
          stamped = withRequestId(response, requestId);
        } catch (error) {
          checks.push(["withRequestId no-throw", false, String(error)]);
        }
        if (stamped) {
          checks.push([
            "withRequestId sets the id (overwriting a stale one)",
            stamped.headers.get(REQUEST_ID_HEADER) === requestId,
          ]);
          checks.push(["withRequestId keeps status", stamped.status === status]);
          checks.push([
            "withRequestId keeps other headers",
            stamped.headers.get("x-existing") === "1",
          ]);
          const bytes = new Uint8Array(await stamped.arrayBuffer());
          const want = hasBody ? raw.bytes : new Uint8Array(0);
          checks.push([
            "withRequestId keeps body bytes",
            bytes.length === want.length && bytes.every((b, i) => b === want[i]),
            `${bytes.length} vs ${want.length}`,
          ]);
        }

        // legalTextResponse with fuzzed text/status
        const legalText = genString(p, {
          lengthClass: p.pick(["empty", "short", "medium", "large"]),
        });
        const legalStatus = p.pick([200, 404, 500]);
        try {
          const legal = legalTextResponse(legalText, legalStatus);
          checks.push(["legalTextResponse status", legal.status === legalStatus]);
          checks.push([
            "legalTextResponse nosniff/no-referrer",
            legal.headers.get("x-content-type-options") === "nosniff" &&
              legal.headers.get("referrer-policy") === "no-referrer",
          ]);
          checks.push([
            "legalTextResponse text/plain utf-8",
            (legal.headers.get("content-type") ?? "").startsWith("text/plain"),
          ]);
          const legalBody = await legal.text();
          checks.push([
            "legalTextResponse body round-trips (at most lone surrogates → U+FFFD)",
            legalBody === legalText || legalBody === legalText.toWellFormed(),
            preview(legalBody),
          ]);
        } catch (error) {
          checks.push(["legalTextResponse no-throw", false, String(error)]);
        }
        checks.push([
          "JSON_SECURITY_HEADERS stable",
          JSON_SECURITY_HEADERS["Cache-Control"] === "no-store" &&
            JSON_SECURITY_HEADERS["X-Content-Type-Options"] === "nosniff",
        ]);

        return judge(
          `response/${raw.kind}`,
          { status, contentType, body: new TextDecoder().decode(raw.bytes) },
          checks,
        );
      },
      { metrics: () => metrics },
    );
    const path = await writeCampaign(report);
    console.error(
      `[stress] ${campaign}: ${report.executed} executed, ${report.broken} broken → ${path}\n${JSON.stringify(metrics)}`,
    );
    assertEquals(report.broken, 0, brokenSummary(report));
  },
);

// ── Campaign 4: constantTimeEqual ────────────────────────────────────────────

Deno.test(
  "stress: constantTimeEqual — equality oracle on well-formed strings; lone-surrogate collisions recorded",
  async () => {
    const campaign = "constant_time_equal";
    const metrics = {
      equalPairs: 0,
      differentPairs: 0,
      loneSurrogateCollisions: 0,
      loneSurrogateCollisionSeeds: [] as number[],
    };
    const report = await runCampaign(
      campaign,
      FILE,
      (p, _i, seed) => {
        const a = genString(p, {
          lengthClass: p.pick(["empty", "one", "short", "medium", "large"]),
        });
        const mode = p.weighted<"same" | "mutated" | "other" | "prefix" | "surrogate-swap">([
          [3, "same"],
          [3, "mutated"],
          [2, "other"],
          [1, "prefix"],
          [1, "surrogate-swap"],
        ]);
        let b: string;
        switch (mode) {
          case "same":
            b = a;
            break;
          case "mutated": {
            const pts = Array.from(a);
            if (pts.length === 0) b = "x";
            else {
              const at = p.int(0, pts.length - 1);
              pts[at] = pts[at] === "x" ? "y" : "x";
              b = pts.join("");
            }
            break;
          }
          case "other":
            b = genString(p);
            break;
          case "prefix":
            b = a + "\u0000";
            break;
          case "surrogate-swap":
            b = a.replace(
              /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u,
              (c) => (c === "\ud800" ? "\udc00" : "\ud800"),
            );
            break;
        }
        const wellFormed =
          (a as unknown as { isWellFormed(): boolean }).isWellFormed() &&
          (b as unknown as { isWellFormed(): boolean }).isWellFormed();
        let result: boolean | null = null;
        const checks: Check[] = [];
        try {
          result = constantTimeEqual(a, b);
        } catch (error) {
          checks.push(["constantTimeEqual no-throw", false, String(error)]);
        }
        if (a === b) metrics.equalPairs += 1;
        else metrics.differentPairs += 1;
        if (result !== null) {
          checks.push(["symmetric", constantTimeEqual(b, a) === result]);
          checks.push([
            "reflexive",
            constantTimeEqual(a, a) === true && constantTimeEqual(b, b) === true,
          ]);
          if (wellFormed) {
            checks.push([
              "equals string equality (well-formed)",
              result === (a === b),
              `${preview(a)} vs ${preview(b)}`,
            ]);
          } else if (result && a !== b) {
            // Different JS strings that compare equal: both encode to the same
            // UTF-8 (lone surrogates → U+FFFD). Recorded, not asserted: no
            // caller passes a non-ByteString here (see findings).
            metrics.loneSurrogateCollisions += 1;
            if (metrics.loneSurrogateCollisionSeeds.length < 20)
              metrics.loneSurrogateCollisionSeeds.push(seed);
          }
        }
        return judge(`cte/${mode}`, { a, b }, checks, { wellFormed, result });
      },
      { metrics: () => metrics },
    );
    const path = await writeCampaign(report);
    console.error(
      `[stress] ${campaign}: ${report.executed} executed, ${report.broken} broken → ${path}\n${JSON.stringify(metrics)}`,
    );
    assertEquals(report.broken, 0, brokenSummary(report));
  },
);

Deno.test(
  "directed: constantTimeEqual treats distinct lone surrogates as equal (UTF-8 replacement collision; unreachable via HTTP headers)",
  () => {
    // Documented observation for the stress report: header values are
    // ByteStrings (Latin-1) so a lone surrogate can never arrive from the wire;
    // recorded here so the property is pinned as KNOWN rather than silently
    // depended on.
    assertEquals(constantTimeEqual("\ud800", "\udc00"), true);
    assertEquals(("\ud800" as string) === "\udc00", false);
    assert(
      !(() => {
        try {
          new Headers({ authorization: "\ud800" });
          return true;
        } catch {
          return false;
        }
      })(),
    );
  },
);
