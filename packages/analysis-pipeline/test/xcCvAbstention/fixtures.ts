/**
 * Adversarial pose fixtures for the CV failure-detection / abstention
 * red-team harness (role `cv-failure-detection-abstention`).
 *
 * PROVENANCE: every sequence here is SYNTHETIC (derived from the canonical
 * deterministic swing generator in @pickle/evaluation) and is stamped with
 * `SYNTHETIC_PRODUCER` — nothing in this file is an Apple Vision observation.
 * Fixture ids embed every parameter and the PRNG seed so each row of the
 * harness output is replayable from the id alone.
 *
 * Families (the role brief): no_player, far_camera, occluded, multi_player,
 * garbage — plus `control` rows that pin the harness itself (a valid swing
 * must still score, otherwise "everything abstains" would be a vacuous pass).
 */
import { generateSwingSequence, type SwingTruth } from "@pickle/evaluation";
import type { Handedness, ShotTypeSlug } from "@pickle/shared-types";
import type { CanonicalPoseFrame, PoseSequence } from "@pickle/swing-domain";
import { makeRng, type Rng } from "./prng.js";

export type FixtureFamily =
  "control" | "no_player" | "far_camera" | "occluded" | "multi_player" | "garbage";

/**
 * - `reject_or_abstain`: the input carries no honest evidence of the declared
 *   stroke by a single tracked player — a numeric score is a confident-wrong.
 * - `control_scored`: a valid synthetic swing — must score (harness sanity).
 * - `informational`: product-level ambiguity (e.g. wrong declared stroke);
 *   recorded, never counted as a failure either way.
 */
export type ExpectedOutcome = "reject_or_abstain" | "control_scored" | "informational";

export interface Fixture {
  id: string;
  family: FixtureFamily;
  seed: number | null;
  params: Record<string, string | number | boolean | null>;
  description: string;
  sequence: PoseSequence;
  trigger: { startMs: number; endMs: number; peakMotionMs: number };
  declared: ShotTypeSlug | null;
  handedness: Handedness;
  expected: ExpectedOutcome;
}

type Window = { startMs: number; endMs: number; peakMs: number };
type Frame = CanonicalPoseFrame;
type Landmark = Frame["landmarks"][number];

const LANDMARK_NAMES = [
  "head",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
] as const;

const LOWER_BODY = new Set(["left_knee", "right_knee", "left_ankle", "right_ankle"]);
const HIPS = new Set(["left_hip", "right_hip"]);
const UPPER_ONLY = new Set([
  "head",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
]);

function base(overrides: Partial<SwingTruth> = {}): { sequence: PoseSequence; window: Window } {
  return generateSwingSequence(overrides);
}

function mapLandmarks(
  sequence: PoseSequence,
  fn: (mark: Landmark, frame: Frame, frameIndex: number) => Landmark | null,
): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map((frame, frameIndex) => ({
      ...frame,
      landmarks: frame.landmarks.flatMap((mark) => {
        const next = fn(mark, frame, frameIndex);
        return next ? [next] : [];
      }),
    })),
  };
}

function mapFrames(
  sequence: PoseSequence,
  fn: (frame: Frame, index: number) => Frame | null,
): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.flatMap((frame, index) => {
      const next = fn(frame, index);
      return next ? [next] : [];
    }),
  };
}

function reindex(sequence: PoseSequence): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map((frame, index) => ({ ...frame, frameIndex: index })),
  };
}

function jitter(sequence: PoseSequence, rng: Rng, sigma: number): PoseSequence {
  return mapLandmarks(sequence, (mark) => ({
    ...mark,
    x: mark.x + rng.gauss() * sigma,
    y: mark.y + rng.gauss() * sigma,
  }));
}

function setVisibility(
  sequence: PoseSequence,
  visibility: number,
  confidence?: number,
): PoseSequence {
  const withMarks = mapLandmarks(sequence, (mark) => ({ ...mark, visibility }));
  return confidence === undefined
    ? withMarks
    : { ...withMarks, frames: withMarks.frames.map((frame) => ({ ...frame, confidence })) };
}

