import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** ffprobe-backed media validation: a file is not a recording until probed. */

export interface MediaProbe {
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  videoCodec: string;
  container: string;
  bytes: number;
}

export function probeMedia(path: string): MediaProbe {
  const raw = execFileSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw) as {
    format?: { duration?: string; format_name?: string; size?: string };
    streams?: Array<{
      codec_type?: string; codec_name?: string; width?: number; height?: number;
      avg_frame_rate?: string; r_frame_rate?: string;
    }>;
  };
  const video = (parsed.streams ?? []).find((stream) => stream.codec_type === "video");
  if (!video) throw new Error(`no video stream in ${path}`);
  const rate = video.avg_frame_rate && video.avg_frame_rate !== "0/0" ? video.avg_frame_rate : video.r_frame_rate;
  const [num, den] = (rate ?? "0/1").split("/").map(Number);
  return {
    durationMs: Math.round(Number(parsed.format?.duration ?? 0) * 1000),
    fps: den ? Number((num! / den).toFixed(3)) : 0,
    width: video.width ?? 0,
    height: video.height ?? 0,
    videoCodec: video.codec_name ?? "unknown",
    container: (parsed.format?.format_name ?? "unknown").split(",")[0]!,
    bytes: Number(parsed.format?.size ?? 0),
  };
}

/** Streaming SHA-256 (media files are hundreds of MB; never readFileSync). */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolvePromise())
      .on("error", rejectPromise);
  });
  return hash.digest("hex");
}
