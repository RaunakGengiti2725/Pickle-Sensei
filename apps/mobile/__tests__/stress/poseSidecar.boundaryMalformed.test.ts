import { parsePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { PoseSequenceSidecarRef } from '../../src/camera/capture';
import { loadReviewPoseSequence } from '../../src/review/poseSidecar';
import {
  PROTO_KEYS,
  ResultTable,
  Rng,
  TRAVERSAL_STRINGS,
  WIRE_MUTATIONS,
  bigString,
  brokenSummary,
  campaignPlan,
  corruptJsonText,
  invariant,
  prototypeFingerprint,
  runCaseAsync,
  safeString,
  validWire,
  weirdString,
  weirdValue,
} from '../../test-support/stress/reviewMalformed';

/**
 * STRESS · boundary/malformed input · poseSidecar.loadReviewPoseSequence.
 *
 * Contract: read the artifact named by the ref, verify the SHA-256 over the
 * exact bytes, parse with the canonical strict parser; ANY failure → null,
 * never a throw, never a repaired/fabricated frame, and exactly one read of
 * exactly `ref.uri` (no traversal, no retry). Only `readCaptureArtifact` is
 * mocked — the hash and the parser are the real ones.
 */

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const table = new ResultTable('poseSidecar');
const plan = campaignPlan(60);

afterAll(() => {
  table.flush();
});

function mutateWire(rng: Rng, log: string[]): string {
  const wire = validWire(rng, rng.pick([1, 2, 12, 40])) as unknown as Record<
    string,
    unknown
  >;
  const count = rng.int(0, 4);
  log.push(`wireMutations×${count}`);
  for (let step = 0; step < count; step += 1) {
    const mutation = rng.pick(WIRE_MUTATIONS);
    mutation.apply(rng, wire);
    log.push(mutation.name);
  }
  let json: string;
  try {
    json = JSON.stringify(wire) ?? 'undefined';
  } catch {
    json = '{"circular":true}';
  }
  if (rng.chance(0.3)) json = corruptJsonText(rng, json, log);
  return json;
}

function refFor(rng: Rng, json: string, log: string[]): PoseSequenceSidecarRef {
  const ref: Record<string, unknown> = {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri: 'file:///captures/clip.pose.json',
    frameCount: 0,
    sha256: sha256Hex(json),
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
  };
  const roll = rng.int(0, 9);
  if (roll === 0) {
    log.push('ref.sha=wrong');
    ref.sha256 = sha256Hex(`${json} `);
  } else if (roll === 1) {
    log.push('ref.sha=weird');
    ref.sha256 = weirdValue(rng);
  } else if (roll === 2) {
    log.push('ref.sha=upperCase');
    ref.sha256 = sha256Hex(json).toUpperCase();
  } else if (roll === 3) {
    log.push('ref.uri=traversal');
    ref.uri = rng.pick(TRAVERSAL_STRINGS);
  } else if (roll === 4) {
    log.push('ref.uri=weird');
    ref.uri = rng.chance(0.5) ? weirdString(rng) : weirdValue(rng);
  } else if (roll === 5) {
    log.push('ref.extraProto');
    Object.assign(ref, JSON.parse('{"__proto__":{"sidecarPolluted":1}}'));
  } else if (roll === 6) {
    log.push('ref.frameCount=weird');
    ref.frameCount = weirdValue(rng);
  } else {
    log.push('ref.valid');
  }
  return ref as unknown as PoseSequenceSidecarRef;
}

describe('poseSidecar · boundary/malformed campaign', () => {
  const fingerprint = prototypeFingerprint();

  it('loadReviewPoseSequence resolves null or a canonical sequence — never throws, never reads elsewhere', async () => {
    for (let i = 0; i < plan.iterations; i += 1) {
      await runCaseAsync(
        table,
        'loadSidecar',
        plan.seedAt(i),
        async (rng, log) => {
          const json = mutateWire(rng, log);
          const ref = refFor(rng, json, log);
          const reads: string[] = [];
          const readMode = rng.int(0, 9);
          mockReadArtifact = async uri => {
            reads.push(uri);
            if (readMode === 0) {
              log.push('read=throws');
              throw new Error('ENOENT');
            }
            if (readMode === 1) {
              log.push('read=nonString');
              return weirdValue(rng) as string;
            }
            if (readMode === 2) {
              log.push('read=bigString');
              return bigString(rng.int(0, 4));
            }
            return json;
          };
          const loaded = await loadReviewPoseSequence(ref);
          const uri = (ref as unknown as { uri: unknown }).uri;
          if (typeof uri !== 'string' || uri.length === 0) {
            invariant(reads.length === 0, 'no read for a ref without a uri');
            invariant(loaded === null, 'null for a ref without a uri');
          } else {
            invariant(
              reads.length === 1 && reads[0] === uri,
              `exactly one read of ref.uri (got ${safeString(reads)})`,
            );
          }
          if (loaded !== null) {
            invariant(readMode >= 3, 'a broken read never yields a sequence');
            invariant(
              (ref as unknown as { sha256: unknown }).sha256 ===
                sha256Hex(json),
              'a sequence is only returned when the hash matched exactly',
            );
            const reparsed = parsePoseSequence(json, {
              providerId: 'pose.apple-vision',
              runtime: 'vision_framework',
              executionTarget: 'on_device',
              artifactHash: null,
            });
            invariant(
              reparsed.ok,
              'a returned sequence re-parses under the strict schema',
            );
            // An empty `frames: []` is schema-valid (the parser only requires
            // an array); selectors return null over it.
            invariant(
              Array.isArray(loaded.frames),
              'returned sequence carries a frames array',
            );
            let previous = -Infinity;
            for (const frame of loaded.frames) {
              invariant(
                Number.isFinite(frame.timestampMs) &&
                  frame.timestampMs > previous,
                'frames strictly increasing and finite',
              );
              previous = frame.timestampMs;
              invariant(
                frame.landmarks.length > 0 &&
                  frame.landmarks.every(
                    mark =>
                      typeof mark.name === 'string' &&
                      mark.name.length > 0 &&
                      Number.isFinite(mark.x) &&
                      Number.isFinite(mark.y) &&
                      Number.isFinite(mark.visibility),
                  ),
                'landmarks finite and named',
              );
            }
            invariant(
              loaded.video !== undefined &&
                ('w' in loaded.video
                  ? loaded.video.w > 0 && loaded.video.h > 0
                  : loaded.video.width > 0 && loaded.video.height > 0) &&
                loaded.video.fps > 0,
              'video dims positive',
            );
          }
          invariant(
            prototypeFingerprint() === fingerprint,
            'no prototype pollution',
          );
          invariant(
            (Object.prototype as { sidecarPolluted?: unknown })
              .sidecarPolluted === undefined,
            'ref __proto__ key did not pollute',
          );
        },
      );
    }
    expect(brokenSummary(table)).toBe(`0 broken of ${table.records.length}`);
  });
});

describe('poseSidecar · pinned boundary probes', () => {
  it.each([null, undefined, {}, { uri: '' }, { uri: 42 }, { uri: null }])(
    'returns null without reading for ref %p',
    async ref => {
      const reads: string[] = [];
      mockReadArtifact = async uri => {
        reads.push(uri);
        return '{}';
      };
      expect(await loadReviewPoseSequence(ref as never)).toBeNull();
      expect(reads).toEqual([]);
    },
  );

  it('rejects future schema versions and unknown formats with matching hashes', async () => {
    const rng = new Rng(3);
    for (const patch of [
      { schemaVersion: 2 },
      { schemaVersion: 99 },
      { schemaVersion: '1' },
      { format: 'pickle.pose-sequence.v2' },
      { coordinateSystem: 'polar' },
      { poseModelVersion: '' },
    ]) {
      const json = JSON.stringify({ ...validWire(rng, 3), ...patch });
      mockReadArtifact = async () => json;
      const ref = {
        uri: 'file:///captures/clip.pose.json',
        sha256: sha256Hex(json),
      } as unknown as PoseSequenceSidecarRef;
      expect(await loadReviewPoseSequence(ref)).toBeNull();
    }
  });

  it('treats a hash over NFD bytes as a mismatch for NFC content (byte-exact integrity)', async () => {
    const rng = new Rng(4);
    const nfc = JSON.stringify({
      ...validWire(rng, 3),
      poseModelVersion: 'caf\u00e9',
    });
    const nfd = JSON.stringify({
      ...validWire(rng, 3),
      poseModelVersion: 'cafe\u0301',
    });
    mockReadArtifact = async () => nfc;
    const ref = {
      uri: 'file:///captures/clip.pose.json',
      sha256: sha256Hex(nfd),
    } as unknown as PoseSequenceSidecarRef;
    expect(await loadReviewPoseSequence(ref)).toBeNull();
  });

  it.each(PROTO_KEYS)(
    'a landmark named %p is kept verbatim, never mapped through Object.prototype',
    async name => {
      const rng = new Rng(5);
      const wire = validWire(rng, 2);
      wire.frames[0]!.l[0]!.n = name;
      const json = JSON.stringify(wire);
      mockReadArtifact = async () => json;
      const loaded = await loadReviewPoseSequence({
        uri: 'file:///captures/clip.pose.json',
        sha256: sha256Hex(json),
      } as unknown as PoseSequenceSidecarRef);
      expect(loaded?.frames[0]?.landmarks[0]?.name).toBe(name);
    },
  );
});