/** Rigidly move a skeleton: scale about the image center then translate. */
function transform(sequence: PoseSequence, scale: number, dx: number, dy: number): PoseSequence {
  return mapLandmarks(sequence, (mark) => ({
    ...mark,
    x: 0.5 + (mark.x - 0.5) * scale + dx,
    y: 0.5 + (mark.y - 0.5) * scale + dy,
  }));
}

/** A motionless copy of frame `sourceIndex`, replayed at the same cadence. */
function freeze(sequence: PoseSequence, sourceIndex: number): PoseSequence {
  const source = sequence.frames[sourceIndex];
  if (!source) throw new Error(`freeze: frame ${sourceIndex} missing`);
  return {
    ...sequence,
    frames: sequence.frames.map((frame) => ({
      ...frame,
      landmarks: source.landmarks.map((mark) => ({ ...mark })),
    })),
  };
}

function fixture(
  id: string,
  family: FixtureFamily,
  seed: number | null,
  params: Fixture["params"],
  description: string,
  sequence: PoseSequence,
  window: Window,
  expected: ExpectedOutcome,
  declared: ShotTypeSlug | null = "forehand_drive",
  handedness: Handedness = "right",
): Fixture {
  return {
    id,
    family,
    seed,
    params,
    description,
    sequence,
    trigger: { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs },
    declared,
    handedness,
    expected,
  };
}

const seeds = (count: number, offset: number): number[] =>
  Array.from({ length: count }, (_, index) => offset + index);

// ---------------------------------------------------------------- control

export function controlFixtures(): Fixture[] {
  const out: Fixture[] = [];
  {
    const { sequence, window } = base();
    out.push(
      fixture(
        "ctrl-default-forehand",
        "control",
        null,
        {},
        "canonical synthetic forehand",
        sequence,
        window,
        "control_scored",
      ),
    );
  }
  {
    const { sequence, window } = base({ handed: "left" });
    out.push(
      fixture(
        "ctrl-default-forehand-left",
        "control",
        null,
        { handed: "left" },
        "canonical synthetic forehand, left-handed",
        sequence,
        window,
        "control_scored",
        "forehand_drive",
        "left",
      ),
    );
  }
  for (const seed of seeds(10, 1000)) {
    const { sequence, window } = base();
    const rng = makeRng(seed);
    out.push(
      fixture(
        `ctrl-jitter-1px-s${seed}`,
        "control",
        seed,
        { sigmaNorm: 1 / 1080 },
        "canonical swing + 1px gaussian landmark jitter (tracker noise floor)",
        jitter(sequence, rng, 1 / 1080),
        window,
        "control_scored",
      ),
    );
  }
  return out;
}

// -------------------------------------------------------------- no_player

