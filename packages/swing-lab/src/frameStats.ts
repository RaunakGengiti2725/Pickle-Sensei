import { execFile, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { FrameStats } from "@pickle/vision-geometry";

/**
 * Pose-free frame statistics for the pre-analysis OOD gate: decodes the clip
 * once with ffmpeg to a small grayscale raster and measures inter-frame
 * change, spatial texture, and letterbox bars. Deterministic over the same
 * file + ffmpeg build; feeds vision-geometry's evaluateFrameAnalyzability.
 *
 * A FrameStats value is a statement about the media, so it is only produced
 * when ffmpeg actually ran to completion on an existing file. Anything that
 * prevents that measurement — the input path does not exist, ffmpeg/ffprobe
 * are not installed, the process could not be launched or was killed — is
 * thrown as FrameStatsToolingError so callers cannot mistake an environment
 * outage for corrupt media.
 */

export type FrameStatsTool = "ffmpeg" | "ffprobe" | "input";

export class FrameStatsToolingError extends Error {
  readonly kind = "tooling_error" as const;
  readonly tool: FrameStatsTool;
  /** OS/Node error code where one exists (e.g. ENOENT, EACCES, EISDIR). */
  readonly code: string;
  readonly path: string;

  constructor(tool: FrameStatsTool, code: string, path: string, message: string) {
    super(message);
    this.name = "FrameStatsToolingError";
    this.tool = tool;
    this.code = code;
    this.path = path;
  }
}

function errnoCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function toolingErrorFromLaunch(
  tool: Exclude<FrameStatsTool, "input">,
  videoPath: string,
  error: unknown,
): FrameStatsToolingError {
  const code = errnoCode(error) ?? "ESPAWN";
  const detail =
    code === "ENOENT"
      ? `${tool} not found on PATH`
      : `${tool} could not be launched (${code}): ${describeError(error)}`;
  return new FrameStatsToolingError(
    tool,
    code,
    videoPath,
    `${detail} while measuring ${videoPath}`,
  );
}

function toolingErrorFromSignal(
  tool: Exclude<FrameStatsTool, "input">,
  videoPath: string,
  signal: NodeJS.Signals,
): FrameStatsToolingError {
  return new FrameStatsToolingError(
    tool,
    "ESIGNAL",
    videoPath,
    `${tool} was terminated by ${signal} before it finished measuring ${videoPath}`,
  );
}

function toolingErrorFromInput(videoPath: string, error: unknown): FrameStatsToolingError {
  const code = errnoCode(error) ?? "ENOENT";
  return new FrameStatsToolingError(
    "input",
    code,
    videoPath,
    `input ${videoPath} cannot be read (${code}): ${describeError(error)}`,
  );
}

function notAFile(videoPath: string): FrameStatsToolingError {
  return new FrameStatsToolingError(
    "input",
    "ENOENT",
    videoPath,
    `input ${videoPath} is not a file`,
  );
}

function assertInputFileSync(videoPath: string): void {
  let isFile: boolean;
  try {
    isFile = statSync(videoPath).isFile();
  } catch (error) {
    throw toolingErrorFromInput(videoPath, error);
  }
  if (!isFile) throw notAFile(videoPath);
}

async function assertInputFile(videoPath: string): Promise<void> {
  let isFile: boolean;
  try {
    isFile = (await stat(videoPath)).isFile();
  } catch (error) {
    throw toolingErrorFromInput(videoPath, error);
  }
  if (!isFile) throw notAFile(videoPath);
}

const STAT_WIDTH = 64;
const STAT_HEIGHT = 36;
/** A row is a letterbox bar row when its mean luma is at or below this. */
const BAR_ROW_MAX_LUMA = 12;
/** ...and its own std is at or below this (uniform, not dark content). */
const BAR_ROW_MAX_STD = 4;
/** Ring thickness (pixels on every edge) for the frozen-border-bezel signal. */
const RING_THICKNESS = 2;
/** A pixel is temporally frozen when its temporal luma std is at or below this. */
const FROZEN_PIXEL_MAX_STD = 0.5;
/** First raster row of the bottom third, where a broadcast score graphic sits. */
const BOTTOM_THIRD_START_ROW = Math.floor((STAT_HEIGHT * 2) / 3);

const DECODE_ARGS = (videoPath: string) => [
  "-v",
  "error",
  "-i",
  videoPath,
  "-vf",
  `scale=${STAT_WIDTH}:${STAT_HEIGHT}`,
  "-pix_fmt",
  "gray",
  "-f",
  "rawvideo",
  "-",
];

const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;

/** Output of a tool that was launched and ran to exit (any exit status). */
interface ToolRun {
  stdout: Buffer;
  stderr: Buffer;
  exitedNonZero: boolean;
}

/**
 * Runs a tool to completion on the calling thread. Partial stdout/stderr from
 * a non-zero exit is returned (that is media information); a launch failure
 * or signal death is a tooling error and throws.
 */
function runToolSync(
  tool: Exclude<FrameStatsTool, "input">,
  args: string[],
  videoPath: string,
): ToolRun {
  const result = spawnSync(tool, args, { maxBuffer: MAX_OUTPUT_BYTES });
  if (result.error !== undefined) throw toolingErrorFromLaunch(tool, videoPath, result.error);
  if (result.status === null) {
    throw toolingErrorFromSignal(tool, videoPath, result.signal ?? "SIGTERM");
  }
  return {
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
    exitedNonZero: result.status !== 0,
  };
}

/** Same contract as runToolSync with the subprocess wait off the event loop. */
function runTool(
  tool: Exclude<FrameStatsTool, "input">,
  args: string[],
  videoPath: string,
): Promise<ToolRun> {
  return new Promise((resolve, reject) => {
    execFile(
      tool,
      args,
      { maxBuffer: MAX_OUTPUT_BYTES, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, exitedNonZero: false });
          return;
        }
        // execFile reports a launch failure (ENOENT, EACCES, maxBuffer…) with a
        // string `code`; a process that ran and exited non-zero carries a
        // numeric exit code, and a signal death carries `signal` with no code.
        if (typeof error.code === "string") {
          reject(toolingErrorFromLaunch(tool, videoPath, error));
          return;
        }
        if (error.signal !== undefined && error.signal !== null) {
          reject(toolingErrorFromSignal(tool, videoPath, error.signal));
          return;
        }
        resolve({ stdout, stderr, exitedNonZero: true });
      },
    );
  });
}

