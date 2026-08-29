import {
  FROZEN_HEALTH_CRITERIA_V1,
  evaluateHealth,
  type HealthCriteria,
  type HealthInputs,
  type HealthReport,
} from "./healthCriteria.js";

/**
 * Staged-rollout state machine — pure logic, no I/O.
 *
 * A rollout carries exactly one candidate model version toward 100% exposure
 * through the frozen stage ladder. The known-good predecessor is recorded at
 * creation and is immutable; rollback always lands there. Every transition
 * is driven by a HealthReport over the frozen criteria — there is no code
 * path that promotes without an overall-HEALTHY report.
 */

export const ROLLOUT_STAGES_V1 = [1, 5, 20, 50, 100] as const;
export type RolloutStagePercent = (typeof ROLLOUT_STAGES_V1)[number];

export const ROLLOUT_STATUSES = ["in_progress", "paused", "rolled_back", "complete"] as const;
export type RolloutStatus = (typeof ROLLOUT_STATUSES)[number];

export const TRANSITION_ACTIONS = ["create", "promote", "pause", "resume", "rollback"] as const;
export type TransitionAction = (typeof TRANSITION_ACTIONS)[number];

export interface RolloutTransition {
  seq: number;
  action: TransitionAction;
  fromStagePercent: RolloutStagePercent | 0;
  toStagePercent: RolloutStagePercent | 0;
  fromStatus: RolloutStatus;
  toStatus: RolloutStatus;
  /** Null only for the synthetic `create` transition. */
  health: HealthReport | null;
  occurredAtMs: number;
}

export interface RolloutState {
  rolloutId: string;
  modelId: string;
  candidateVersion: string;
  /** The recorded known-good predecessor; immutable after creation. */
  knownGoodVersion: string;
  /**
   * The version currently serving traffic outside the canary slice — and
   * ALL traffic after a rollback. Always the known-good predecessor until
   * the rollout completes.
   */
  activeVersion: string;
  stagePercent: RolloutStagePercent | 0;
  status: RolloutStatus;
  criteriaId: string;
  transitions: readonly RolloutTransition[];
}

export function createRollout(params: {
  rolloutId: string;
  modelId: string;
  candidateVersion: string;
  knownGoodVersion: string;
  nowMs: number;
}): RolloutState {
  if (params.candidateVersion === params.knownGoodVersion) {
    throw new Error("Candidate and known-good versions must differ.");
  }
  const create: RolloutTransition = {
    seq: 0,
    action: "create",
    fromStagePercent: 0,
    toStagePercent: ROLLOUT_STAGES_V1[0],
    fromStatus: "in_progress",
    toStatus: "in_progress",
    health: null,
    occurredAtMs: params.nowMs,
  };
  return {
    rolloutId: params.rolloutId,
    modelId: params.modelId,
    candidateVersion: params.candidateVersion,
    knownGoodVersion: params.knownGoodVersion,
    activeVersion: params.knownGoodVersion,
    stagePercent: ROLLOUT_STAGES_V1[0],
    status: "in_progress",
    criteriaId: FROZEN_HEALTH_CRITERIA_V1.id,
    transitions: [create],
  };
}

export function isTerminal(state: RolloutState): boolean {
  return state.status === "rolled_back" || state.status === "complete";
}

function nextStage(current: RolloutStagePercent): RolloutStagePercent | null {
  const index = ROLLOUT_STAGES_V1.indexOf(current);
  return ROLLOUT_STAGES_V1[index + 1] ?? null;
}

function appendTransition(
  state: RolloutState,
  transition: Omit<RolloutTransition, "seq">,
): RolloutTransition {
  const last = state.transitions[state.transitions.length - 1];
  return { ...transition, seq: (last?.seq ?? -1) + 1 };
}

/**
 * Applies one health window to the rollout. The only inputs are typed metric
 * observations; the decision is a pure function of the frozen criteria:
 *
 * - HEALTHY        → promote to the next stage (complete at 100%).
 * - NOT_EVALUABLE  → pause (hold exposure; never treated as healthy).
 * - UNHEALTHY      → rollback to the recorded known-good predecessor.
 *
 * A paused rollout resumes (and promotes) only on a later HEALTHY window.
 * Terminal states reject further evaluation.
 */
export function applyHealthWindow(
  state: RolloutState,
  inputs: HealthInputs,
  nowMs: number,
  criteria: HealthCriteria = FROZEN_HEALTH_CRITERIA_V1,
): RolloutState {
  if (isTerminal(state)) {
    throw new Error(`Rollout ${state.rolloutId} is terminal (${state.status}).`);
  }
  if (state.stagePercent === 0) {
    throw new Error(`Rollout ${state.rolloutId} has no active stage.`);
  }
  const health = evaluateHealth(inputs, criteria);

  if (health.overall === "UNHEALTHY") {
    const transition = appendTransition(state, {
      action: "rollback",
      fromStagePercent: state.stagePercent,
      toStagePercent: 0,
      fromStatus: state.status,
      toStatus: "rolled_back",
      health,
      occurredAtMs: nowMs,
    });
    return {
      ...state,
      stagePercent: 0,
      status: "rolled_back",
      activeVersion: state.knownGoodVersion,
      transitions: [...state.transitions, transition],
    };
  }

  if (health.overall === "NOT_EVALUABLE") {
    const transition = appendTransition(state, {
      action: "pause",
      fromStagePercent: state.stagePercent,
      toStagePercent: state.stagePercent,
      fromStatus: state.status,
      toStatus: "paused",
      health,
      occurredAtMs: nowMs,
    });
    return {
      ...state,
      status: "paused",
      transitions: [...state.transitions, transition],
    };
  }

  // HEALTHY. A paused rollout resumes; then the stage advances.
  const target = nextStage(state.stagePercent);
  if (target === null) {
    // Already at 100% and healthy: the candidate becomes the active version.
    const transition = appendTransition(state, {
      action: "promote",
      fromStagePercent: state.stagePercent,
      toStagePercent: state.stagePercent,
      fromStatus: state.status,
      toStatus: "complete",
      health,
      occurredAtMs: nowMs,
    });
    return {
      ...state,
      status: "complete",
      activeVersion: state.candidateVersion,
      transitions: [...state.transitions, transition],
    };
  }
  const transition = appendTransition(state, {
    action: state.status === "paused" ? "resume" : "promote",
    fromStagePercent: state.stagePercent,
    toStagePercent: target,
    fromStatus: state.status,
    toStatus: "in_progress",
    health,
    occurredAtMs: nowMs,
  });
  return {
    ...state,
    stagePercent: target,
    status: "in_progress",
    transitions: [...state.transitions, transition],
  };
}

/**
 * Operator-initiated rollback (kill switch). Needs no health report — it is
 * always allowed on a non-terminal rollout and always lands on the recorded
 * known-good predecessor.
 */
export function forceRollback(state: RolloutState, nowMs: number): RolloutState {
  if (isTerminal(state)) {
    throw new Error(`Rollout ${state.rolloutId} is terminal (${state.status}).`);
  }
  const transition = appendTransition(state, {
    action: "rollback",
    fromStagePercent: state.stagePercent,
    toStagePercent: 0,
    fromStatus: state.status,
    toStatus: "rolled_back",
    health: null,
    occurredAtMs: nowMs,
  });
  return {
    ...state,
    stagePercent: 0,
    status: "rolled_back",
    activeVersion: state.knownGoodVersion,
    transitions: [...state.transitions, transition],
  };
}
