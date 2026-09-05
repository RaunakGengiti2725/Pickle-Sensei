import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateCaptureEnvelope } from "../../src/envelope.js";
import { measureClip, probeClipStream, type MeasureWindow } from "../../src/clipProbe.js";
import {
  describeValue,
  isFiniteNumber,
  MEASUREMENT_KEYS,
  PATH_TRAVERSALS,
  ResultTable,
  SeededRng,
  stableJson,
  STRESS_MEDIA_ITER,
  STRESS_OUT,
  STRESS_SEED,
  writeTable,
} from "./boundaryMalformedSupport.js";

/**
 * boundary-malformed stress — the ffprobe/ffmpeg process boundary
 * (`probeClipStream` / `measureClip`). Inputs are SEEDED SYNTHETIC streams
 * only (ffmpeg lavfi test sources) plus byte-level corruption of them:
 * truncation, seeded byte flips, zero-length, non-media bytes, still image,
 * audio-only, directories, traversal strings, NUL bytes, argument-shaped
 * paths, extreme aspect ratios, FIFOs, and malformed measurement windows.
 *
 * Contract under test: a caller receives EITHER measurements whose fields
 * are null-or-finite OR a thrown `Error`; nothing is written anywhere; the
 * call returns in bounded time. Sub-processes that may hang or exhaust
 * memory are run in a child node with a timeout + heap cap so the suite
 * itself stays bounded.
 */

const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");
const CLIP_PROBE_SRC = resolve(PACKAGE_ROOT, "src/clipProbe.ts");

function hasTool(name: string): boolean {
  const res = spawnSync(name, ["-version"], { stdio: "ignore" });
  return res.status === 0;
}

const TOOLS_PRESENT = hasTool("ffmpeg") && hasTool("ffprobe");

const table = new ResultTable();
let scratch = "";
let cwdSandbox = "";
let baseClip = "";

function synth(name: string, source: string, seconds: string): string {
  const out = join(scratch, name);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    source,
    "-t",
    seconds,
    "-pix_fmt",
    "yuv420p",
    "-y",
    out,
  ]);
  return out;
}

function fileTree(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

type Attempt =
  | { kind: "returned"; problems: string[]; summary: string }
  | { kind: "typed-error"; message: string }
  | { kind: "untyped-throw"; value: string };

function attempt(
  fn: () => unknown,
  describe: (value: unknown) => { problems: string[]; summary: string },
): Attempt {
  try {
    const value = fn();
    return { kind: "returned", ...describe(value) };
  } catch (error) {
    if (error instanceof Error)
      return { kind: "typed-error", message: error.message.slice(0, 160).replace(/\s+/g, " ") };
    return { kind: "untyped-throw", value: describeValue(error) };
  }
}

function describeMeasurements(value: unknown): { problems: string[]; summary: string } {
  const problems: string[] = [];
  const m = value as Record<string, unknown>;
  for (const key of MEASUREMENT_KEYS) {
    if (!(key in m)) problems.push(`missing ${key}`);
    else if (m[key] !== null && !isFiniteNumber(m[key]))
      problems.push(`${key}=${describeValue(m[key])}`);
  }
  let overall = "?";
  try {
    overall = evaluateCaptureEnvelope(m as never).overallWithCoverage;
  } catch (error) {
    problems.push(`evaluate threw ${describeValue(error)}`);
  }
  return {
    problems,
    summary: `${overall} nulls=${MEASUREMENT_KEYS.filter((k) => m[k] === null).length}`,
  };
}

function describeProbe(value: unknown): { problems: string[]; summary: string } {
  const info = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of [
    "width",
    "height",
    "rotationDegrees",
    "displayWidth",
    "displayHeight",
    "avgFrameRateFps",
    "durationMs",
  ]) {
    if (!isFiniteNumber(info[key])) problems.push(`${key}=${describeValue(info[key])}`);
  }
  return {
    problems,
    summary: `${String(info.displayWidth)}x${String(info.displayHeight)}@${String(info.avgFrameRateFps)}`,
  };
}

const CHILD_SCRIPT = `import { measureClip, probeClipStream } from ${JSON.stringify(CLIP_PROBE_SRC)};
const [mode, p] = process.argv.slice(1);
try {
  const value = mode === "probe" ? probeClipStream(p) : measureClip(p);
  console.log(JSON.stringify({ ok: true, value }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, typed: error instanceof Error, message: String(error && error.message).slice(0, 200) }));
}`;

