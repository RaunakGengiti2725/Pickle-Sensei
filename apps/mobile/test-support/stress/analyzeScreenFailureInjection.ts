/**
 * Seeded failure-injection catalogue for the AnalyzeScreen stress campaign
 * (`__tests__/stress/analyzeScreenFailureInjection.stress.test.tsx`).
 *
 * Everything here is pure data + deterministic derivation: a seed selects a
 * fault cell and every free parameter of that fault (delays, payload variant,
 * which recovery control the player presses). The jest suite owns the world
 * (native bridge, SQLite, fetch, Keychain, RevenueCat, clock, navigator) and
 * consults the plan produced here, so any iteration is replayable from its
 * seed alone: `STRESS_SEEDS=<seed>` reruns exactly that plan.
 */

export type Dependency =
  | 'camera'
  | 'permissions'
  | 'sqlite'
  | 'fetch'
  | 'vision'
  | 'keychain'
  | 'revenuecat'
  | 'clock'
  | 'navigation';

export type FaultForm =
  'throw' | 'reject' | 'timeout' | 'malformed' | 'partial' | 'slow' | 'never';

export type Source = 'camera' | 'library';

/** Deterministic PRNG (mulberry32); identical to test-support/matrix. */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return (
      minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1))
    );
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
}

// ─── Fault primitives ────────────────────────────────────────────────────────

/** How a single native/async seam misbehaves for this iteration. */
export type SeamBehaviour =
  | { mode: 'ok'; delayMs: number }
  | { mode: 'throw'; message: string }
  | { mode: 'reject'; code: string | null; message: string; delayMs: number }
  | { mode: 'never' }
  | { mode: 'malformed'; variant: string; delayMs: number }
  | { mode: 'partial'; variant: string; delayMs: number };

export interface SqlFault {
  /** Regex source matched against the statement's leading SQL. */
  match: string;
  form: 'throw' | 'reject' | 'never' | 'slow' | 'malformed';
  delayMs: number;
  /** 1-based statement occurrence the fault applies to (others pass). */
  onNth: number;
}

export type Route =
  | 'auth.refresh'
  | 'access.get'
  | 'permits.reserve'
  | 'permits.release'
  | 'shots.sync';

export interface RouteFault {
  route: Route;
  form:
    | 'reject'
    | 'never'
    | 'slow'
    | 'malformed_json'
    | 'malformed_body'
    | 'partial_body'
    | 'status';
  status: number;
  variant: string;
  delayMs: number;
  /** 1-based call occurrence the fault applies to (others pass). */
  onNth: number;
}

export type KeychainFault =
  | {
      op: 'get';
      form: 'reject' | 'never' | 'malformed' | 'slow';
      delayMs: number;
      variant: string;
    }
  | { op: 'set'; form: 'reject' | 'throw' };

export type RevenueCatFault = {
  method:
    | 'isConfigured'
    | 'configure'
    | 'getAppUserID'
    | 'logIn'
    | 'getOfferings'
    | 'checkTrialOrIntroductoryPriceEligibility';
  form: 'throw' | 'reject' | 'never' | 'slow' | 'malformed' | 'partial';
  delayMs: number;
  variant: string;
};

export type VisionFault = {
  target:
    | 'registry'
    | 'phase'
    | 'biomechanics'
    | 'scorer'
    | 'faultDetector'
    | 'coach';
  form:
    | 'unavailable'
    | 'throw'
    | 'reject'
    | 'never'
    | 'slow'
    | 'malformed'
    | 'partial';
  delayMs: number;
  variant: string;
};

export type ClockFault =
  | { kind: 'frozen' }
  | { kind: 'jump_backwards'; byMs: number; atStage: 'analysis' }
  | { kind: 'jump_forwards'; byMs: number; atStage: 'analysis' }
  | { kind: 'absolute'; epochMs: number }
  | { kind: 'bearer_expires_in_past' };

export type NavigationFault =
  | {
      action: 'close';
      atStage: 'capture_working' | 'analysis_working';
      times: 1 | 2;
    }
  | { action: 'navigate_home'; atStage: 'analysis_working' }
  | { action: 'retry_double_tap' }
  | { action: 'try_again_then_close_race' };

export interface PermissionScript {
  /** Native events emitted (in order) after the capture is requested. */
  events: Array<'requesting' | 'granted' | 'denied' | 'malformed'>;
  /** What the capture promise then does. */
  outcome: 'reject_denied' | 'never' | 'ok';
  denyAfterMs: number;
}

export interface FaultPlan {
  seed: number;
  cell: string;
  dependency: Dependency;
  form: FaultForm;
  source: Source;
  /** Camera source: declared technique (true) or armed Auto Detect (false). */
  declare: boolean;
  /** Which recovery control the player uses on an error surface. */
  recovery: 'try_again' | 'close';
  capture: SeamBehaviour;
  readTextFile: SeamBehaviour;
  extraction: SeamBehaviour;
  permission: PermissionScript | null;
  sql: SqlFault[];
  fetch: RouteFault[];
  keychain: KeychainFault | null;
  revenueCat: RevenueCatFault | null;
  vision: VisionFault | null;
  clock: ClockFault | null;
  navigation: NavigationFault | null;
}

