import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  formatReport,
  INVALID_BEARER,
  MAX_BODY_BYTES,
  PROBE_TIMEOUT_MS,
  PRODUCTION_API_URL,
  readinessEnabled,
  runMonitor,
} from "../monitor-production.mjs";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const headings = {
  "/support": "PICKLE SENSEI SUPPORT",
  "/privacy": "PICKLE SENSEI — PRIVACY POLICY",
  "/terms": "PICKLE SENSEI — TERMS OF USE",
};

function stub(override = () => undefined) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.ok(url.startsWith(`${PRODUCTION_API_URL}/`));
    const path = url.slice(PRODUCTION_API_URL.length);
    calls.push({ path, ...init });
    const custom = override(path, init, calls.length - 1);
    if (custom !== undefined) return custom;
    const legal = headings[path];
    if (init.method === "HEAD") {
      return new Response(null, {
        headers: { "content-type": legal ? "text/plain; charset=utf-8" : "application/json" },
      });
    }
    if (legal) {
      return new Response(
        `${legal}\nLast updated: September 3, 2026\n${"Public text. ".repeat(20)}`,
        {
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }
    if (path === "/v1/me") return json({ error: { message: "Invalid bearer token." } }, 401);
    if (path === "/healthz?readiness=1") {
      return json({ ok: true, readiness: { database: true } });
    }
    return json({ ok: true });
  };
  return { calls, fetchImpl };
}

async function fails(override, detail, check = "liveness_get", options = {}) {
  const h = stub(override);
  const report = await runMonitor({ fetchImpl: h.fetchImpl, ...options });
  assert.equal(report.failed, true);
  assert.equal(report.checks.find((entry) => entry.check === check)?.outcome, "FAIL");
  assert.equal(report.checks.find((entry) => entry.check === check)?.detail, detail);
  return { ...h, report };
}

test("baseline liveness, legal GET/HEAD and invalid bearer pass without claiming database readiness", async () => {
  const h = stub();
  const report = await runMonitor({ fetchImpl: h.fetchImpl });
  assert.equal(report.failed, false);
  assert.equal(h.calls.length, 9);
  assert.equal(report.checks.filter((entry) => entry.outcome === "PASS").length, 9);
  assert.deepEqual(report.checks.at(-1), {
    check: "database_readiness",
    outcome: "UNVERIFIED",
    status: null,
    detail: "disabled_until_coordinated_backend_deploy",
  });
  for (const call of h.calls) {
    assert.ok(["GET", "HEAD"].includes(call.method));
    assert.equal(call.redirect, "manual");
    assert.equal(call.credentials, "omit");
    assert.equal(call.cache, "no-store");
    assert.equal(call.signal.aborted, true);
    assert.equal(call.body, undefined);
    assert.equal(call.headers.apikey, undefined);
    assert.equal(call.headers.Cookie, undefined);
    assert.equal(call.path.includes("bootstrap"), false);
    assert.equal(call.path.includes("?"), false);
    assert.equal(
      call.headers.Authorization,
      call.path === "/v1/me" ? `Bearer ${INVALID_BEARER}` : undefined,
    );
  }
  assert.equal(INVALID_BEARER.includes("."), false);
  const summary = formatReport(report);
  assert.match(summary, /database_readiness \| UNVERIFIED/);
  assert.doesNotMatch(summary, /VERIFIED \| 200|https:|Bearer|Last updated:|Invalid bearer token/);
});

test("explicit database readiness is required, and only the opt-in makes the tenth request", async () => {
  const h = stub();
  const report = await runMonitor({ fetchImpl: h.fetchImpl, readiness: true });
  assert.equal(report.failed, false);
  assert.equal(h.calls.length, 10);
  assert.equal(h.calls.at(-1).path, "/healthz?readiness=1");
  assert.equal(report.checks.at(-1).outcome, "VERIFIED");
  const off = stub((path, init) =>
    path === "/healthz" && init.method === "GET"
      ? json({ ok: true, readiness: { database: true } })
      : undefined,
  );
  assert.equal(
    (await runMonitor({ fetchImpl: off.fetchImpl })).checks.at(-1).outcome,
    "UNVERIFIED",
  );
});

