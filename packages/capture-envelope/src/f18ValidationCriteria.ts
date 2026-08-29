import type { EnvelopeDimension } from "@pickle/shared-types";

/**
 * F18: versioned validation criteria for the capture-envelope thresholds.
 *
 * E15 was a scientific negative: corpus correlation could not validate the
 * bands (9 downstream-good units from only 3 independent sessions; failure
 * ground truth dominated by content failures the envelope does not claim to
 * predict). This spec states, per dimension, what evidence WOULD validate or
 * refute each band, splits each claim into its two independently testable
 * parts, and records which part is runnable on this Linux environment today.
 *
 * Claim decomposition:
 *  - CONSTRUCT validity: the measured proxy actually tracks the physical
 *    quantity the threshold is written against (testable on Linux with
 *    controlled ffmpeg degradations whose ground truth is known by
 *    construction — no downstream analysis or labels needed).
 *  - PREDICTIVE validity: clips inside/outside the band succeed/fail
 *    downstream analysis at materially different rates (requires downstream
 *    reruns — Apple Vision pose extraction, BLOCKED_EXTERNAL on Linux — or a
 *    labeled corpus that spans the band boundary).
 */

export const F18_VALIDATION_CRITERIA_VERSION = "f18-envelope-validation-criteria-v1";

export type CriterionRunnability = "RUNNABLE_LINUX" | "BLOCKED_EXTERNAL" | "NEEDS_CORPUS";

export interface DimensionValidationCriteria {
  dimension: EnvelopeDimension;
  thresholdId: string;
  /** What the band claims, stated so it can be falsified. */
  claim: string;
  constructValidity: {
    test: string;
    validates: string;
    refutes: string;
    runnability: CriterionRunnability;
  };
  predictiveValidity: {
    test: string;
    validates: string;
    refutes: string;
    runnability: CriterionRunnability;
    /** Minimum labeled evidence for the predictive test, grouped by independent session. */
    corpusRequirement: string;
  };
}