/**
 * Decoder/demuxer diagnostics that mean part of the declared media was not
 * delivered. Matroska/WebM report a cut-off file as a bare
 * "File ended prematurely" and still exit 0, so the EOF wording is matched
 * explicitly alongside the generic error vocabulary.
 */
const DECODE_ERROR_LINE =
  /error|invalid data|partial file|truncat|corrupt|missing|ended prematurely|premature end|unexpected eof|unexpected end of file/i;

function countDecodeErrors(stderrText: string, exitedNonZero: boolean): number {
  const count = stderrText.split("\n").filter((line) => DECODE_ERROR_LINE.test(line)).length;
  return exitedNonZero && count === 0 ? 1 : count;
}

/**
 * @throws FrameStatsToolingError when the input is not a readable file or
 *   ffmpeg/ffprobe cannot be run; a corrupt-but-present file is NOT an error
 *   and yields `{frameCount: 0, decode.errorCount > 0}`.
 */
export function extractFrameStats(videoPath: string): FrameStats {
  assertInputFileSync(videoPath);
  const decode = runToolSync("ffmpeg", DECODE_ARGS(videoPath), videoPath);
  const decodeErrorCount = countDecodeErrors(decode.stderr.toString("utf8"), decode.exitedNonZero);
  const source = parseSourceProbe(runToolSync("ffprobe", SOURCE_PROBE_ARGS(videoPath), videoPath));
  const durationMs = parseDurationProbe(
    runToolSync("ffprobe", DURATION_PROBE_ARGS(videoPath), videoPath),
  );
  return computeFrameStats(decode.stdout, decodeErrorCount, source, durationMs);
}

/**
 * Same statistics (and the same FrameStatsToolingError contract) as
 * extractFrameStats but with the ffmpeg/ffprobe subprocess waits off the
 * event loop; byte-identical inputs produce identical outputs.
 */
