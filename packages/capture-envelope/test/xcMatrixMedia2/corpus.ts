import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * xc-matrix-media-2: deterministic adversarial media corpus.
 *
 * Every case is (re)generated locally with ffmpeg + byte surgery at run time
 * from a fixed recipe, so a failing case is replayable from its `recipe`
 * string alone. Nothing here is committed as binary. Categories:
 *
 *  - baseline           : known-good references (with/without audio)
 *  - corrupted          : random bytes, zeroed mdat, patched fourcc, junk tails
 *  - truncated          : cut at 50% / header only / tail chop, moov-first and moov-last
 *  - wrong_extension    : container/extension mismatch in both directions
 *  - unsupported_codec  : unknown fourcc, codecs a phone pipeline never emits
 *  - missing_audio      : video-only, audio-only, wav/m4a renamed
 *  - unusual_metadata   : rotation tags (45/-90/450/garbage), degenerate dims,
 *                         single frame, multi video stream, negative pts,
 *                         10-bit HEVC, GIF/PNG "videos"
 */

export type CorpusCategory =
  | "baseline"
  | "corrupted"
  | "truncated"
  | "wrong_extension"
  | "unsupported_codec"
  | "missing_audio"
  | "unusual_metadata";

/** What a well-behaved consumer is expected to do with the file. */
export type ExpectedDisposition =
  /** Probe + measurement succeed; envelope decision is up to the thresholds. */
  | "decodable"
  /** ffprobe/ffmpeg must reject it with a typed error (no crash, no hang). */
  | "typed_reject"
  /** Metadata probes but pixel decode may partially/fully fail; must not hang or false-pass. */
  | "degenerate";

export interface CorpusCase {
  id: string;
  category: CorpusCategory;
  /** File name INCLUDING the (possibly lying) extension. */
  fileName: string;
  /** Human-replayable description of exactly how the bytes were produced. */
  recipe: string;
  expected: ExpectedDisposition;
  /** Declared upload content type a client would claim for this file. */
  claimedContentType: string;
  /**
   * Matroska/WebM muxers write a random 128-bit SegmentUID even under
   * -fflags +bitexact (ffmpeg 4.4), so the container bytes differ between
   * generations while the elementary streams are identical. Such cases are
   * compared via `ffmpeg -f streamhash` instead of file sha256.
   */
  containerBytesRandom?: true;
}

export interface GeneratedCase extends CorpusCase {
  path: string;
  bytes: number;
  sha256: string;
}

export interface CorpusManifest {
  generatedAt: string;
  ffmpegVersion: string;
  seed: number;
  cases: GeneratedCase[];
}

export const CORPUS_SEED = 0x5eed_2026;