export function noPlayerFixtures(seedCount: number): Fixture[] {
  const out: Fixture[] = [];
  const { sequence: swing, window } = base();

  out.push(
    fixture(
      "np-empty-frames",
      "no_player",
      null,
      { frames: 0 },
      "no pose frames at all",
      { ...swing, frames: [] },
      window,
      "reject_or_abstain",
    ),
  );
  for (const n of [1, 3, 5]) {
    out.push(
      fixture(
        `np-${n}-frames`,
        "no_player",
        null,
        { frames: n },
        `only ${n} pose frames survived the whole clip`,
        { ...swing, frames: swing.frames.slice(0, n) },
        window,
        "reject_or_abstain",
      ),
    );
  }
  out.push(
    fixture(
      "np-still-ready-pose",
      "no_player",
      null,
      { frozenFrame: 0 },
      "a person standing still for the entire window (no stroke happened)",
      freeze(swing, 0),
      window,
      "reject_or_abstain",
    ),
  );
  for (const visibility of [0, 0.1, 0.29]) {
    out.push(
      fixture(
        `np-visibility-${visibility}`,
        "no_player",
        null,
        { visibility, frameConfidence: visibility },
        `every landmark reported at visibility ${visibility} (tracker found nothing it trusts)`,
        setVisibility(swing, visibility, visibility),
        window,
        "reject_or_abstain",
      ),
    );
  }
  out.push(
    fixture(
      "np-visibility-0.31-conf-0.31",
      "no_player",
      null,
      { visibility: 0.31, frameConfidence: 0.31 },
      "landmarks just above the 0.3 visibility cut, frame confidence 0.31",
      setVisibility(swing, 0.31, 0.31),
      window,
      "reject_or_abstain",
    ),
    fixture(
      "np-visibility-0.31-conf-0.95",
      "no_player",
      null,
      { visibility: 0.31, frameConfidence: 0.95 },
      "landmarks just above the 0.3 visibility cut but frame confidence 0.95",
      setVisibility(swing, 0.31, 0.95),
      window,
      "reject_or_abstain",
    ),
  );
  for (const sigma of [0.003, 0.01]) {
    for (const seed of seeds(seedCount, 2000)) {
      const rng = makeRng(seed);
      out.push(
        fixture(
          `np-static-noise-${sigma}-s${seed}`,
          "no_player",
          seed,
          { sigmaNorm: sigma },
          "motionless ready pose + gaussian jitter (tracker locked on furniture / mannequin)",
          jitter(freeze(swing, 0), rng, sigma),
          window,
          "reject_or_abstain",
        ),
      );
    }
  }
  for (const seed of seeds(seedCount, 2100)) {
    const rng = makeRng(seed);
    let dx = 0;
    let dy = 0;
    const drifted = mapFrames(freeze(swing, 0), (frame) => {
      dx += rng.gauss() * 0.002;
      dy += rng.gauss() * 0.002;
      return {
        ...frame,
        landmarks: frame.landmarks.map((mark) => ({ ...mark, x: mark.x + dx, y: mark.y + dy })),
      };
    });
    out.push(
      fixture(
        `np-random-walk-drift-s${seed}`,
        "no_player",
        seed,
        { stepSigma: 0.002 },
        "motionless pose whose whole skeleton random-walks (camera drift on an empty court prop)",
        drifted,
        window,
        "reject_or_abstain",
      ),
    );
  }
  // Idle sway sweep: a person standing in place, shifting weight (horizontal
  // sway of a given period) with 1px tracker jitter. No stroke happens
  // anywhere in the window. Amplitudes are normalized image width
  // (0.01 ≈ 11 px at 1080).
  for (const sway of [0.005, 0.01, 0.02]) {
    for (const periodMs of [400, 1000, 1800, 2500, 4000]) {
      const sigma = 0.001;
      for (const seed of seeds(seedCount, 2200)) {
        const rng = makeRng(seed);
        const phase = rng.range(0, Math.PI * 2);
        const swaying = mapFrames(freeze(swing, 0), (frame) => {
          const dx = sway * Math.sin((frame.timestampMs / periodMs) * 2 * Math.PI + phase);
          return {
            ...frame,
            landmarks: frame.landmarks.map((mark) => ({
              ...mark,
              x: mark.x + dx + rng.gauss() * sigma,
              y: mark.y + rng.gauss() * sigma,
            })),
          };
        });
        out.push(
          fixture(
            `np-idle-sway-a${sway}-p${periodMs}-s${seed}`,
            "no_player",
            seed,
            { swayAmplitude: sway, jitterSigma: sigma, periodMs },
            "idle player swaying in place, no stroke in the window",
            swaying,
            window,
            "reject_or_abstain",
          ),
        );
      }
    }
  }
  return out;
}

// ------------------------------------------------------------- far_camera

