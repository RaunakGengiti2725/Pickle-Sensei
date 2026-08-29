export type TrainingLoadStatus =
  'idle' | 'loading' | 'ready' | 'unconfigured' | 'error';

export type TrainingErrorCode =
  | 'training.unconfigured'
  | 'training.unavailable'
  | 'training.invalid_response'
  | 'training.request_failed'
  | 'training.invalid_completion';

export interface TrainingErrorState {
  code: TrainingErrorCode | string;
  message: string;
  retryable: boolean;
  status: number | null;
}

export class TrainingError extends Error {
  constructor(
    readonly code: TrainingErrorCode | string,
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
  }

  toState(): TrainingErrorState {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
    };
  }
}

export interface SavedDrill {
  id: string;
  slug: string;
  title: string;
  description: string;
  coachName: string;
  equipment: unknown[];
  difficultyMin: string | null;
  difficultyMax: string | null;
  savedAt: string;
}

export interface DrillMapping {
  checkpoint: string;
  shotType: string;
  planRole: 'warmup' | 'targeted';
  faultDirections: string[];
  cueText: string;
  targetSets: number;
  targetRepetitionsPerSet: number | null;
  targetDurationSeconds: number | null;
  restSeconds: number | null;
}

interface InstructionalMediaBase {
  id: string;
  sourceUrl: string;
  creatorName: string;
  licenseName: string;
  licenseUrl: string | null;
  attribution: string;
}

export interface HostedInstructionalMedia extends InstructionalMediaBase {
  kind: 'hosted';
  playbackUrl: string;
  expiresAt: string;
}

export interface EmbeddedInstructionalMedia extends InstructionalMediaBase {
  kind: 'embed';
  provider: 'youtube' | 'vimeo';
  videoId: string;
  embedUrl: string;
}

export type InstructionalMedia =
  HostedInstructionalMedia | EmbeddedInstructionalMedia;

export interface DrillDetail {
  id: string;
  slug: string;
  title: string;
  description: string;
  coachName: string;
  equipment: unknown[];
  difficultyMin: string | null;
  difficultyMax: string | null;
  saved: boolean;
  mappings: DrillMapping[];
  instructionalMedia: InstructionalMedia[];
}

export interface DrillCompletion {
  id: string;
  completedAt: string;
  actualRepetitions: number | null;
  actualDurationSeconds: number | null;
  qualifiesForStreak: boolean;
}

export interface TrainingPlanDrill {
  slug: string;
  title: string;
  description: string;
  coachName: string;
  equipment: unknown[];
  saved: boolean;
}

export interface TrainingPlanItem {
  id: string;
  position: number;
  kind: 'warmup' | 'targeted' | 'reassessment';
  drill: TrainingPlanDrill | null;
  cueText: string | null;
  targetSets: number | null;
  targetRepetitionsPerSet: number | null;
  targetDurationSeconds: number | null;
  restSeconds: number | null;
  completion: DrillCompletion | null;
}

export interface TrainingPlan {
  id: string;
  status: 'active' | 'completed' | 'superseded';
  algorithmVersion: string;
  sourceShotId: string;
  shotType: string;
  priorityCheckpoint: string;
  priorityDirection: string;
  baselineScore: number;
  baselineCheckpointScore: number | null;
  reassessmentShotId: string | null;
  scoreDelta: number | null;
  createdAt: string;
  completedAt: string | null;
  items: TrainingPlanItem[];
}

export interface CompletionEvidence {
  id: string;
  drillSlug: string;
  trainingPlanItemId: string;
  completedAt: string;
  actualRepetitions: number | null;
  actualDurationSeconds: number | null;
}

export interface TrainingApi {
  listSavedDrills(): Promise<SavedDrill[]>;
  getDrill(slug: string): Promise<DrillDetail>;
  saveDrill(slug: string): Promise<void>;
  unsaveDrill(slug: string): Promise<void>;
  getCurrentPlan(): Promise<TrainingPlan | null>;
  createPlan(sourceShotId: string): Promise<TrainingPlan>;
  completeDrill(evidence: CompletionEvidence): Promise<DrillCompletion>;
  reassessPlan(planId: string, shotId: string): Promise<TrainingPlan>;
}
