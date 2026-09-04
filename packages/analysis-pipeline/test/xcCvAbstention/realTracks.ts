/**
 * Multi-player fixtures built from COMMITTED Apple Vision all-person
 * sidecars (`datasets/paddle-bench/runs-wave-a/<run>/people.json`, model
 * `apple-vision-bodypose-1`, 2–6 detections per frame). Read-only: the
 * dataset is never modified.
 *
 * Each run yields several single-person TRACKS, one per selection policy.
 * The policies are deliberately naive — they model what a primary-person
 * picker WITHOUT identity continuity would hand the pipeline. The real
 * native picker (`native/vision-core/Sources/ApplePoseProvider.swift`
 * `primaryPerson`) is stickier; it cannot run on Linux, so these rows probe
 * the TypeScript pipeline's own defence against a track that jumps between
 * bodies, not the picker itself.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ShotTypeSlug } from "@pickle/shared-types";
import type { PoseSequence } from "@pickle/swing-domain";
import type { Fixture } from "./fixtures.js";

interface WirePerson {
  c: number;
  l: Array<{ n: string; x: number; y: number; v: number }>;
}
interface WirePeopleFrame {
  t: number;
  p: WirePerson[];
}
interface WirePeople {
  schemaVersion: number;
  poseModelVersion: string;
  video: { w: number; h: number; fps: number };
  frames: WirePeopleFrame[];
}
interface WindowMeta {
  derivedFrom: string;
  windowMs: { from: number; to: number };
}

export const WAVE_A_DIR = "datasets/paddle-bench/runs-wave-a";

const DECLARED_FOR_RUN: Record<string, ShotTypeSlug> = {
  "wavea-944403-dink": "dink",
  "wavea-944403-smash": "overhead",
  "wavea-faead-feed": "forehand_drive",
  "wavea-faead-rally": "forehand_drive",
  "wavea-marne-dig": "forehand_drive",
  "wavea-marne-serve": "serve",
  "wavea-sasebo-volleys": "volley",
  "wavea-wgm-wheelchair": "forehand_drive",
};

function torsoSpan(person: WirePerson): number {
  const find = (name: string) => person.l.find((mark) => mark.n === name && mark.v >= 0.3);
  const ls = find("left_shoulder");
  const rs = find("right_shoulder");
  const lh = find("left_hip");
  const rh = find("right_hip");
  if (!ls || !rs || !lh || !rh) return 0;
  return Math.hypot((ls.x + rs.x) / 2 - (lh.x + rh.x) / 2, (ls.y + rs.y) / 2 - (lh.y + rh.y) / 2);
}

export type TrackPolicy =
  "vision_order_first" | "largest_torso" | "smallest_torso" | "alternate_two_largest";

function pick(frame: WirePeopleFrame, policy: TrackPolicy, frameIndex: number): WirePerson | null {
  if (frame.p.length === 0) return null;
  const bySize = [...frame.p].sort((a, b) => torsoSpan(b) - torsoSpan(a));
  switch (policy) {
    case "vision_order_first":
      return frame.p[0] ?? null;
    case "largest_torso":
      return bySize[0] ?? null;
    case "smallest_torso":
      return bySize[bySize.length - 1] ?? null;
    case "alternate_two_largest":
      return (frameIndex % 2 === 0 ? bySize[0] : (bySize[1] ?? bySize[0])) ?? null;
  }
}

function toSequence(people: WirePeople, policy: TrackPolicy): PoseSequence {
  const frames: PoseSequence["frames"] = [];
  people.frames.forEach((frame, index) => {
    const person = pick(frame, policy, index);
    if (!person) return;
    frames.push({
      frameIndex: index,
      timestampMs: frame.t,
      confidence: person.c,
      landmarks: person.l.map((mark) => ({
        name: mark.n,
        x: mark.x,
        y: mark.y,
        visibility: mark.v,
      })),
    });
  });
  return {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    producedBy: {
      providerId: "harness.wave-a-people-track",
      modelVersion: people.poseModelVersion,
      runtime: "deterministic",
      executionTarget: "on_device",
      artifactHash: null,
    },
    video: { width: people.video.w, height: people.video.h, fps: people.video.fps },
    frames: frames.map((frame, index) => ({ ...frame, frameIndex: index })),
  };
}

export function realMultiPersonFixtures(repoRoot: string): Fixture[] {
  const dir = join(repoRoot, WAVE_A_DIR);
  const runs = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const out: Fixture[] = [];
  for (const run of runs) {
    const people = JSON.parse(readFileSync(join(dir, run, "people.json"), "utf8")) as WirePeople;
    const meta = JSON.parse(readFileSync(join(dir, run, "window-meta.json"), "utf8")) as WindowMeta;
    const maxPeople = Math.max(...people.frames.map((frame) => frame.p.length));
    if (maxPeople < 2) continue; // single-person runs are not multi-player fixtures
    const declared = DECLARED_FOR_RUN[run] ?? "forehand_drive";
    const window = {
      startMs: meta.windowMs.from,
      endMs: meta.windowMs.to,
      // No measured kinematic peak is committed for these windows; the
      // midpoint is a harness stand-in and is recorded as such.
      peakMotionMs: Math.round((meta.windowMs.from + meta.windowMs.to) / 2),
    };
    const policies: TrackPolicy[] = [
      "vision_order_first",
      "largest_torso",
      "smallest_torso",
      "alternate_two_largest",
    ];
    for (const policy of policies) {
      out.push({
        id: `mp-real-${run}-${policy}`,
        family: "multi_player",
        seed: null,
        params: {
          run,
          derivedFrom: meta.derivedFrom,
          policy,
          maxPeoplePerFrame: maxPeople,
          frames: people.frames.length,
          windowFrom: meta.windowMs.from,
          windowTo: meta.windowMs.to,
          peakIsMidpointStandIn: true,
          poseModelVersion: people.poseModelVersion,
        },
        description: `real Apple Vision all-person sidecar; single track chosen per frame by policy ${policy}`,
        sequence: toSequence(people, policy),
        trigger: window,
        declared,
        handedness: "right",
        // Only the every-frame body flip is unambiguously not one player's
        // stroke; the other policies may land on a genuine player.
        expected: policy === "alternate_two_largest" ? "reject_or_abstain" : "informational",
      });
    }
  }
  return out;
}
