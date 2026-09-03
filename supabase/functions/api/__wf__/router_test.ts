// Router-level evidence for the edge-http-legal-security audit. Boots the
// real function against a fake Supabase (edgeHarness.ts). Tests tagged
// [defect-pin] assert the CURRENT (defective) behaviour so the finding is
// reproducible; flip the assertion when the fix lands.
//
//   deno test --allow-all --no-check --node-modules-dir=none supabase/functions/api/__wf__/

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  API_BASE,
  authedInit,
  bootEdgeFunction,
  fakeGoogleIdToken,
  recorded,
  resetRest,
  restJson,
  setRestResponder,
  streamedJsonBody,
  USER_ID,
  wantsSingleObject,
} from "./edgeHarness.ts";

const PROFILE = {
  skill_level: "beginner",
  handedness: "right",
  primary_goal: "dinks",
  biggest_problem: "x",
  focus_checkpoint: "contact_position",
  first_name: null,
  gender: null,
};

const ONBOARDING = {
  skillLevel: "beginner",
  handedness: "right",
  goal: "dinks",
};

function profileResponder() {
  setRestResponder((req) => {
    if (req.path === "profiles" && req.method === "PATCH") {
      const patch = JSON.parse(req.body) as Record<string, unknown>;
      const row = { ...PROFILE, ...patch };
      return restJson(200, wantsSingleObject(req) ? row : [row]);
    }
    return null;
  });
}

Deno.test({
  name: "public routes: healthz/support/privacy/terms answer without auth, with hardening headers",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await bootEdgeFunction();
    const health = await fetch(`${API_BASE}/functions/v1/api/healthz`);
    assertEquals(health.status, 200);
    assertEquals(await health.json(), { ok: true });
    assertEquals(health.headers.get("cache-control"), "no-store");
    assertEquals(health.headers.get("x-content-type-options"), "nosniff");

    const support = await fetch(`${API_BASE}/functions/v1/api/support`);
    assertEquals(support.status, 200);
    assertEquals(support.headers.get("content-type"), "text/plain; charset=utf-8");
    assertStringIncludes(await support.text(), "picklesenseidev@gmail.com");

    const privacy = await fetch(`${API_BASE}/functions/v1/api/privacy`);
    assertEquals(privacy.status, 200);
    assertEquals(privacy.headers.get("content-type"), "text/plain; charset=utf-8");
    assertStringIncludes(await privacy.text(), "picklesenseidev@gmail.com");

    const terms = await fetch(`${API_BASE}/functions/v1/api/terms`);
    assertEquals(terms.status, 200);
    assertStringIncludes(await terms.text(), "auto-renewing");

    for (const path of ["healthz", "support", "privacy", "terms"]) {
      const head = await fetch(`${API_BASE}/functions/v1/api/${path}`, {
        method: "HEAD",
      });
      assertEquals(head.status, 200);
      assertEquals(await head.text(), "");
    }
  },
});

Deno.test({
  name: "public routes match on pathname suffix only (…/v1/me/privacy also serves the policy)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await bootEdgeFunction();
    const res = await fetch(`${API_BASE}/functions/v1/api/v1/me/privacy`);
    assertEquals(res.status, 200);
    assertStringIncludes(await res.text(), "PRIVACY POLICY");
  },
});

Deno.test({
  name: "no CORS surface: OPTIONS preflight is an ordinary 401 with no Access-Control-* headers",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await bootEdgeFunction();
    const res = await fetch(`${API_BASE}/v1/me`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" },
    });
    assertEquals(res.status, 401);
    assertEquals(res.headers.get("access-control-allow-origin"), null);
    await res.body?.cancel();
  },
});

Deno.test({
  name: "webhook fails closed when REVENUECAT_WEBHOOK_AUTH is unset (503, generic body)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await bootEdgeFunction();
    Deno.env.delete("REVENUECAT_WEBHOOK_AUTH");
    const res = await fetch(`${API_BASE}/webhooks/revenuecat`, {
      method: "POST",
      body: JSON.stringify({ event: { id: "x" } }),
    });
    assertEquals(res.status, 503);
    assertEquals(await res.json(), { error: { message: "Webhook is not configured." } });
  },
});

Deno.test({
  name: "declared oversize body (Content-Length > 5 MB) is refused with 413 before auth",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await bootEdgeFunction();
    // fetch() forbids a hand-set Content-Length, so speak HTTP/1.1 directly:
    // declare 6 MB and send nothing — the router must answer from the header
    // alone (index.ts:2142-2145) without waiting for the body.
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: 8000 });
    const head =
      "POST /v1/sessions HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nContent-Type: application/json\r\n" +
      "Content-Length: 6000000\r\n\r\n";
    await conn.write(new TextEncoder().encode(head));
    const buf = new Uint8Array(4096);
    const n = (await conn.read(buf)) ?? 0;
    conn.close();
    const response = new TextDecoder().decode(buf.subarray(0, n));
    assertStringIncludes(response.split("\r\n")[0], " 413 ");
    assertStringIncludes(response, '"Request body is too large."');
  },
});

