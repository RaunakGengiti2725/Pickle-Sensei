import type { Motion3DAnalysis } from '@pickle/analysis-pipeline';
import type { StrokeResultClip } from './StrokeResult';
import type { StrokeResultEvidence } from './strokeResultData';

export type AnalysisPresentation =
  | {
      kind: 'motion_3d';
      motion: Motion3DAnalysis;
      clip: StrokeResultClip | null;
    }
  | { kind: 'legacy_2d' }
  | { kind: 'missing' };

export function resolveAnalysisPresentation(
  evidence: StrokeResultEvidence,
): AnalysisPresentation {
  if (evidence.motion3d) {
    const { record } = evidence.motion3d;
    if (
      record.engine !== 'motion_3d' ||
      record.purpose !== 'development_validation' ||
      record.capabilities.visualization !== 'development_only' ||
      record.capabilities.scoring !== 'blocked' ||
      record.capabilities.coaching !== 'blocked'
    ) {
      return { kind: 'missing' };
    }
    return {
      kind: 'motion_3d',
      motion: evidence.motion3d,
      clip: evidence.clip,
    };
  }
  return {
    kind: evidence.analysis || evidence.record ? 'legacy_2d' : 'missing',
  };
}