export async function extractFrameStatsAsync(videoPath: string): Promise<FrameStats> {
  await assertInputFile(videoPath);
  const decode = await runTool("ffmpeg", DECODE_ARGS(videoPath), videoPath);
  const decodeErrorCount = countDecodeErrors(decode.stderr.toString("utf8"), decode.exitedNonZero);
  const source = parseSourceProbe(
    await runTool("ffprobe", SOURCE_PROBE_ARGS(videoPath), videoPath),
  );
  const durationMs = parseDurationProbe(
    await runTool("ffprobe", DURATION_PROBE_ARGS(videoPath), videoPath),
  );
  return computeFrameStats(decode.stdout, decodeErrorCount, source, durationMs);
}

function computeFrameStats(
  raw: Buffer,
  decodeErrorCount: number,
  source: { width: number; height: number; fps: number | null } | null,
  durationMs: number,
): FrameStats {
  const frameSize = STAT_WIDTH * STAT_HEIGHT;
  const frameCount = Math.floor(raw.length / frameSize);

  const interFrameDiffs: number[] = [];
  const spatialLumaStd: number[] = [];
  let barRowFractionSum = 0;
  const pixelSum = new Float64Array(frameSize);
  const pixelSumSq = new Float64Array(frameSize);

  for (let f = 0; f < frameCount; f += 1) {
    const offset = f * frameSize;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < frameSize; i += 1) {
      const v = raw[offset + i]!;
      sum += v;
      sumSq += v * v;
      pixelSum[i] = pixelSum[i]! + v;
      pixelSumSq[i] = pixelSumSq[i]! + v * v;
    }
    const mean = sum / frameSize;
    spatialLumaStd.push(Math.sqrt(Math.max(0, sumSq / frameSize - mean * mean)));

    let barRows = 0;
    for (let half = 0; half < 2; half += 1) {
      // Walk inward from the top and from the bottom; stop at first non-bar row.
      for (let r = 0; r < Math.floor(STAT_HEIGHT / 2); r += 1) {
        const row = half === 0 ? r : STAT_HEIGHT - 1 - r;
        let rowSum = 0;
        let rowSumSq = 0;
        for (let c = 0; c < STAT_WIDTH; c += 1) {
          const v = raw[offset + row * STAT_WIDTH + c]!;
          rowSum += v;
          rowSumSq += v * v;
        }
        const rowMean = rowSum / STAT_WIDTH;
        const rowStd = Math.sqrt(Math.max(0, rowSumSq / STAT_WIDTH - rowMean * rowMean));
        if (rowMean <= BAR_ROW_MAX_LUMA && rowStd <= BAR_ROW_MAX_STD) barRows += 1;
        else break;
      }
    }
    barRowFractionSum += barRows / STAT_HEIGHT;

    if (f > 0) {
      const prev = (f - 1) * frameSize;
      let diff = 0;
      for (let i = 0; i < frameSize; i += 1) {
        diff += Math.abs(raw[offset + i]! - raw[prev + i]!);
      }
      interFrameDiffs.push(diff / frameSize);
    }
  }

  const pixelMean = new Float64Array(frameSize);
  const pixelStd = new Float64Array(frameSize);
  if (frameCount > 0) {
    for (let i = 0; i < frameSize; i += 1) {
      pixelMean[i] = pixelSum[i]! / frameCount;
      pixelStd[i] = Math.sqrt(Math.max(0, pixelSumSq[i]! / frameCount - pixelMean[i]! ** 2));
    }
  }

  const expectedFrameCount =
    source !== null && source.fps !== null && durationMs > 0
      ? Math.round((durationMs / 1000) * source.fps)
      : null;
  return {
    frameCount,
    durationMs,
    width: STAT_WIDTH,
    height: STAT_HEIGHT,
    interFrameDiffs,
    spatialLumaStd,
    letterboxRowFraction: frameCount > 0 ? barRowFractionSum / frameCount : 0,
    ...(frameCount > 0
      ? {
          borderRing: measureBorderRing(pixelMean, pixelStd),
          bottomFrozenComponents: findBottomFrozenComponents(pixelMean, pixelStd),
        }
      : {}),
    ...(source !== null ? { source: { width: source.width, height: source.height } } : {}),
    decode: { errorCount: decodeErrorCount, expectedFrameCount },
  };
}

const SOURCE_PROBE_ARGS = (videoPath: string) => [
  "-v",
  "error",
  "-select_streams",
  "v:0",
  "-show_entries",
  "stream=width,height,avg_frame_rate",
  "-of",
  "csv=p=0",
  videoPath,
];