interface GuardedResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Killing the child node does not kill a blocked ffprobe grandchild; reap it by its argv. */
function reapProbes(path: string): void {
  spawnSync("pkill", ["-f", `ffprobe .*${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`], {
    stdio: "ignore",
  });
}

/** Run one prober call in a child node with a wall-clock + heap budget. */
function guardedCall(mode: "probe" | "measure", path: string, timeoutMs: number): GuardedResult {
  const started = Date.now();
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "--max-old-space-size=256", "-e", CHILD_SCRIPT, mode, path],
    {
      cwd: PACKAGE_ROOT,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  reapProbes(path);
  return {
    status: res.status,
    signal: res.signal,
    stdout: (res.stdout ?? "").toString(),
    stderr: (res.stderr ?? "").toString(),
    ms: Date.now() - started,
  };
}

/**
 * A throwaway HTTP listener in a separate process (the prober is synchronous,
 * so a server in this event loop could never answer it). Every request line
 * is appended to `logPath`; resolves with the bound port.
 */
function startRequestSink(logPath: string): Promise<{ port: number; stop: () => void }> {
  const script = `const { createServer } = require("node:http");
const { appendFileSync } = require("node:fs");
const server = createServer((req, res) => {
  appendFileSync(process.argv[1], req.method + " " + req.url + "\\n");
  res.statusCode = 404;
  res.end();
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));`;
  const child = spawn(process.execPath, ["-e", script, logPath], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  return new Promise((resolvePort, reject) => {
    let buffered = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("request sink did not start"));
    }, 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const line = buffered.split("\n")[0];
      if (buffered.includes("\n") && line !== undefined) {
        clearTimeout(timer);
        resolvePort({ port: Number(line), stop: () => child.kill() });
      }
    });
  });
}

beforeAll(() => {
  if (!TOOLS_PRESENT) return;
  scratch = mkdtempSync(join(tmpdir(), "capture-envelope-stress-"));
  cwdSandbox = join(scratch, "cwd");
  mkdirSync(cwdSandbox);
  baseClip = synth("base.mp4", "testsrc=size=320x240:rate=12", "2");
});

