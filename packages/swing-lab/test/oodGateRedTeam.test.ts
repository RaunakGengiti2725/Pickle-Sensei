import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateFrameAnalyzability } from "@pickle/vision-geometry";
import { extractFrameStats } from "../src/frameStats.js";

/**
 * D3-11 red team: adversarial NEAR-MISS fixtures for the OOD gate — inputs
 * that contain real pickleball imagery but are not phone-on-fence captures.
 * All fixtures are SYNTHETIC, constructed locally with ffmpeg from the
 * committed dev bundle clip wm-volley-02 (never from held-out cases).
 *
 * Case book (Wave D3):
 *  - slideshow of pickleball still photos      -> must be rejected
 *  - pickleball video with 80% letterbox       -> must be rejected
 *  - TV broadcast with static score graphic    -> must be rejected
 *  - 2x-speed playback                          -> KNOWN OPEN gap (documented)
 *  - video of a phone screen playing pickleball -> must be rejected
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const sourceClip = join(root, "datasets", "paddle-bench", "bundles", "wm-volley-02", "clip.mp4");
const dir = mkdtempSync(join(tmpdir(), "ood-redteam-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
}

function gate(path: string) {
  return evaluateFrameAnalyzability(extractFrameStats(path));
}

describe(
  "OOD gate red team: adversarial near-misses (synthetic, from dev clip)",
  { timeout: 60_000 },
  () => {
    it("rejects a slideshow of pickleball still photos (1s per photo)", () => {
      const stills: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const still = join(dir, `slide-${i}.png`);
        ffmpeg(["-ss", String(0.5 + i * 1.2), "-i", sourceClip, "-frames:v", "1", still]);
        stills.push(still);
      }
      const list = join(dir, "slides.txt");
      writeFileSync(list, stills.map((s) => `file '${s}'\nduration 1`).join("\n"));
      const path = join(dir, "slideshow.mp4");
      ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-r", "30", "-pix_fmt", "yuv420p", path]);
      const report = gate(path);
      expect(report.analyzable).toBe(false);
      expect(report.reasons).toContain("still_image_video");
    });

    it("rejects a crossfading slideshow of pickleball still photos", () => {
      const inputs: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        inputs.push("-loop", "1", "-t", "1.5", "-i", join(dir, `slide-${i}.png`));
      }
      const path = join(dir, "slideshow-xfade.mp4");
      ffmpeg([
        ...inputs,
        "-filter_complex",
        "[0][1]xfade=transition=fade:duration=0.5:offset=1[a];" +
          "[a][2]xfade=transition=fade:duration=0.5:offset=2[b];" +
          "[b][3]xfade=transition=fade:duration=0.5:offset=3[c]",
        "-map",
        "[c]",
        "-r",
        "30",
        "-pix_fmt",
        "yuv420p",
        path,
      ]);
      const report = gate(path);
      expect(report.analyzable).toBe(false);
      expect(report.reasons).toContain("still_image_video");
    });

    it("rejects a pickleball video squeezed into 80% letterbox", () => {
      const path = join(dir, "letterbox80.mp4");
      ffmpeg([
        "-i",
        sourceClip,
        "-vf",
        "scale=1280:144,pad=1280:720:0:288:black",
        "-pix_fmt",
        "yuv420p",
        path,
      ]);
      const report = gate(path);
      expect(report.analyzable).toBe(false);
      expect(report.reasons).toContain("letterbox_dominant");
    });

    it("rejects a TV-broadcast simulation with a static score graphic", () => {
      const path = join(dir, "broadcast-scorebug.mp4");
      ffmpeg([
        "-i",
        sourceClip,
        "-vf",
        "drawbox=x=40:y=ih-120:w=420:h=80:color=black@0.85:t=fill," +
          "drawbox=x=44:y=ih-116:w=412:h=72:color=white@0.15:t=2," +
          "drawtext=text='SMITH 7  -  JONES 5':x=60:y=h-96:fontsize=36:fontcolor=white," +
          "drawtext=text='LIVE  PICKLEBALL CHAMPIONSHIP':x=60:y=40:fontsize=24:fontcolor=yellow",
        "-pix_fmt",
        "yuv420p",
        path,
      ]);
      const report = gate(path);
      expect(report.analyzable).toBe(false);
      expect(report.reasons).toContain("static_overlay_suspected");
    });

    it("rejects a video of a phone screen playing pickleball (dark static bezel)", () => {
      const path = join(dir, "phone-screen.mp4");
      ffmpeg([
        "-i",
        sourceClip,
        "-vf",
        "scale=trunc(iw*0.72/2)*2:trunc(ih*0.72/2)*2," +
          "pad=trunc(iw/0.72/2)*2:trunc(ih/0.72/2)*2:(ow-iw)/2:(oh-ih)/2:0x141414," +
          "noise=alls=6:allf=t," +
          "drawbox=x=(iw-iw*0.74)/2:y=(ih-ih*0.74)/2:w=iw*0.74:h=ih*0.74:color=0x303030:t=6",
        "-pix_fmt",
        "yuv420p",
        path,
      ]);
      const report = gate(path);
      expect(report.analyzable).toBe(false);
      expect(report.reasons).toContain("static_border_frame");
    });

    it("KNOWN OPEN GAP: 2x-speed playback passes the frame-statistic gate", () => {
      // Resampled playback is statistically indistinguishable from a normal
      // capture at this raster; the gate declares the gap instead of guessing.
      const path = join(dir, "speed2x.mp4");
      ffmpeg(["-i", sourceClip, "-vf", "setpts=0.5*PTS", "-r", "30", "-an", path]);
      const report = gate(path);
      expect(report.analyzable).toBe(true);
      expect(report.notEvaluated).toContain("playback_speed");
    });
  },
);

describe("OOD gate red team: committed positive corpus still passes", { timeout: 60_000 }, () => {
  const bundles = join(root, "datasets", "paddle-bench", "bundles");
  const committedClips = readdirSync(bundles)
    .map((bundle) => ({ bundle, clip: join(bundles, bundle, "clip.mp4") }))
    .filter(({ clip }) => existsSync(clip));

  it("every committed bundle clip passes the gate", () => {
    // 13 bundles exist; only the committed clips are present on Linux
    // (canonical media is gitignored) — measure all that exist.
    expect(committedClips.length).toBeGreaterThanOrEqual(3);
    for (const { bundle, clip } of committedClips) {
      const report = gate(clip);
      expect(report.analyzable, `${bundle}: ${report.reasons.join(",")}`).toBe(true);
    }
  });

  it(
    "fresh-candidate real footage is not blanket-rejected (coverage floor)",
    { timeout: 120_000 },
    async () => {
      const fresh = join(root, "datasets", "pickleball", "fresh-candidates");
      const files = readdirSync(fresh).filter((f) => f.endsWith(".mp4"));
      expect(files.length).toBeGreaterThanOrEqual(6);
      const rejected: string[] = [];
      for (const f of files) {
        const report = gate(join(fresh, f));
        if (!report.analyzable) rejected.push(`${f}: ${report.reasons.join(",")}`);
        // gate() is synchronous and can take tens of seconds per clip; yield
        // between clips so the vitest worker's RPC channel does not starve.
        await new Promise((resolve) => setImmediate(resolve));
      }
      // yt-iuVdtmGoTbo carries a real static score-graphic overlay; every
      // other candidate must pass. Before the frozen-pair-fraction fix,
      // 5 of 6 were falsely rejected as still_image_video.
      expect(rejected.length).toBeLessThanOrEqual(1);
      for (const entry of rejected) expect(entry).toContain("yt-iuVdtmGoTbo");
    },
  );
});
