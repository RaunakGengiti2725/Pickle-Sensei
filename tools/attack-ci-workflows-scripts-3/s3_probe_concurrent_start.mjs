#!/usr/bin/env node
// S3 — two `local_api_probe.mjs --start` runs racing for the same port.
//
// The probe's "is something already there?" guard is a 1.5 s /v1/health poll
// (waitForHealth(1_500)) taken BEFORE it spawns the API, and the API itself
// needs several seconds (pnpm → tsx → Fastify) to bind. Two probes launched
// together therefore both pass the guard, both spawn an API, exactly one API
// wins the bind (the other exits 1 on EADDRINUSE — services/api/src/server.ts),
// and BOTH probes then see /v1/health answer and run their probes against the
// single surviving instance. The probe never checks that its OWN child is the
// one answering.
//
// Expected (scenario text): the loser reports verdict UNAVAILABLE, exit 2.
// Checks:
//   A. default (per-process random DEV_AUTH_SECRET): loser's bearer is signed
//      with the wrong secret → it reports FAIL/exit 1 blaming the API
//      (auth.invalid_token where auth.no_account was expected) instead of
//      UNAVAILABLE.
//   B. shared DEV_AUTH_SECRET (as a dev would export in .env): loser PASSES
//      (exit 0) against the winner's instance although its own API never
//      started — and can be torn down mid-flight when the winner exits.
//   C. deterministic: the probe's API child is slowed by a `pnpm` PATH shim
//      (sleep 4 s, then the real pnpm — a cold tsx cache / loaded CI box), and
//      a decoy HTTP server binds the port 2.5 s after the probe starts (after
//      the guard, before the real API is up). The child dies on EADDRINUSE;
//      the probe runs its whole matrix against the decoy and reports the
//      decoy's answers as the API's.
//
// Uses an alternative port (ATTACK_PORT, default 3102) so a developer's real
// :3001 API is never touched. Exits 0 only if every check HELD.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const scenario = "s3_probe_concurrent_start";
const out = path.join(
  process.env.ATTACK_ARTIFACTS ?? path.join(repoRoot, "artifacts/attack-ci-workflows-scripts-3"),
  scenario,
);
mkdirSync(out, { recursive: true });
const port = Number(process.env.ATTACK_PORT ?? 3102);
const baseUrl = `http://127.0.0.1:${port}`;
const probe = path.join(repoRoot, "tools/diagnostics/local_api_probe.mjs");

const results = [];
let held = 0;
let broken = 0;
const record = (status, id, code, artifact, summary) => {
  results.push(`${status}|${id}|exit=${code}|${artifact}|${summary}`);
  if (status === "HELD") held++;
  else broken++;
  console.error(`[${scenario}] ${status}  ${id}  exit=${code}  ${artifact}  — ${summary}`);
};

function runProbe(tag, extraEnv = {}, extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [probe, "--start", "--json", ...extraArgs], {
      cwd: repoRoot,
      env: { ...process.env, API_BASE_URL: baseUrl, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => {
      const file = path.join(out, `${tag}.json`);
      writeFileSync(file, stdout);
      writeFileSync(path.join(out, `${tag}.stderr`), stderr);
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        // non-JSON output is itself reported below
      }
      resolve({ tag, code, json, file });
    });
  });
}

const failCodes = (r) =>
  (r.json?.records ?? [])
    .filter((x) => x.outcome !== "pass")
    .map((x) => `${x.name}:${x.outcome}:${x.status ?? "-"}:${x.error?.code ?? x.reason ?? "-"}`)
    .join(", ");

