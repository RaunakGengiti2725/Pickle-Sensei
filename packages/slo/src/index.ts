/**
 * Backend/queue SLO instrumentation (Wave I, workstream i19).
 *
 * Pure, dependency-free measurement + evaluation primitives shared by
 * services/api and services/media-worker. Everything here reports what was
 * actually measured: a metric that cannot be measured in the current
 * deployment (e.g. SQS oldest-job age without CloudWatch) is surfaced as
 * `not_evaluable`, never as a fabricated pass.
 */

/** Bounded reservoir of the most recent latency samples (sliding window). */
export class LatencyWindow {
  private samples: number[] = [];
  private cursor = 0;
  private filled = false;

  constructor(private capacity = 1000) {
    if (capacity < 1) throw new Error("LatencyWindow capacity must be >= 1");
  }

  record(latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    if (this.samples.length < this.capacity) {
      this.samples.push(latencyMs);
    } else {
      this.samples[this.cursor] = latencyMs;
      this.filled = true;
    }
    this.cursor = (this.cursor + 1) % this.capacity;
  }

  count(): number {
    return this.filled ? this.capacity : this.samples.length;
  }

  /** Nearest-rank percentile over the window; null when empty. */
  percentile(p: number): number | null {
    if (this.samples.length === 0) return null;
    if (p <= 0 || p > 100) throw new Error("percentile p must be in (0, 100]");
    const sorted = [...this.samples].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(rank, sorted.length) - 1] ?? null;
  }
}

export interface LatencyPercentiles {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  sampleCount: number;
}

function percentilesOf(window: LatencyWindow): LatencyPercentiles {
  return {
    p50: window.percentile(50),
    p95: window.percentile(95),
    p99: window.percentile(99),
    sampleCount: window.count(),
  };
}

export interface PoolSaturationSample {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  maxSize: number | null;
}

export interface ApiSloSnapshot {
  requestCount: number;
  fiveXxCount: number;
  /** 1 - (5xx / total); null until at least one request was observed. */
  availability: number | null;
  fiveXxRate: number | null;
  latency: LatencyPercentiles;
  dbLatency: LatencyPercentiles;
  /** Latest pool sample; null when the API runs without a database pool. */
  pool: PoolSaturationSample | null;
  /** In-use fraction of the pool (busy / max); null when max is unknown. */
  poolSaturation: number | null;
  /** 5xx responses on /v1/media routes (upload/storage failure surface). */
  mediaFiveXxCount: number;
}

/**
 * Rolling API SLO recorder. Counters are monotonic since construction;
 * latency percentiles cover a bounded sliding window of recent samples.
 */
export class ApiSloRecorder {
  private requestCount = 0;
  private fiveXxCount = 0;
  private mediaFiveXxCount = 0;
  private requestLatency: LatencyWindow;
  private dbLatencyWindow: LatencyWindow;
  private lastPool: PoolSaturationSample | null = null;

  constructor(windowSize = 1000) {
    this.requestLatency = new LatencyWindow(windowSize);
    this.dbLatencyWindow = new LatencyWindow(windowSize);
  }

  recordRequest(input: { route: string; statusCode: number; latencyMs: number }): void {
    this.requestCount++;
    this.requestLatency.record(input.latencyMs);
    if (input.statusCode >= 500) {
      this.fiveXxCount++;
      if (input.route.startsWith("/v1/media")) this.mediaFiveXxCount++;
    }
  }

  recordDbLatency(latencyMs: number): void {
    this.dbLatencyWindow.record(latencyMs);
  }

  recordPoolSample(sample: PoolSaturationSample): void {
    this.lastPool = sample;
  }