const DURATION_PROBE_ARGS = (videoPath: string) => [
  "-v",
  "error",
  "-show_entries",
  "format=duration",
  "-of",
  "default=noprint_wrappers=1:nokey=1",
  videoPath,
];

/** Container-declared source dimensions and frame rate; null when ffprobe rejects the media. */
function parseSourceProbe(
  probe: ToolRun,
): { width: number; height: number; fps: number | null } | null {
  if (probe.exitedNonZero) return null;
  return parseSourceStdout(probe.stdout.toString("utf8"));
}

function parseSourceStdout(
  stdout: string,
): { width: number; height: number; fps: number | null } | null {
  const [w, h, rate] = stdout.trim().split(",");
  const width = Number(w);
  const height = Number(h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  let fps: number | null = null;
  if (rate !== undefined && rate.includes("/")) {
    const [num, den] = rate.split("/").map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den! > 0 && num! > 0) fps = num! / den!;
  }
  return { width, height, fps };
}

function measureBorderRing(
  pixelMean: Float64Array,
  pixelStd: Float64Array,
): { temporalStd: number; meanLuma: number } {
  let stdSum = 0;
  let lumaSum = 0;
  let count = 0;
  for (let r = 0; r < STAT_HEIGHT; r += 1) {
    for (let c = 0; c < STAT_WIDTH; c += 1) {
      const onRing =
        r < RING_THICKNESS ||
        r >= STAT_HEIGHT - RING_THICKNESS ||
        c < RING_THICKNESS ||
        c >= STAT_WIDTH - RING_THICKNESS;
      if (!onRing) continue;
      const i = r * STAT_WIDTH + c;
      stdSum += pixelStd[i]!;
      lumaSum += pixelMean[i]!;
      count += 1;
    }
  }
  return { temporalStd: stdSum / count, meanLuma: lumaSum / count };
}

/**
 * 4-connected components of temporally frozen pixels whose bounding box lies
 * entirely in the bottom third of the raster; per component, the spatial std
 * of the temporal-mean luma inside it (a text graphic has high contrast, a
 * frozen patch of court does not).
 */
function findBottomFrozenComponents(
  pixelMean: Float64Array,
  pixelStd: Float64Array,
): Array<{ size: number; lumaStd: number }> {
  const frameSize = STAT_WIDTH * STAT_HEIGHT;
  const visited = new Uint8Array(frameSize);
  const components: Array<{ size: number; lumaStd: number }> = [];
  for (let start = 0; start < frameSize; start += 1) {
    if (visited[start] === 1 || pixelStd[start]! > FROZEN_PIXEL_MAX_STD) continue;
    visited[start] = 1;
    const stack = [start];
    const members: number[] = [];
    let minRow = STAT_HEIGHT;
    while (stack.length > 0) {
      const p = stack.pop()!;
      members.push(p);
      const row = Math.floor(p / STAT_WIDTH);
      const col = p % STAT_WIDTH;
      minRow = Math.min(minRow, row);
      const neighbors = [
        row > 0 ? p - STAT_WIDTH : -1,
        row < STAT_HEIGHT - 1 ? p + STAT_WIDTH : -1,
        col > 0 ? p - 1 : -1,
        col < STAT_WIDTH - 1 ? p + 1 : -1,
      ];
      for (const q of neighbors) {
        if (q >= 0 && visited[q] === 0 && pixelStd[q]! <= FROZEN_PIXEL_MAX_STD) {
          visited[q] = 1;
          stack.push(q);
        }
      }
    }
    if (minRow < BOTTOM_THIRD_START_ROW) continue;
    let sum = 0;
    let sumSq = 0;
    for (const p of members) {
      sum += pixelMean[p]!;
      sumSq += pixelMean[p]! ** 2;
    }
    const mean = sum / members.length;
    components.push({
      size: members.length,
      lumaStd: Math.sqrt(Math.max(0, sumSq / members.length - mean * mean)),
    });
  }
  return components;
}

/** Container-declared duration; 0 when ffprobe rejects the media. */
function parseDurationProbe(probe: ToolRun): number {
  if (probe.exitedNonZero) return 0;
  return parseDurationStdout(probe.stdout.toString("utf8"));
}

function parseDurationStdout(stdout: string): number {
  const seconds = Number(stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}
