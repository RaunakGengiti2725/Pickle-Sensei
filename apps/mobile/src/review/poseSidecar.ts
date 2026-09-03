import { Platform } from 'react-native';
import { parsePoseSequence, sha256Hex } from '@pickle/swing-domain';
import {
  readCaptureArtifact,
  type PoseSequenceSidecarRef,
} from '../camera/capture';
import type { ReviewPoseSequence } from './formReviewModel';

/**
 * Loads the recorded pose-sequence sidecar for the Form Review — the SAME
 * read path the analysis engine uses (runCaptureAnalysis): read the private
 * artifact, require a byte-identical SHA-256 against the capture's ref, then
 * the canonical strict parse. Any failure (unreadable file, hash mismatch,
 * invalid document) yields null: the review then shows no skeleton rather
 * than a repaired or guessed one.
 */
export async function loadReviewPoseSequence(
  ref: PoseSequenceSidecarRef | null | undefined,
): Promise<ReviewPoseSequence | null> {
  if (!ref || typeof ref.uri !== 'string' || ref.uri.length === 0) return null;
  let sidecarJson: string;
  try {
    sidecarJson = await readCaptureArtifact(ref.uri);
  } catch {
    return null;
  }
  if (typeof sidecarJson !== 'string') return null;
  // Integrity: the sidecar must be byte-identical to what capture recorded.
  try {
    if (sha256Hex(sidecarJson) !== ref.sha256) return null;
  } catch {
    return null;
  }
  const parsed = parsePoseSequence(sidecarJson, {
    providerId:
      Platform.OS === 'android' ? 'pose.mediapipe' : 'pose.apple-vision',
    runtime: Platform.OS === 'android' ? 'mediapipe' : 'vision_framework',
    executionTarget: 'on_device',
    artifactHash: null,
  });
  if (!parsed.ok) return null;
  return parsed.value;
}