export function farCameraFixtures(seedCount: number): Fixture[] {
  const out: Fixture[] = [];
  for (const torsoLength of [0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.079]) {
    const { sequence, window } = base({ torsoLength });
    out.push(
      fixture(
        `far-torso-${torsoLength}`,
        "far_camera",
        null,
        { torsoLengthNorm: torsoLength, torsoPx1080: Math.round(torsoLength * 1080) },
        `player far from camera: torso ${torsoLength} of frame height (~${Math.round(torsoLength * 1080)}px at 1080p)`,
        sequence,
        window,
        "reject_or_abstain",
      ),
    );
  }
  for (const torsoLength of [0.03, 0.05]) {
    for (const sigmaPx of [1, 2]) {
      for (const seed of seeds(seedCount, 3000)) {
        const { sequence, window } = base({ torsoLength });
        const rng = makeRng(seed);
        out.push(
          fixture(
            `far-torso-${torsoLength}-noise-${sigmaPx}px-s${seed}`,
            "far_camera",
            seed,
            { torsoLengthNorm: torsoLength, sigmaPx },
            "far player + realistic pixel jitter (noise comparable to the body scale)",
            jitter(sequence, rng, sigmaPx / 1080),
            window,
            "reject_or_abstain",
          ),
        );
      }
    }
  }
  for (const torsoLength of [0.62, 0.8]) {
    const { sequence, window } = base({ torsoLength });
    out.push(
      fixture(
        `near-torso-${torsoLength}`,
        "far_camera",
        null,
        { torsoLengthNorm: torsoLength },
        "player far too close / partially out of frame (torso taller than the library's 0.6 ceiling)",
        sequence,
        window,
        "reject_or_abstain",
      ),
    );
  }
  return out;
}

// --------------------------------------------------------------- occluded

export function occludedFixtures(seedCount: number): Fixture[] {
  const out: Fixture[] = [];
  const { sequence: swing, window } = base();
  const contactMs = window.peakMs;
  const hide = (names: Set<string>, when: (frame: Frame) => boolean = () => true): PoseSequence =>
    mapLandmarks(swing, (mark, frame) =>
      names.has(mark.name) && when(frame) ? { ...mark, visibility: 0 } : mark,
    );

  out.push(
    fixture(
      "occ-lower-body-hidden",
      "occluded",
      null,
      { hidden: "knees+ankles" },
      "net/fence hides everything below the hips for the whole clip",
      hide(LOWER_BODY),
      window,
      "informational",
    ),
    fixture(
      "occ-hips-hidden",
      "occluded",
      null,
      { hidden: "hips" },
      "hips never measured (torso scale impossible)",
      hide(HIPS),
      window,
      "reject_or_abstain",
    ),
    fixture(
      "occ-dominant-arm-hidden-around-contact",
      "occluded",
      null,
      { hidden: "right_wrist+right_elbow", fromMs: contactMs - 300, toMs: contactMs + 300 },
      "dominant arm behind a post from 300ms before to 300ms after contact",
      hide(
        new Set(["right_wrist", "right_elbow"]),
        (frame) => Math.abs(frame.timestampMs - contactMs) <= 300,
      ),
      window,
      "reject_or_abstain",
    ),
    fixture(
      "occ-dominant-arm-hidden-all",
      "occluded",
      null,
      { hidden: "right_wrist+right_elbow" },
      "dominant arm never measured",
      hide(new Set(["right_wrist", "right_elbow"])),
      window,
      "reject_or_abstain",
    ),
    fixture(
      "occ-off-arm-hidden-all",
      "occluded",
      null,
      { hidden: "left_wrist+left_elbow" },
      "non-dominant arm never measured",
      hide(new Set(["left_wrist", "left_elbow"])),
      window,
      "informational",
    ),
    fixture(
      "occ-upper-body-only",
      "occluded",
      null,
      { kept: "head+shoulders+elbows+wrists" },
      "waist-up framing: hips/knees/ankles never measured",
      mapLandmarks(swing, (mark) =>
        UPPER_ONLY.has(mark.name) ? mark : { ...mark, visibility: 0 },
      ),
      window,
      "reject_or_abstain",
    ),
  );
  for (const gapMs of [400, 800, 1500]) {
    out.push(
      fixture(
        `occ-gap-${gapMs}ms-at-contact`,
        "occluded",
        null,
        { gapMs, centerMs: contactMs },
        `tracker lost the player for ${gapMs}ms straddling contact`,
        reindex(
          mapFrames(swing, (frame) =>
            Math.abs(frame.timestampMs - contactMs) <= gapMs / 2 ? null : frame,
          ),
        ),
        window,
        "reject_or_abstain",
      ),
    );
  }
  for (const p of [0.3, 0.5, 0.7]) {
    for (const seed of seeds(seedCount, 4000)) {
      const rng = makeRng(seed);
      out.push(
        fixture(
          `occ-random-landmarks-p${p}-s${seed}`,
          "occluded",
          seed,
          { dropProbability: p },
          "each landmark independently unmeasured with probability p (fragmentary tracking)",
          mapLandmarks(swing, (mark) => (rng.chance(p) ? { ...mark, visibility: 0 } : mark)),
          window,
          p >= 0.5 ? "reject_or_abstain" : "informational",
        ),
      );
    }
  }
  for (const p of [0.5, 0.8]) {
    for (const seed of seeds(seedCount, 4100)) {
      const rng = makeRng(seed);
      out.push(
        fixture(
          `occ-frame-dropout-p${p}-s${seed}`,
          "occluded",
          seed,
          { frameDropProbability: p },
          "whole frames missing with probability p (intermittent detection)",
          reindex(mapFrames(swing, (frame) => (rng.chance(p) ? null : frame))),
          window,
          p >= 0.8 ? "reject_or_abstain" : "informational",
        ),
      );
    }
  }
  return out;
}

