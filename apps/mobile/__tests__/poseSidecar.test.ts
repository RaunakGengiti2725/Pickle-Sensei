import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { PoseSequenceSidecarRef } from '../src/camera/capture';
import { loadReviewPoseSequence } from '../src/review/poseSidecar';

/**
 * Form review pose loading — the same read/verify/parse path the analysis
 * engine uses. A valid sidecar yields the canonical sequence; a hash
 * mismatch, unreadable file or invalid document yields null. Nothing is ever
 * repaired into a frame the camera did not record.
 */

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

function refFor(json: string, overrides: Partial<PoseSequenceSidecarRef> = {}) {
  return {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri: 'file:///captures/clip.pose.json',
    frameCount: 0,
    sha256: sha256Hex(json),
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
    ...overrides,
  } as PoseSequenceSidecarRef;
}

describe('loadReviewPoseSequence', () => {
  it('returns the parsed sequence for a byte-identical, valid sidecar', async () => {
    const { sequence } = generateSwingSequence();
    const json = serializePoseSequence(sequence);
    const reads: string[] = [];
    mockReadArtifact = async uri => {
      reads.push(uri);
      return json;
    };
    const loaded = await loadReviewPoseSequence(
      refFor(json, { frameCount: sequence.frames.length }),
    );
    expect(reads).toEqual(['file:///captures/clip.pose.json']);
    expect(loaded).not.toBeNull();
    expect(loaded?.frames).toHaveLength(sequence.frames.length);
    expect(loaded?.frames[0]?.timestampMs).toBe(
      sequence.frames[0]?.timestampMs,
    );
    expect(loaded?.frames[0]?.landmarks[0]).toEqual(
      sequence.frames[0]?.landmarks[0],
    );
    expect(loaded?.video).toEqual(sequence.video);
  });

  it('returns null on a hash mismatch — the sidecar is never trusted or repaired', async () => {
    const { sequence } = generateSwingSequence();
    const json = serializePoseSequence(sequence);
    mockReadArtifact = async () => json;
    const loaded = await loadReviewPoseSequence(
      refFor(json, { sha256: 'ab'.repeat(32) }),
    );
    expect(loaded).toBeNull();
  });

  it('returns null when the sidecar is not valid JSON (even with a matching hash)', async () => {
    const corrupt = '{not json';
    mockReadArtifact = async () => corrupt;
    expect(await loadReviewPoseSequence(refFor(corrupt))).toBeNull();
  });

  it('returns null when the document parses but fails the canonical schema', async () => {
    const wrongSchema = JSON.stringify({
      schemaVersion: 99,
      format: 'pickle.pose-sequence.v1',
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'x',
      video: { w: 1080, h: 1920, fps: 30 },
      frames: [],
    });
    mockReadArtifact = async () => wrongSchema;
    expect(await loadReviewPoseSequence(refFor(wrongSchema))).toBeNull();
  });

  it('returns null when the artifact cannot be read or no ref exists', async () => {
    mockReadArtifact = async () => {
      throw new Error('file gone');
    };
    expect(await loadReviewPoseSequence(refFor('{}'))).toBeNull();
    expect(await loadReviewPoseSequence(null)).toBeNull();
    expect(await loadReviewPoseSequence(undefined)).toBeNull();
  });
});
