import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluateCaptureEnvelope } from "./envelope.js";
import { measureClip, probeClipStream, probeFrameIntervalCv } from "./clipProbe.js";
import { CAPTURE_ENVELOPE_THRESHOLDS_VERSION } from "./thresholds.js";

/**
 * f22-rt-envelope-bypass: adversarial attack harness against the
 * capture-envelope checker. Synthesizes clips that are truly
 * DEGRADED/UNSUPPORTED but pass, and good clips that are falsely rejected,
 * using ffmpeg synthesis plus the two committed non-held-out real corpus
 * clips (wm-volley-02, afn-sasebo-rally1). wm-dink-01 and afn-vic-rally1
 * are held out and never opened. Fresh-candidates are holdout material and
 * never opened.
 *
 * Usage: pnpm --filter @pickle/capture-envelope exec tsx src/redteamF22.ts
 * Output: datasets/experiments/wave-f/f22-rt-envelope-bypass-attacks.json
 */

const repoRoot = resolve(import.meta.dirname, "../../..");
const outDir = join(repoRoot, "datasets", "experiments", "wave-f");
mkdirSync(outDir, { recursive: true });
const workDir = join(tmpdir(), `f22-redteam-${Date.now()}`);
mkdirSync(workDir, { recursive: true });

const REAL_CLIPS = {
  "wm-volley-02": join(repoRoot, "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4"),
  "afn-sasebo-rally1": join(repoRoot, "datasets/paddle-bench/bundles/afn-sasebo-rally1/clip.mp4"),
};

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], {
    stdio: ["ignore", "ignore", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

interface AttackResult {
  id: string;
  category: string;
  construction: string;
  trueCondition: string;
  expectedIfDetected: string;
  measured: Record<string, number | null>;
  dimensionStatuses: Record<string, string>;
  overall: string;
  bypass: boolean;
  note?: string | undefined;
}

const results: AttackResult[] = [];

function evaluate(
  id: string,
  category: string,
  clip: string,
  construction: string,
  trueCondition: string,
  expectedIfDetected: string,
  isBypass: (statuses: Record<string, string>, overall: string) => boolean,
  note?: string,
): AttackResult {
  const m = measureClip(clip);
  const verdict = evaluateCaptureEnvelope(m);
  const statuses: Record<string, string> = {};
  for (const d of verdict.dimensions) statuses[d.dimension] = d.status;
  const r: AttackResult = {
    id,
    category,
    construction,
    trueCondition,
    expectedIfDetected,
    measured: {
      shortSidePx:
        m.frameWidthPx !== null && m.frameHeightPx !== null
          ? Math.min(m.frameWidthPx, m.frameHeightPx)
          : null,
      avgFrameRateFps: m.avgFrameRateFps,
      brightnessMeanLuma: m.brightnessMeanLuma,
      brightnessStdLuma: m.brightnessStdLuma,
      laplacianVarianceMedian: m.laplacianVarianceMedian,
      meanAbsFrameDiff: m.meanAbsFrameDiff,
      frameIntervalCv: m.frameIntervalCv,
      clipDurationMs: m.clipDurationMs,
    },
    dimensionStatuses: statuses,
    overall: verdict.overall,
    bypass: isBypass(statuses, verdict.overall),
    note,
  };
  results.push(r);
  console.warn(
    `${r.bypass ? "BYPASS   " : "detected "} ${id}: overall=${r.overall} ` +
      JSON.stringify(statuses),
  );
  return r;
}

function makeBase(path: string, size = "1280x720", rate = 30, duration = 4): void {
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${size}:rate=${rate}:duration=${duration}`,
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    path,
  ]);
}

const base = join(workDir, "base.mp4");
makeBase(base);

// ---------------------------------------------------------------------------
// A1. Motion blur masked by sensor noise: heavy gaussian blur (all real
// detail destroyed) then film-grain noise on top. Laplacian variance responds
// to the noise, not the content.
{
  const clip = join(workDir, "a1-blur-plus-noise.mp4");
  ffmpeg([
    "-i",
    base,
    "-vf",
    "gblur=sigma=12,noise=alls=24:allf=t",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "14",
    clip,
  ]);
  evaluate(
    "a1-blur-plus-noise",
    "motion_blur",
    clip,
    "base -> gblur=sigma=12 (identical to detected D3-07 blur case) -> noise=alls=24:allf=t, crf 14",
    "all scene detail destroyed by sigma-12 blur; only grain remains",
    "motion_blur DEGRADED/UNSUPPORTED",
    (s) => s.motion_blur === "SUPPORTED",
  );
}

// A2. Bimodal exposure: half frame crushed black, half blown white. Mean
// luma sits mid-band while nothing in the frame is usable.
{
  const clip = join(workDir, "a2-bimodal-exposure.mp4");
  ffmpeg([
    "-i",
    base,
    "-vf",
    "split[l][r];[l]crop=iw/2:ih:0:0,lutyuv=y=16[lo];[r]crop=iw/2:ih:iw/2:0,lutyuv=y=235[hi];[lo][hi]hstack",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    clip,
  ]);
  evaluate(
    "a2-bimodal-exposure",
    "brightness",
    clip,
    "left half lutyuv y=16 (crushed), right half lutyuv y=235 (blown), hstack",
    "no usable exposure anywhere in frame; spatial mean is mid-band by construction",
    "brightness DEGRADED/UNSUPPORTED",
    (s) => s.brightness === "SUPPORTED",
  );
}

// A3. Strobing exposure: alternating near-black / near-white frames. The
// temporal mean is mid-band; brightnessStdLuma measures it but no dimension
// consumes it.
{
  const clip = join(workDir, "a3-strobe-exposure.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=0x101010:size=1280x720:rate=30:duration=4",
    "-f",
    "lavfi",
    "-i",
    "color=c=0xebebeb:size=1280x720:rate=30:duration=4",
    "-filter_complex",
    "[0][1]blend=all_expr='if(eq(mod(N,2),0),A,B)'",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    clip,
  ]);
  evaluate(
    "a3-strobe-exposure",
    "brightness",
    clip,
    "blend alternates near-black / near-white full frames per frame N",
    "every individual frame is crushed or blown; temporal mean is mid-band",
    "brightness DEGRADED/UNSUPPORTED",
    (s) => s.brightness === "SUPPORTED",
    "brightnessStdLuma is measured but no threshold dimension consumes it",
  );
}

// A4. Upscale lie: true 240p content upscaled to 1280x720. Resolution
// dimension reads container metadata; sampling normalizes to 320w so the
// upscale is invisible to Laplacian too.
{
  const tiny = join(workDir, "a4-true240p.mp4");
  makeBase(tiny, "426x240");
  const clip = join(workDir, "a4-upscaled-720p.mp4");
  ffmpeg([
    "-i",
    tiny,
    "-vf",
    "scale=1280:720:flags=lanczos",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    clip,
  ]);
  evaluate(
    "a4-upscale-240p-to-720p",
    "resolution",
    clip,
    "426x240 testsrc2 -> lanczos upscale to 1280x720",
    "true optical detail is 240p (UNSUPPORTED band); container says 720p",
    "resolution DEGRADED/UNSUPPORTED",
    (s) => s.resolution === "SUPPORTED",
  );
}

// A5. Tiny player far away: pose dimensions are NOT_MEASURED without a pose
// pass, and NOT_MEASURED never worsens the overall verdict, so a clip whose
// player occupies ~5% of frame height is overall SUPPORTED.
{
  const bgFrame = join(workDir, "a5-bg.png");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-frames:v", "1", bgFrame]);
  const clip = join(workDir, "a5-tiny-subject.mp4");
  ffmpeg([
    "-loop",
    "1",
    "-t",
    "4",
    "-framerate",
    "30",
    "-i",
    bgFrame,
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=64x36:rate=30:duration=4",
    "-filter_complex",
    "[0][1]overlay=x=600:y=340",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    clip,
  ]);
  evaluate(
    "a5-tiny-subject-no-pose",
    "player_pixel_height",
    clip,
    "64x36 moving patch (5% of frame height) composited on a static textured (frozen testsrc2) 720p background",
    "subject far too small for stroke analysis; only pose dims could catch it",
    "player_pixel_height DEGRADED/UNSUPPORTED or overall not SUPPORTED",
    (s, overall) => s.player_pixel_height === "NOT_MEASURED" && overall === "SUPPORTED",
    "structural: overall ignores NOT_MEASURED pose dimensions",
  );
}

// A6. Duplicate PTS / frozen frames: player-visible stalls encoded as
// duplicated timestamps. probeFrameIntervalCv drops non-positive deltas, so
// duplicates are silently excluded from the jitter statistic.
{
  const clip = join(workDir, "a6-dup-pts.mp4");
  ffmpeg([
    "-i",
    base,
    "-vf",
    "setpts=floor(N/2)*2/30/TB",
    "-fps_mode",
    "passthrough",
    "-enc_time_base",
    "1/90000",
    "-video_track_timescale",
    "90000",
    "-c:v",
    "libx264",
    clip,
  ]);
  const info = probeClipStream(clip);
  const cv = probeFrameIntervalCv(clip);
  evaluate(
    "a6-duplicate-pts",
    "timing_stability",
    clip,
    "setpts=floor(N/2)*2/30/TB (every pair of frames shares a PTS), fps_mode passthrough",
    "half of all presentation intervals are zero: playback stutters at 15 effective fps",
    "timing_stability or frame_rate DEGRADED/UNSUPPORTED",
    (s) => s.timing_stability === "SUPPORTED" && s.frame_rate === "SUPPORTED",
    `probe: avgFps=${info.avgFrameRateFps.toFixed(2)}, intervalCv=${cv}`,
  );
}

// A7. Too-few-packets timing bypass: <4 packets yields <3 usable intervals,
// so timing_stability is NOT_MEASURED and cannot worsen the verdict even for
// wildly jittered short bursts. (clip_duration catches sub-1s clips, so this
// needs a low-fps short clip that still passes duration bands... it cannot:
// duration >= 2000ms at 3 packets means <2fps, caught by frame_rate. Probe
// anyway to document the negative.)
{
  const clip = join(workDir, "a7-three-frames.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=1:duration=3",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    clip,
  ]);
  evaluate(
    "a7-three-frame-clip",
    "timing_stability",
    clip,
    "3 frames at 1fps, 3s duration",
    "timing unmeasurable (<3 intervals); is any other dimension catching it?",
    "frame_rate UNSUPPORTED (1fps)",
    (s) => s.frame_rate === "SUPPORTED",
  );
}

// A8. Rotation metadata lie on real portrait-shaped storage: stored
// 480x854 with rotate=90 -> display short side 480 (DEGRADED). If the
// checker used stored dims it would read short side 480 either way here, so
// also test the inverse lie: stored 854x480 landscape claiming rotate=90 ->
// display 480x854, short side still 480. The lie cannot inflate min(w,h);
// document as proven negative for the resolution dimension.
{
  const land = join(workDir, "a8-landscape480.mp4");
  makeBase(land, "854x480");
  const clip = join(workDir, "a8-rot90-lie.mp4");
  ffmpeg(["-i", land, "-c", "copy", "-metadata:s:v:0", "rotate=90", clip]);
  const info = probeClipStream(clip);
  evaluate(
    "a8-rotation-lie-480p",
    "resolution",
    clip,
    "854x480 stream-copied with rotate=90 metadata tag (content not actually rotated)",
    "true short side is 480 regardless of rotation claim",
    "resolution DEGRADED (short side 480)",
    (s) => s.resolution === "SUPPORTED",
    `probe: rotation=${info.rotationDegrees}, display=${info.displayWidth}x${info.displayHeight}`,
  );
}

// A9. Conflicting rotation metadata: legacy rotate tag says 0 but the
// checker must not mis-scale frames when ffmpeg's decoder applies a
// different rotation than probeClipStream reports. Construct 90-rotate tag
// on a 720p landscape clip and verify Laplacian normalization is not
// corrupted (distortion would shift lapvar vs. the correctly-decoded value).
{
  const clip = join(workDir, "a9-rot90-tag-720p.mp4");
  ffmpeg(["-i", base, "-c", "copy", "-metadata:s:v:0", "rotate=90", clip]);
  const info = probeClipStream(clip);
  const plain = measureClip(base);
  const rot = measureClip(clip);
  const lapRatio =
    plain.laplacianVarianceMedian && rot.laplacianVarianceMedian
      ? rot.laplacianVarianceMedian / plain.laplacianVarianceMedian
      : null;
  evaluate(
    "a9-rotation-tag-normalization",
    "motion_blur",
    clip,
    "1280x720 stream-copied with rotate=90 tag; decoder auto-rotates, probe must match",
    "same pixels as base; a probe/decoder rotation mismatch distorts sampling aspect",
    "laplacian within ~15% of base clip's",
    () => (lapRatio !== null ? Math.abs(1 - lapRatio) > 0.15 : true),
    `probe: rotation=${info.rotationDegrees}, display=${info.displayWidth}x${info.displayHeight}, lapRatio=${lapRatio?.toFixed(3)}`,
  );
}

// ---------------------------------------------------------------------------
// FALSE REJECTS: good clips wrongly flagged.

// F1. Sharp but low-texture scene: flat color panels with a moving sharp
// square. Laplacian variance is a TEXTURE statistic, not a blur statistic;
// clean flat scenes measure low and get flagged as motion blur.
{
  const clip = join(workDir, "f1-low-texture-sharp.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=0x707070:size=1280x720:rate=30:duration=4",
    "-f",
    "lavfi",
    "-i",
    "color=c=white:size=120x240:rate=30:duration=4",
    "-filter_complex",
    "[0][1]overlay=x='100+mod(n*8,900)':y=300",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "12",
    clip,
  ]);
  evaluate(
    "f1-low-texture-sharp",
    "motion_blur",
    clip,
    "flat gray field + razor-sharp white 120x240 block translating 8px/frame, crf 12",
    "perfectly sharp footage; scene simply has little texture",
    "motion_blur SUPPORTED (it is sharp)",
    (s) => s.motion_blur !== "SUPPORTED",
    "false-reject probe: bypass=true here means FALSE REJECT",
  );
}

// F2/F3. Real corpus clips (committed, non-held-out): verify the checker
// does not falsely reject known downstream-analyzable footage.
for (const [id, path] of Object.entries(REAL_CLIPS)) {
  if (!existsSync(path)) {
    console.warn(`skip ${id}: clip not present`);
    continue;
  }
  evaluate(
    `real-${id}`,
    "real-corpus-baseline",
    path,
    "committed paddle-bench bundle clip, unmodified",
    "real capture previously measured in C12/E15",
    "no UNSUPPORTED video dimension",
    (s) => Object.entries(s).some(([, status]) => status === "UNSUPPORTED"),
    "false-reject probe on real footage: bypass=true means FALSE REJECT",
  );
}

// F4. Real clip with rotation metadata added (portrait-carried landscape):
// stream copy of wm-volley-02 with rotate=180 must not change any measured
// value materially.
{
  const src = REAL_CLIPS["wm-volley-02"];
  if (existsSync(src)) {
    const clip = join(workDir, "f4-real-rot180.mp4");
    ffmpeg(["-i", src, "-c", "copy", "-metadata:s:v:0", "rotate=180", clip]);
    const a = measureClip(src);
    const b = measureClip(clip);
    const lapDelta =
      a.laplacianVarianceMedian && b.laplacianVarianceMedian
        ? Math.abs(a.laplacianVarianceMedian - b.laplacianVarianceMedian) /
          a.laplacianVarianceMedian
        : null;
    evaluate(
      "f4-real-rot180-consistency",
      "rotation-consistency",
      clip,
      "wm-volley-02 stream-copied with rotate=180 tag",
      "identical pixels; measurements must match the untagged clip",
      "laplacian within 5% of untagged",
      () => (lapDelta !== null ? lapDelta > 0.05 : true),
      `lapDeltaFraction=${lapDelta?.toFixed(4)}`,
    );
  }
}

// A10. Real clip camera-motion masking: crop-zoom jitter simulating a
// violently shaking handheld capture of real footage. v0.2 camera_motion
// supported max 33 was set from subject-motion-heavy good units; check a
// synthetic aggressive shake actually lands above it.
{
  const src = REAL_CLIPS["afn-sasebo-rally1"];
  if (existsSync(src)) {
    const clip = join(workDir, "a10-real-shake.mp4");
    ffmpeg([
      "-i",
      src,
      "-vf",
      "crop=iw-96:ih-96:x='48+40*sin(n*1.7)':y='48+40*cos(n*2.3)',scale=1280:720",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      clip,
    ]);
    evaluate(
      "a10-real-violent-shake",
      "camera_motion",
      clip,
      "afn-sasebo-rally1 with +-40px sinusoidal crop jitter per frame",
      "violent global camera shake on real footage",
      "camera_motion DEGRADED/UNSUPPORTED",
      (s) => s.camera_motion === "SUPPORTED",
    );
  }
}

// A11. Same violent shake on SYNTHETIC lower-contrast content: the
// mean-abs-frame-diff proxy is content-contrast-dependent, so the identical
// ±40px/frame jitter that lands DEGRADED on real footage (a10) measures ~13
// on testsrc2 and passes camera_motion.
{
  const clip = join(workDir, "a11-synthetic-shake.mp4");
  ffmpeg([
    "-i",
    base,
    "-vf",
    "crop=iw-96:ih-96:x='48+40*sin(n*1.7)':y='48+40*cos(n*2.3)',scale=1280:720",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    clip,
  ]);
  evaluate(
    "a11-synthetic-shake",
    "camera_motion",
    clip,
    "testsrc2 base with the same +-40px sinusoidal crop jitter as a10",
    "violent global camera shake on lower-contrast content",
    "camera_motion DEGRADED/UNSUPPORTED",
    (s) => s.camera_motion === "SUPPORTED",
    "contrast-dependence of the frame-diff proxy: identical shake, opposite verdict vs a10",
  );
}

const summary = {
  workstream: "f22-rt-envelope-bypass",
  thresholdsVersion: CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
  date: new Date().toISOString(),
  workDir,
  attacks: results,
  bypassCount: results.filter((r) => r.bypass).length,
};
writeFileSync(
  join(outDir, "f22-rt-envelope-bypass-attacks.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.warn(
  `\n${summary.bypassCount}/${results.length} probes hit; written to wave-f/f22-rt-envelope-bypass-attacks.json`,
);
