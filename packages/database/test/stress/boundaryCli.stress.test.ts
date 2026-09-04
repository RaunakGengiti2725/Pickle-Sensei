import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CONTROL_STRINGS,
  KB64,
  MALFORMED_JSON_TEXT,
  NUMERIC_EDGE_TEXT,
  PACKAGE_ROOT,
  PATH_TRAVERSAL,
  PROTO_KEYS,
  Reporter,
  Rng,
  TEST_URL,
  UNICODE_PAIRS,
  campaignSeeds,
  describeInput,
  formatAnomalies,
  hostileString,
  iterations,
} from "./harness.js";

/**
 * LENS boundary-malformed / campaign "cli": `src/cli.ts` is the only entry
 * point that turns untrusted process input (argv + DATABASE_URL) into a pg.Pool
 * and a migrate/seed run. Every iteration spawns the real CLI with a generated
 * hostile `DATABASE_URL` and/or command and asserts:
 *   - it exits non-zero (a malformed input must never be reported as success);
 *   - it terminates (no hang: 20s budget);
 *   - it never echoes the credential embedded in the URL to stdout/stderr;
 *   - it never dies from a signal (uncaught crash = SIGABRT/SIGSEGV).
 *
 * Only URLs that cannot reach a real database (or reach it with wrong
 * credentials / an impossible database name) are generated — the campaign
 * never performs a real migrate/seed. Default 12 spawns; STRESS_ITER x0.02.
 */

const CLI = join(PACKAGE_ROOT, "src", "cli.ts");
const TSX = join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");
const SECRET = "STRESS_SECRET_MARKER_5f1c2b";
const SPAWN_TIMEOUT_MS = 20_000;

interface Spawned {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

function runCli(args: string[], env: Record<string, string | undefined>): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    try {
      execFile(
        TSX,
        [CLI, ...args],
        {
          cwd: PACKAGE_ROOT,
          env: { ...process.env, ...env },
          timeout: SPAWN_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: 16 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          const durationMs = performance.now() - started;
          if (!error) {
            resolve({ code: 0, signal: null, stdout, stderr, timedOut: false, durationMs });
            return;
          }
          resolve({
            code: typeof error.code === "number" ? error.code : null,
            signal: error.signal ?? null,
            stdout,
            stderr,
            timedOut: error.killed === true && error.signal === "SIGKILL",
            durationMs,
          });
        },
      );
    } catch (error) {
      reject(error);
    }
  });
}

interface Scenario {
  label: string;
  url: string | undefined;
  command: string | undefined;
  extraArgs: string[];
}