afterAll(() => {
  writeTable(STRESS_OUT, "process", table);
  process.stderr.write(
    `[stress process] executed=${table.rows.length} broken=${table.broken().length} byKind=${JSON.stringify(table.countByKind())}\n`,
  );
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const describeIf = TOOLS_PRESENT ? describe : describe.skip;

describeIf(
  "boundary-malformed stress: ffprobe/ffmpeg boundary with corrupted synthetic streams",
  () => {
    it(
      `truncated / byte-flipped / zero-filled copies × ${STRESS_MEDIA_ITER} seeds: measurements-or-Error, fields finite-or-null, no writes`,
      () => {
        const failures: string[] = [];
        const original = readFileSync(baseClip);
        for (let i = 0; i < STRESS_MEDIA_ITER; i += 1) {
          const seed = STRESS_SEED + 60_000_000 + i;
          const rng = new SeededRng(seed);
          const mode = rng.int(4);
          let bytes: Buffer;
          let label: string;
          if (mode === 0) {
            const cut = rng.intBetween(0, original.length - 1);
            bytes = original.subarray(0, cut);
            label = `truncate@${cut}`;
          } else if (mode === 1) {
            bytes = Buffer.from(original);
            const flips = rng.intBetween(1, 64);
            for (let k = 0; k < flips; k += 1) bytes[rng.int(bytes.length)] = rng.int(256);
            label = `flip×${flips}`;
          } else if (mode === 2) {
            bytes = Buffer.from(original);
            const start = rng.int(bytes.length);
            const len = rng.intBetween(1, Math.min(4096, bytes.length - start));
            bytes.fill(0, start, start + len);
            label = `zero@${start}+${len}`;
          } else {
            bytes = Buffer.concat([original.subarray(0, rng.int(64)), rng.bytes(rng.int(2048))]);
            label = `header+random(${bytes.length})`;
          }
          const path = join(scratch, `seed-${seed}.mp4`);
          writeFileSync(path, bytes);
          const before = fileTree(scratch);
          const probe = attempt(() => probeClipStream(path), describeProbe);
          const measure = attempt(() => measureClip(path), describeMeasurements);
          const after = fileTree(scratch);
          const problems: string[] = [];
          if (stableJson(before) !== stableJson(after))
            problems.push(`files changed: ${after.filter((f) => !before.includes(f)).join(",")}`);
          for (const [name, a] of [
            ["probe", probe],
            ["measure", measure],
          ] as const) {
            if (a.kind === "untyped-throw") problems.push(`${name} threw non-Error ${a.value}`);
            if (a.kind === "returned" && a.problems.length > 0)
              problems.push(`${name}: ${a.problems.join(",")}`);
          }
          if (measure.kind === "returned") {
            const again = attempt(() => measureClip(path), describeMeasurements);
            if (again.kind !== "returned" || again.summary !== measure.summary)
              problems.push("measure not repeatable");
          }
          rmSync(path, { force: true });
          const summary = `${label}: probe=${probe.kind === "returned" ? probe.summary : probe.kind} measure=${measure.kind === "returned" ? measure.summary : measure.kind}`;
          if (problems.length > 0) {
            failures.push(`seed ${seed} [${label}]: ${problems.join("; ")}`);
            table.record({
              seed,
              generator: "process.corrupt",
              kind: "invariant",
              outcome: "BROKEN",
              detail: `${summary}; ${problems.join("; ")}`,
            });
          } else {
            table.record({
              seed,
              generator: "process.corrupt",
              kind: "invariants",
              outcome: "HELD",
              detail: summary,
            });
          }
        }
        expect(failures).toEqual([]);
      },
      5000 + STRESS_MEDIA_ITER * 1500,
    );

    it("non-media inputs (still image, audio-only, empty, text, directory, missing, traversal strings): measurements-or-Error, no writes", () => {
      const png = join(scratch, "still.png");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=64x64:rate=1",
        "-frames:v",
        "1",
        "-y",
        png,
      ]);
      const audio = join(scratch, "tone.m4a");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-y",
        audio,
      ]);
      const empty = join(scratch, "empty.mp4");
      writeFileSync(empty, "");
      const text = join(scratch, "labels.json");
      writeFileSync(
        text,
        '{"schemaVersion":"g08-f22-evidence-labels-v1","provenance":"x","labels":[]}',
      );
      const cases: Array<[string, string]> = [
        ["still-image", png],
        ["audio-only", audio],
        ["empty-file", empty],
        ["json-text", text],
        ["directory", scratch],
        ["missing", join(scratch, "does-not-exist.mp4")],
        ...PATH_TRAVERSALS.filter((p) => !p.includes("\u0000")).map((p): [string, string] => [
          `traversal:${p}`,
          p,
        ]),
      ];
      const failures: string[] = [];
      cases.forEach(([label, path], index) => {
        const seed = STRESS_SEED + 61_000_000 + index;
        const started = Date.now();
        const before = fileTree(scratch);
        const probe = attempt(() => probeClipStream(path), describeProbe);
        const measure = attempt(() => measureClip(path), describeMeasurements);
        const after = fileTree(scratch);
        const problems: string[] = [];
        if (stableJson(before) !== stableJson(after))
          problems.push(`files changed: ${after.filter((f) => !before.includes(f)).join(",")}`);
        for (const [name, a] of [
          ["probe", probe],
          ["measure", measure],
        ] as const) {
          if (a.kind === "untyped-throw") problems.push(`${name} threw non-Error ${a.value}`);
          if (a.kind === "returned" && a.problems.length > 0)
            problems.push(`${name}: ${a.problems.join(",")}`);
        }
        const summary = `${Date.now() - started}ms probe=${probe.kind === "returned" ? probe.summary : probe.kind === "typed-error" ? probe.message : probe.kind} measure=${measure.kind === "returned" ? measure.summary : measure.kind}`;
        if (problems.length > 0) {
          failures.push(`${label}: ${problems.join("; ")}`);
          table.record({
            seed,
            generator: "process.non-media",
            kind: "invariant",
            outcome: "BROKEN",
            detail: `${label}: ${summary}; ${problems.join("; ")}`,
          });
        } else {
          table.record({
            seed,
            generator: "process.non-media",
            kind: "invariants",
            outcome: "HELD",
            detail: `${label}: ${summary}`,
          });
        }
      });
      expect(failures).toEqual([]);
    }, 30_000);

    it.fails(
      "PINNED DEVIATION: a URL-shaped clip path must not make the prober open a network connection",
      async () => {
        const seed = STRESS_SEED + 61_500_000;
        const logPath = join(scratch, "sink-requests.log");
        const sink = await startRequestSink(logPath);
        try {
          const url = `http://127.0.0.1:${sink.port}/clips/../../secret.mp4`;
          const result = guardedCall("probe", url, 10_000);
          const requests = existsSync(logPath)
            ? readFileSync(logPath, "utf8")
                .split("\n")
                .filter((line) => line.length > 0)
            : [];
          table.record({
            seed,
            generator: "process.url",
            kind: "url-path-opens-network",
            outcome: requests.length === 0 ? "HELD" : "BROKEN",
            detail: `status=${String(result.status)} signal=${String(result.signal)} ${result.ms}ms ${result.stdout.slice(0, 100).trim()}; server saw ${requests.length} request(s) ${requests.join(",")}`,
          });
          expect(requests).toEqual([]);
        } finally {
          sink.stop();
        }
      },
    );

    it("a NUL byte in the clip path is refused before any process spawns (TypeError from node, no ffprobe run)", () => {
      const seed = STRESS_SEED + 62_000_000;
      let caught: unknown;
      try {
        probeClipStream(join(scratch, "clip.mp4\u0000.txt"));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TypeError);
      table.record({
        seed,
        generator: "process.nul",
        kind: "nul-path-typeerror",
        outcome: "HELD",
        detail: describeValue(caught),
      });
    });

    it("argument-shaped clip paths reach ffprobe as options (recorded): `-version`/`-h` exit 0 and surface as SyntaxError from JSON.parse", () => {
      const seed = STRESS_SEED + 63_000_000;
      const results = ["-version", "-h", "-formats"].map((path) =>
        attempt(() => probeClipStream(path), describeProbe),
      );
      for (const r of results) expect(r.kind).not.toBe("returned");
      table.record({
        seed,
        generator: "process.argv",
        kind: "option-path-not-a-clip",
        outcome: "BROKEN",
        detail: results
          .map((r) => (r.kind === "typed-error" ? r.message.slice(0, 60) : r.kind))
          .join(" | "),
      });
    });

    it.fails(
      "PINNED DEVIATION: a clip path of `-report` must not make ffprobe write a log file into the working directory",
      () => {
        const seed = STRESS_SEED + 63_000_001;
        const previousCwd = process.cwd();
        process.chdir(cwdSandbox);
        let written: string[] = [];
        try {
          const before = fileTree(cwdSandbox);
          attempt(() => probeClipStream("-report"), describeProbe);
          written = fileTree(cwdSandbox).filter((f) => !before.includes(f));
        } finally {
          process.chdir(previousCwd);
        }
        table.record({
          seed,
          generator: "process.argv",
          kind: "report-flag-writes-log",
          outcome: written.length > 0 ? "BROKEN" : "HELD",
          detail: written.join(",") || "no file written",
        });
        expect(written).toEqual([]);
      },
    );

    it.fails(
      "PINNED DEVIATION: an extreme-aspect but valid h264 stream (1280x2) must yield measurements or an Error, not an out-of-memory abort",
      () => {
        const seed = STRESS_SEED + 64_000_000;
        const thin = synth("thin.mp4", "testsrc=size=1280x2:rate=12", "1");
        const probe = attempt(() => probeClipStream(thin), describeProbe);
        expect(probe.kind).toBe("returned");
        const run = guardedCall("measure", thin, 20_000);
        const oom = /heap out of memory|Reached heap limit/.test(run.stderr);
        table.record({
          seed,
          generator: "process.aspect",
          kind: "extreme-aspect-oom",
          outcome: run.status === 0 && !oom ? "HELD" : "BROKEN",
          detail: `status=${String(run.status)} signal=${String(run.signal)} oom=${oom} ${run.ms}ms ${run.stdout.slice(0, 120).trim()}`,
        });
        expect(run.signal).toBeNull();
        expect(oom).toBe(false);
        expect(run.status).toBe(0);
      },
    );

    it.fails(
      "PINNED DEVIATION: a FIFO clip path must fail or time out — the prober has no timeout/cancellation and blocks forever",
      () => {
        const seed = STRESS_SEED + 65_000_000;
        const fifo = join(scratch, "pipe.fifo");
        execFileSync("mkfifo", [fifo]);
        const run = guardedCall("probe", fifo, 3_000);
        table.record({
          seed,
          generator: "process.hang",
          kind: "fifo-blocks-without-timeout",
          outcome: run.signal === null ? "HELD" : "BROKEN",
          detail: `status=${String(run.status)} signal=${String(run.signal)} after ${run.ms}ms`,
        });
        expect(run.signal).toBeNull();
      },
    );

    it("malformed measurement windows (NaN/±Infinity/negative/subnormal/overflow) are refused by ffmpeg as a typed Error or measure nothing — never a crash, never a write", () => {
      const windows: MeasureWindow[] = [
        { startMs: Number.NaN, durationMs: 1000 },
        { startMs: 0, durationMs: Number.POSITIVE_INFINITY },
        { startMs: Number.NEGATIVE_INFINITY, durationMs: 1000 },
        { startMs: -1000, durationMs: 1000 },
        { startMs: 0, durationMs: -1 },
        { startMs: 0, durationMs: 0 },
        { startMs: -0, durationMs: Number.MIN_VALUE },
        { startMs: 0, durationMs: 1e308 },
        { startMs: Number.MAX_SAFE_INTEGER, durationMs: 1 },
      ];
      const failures: string[] = [];
      windows.forEach((window, index) => {
        const seed = STRESS_SEED + 66_000_000 + index;
        const before = fileTree(scratch);
        const result = attempt(() => measureClip(baseClip, window), describeMeasurements);
        const after = fileTree(scratch);
        const problems: string[] = [];
        if (stableJson(before) !== stableJson(after)) problems.push("files changed");
        if (result.kind === "untyped-throw") problems.push(`non-Error ${result.value}`);
        if (result.kind === "returned" && result.problems.length > 0)
          problems.push(result.problems.join(","));
        const label = `start=${describeValue(window.startMs)} dur=${describeValue(window.durationMs)}`;
        if (problems.length > 0) {
          failures.push(`${label}: ${problems.join("; ")}`);
          table.record({
            seed,
            generator: "process.window",
            kind: "invariant",
            outcome: "BROKEN",
            detail: `${label}: ${problems.join("; ")}`,
          });
        } else {
          table.record({
            seed,
            generator: "process.window",
            kind: "invariants",
            outcome: "HELD",
            detail: `${label}: ${result.kind === "returned" ? result.summary : result.kind === "typed-error" ? result.message.slice(0, 80) : result.kind}`,
          });
        }
      });
      expect(failures).toEqual([]);
    });

    it.fails(
      "PINNED DEVIATION: a window past the end of the media must not report the requested window length as clipDurationMs",
      () => {
        const seed = STRESS_SEED + 67_000_000;
        const beyond = measureClip(baseClip, { startMs: 100_000, durationMs: 5_000 });
        const longer = measureClip(baseClip, { startMs: 0, durationMs: 90_000 });
        table.record({
          seed,
          generator: "process.window",
          kind: "window-duration-not-media-duration",
          outcome:
            beyond.clipDurationMs === 5000 || longer.clipDurationMs === 90_000 ? "BROKEN" : "HELD",
          detail: `beyond-end clipDurationMs=${String(beyond.clipDurationMs)} sampled-nulls=${MEASUREMENT_KEYS.filter((k) => beyond[k] === null).length}; 90s window on 2s clip clipDurationMs=${String(longer.clipDurationMs)} → ${evaluateCaptureEnvelope(longer).dimensions.find((d) => d.dimension === "clip_duration")!.status}`,
        });
        expect(beyond.brightnessMeanLuma).toBeNull();
        expect(beyond.clipDurationMs).not.toBe(5000);
        expect(longer.clipDurationMs).toBeLessThanOrEqual(2000);
      },
    );
  },
);

if (!TOOLS_PRESENT) {
  it("ffmpeg/ffprobe unavailable — process-boundary campaign NOT executed (this is not a pass)", () => {
    table.record({
      seed: STRESS_SEED,
      generator: "process",
      kind: "tools-missing",
      outcome: "BROKEN",
      detail: "ffmpeg/ffprobe not on PATH",
    });
    expect.soft(TOOLS_PRESENT, "ffmpeg/ffprobe missing: campaign skipped").toBe(true);
  });
}
