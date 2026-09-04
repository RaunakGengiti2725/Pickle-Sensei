#!/usr/bin/env node
/**
 * Negative controls for the secret gate (`scripts/security-scan.sh` + `.gitleaks.toml`).
 *
 * Each case plants a SYNTHETIC token (generated at runtime — nothing secret-shaped
 * is stored in this file) inside a throwaway clone of the current checkout and
 * asserts that the gate FAILS (exit 1). A control case proves the harness itself
 * detects the same token in an ordinary path, so a passing gate on the other cases
 * is a real blind spot, not a broken probe.
 *
 * Run:  node --test tools/security-audit/security_scan_gate.test.mjs
 * Env:  SECURITY_AUDIT_KEEP=1 keeps the scratch clone for inspection.
 *
 * Cost: one `git clone` of the local checkout plus one gitleaks run per case
 * (~5–40 s each on the full history). Requires git and the pinned gitleaks (the
 * script downloads it to $SECURITY_SCAN_CACHE / ~/.cache/pickle-sensei).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCAN = "scripts/security-scan.sh";

// Default gitleaks rules that every case relies on: `github-pat` (ghp_ + 36 chars)
// and the repo's own `supabase-secret-api-key` (sb_secret_ + 20+ chars).
const alnum = (n) =>
  randomBytes(n * 2)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, n);
const token = () => `ghp_${alnum(36)}`;
const sbSecret = () => `sb_secret_${alnum(32)}`;

let scratch;
let head;

function git(args, cwd = scratch) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed:\n${r.stderr}`);
  return r.stdout.trim();
}

const localBranches = () =>
  git(["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean);

/** Throwaway scratch clone only — never runs against the real checkout. */
function resetScratch() {
  git(["checkout", "-q", "--detach", head]);
  git(["reset", "-q", "--hard", head]);
  git(["clean", "-qfdx"]);
  for (const b of localBranches()) git(["branch", "-q", "-D", b]);
}