const OK: SeamBehaviour = { mode: 'ok', delayMs: 0 };

function basePlan(seed: number, rng: Rng, source: Source): FaultPlan {
  return {
    seed,
    cell: '',
    dependency: 'camera',
    form: 'reject',
    source,
    declare: source === 'library' ? true : rng.chance(0.7),
    recovery: rng.chance(0.65) ? 'try_again' : 'close',
    capture: { mode: 'ok', delayMs: rng.int(0, 400) },
    readTextFile: OK,
    extraction: OK,
    permission: null,
    sql: [],
    fetch: [],
    keychain: null,
    revenueCat: null,
    vision: null,
    clock: null,
    navigation: null,
  };
}

const CAMERA_REJECT_CODES = [
  'camera.session_failed',
  'camera.storage_failed',
  'camera.processing_failed',
  'camera.interrupted',
  'camera.evidence_unavailable',
  'camera.configuration_failed',
  'camera.session_busy',
  null,
] as const;

const CLIP_MALFORMED_VARIANTS = [
  'null',
  'string',
  'empty_object',
  'wrong_mode',
  'missing_uri',
  'negative_duration',
  'pose_ref_wrong_type',
  'recognition_garbage',
  'trigger_nan',
] as const;

const CLIP_PARTIAL_VARIANTS = [
  'no_pose_sequence',
  'no_capture_evidence',
  'no_target_seed',
  'no_trigger',
] as const;

const SIDECAR_MALFORMED_VARIANTS = [
  'not_json',
  'wrong_format',
  'frames_not_array',
  'one_flipped_byte',
  'empty_string',
] as const;

const SIDECAR_PARTIAL_VARIANTS = [
  'truncated_half',
  'frames_dropped',
  'frame_missing_joints',
] as const;

const EXTRACTION_MALFORMED_VARIANTS = [
  'null',
  'frames_with_pose_gt_total',
  'pose_ref_missing',
  'frames_zero',
] as const;

const PERMIT_MALFORMED_VARIANTS = [
  'permit_null',
  'permit_string',
  'id_empty',
  'id_number',
  'status_consumed',
  'status_released',
  'missing_expires',
  'access_garbage',
] as const;

const RC_MALFORMED_VARIANTS = [
  'offerings_null_current',
  'offerings_garbage',
  'packages_all_null',
  'price_string',
] as const;

const VISION_MALFORMED_VARIANTS = [
  'ok_null_value',
  'ok_garbage_value',
  'nan_confidence',
  'score_out_of_range',
  'empty_checkpoints',
  'not_a_result',
] as const;

type CellBuilder = (plan: FaultPlan, rng: Rng) => void;

interface Cell {
  id: string;
  dependency: Dependency;
  form: FaultForm;
  sources: readonly Source[];
  build: CellBuilder;
}

/** Native-seam delays at or above this are the injected `slow` fault. */
export const SLOW_SEAM_MS = 3_000;

function slowMs(rng: Rng): number {
  return rng.int(SLOW_SEAM_MS, 45_000);
}

/**
 * Every fault cell the campaign draws from. Coverage order: the first
 * `CELLS.length` iterations of a campaign visit each cell once (seed-derived
 * parameters still vary); later iterations pick cells at random.
 */
