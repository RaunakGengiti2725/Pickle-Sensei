// Shared helpers for the H04-01 adversarial suite (node:test, built-ins only).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const MOBILE_DIR = path.join(REPO_ROOT, "apps/mobile");
export const DOC_PATH = path.join(REPO_ROOT, "docs/security/ADVISORIES_2026-09-08.md");
export const ARTIFACT_DIR = path.join(REPO_ROOT, "artifacts/adversarial/h04-01");

export const DOC_GHSA_IDS = ["GHSA-w3rx-r6r6-pgpr", "GHSA-5p2g-fcmc-qvqq", "GHSA-vcc3-ghjq-m6fr"];

export function readDoc() {
  return fs.readFileSync(DOC_PATH, "utf8");
}

export function ensureArtifactDir() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  return ARTIFACT_DIR;
}

export function writeArtifact(name, content) {
  ensureArtifactDir();
  const file = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return file;
}

/** Run a command, never throw; returns {status, stdout, stderr}. */
export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: 256 * 1024 * 1024,
    shell: opts.shell ?? false,
    timeout: opts.timeout ?? 600_000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error,
  };
}

export function runShell(script, opts = {}) {
  return run("bash", ["-lc", script], opts);
}

export function npmView(spec, field) {
  const res = run("npm", ["view", spec, field, "--json"], { timeout: 120_000 });
  if (res.status !== 0) throw new Error(`npm view ${spec} ${field} failed: ${res.stderr}`);
  return res.stdout.trim() ? JSON.parse(res.stdout) : null;
}

/** GHSA ids referenced by an `npm audit --json` report (same extraction the doc's §8.2 uses). */
export function ghsaIdsFromNpmAudit(report) {
  const ids = new Set();
  for (const v of Object.values(report.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (via && typeof via === "object" && via.url) {
        const m = String(via.url).match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/);
        if (m) ids.add(m[0]);
      }
    }
  }
  return ids;
}

/**
 * Extracts the §8.2 acceptance check (the `node -e '…'` program) verbatim from the doc's
 * fenced ```sh block so tests exercise exactly what the candidate documented.
 */
export function extractDispositionCheckScript(doc = readDoc()) {
  const fence = doc.match(/```sh\n([\s\S]*?)\n```/);
  if (!fence) throw new Error("no ```sh fence in the doc");
  const block = fence[1];
  const start = block.indexOf("node -e '");
  if (start < 0) throw new Error("no node -e in the §8.2 block");
  const body = block.slice(start + "node -e '".length);
  const end = body.lastIndexOf("'");
  return { manifestCommand: block.slice(0, start).trim(), nodeScript: body.slice(0, end) };
}

/**
 * Runs the extracted §8.2 node program inside a throwaway directory that mimics the repo
 * layout it hard-codes (artifacts/advisories/*.json + docs/security/ADVISORIES_2026-09-08.md).
 */
export function runDispositionCheck({ mobile, pnpm, doc }, label) {
  const { nodeScript } = extractDispositionCheckScript();
  const sandbox = fs.mkdtempSync(path.join(ensureArtifactDir(), `disposition-${label}-`));
  fs.mkdirSync(path.join(sandbox, "artifacts/advisories"), { recursive: true });
  fs.mkdirSync(path.join(sandbox, "docs/security"), { recursive: true });
  fs.writeFileSync(path.join(sandbox, "artifacts/advisories/mobile.json"), JSON.stringify(mobile));
  fs.writeFileSync(path.join(sandbox, "artifacts/advisories/pnpm.json"), JSON.stringify(pnpm));
  fs.writeFileSync(path.join(sandbox, "docs/security/ADVISORIES_2026-09-08.md"), doc ?? readDoc());
  const res = run("node", ["-e", nodeScript], { cwd: sandbox, timeout: 60_000 });
  return { ...res, sandbox };
}

/** Minimal well-formed `npm audit --json` report with the given vulnerabilities map. */
export function npmAuditReport(vulnerabilities, counts) {
  const total = Object.keys(vulnerabilities).length;
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: counts?.moderate ?? total,
        high: counts?.high ?? 0,
        critical: 0,
        total,
      },
      dependencies: { prod: 1, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 1 },
    },
  };
}

/** Minimal well-formed `pnpm audit --json` report (npm v6 audit shape pnpm emits). */
export function pnpmAuditReport(advisories) {
  const sev = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const a of Object.values(advisories)) sev[a.severity] = (sev[a.severity] ?? 0) + 1;
  return {
    actions: [],
    advisories,
    muted: [],
    metadata: {
      vulnerabilities: sev,
      dependencies: 1,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 1,
    },
  };
}

export const EMPTY_PNPM_REPORT = pnpmAuditReport({});
