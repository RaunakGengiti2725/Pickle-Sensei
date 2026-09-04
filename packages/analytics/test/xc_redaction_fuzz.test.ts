/**
 * XC adversarial harness — analytics redaction guard.
 *
 * Seeded fuzz of `findPrivacyViolations` / `BufferedAnalytics.track` with
 * planted sensitive payloads of the classes REVIEW.md says the redaction layer
 * rejects (media URIs, filesystem paths, emails, base64 blobs, oversized
 * free text, forbidden keys) plus adjacent classes it does NOT claim to reject
 * (base64url/JWT tokens, https media URLs, short free text, UUID identifiers
 * under non-forbidden keys). Every probe is recorded to a JSON matrix so the
 * exact catch/bypass behaviour per class is replayable:
 *
 *   XC_SEED=1602847 XC_ITER=3000 XC_ARTIFACT_DIR=/tmp/xc \
 *     pnpm --filter @pickle/analytics test -- xc_redaction_fuzz
 *
 * Assertions pin only the CLAIMED classes (a bypass there is a regression);
 * the unclaimed classes are reported, not asserted, so the harness stays green
 * while making the guard's real coverage visible.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BufferedAnalytics,
  findPrivacyViolations,
  type AnalyticsEvent,
  type PrivacyViolation,
} from "../src/index.js";

const SEED = Number.parseInt(process.env.XC_SEED ?? "1602847", 10);
const ITER = Number.parseInt(process.env.XC_ITER ?? "3000", 10);
const ARTIFACT_DIR = process.env.XC_ARTIFACT_DIR ?? tmpdir();

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const B64URL = `${ALNUM}-_`;

function rs(rng: () => number, n: number, alphabet = ALNUM): string {
  let out = "";
  for (let i = 0; i < n; i += 1) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

function uuid(rng: () => number): string {
  const h = (n: number) => rs(rng, n, "0123456789abcdef");
  return `${h(8)}-${h(4)}-4${h(3)}-8${h(3)}-${h(12)}`;
}

/** Probe classes. `claimed` = REVIEW.md says the redaction layer rejects it. */
type ProbeClass =
  | "file_uri"
  | "content_uri"
  | "ph_uri"
  | "ios_private_path"
  | "ios_var_path"
  | "email"
  | "base64_std_blob"
  | "oversized_string"
  | "oversized_array"
  | "forbidden_key_uri"
  | "forbidden_key_email"
  | "forbidden_key_deviceId"
  | "forbidden_key_poseFrames"
  | "https_media_url"
  | "s3_https_url"
  | "base64url_blob"
  | "jwt_token"
  | "bearer_token"
  | "short_free_text"
  | "uuid_under_plain_key"
  | "path_after_colon"
  | "android_sdcard_path"
  | "ios_library_path";

const CLAIMED: ReadonlySet<ProbeClass> = new Set<ProbeClass>([
  "file_uri",
  "content_uri",
  "ph_uri",
  "ios_private_path",
  "ios_var_path",
  "email",
  "base64_std_blob",
  "oversized_string",
  "oversized_array",
  "forbidden_key_uri",
  "forbidden_key_email",
  "forbidden_key_deviceId",
  "forbidden_key_poseFrames",
]);

const ALL_CLASSES: readonly ProbeClass[] = [
  ...CLAIMED,
  "https_media_url",
  "s3_https_url",
  "base64url_blob",
  "jwt_token",
  "bearer_token",
  "short_free_text",
  "uuid_under_plain_key",
  "path_after_colon",
  "android_sdcard_path",
  "ios_library_path",
];

interface Probe {
  cls: ProbeClass;
  /** Where the payload was planted. */
  slot: "failureKind" | "modelVersion" | "extra_key" | "array_item";
  event: AnalyticsEvent;
  planted: string;
}

const at = "2026-09-04T00:00:00.000Z";

function payloadFor(rng: () => number, cls: ProbeClass): { text: string; key?: string } {
  const id = uuid(rng);
  switch (cls) {
    case "file_uri":
      return { text: `read error at file:///var/mobile/Containers/${id}/clip.mov` };
    case "content_uri":
      return { text: `content://media/external/video/${Math.floor(rng() * 1e6)}` };
    case "ph_uri":
      return { text: `ph://${id.toUpperCase()}/L0/001` };
    case "ios_private_path":
      return { text: `ENOENT /private/var/mobile/Containers/Data/${id}/tmp/clip.mov` };
    case "ios_var_path":
      return { text: `write failed /var/mobile/Containers/${id}/Documents/pose.json` };
    case "email":
      return { text: `rejected for ${rs(rng, 8).toLowerCase()}@${rs(rng, 6).toLowerCase()}.com` };
    case "base64_std_blob":
      return { text: rs(rng, 120 + Math.floor(rng() * 60), `${ALNUM}+/`) };
    case "oversized_string":
      return { text: `${rs(rng, 40)} `.repeat(6 + Math.floor(rng() * 4)) };
    case "oversized_array":
      return { text: "array" };
    case "forbidden_key_uri":
      return { text: `clip-${id}`, key: "uri" };
    case "forbidden_key_email":
      return { text: "redacted", key: "email" };
    case "forbidden_key_deviceId":
      return { text: id, key: "deviceId" };
    case "forbidden_key_poseFrames":
      return { text: "[]", key: "poseFrames" };
    case "https_media_url":
      return { text: `https://cdn.example.com/media/${id}/master.mp4` };
    case "s3_https_url":
      return {
        text: `https://pickle-media.s3.amazonaws.com/${id}.mov?X-Amz-Signature=${rs(rng, 40)}`,
      };
    case "base64url_blob":
      return { text: rs(rng, 150 + Math.floor(rng() * 40), B64URL) };
    case "jwt_token":
      return { text: `eyJhbGciOiJIUzI1NiJ9.${rs(rng, 60, B64URL)}.${rs(rng, 43, B64URL)}` };
    case "bearer_token":
      return { text: `Bearer ${rs(rng, 48, B64URL)}` };
    case "short_free_text":
      return { text: `my knee hurts after ${rs(rng, 5)} drills, call me` };
    case "uuid_under_plain_key":
      return { text: id, key: "installId" };
    case "path_after_colon":
      return { text: `path:/var/mobile/Containers/${id}/clip.mov` };
    case "android_sdcard_path":
      return { text: `/sdcard/DCIM/Camera/${id}.mp4` };
    case "ios_library_path":
      return { text: `/Library/Caches/${id}/clip.mov` };
  }
}