  snapshot(): ApiSloSnapshot {
    const total = this.requestCount;
    const pool = this.lastPool;
    const busy = pool ? pool.totalCount - pool.idleCount + pool.waitingCount : null;
    return {
      requestCount: total,
      fiveXxCount: this.fiveXxCount,
      availability: total > 0 ? 1 - this.fiveXxCount / total : null,
      fiveXxRate: total > 0 ? this.fiveXxCount / total : null,
      latency: percentilesOf(this.requestLatency),
      dbLatency: percentilesOf(this.dbLatencyWindow),
      pool,
      poolSaturation:
        pool && pool.maxSize !== null && pool.maxSize > 0 && busy !== null
          ? busy / pool.maxSize
          : null,
      mediaFiveXxCount: this.mediaFiveXxCount,
    };
  }
}

export type SloStatus = "met" | "breached" | "not_evaluable";

export interface SloEvaluation {
  slo:
    | "api_availability"
    | "api_latency_p95"
    | "api_latency_p99"
    | "api_5xx_rate"
    | "db_latency_p95"
    | "pool_saturation";
  status: SloStatus;
  /** Measured value, when measurable. */
  observed: number | null;
  target: number;
  /** Why the SLO could not be evaluated (only for not_evaluable). */
  reason?: string;
}

export interface ApiSloTargets {
  /** Minimum fraction of non-5xx responses. */
  availability: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  /** Maximum tolerated 5xx fraction. */
  maxFiveXxRate: number;
  dbP95LatencyMs: number;
  /** Maximum in-use fraction of the connection pool. */
  maxPoolSaturation: number;
  /** Below this many requests the rate SLOs are not statistically evaluable. */
  minRequestSamples: number;
}

export const DEFAULT_API_SLO_TARGETS: ApiSloTargets = {
  availability: 0.995,
  p95LatencyMs: 500,
  p99LatencyMs: 2000,
  maxFiveXxRate: 0.005,
  dbP95LatencyMs: 250,
  maxPoolSaturation: 0.8,
  minRequestSamples: 100,
};

export function evaluateApiSlos(
  snapshot: ApiSloSnapshot,
  targets: ApiSloTargets = DEFAULT_API_SLO_TARGETS,
): SloEvaluation[] {
  const enoughRequests = snapshot.requestCount >= targets.minRequestSamples;
  const tooFew = `fewer than ${targets.minRequestSamples} requests observed`;
  const rateStatus = (observed: number | null, ok: boolean): SloEvaluation["status"] =>
    observed === null || !enoughRequests ? "not_evaluable" : ok ? "met" : "breached";

  const evaluations: SloEvaluation[] = [];
  evaluations.push({
    slo: "api_availability",
    status: rateStatus(snapshot.availability, (snapshot.availability ?? 0) >= targets.availability),
    observed: snapshot.availability,
    target: targets.availability,
    ...(snapshot.availability === null || !enoughRequests ? { reason: tooFew } : {}),
  });
  evaluations.push({
    slo: "api_5xx_rate",
    status: rateStatus(snapshot.fiveXxRate, (snapshot.fiveXxRate ?? 1) <= targets.maxFiveXxRate),
    observed: snapshot.fiveXxRate,
    target: targets.maxFiveXxRate,
    ...(snapshot.fiveXxRate === null || !enoughRequests ? { reason: tooFew } : {}),
  });
  const p95 = snapshot.latency.p95;
  evaluations.push({
    slo: "api_latency_p95",
    status: p95 === null ? "not_evaluable" : p95 <= targets.p95LatencyMs ? "met" : "breached",
    observed: p95,
    target: targets.p95LatencyMs,
    ...(p95 === null ? { reason: "no latency samples" } : {}),
  });
  const p99 = snapshot.latency.p99;
  evaluations.push({
    slo: "api_latency_p99",
    status: p99 === null ? "not_evaluable" : p99 <= targets.p99LatencyMs ? "met" : "breached",
    observed: p99,
    target: targets.p99LatencyMs,
    ...(p99 === null ? { reason: "no latency samples" } : {}),
  });
  const dbP95 = snapshot.dbLatency.p95;
  evaluations.push({
    slo: "db_latency_p95",
    status: dbP95 === null ? "not_evaluable" : dbP95 <= targets.dbP95LatencyMs ? "met" : "breached",
    observed: dbP95,
    target: targets.dbP95LatencyMs,
    ...(dbP95 === null ? { reason: "no database latency samples (pool absent or unprobed)" } : {}),
  });
  evaluations.push({
    slo: "pool_saturation",
    status:
      snapshot.poolSaturation === null
        ? "not_evaluable"
        : snapshot.poolSaturation <= targets.maxPoolSaturation
          ? "met"
          : "breached",
    observed: snapshot.poolSaturation,
    target: targets.maxPoolSaturation,
    ...(snapshot.poolSaturation === null ? { reason: "pool not sampled or max size unknown" } : {}),
  });
  return evaluations;
}