test("static ok, missing, false and malformed readiness never masquerade as verified", async (t) => {
  for (const body of [
    { ok: true },
    { ok: true, readiness: true },
    { ok: true, readiness: { database: false } },
    { ok: true, readiness: { database: "true" } },
    { ok: true, readiness: { database: null } },
    { ok: false, readiness: { database: true } },
  ]) {
    await t.test(JSON.stringify(body), async () => {
      await fails(
        (path) => (path === "/healthz?readiness=1" ? json(body) : undefined),
        body.ok ? "database_readiness_not_verified" : "invalid_health_response",
        "database_readiness",
        { readiness: true },
      );
    });
  }
  await fails(
    (path) => (path === "/healthz?readiness=1" ? json({ ok: false }, 503) : undefined),
    "unexpected_status",
    "database_readiness",
    { readiness: true },
  );
});

test("bad status fails every public check, including accidental authentication success", async (t) => {
  const baseline = await runMonitor({ fetchImpl: stub().fetchImpl });
  for (let index = 0; index < 9; index += 1) {
    const name = baseline.checks[index].check;
    await t.test(name, async () => {
      const { calls } = await fails(
        (_path, _init, i) => (i === index ? json({}, i === 8 ? 200 : 503) : undefined),
        "unexpected_status",
        name,
      );
      assert.equal(calls.length, 9);
    });
  }
  for (const status of [401, 403, 404, 429, 500, 502, 503]) {
    await fails((_path, _init, i) => (i === 0 ? json({}, status) : undefined), "unexpected_status");
  }
  for (const status of [403, 429, 503]) {
    await fails(
      (path) => (path === "/v1/me" ? json({ error: { message: "No access" } }, status) : undefined),
      "unexpected_status",
      "invalid_bearer_rejected",
    );
  }
});

test("redirects fail closed without following a location or accepting redirected content", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    await fails(
      (_path, _init, i) =>
        i === 0
          ? new Response("synthetic private redirect detail", {
              status,
              headers: { location: "https://example.invalid/private?token=synthetic" },
            })
          : undefined,
      "redirect",
    );
  }
  const redirected = json({ ok: true });
  Object.defineProperty(redirected, "redirected", { value: true });
  await fails((_path, _init, i) => (i === 0 ? redirected : undefined), "redirect");
});

test("invalid health, legal, auth and HEAD responses fail instead of merely checking status", async () => {
  for (const body of [null, [], {}, { ok: false }, { ok: "true" }]) {
    await fails((_path, _init, i) => (i === 0 ? json(body) : undefined), "invalid_health_response");
  }
  await fails(
    (_path, _init, i) =>
      i === 0
        ? new Response("not-json", { headers: { "content-type": "application/json" } })
        : undefined,
    "invalid_json",
  );
  for (const type of ["text/html", "text/plain", ""]) {
    await fails(
      (_path, _init, i) =>
        i === 0 ? new Response('{"ok":true}', { headers: { "content-type": type } }) : undefined,
      "unexpected_content_type",
    );
  }
  await fails(
    (_path, _init, i) => (i === 1 ? json({ ok: true }) : undefined),
    "unexpected_head_body",
    "liveness_head",
  );
  for (const page of Object.keys(headings)) {
    await fails(
      (path, init) =>
        path === page && init.method === "GET"
          ? new Response("Generic gateway page", { headers: { "content-type": "text/plain" } })
          : undefined,
      "invalid_legal_document",
      `${page.slice(1)}_get`,
    );
  }
  for (const body of [
    {},
    { error: "no access" },
    { error: { message: "" } },
    { error: { message: "no access", accessToken: "synthetic" } },
    { error: { message: "no access" }, session: {} },
    { error: { message: "no access" }, user: {} },
    { error: { message: "no access", code: [] } },
  ]) {
    await fails(
      (path) => (path === "/v1/me" ? json(body, 401) : undefined),
      "invalid_auth_rejection",
      "invalid_bearer_rejected",
    );
  }
});