function buildProbe(rng: () => number, cls: ProbeClass): Probe {
  const { text, key } = payloadFor(rng, cls);
  if (cls === "oversized_array") {
    const items = Array.from({ length: 33 + Math.floor(rng() * 8) }, () => "brightness");
    return {
      cls,
      slot: "array_item",
      planted: `array(${items.length})`,
      event: {
        name: "capture_envelope_verdict",
        at,
        overall: "DEGRADED",
        failedDimensions: items,
        notMeasuredCount: 0,
        thresholdsVersion: "capture-envelope-thresholds-v0.1-provisional",
      },
    };
  }
  if (key) {
    const base: AnalyticsEvent = {
      name: "analysis_failed",
      at,
      failureKind: "pose_extraction_error",
    };
    return {
      cls,
      slot: "extra_key",
      planted: `${key}=${text}`,
      event: { ...base, [key]: text } as AnalyticsEvent,
    };
  }
  const slotRoll = rng();
  if (slotRoll < 0.4) {
    return {
      cls,
      slot: "failureKind",
      planted: text,
      event: { name: "analysis_failed", at, failureKind: text },
    };
  }
  if (slotRoll < 0.7) {
    return {
      cls,
      slot: "modelVersion",
      planted: text,
      event: { name: "analysis_started", at, inferenceMode: "on_device", modelVersion: text },
    };
  }
  return {
    cls,
    slot: "array_item",
    planted: text,
    event: {
      name: "capture_envelope_verdict",
      at,
      overall: "DEGRADED",
      failedDimensions: ["brightness", text],
      notMeasuredCount: 0,
      thresholdsVersion: "capture-envelope-thresholds-v0.1-provisional",
    },
  };
}

interface ClassRow {
  cls: ProbeClass;
  claimed: boolean;
  probes: number;
  caught: number;
  bypassed: number;
  rules: Record<string, number>;
  /** First replayable bypass (iteration + planted value) when any. */
  firstBypass: { iteration: number; slot: string; planted: string } | null;
}

describe(`xc analytics redaction fuzz (seed=${SEED}, iter=${ITER})`, () => {
  it("rejects every REVIEW.md-claimed class and records the bypass matrix for the rest", async () => {
    const rng = mulberry32(SEED);
    const rows = new Map<ProbeClass, ClassRow>(
      ALL_CLASSES.map((cls) => [
        cls,
        {
          cls,
          claimed: CLAIMED.has(cls),
          probes: 0,
          caught: 0,
          bypassed: 0,
          rules: {},
          firstBypass: null,
        },
      ]),
    );
    const sent: AnalyticsEvent[] = [];
    let onViolationCalls = 0;
    const sink = new BufferedAnalytics(
      async (batch) => {
        sent.push(...batch);
      },
      1,
      () => {
        onViolationCalls += 1;
      },
    );
    const claimedBypasses: Array<{
      iteration: number;
      cls: ProbeClass;
      slot: string;
      planted: string;
    }> = [];

    for (let iteration = 0; iteration < ITER; iteration += 1) {
      const cls = ALL_CLASSES[Math.floor(rng() * ALL_CLASSES.length)];
      if (!cls) throw new Error("class table is empty");
      const probe = buildProbe(rng, cls);
      const violations: PrivacyViolation[] = findPrivacyViolations(probe.event);
      const row = rows.get(cls);
      if (!row) throw new Error(`no row for ${cls}`);
      row.probes += 1;
      if (violations.length > 0) {
        row.caught += 1;
        for (const v of violations) row.rules[v.rule] = (row.rules[v.rule] ?? 0) + 1;
      } else {
        row.bypassed += 1;
        row.firstBypass ??= { iteration, slot: probe.slot, planted: probe.planted };
        if (CLAIMED.has(cls))
          claimedBypasses.push({ iteration, cls, slot: probe.slot, planted: probe.planted });
      }
      const before = sent.length;
      sink.track(probe.event);
      await sink.flush();
      const delivered = sent.length > before;
      if (delivered !== (violations.length === 0)) {
        throw new Error(
          `sink/guard disagreement at iteration ${iteration} (${cls}): delivered=${delivered} violations=${violations.length}`,
        );
      }
    }

    // Guard/sink coherence: exactly the violating events were dropped and reported.
    const totalCaught = [...rows.values()].reduce((n, r) => n + r.caught, 0);
    expect(sink.droppedViolationCount()).toBe(totalCaught);
    expect(onViolationCalls).toBe(totalCaught);
    expect(sent.length).toBe(ITER - totalCaught);

    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const artifact = join(ARTIFACT_DIR, "xc-analytics-redaction-fuzz.json");
    writeFileSync(
      artifact,
      JSON.stringify(
        {
          seed: SEED,
          iterations: ITER,
          droppedByGuard: totalCaught,
          deliveredBySink: sent.length,
          claimedBypasses,
          matrix: [...rows.values()],
        },
        null,
        2,
      ),
    );

    expect(claimedBypasses).toEqual([]);
  });
});