// ----------------------------------------------------------- multi_player

/**
 * Two synthetic people: A swings (the declared stroke) shifted left, B is a
 * smaller bystander shifted right. Tracks are built by choosing which person
 * feeds each frame — the failure mode of a per-frame primary-person picker
 * with no identity continuity.
 */
function twoPeople(): { a: PoseSequence; b: PoseSequence; window: Window } {
  const { sequence, window } = base();
  const a = transform(sequence, 1, -0.2, 0);
  const bystander = freeze(sequence, 0);
  const b = transform(bystander, 0.7, 0.25, 0.05);
  return { a, b, window };
}

function pickTrack(
  a: PoseSequence,
  b: PoseSequence,
  useB: (index: number) => boolean,
): PoseSequence {
  return {
    ...a,
    frames: a.frames.map((frame, index) => {
      const source = useB(index) ? b.frames[index] : frame;
      if (!source) throw new Error(`pickTrack: frame ${index} missing`);
      return { ...source, frameIndex: index };
    }),
  };
}

export function multiPlayerFixtures(seedCount: number): Fixture[] {
  const out: Fixture[] = [];
  const { a, b, window } = twoPeople();
  out.push(
    fixture(
      "mp-bystander-lock",
      "multi_player",
      null,
      { tracked: "B(static)" },
      "tracker locked on the motionless bystander, swinger ignored",
      b,
      window,
      "reject_or_abstain",
    ),
  );
  for (const seed of seeds(seedCount, 5000)) {
    const rng = makeRng(seed);
    const phase = rng.range(0, Math.PI * 2);
    const swaying = mapFrames(b, (frame) => {
      const dx = 0.01 * Math.sin(frame.timestampMs / 400 + phase);
      return {
        ...frame,
        landmarks: frame.landmarks.map((mark) => ({
          ...mark,
          x: mark.x + dx + rng.gauss() * 0.001,
        })),
      };
    });
    out.push(
      fixture(
        `mp-bystander-swaying-s${seed}`,
        "multi_player",
        seed,
        { swayAmplitude: 0.01, jitterSigma: 0.001 },
        "tracker locked on a bystander who sways gently (no stroke)",
        swaying,
        window,
        "reject_or_abstain",
      ),
    );
  }
  for (const swaps of [1, 2, 4]) {
    for (const seed of seeds(seedCount, 5100)) {
      const rng = makeRng(seed);
      const frameCount = a.frames.length;
      const swapPoints = new Set<number>();
      while (swapPoints.size < swaps) swapPoints.add(rng.int(frameCount));
      let onB = false;
      const useB = (index: number): boolean => {
        if (swapPoints.has(index)) onB = !onB;
        return onB;
      };
      const points = [...swapPoints].sort((x, y) => x - y);
      const track = pickTrack(a, b, useB);
      out.push(
        fixture(
          `mp-identity-swap-k${swaps}-s${seed}`,
          "multi_player",
          seed,
          { swaps, swapFrames: points.join("|") },
          "track jumps between swinger A and bystander B at seeded frames",
          track,
          window,
          "reject_or_abstain",
        ),
      );
    }
  }
  for (const p of [0.2, 0.5]) {
    for (const seed of seeds(seedCount, 5200)) {
      const rng = makeRng(seed);
      const chimera: PoseSequence = {
        ...a,
        frames: a.frames.map((frame, index) => {
          const other = b.frames[index];
          if (!other) throw new Error(`chimera: frame ${index} missing`);
          return {
            ...frame,
            landmarks: frame.landmarks.map((mark) => {
              const alt = other.landmarks.find((candidate) => candidate.name === mark.name);
              return alt && rng.chance(p) ? { ...alt } : mark;
            }),
          };
        }),
      };
      out.push(
        fixture(
          `mp-landmark-mix-p${p}-s${seed}`,
          "multi_player",
          seed,
          { mixProbability: p },
          "chimera skeleton: each landmark taken from A or B (two overlapping players)",
          chimera,
          window,
          "reject_or_abstain",
        ),
      );
    }
  }
  {
    // Two swingers: B mirrors A and is offset by 300ms; the track flips at contact.
    const { sequence: mirrored } = base({ handed: "left" });
    const bSwing = transform(
      {
        ...mirrored,
        frames: mirrored.frames.map((frame) => ({ ...frame, timestampMs: frame.timestampMs })),
      },
      0.85,
      0.25,
      0,
    );
    const shifted = mapFrames(bSwing, (frame, index) => {
      const source = bSwing.frames[Math.min(bSwing.frames.length - 1, index + 18)];
      return source ? { ...source, frameIndex: index, timestampMs: frame.timestampMs } : null;
    });
    for (const seed of seeds(seedCount, 5300)) {
      const rng = makeRng(seed);
      const flipAt = window.peakMs + rng.int(200) - 100;
      const track = pickTrack(a, shifted, (index) => (a.frames[index]?.timestampMs ?? 0) >= flipAt);
      out.push(
        fixture(
          `mp-two-swingers-flip-s${seed}`,
          "multi_player",
          seed,
          { flipAtMs: flipAt, bOffsetFrames: 18 },
          "two players both swing (B mirrored, +300ms); track flips from A to B near contact",
          track,
          window,
          "reject_or_abstain",
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------- garbage

export function garbageFixtures(seedCount: number): Fixture[] {
  const out: Fixture[] = [];
  const { sequence: swing, window } = base();

  for (const seed of seeds(seedCount, 6000)) {
    const rng = makeRng(seed);
    out.push(
      fixture(
        `gb-uniform-random-s${seed}`,
        "garbage",
        seed,
        { visibility: 0.9, frameConfidence: 0.9 },
        "every landmark uniformly random in the image each frame, reported at high confidence",
        {
          ...swing,
          frames: swing.frames.map((frame) => ({
            ...frame,
            confidence: 0.9,
            landmarks: LANDMARK_NAMES.map((name) => ({
              name,
              x: rng.next(),
              y: rng.next(),
              visibility: 0.9,
            })),
          })),
        },
        window,
        "reject_or_abstain",
      ),
    );
  }
  for (const seed of seeds(seedCount, 6100)) {
    const rng = makeRng(seed);
    const first = swing.frames[0];
    if (!first) throw new Error("swing has no frames");
    const positions = new Map(first.landmarks.map((mark) => [mark.name, { x: mark.x, y: mark.y }]));
    out.push(
      fixture(
        `gb-random-walk-s${seed}`,
        "garbage",
        seed,
        { stepSigma: 0.02 },
        "each landmark random-walks independently from a valid ready pose (σ=0.02/frame)",
        {
          ...swing,
          frames: swing.frames.map((frame) => ({
            ...frame,
            landmarks: frame.landmarks.map((mark) => {
              const pos = positions.get(mark.name) ?? { x: 0.5, y: 0.5 };
              pos.x += rng.gauss() * 0.02;
              pos.y += rng.gauss() * 0.02;
              return { ...mark, x: pos.x, y: pos.y };
            }),
          })),
        },
        window,
        "reject_or_abstain",
      ),
    );
  }
  for (const seed of seeds(seedCount, 6200)) {
    const rng = makeRng(seed);
    const order = swing.frames.map((_, index) => index);
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = rng.int(i + 1);
      const tmp = order[i]!;
      order[i] = order[j]!;
      order[j] = tmp;
    }
    out.push(
      fixture(
        `gb-shuffled-frames-s${seed}`,
        "garbage",
        seed,
        {},
        "valid poses in scrambled temporal order (timestamps kept ascending)",
        {
          ...swing,
          frames: swing.frames.map((frame, index) => {
            const source = swing.frames[order[index]!]!;
            return { ...frame, landmarks: source.landmarks.map((mark) => ({ ...mark })) };
          }),
        },
        window,
        "reject_or_abstain",
      ),
    );
  }
  out.push(
    fixture(
      "gb-collapsed-point",
      "garbage",
      null,
      { x: 0.5, y: 0.5 },
      "all landmarks at the same pixel",
      mapLandmarks(swing, (mark) => ({ ...mark, x: 0.5, y: 0.5 })),
      window,
      "reject_or_abstain",
    ),
    fixture(
      "gb-upside-down",
      "garbage",
      null,
      { yFlip: true },
      "y → 1−y (upside-down phone / coordinate-origin bug)",
      mapLandmarks(swing, (mark) => ({ ...mark, y: 1 - mark.y })),
      window,
      "informational",
    ),
    fixture(
      "gb-time-reversed",
      "garbage",
      null,
      {},
      "frames played backwards (recover→ready)",
      {
        ...swing,
        frames: swing.frames.map((frame, index) => {
          const source = swing.frames[swing.frames.length - 1 - index]!;
          return { ...frame, landmarks: source.landmarks.map((mark) => ({ ...mark })) };
        }),
      },
      window,
      "informational",
    ),
    fixture(
      "gb-time-stretched-x10",
      "garbage",
      null,
      { timeScale: 10 },
      "timestamps ×10 (6 fps effective; the 'swing' takes 20 seconds)",
      {
        ...swing,
        frames: swing.frames.map((frame) => ({ ...frame, timestampMs: frame.timestampMs * 10 })),
      },
      { startMs: window.startMs * 10, endMs: window.endMs * 10, peakMs: window.peakMs * 10 },
      "reject_or_abstain",
    ),
    fixture(
      "gb-time-compressed-div10",
      "garbage",
      null,
      { timeScale: 0.1 },
      "timestamps ÷10 (600 fps; the whole swing lasts 200 ms)",
      {
        ...swing,
        frames: swing.frames.map((frame) => ({ ...frame, timestampMs: frame.timestampMs / 10 })),
      },
      { startMs: window.startMs / 10, endMs: window.endMs / 10, peakMs: window.peakMs / 10 },
      "informational",
    ),
    fixture(
      "gb-left-right-labels-swapped",
      "garbage",
      null,
      {},
      "left_*/right_* names swapped without mirroring positions (tracker mislabel)",
      mapLandmarks(swing, (mark) => ({
        ...mark,
        name: mark.name.startsWith("left_")
          ? mark.name.replace("left_", "right_")
          : mark.name.startsWith("right_")
            ? mark.name.replace("right_", "left_")
            : mark.name,
      })),
      window,
      "informational",
    ),
    fixture(
      "gb-offscreen-x-plus-2",
      "garbage",
      null,
      { dx: 2 },
      "entire skeleton reported two image-widths to the right of the frame",
      mapLandmarks(swing, (mark) => ({ ...mark, x: mark.x + 2 })),
      window,
      "reject_or_abstain",
    ),
    fixture(
      "gb-negative-coordinates",
      "garbage",
      null,
      { dx: -1.5, dy: -1.5 },
      "entire skeleton at negative normalized coordinates",
      mapLandmarks(swing, (mark) => ({ ...mark, x: mark.x - 1.5, y: mark.y - 1.5 })),
      window,
      "reject_or_abstain",
    ),
    fixture(
      "gb-visibility-5-confidence-5",
      "garbage",
      null,
      { visibility: 5, frameConfidence: 5 },
      "visibility/confidence far outside [0,1]",
      setVisibility(swing, 5, 5),
      window,
      "informational",
    ),
    fixture(
      "gb-frame-confidence-0",
      "garbage",
      null,
      { visibility: 0.95, frameConfidence: 0 },
      "landmarks confident but every frame confidence is 0",
      { ...swing, frames: swing.frames.map((frame) => ({ ...frame, confidence: 0 })) },
      window,
      "reject_or_abstain",
    ),
    fixture(
      "gb-unknown-landmark-names",
      "garbage",
      null,
      {},
      "landmarks carry names outside the pose vocabulary",
      mapLandmarks(swing, (mark, _frame, index) => ({
        ...mark,
        name: `joint_${mark.name}_${index % 3}`,
      })),
      window,
      "reject_or_abstain",
    ),
    fixture(
      "gb-window-outside-clip",
      "garbage",
      null,
      { startMs: 50000, endMs: 52000 },
      "trigger window lies entirely after the last pose frame",
      swing,
      { startMs: 50000, endMs: 52000, peakMs: 51000 },
      "reject_or_abstain",
    ),
    fixture(
      "gb-window-50ms",
      "garbage",
      null,
      { windowMs: 50 },
      "trigger window of 50ms around contact",
      swing,
      { startMs: window.peakMs - 25, endMs: window.peakMs + 25, peakMs: window.peakMs },
      "reject_or_abstain",
    ),
    fixture(
      "gb-window-inverted",
      "garbage",
      null,
      {},
      "trigger window with end before start",
      swing,
      { startMs: window.endMs, endMs: window.startMs, peakMs: window.peakMs },
      "reject_or_abstain",
    ),
    fixture(
      "gb-peak-outside-window",
      "garbage",
      null,
      { peakMs: -500 },
      "trigger peak reported before the window starts",
      swing,
      { startMs: window.startMs, endMs: window.endMs, peakMs: -500 },
      "informational",
    ),
  );
  for (const declared of [
    "serve",
    "dink",
    "third_shot_drop",
    "overhead",
    "volley",
    "backhand_drive",
    "return",
  ] as const) {
    out.push(
      fixture(
        `gb-declared-${declared}-actual-forehand-drive`,
        "garbage",
        null,
        { declared },
        `a forehand drive declared as ${declared}`,
        swing,
        window,
        "informational",
        declared,
      ),
    );
  }
  out.push(
    fixture(
      "gb-auto-detect-default-forehand",
      "garbage",
      null,
      { declared: null },
      "AUTO DETECT on the canonical forehand",
      swing,
      window,
      "informational",
      null,
    ),
    fixture(
      "gb-auto-detect-still-pose",
      "garbage",
      null,
      { declared: null },
      "AUTO DETECT on a motionless pose",
      freeze(swing, 0),
      window,
      "reject_or_abstain",
      null,
    ),
  );
  return out;
}

export function allSyntheticFixtures(seedCount: number): Fixture[] {
  return [
    ...controlFixtures(),
    ...noPlayerFixtures(seedCount),
    ...farCameraFixtures(seedCount),
    ...occludedFixtures(seedCount),
    ...multiPlayerFixtures(seedCount),
    ...garbageFixtures(seedCount),
  ];
}
