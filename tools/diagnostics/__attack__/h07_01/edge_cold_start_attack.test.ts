// H07-01 adversarial tests (no Docker / no local stack needed).
//
//   deno test -A tools/diagnostics/__attack__/h07_01/edge_cold_start_attack.test.ts
//
// Each test encodes the behaviour the candidate claims (header comment of
// tools/diagnostics/edge_cold_start.ts and docs/OBSERVABILITY.md §H07-COLD-START);
// a failing test is a confirmed break of that claim at the attacked sha.
// Importing the candidate module also registers its own 20 self-tests in this
// run; the attack tests are the ones whose names start with "attack:".

import { join } from "node:path";
import { assert, assertEquals, assertNotEquals } from "./assert.ts";
import { measureBundle, readApiPort } from "../../edge_cold_start.ts";
import {
  CANDIDATE_SCRIPT,
  exec,
  makeRepoCopy,
  pathExists,
  pathWith,
  readReport,
  runCandidate,
  scratchDir,
  writeShims,
} from "./harness.ts";

const DOCKERLESS_SHIMS = {
  docker: 'echo "Cannot connect to the Docker daemon (attack shim)" >&2; exit 1',
};

// ---------------------------------------------------------------------------
// Attack 1 — checkout-path variation: a symlinked checkout at another depth.
// Claim (header lines 11-14): raw bytes / sha256 "are the same on every checkout
// path". Developers routinely keep repos behind a symlink (~/src → /mnt/…).
// ---------------------------------------------------------------------------
Deno.test(
  "attack: bundle identity survives a symlinked checkout at a different depth",
  async () => {
    const root = await scratchDir("symlink");
    try {
      const real = join(root, "real");
      await makeRepoCopy(real);
      const linkParent = join(root, "a", "b", "c", "d");
      await Deno.mkdir(linkParent, { recursive: true });
      const link = join(linkParent, "checkout");
      await Deno.symlink(real, link);

      const viaReal = await measureBundle(real, join(root, "out-real", "index.js"));
      const viaLink = await measureBundle(link, join(root, "out-link", "index.js"));

      assertEquals(viaLink.pathNormalization.unresolved, 0, "no unresolved labels via symlink");
      assertEquals(viaLink.sha256, viaReal.sha256, "sha256 identical via symlink");
      assertEquals(viaLink.rawBytes, viaReal.rawBytes, "raw bytes identical via symlink");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Attack 2 — checkout-path variation: $DENO_DIR reached through a symlink.
// `deno info` reports the configured DENO_DIR verbatim while the bundler labels
// modules with the resolved real path, so the rewrite needle never matches.
// ---------------------------------------------------------------------------
Deno.test("attack: bundle identity survives DENO_DIR pointing through a symlink", async () => {
  const root = await scratchDir("denodir");
  const previous = Deno.env.get("DENO_DIR");
  try {
    const real = join(root, "real");
    await makeRepoCopy(real);
    const info = await exec(Deno.execPath(), ["info", "--json"], { cwd: real });
    const denoDir = (JSON.parse(info.stdout) as { denoDir: string }).denoDir;
    const link = join(root, "deno-cache-link");
    await Deno.symlink(denoDir, link);

    const direct = await measureBundle(real, join(root, "out-direct", "index.js"));
    Deno.env.set("DENO_DIR", link);
    const viaLink = await measureBundle(real, join(root, "out-link", "index.js"));

    assertEquals(
      viaLink.pathNormalization.unresolved,
      0,
      "no unresolved labels via DENO_DIR symlink",
    );
    assertEquals(viaLink.sha256, direct.sha256, "sha256 identical via DENO_DIR symlink");
  } finally {
    if (previous === undefined) {
      Deno.env.delete("DENO_DIR");
    } else {
      Deno.env.set("DENO_DIR", previous);
    }
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Attack 3 — corrupt/partial provenance: a dirty working tree.
// The report attributes the bundle to `gitHead` only. Two runs on the same HEAD
// with different sources produce different sha256 values but indistinguishable
// provenance, so docs/OBSERVABILITY.md's "sources at <sha>" cannot be trusted.
// ---------------------------------------------------------------------------
Deno.test(
  "attack: report provenance distinguishes a dirty tree from the recorded HEAD",
  async () => {
    const root = await scratchDir("dirty");
    try {
      const repo = join(root, "repo");
      await makeRepoCopy(repo);
      const shims = join(root, "bin");
      await writeShims(shims, DOCKERLESS_SHIMS);
      const env = { PATH: pathWith(shims) };

      const clean = await runCandidate(repo, ["--out", join(root, "out-clean")], { env });
      assertEquals(clean.code, 1, `clean run exits 1 without docker\n${clean.stdout}`);
      const cleanReport = await readReport(join(root, "out-clean"));
      assert(cleanReport.bundle !== null, "clean run measured the bundle");

      const entry = join(repo, "supabase", "functions", "api", "index.ts");
      await Deno.writeTextFile(
        entry,
        `${await Deno.readTextFile(entry)}\nexport const attackMarker = 1;\n`,
      );
      const status = await exec("git", ["status", "--porcelain"], { cwd: repo });
      assert(status.stdout.includes("index.ts"), "tree is dirty");

      const dirty = await runCandidate(repo, ["--out", join(root, "out-dirty")], { env });
      assertEquals(dirty.code, 1, `dirty run exits 1 without docker\n${dirty.stdout}`);
      const dirtyReport = await readReport(join(root, "out-dirty"));
      assert(dirtyReport.bundle !== null, "dirty run measured the bundle");
      assertNotEquals(dirtyReport.bundle.sha256, cleanReport.bundle.sha256, "sources differ");

      const provenance = (report: Record<string, unknown>): string =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(report).filter(
              ([key]) =>
                ![
                  "generatedAt",
                  "updatedAt",
                  "status",
                  "error",
                  "repoRoot",
                  "entrypoint",
                  "environment",
                  "options",
                  "bundle",
                  "sourceGraph",
                  "serve",
                  "ok",
                ].includes(key),
            ),
          ),
        );
      assertNotEquals(
        provenance(dirtyReport as unknown as Record<string, unknown>),
        provenance(cleanReport as unknown as Record<string, unknown>),
        `a report built from a dirty tree must not carry the same provenance as the clean HEAD run: ${provenance(
          dirtyReport as unknown as Record<string, unknown>,
        )}`,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Attack 4 — boundary value: a relative `--out DIR` from a foreign cwd.
// Every other CLI resolves paths against the caller's cwd; the docs show only an
// absolute example. A relative DIR must not silently land inside the checkout.
// ---------------------------------------------------------------------------
Deno.test(
  "attack: relative --out resolves against the caller's cwd, not the checkout",
  async () => {
    const root = await scratchDir("relout");
    try {
      const repo = join(root, "repo");
      await makeRepoCopy(repo);
      const shims = join(root, "bin");
      await writeShims(shims, DOCKERLESS_SHIMS);
      const cwd = join(root, "elsewhere");
      await Deno.mkdir(cwd);

      const result = await runCandidate(repo, ["--out", "rel-out"], {
        cwd,
        env: { PATH: pathWith(shims) },
      });
      assertEquals(result.code, 1, `exits 1 without docker\n${result.stdout}`);
      const inCwd = await pathExists(join(cwd, "rel-out", "report.json"));
      const inRepo = await pathExists(join(repo, "rel-out", "report.json"));
      assert(inCwd, "report written under the caller's cwd");
      assert(!inRepo, "report NOT written into the checkout");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Attack 5 — concurrency: two runs reclaiming the same stale lock.
// RunLock.acquire reads the holder pid, asks `ps`, then remove()+createNew. Two
// processes that both observe the dead holder both remove and both create —
// the second remove deletes the first winner's fresh lock. A `ps` shim that
// answers the second caller later makes the interleaving deterministic.
// ---------------------------------------------------------------------------
Deno.test("attack: a stale lock cannot be reclaimed by two concurrent runs", async () => {
  const root = await scratchDir("lockrace");
  try {
    const lock = join(root, "stale.lock");
    await Deno.writeTextFile(lock, "999999999\n");
    const shims = join(root, "bin");
    const counter = join(root, "ps-calls");
    await writeShims(shims, {
      ps: [
        `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
        `n=$((n+1)); echo $n > "${counter}"`,
        'if [ "$n" -eq 1 ]; then sleep 0.2; else sleep 1.2; fi',
        "exit 1",
      ].join("\n"),
    });
    const acquirer = join(root, "acquire.ts");
    await Deno.writeTextFile(
      acquirer,
      [
        `import { RunLock } from ${JSON.stringify(CANDIDATE_SCRIPT)};`,
        "try {",
        "  await RunLock.acquire(Deno.args[0], Deno.pid);",
        "  console.log(`acquired ${Deno.pid}`);",
        "} catch (error) {",
        "  console.log(`refused ${(error as Error).message}`);",
        "}",
        "",
      ].join("\n"),
    );
    const env = { PATH: pathWith(shims) };
    const [a, b] = await Promise.all([
      exec(Deno.execPath(), ["run", "-A", acquirer, lock], { env }),
      exec(Deno.execPath(), ["run", "-A", acquirer, lock], { env }),
    ]);
    const acquired = [a.stdout, b.stdout].filter((line) => line.startsWith("acquired"));
    assertEquals(
      acquired.length,
      1,
      `exactly one run may hold the lock; got:\n${a.stdout}${a.stderr}${b.stdout}${b.stderr}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Attack 6 — boundary values in supabase/config.toml `[api] port`.
// ---------------------------------------------------------------------------
Deno.test("attack: [api] port outside 1..65535 is rejected", () => {
  for (const port of ["0", "65536", "70000"]) {
    let rejected = false;
    try {
      readApiPort(`project_id = "x"\n[api]\nport = ${port}\n`);
    } catch {
      rejected = true;
    }
    assert(rejected, `port = ${port} must be rejected, it cannot host Kong`);
  }
});

Deno.test("attack: [api] port written with a TOML digit separator is read", () => {
  assertEquals(
    readApiPort('project_id = "x"\n[api]\nport = 54_321\n'),
    54321,
    "54_321 is the TOML integer 54321",
  );
});

// ---------------------------------------------------------------------------
// Attack 7 — concurrency: two runs started in the same UTC second share the
// default artifacts/edge-cold-start/<UTC>/ directory and overwrite each other's
// report.json (the second run's failure clobbers the first run's evidence).
// ---------------------------------------------------------------------------
Deno.test("attack: two runs started in the same second keep separate reports", async () => {
  const root = await scratchDir("samesecond");
  try {
    const repo = join(root, "repo");
    await makeRepoCopy(repo);
    const shims = join(root, "bin");
    await writeShims(shims, DOCKERLESS_SHIMS);
    const env = { PATH: pathWith(shims) };
    const artifacts = join(repo, "artifacts", "edge-cold-start");

    let sameSecond = false;
    for (let attempt = 0; attempt < 5 && !sameSecond; attempt += 1) {
      await Deno.remove(artifacts, { recursive: true }).catch(() => undefined);
      const nowMs = Date.now() % 1000;
      if (nowMs > 300) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 1000 - nowMs + 5));
      }
      const [one, two] = await Promise.all([
        runCandidate(repo, ["--cycles", "1"], { env }),
        runCandidate(repo, ["--cycles", "2"], { env }),
      ]);
      assertEquals(one.code, 1, one.stdout);
      assertEquals(two.code, 1, two.stdout);
      const stamps = /artifacts → (\S+)/;
      const dirOne = stamps.exec(one.stdout)?.[1];
      const dirTwo = stamps.exec(two.stdout)?.[1];
      assert(dirOne !== undefined && dirTwo !== undefined, "both runs announce an artifact dir");
      sameSecond = dirOne === dirTwo;
      if (sameSecond) {
        const dirs: string[] = [];
        for await (const entry of Deno.readDir(artifacts)) {
          dirs.push(entry.name);
        }
        assertEquals(dirs.length, 2, `two runs must leave two report directories, got ${dirs}`);
      }
    }
    assert(sameSecond, "could not start two runs within one UTC second (inconclusive)");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
