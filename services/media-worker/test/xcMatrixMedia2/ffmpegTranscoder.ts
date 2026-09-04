import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ObjectDeleter, WorkerDeps } from "../../src/worker.js";

/**
 * xc-matrix-media-2 harness: a REAL ffmpeg transcoder for the media worker.
 *
 * `services/media-worker/src/main.ts` wires `transcoder: null` (no pipeline in
 * the deployment image), so the worker's transcode branch has never run
 * against actual bytes. This adapter is the minimal honest implementation of
 * the `WorkerDeps.transcoder` contract so the branch CAN be driven with the
 * adversarial corpus:
 *
 *   master bytes (object store) → tmpdir → ffmpeg (normalize 720p h264 +
 *   thumbnail jpg) → derived objects under `${objectKey}/` → tmpdir removed.
 *
 * Temp-dir ownership is explicit (every mkdtemp is recorded) so tests can
 * assert cleanup on success, on failure, on timeout, and when the caller
 * abandons the promise (cancellation).
 */

export class TranscodeError extends Error {
  constructor(
    readonly code: "download_failed" | "ffmpeg_failed" | "timeout" | "no_output",
    message: string,
  ) {
    super(message);
    this.name = "TranscodeError";
  }
}

export interface ByteStore extends ObjectDeleter {
  bytes: Map<string, Buffer>;
  putObject(key: string, data: Buffer): Promise<void>;
  getObject(key: string): Promise<Buffer>;
}

/** In-memory byte-level object store (keys + contents), purge-compatible. */
export class FakeByteStore implements ByteStore {
  bytes = new Map<string, Buffer>();
  deletedKeys: string[] = [];
  /** When set, getObject throws (simulates a storage outage during transcode). */
  failReads: Error | null = null;

  async putObject(key: string, data: Buffer): Promise<void> {
    this.bytes.set(key, data);
  }
  async getObject(key: string): Promise<Buffer> {
    if (this.failReads) throw this.failReads;
    const b = this.bytes.get(key);
    if (!b) throw new Error(`NoSuchKey: ${key}`);
    return b;
  }
  async deleteObject(key: string): Promise<void> {
    this.bytes.delete(key);
    this.deletedKeys.push(key);
  }
  async listObjects(prefix: string): Promise<string[]> {
    return [...this.bytes.keys()].filter((k) => k.startsWith(prefix));
  }
}

export interface TranscoderOptions {
  store: ByteStore;
  tmpRoot: string;
  /** ffmpeg wall-clock budget per invocation. */
  timeoutMs?: number;
  /** Test hook: called after the temp dir is populated, before ffmpeg runs. */
  onBeforeFfmpeg?: (tmpDir: string) => void | Promise<void>;
}

export interface TranscoderStats {
  invocations: number;
  tempDirsCreated: string[];
  ffmpegRuns: number;
  ffmpegMsTotal: number;
  peakRssMb: number;
}

export interface FfmpegTranscoder {
  transcode: NonNullable<WorkerDeps["transcoder"]>;
  stats: TranscoderStats;
  /** Temp dirs recorded by this transcoder that still exist on disk. */
  leakedTempDirs(): string[];
}

function runFfmpeg(args: string[], timeoutMs: number): { ms: number; stderr: string } {
  const started = performance.now();
  const res = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  });
  const ms = performance.now() - started;
  if (res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new TranscodeError("timeout", `ffmpeg exceeded ${timeoutMs} ms`);
  }
  if (res.status !== 0) {
    throw new TranscodeError(
      "ffmpeg_failed",
      `ffmpeg exit=${res.status} signal=${res.signal}: ${(res.stderr ?? "").slice(-1500)}`,
    );
  }
  return { ms, stderr: res.stderr ?? "" };
}

export function createFfmpegTranscoder(opts: TranscoderOptions): FfmpegTranscoder {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const stats: TranscoderStats = {
    invocations: 0,
    tempDirsCreated: [],
    ffmpegRuns: 0,
    ffmpegMsTotal: 0,
    peakRssMb: 0,
  };

  const transcode: NonNullable<WorkerDeps["transcoder"]> = async ({ objectKey }) => {
    stats.invocations++;
    let master: Buffer;
    try {
      master = await opts.store.getObject(objectKey);
    } catch (error) {
      throw new TranscodeError("download_failed", String(error));
    }
    const tmpDir = mkdtempSync(join(opts.tmpRoot, "xc-media2-transcode-"));
    stats.tempDirsCreated.push(tmpDir);
    try {
      // No extension on purpose: ffmpeg picks demuxers by filename extension
      // before content probing (".bin" selects the bintext ANSI-art demuxer and
      // turns any text file into a decodable 640x400 "video").
      const input = join(tmpDir, "master");
      const normalized = join(tmpDir, "normalized.mp4");
      const thumb = join(tmpDir, "thumb.jpg");
      writeFileSync(input, master);
      if (opts.onBeforeFfmpeg) await opts.onBeforeFfmpeg(tmpDir);

      const a = runFfmpeg(
        [
          "-i",
          input,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          "-vf",
          "scale='min(1280,iw)':-2",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-movflags",
          "+faststart",
          normalized,
        ],
        timeoutMs,
      );
      stats.ffmpegRuns++;
      stats.ffmpegMsTotal += a.ms;
      const b = runFfmpeg(
        ["-i", input, "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", thumb],
        timeoutMs,
      );
      stats.ffmpegRuns++;
      stats.ffmpegMsTotal += b.ms;

      if (!existsSync(normalized) || !existsSync(thumb)) {
        throw new TranscodeError(
          "no_output",
          `ffmpeg produced no output: ${readdirSync(tmpDir).join(",")}`,
        );
      }
      const normalizedKey = `${objectKey}/normalized.mp4`;
      const thumbnailKey = `${objectKey}/thumb.jpg`;
      await opts.store.putObject(normalizedKey, readFileSync(normalized));
      await opts.store.putObject(thumbnailKey, readFileSync(thumb));
      stats.peakRssMb = Math.max(stats.peakRssMb, process.memoryUsage().rss / 1024 / 1024);
      return { normalizedKey, thumbnailKey };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  };

  return {
    transcode,
    stats,
    leakedTempDirs: () => stats.tempDirsCreated.filter((d) => existsSync(d)),
  };
}
