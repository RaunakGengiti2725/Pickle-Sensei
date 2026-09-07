import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const PRODUCTION_API_URL = "https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api";
export const INVALID_BEARER = "launch-monitor-deliberately-invalid-not-a-jwt";
export const PROBE_TIMEOUT_MS = 8_000;
export const MAX_BODY_BYTES = 65_536;

const publicChecks = [
  { name: "liveness_get", path: "/healthz", method: "GET", kind: "liveness" },
  { name: "liveness_head", path: "/healthz", method: "HEAD", kind: "liveness" },
  ...[
    ["support", "PICKLE SENSEI SUPPORT"],
    ["privacy", "PICKLE SENSEI — PRIVACY POLICY"],
    ["terms", "PICKLE SENSEI — TERMS OF USE"],
  ].flatMap(([page, heading]) =>
    ["GET", "HEAD"].map((method) => ({
      name: `${page}_${method.toLowerCase()}`,
      path: `/${page}`,
      method,
      kind: "legal",
      heading,
    })),
  ),
  { name: "invalid_bearer_rejected", path: "/v1/me", method: "GET", kind: "auth" },
];

class ProbeFailure extends Error {}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function validateBody(check, text) {
  if (check.method === "HEAD") {
    if (text !== "") throw new ProbeFailure("unexpected_head_body");
    return;
  }
  if (check.kind === "legal") {
    if (
      text.length < 100 ||
      !text.trimStart().startsWith(check.heading) ||
      !text.includes("Last updated:")
    ) {
      throw new ProbeFailure("invalid_legal_document");
    }
    return;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ProbeFailure("invalid_json");
  }
  if (check.kind === "readiness") {
    if (!isRecord(body?.readiness) || body.readiness.database !== true) {
      throw new ProbeFailure("database_readiness_not_verified");
    }
  }
  if (check.kind === "auth") {
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => key !== "error") ||
      !isRecord(body.error) ||
      Object.keys(body.error).some((key) => key !== "message" && key !== "code") ||
      typeof body.error.message !== "string" ||
      !body.error.message.trim() ||
      body.error.message.length > 512 ||
      (body.error.code !== undefined &&
        (typeof body.error.code !== "string" || body.error.code.length > 128))
    ) {
      throw new ProbeFailure("invalid_auth_rejection");
    }
  } else if (!isRecord(body) || body.ok !== true) {
    throw new ProbeFailure("invalid_health_response");
  }
}

async function probe(check, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  let response;
  let reader;
  let timer;
  let timedOut = false;
  let status = null;
  const cancel = () => {
    controller.abort();
    void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {});
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      cancel();
      reject(new ProbeFailure("timeout"));
    }, timeoutMs);
  });
  const request = (async () => {
    response = await fetchImpl(`${PRODUCTION_API_URL}${check.path}`, {
      method: check.method,
      headers: {
        Accept: check.kind === "legal" ? "text/plain" : "application/json",
        "User-Agent": "Pickle-Sensei-Production-Monitor/1",
        ...(check.kind === "auth" ? { Authorization: `Bearer ${INVALID_BEARER}` } : {}),
      },
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw new ProbeFailure("timeout");
    }
    status = response.status;
    if (response.redirected || (status >= 300 && status < 400)) {
      throw new ProbeFailure("redirect");
    }
    if (status !== (check.kind === "auth" ? 401 : 200)) {
      throw new ProbeFailure("unexpected_status");
    }
    const mediaType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (mediaType !== (check.kind === "legal" ? "text/plain" : "application/json")) {
      throw new ProbeFailure("unexpected_content_type");
    }
    if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES) {
      throw new ProbeFailure("body_too_large");
    }
    const bytes = new Uint8Array(MAX_BODY_BYTES);
    let size = 0;
    reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (size + chunk.value.byteLength > MAX_BODY_BYTES) {
          throw new ProbeFailure("body_too_large");
        }
        bytes.set(chunk.value, size);
        size += chunk.value.byteLength;
      }
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
    } catch {
      throw new ProbeFailure("invalid_encoding");
    }
    validateBody(check, text);
  })();
  try {
    await Promise.race([request, deadline]);
    return {
      check: check.name,
      outcome: check.kind === "readiness" ? "VERIFIED" : "PASS",
      status,
      detail: "expected_response",
    };
  } catch (error) {
    return {
      check: check.name,
      outcome: "FAIL",
      status,
      detail: timedOut
        ? "timeout"
        : error instanceof ProbeFailure
          ? error.message
          : "network_error",
    };
  } finally {
    clearTimeout(timer);
    cancel();
    reader?.releaseLock();
  }
}

export function readinessEnabled(value) {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new ProbeFailure("invalid_readiness_setting");
}

export async function runMonitor({
  fetchImpl = globalThis.fetch,
  readiness = false,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  if (
    typeof readiness !== "boolean" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > PROBE_TIMEOUT_MS
  ) {
    throw new ProbeFailure("invalid_monitor_configuration");
  }
  const checks = [];
  for (const check of publicChecks) {
    checks.push(await probe(check, fetchImpl, timeoutMs));
  }
  checks.push(
    readiness
      ? await probe(
          {
            name: "database_readiness",
            path: "/healthz?readiness=1",
            method: "GET",
            kind: "readiness",
          },
          fetchImpl,
          timeoutMs,
        )
      : {
          check: "database_readiness",
          outcome: "UNVERIFIED",
          status: null,
          detail: "disabled_until_coordinated_backend_deploy",
        },
  );
  return { failed: checks.some((check) => check.outcome === "FAIL"), checks };
}

export function formatReport(report) {
  return [
    "# Production monitor",
    "",
    "| Check | Result | HTTP | Detail |",
    "| --- | --- | --- | --- |",
    ...report.checks.map(
      ({ check, outcome, status, detail }) =>
        `| ${check} | ${outcome} | ${status ?? "—"} | ${detail} |`,
    ),
    "",
    "Public probes only; not proof of working sign-in, sessions, billing, camera or crash-free users.",
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runMonitor({
      readiness: readinessEnabled(process.env.PRODUCTION_MONITOR_READINESS),
    });
    const summary = formatReport(report);
    process.stdout.write(summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    }
    process.exitCode = report.failed ? 1 : 0;
  } catch {
    process.stderr.write("Production monitor failed: configuration or runner error.\n");
    process.exitCode = 1;
  }
}
