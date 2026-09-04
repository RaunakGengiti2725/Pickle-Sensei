// Correlation contract of the outer handler: every response carries
// x-request-id (client-supplied when well-formed, otherwise minted) and every
// request emits exactly one JSON access-log line with categorical fields only.
//
// Run: deno test -A --no-check --config deno.json   (inside __wf__/)

import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  accessLogEntry,
  captureAccessLog,
  errorCodeOf,
  resolveRequestId,
  routeTemplate,
  withRequestId,
} from "../http.ts";
import { loadHarness, userRequest } from "./routesHarness.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const restore = captureAccessLog((line) => lines.push(line));
  return fn()
    .then((result) => ({ result, lines }))
    .finally(restore);
}

Deno.test("resolveRequestId honours a well-formed client id and mints otherwise", () => {
  const ok = new Request("http://x/", { headers: { "x-request-id": "client-abc.123_XYZ" } });
  assertEquals(resolveRequestId(ok), "client-abc.123_XYZ");
  for (const bad of ["short", "has space here", "x".repeat(65), "<script>alert(1)</script>"]) {
    const req = new Request("http://x/", { headers: { "x-request-id": bad } });
    assertMatch(resolveRequestId(req), UUID);
  }
  assertMatch(resolveRequestId(new Request("http://x/")), UUID);
});

Deno.test("routeTemplate collapses uuids and long digit runs, keeps route words", () => {
  assertEquals(
    routeTemplate("/functions/v1/api/v1/shots/11111111-1111-4111-8111-111111111111/feedback"),
    "/functions/v1/api/v1/shots/:id/feedback",
  );
  assertEquals(routeTemplate("/v1/sessions/123456/end"), "/v1/sessions/:id/end");
  assertEquals(routeTemplate("/v1/me/access"), "/v1/me/access");
});

Deno.test(
  "accessLogEntry / errorCodeOf / withRequestId are categorical and body-preserving",
  async () => {
    const request = new Request(
      "http://edge.test/functions/v1/api/v1/shots/11111111-1111-4111-8111-111111111111?secret=1",
      { method: "POST", headers: { authorization: "Bearer nope" } },
    );
    const response = new Response(
      JSON.stringify({ error: { code: "shot.invalid", message: "m" } }),
      {
        status: 400,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      },
    );
    const code = await errorCodeOf(response);
    assertEquals(code, "shot.invalid");
    const entry = accessLogEntry(request, response, "rid-12345678", performance.now() - 5, code);
    assertEquals(entry.evt, "api_request");
    assertEquals(entry.method, "POST");
    assertEquals(entry.route, "/functions/v1/api/v1/shots/:id");
    assertEquals(entry.status, 400);
    assertEquals(entry.code, "shot.invalid");
    assert(entry.durationMs >= 0);
    const serialized = JSON.stringify(entry);
    assert(!serialized.includes("secret=1"));
    assert(!serialized.includes("Bearer"));
    assert(!serialized.includes("11111111-1111"));

    const stamped = withRequestId(response, "rid-12345678");
    assertEquals(stamped.status, 400);
    assertEquals(stamped.headers.get("x-request-id"), "rid-12345678");
    assertEquals(stamped.headers.get("cache-control"), "no-store");
    assertEquals((await stamped.json()).error.code, "shot.invalid");

    const empty = withRequestId(new Response(null, { status: 204 }), "rid-12345678");
    assertEquals(empty.status, 204);
    assertEquals(empty.headers.get("x-request-id"), "rid-12345678");
    assertEquals(await errorCodeOf(new Response("plain", { status: 500 })), undefined);
  },
);

Deno.test("handler: minted x-request-id on every response + one access-log line", async () => {
  const h = await loadHarness();
  const { result: res, lines } = await captureLogs(() =>
    h.handler(userRequest("GET", "/healthz", { ip: "198.51.100.50" })),
  );
  assertEquals(res.status, 200);
  const id = res.headers.get("x-request-id");
  assert(id);
  assertMatch(id, UUID);
  const access = lines.filter((line) => line.startsWith('{"evt":"api_request"'));
  assertEquals(access.length, 1);
  const entry = JSON.parse(access[0]);
  assertEquals(entry.requestId, id);
  assertEquals(entry.method, "GET");
  assertEquals(entry.route, "/functions/v1/api/healthz");
  assertEquals(entry.status, 200);
  assertEquals(typeof entry.durationMs, "number");
  assertEquals("code" in entry, false);
});

Deno.test(
  "handler: echoes a well-formed client id, ignores a malformed one, logs error.code",
  async () => {
    const h = await loadHarness();
    const echoed = await h.handler(
      userRequest("GET", "/healthz", {
        ip: "198.51.100.51",
        headers: { "x-request-id": "mobile-req-0001" },
      }),
    );
    assertEquals(echoed.headers.get("x-request-id"), "mobile-req-0001");

    const malformed = await h.handler(
      userRequest("GET", "/healthz", {
        ip: "198.51.100.52",
        headers: { "x-request-id": "not valid because of spaces" },
      }),
    );
    assertNotEquals(malformed.headers.get("x-request-id"), "not valid because of spaces");
    assertMatch(malformed.headers.get("x-request-id") ?? "", UUID);

    const { result: unknownRoute, lines } = await captureLogs(() =>
      h.handler(userRequest("GET", "/v1/definitely-not-a-route", { ip: "198.51.100.53" })),
    );
    assert(unknownRoute.status >= 400);
    assert(unknownRoute.headers.get("x-request-id"));
    const entry = JSON.parse(lines.find((l) => l.startsWith('{"evt":"api_request"')) ?? "{}");
    assertEquals(entry.status, unknownRoute.status);
    assertEquals(entry.route, "/functions/v1/api/v1/definitely-not-a-route");
    const body = await unknownRoute.json();
    if (typeof body?.error?.code === "string") assertEquals(entry.code, body.error.code);
  },
);