function plant(relPath, contents) {
  const abs = join(scratch, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
  return abs;
}

function commitAll(message = "probe") {
  git(["add", "-A", "-f", "."]);
  git([
    "-c",
    "user.name=security-audit",
    "-c",
    "user.email=security-audit@example.invalid",
    "commit",
    "-q",
    "-m",
    message,
  ]);
}

/** Run the gate; returns { status, log }. */
function scan(args, env = {}) {
  const r = spawnSync(SCAN, args, {
    cwd: scratch,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 10 * 60 * 1000,
  });
  return { status: r.status, log: `${r.stdout}\n${r.stderr}` };
}

const tree = (env) => scan(["--tree"], env).status;
const historyOfHead = () => scan(["--history", "--log-opts", "HEAD"]).status;

before(() => {
  head = git(["rev-parse", "HEAD"], repoRoot);
  scratch = mkdtempSync(join(tmpdir(), "security-scan-gate-"));
  // Local clone: only HEAD's history, no remote-tracking refs, so history scans
  // start from a known-clean baseline (the tree at HEAD passes the gate in CI).
  git(["clone", "-q", "--no-hardlinks", repoRoot, scratch], repoRoot);
  git(["checkout", "-q", "--detach", head]);
  git(["remote", "remove", "origin"]);
  for (const b of localBranches()) git(["branch", "-q", "-D", b]);
  git(["gc", "-q", "--prune=now"]);
});

after(() => {
  if (process.env.SECURITY_AUDIT_KEEP === "1") {
    console.log(`scratch clone kept at ${scratch}`);
    return;
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe("secret gate — controls", () => {
  it("baseline: the checkout itself passes the tree scan and its own history", () => {
    resetScratch();
    assert.equal(tree(), 0, "tree scan of the clean checkout must pass");
    assert.equal(historyOfHead(), 0, "history of HEAD must pass");
  });

  it("control: a planted token in an ordinary untracked file fails the tree scan", () => {
    resetScratch();
    plant("probe.txt", `token=${token()}\nkey=${sbSecret()}\n`);
    assert.equal(tree(), 1);
  });

  it("control: a planted token in an ordinary committed file fails the history scan", () => {
    resetScratch();
    plant("buildx/leak.txt", `token=${token()}\n`);
    commitAll();
    assert.equal(historyOfHead(), 1);
    assert.equal(tree(), 1);
  });
});

describe("secret gate — path allowlists must not hide real credentials", () => {
  it("a root .env holding a token is caught by the tree scan", () => {
    resetScratch();
    plant(".env", `GITHUB_TOKEN=${token()}\nSUPABASE_KEY=${sbSecret()}\n`);
    assert.equal(tree(), 1, ".gitleaks.toml:20 allowlists .env for the tree scan");
  });

  it("a force-added .env is caught by the history scan", () => {
    resetScratch();
    plant(".env", `GITHUB_TOKEN=${token()}\n`);
    commitAll("oops: committed .env");
    assert.equal(historyOfHead(), 1, ".gitleaks.toml:20 allowlists .env for history too");
  });

  it("a force-added apps/mobile/.env.local is caught by the history scan", () => {
    resetScratch();
    plant("apps/mobile/.env.local", `TOKEN=${token()}\n`);
    commitAll();
    assert.equal(historyOfHead(), 1);
  });

  it("a committed build/ directory is scanned (root build/ is not even gitignored)", () => {
    resetScratch();
    plant("build/leak.txt", `token=${token()}\n`);
    commitAll();
    assert.equal(historyOfHead(), 1, ".gitleaks.toml:43 unanchored (?:^|/)build/");
    assert.equal(tree(), 1);
  });

  it("a committed dist/ file anywhere in the tree is scanned", () => {
    resetScratch();
    plant("packages/foo/dist/index.js", `const t = "${token()}";\n`);
    commitAll();
    assert.equal(historyOfHead(), 1, ".gitleaks.toml:44 unanchored (?:^|/)dist/");
  });

  it("a committed coverage/ file is scanned", () => {
    resetScratch();
    plant("coverage/lcov-report/x.html", `${token()}\n`);
    commitAll();
    assert.equal(historyOfHead(), 1, ".gitleaks.toml:45 unanchored (?:^|/)coverage/");
  });

  it("a committed Podfile.lock-named text file is scanned", () => {
    resetScratch();
    plant("services/Podfile.lock", `token=${token()}\n`);
    commitAll();
    assert.equal(historyOfHead(), 1);
  });
});

describe("secret gate — extension allowlists are extension-only", () => {
  it("a TEXT file named model.pkl holding a token is scanned", () => {
    resetScratch();
    plant("model.pkl", `token=${token()}\n`);
    commitAll();
    assert.equal(historyOfHead(), 1, ".gitleaks.toml:27 skips by extension, not content");
    assert.equal(tree(), 1);
  });

  it("a TEXT file named secrets.task holding a token is scanned", () => {
    resetScratch();
    plant("secrets.task", `token=${token()}\n`);
    commitAll();
    assert.equal(historyOfHead(), 1);
  });
});

describe("secret gate — scanner binary trust", () => {
  it("GITLEAKS_BIN pointing at a non-gitleaks executable is refused (exit 2), not run", () => {
    resetScratch();
    plant("probe.txt", `token=${token()}\n`);
    const r = scan(["--tree"], { GITLEAKS_BIN: "/bin/true" });
    assert.notEqual(r.status, 0, `planted token must not PASS; log:\n${r.log}`);
    assert.equal(
      r.status,
      2,
      "a binary that does not report the pinned version is a setup failure",
    );
  });

  it("a cached binary that only echoes the pinned version string is not trusted", () => {
    resetScratch();
    plant("probe.txt", `token=${token()}\n`);
    const cache = mkdtempSync(join(tmpdir(), "security-scan-cache-"));
    const fake = join(cache, "gitleaks-8.30.1", "gitleaks");
    mkdirSync(dirname(fake), { recursive: true });
    writeFileSync(fake, '#!/bin/sh\n[ "$1" = version ] && echo 8.30.1 && exit 0\nexit 0\n');
    chmodSync(fake, 0o755);
    try {
      const r = scan(["--tree"], { SECURITY_SCAN_CACHE: cache });
      assert.notEqual(
        r.status,
        0,
        `planted token must not PASS via a tampered cache; log:\n${r.log}`,
      );
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe("secret gate — history scope", () => {
  it("default history scan is hermetic to HEAD's ancestry (other refs do not fail the gate)", () => {
    resetScratch();
    // A sibling branch (e.g. another agent's remote branch fetched by
    // actions/checkout fetch-depth:0) carries a token; HEAD's history is clean.
    git(["branch", "-q", "-f", "sibling", head]);
    git(["checkout", "-q", "sibling"]);
    plant("leak.txt", `token=${token()}\n`);
    commitAll("sibling branch commit");
    git(["checkout", "-q", "--detach", head]);
    assert.equal(historyOfHead(), 0, "--log-opts HEAD must stay clean (sanity)");
    const r = scan(["--history"]);
    assert.equal(
      r.status,
      0,
      `the default history scan (no --log-opts) walks every ref, so an unrelated branch fails HEAD's gate; log:\n${r.log}`,
    );
  });
});