test("advertised and streamed oversized bodies are cancelled at a fixed byte bound", async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        if (!declared) controller.enqueue(new Uint8Array(MAX_BODY_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    await fails(
      (_path, _init, i) =>
        i === 0
          ? new Response(body, {
              headers: {
                "content-type": "application/json",
                ...(declared ? { "content-length": String(MAX_BODY_BYTES + 1) } : {}),
              },
            })
          : undefined,
      "body_too_large",
    );
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  }
  await fails(
    (_path, _init, i) =>
      i === 0
        ? new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } })
        : undefined,
    "invalid_encoding",
  );
});

test(
  "fetch and whole-body stalls time out even when cancellation never settles",
  { timeout: 3_000 },
  async () => {
    await fails(
      (_path, _init, i) => (i === 0 ? new Promise(() => {}) : undefined),
      "timeout",
      "liveness_get",
      { timeoutMs: 20 },
    );
    await fails(
      (_path, init, i) =>
        i === 0
          ? new Promise((_, reject) => {
              init.signal.addEventListener(
                "abort",
                () => reject(new Error("synthetic abort detail")),
                { once: true },
              );
            })
          : undefined,
      "timeout",
      "liveness_get",
      { timeoutMs: 20 },
    );
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":true}'));
      },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    });
    await fails(
      (_path, _init, i) =>
        i === 0
          ? new Response(body, { headers: { "content-type": "application/json" } })
          : undefined,
      "timeout",
      "liveness_get",
      { timeoutMs: 20 },
    );
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  },
);

test("a fetch completing after its deadline has its body cancelled and cannot change the verdict", async () => {
  let finish;
  let cancelled = false;
  const late = new Promise((resolve) => (finish = resolve));
  const { report } = await fails(
    (_path, _init, i) => (i === 0 ? late : undefined),
    "timeout",
    "liveness_get",
    { timeoutMs: 20 },
  );
  finish(
    new Response(new ReadableStream({ cancel: () => (cancelled = true) }), {
      headers: { "content-type": "application/json" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(report.checks[0].outcome, "FAIL");
});

test("transport failures and malformed bodies produce categorical reports, not input or errors", async () => {
  const canary = "synthetic-private-input@example.invalid?token=synthetic-private-token";
  const { report } = await fails(() => {
    throw new Error(canary);
  }, "network_error");
  assert.equal(report.checks.filter((entry) => entry.outcome === "FAIL").length, 9);
  assert.doesNotMatch(formatReport(report), /synthetic-private|example.invalid/);
  const invalid = await fails(
    (_path, _init, i) =>
      i === 0
        ? new Response(canary, { headers: { "content-type": "application/json" } })
        : undefined,
    "invalid_json",
  );
  assert.equal(formatReport(invalid.report).includes(canary), false);
});

test("readiness opt-in and request limits reject ambiguous or unbounded configuration", async () => {
  for (const value of [undefined, "", "false"]) assert.equal(readinessEnabled(value), false);
  assert.equal(readinessEnabled("true"), true);
  for (const value of [null, "TRUE", "yes", "1", "0"]) {
    assert.throws(() => readinessEnabled(value));
  }
  for (const timeoutMs of [0, -1, Infinity, NaN, PROBE_TIMEOUT_MS + 1]) {
    await assert.rejects(runMonitor({ timeoutMs, fetchImpl: stub().fetchImpl }));
  }
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../monitor-production.mjs", import.meta.url))],
    {
      env: { ...process.env, PRODUCTION_MONITOR_READINESS: "invalid", GITHUB_STEP_SUMMARY: "" },
      encoding: "utf8",
      timeout: 2_000,
    },
  );
  assert.equal(child.status, 1);
  assert.match(child.stderr, /configuration or runner error/);
});

test("workflow runs only trusted main on hosted Ubuntu with read-only permissions and no secrets", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/production-monitor.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /timeout-minutes: 5/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /actions\/checkout@v7/);
  assert.match(workflow, /actions\/setup-node@v7/);
  assert.match(workflow, /vars.PRODUCTION_MONITOR_READINESS \|\| 'false'/);
  assert.match(workflow, /node --test scripts\/tests\/monitor-production.test.mjs/);
  assert.doesNotMatch(workflow, /pull_request|push:|self-hosted|secrets\.|: write/);
});
