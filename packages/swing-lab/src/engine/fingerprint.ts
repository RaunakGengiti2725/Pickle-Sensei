import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * PERCEPTUAL FINGERPRINTS + CLIP-OVERLAP DETECTION.
 *
 * Cryptographic hashes only catch byte-identical duplication. Real leakage
 * arrives as re-encodes and time-cuts of the same recording landing in
 * different splits. Each recording gets a temporal dHash sequence (64-bit
 * difference hash of a 9×8 grayscale downsample, 1 frame/second); overlap
 * detection slides the shorter sequence over the longer one and reports
 * aligned stretches whose mean Hamming distance is far below chance.
 *
 * KNOWN LIMITATION (recorded, deliberate): spatial crops defeat dHash —
 * those must be caught by declared lineage at registration time. The audit
 * therefore merges BOTH signals and alarms on detected-but-undeclared
 * overlap, the dangerous case.
 */

export const FINGERPRINT_ALGO = "dhash64-9x8-gray@1fps" as const;

export interface Fingerprint {
  algo: typeof FINGERPRINT_ALGO;
  /** One 16-hex-char dHash per sampled second. */
  hashes: string[];
}

export function computeFingerprint(videoPath: string): Fingerprint {
  // 9x8 gray frames, 1fps, raw bytes: each frame = 72 bytes.
  const raw = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", videoPath, "-vf", "fps=1,scale=9:8", "-pix_fmt", "gray", "-f", "rawvideo", "-"],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  const hashes: string[] = [];
  for (let offset = 0; offset + 72 <= raw.length; offset += 72) {
    let bits = 0n;
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const left = raw[offset + row * 9 + col]!;
        const right = raw[offset + row * 9 + col + 1]!;
        bits = (bits << 1n) | (left > right ? 1n : 0n);
      }
    }
    hashes.push(bits.toString(16).padStart(16, "0"));
  }
  return { algo: FINGERPRINT_ALGO, hashes };
}

export function fingerprintPath(fingerprintsDir: string, recordingId: string): string {
  return join(fingerprintsDir, `${recordingId}.json`);
}

export function loadFingerprint(fingerprintsDir: string, recordingId: string): Fingerprint | null {
  const path = fingerprintPath(fingerprintsDir, recordingId);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Fingerprint) : null;
}

export function saveFingerprint(fingerprintsDir: string, recordingId: string, fingerprint: Fingerprint): void {
  writeFileSync(fingerprintPath(fingerprintsDir, recordingId), JSON.stringify(fingerprint));
}

function hamming64(hexA: string, hexB: string): number {
  let xor = BigInt(`0x${hexA}`) ^ BigInt(`0x${hexB}`);
  let count = 0;
  while (xor) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

export interface OverlapMatch {
  /** Offset (seconds) of the shorter clip inside the longer one. */
  offsetSec: number;
  alignedSeconds: number;
  meanHamming: number;
}

/**
 * Best alignment of B (shorter) inside A (longer). Random 64-bit hashes have
 * expected Hamming 32; re-encodes of the same content sit well under 12.
 */
export function detectOverlap(
  a: Fingerprint,
  b: Fingerprint,
  { maxMeanHamming = 12, minAligned = 4 }: { maxMeanHamming?: number; minAligned?: number } = {},
): OverlapMatch | null {
  const [long, short, invert] =
    a.hashes.length >= b.hashes.length ? [a.hashes, b.hashes, false] : [b.hashes, a.hashes, true];
  if (short.length < minAligned) return null;
  let best: OverlapMatch | null = null;
  for (let offset = 0; offset <= long.length - minAligned; offset += 1) {
    const aligned = Math.min(short.length, long.length - offset);
    if (aligned < minAligned) break;
    let total = 0;
    for (let index = 0; index < aligned; index += 1) {
      total += hamming64(long[offset + index]!, short[index]!);
    }
    const mean = total / aligned;
    if (mean <= maxMeanHamming && (!best || mean < best.meanHamming)) {
      best = { offsetSec: invert ? -offset : offset, alignedSeconds: aligned, meanHamming: Number(mean.toFixed(2)) };
    }
  }
  return best;
}