/** One worker poll cycle as observed from the outside. */
export interface QueueCycleObservation {
  /** Queue depth after the cycle; -1 means the backend cannot report depth. */
  depth: number;
  /** Age of the oldest unfinished job; null when the backend cannot report it. */
  oldestJobAgeMs: number | null;
  /** Jobs successfully handled (acked) this cycle. */
  jobsHandled: number;
  /** Jobs received (visible) this cycle, handled or not. */
  jobsSeen: number;
}

export type QueueStalledReason = "no_progress" | "oldest_job_age_exceeded";

/**
 * Typed stalled-queue alert. This is the loud surface: emitters must log it
 * at error level AND track it through analytics — never a silent counter.
 */
export interface QueueStalledAlert {
  kind: "queue_stalled";
  queue: string;
  reason: QueueStalledReason;
  depth: number;
  oldestJobAgeMs: number | null;
  consecutiveIdleCycles: number;
}

export interface QueueSloConfig {
  queue: string;
  /** Cycles with visible work but zero handled jobs before alerting. */
  stalledAfterIdleCycles: number;
  /** Oldest-job age that alerts immediately (ms); null disables the check. */
  maxOldestJobAgeMs: number | null;
}

export const DEFAULT_QUEUE_SLO_CONFIG: QueueSloConfig = {
  queue: "media",
  stalledAfterIdleCycles: 3,
  maxOldestJobAgeMs: 15 * 60 * 1000,
};

/**
 * Detects a stalled queue from successive cycle observations: work is visible
 * but nothing completes, or the oldest job has waited past the limit. Fires
 * on every observation while the condition holds (repeat alerts are cheap;
 * a missed stall is not).
 */
export class QueueSloMonitor {
  private idleCycles = 0;

  constructor(private config: QueueSloConfig = DEFAULT_QUEUE_SLO_CONFIG) {}

  consecutiveIdleCycles(): number {
    return this.idleCycles;
  }

  observe(observation: QueueCycleObservation): QueueStalledAlert | null {
    const workVisible = observation.depth > 0 || observation.jobsSeen > 0;
    if (workVisible && observation.jobsHandled === 0) {
      this.idleCycles++;
    } else {
      this.idleCycles = 0;
    }
    if (
      this.config.maxOldestJobAgeMs !== null &&
      observation.oldestJobAgeMs !== null &&
      observation.oldestJobAgeMs > this.config.maxOldestJobAgeMs
    ) {
      return {
        kind: "queue_stalled",
        queue: this.config.queue,
        reason: "oldest_job_age_exceeded",
        depth: observation.depth,
        oldestJobAgeMs: observation.oldestJobAgeMs,
        consecutiveIdleCycles: this.idleCycles,
      };
    }
    if (this.idleCycles >= this.config.stalledAfterIdleCycles) {
      return {
        kind: "queue_stalled",
        queue: this.config.queue,
        reason: "no_progress",
        depth: observation.depth,
        oldestJobAgeMs: observation.oldestJobAgeMs,
        consecutiveIdleCycles: this.idleCycles,
      };
    }
    return null;
  }
}