function hostileUrl(rng: Rng): { url: string | undefined; label: string } {
  const base = TEST_URL
    ? new URL(TEST_URL)
    : new URL("postgres://pickle:pw@127.0.0.1:1/pickle_test");
  const host = base.hostname;
  const port = base.port || "5432";
  const user = base.username || "pickle";
  const db = base.pathname.replace(/^\//, "") || "pickle_test";
  const variants: Array<() => [string | undefined, string]> = [
    () => [undefined, "unset"],
    () => ["", "empty"],
    () => ["   ", "whitespace"],
    () => [`postgres://${user}:${SECRET}@${host}:${port}/${db}`, "wrong-password"],
    () => [`postgres://${user}:${SECRET}@${host}:${port}/db_${rng.hex(8)}`, "missing-database"],
    () => [
      `postgres://${user}:${SECRET}@${host}:${port}/${rng.pick(PATH_TRAVERSAL)}`,
      "path-traversal-dbname",
    ],
    () => [
      `postgres://${user}:${SECRET}@${host}:${port}/${encodeURIComponent(rng.pick(PROTO_KEYS))}`,
      "proto-key-dbname",
    ],
    () => [
      `postgres://${user}:${SECRET}@${host}:${port}/${db}?sslmode=${rng.pick(["garbage", "require", "verify-full", "", "\u0000"])}`,
      "sslmode",
    ],
    () => [
      `postgres://${user}:${SECRET}@${host}:${port}/${db}?application_name=${encodeURIComponent(hostileString(rng).slice(0, KB64 + 5))}`,
      "huge-application_name",
    ],
    () => [
      `postgres://${user}:${SECRET}@${host}:${port}/${db}?options=${encodeURIComponent(`-c search_path=${rng.pick(PATH_TRAVERSAL)}`)}`,
      "options-injection",
    ],
    () => [
      `postgres://${user}:${SECRET}@${host}:${port}/${db}?connect_timeout=${rng.pick(NUMERIC_EDGE_TEXT)}`,
      "connect_timeout-edge",
    ],
    () => [
      `postgres://${user}:${SECRET}@${host}:${port}/${db}?port=${rng.pick(NUMERIC_EDGE_TEXT)}`,
      "port-override-edge",
    ],
    () => [
      `postgres://${user}:${SECRET}@${host}:${rng.pick(["0", "1", "65536", "-1", "abc", "5433.5", "NaN"])}/${db}`,
      "port-edge",
    ],
    () => [`postgres://${user}:${SECRET}@127.0.0.1:1/${db}`, "closed-port"],
    () => [`postgres://${user}:${SECRET}@[::1]:1/${db}`, "ipv6-closed-port"],
    () => [
      `postgres://${user}:${SECRET}@${rng.pick(["nonexistent.invalid", "‥", "host name", "%00", "localhost\u0000"])}:${port}/${db}`,
      "bad-host",
    ],
    () => [
      `postgres://${encodeURIComponent(hostileString(rng).slice(0, 200))}:${SECRET}@${host}:${port}/${db}`,
      "hostile-user",
    ],
    () => [
      `postgres://${user}:${SECRET}@${host}:${port}/${db}`.slice(0, rng.int(5, 40)),
      "truncated-url",
    ],
    () => [
      `${rng.pick(["mysql", "http", "file", "postgresql+psycopg2", "javascript", "POSTGRES", ""])}://${user}:${SECRET}@${host}:${port}/${db}`,
      "wrong-scheme",
    ],
    () => [rng.pick(MALFORMED_JSON_TEXT), "json-as-url"],
    () => [
      `postgres://${user}:${SECRET}@${host}:${port}/${db}${rng.pick(CONTROL_STRINGS)}`,
      "control-suffix",
    ],
    () => [
      `postgres://${user}:${SECRET}@${host}:${port}/${db}?${"a=b&".repeat(5000)}`,
      "query-flood",
    ],
    () => [
      `postgres://${user}:${SECRET}@${host}:${port}/${rng.pick(UNICODE_PAIRS)[rng.int(1, 2)]}`,
      "unicode-dbname",
    ],
    () => ["postgres://", "scheme-only"],
    () => ["postgres:///", "socket-default"],
    () => [`postgres://${user}:${SECRET}@${host}:${port}`, "no-database"],
    () => [`postgres://${user}:${SECRET}@${host}:${port}/${db}/extra/segments`, "extra-path"],
    () => [`postgres://${user}:${SECRET}@${host}:${port}/${db}#fragment`, "fragment"],
    () => [
      `postgres://${user}:${SECRET}@${host}:${port}/${db}?user=${rng.pick(["postgres", "", "\u0000"])}`,
      "user-override",
    ],
    () => [`socket:/${rng.pick(PATH_TRAVERSAL)}?db=${db}`, "socket-scheme"],
  ];
  const [url, label] = rng.pick(variants)();
  return { url, label };
}

function scenario(rng: Rng): Scenario {
  const { url, label } = hostileUrl(rng);
  const commandVariants: Array<() => [string | undefined, string]> = [
    () => [undefined, "none"],
    () => ["migrate", "migrate"],
    () => ["seed", "seed"],
    () => ["Migrate", "case"],
    () => [" migrate", "space"],
    () => ["migrate\u0000", "nul"],
    () => [rng.pick(PATH_TRAVERSAL), "path"],
    () => [rng.pick(PROTO_KEYS), "proto"],
    () => [hostileString(rng).slice(0, 4000), "hostile"],
    () => ["--help", "flag"],
    () => ["", "empty"],
    () => ["migrate seed", "two-words"],
  ];
  // Half the spawns use a real command so the URL actually reaches pg.Pool.
  const [command, cmdLabel] = rng.chance(0.5)
    ? rng.chance(0.5)
      ? (["migrate", "migrate"] as [string, string])
      : (["seed", "seed"] as [string, string])
    : rng.pick(commandVariants)();
  const extraArgs = rng.chance(0.2) ? [rng.pick(["--force", "seed", rng.hex(4)])] : [];
  return { label: `url:${label}/cmd:${cmdLabel}`, url, command, extraArgs };
}

describe.skipIf(!existsSync(TSX))(
  "stress/boundary-malformed: cli.ts vs hostile DATABASE_URL / argv",
  () => {
    const total = iterations(12, 0.02);
    const concurrency = 4;

    it(
      `exits non-zero, terminates and never leaks the credential (${total} spawns)`,
      async () => {
        const reporter = new Reporter("cli-hostile-env", {
          iterations: total,
          timeoutMs: SPAWN_TIMEOUT_MS,
        });
        const seeds = campaignSeeds("cli", total);
        const queue = seeds.map((seed, index) => ({ seed, index }));
        const worker = async (): Promise<void> => {
          for (;;) {
            const next = queue.shift();
            if (!next) return;
            const rng = new Rng(next.seed);
            const sc = scenario(rng);
            const args = [...(sc.command === undefined ? [] : [sc.command]), ...sc.extraArgs];
            const env: Record<string, string | undefined> = { DATABASE_URL: sc.url };
            let result: Spawned;
            const problems: string[] = [];
            try {
              result = await runCli(args, env);
            } catch (error) {
              // argv with a NUL byte is refused by Node before the process exists.
              reporter.add({
                seed: next.seed,
                index: next.index,
                kind: sc.label,
                input: describeInput({ url: sc.url?.replace(SECRET, "<secret>"), args }, 300),
                outcome: "REJECTED_CLIENT",
                message: String(error).slice(0, 200),
                durationMs: 0,
              });
              continue;
            }
            const combined = `${result.stdout}\n${result.stderr}`;
            if (result.timedOut) problems.push("hang>20s");
            if (result.signal) problems.push(`signal:${result.signal}`);
            if (result.code === 0) problems.push("exit-0-on-malformed-input");
            if (combined.includes(SECRET)) problems.push("credential-echoed");
            if (/seed complete|applied,/.test(result.stdout)) problems.push("reported-success");
            const firstLine = result.stderr.split("\n").find((l) => l.trim().length > 0) ?? "";
            reporter.add({
              seed: next.seed,
              index: next.index,
              kind: sc.label,
              input: describeInput({ url: sc.url?.replace(SECRET, "<secret>"), args }, 300),
              outcome: problems.length
                ? problems.includes("credential-echoed")
                  ? "ANOMALY_INTERNAL"
                  : "ANOMALY_PROPERTY"
                : "REJECTED_TYPED",
              message: `exit=${result.code} signal=${result.signal} stderr=${firstLine.slice(0, 160)}`,
              ...(problems.length ? { note: problems.join(";") } : {}),
              durationMs: result.durationMs,
            });
          }
        };
        await Promise.all(Array.from({ length: concurrency }, worker));
        const path = reporter.write();
        console.warn(`[stress] cli-hostile-env: ${JSON.stringify(reporter.summary())} → ${path}`);
        expect(reporter.rows.length).toBe(total);
        expect(formatAnomalies(reporter)).toBe("");
      },
      Math.max(120_000, (total / concurrency) * (SPAWN_TIMEOUT_MS + 2_000)),
    );
  },
);
