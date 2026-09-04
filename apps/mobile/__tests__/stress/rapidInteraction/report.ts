import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** One replayable iteration: seed → scenario → per-invariant verdicts. */
export interface IterationRecord {
  seed: number;
  scenario: string;
  params: Record<string, unknown>;
  /** Invariant name → held. Every key is an assertion the iteration made. */
  checks: Record<string, boolean>;
  /** Free-form observations useful for minimization (counts, route lists). */
  observed: Record<string, unknown>;
  consoleErrors: string[];
  unhandledRejections: string[];
  /** Thrown by the driver itself (a crash or an unexpected surface). */
  driverError: string | null;
  outcome: 'HELD' | 'BROKEN';
  durationMs: number;
}

export interface CampaignSummary {
  unit: string;
  lens: string;
  startedAtIso: string;
  seeds: number[];
  scenariosExecuted: number;
  held: number;
  broken: number;
  brokenSeeds: number[];
  scenarioCounts: Record<string, number>;
  checkFailureCounts: Record<string, number>;
  iterations: IterationRecord[];
}

/**
 * The campaign JSON lands where `STRESS_OUT` points (one JSON table, seed →
 * outcome). Records are also appended as JSON lines to `<STRESS_OUT>.jsonl`
 * as they complete so a crashed or timed-out run still leaves evidence.
 */
export class CampaignReporter {
  private readonly records: IterationRecord[] = [];
  private readonly outPath: string | null;
  private readonly startedAtIso = new Date().toISOString();

  constructor(
    private readonly unit: string,
    private readonly lens: string,
  ) {
    const out = process.env.STRESS_OUT;
    this.outPath = out && out.length > 0 ? out : null;
    if (this.outPath) {
      mkdirSync(dirname(this.outPath), { recursive: true });
      writeFileSync(`${this.outPath}.jsonl`, '');
    }
  }

  record(record: IterationRecord): void {
    this.records.push(record);
    if (this.outPath) {
      appendFileSync(`${this.outPath}.jsonl`, `${JSON.stringify(record)}\n`);
    }
  }

  summary(seeds: number[]): CampaignSummary {
    const scenarioCounts: Record<string, number> = {};
    const checkFailureCounts: Record<string, number> = {};
    for (const record of this.records) {
      scenarioCounts[record.scenario] =
        (scenarioCounts[record.scenario] ?? 0) + 1;
      for (const [check, held] of Object.entries(record.checks)) {
        if (!held) {
          checkFailureCounts[check] = (checkFailureCounts[check] ?? 0) + 1;
        }
      }
      if (record.driverError) {
        checkFailureCounts.driverError =
          (checkFailureCounts.driverError ?? 0) + 1;
      }
    }
    const broken = this.records.filter(r => r.outcome === 'BROKEN');
    return {
      unit: this.unit,
      lens: this.lens,
      startedAtIso: this.startedAtIso,
      seeds,
      scenariosExecuted: this.records.length,
      held: this.records.length - broken.length,
      broken: broken.length,
      brokenSeeds: broken.map(r => r.seed),
      scenarioCounts,
      checkFailureCounts,
      iterations: this.records,
    };
  }

  flush(seeds: number[]): CampaignSummary {
    const summary = this.summary(seeds);
    if (this.outPath) {
      writeFileSync(this.outPath, `${JSON.stringify(summary, null, 2)}\n`);
    }
    return summary;
  }
}
