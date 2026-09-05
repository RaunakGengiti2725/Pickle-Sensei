/**
 * Boundary / malformed-input stress campaign for @pickle/swing-lab.
 *
 * Default run: STRESS_ITER iterations (default 400, ~seconds) so the campaign
 * lives in the ordinary suite. Full campaign:
 *
 *   STRESS_ITER=3000 STRESS_OUT=/tmp/stress/boundary.json \
 *     pnpm --filter @pickle/swing-lab test -- boundaryMalformed
 *
 * Replay one row of the results table:
 *
 *   STRESS_SEED=<seed> pnpm --filter @pickle/swing-lab test -- boundaryMalformed
 *
 * The campaign seed is fixed (STRESS_CAMPAIGN_SEED to override) so the same
 * iteration count always visits the same seeds.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeRng } from "./rng.js";
import { flakeRate, isBroken, runCampaign, runSeed, type IterationRow } from "./runner.js";
import { SURFACES } from "./surfaces.js";

/* ------------------------------------------------------------------------ *
 * fs write sentinel: every write-shaped fs entry point increments a counter.
 * The mock passes straight through, so behaviour is unchanged — it only
 * lets the runner prove that no surface wrote anything while under attack.
 * ------------------------------------------------------------------------ */

const { fsWrites, countingFs } = vi.hoisted(() => {
  const fsWrites = { count: 0 };
  const WRITE_APIS = [
    "writeFileSync",
    "writeFile",
    "appendFileSync",
    "appendFile",
    "mkdirSync",
    "mkdir",
    "renameSync",
    "rename",
    "rmSync",
    "rm",
    "unlinkSync",
    "unlink",
    "copyFileSync",
    "copyFile",
    "truncateSync",
    "truncate",
    "createWriteStream",
    "openSync",
    "open",
    "writeSync",
    "write",
    "symlinkSync",
    "symlink",
    "chmodSync",
    "chmod",
    "utimesSync",
    "utimes",
  ] as const;

  function countingFs<T extends Record<string, unknown>>(actual: T): T {
    const wrapped: Record<string, unknown> = { ...actual };
    for (const name of WRITE_APIS) {
      const original = actual[name];
      if (typeof original !== "function") continue;
      wrapped[name] = (...args: unknown[]) => {
        fsWrites.count += 1;
        return (original as (...inner: unknown[]) => unknown).apply(actual, args);
      };
    }
    return wrapped as T;
  }
  return { fsWrites, countingFs };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const wrapped = countingFs(actual as unknown as Record<string, unknown>);
  return { ...wrapped, default: wrapped };
});
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const wrapped = countingFs(actual as unknown as Record<string, unknown>);
  return { ...wrapped, default: wrapped };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const wrapped = countingFs(actual as unknown as Record<string, unknown>);
  return { ...wrapped, default: wrapped };
});

const hooks = { fsWriteCount: () => fsWrites.count };

/* ------------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------------ */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return parsed;
}

const STRESS_ITER = envInt("STRESS_ITER", 400);
const CAMPAIGN_SEED = envInt("STRESS_CAMPAIGN_SEED", 0x5eed_0b0d);
const STRESS_SEED = process.env["STRESS_SEED"];
const STRESS_OUT = process.env["STRESS_OUT"];
/** Re-run every BROKEN seed this many times and record the flake rate in STRESS_OUT. */
const STRESS_RERUN_BROKEN = envInt("STRESS_RERUN_BROKEN", 0);

function summarizeBroken(rows: IterationRow[]): string {
  return rows
    .slice(0, 25)
    .map(
      (row) =>
        `${row.outcome} seed=${row.seed} ${row.surface} ` +
        `[${row.mutations.map((m) => `${m.category}:${m.detail}`).join(" | ")}] ` +
        `${row.error ? `${row.error.name}: ${row.error.message} @ ${row.error.frame ?? "?"}` : ""}` +
        `${row.nonFinitePaths ? row.nonFinitePaths.join(",") : ""}` +
        `${row.outputInvariantViolations ? row.outputInvariantViolations.join(",") : ""}`,
    )
    .join("\n");
}

/* ------------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------------ */

describe("swing-lab boundary/malformed stress harness", () => {
  it("fixture sanity: every surface accepts its unmutated base payload", () => {
    const failures: string[] = [];
    for (const surface of SURFACES) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const rng = makeRng(0xf1_00 + attempt);
        const base = surface.base(rng);
        let result: ReturnType<typeof surface.invoke>;
        try {
          result = surface.invoke(structuredClone(base));
        } catch (error) {
          if (surface.documentedThrow?.(error)) continue;
          failures.push(`${surface.name}#${attempt}: threw ${String(error)}`);
          continue;
        }
        if (result.kind === "rejected") {
          failures.push(`${surface.name}#${attempt}: rejected ${result.problems.join("; ")}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("replays deterministically: the same seed yields the same row", () => {
    const seeds = [1, 2, 3, 0xdead_beef, 0x7fff_ffff, 0];
    for (const seed of seeds) {
      const a = runSeed(seed, hooks);
      const b = runSeed(seed, hooks);
      expect(JSON.stringify({ ...b, durationMs: 0 })).toBe(JSON.stringify({ ...a, durationMs: 0 }));
    }
  });

  it.skipIf(STRESS_SEED === undefined)(
    `replays STRESS_SEED=${STRESS_SEED ?? ""} 10× and reports the flake rate`,
    () => {
      const seed = Number(STRESS_SEED);
      const row = runSeed(seed, hooks);
      const rate = flakeRate(seed, 10, hooks);
      process.stdout.write(`${JSON.stringify({ row, rate }, null, 2)}\n`);
      expect(rate.broken, `seed ${seed} broken ${rate.broken}/${rate.runs}: ${row.outcome}`).toBe(
        0,
      );
    },
  );

  it.skipIf(STRESS_SEED !== undefined)(
    `seeded campaign of ${STRESS_ITER} malformed inputs never breaks a surface`,
    () => {
      const result = runCampaign({ campaignSeed: CAMPAIGN_SEED, iterations: STRESS_ITER, hooks });

      const flake: Record<string, { broken: number; runs: number; outcomes: string[] }> = {};
      if (STRESS_RERUN_BROKEN > 0) {
        for (const seed of result.summary.brokenSeeds)
          flake[String(seed)] = flakeRate(seed, STRESS_RERUN_BROKEN, hooks);
      }

      if (STRESS_OUT) {
        mkdirSync(dirname(STRESS_OUT), { recursive: true });
        writeFileSync(STRESS_OUT, `${JSON.stringify({ ...result, flake }, null, 1)}\n`);
      }
      process.stdout.write(`${JSON.stringify({ ...result.summary, flake }, null, 2)}\n`);

      expect(result.summary.iterations).toBe(STRESS_ITER);
      // Every surface must have been visited when the campaign is large enough.
      if (STRESS_ITER >= 20 * SURFACES.length) {
        for (const surface of SURFACES)
          expect(result.summary.bySurface[surface.name] ?? 0).toBeGreaterThan(0);
      }

      const broken = result.rows.filter((row) => isBroken(row.outcome));
      expect(broken.length, `${broken.length} BROKEN rows:\n${summarizeBroken(broken)}`).toBe(0);
    },
  );
});