/** Per-stream SHA-256 of the packet payloads (container-independent identity). */
export function streamHash(path: string): string {
  const out = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", path, "-map", "0", "-c", "copy", "-f", "streamhash", "-"],
    {
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  if (out.status !== 0) throw new Error(`streamhash failed for ${path}: ${out.stderr}`);
  return out.stdout.trim();
}

export function hasFfmpeg(): boolean {
  return (
    spawnSync("ffmpeg", ["-version"]).status === 0 &&
    spawnSync("ffprobe", ["-version"]).status === 0
  );
}

export function ffmpegVersion(): string {
  const out = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  return (out.stdout ?? "").split("\n")[0] ?? "unknown";
}

function ffmpeg(args: string[]): void {
  // bitexact: no wall-clock/random muxer fields (matroska SegmentUID, DateUTC) so sha256 is replayable.
  execFileSync(
    "ffmpeg",
    ["-v", "error", "-y", "-fflags", "+bitexact", "-flags", "+bitexact", ...args],
    {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 120_000,
    },
  );
}

/** xorshift32 — deterministic junk bytes for the "random garbage" cases. */
function junk(seed: number, length: number): Buffer {
  let x = seed >>> 0 || 1;
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function testsrc(size: string, rate: number, duration: number): string {
  return `testsrc2=size=${size}:rate=${rate}:duration=${duration}`;
}

const H264 = ["-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-g", "30"];

function makeBase(
  path: string,
  opts: { audio: boolean; faststart?: boolean; size?: string; rate?: number; duration?: number },
): void {
  const args = [
    "-f",
    "lavfi",
    "-i",
    testsrc(opts.size ?? "1280x720", opts.rate ?? 30, opts.duration ?? 3),
  ];
  if (opts.audio) {
    args.push(
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${opts.duration ?? 3}`,
      "-c:a",
      "aac",
      "-b:a",
      "64k",
    );
  }
  args.push(...H264);
  if (opts.faststart) args.push("-movflags", "+faststart");
  args.push("-shortest", path);
  ffmpeg(args);
}

function truncateTo(src: string, dest: string, keepBytes: number): void {
  const buf = readFileSync(src);
  writeFileSync(dest, buf.subarray(0, Math.max(0, Math.min(buf.length, keepBytes))));
}

function patchFourcc(src: string, dest: string, from: string, to: string): number {
  const buf = Buffer.from(readFileSync(src));
  let count = 0;
  let idx = buf.indexOf(from, 0, "latin1");
  while (idx !== -1) {
    buf.write(to, idx, "latin1");
    count++;
    idx = buf.indexOf(from, idx + 4, "latin1");
  }
  writeFileSync(dest, buf);
  return count;
}

/** Zero the payload of the first top-level `mdat` box, keep every other byte. */
function zeroMdat(src: string, dest: string): void {
  const buf = Buffer.from(readFileSync(src));
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    let header = 8;
    if (size === 1 && off + 16 <= buf.length) {
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    }
    if (size === 0) size = buf.length - off;
    if (type === "mdat") {
      buf.fill(0, off + header, Math.min(buf.length, off + size));
      break;
    }
    if (size < 8) break;
    off += size;
  }
  writeFileSync(dest, buf);
}

export const CORPUS_CASES: CorpusCase[] = [
  // ---- baseline
  {
    id: "base_720p30_aac",
    category: "baseline",
    fileName: "base_720p30_aac.mp4",
    recipe: "testsrc2 1280x720@30 3s + sine aac, libx264 yuv420p",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "base_faststart_aac",
    category: "baseline",
    fileName: "base_faststart_aac.mp4",
    recipe: "same as base_720p30_aac with -movflags +faststart (moov before mdat)",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "base_1080x1920_portrait",
    category: "baseline",
    fileName: "base_1080x1920_portrait.mp4",
    recipe: "testsrc2 1080x1920@30 3s, libx264, no audio",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  // ---- corrupted
  {
    id: "empty_file",
    category: "corrupted",
    fileName: "empty_file.mp4",
    recipe: "0-byte file",
    expected: "typed_reject",
    claimedContentType: "video/mp4",
  },
  {
    id: "junk_64k",
    category: "corrupted",
    fileName: "junk_64k.mp4",
    recipe: `xorshift32(seed=${CORPUS_SEED}) 65536 bytes`,
    expected: "typed_reject",
    claimedContentType: "video/mp4",
  },
  {
    id: "junk_ftyp_prefix",
    category: "corrupted",
    fileName: "junk_ftyp_prefix.mp4",
    recipe: "first 32 bytes of a real mp4 (ftyp box) + xorshift32 junk 64KiB",
    expected: "typed_reject",
    claimedContentType: "video/mp4",
  },
  {
    id: "mdat_zeroed_moov_intact",
    category: "corrupted",
    fileName: "mdat_zeroed_moov_intact.mp4",
    recipe: "base_faststart_aac with the mdat payload zero-filled; moov (all metadata) intact",
    expected: "degenerate",
    claimedContentType: "video/mp4",
  },
  {
    id: "avc1_fourcc_patched",
    category: "unsupported_codec",
    fileName: "avc1_fourcc_patched.mp4",
    recipe:
      "base_faststart_aac with every 'avc1' fourcc rewritten to 'zzzz' (unknown video codec, intact container)",
    expected: "degenerate",
    claimedContentType: "video/mp4",
  },
  {
    id: "junk_tail_1mib",
    category: "corrupted",
    fileName: "junk_tail_1mib.mp4",
    recipe: "base_faststart_aac + 1 MiB xorshift32 junk appended after the last box",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "double_concat_mp4",
    category: "corrupted",
    fileName: "double_concat_mp4.mp4",
    recipe: "base_faststart_aac bytes concatenated twice (two ftyp/moov/mdat sequences)",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  // ---- truncated
  {
    id: "trunc_moovlast_50pct",
    category: "truncated",
    fileName: "trunc_moovlast_50pct.mp4",
    recipe: "base_720p30_aac (moov at end) cut to 50% of bytes -> moov missing",
    expected: "typed_reject",
    claimedContentType: "video/mp4",
  },
  {
    id: "trunc_faststart_50pct",
    category: "truncated",
    fileName: "trunc_faststart_50pct.mp4",
    recipe: "base_faststart_aac (moov first) cut to 50% -> mdat truncated, index intact",
    expected: "degenerate",
    claimedContentType: "video/mp4",
  },
  {
    id: "trunc_faststart_tail_100b",
    category: "truncated",
    fileName: "trunc_faststart_tail_100b.mp4",
    recipe: "base_faststart_aac minus last 100 bytes (last samples missing)",
    expected: "degenerate",
    claimedContentType: "video/mp4",
  },
  {
    id: "trunc_moovlast_tail_100b",
    category: "truncated",
    fileName: "trunc_moovlast_tail_100b.mp4",
    recipe:
      "base_720p30_aac minus last 100 bytes (tail of moov — udta/free — cut; ffprobe 4.4 tolerates it)",
    expected: "degenerate",
    claimedContentType: "video/mp4",
  },
  {
    id: "header_only_1k",
    category: "truncated",
    fileName: "header_only_1k.mp4",
    recipe: "first 1024 bytes of base_faststart_aac",
    expected: "typed_reject",
    claimedContentType: "video/mp4",
  },
  // ---- wrong extension / container lies
  {
    id: "png_as_mp4",
    category: "wrong_extension",
    fileName: "png_as_mp4.mp4",
    recipe: "single PNG frame (testsrc2 640x480) written with .mp4 extension",
    expected: "degenerate",
    claimedContentType: "video/mp4",
  },
  {
    id: "gif_as_mp4",
    category: "wrong_extension",
    fileName: "gif_as_mp4.mp4",
    recipe: "animated GIF (testsrc2 320x240@10 2s) written with .mp4 extension",
    expected: "degenerate",
    claimedContentType: "video/mp4",
  },
  {
    id: "mkv_as_mp4",
    category: "wrong_extension",
    fileName: "mkv_as_mp4.mp4",
    recipe: "matroska container (h264 + aac) written with .mp4 extension",
    expected: "decodable",
    claimedContentType: "video/mp4",
    containerBytesRandom: true,
  },
  {
    id: "mp4_as_txt",
    category: "wrong_extension",
    fileName: "mp4_as_txt.txt",
    recipe: "base_720p30_aac bytes with .txt extension",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "mp4_as_mov",
    category: "wrong_extension",
    fileName: "mp4_as_mov.mov",
    recipe: "base_720p30_aac bytes with .mov extension (claimed video/quicktime)",
    expected: "decodable",
    claimedContentType: "video/quicktime",
  },
  {
    id: "text_as_mp4",
    category: "wrong_extension",
    fileName: "text_as_mp4.mp4",
    recipe: "4 KiB of ASCII text with .mp4 extension",
    expected: "typed_reject",
    claimedContentType: "video/mp4",
  },
  {
    id: "wav_as_mp4",
    category: "wrong_extension",
    fileName: "wav_as_mp4.mp4",
    recipe: "PCM WAV (sine 2s) written with .mp4 extension",
    expected: "typed_reject",
    claimedContentType: "video/mp4",
  },
  {
    id: "jpeg_as_mp4",
    category: "wrong_extension",
    fileName: "jpeg_as_mp4.mp4",
    recipe: "single JPEG frame (testsrc2 1280x720) written with .mp4 extension",
    expected: "degenerate",
    claimedContentType: "video/mp4",
  },
  // ---- unsupported / unusual codecs
  {
    id: "mpeg4_part2_avi",
    category: "unsupported_codec",
    fileName: "mpeg4_part2_avi.avi",
    recipe: "testsrc2 640x480@25 2s encoded mpeg4 (part 2) in AVI",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "hevc_10bit_mp4",
    category: "unsupported_codec",
    fileName: "hevc_10bit_mp4.mp4",
    recipe: "testsrc2 1280x720@30 2s libx265 yuv420p10le (HDR-style 10-bit)",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "prores_mov",
    category: "unsupported_codec",
    fileName: "prores_mov.mov",
    recipe: "testsrc2 1280x720@30 2s prores_ks in QuickTime",
    expected: "decodable",
    claimedContentType: "video/quicktime",
  },
  {
    id: "vp9_webm_as_mp4",
    category: "unsupported_codec",
    fileName: "vp9_webm_as_mp4.mp4",
    recipe: "testsrc2 640x360@30 2s libvpx-vp9 in webm, .mp4 extension",
    expected: "decodable",
    claimedContentType: "video/mp4",
    containerBytesRandom: true,
  },
  {
    id: "rawvideo_yuv_as_mp4",
    category: "unsupported_codec",
    fileName: "rawvideo_yuv_as_mp4.mp4",
    recipe: "raw yuv420p frames (no container) 320x240 10 frames, .mp4 extension",
    expected: "typed_reject",
    claimedContentType: "video/mp4",
  },
  // ---- audio present/absent
  {
    id: "video_only_no_audio",
    category: "missing_audio",
    fileName: "video_only_no_audio.mp4",
    recipe: "testsrc2 1280x720@30 3s libx264, no audio stream",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "audio_only_mp4",
    category: "missing_audio",
    fileName: "audio_only_mp4.mp4",
    recipe: "sine 3s aac in mp4, no video stream",
    expected: "typed_reject",
    claimedContentType: "video/mp4",
  },
  {
    id: "audio_only_m4a_as_mp4",
    category: "missing_audio",
    fileName: "audio_only_m4a_as_mp4.mp4",
    recipe: "sine 3s aac in ipod/m4a container, .mp4 extension",
    expected: "typed_reject",
    claimedContentType: "video/mp4",
  },
  {
    id: "audio_stream_truncated",
    category: "missing_audio",
    fileName: "audio_stream_truncated.mp4",
    recipe: "video 3s + audio only 1s (sine duration=1, no -shortest)",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "silent_audio_track",
    category: "missing_audio",
    fileName: "silent_audio_track.mp4",
    recipe: "video 3s + anullsrc aac silent track",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  // ---- unusual metadata
  {
    id: "rotate_45",
    category: "unusual_metadata",
    fileName: "rotate_45.mp4",
    recipe: "base_720p30_aac stream-copied with -metadata:s:v:0 rotate=45",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "rotate_minus90",
    category: "unusual_metadata",
    fileName: "rotate_minus90.mp4",
    recipe: "base_720p30_aac stream-copied with -metadata:s:v:0 rotate=-90",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "rotate_450",
    category: "unusual_metadata",
    fileName: "rotate_450.mp4",
    recipe: "base_720p30_aac stream-copied with -metadata:s:v:0 rotate=450",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "rotate_garbage",
    category: "unusual_metadata",
    fileName: "rotate_garbage.mp4",
    recipe: "base_720p30_aac stream-copied with -metadata:s:v:0 rotate=abc",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "single_frame",
    category: "unusual_metadata",
    fileName: "single_frame.mp4",
    recipe: "testsrc2 1280x720@30 -frames:v 1 libx264 (duration ~33ms)",
    expected: "degenerate",
    claimedContentType: "video/mp4",
  },
  {
    id: "extreme_aspect_1000x2",
    category: "unusual_metadata",
    fileName: "extreme_aspect_1000x2.mp4",
    recipe: "testsrc2 1000x2@30 2s libx264 (long side 1000, short side 2)",
    expected: "degenerate",
    claimedContentType: "video/mp4",
  },
  {
    id: "extreme_aspect_2x1000",
    category: "unusual_metadata",
    fileName: "extreme_aspect_2x1000.mp4",
    recipe: "testsrc2 2x1000@30 2s libx264 (portrait sliver)",
    expected: "degenerate",
    claimedContentType: "video/mp4",
  },
  {
    id: "tiny_16x16",
    category: "unusual_metadata",
    fileName: "tiny_16x16.mp4",
    recipe: "testsrc2 16x16@30 2s libx264",
    expected: "degenerate",
    claimedContentType: "video/mp4",
  },
  {
    id: "odd_dims_641x361_mpeg4",
    category: "unusual_metadata",
    fileName: "odd_dims_641x361_mpeg4.mp4",
    recipe: "testsrc2 641x361@30 2s mpeg4 (odd dimensions)",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "two_video_streams",
    category: "unusual_metadata",
    fileName: "two_video_streams.mp4",
    recipe: "v:0 = testsrc2 64x64@5 2s, v:1 = testsrc2 1280x720@30 2s, both libx264 in one mp4",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "two_video_streams_luma",
    category: "unusual_metadata",
    fileName: "two_video_streams_luma.mp4",
    recipe:
      "v:0 = color=black 64x64@5 3s, v:1 = color=white 1280x720@30 3s (luma reveals which stream was decoded)",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "negative_start_pts",
    category: "unusual_metadata",
    fileName: "negative_start_pts.mp4",
    recipe: "base_720p30_aac remuxed with -output_ts_offset -1 (start pts before zero)",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "fps_1000_declared",
    category: "unusual_metadata",
    fileName: "fps_1000_declared.mp4",
    recipe:
      "base_720p30_aac stream-copied with -r 1000 on output (declared 1000fps, real 30 frames/s)",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "fps_1_declared",
    category: "unusual_metadata",
    fileName: "fps_1_declared.mp4",
    recipe: "testsrc2 1280x720@30 3s re-timed via setpts=30*PTS -> 1 fps, 90s declared duration",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
  {
    id: "long_metadata_strings",
    category: "unusual_metadata",
    fileName: "long_metadata_strings.mp4",
    recipe:
      "base_720p30_aac stream-copied with 8 KiB title/comment/handler_name tags and a 2 KiB rotate tag",
    expected: "decodable",
    claimedContentType: "video/mp4",
  },
];

export function generateCorpus(outDir: string): CorpusManifest {
  mkdirSync(outDir, { recursive: true });
  const p = (name: string) => join(outDir, name);
  const base = p("base_720p30_aac.mp4");
  const fast = p("base_faststart_aac.mp4");

  makeBase(base, { audio: true });
  makeBase(fast, { audio: true, faststart: true });
  makeBase(p("base_1080x1920_portrait.mp4"), { audio: false, size: "1080x1920" });

  // corrupted
  writeFileSync(p("empty_file.mp4"), Buffer.alloc(0));
  writeFileSync(p("junk_64k.mp4"), junk(CORPUS_SEED, 65536));
  writeFileSync(
    p("junk_ftyp_prefix.mp4"),
    Buffer.concat([readFileSync(base).subarray(0, 32), junk(CORPUS_SEED ^ 1, 65536)]),
  );
  zeroMdat(fast, p("mdat_zeroed_moov_intact.mp4"));
  patchFourcc(fast, p("avc1_fourcc_patched.mp4"), "avc1", "zzzz");
  writeFileSync(
    p("junk_tail_1mib.mp4"),
    Buffer.concat([readFileSync(fast), junk(CORPUS_SEED ^ 2, 1 << 20)]),
  );
  writeFileSync(
    p("double_concat_mp4.mp4"),
    Buffer.concat([readFileSync(fast), readFileSync(fast)]),
  );

  // truncated
  const baseLen = statSync(base).size;
  const fastLen = statSync(fast).size;
  truncateTo(base, p("trunc_moovlast_50pct.mp4"), Math.floor(baseLen / 2));
  truncateTo(fast, p("trunc_faststart_50pct.mp4"), Math.floor(fastLen / 2));
  truncateTo(fast, p("trunc_faststart_tail_100b.mp4"), fastLen - 100);
  truncateTo(base, p("trunc_moovlast_tail_100b.mp4"), baseLen - 100);
  truncateTo(fast, p("header_only_1k.mp4"), 1024);

  // wrong extension
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    testsrc("640x480", 30, 1),
    "-frames:v",
    "1",
    "-f",
    "image2",
    "-c:v",
    "png",
    p("png_as_mp4.mp4"),
  ]);
  ffmpeg(["-f", "lavfi", "-i", testsrc("320x240", 10, 2), "-f", "gif", p("gif_as_mp4.mp4")]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    testsrc("1280x720", 30, 2),
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    ...H264,
    "-c:a",
    "aac",
    "-shortest",
    "-f",
    "matroska",
    p("mkv_as_mp4.mp4"),
  ]);
  writeFileSync(p("mp4_as_txt.txt"), readFileSync(base));
  writeFileSync(p("mp4_as_mov.mov"), readFileSync(base));
  writeFileSync(p("text_as_mp4.mp4"), Buffer.from("this is not a video file\n".repeat(160)));
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    p("wav_as_mp4.mp4"),
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    testsrc("1280x720", 30, 1),
    "-frames:v",
    "1",
    "-f",
    "image2",
    "-c:v",
    "mjpeg",
    p("jpeg_as_mp4.mp4"),
  ]);

  // unsupported / unusual codecs
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    testsrc("640x480", 25, 2),
    "-c:v",
    "mpeg4",
    "-f",
    "avi",
    p("mpeg4_part2_avi.avi"),
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    testsrc("1280x720", 30, 2),
    "-pix_fmt",
    "yuv420p10le",
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-x265-params",
    "log-level=error",
    "-tag:v",
    "hvc1",
    p("hevc_10bit_mp4.mp4"),
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    testsrc("1280x720", 30, 2),
    "-c:v",
    "prores_ks",
    "-profile:v",
    "0",
    "-f",
    "mov",
    p("prores_mov.mov"),
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    testsrc("640x360", 30, 2),
    "-c:v",
    "libvpx-vp9",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    "-b:v",
    "500k",
    "-f",
    "webm",
    p("vp9_webm_as_mp4.mp4"),
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    testsrc("320x240", 30, 1),
    "-frames:v",
    "10",
    "-pix_fmt",
    "yuv420p",
    "-f",
    "rawvideo",
    p("rawvideo_yuv_as_mp4.mp4"),
  ]);

  // audio
  makeBase(p("video_only_no_audio.mp4"), { audio: false });
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-c:a",
    "aac",
    "-f",
    "mp4",
    p("audio_only_mp4.mp4"),
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-c:a",
    "aac",
    "-f",
    "ipod",
    p("audio_only_m4a_as_mp4.mp4"),
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    testsrc("1280x720", 30, 3),
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    ...H264,
    "-c:a",
    "aac",
    p("audio_stream_truncated.mp4"),
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    testsrc("1280x720", 30, 3),
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono",
    ...H264,
    "-c:a",
    "aac",
    "-shortest",
    p("silent_audio_track.mp4"),
  ]);

  // unusual metadata
  for (const [name, val] of [
    ["rotate_45", "45"],
    ["rotate_minus90", "-90"],
    ["rotate_450", "450"],
    ["rotate_garbage", "abc"],
  ] as const) {
    ffmpeg(["-i", base, "-c", "copy", "-metadata:s:v:0", `rotate=${val}`, p(`${name}.mp4`)]);
  }
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    testsrc("1280x720", 30, 1),
    "-frames:v",
    "1",
    ...H264,
    p("single_frame.mp4"),
  ]);
  ffmpeg(["-f", "lavfi", "-i", testsrc("1000x2", 30, 2), ...H264, p("extreme_aspect_1000x2.mp4")]);
  ffmpeg(["-f", "lavfi", "-i", testsrc("2x1000", 30, 2), ...H264, p("extreme_aspect_2x1000.mp4")]);
  ffmpeg(["-f", "lavfi", "-i", testsrc("16x16", 30, 2), ...H264, p("tiny_16x16.mp4")]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    testsrc("641x361", 30, 2),
    "-c:v",
    "mpeg4",
    "-q:v",
    "5",
    p("odd_dims_641x361_mpeg4.mp4"),
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    testsrc("64x64", 5, 2),
    "-f",
    "lavfi",
    "-i",
    testsrc("1280x720", 30, 2),
    "-map",
    "0:v",
    "-map",
    "1:v",
    ...H264,
    p("two_video_streams.mp4"),
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=black:size=64x64:rate=5:duration=3",
    "-f",
    "lavfi",
    "-i",
    "color=c=white:size=1280x720:rate=30:duration=3",
    "-map",
    "0:v",
    "-map",
    "1:v",
    ...H264,
    p("two_video_streams_luma.mp4"),
  ]);
  ffmpeg(["-i", base, "-c", "copy", "-output_ts_offset", "-1", p("negative_start_pts.mp4")]);
  ffmpeg(["-i", base, "-c", "copy", "-r", "1000", p("fps_1000_declared.mp4")]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    testsrc("1280x720", 30, 3),
    "-vf",
    "setpts=30*PTS",
    "-r",
    "1",
    ...H264,
    p("fps_1_declared.mp4"),
  ]);
  const longTag = "A".repeat(8192);
  ffmpeg([
    "-i",
    base,
    "-c",
    "copy",
    "-metadata",
    `title=${longTag}`,
    "-metadata",
    `comment=${longTag}`,
    "-metadata:s:v:0",
    `handler_name=${longTag}`,
    "-metadata:s:v:0",
    `rotate=${"9".repeat(2048)}`,
    p("long_metadata_strings.mp4"),
  ]);

  const cases: GeneratedCase[] = CORPUS_CASES.map((c) => {
    const path = p(c.fileName);
    return { ...c, path, bytes: statSync(path).size, sha256: sha256(path) };
  });
  return {
    generatedAt: new Date().toISOString(),
    ffmpegVersion: ffmpegVersion(),
    seed: CORPUS_SEED,
    cases,
  };
}