export const F18_VALIDATION_CRITERIA: readonly DimensionValidationCriteria[] = [
  {
    dimension: "resolution",
    thresholdId: "resolution-short-side-v0.1",
    claim: "Short side < 720px degrades and < 480px breaks downstream pose/track quality.",
    constructValidity: {
      test: "Downscale ladder (short side native→720→640→480→360→240) on downstream-good units; measured short side must equal the encoded short side exactly and band status must flip exactly at 719/479.",
      validates: "Measured value tracks ground truth 1:1 and band edges bind where written.",
      refutes:
        "Any measured short side deviating from the encoded value (probe reads rotation/storage wrong).",
      runnability: "RUNNABLE_LINUX",
    },
    predictiveValidity: {
      test: "Re-run pose extraction + mining on the downscale ladder; find the short side where track fragmentation/pose loss actually rises.",
      validates:
        "Failure onset within [480, 720] confirms both edges; onset elsewhere refutes the placement.",
      refutes: "Downstream survival at 360px or failure at 720px.",
      runnability: "BLOCKED_EXTERNAL",
      corpusRequirement:
        "Alternatively ≥10 labeled units per bin {<480, 480–719, ≥720} from ≥5 independent sessions each; corpus has zero labeled units below 720.",
    },
  },
  {
    dimension: "frame_rate",
    thresholdId: "frame-rate-avg-v0.2",
    claim: "avg fps ≥ 24 is analyzable; 15–23 degrades; < 15 breaks event/contact timing.",
    constructValidity: {
      test: "fps-decimation ladder (24→20→15→12→10→8) on downstream-good units; measured avg fps must equal the target within container rounding, and band status must flip exactly at 23.x/14.x.",
      validates: "Probe's avg_frame_rate tracks true decoded rate across containers.",
      refutes: "Measured fps diverging from encoded fps.",
      runnability: "RUNNABLE_LINUX",
    },
    predictiveValidity: {
      test: "Re-run downstream analysis on the fps ladder of known-good clips; locate the fps where contact-timing error/event recall actually collapses.",
      validates:
        "Collapse onset in [15, 24) confirms the degraded band; survival at 12 or collapse at 24 refutes it.",
      refutes: "Downstream completion at 8–12 fps or failure at 24 fps.",
      runnability: "BLOCKED_EXTERNAL",
      corpusRequirement:
        "Alternatively ≥10 labeled units per bin {<15, 15–23, ≥24} from ≥5 sessions each; corpus has zero labeled real clips between 8 and 24 fps.",
    },
  },
  {
    dimension: "brightness",
    thresholdId: "brightness-mean-luma-v0.1",
    claim:
      "Mean luma inside [60, 200] is analyzable; [40, 220] degraded; outside breaks detection.",
    constructValidity: {
      test: "eq=brightness shift ladder (±0.1/±0.2/±0.3 normalized) on downstream-good units; measured mean luma must move monotonically with the injected shift (≈255·shift before clipping) and cross the 60/200 edges where arithmetic predicts.",
      validates: "Luma probe responds monotonically and predictably to real exposure change.",
      refutes: "Non-monotonic or unresponsive measured luma under known injected shifts.",
      runnability: "RUNNABLE_LINUX",
    },
    predictiveValidity: {
      test: "Downstream reruns on the brightness ladder; find the luma where pose/ball detection actually fails.",
      validates:
        "Failure onset outside [60, 200] on both tails confirms; failure inside or survival far outside refutes.",
      refutes: "Downstream survival at luma < 40 or > 220, or failure inside [60, 200].",
      runnability: "BLOCKED_EXTERNAL",
      corpusRequirement:
        "Alternatively ≥10 labeled units per tail bin {<60, >200} from ≥5 sessions; corpus luma range on labeled units is entirely inside the supported band.",
    },
  },
  {
    dimension: "exposure_clipping",
    thresholdId: "clipped-pixel-fraction-v0.1",
    claim:
      "Clipped-pixel fraction ≤ 0.3 is analyzable; 0.3–0.6 degraded; above, too much of the frame is crushed/blown to carry signal.",
    constructValidity: {
      test: "lutyuv crush/blow ladder covering a known fraction of the frame (0/25/50/75/100%) on downstream-good units; the measured clipped fraction must track the constructed fraction within sampling error.",
      validates: "The probe counts actually-clipped pixels, not a proxy.",
      refutes: "Measured fraction deviating materially from the constructed fraction.",
      runnability: "RUNNABLE_LINUX",
    },
    predictiveValidity: {
      test: "Downstream reruns on the partial-clipping ladder; find the clipped fraction where detection actually fails.",
      validates: "Failure onset in (0.3, 0.6] confirms both edges.",
      refutes: "Downstream survival above 0.6 or failure below 0.3.",
      runnability: "BLOCKED_EXTERNAL",
      corpusRequirement:
        "≥10 labeled units per bin {≤0.3, 0.3–0.6, >0.6} from ≥5 sessions; g06 measured genuine footage ≤ 0.051 (n=3 real clips) — band placement rests on synthetic attacks only.",
    },
  },
  {
    dimension: "exposure_stability",
    thresholdId: "brightness-std-luma-v0.1",
    claim:
      "Std of per-frame mean luma ≤ 40 is stable exposure; 40–80 degraded; above, exposure strobing breaks temporal analysis.",
    constructValidity: {
      test: "Alternating-frame luma-shift ladder with known amplitude (0/10/25/50/100 luma) on downstream-good units; measured std must rise monotonically with the injected amplitude.",
      validates: "The std proxy tracks constructed temporal exposure instability.",
      refutes: "Non-monotonic std under increasing injected strobing.",
      runnability: "RUNNABLE_LINUX",
    },
    predictiveValidity: {
      test: "Downstream reruns on the strobing ladder; find the std where tracking actually fails.",
      validates: "Failure onset in (40, 80] confirms both edges.",
      refutes: "Downstream survival above 80 or failure below 40.",
      runnability: "BLOCKED_EXTERNAL",
      corpusRequirement:
        "≥10 labeled units per bin {≤40, 40–80, >80} from ≥5 sessions; g06 measured genuine footage ≤ 2.3 (n=3 real clips) — band placement rests on synthetic attacks only.",
    },
  },
  {
    dimension: "motion_blur",
    thresholdId: "laplacian-variance-320long-median-v0.2",
    claim: "Median Laplacian variance @320long ≥ 100 is sharp; 30–99 degraded; < 30 too blurred.",
    constructValidity: {
      test: "Gaussian-blur ladder (sigma@320w 0.5→1→2→4) on downstream-good units; measured Laplacian variance must decrease strictly monotonically with sigma, and the sigma at which each unit crosses 100/30 is recorded.",
      validates: "The proxy orders real blur severities correctly on real footage.",
      refutes: "Non-monotonic variance under increasing injected blur.",
      runnability: "RUNNABLE_LINUX",
    },
    predictiveValidity: {
      test: "Downstream reruns on the blur ladder; find the variance at which paddle/ball tracking actually degrades.",
      validates: "Failure onset in [30, 100) confirms both edges.",
      refutes: "Downstream survival below variance 30 or failure above 100.",
      runnability: "BLOCKED_EXTERNAL",
      corpusRequirement:
        "Alternatively ≥10 labeled units per bin {<30, 30–99, ≥100} from ≥5 sessions; every labeled corpus unit measured ≥ 100.",
    },
  },
  {
    dimension: "sensor_noise",
    thresholdId: "denoise-survival-ratio-v0.1",
    claim:
      "Denoise-survival ratio ≥ 0.25 indicates genuine detail; 0.15–0.25 degraded; below, the Laplacian energy is noise, not detail.",
    constructValidity: {
      test: "Grain-injection ladder (noise=alls 0/6/12/24 temporal) on downstream-good units; the measured ratio must fall monotonically with injected grain while clean-content controls stay high.",
      validates: "The ratio separates injected grain from genuine scene detail.",
      refutes: "Clean real footage measuring below grained synthetic footage.",
      runnability: "RUNNABLE_LINUX",
    },
    predictiveValidity: {
      test: "Downstream ball-candidate reruns across the grain ladder; find the ratio where the candidate stage floods (g06 measured 39.93 cands/frame at ratio 0.126).",
      validates: "Flooding onset in [0.15, 0.25) confirms both edges.",
      refutes: "Downstream survival below 0.15 or flooding above 0.25.",
      runnability: "RUNNABLE_LINUX",
      corpusRequirement:
        "≥10 labeled units per bin from ≥5 sessions; g06 measured real footage 0.339–0.357 (n=3 real clips) — the supported floor rests on that small sample plus synthetic attacks.",
    },
  },
  {
    dimension: "camera_motion",
    thresholdId: "global-frame-diff-320long-v0.3",
    claim:
      "Mean abs frame diff @320w ≤ 33 indicates a stable-enough camera; 34–46 degraded; > 46 unsupported. Implicit construct claim: the proxy measures CAMERA motion.",
    constructValidity: {
      test: "Inject known global camera motion (sinusoidal crop-path pan, amplitude 0/1/2/4/8/16 px @320w, 1.5 Hz) into downstream-good units; compare measured diff against each unit's own zero-injection control and against the subject-motion-only control range across units.",
      validates:
        "Measured diff separates injected-camera-motion clips from subject-motion-only controls at some amplitude below the supported edge.",
      refutes:
        "Subject-motion-only controls spanning the supported edge, or realistic handheld amplitudes (1–4 px @320w) remaining inside the control range — the proxy then cannot distinguish camera from subject motion and the band is construct-invalid regardless of placement.",
      runnability: "RUNNABLE_LINUX",
    },
    predictiveValidity: {
      test: "Downstream reruns on the injected-pan ladder; find the amplitude where tracking actually breaks, then map it through the proxy.",
      validates: "Breakage onset mapping to diff ≈ 33–46 confirms; otherwise refutes.",
      refutes: "Tracking survival at diff > 46 or breakage at diff < 33.",
      runnability: "BLOCKED_EXTERNAL",
      corpusRequirement:
        "Alternatively ≥10 labeled units per bin {≤33, 34–46, >46} from ≥5 sessions with known camera-mount type; corpus has 9 good units from 3 sessions, none above 33.",
    },
  },
  {
    dimension: "camera_shake",
    thresholdId: "contrast-normalized-frame-diff-v0.1",
    claim:
      "Contrast-normalized frame diff ≤ 0.18 indicates a stable camera; 0.18–0.45 degraded; above, global shake breaks tracking. Construct claim: dividing by spatial std removes the content-contrast dependence that defeats camera_motion.",
    constructValidity: {
      test: "Apply the identical crop-jitter shake to low-contrast synthetic and high-contrast real content; the normalized metric must move both clips out of the supported band while their raw diffs diverge (g06: 3.7x/3.9x shaken/unshaken ratios vs raw diffs 13.05 and 35.51).",
      validates: "The normalized proxy responds to camera motion independent of content contrast.",
      refutes:
        "Content classes whose unshaken normalized diff exceeds shaken values — g06 already observed a sharp low-texture scene at 0.193 (inside the degraded band unshaken), so the supported edge is content-sensitive at low spatial contrast.",
      runnability: "RUNNABLE_LINUX",
    },
    predictiveValidity: {
      test: "Downstream reruns across a shake-amplitude ladder; find the normalized diff where tracking actually breaks.",
      validates: "Breakage onset in (0.18, 0.45] confirms both edges.",
      refutes: "Tracking survival above 0.45 or breakage below 0.18.",
      runnability: "BLOCKED_EXTERNAL",
      corpusRequirement:
        "≥10 labeled units per bin {≤0.18, 0.18–0.45, >0.45} from ≥5 sessions with known mount type; g06 evidence is 2 shaken constructions + 3 real clips.",
    },
  },
  {
    dimension: "timing_stability",
    thresholdId: "timing-stability-interval-cv-v0.2",
    claim: "Frame-interval CV ≤ 0.15 is stable; 0.16–0.35 degraded; > 0.35 unsupported.",
    constructValidity: {
      test: "Requires re-muxing clips with controlled PTS jitter; ffmpeg 4.4.2 lacks a per-packet timestamp-jitter path that preserves decodability (setts bsf not available), so no trustworthy injection exists here.",
      validates: "n/a this wave",
      refutes: "n/a this wave",
      runnability: "NEEDS_CORPUS",
    },
    predictiveValidity: {
      test: "Labeled VFR clips (phone captures) spanning CV 0.15–0.5 with downstream outcomes.",
      validates: "Failure rate rising across the 0.15/0.35 edges.",
      refutes: "Downstream survival at CV > 0.35.",
      runnability: "NEEDS_CORPUS",
      corpusRequirement:
        "≥10 labeled VFR units per bin {≤0.15, 0.16–0.35, >0.35} from ≥5 sessions; all current labeled units are CFR broadcast/DVIDS footage with CV ≈ 0.",
    },
  },
  {
    dimension: "clip_duration",
    thresholdId: "clip-duration-v0.1",
    claim: "2–90 s clips are analyzable; 1–2 s or 90–180 s degraded; outside unsupported.",
    constructValidity: {
      test: "Duration is read directly from the container/window — construct validity is definitional (verified incidentally by every windowed measurement in E15).",
      validates: "Measured duration equals window length.",
      refutes: "n/a",
      runnability: "RUNNABLE_LINUX",
    },
    predictiveValidity: {
      test: "Product-level: does analysis produce a usable Result on sub-2 s clips? This is an analysis-pipeline invariant (insufficient events), not a capture-quality property.",
      validates: "Downstream event count vs clip length curve.",
      refutes: "Usable results on sub-1 s clips.",
      runnability: "BLOCKED_EXTERNAL",
      corpusRequirement: "≥10 labeled units per duration bin from ≥5 sessions.",
    },
  },
  {
    dimension: "player_pixel_height",
    thresholdId: "player-pixel-height-fraction-v0.1",
    claim: "Target player ≥ 25% of frame height is analyzable; 12–25% degraded; below unsupported.",
    constructValidity: {
      test: "Requires pose output (Apple Vision) to measure the proxy at all; NOT_MEASURED on Linux.",
      validates: "n/a on Linux",
      refutes: "n/a on Linux",
      runnability: "BLOCKED_EXTERNAL",
    },
    predictiveValidity: {
      test: "Downscale/distance ladder with pose reruns on Mac; find the player-height fraction where joint recall collapses.",
      validates: "Collapse onset in [0.12, 0.25).",
      refutes: "Pose survival below 0.12 or collapse above 0.25.",
      runnability: "BLOCKED_EXTERNAL",
      corpusRequirement: "≥10 pose-measured labeled units per bin from ≥5 sessions; zero exist.",
    },
  },
  {
    dimension: "player_visibility",
    thresholdId: "player-mean-joint-visibility-v0.1",
    claim: "Mean joint visibility ≥ 0.5 is analyzable; 0.3–0.5 degraded; below unsupported.",
    constructValidity: {
      test: "Requires pose output (Apple Vision); NOT_MEASURED on Linux.",
      validates: "n/a on Linux",
      refutes: "n/a on Linux",
      runnability: "BLOCKED_EXTERNAL",
    },
    predictiveValidity: {
      test: "Occlusion ladder with pose reruns on Mac.",
      validates: "Failure onset in [0.3, 0.5).",
      refutes: "Survival below 0.3 or failure above 0.5.",
      runnability: "BLOCKED_EXTERNAL",
      corpusRequirement: "≥10 pose-measured labeled units per bin from ≥5 sessions; zero exist.",
    },
  },
] as const;