async function portFree() {
  try {
    await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}

if (!(await portFree())) {
  record(
    "BROKEN",
    "s3.precondition",
    2,
    out,
    `${baseUrl} already answers; pick another ATTACK_PORT`,
  );
  finish();
}

// ---------------------------------------------------------------- check A ----
{
  const [a, b] = await Promise.all([runProbe("A_random_secret_1"), runProbe("A_random_secret_2")]);
  const verdicts = [a, b]
    .map((r) => `${r.tag}:${r.json?.verdict ?? "non-json"}/exit${r.code}`)
    .join(" ");
  const summary = `${verdicts}; non-pass records: [${failCodes(a)}] [${failCodes(b)}]`;
  const oneUnavailable = [a, b].some((r) => r.code === 2 && r.json?.verdict === "UNAVAILABLE");
  const onePass = [a, b].some((r) => r.code === 0);
  if (oneUnavailable && onePass) {
    record(
      "HELD",
      "s3.random_secret_race",
      `${a.code},${b.code}`,
      a.file,
      `loser reported UNAVAILABLE: ${summary}`,
    );
  } else {
    record(
      "BROKEN",
      "s3.random_secret_race",
      `${a.code},${b.code}`,
      a.file,
      `no UNAVAILABLE/exit 2 for the bind loser: ${summary}`,
    );
  }
  await sleep(1000);
}

// ---------------------------------------------------------------- check B ----
{
  const shared = { DEV_AUTH_SECRET: "attack-shared-secret-0123456789abcdef" };
  const [a, b] = await Promise.all([
    runProbe("B_shared_secret_1", shared),
    runProbe("B_shared_secret_2", shared),
  ]);
  const verdicts = [a, b]
    .map((r) => `${r.tag}:${r.json?.verdict ?? "non-json"}/exit${r.code}`)
    .join(" ");
  const summary = `${verdicts}; non-pass records: [${failCodes(a)}] [${failCodes(b)}]`;
  const passes = [a, b].filter((r) => r.code === 0).length;
  const oneUnavailable = [a, b].some((r) => r.code === 2 && r.json?.verdict === "UNAVAILABLE");
  if (passes <= 1 && oneUnavailable) {
    record("HELD", "s3.shared_secret_race", `${a.code},${b.code}`, a.file, summary);
  } else if (passes === 2) {
    record(
      "BROKEN",
      "s3.shared_secret_race",
      `${a.code},${b.code}`,
      a.file,
      `BOTH runs PASS although only one API bound ${port}: ${summary}`,
    );
  } else {
    record(
      "BROKEN",
      "s3.shared_secret_race",
      `${a.code},${b.code}`,
      a.file,
      `bind loser not reported UNAVAILABLE: ${summary}`,
    );
  }
  await sleep(1000);
}

// ---------------------------------------------------------------- check C ----
{
  const decoyLog = [];
  const decoy = createServer((req, res) => {
    decoyLog.push(`${req.method} ${req.url} x-request-id=${req.headers["x-request-id"] ?? "-"}`);
    // Echo nothing useful: an impostor that only knows how to say "ok".
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", version: "decoy", decoy: true }));
  });
  const slowBin = path.join(out, "slowbin");
  mkdirSync(slowBin, { recursive: true });
  const realPnpm = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((d) => path.join(d, "pnpm"))
    .find((p) => {
      try {
        return p !== path.join(slowBin, "pnpm") && statSync(p).isFile();
      } catch {
        return false;
      }
    });
  writeFileSync(
    path.join(slowBin, "pnpm"),
    `#!/usr/bin/env bash\n# slow-start simulation for s3 check C\nsleep 4\nexec "${realPnpm}" "$@"\n`,
  );
  chmodSync(path.join(slowBin, "pnpm"), 0o755);
  const probeRun = runProbe("C_decoy_late_bind", {
    PATH: `${slowBin}${path.delimiter}${process.env.PATH}`,
  });
  await sleep(2_500); // after the 1.5 s guard, before the (slowed) API can bind
  let decoyBound = true;
  await new Promise((resolve) => {
    decoy.once("error", () => {
      decoyBound = false;
      resolve();
    });
    decoy.listen(port, "127.0.0.1", resolve);
  });
  const r = await probeRun;
  if (decoyBound) decoy.close();
  writeFileSync(path.join(out, "C_decoy_requests.log"), decoyLog.join("\n") + "\n");
  const answeredByDecoy = decoyLog.length;
  const summary =
    `decoyBound=${decoyBound} verdict=${r.json?.verdict ?? "non-json"} exit=${r.code}; decoy answered ${answeredByDecoy} requests; ` +
    `apiLogLinesWithOurRequestIds=${r.json?.apiLogLinesWithOurRequestIds}`;
  if (!decoyBound) {
    record(
      "BROKEN",
      "s3.decoy_late_bind",
      r.code,
      r.file,
      `harness race lost (API bound first) — inconclusive: ${summary}`,
    );
  } else if (r.code === 2 && r.json?.verdict === "UNAVAILABLE" && answeredByDecoy <= 5) {
    record("HELD", "s3.decoy_late_bind", r.code, r.file, summary);
  } else {
    record(
      "BROKEN",
      "s3.decoy_late_bind",
      r.code,
      r.file,
      `probe's own API child died on EADDRINUSE but the matrix ran against the decoy — ${summary}`,
    );
  }
}

finish();

function finish() {
  const lines = [
    `scenario: ${scenario}`,
    `port: ${port}`,
    `held: ${held}`,
    `broken: ${broken}`,
    ...results,
  ];
  writeFileSync(path.join(out, "verdict.txt"), lines.join("\n") + "\n");
  console.error(lines.join("\n"));
  console.error(
    `[${scenario}] VERDICT: ${broken ? `BROKEN (${broken} check(s) failed, ${held} held)` : `HELD (${held} check(s))`}`,
  );
  process.exit(broken ? 1 : 0);
}