Deno.test({
  name: "streamed (chunked, no Content-Length) 6 MB body on PUT /v1/me/onboarding is rejected with 413 and never reaches the DB",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await bootEdgeFunction();
    resetRest();
    profileResponder();
    const prefix = JSON.stringify(ONBOARDING).slice(0, -1) + ',"biggestProblem":"ok","pad":"';
    const res = await fetch(
      `${API_BASE}/v1/me/onboarding`,
      authedInit({
        method: "PUT",
        body: streamedJsonBody(prefix, '"}', 6_000_000),
      }),
    );
    assertEquals(res.status, 413);
    const payload = (await res.json()) as { error: { message: string } };
    assertEquals(payload.error.message, "Request body is too large.");
    assert(!recorded.some((r) => r.path === "profiles" && r.method === "PATCH"));
  },
});

Deno.test({
  name: "streamed 6 MB body on a readBody() route is reported as 413 (a size problem, not a validation 400)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await bootEdgeFunction();
    resetRest();
    const res = await fetch(
      `${API_BASE}/v1/sessions`,
      authedInit({
        method: "POST",
        body: streamedJsonBody('{"idempotencyKey":"k","pad":"', '"}', 6_000_000),
      }),
    );
    assertEquals(res.status, 413);
    await res.body?.cancel();
  },
});

Deno.test({
  name: "PUT /v1/me/onboarding sanitizes biggestProblem like firstName (bidi + control chars never reach the DB write)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await bootEdgeFunction();
    resetRest();
    profileResponder();
    const hostile = "I lose dinks\u202e\u0007\u200b at the kitchen";
    const res = await fetch(
      `${API_BASE}/v1/me/onboarding`,
      authedInit({
        method: "PUT",
        body: JSON.stringify({ ...ONBOARDING, biggestProblem: hostile, firstName: "Al\u202ei" }),
      }),
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();
    const patch = recorded.find((r) => r.path === "profiles" && r.method === "PATCH");
    assert(patch, "profiles PATCH was issued");
    const body = JSON.parse(patch.body) as Record<string, unknown>;
    assertEquals(body.first_name, "Ali");
    assertEquals(body.biggest_problem, "I lose dinks at the kitchen");
  },
});

Deno.test({
  name: "POST /v1/me/evaluation/trials reports a write failure with generic copy, never raw PostgREST/DB error text",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await bootEdgeFunction();
    resetRest();
    const dbError = 'new row violates row-level security policy for table "evaluation_trials"';
    setRestResponder((req) => {
      if (req.path === "consent_records" && req.method === "GET") {
        return restJson(200, [
          {
            scope: "evaluation_telemetry",
            action: "grant",
            consent_version: "v1",
            created_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (req.path === "evaluation_trials" && req.method === "POST") {
        return restJson(403, { code: "42501", message: dbError, details: null, hint: null });
      }
      return null;
    });
    const trialId = "22222222-2222-4222-8222-222222222222";
    const res = await fetch(
      `${API_BASE}/v1/me/evaluation/trials`,
      authedInit({
        method: "POST",
        body: JSON.stringify({ trials: [{ trialId, schemaVersion: 1 }] }),
      }),
    );
    assertEquals(res.status, 200);
    const payload = (await res.json()) as {
      rejected: Array<{ trialId: string; code: string; message: string }>;
    };
    assertEquals(payload.rejected.length, 1);
    assertEquals(payload.rejected[0].code, "evaluation.trial_write_failed");
    assertEquals(
      payload.rejected[0].message,
      "The trial could not be saved right now. It stays on this device and will retry.",
    );
    assert(!JSON.stringify(payload).includes("row-level security"));
  },
});

Deno.test({
  name: "malformed percent-encoding in a path parameter is a JSON 400, not an uncaught URIError 500",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await bootEdgeFunction();
    resetRest();
    const res = await fetch(
      `${API_BASE}/v1/sessions/%E0%A4%A/finalize`,
      authedInit({ method: "POST", body: "{}" }),
    );
    assertEquals(res.status, 400);
    assertStringIncludes(res.headers.get("content-type") ?? "", "application/json");
    const payload = (await res.json()) as { error: { message: string } };
    assertEquals(payload.error.message, "Malformed path segment.");
  },
});

Deno.test({
  name: "5xx from a DB failure is generic (no internal detail) on the standard path",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await bootEdgeFunction();
    resetRest();
    setRestResponder((req) =>
      req.path === "profiles"
        ? restJson(500, { message: "relation profiles does not exist" })
        : null,
    );
    const res = await fetch(`${API_BASE}/v1/me`, authedInit({ method: "GET" }));
    assertEquals(res.status, 503);
    const body = (await res.json()) as { error: { message: string } };
    assertEquals(body.error.message, "Your account is temporarily unavailable. Please try again.");
    assert(!body.error.message.includes("relation"));
  },
});

Deno.test({
  name: "authenticated user identity flows through to PostgREST as the user's session",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await bootEdgeFunction();
    resetRest();
    const res = await fetch(
      `${API_BASE}/v1/me/consent/status`,
      authedInit({ method: "GET" }, fakeGoogleIdToken("another-subject")),
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();
    const consent = recorded.find((r) => r.path === "consent_records");
    assert(consent);
    assertEquals(consent.headers.get("authorization"), "Bearer fake-session-access-token");
    assertEquals(consent.query.get("user_id"), `eq.${USER_ID}`);
  },
});