export const CELLS: readonly Cell[] = [
  // ── camera bridge ────────────────────────────────────────────────────
  {
    id: 'camera.reject',
    dependency: 'camera',
    form: 'reject',
    sources: ['camera', 'library'],
    build: (p, r) => {
      const code = r.pick(CAMERA_REJECT_CODES);
      p.capture = {
        mode: 'reject',
        code,
        message: code
          ? `native failed: ${code}`
          : 'native failed without a code',
        delayMs: r.int(0, 2_000),
      };
    },
  },
  {
    id: 'camera.throw',
    dependency: 'camera',
    form: 'throw',
    sources: ['camera', 'library'],
    build: p => {
      p.capture = { mode: 'throw', message: 'bridge threw synchronously' };
    },
  },
  {
    id: 'camera.never',
    dependency: 'camera',
    form: 'never',
    sources: ['camera', 'library'],
    build: p => {
      p.capture = { mode: 'never' };
    },
  },
  {
    id: 'camera.slow',
    dependency: 'camera',
    form: 'slow',
    sources: ['camera', 'library'],
    build: (p, r) => {
      p.capture = { mode: 'ok', delayMs: slowMs(r) };
    },
  },
  {
    id: 'camera.timeout',
    dependency: 'camera',
    form: 'timeout',
    sources: ['camera'],
    build: (p, r) => {
      p.capture = {
        mode: 'reject',
        code: 'camera.interrupted',
        message:
          'Camera capture was interrupted. Try again when the camera is available.',
        delayMs: r.int(10_000, 40_000),
      };
    },
  },
  {
    id: 'camera.malformed',
    dependency: 'camera',
    form: 'malformed',
    sources: ['camera', 'library'],
    build: (p, r) => {
      p.capture = {
        mode: 'malformed',
        variant: r.pick(CLIP_MALFORMED_VARIANTS),
        delayMs: r.int(0, 500),
      };
    },
  },
  {
    id: 'camera.partial',
    dependency: 'camera',
    form: 'partial',
    sources: ['camera'],
    build: (p, r) => {
      p.capture = {
        mode: 'partial',
        variant: r.pick(CLIP_PARTIAL_VARIANTS),
        delayMs: r.int(0, 500),
      };
    },
  },
  // ── camera permission ────────────────────────────────────────────────
  {
    id: 'permissions.denied',
    dependency: 'permissions',
    form: 'reject',
    sources: ['camera'],
    build: (p, r) => {
      p.permission = {
        events: ['requesting', 'denied'],
        outcome: 'reject_denied',
        denyAfterMs: r.int(0, 3_000),
      };
    },
  },
  {
    id: 'permissions.never',
    dependency: 'permissions',
    form: 'never',
    sources: ['camera'],
    build: p => {
      p.permission = {
        events: ['requesting'],
        outcome: 'never',
        denyAfterMs: 0,
      };
    },
  },
  {
    id: 'permissions.slow_deny',
    dependency: 'permissions',
    form: 'slow',
    sources: ['camera'],
    build: (p, r) => {
      p.permission = {
        events: ['requesting', 'denied'],
        outcome: 'reject_denied',
        denyAfterMs: r.int(8_000, 30_000),
      };
    },
  },
  {
    id: 'permissions.malformed_event',
    dependency: 'permissions',
    form: 'malformed',
    sources: ['camera'],
    build: p => {
      p.permission = {
        events: ['malformed', 'granted'],
        outcome: 'ok',
        denyAfterMs: 0,
      };
    },
  },
  {
    id: 'permissions.timeout',
    dependency: 'permissions',
    form: 'timeout',
    sources: ['camera'],
    build: (p, r) => {
      p.permission = {
        events: ['requesting', 'denied'],
        outcome: 'reject_denied',
        denyAfterMs: r.int(45_000, 59_000),
      };
    },
  },
  // ── SQLite ───────────────────────────────────────────────────────────
  {
    id: 'sqlite.throw.capture_insert',
    dependency: 'sqlite',
    form: 'throw',
    sources: ['camera', 'library'],
    build: p => {
      p.sql = [
        {
          match: 'INSERT INTO local_capture',
          form: 'throw',
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'sqlite.reject.capture_insert',
    dependency: 'sqlite',
    form: 'reject',
    sources: ['camera', 'library'],
    build: p => {
      p.sql = [
        {
          match: 'INSERT INTO local_capture',
          form: 'reject',
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'sqlite.never.capture_insert',
    dependency: 'sqlite',
    form: 'never',
    sources: ['camera'],
    build: p => {
      p.sql = [
        {
          match: 'INSERT INTO local_capture',
          form: 'never',
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'sqlite.slow.capture_insert',
    dependency: 'sqlite',
    form: 'slow',
    sources: ['camera'],
    build: (p, r) => {
      p.sql = [
        {
          match: 'INSERT INTO local_capture',
          form: 'slow',
          delayMs: slowMs(r),
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'sqlite.reject.declared_stroke',
    dependency: 'sqlite',
    form: 'reject',
    sources: ['camera', 'library'],
    build: p => {
      p.sql = [
        {
          match: 'UPDATE local_capture SET declared_stroke',
          form: 'reject',
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'sqlite.reject.analysis_record',
    dependency: 'sqlite',
    form: 'reject',
    sources: ['camera'],
    build: p => {
      p.sql = [
        {
          match: 'INSERT INTO local_analysis_record',
          form: 'reject',
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'sqlite.reject.shot_insert',
    dependency: 'sqlite',
    form: 'reject',
    sources: ['camera'],
    build: p => {
      p.sql = [
        {
          match: 'INSERT OR REPLACE INTO local_shot',
          form: 'reject',
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'sqlite.reject.outbox_insert',
    dependency: 'sqlite',
    form: 'partial',
    sources: ['camera'],
    build: p => {
      p.sql = [
        { match: 'INSERT INTO outbox', form: 'reject', delayMs: 0, onNth: 1 },
      ];
    },
  },
  {
    id: 'sqlite.reject.commit',
    dependency: 'sqlite',
    form: 'reject',
    sources: ['camera'],
    build: (p, r) => {
      p.sql = [
        { match: '^COMMIT', form: 'reject', delayMs: 0, onNth: r.int(1, 2) },
      ];
    },
  },
  {
    id: 'sqlite.reject.begin_locked',
    dependency: 'sqlite',
    form: 'reject',
    sources: ['camera'],
    build: (p, r) => {
      p.sql = [
        { match: '^BEGIN', form: 'reject', delayMs: 0, onNth: r.int(1, 2) },
      ];
    },
  },
  {
    id: 'sqlite.never.shot_insert',
    dependency: 'sqlite',
    form: 'never',
    sources: ['camera'],
    build: p => {
      p.sql = [
        {
          match: 'INSERT OR REPLACE INTO local_shot',
          form: 'never',
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'sqlite.slow.shot_insert',
    dependency: 'sqlite',
    form: 'slow',
    sources: ['camera'],
    build: (p, r) => {
      p.sql = [
        {
          match: 'INSERT OR REPLACE INTO local_shot',
          form: 'slow',
          delayMs: slowMs(r),
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'sqlite.malformed.select_rows',
    dependency: 'sqlite',
    form: 'malformed',
    sources: ['camera'],
    build: p => {
      p.sql = [{ match: '^SELECT', form: 'malformed', delayMs: 0, onNth: 1 }];
    },
  },
  {
    id: 'sqlite.reject.mark_analyzed',
    dependency: 'sqlite',
    form: 'timeout',
    sources: ['camera'],
    build: p => {
      p.sql = [
        {
          match: "UPDATE local_capture SET status = 'analyzed'",
          form: 'reject',
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  // ── fetch / API (analysis permits) ───────────────────────────────────
  {
    id: 'fetch.reject.reserve',
    dependency: 'fetch',
    form: 'reject',
    sources: ['camera', 'library'],
    build: (p, r) => {
      p.fetch = [
        {
          route: 'permits.reserve',
          form: 'reject',
          status: 0,
          variant: 'network',
          delayMs: r.int(0, 2_000),
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'fetch.never.reserve',
    dependency: 'fetch',
    form: 'never',
    sources: ['camera'],
    build: p => {
      p.fetch = [
        {
          route: 'permits.reserve',
          form: 'never',
          status: 0,
          variant: '',
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'fetch.timeout.reserve',
    dependency: 'fetch',
    form: 'timeout',
    sources: ['camera'],
    build: (p, r) => {
      p.fetch = [
        {
          route: 'permits.reserve',
          form: 'slow',
          status: 200,
          variant: '',
          delayMs: r.int(20_500, 40_000),
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'fetch.slow.reserve',
    dependency: 'fetch',
    form: 'slow',
    sources: ['camera'],
    build: (p, r) => {
      p.fetch = [
        {
          route: 'permits.reserve',
          form: 'slow',
          status: 200,
          variant: '',
          delayMs: r.int(2_000, 19_000),
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'fetch.malformed.reserve_json',
    dependency: 'fetch',
    form: 'malformed',
    sources: ['camera'],
    build: p => {
      p.fetch = [
        {
          route: 'permits.reserve',
          form: 'malformed_json',
          status: 200,
          variant: 'json_throws',
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'fetch.malformed.reserve_body',
    dependency: 'fetch',
    form: 'malformed',
    sources: ['camera'],
    build: (p, r) => {
      p.fetch = [
        {
          route: 'permits.reserve',
          form: 'malformed_body',
          status: 200,
          variant: r.pick(PERMIT_MALFORMED_VARIANTS),
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'fetch.partial.reserve_body',
    dependency: 'fetch',
    form: 'partial',
    sources: ['camera'],
    build: (p, r) => {
      p.fetch = [
        {
          route: 'permits.reserve',
          form: 'partial_body',
          status: 200,
          variant: r.pick(['no_access', 'no_expires', 'no_access_source']),
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'fetch.status.reserve_paywall',
    dependency: 'fetch',
    form: 'reject',
    sources: ['camera'],
    build: p => {
      p.fetch = [
        {
          route: 'permits.reserve',
          form: 'status',
          status: 402,
          variant: 'access.paywall_required',
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'fetch.status.reserve_5xx_4xx',
    dependency: 'fetch',
    form: 'reject',
    sources: ['camera'],
    build: (p, r) => {
      p.fetch = [
        {
          route: 'permits.reserve',
          form: 'status',
          status: r.pick([500, 502, 503, 429, 401, 403, 409]),
          variant: 'server',
          delayMs: r.int(0, 1_000),
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'fetch.reject.release_after_shot_failure',
    dependency: 'fetch',
    form: 'reject',
    sources: ['camera'],
    build: (p, r) => {
      p.sql = [
        {
          match: 'INSERT OR REPLACE INTO local_shot',
          form: 'reject',
          delayMs: 0,
          onNth: 1,
        },
      ];
      p.fetch = [
        {
          route: 'permits.release',
          form: r.pick(['reject', 'never', 'status']),
          status: 500,
          variant: 'release',
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'fetch.reject.shots_sync',
    dependency: 'fetch',
    form: 'reject',
    sources: ['camera'],
    build: (p, r) => {
      p.fetch = [
        {
          route: 'shots.sync',
          form: r.pick(['reject', 'status', 'malformed_json']),
          status: 503,
          variant: 'sync',
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'fetch.reject.access_get',
    dependency: 'fetch',
    form: 'reject',
    sources: ['camera'],
    build: (p, r) => {
      p.fetch = [
        {
          route: 'access.get',
          form: r.pick(['reject', 'malformed_body', 'status', 'never']),
          status: 500,
          variant: 'access',
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'fetch.reject.auth_refresh',
    dependency: 'fetch',
    form: 'reject',
    sources: ['camera'],
    build: (p, r) => {
      p.fetch = [
        {
          route: 'auth.refresh',
          form: r.pick(['reject', 'never', 'malformed_body']),
          status: 0,
          variant: 'refresh',
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  {
    id: 'fetch.status.auth_refresh_revoked',
    dependency: 'fetch',
    form: 'reject',
    sources: ['camera'],
    build: (p, r) => {
      p.fetch = [
        {
          route: 'auth.refresh',
          form: 'status',
          status: r.pick([401, 403]),
          variant: 'revoked',
          delayMs: 0,
          onNth: 1,
        },
      ];
    },
  },
  // ── Vision / model providers ─────────────────────────────────────────
  {
    id: 'vision.unavailable.registry',
    dependency: 'vision',
    form: 'reject',
    sources: ['camera'],
    build: (p, r) => {
      p.vision = {
        target: 'registry',
        form: 'unavailable',
        delayMs: 0,
        variant: r.pick([
          'phase_segmentation',
          'technique_scoring',
          'stroke_classification',
        ]),
      };
    },
  },
  {
    id: 'vision.throw.phase',
    dependency: 'vision',
    form: 'throw',
    sources: ['camera'],
    build: p => {
      p.vision = { target: 'phase', form: 'throw', delayMs: 0, variant: '' };
    },
  },
  {
    id: 'vision.reject.scorer',
    dependency: 'vision',
    form: 'reject',
    sources: ['camera'],
    build: (p, r) => {
      p.vision = {
        target: r.pick(['scorer', 'biomechanics', 'faultDetector', 'coach']),
        form: 'reject',
        delayMs: r.int(0, 1_000),
        variant: '',
      };
    },
  },
  {
    id: 'vision.never.biomechanics',
    dependency: 'vision',
    form: 'never',
    sources: ['camera'],
    build: (p, r) => {
      p.vision = {
        target: r.pick(['biomechanics', 'scorer', 'phase']),
        form: 'never',
        delayMs: 0,
        variant: '',
      };
    },
  },
  {
    id: 'vision.slow.scorer',
    dependency: 'vision',
    form: 'slow',
    sources: ['camera'],
    build: (p, r) => {
      p.vision = {
        target: 'scorer',
        form: 'slow',
        delayMs: slowMs(r),
        variant: '',
      };
    },
  },
  {
    id: 'vision.malformed.scorer',
    dependency: 'vision',
    form: 'malformed',
    sources: ['camera'],
    build: (p, r) => {
      p.vision = {
        target: 'scorer',
        form: 'malformed',
        delayMs: 0,
        variant: r.pick(VISION_MALFORMED_VARIANTS),
      };
    },
  },
  {
    id: 'vision.partial.phase',
    dependency: 'vision',
    form: 'partial',
    sources: ['camera'],
    build: (p, r) => {
      p.vision = {
        target: r.pick(['phase', 'biomechanics']),
        form: 'partial',
        delayMs: 0,
        variant: r.pick(['empty', 'half']),
      };
    },
  },
  {
    id: 'vision.timeout.scorer',
    dependency: 'vision',
    form: 'timeout',
    sources: ['camera'],
    build: (p, r) => {
      p.vision = {
        target: 'scorer',
        form: 'slow',
        delayMs: r.int(50_000, 59_000),
        variant: '',
      };
    },
  },
  // ── Recorded pose sidecar (Apple Vision output on disk) ──────────────
  {
    id: 'vision.sidecar.reject',
    dependency: 'vision',
    form: 'reject',
    sources: ['camera'],
    build: (p, r) => {
      p.readTextFile = {
        mode: 'reject',
        code: null,
        message: 'ENOENT: sidecar missing',
        delayMs: r.int(0, 500),
      };
    },
  },
  {
    id: 'vision.sidecar.malformed',
    dependency: 'vision',
    form: 'malformed',
    sources: ['camera'],
    build: (p, r) => {
      p.readTextFile = {
        mode: 'malformed',
        variant: r.pick(SIDECAR_MALFORMED_VARIANTS),
        delayMs: 0,
      };
    },
  },
  {
    id: 'vision.sidecar.partial',
    dependency: 'vision',
    form: 'partial',
    sources: ['camera'],
    build: (p, r) => {
      p.readTextFile = {
        mode: 'partial',
        variant: r.pick(SIDECAR_PARTIAL_VARIANTS),
        delayMs: 0,
      };
    },
  },
  {
    id: 'vision.sidecar.never',
    dependency: 'vision',
    form: 'never',
    sources: ['camera'],
    build: p => {
      p.readTextFile = { mode: 'never' };
    },
  },
  {
    id: 'vision.sidecar.slow',
    dependency: 'vision',
    form: 'slow',
    sources: ['camera'],
    build: (p, r) => {
      p.readTextFile = { mode: 'ok', delayMs: slowMs(r) };
    },
  },
  // ── Imported-video native pose extraction ────────────────────────────
  {
    id: 'vision.extraction.reject',
    dependency: 'vision',
    form: 'reject',
    sources: ['library'],
    build: (p, r) => {
      const code = r.pick([
        'camera.import_too_long',
        'camera.import_no_person',
        'camera.import_pose_failed',
        'camera.extraction_failed',
        null,
      ]);
      p.extraction = {
        mode: 'reject',
        code,
        message: code ?? 'extraction failed',
        delayMs: r.int(0, 2_000),
      };
    },
  },
  {
    id: 'vision.extraction.malformed',
    dependency: 'vision',
    form: 'malformed',
    sources: ['library'],
    build: (p, r) => {
      p.extraction = {
        mode: 'malformed',
        variant: r.pick(EXTRACTION_MALFORMED_VARIANTS),
        delayMs: 0,
      };
    },
  },
  {
    id: 'vision.extraction.never',
    dependency: 'vision',
    form: 'never',
    sources: ['library'],
    build: p => {
      p.extraction = { mode: 'never' };
    },
  },
  {
    id: 'vision.extraction.slow',
    dependency: 'vision',
    form: 'slow',
    sources: ['library'],
    build: (p, r) => {
      p.extraction = { mode: 'ok', delayMs: slowMs(r) };
    },
  },
  // ── Keychain (session vault) ─────────────────────────────────────────
  {
    id: 'keychain.reject.get',
    dependency: 'keychain',
    form: 'reject',
    sources: ['camera'],
    build: p => {
      p.keychain = { op: 'get', form: 'reject', delayMs: 0, variant: '' };
    },
  },
  {
    id: 'keychain.malformed.get',
    dependency: 'keychain',
    form: 'malformed',
    sources: ['camera'],
    build: (p, r) => {
      p.keychain = {
        op: 'get',
        form: 'malformed',
        delayMs: 0,
        variant: r.pick([
          'not_json',
          'version_2',
          'empty_refresh',
          'provider_guest',
          'array',
        ]),
      };
    },
  },
  {
    id: 'keychain.never.get',
    dependency: 'keychain',
    form: 'never',
    sources: ['camera'],
    build: p => {
      p.keychain = { op: 'get', form: 'never', delayMs: 0, variant: '' };
    },
  },
  {
    id: 'keychain.slow.get',
    dependency: 'keychain',
    form: 'slow',
    sources: ['camera'],
    build: (p, r) => {
      p.keychain = {
        op: 'get',
        form: 'slow',
        delayMs: r.int(1_000, 12_000),
        variant: '',
      };
    },
  },
  {
    id: 'keychain.reject.set_on_rotation',
    dependency: 'keychain',
    form: 'throw',
    sources: ['camera'],
    build: (p, r) => {
      p.keychain = { op: 'set', form: r.pick(['reject', 'throw']) };
    },
  },
  // ── RevenueCat SDK ───────────────────────────────────────────────────
  {
    id: 'revenuecat.reject.configure',
    dependency: 'revenuecat',
    form: 'reject',
    sources: ['camera'],
    build: (p, r) => {
      // Only the SDK calls the Analyze access gate actually makes
      // (configure → isConfigured/configure/getAppUserID; logIn needs a
      // pre-configured mismatched user and is not on this path).
      p.revenueCat = {
        method: r.pick(['configure', 'isConfigured', 'getAppUserID']),
        form: 'reject',
        delayMs: r.int(0, 1_000),
        variant: '',
      };
    },
  },
  {
    id: 'revenuecat.throw.isConfigured',
    dependency: 'revenuecat',
    form: 'throw',
    sources: ['camera'],
    build: (p, r) => {
      p.revenueCat = {
        method: r.pick(['isConfigured', 'configure', 'getOfferings']),
        form: 'throw',
        delayMs: 0,
        variant: '',
      };
    },
  },
  {
    id: 'revenuecat.never.getOfferings',
    dependency: 'revenuecat',
    form: 'never',
    sources: ['camera'],
    build: (p, r) => {
      p.revenueCat = {
        method: r.pick(['getOfferings', 'configure', 'getAppUserID']),
        form: 'never',
        delayMs: 0,
        variant: '',
      };
    },
  },
  {
    id: 'revenuecat.slow.getOfferings',
    dependency: 'revenuecat',
    form: 'slow',
    sources: ['camera'],
    build: (p, r) => {
      p.revenueCat = {
        method: 'getOfferings',
        form: 'slow',
        delayMs: slowMs(r),
        variant: '',
      };
    },
  },
  {
    id: 'revenuecat.malformed.getOfferings',
    dependency: 'revenuecat',
    form: 'malformed',
    sources: ['camera'],
    build: (p, r) => {
      p.revenueCat = {
        method: 'getOfferings',
        form: 'malformed',
        delayMs: 0,
        variant: r.pick(RC_MALFORMED_VARIANTS),
      };
    },
  },
  {
    id: 'revenuecat.partial.getAppUserID_mismatch',
    dependency: 'revenuecat',
    form: 'partial',
    sources: ['camera'],
    build: p => {
      p.revenueCat = {
        method: 'getAppUserID',
        form: 'partial',
        delayMs: 0,
        variant: 'wrong_user',
      };
    },
  },
  {
    id: 'revenuecat.timeout.configure',
    dependency: 'revenuecat',
    form: 'timeout',
    sources: ['camera'],
    build: p => {
      // Eligibility is only consulted by the Paywall purchase path, never by
      // the Analyze gate — the never-settling SDK call the gate DOES await
      // is configure().
      p.revenueCat = {
        method: 'configure',
        form: 'never',
        delayMs: 0,
        variant: '',
      };
    },
  },
  // ── Clock ────────────────────────────────────────────────────────────
  {
    id: 'clock.frozen',
    dependency: 'clock',
    form: 'malformed',
    sources: ['camera'],
    build: p => {
      p.clock = { kind: 'frozen' };
    },
  },
  {
    id: 'clock.jump_backwards',
    dependency: 'clock',
    form: 'partial',
    sources: ['camera'],
    build: (p, r) => {
      p.clock = {
        kind: 'jump_backwards',
        byMs: r.int(60_000, 6 * 3_600_000),
        atStage: 'analysis',
      };
    },
  },
  {
    id: 'clock.jump_forwards',
    dependency: 'clock',
    form: 'timeout',
    sources: ['camera'],
    build: (p, r) => {
      p.clock = {
        kind: 'jump_forwards',
        byMs: r.int(3_600_000, 48 * 3_600_000),
        atStage: 'analysis',
      };
    },
  },
  {
    id: 'clock.absolute_extreme',
    dependency: 'clock',
    form: 'malformed',
    sources: ['camera'],
    build: (p, r) => {
      p.clock = {
        kind: 'absolute',
        epochMs: r.pick([
          0,
          86_400_000,
          Date.UTC(2099, 11, 31, 23, 59),
          Date.UTC(1999, 11, 31, 23, 59, 59),
        ]),
      };
    },
  },
  {
    id: 'clock.bearer_expires_in_past',
    dependency: 'clock',
    form: 'slow',
    sources: ['camera'],
    build: p => {
      p.clock = { kind: 'bearer_expires_in_past' };
    },
  },
  // ── Navigation ───────────────────────────────────────────────────────
  {
    id: 'navigation.close_during_capture',
    dependency: 'navigation',
    form: 'timeout',
    sources: ['camera', 'library'],
    build: (p, r) => {
      p.capture = { mode: 'ok', delayMs: r.int(2_000, 8_000) };
      p.navigation = {
        action: 'close',
        atStage: 'capture_working',
        times: r.chance(0.3) ? 2 : 1,
      };
    },
  },
  {
    id: 'navigation.close_during_analysis',
    dependency: 'navigation',
    form: 'partial',
    sources: ['camera'],
    build: (p, r) => {
      p.vision = {
        target: 'scorer',
        form: 'slow',
        delayMs: r.int(2_000, 8_000),
        variant: '',
      };
      p.navigation = {
        action: 'close',
        atStage: 'analysis_working',
        times: r.chance(0.3) ? 2 : 1,
      };
    },
  },
  {
    id: 'navigation.navigate_home_during_analysis',
    dependency: 'navigation',
    form: 'reject',
    sources: ['camera'],
    build: (p, r) => {
      p.fetch = [
        {
          route: 'permits.reserve',
          form: 'slow',
          status: 200,
          variant: '',
          delayMs: r.int(2_000, 8_000),
          onNth: 1,
        },
      ];
      p.navigation = { action: 'navigate_home', atStage: 'analysis_working' };
    },
  },
  {
    id: 'navigation.retry_double_tap',
    dependency: 'navigation',
    form: 'throw',
    sources: ['camera'],
    build: (p, r) => {
      p.capture = {
        mode: 'reject',
        code: 'camera.session_failed',
        message: 'first attempt failed',
        delayMs: r.int(0, 500),
      };
      p.navigation = { action: 'retry_double_tap' };
    },
  },
  {
    id: 'navigation.try_again_then_close_race',
    dependency: 'navigation',
    form: 'never',
    sources: ['camera'],
    build: (p, r) => {
      p.capture = {
        mode: 'reject',
        code: 'camera.storage_failed',
        message: 'first attempt failed',
        delayMs: r.int(0, 500),
      };
      p.navigation = { action: 'try_again_then_close_race' };
    },
  },
];

export function cellById(id: string): Cell {
  const cell = CELLS.find(c => c.id === id);
  if (!cell) throw new Error(`Unknown stress cell ${id}`);
  return cell;
}

/**
 * Derives the full plan for one iteration. `index` selects the cell during
 * the coverage pass (first CELLS.length iterations); after that the seed does.
 */
export function planFor(
  seed: number,
  index: number,
  onlyCell?: string,
): FaultPlan {
  const rng = new Rng(seed);
  const cell = onlyCell
    ? cellById(onlyCell)
    : index < CELLS.length
      ? CELLS[index]!
      : rng.pick(CELLS);
  const source = rng.pick(cell.sources);
  const plan = basePlan(seed, rng, source);
  plan.cell = cell.id;
  plan.dependency = cell.dependency;
  plan.form = cell.form;
  cell.build(plan, rng);
  return plan;
}

/** Seeds for a campaign: deterministic from the campaign seed. */
export function campaignSeeds(campaignSeed: number, count: number): number[] {
  const rng = new Rng(campaignSeed);
  const seeds: number[] = [];
  for (let i = 0; i < count; i += 1) seeds.push(rng.int(1, 0x7fffffff));
  return seeds;
}

// ─── Outcome record ──────────────────────────────────────────────────────────

export type Terminal =
  | 'error_retry'
  | 'error_upgrade'
  | 'result'
  | 'paywall'
  | 'home'
  | 'saved'
  | 'ready'
  | 'free_limit'
  | 'analyzed'
  | 'working_stuck'
  | 'bootstrap_stuck'
  | 'unknown';

export interface PersistenceSnapshot {
  backend: 'node:sqlite';
  integrity: string;
  openTransaction: boolean;
  captures: number;
  analysisRecords: number;
  shots: number;
  outboxShotSync: number;
  syncReceipts: number;
  unparsablePayloads: number;
  shotsWithoutOutboxOrReceipt: number;
  shotScores: number[];
}

/** Exact command that replays one iteration (seed + cell pin the plan). */
export function replayCommand(seed: number, cell: string): string {
  return `cd apps/mobile && NODE_OPTIONS=--experimental-sqlite STRESS_SEEDS=${seed} STRESS_CELL=${cell} npx jest --ci __tests__/stress/analyzeScreenFailureInjection`;
}

export interface IterationRecord {
  seed: number;
  index: number;
  cell: string;
  replay: string;
  dependency: Dependency;
  form: FaultForm;
  source: Source;
  plan: FaultPlan;
  faultHits: number;
  terminal: Terminal;
  errorMessage: string | null;
  controls: string[];
  recovery: { action: string; outcome: string } | null;
  fetchCalls: string[];
  bridgeCalls: string[];
  cancelCalls: number;
  permits: {
    reserved: string[];
    released: Array<{ id: string; outcome: string }>;
  };
  persistence: PersistenceSnapshot | null;
  consoleErrors: string[];
  unhandledRejections: string[];
  violations: string[];
  notes: string[];
  fakeMsAdvanced: number;
  wallMs: number;
  verdict: 'HELD' | 'BROKEN';
}

export interface CampaignReport {
  unit: 'scr-analyzescreen';
  lens: 'failure-injection';
  commit: string;
  campaignSeed: number;
  requested: number;
  executed: number;
  held: number;
  broken: number;
  cellsCovered: string[];
  cellsTotal: number;
  dependencies: Record<string, number>;
  forms: Record<string, number>;
  terminals: Record<string, number>;
  failingSeeds: Array<{
    seed: number;
    cell: string;
    violations: string[];
    replay: string;
  }>;
  iterations: IterationRecord[];
  startedAtIso: string;
  finishedAtIso: string;
  node: string;
}

export function summarize(
  iterations: IterationRecord[],
  meta: {
    commit: string;
    campaignSeed: number;
    requested: number;
    startedAtIso: string;
    node: string;
  },
): CampaignReport {
  const count = (key: (r: IterationRecord) => string) =>
    iterations.reduce<Record<string, number>>((acc, r) => {
      const k = key(r);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
  return {
    unit: 'scr-analyzescreen',
    lens: 'failure-injection',
    commit: meta.commit,
    campaignSeed: meta.campaignSeed,
    requested: meta.requested,
    executed: iterations.length,
    held: iterations.filter(r => r.verdict === 'HELD').length,
    broken: iterations.filter(r => r.verdict === 'BROKEN').length,
    cellsCovered: [...new Set(iterations.map(r => r.cell))].sort(),
    cellsTotal: CELLS.length,
    dependencies: count(r => r.dependency),
    forms: count(r => r.form),
    terminals: count(r => r.terminal),
    failingSeeds: iterations
      .filter(r => r.verdict === 'BROKEN')
      .map(r => ({
        seed: r.seed,
        cell: r.cell,
        violations: r.violations,
        replay: r.replay,
      })),
    iterations,
    startedAtIso: meta.startedAtIso,
    finishedAtIso: new Date().toISOString(),
    node: meta.node,
  };
}
