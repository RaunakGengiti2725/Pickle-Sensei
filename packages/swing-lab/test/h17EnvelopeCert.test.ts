import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateCaptureEnvelope, measureClip } from "@pickle/capture-envelope";
import { measureH17Probe } from "../src/h17EnvelopeCert.js";

/**
 * Wave-H h17 regression suite: unsupported capture conditions that the
 * pose-free layers CAN measure on Linux must classify out of the supported
 * envelope and fail closed through the pre-analysis gate. These are
 * SYNTHETIC ffmpeg constructions, clearly labeled as such; pose-conditioned
 * conditions (tiny player, cropped limbs, multiple players) are NOT asserted
 * here because pose extraction is unavailable off-device.
 */

const dir = mkdtempSync(join(tmpdir(), "h17-fixtures-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
}

describe("h17 envelope certification: unsupported input fails closed", () => {
  it("black input: envelope UNSUPPORTED and pre-analysis gate rejects", () => {
    const path = join(dir, "black.mp4");
    ffmpeg(["-f", "lavfi", "-i", "color=black:s=1280x720:r=30", "-t", "5", path]);
    const m = measureH17Probe({ id: "black", category: "black_input", path });
    expect(m.envelope?.overall).toBe("UNSUPPORTED");
    expect(m.envelope?.unsupportedDimensions).toContain("brightness");
    expect(m.gateOk).toBe(false);
    expect(m.gateFailureKind).toBe("corrupted_media");
  }, 60_000);

  it("corrupt input: envelope measurement throws (never SUPPORTED) and gate rejects", () => {
    const path = join(dir, "garbage.mp4");
    writeFileSync(path, Buffer.alloc(65536, 0x5a));
    expect(() => evaluateCaptureEnvelope(measureClip(path))).toThrow();
    const m = measureH17Probe({ id: "garbage", category: "corrupt_input", path });
    expect(m.envelope).toBeNull();
    expect(m.envelopeError).not.toBeNull();
    expect(m.gateOk).toBe(false);
    expect(m.frameReasons).toContain("undecodable_media");
  }, 60_000);

  it("dark scene: envelope UNSUPPORTED on brightness", () => {
    const path = join(dir, "dark.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=1280x720:r=30",
      "-vf",
      "eq=brightness=-0.42:saturation=0.3",
      "-t",
      "5",
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
    const m = measureH17Probe({ id: "dark", category: "dark_scene", path });
    expect(m.envelope?.overall).toBe("UNSUPPORTED");
    expect(m.envelope?.unsupportedDimensions).toContain("brightness");
  }, 60_000);

  it("severe blur: envelope UNSUPPORTED on motion_blur", () => {
    const path = join(dir, "blur.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=1280x720:r=30",
      "-vf",
      "boxblur=20:5",
      "-t",
      "5",
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
    const m = measureH17Probe({ id: "blur", category: "severe_blur", path });
    expect(m.envelope?.overall).toBe("UNSUPPORTED");
    expect(m.envelope?.unsupportedDimensions).toContain("motion_blur");
  }, 60_000);

  it("camera obstruction (dominant black occluder): pre-analysis gate rejects", () => {
    const path = join(dir, "obstruction.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=1280x720:r=30",
      "-vf",
      "drawbox=x=0:y=0:w=1280:h=600:color=black:t=fill",
      "-t",
      "5",
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
    const m = measureH17Probe({ id: "obstruction", category: "camera_obstruction", path });
    expect(m.gateOk).toBe(false);
    expect(m.gateFailureKind).toBe("corrupted_media");
    expect(m.envelope?.overall).toBe("UNSUPPORTED");
  }, 60_000);
});
