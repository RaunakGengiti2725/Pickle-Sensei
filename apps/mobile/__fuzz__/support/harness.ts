/**
 * Fuzz runner + report writer. A "surface" is one persisted-state reader
 * (a store hydrate, a repository reader, the Keychain vault). For every
 * generator × case index the runner derives a deterministic seed, generates
 * one input from the surface's valid template, feeds it to the reader and
 * classifies the outcome:
 *
 *   accepted  — reader produced a well-formed value (expected for `valid`);
 *   rejected  — reader refused it and landed in a safe default/empty state;
 *   lenient   — reader accepted something structurally off but harmless to
 *               callers (reported, never a failure);
 *   invariant — reader "succeeded" but left a state callers cannot survive or
 *               the user cannot recover from (failure);
 *   threw     — an exception escaped the reader (failure).
 *
 * Every failure is written with its seed, generator, index and (when it
 * fits) the verbatim input, so `FUZZ_REPLAY=<surface>:<generator>:<index>`
 * re-runs exactly that case. Reports land under
 * `artifacts/fuzz-mobile-persisted-state/<run id>/` at the repo root.
 */
// The mobile tsconfig deliberately has no node globals (types: ["jest"]);
// the existing wf suites reach node the same way.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { existsSync, mkdirSync, writeFileSync } = require('fs') as {
  existsSync: (p: string) => boolean;
  mkdirSync: (p: string, opts: { recursive: boolean }) => void;
  writeFileSync: (p: string, data: string) => void;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { dirname, resolve } = require('path') as {
  dirname: (p: string) => string;
  resolve: (...parts: string[]) => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeProcess = require('process') as {
  env: Record<string, string | undefined>;
  cwd: () => string;
  version: string;
  memoryUsage: () => {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
};
import {
  ALL_GENERATORS,
  serializeInput,
  type GeneratedInput,
  type Json,
  type SerializedInput,
} from './generators';
import { Rng, hashSeed } from './prng';

export type Outcome =
  'accepted' | 'rejected' | 'lenient' | 'invariant' | 'threw';

export interface CaseVerdict {
  outcome: Exclude<Outcome, 'threw'>;
  detail?: string;
}

export interface Surface {
  name: string;
  /** A record the reader must accept as-is (the `valid` generator's seed). */
  template: Json;
  /** Generator names to run; defaults to every generator. */
  generators?: readonly string[];
  /** The reader compares the raw string byte-for-byte (no JSON parse), so
   * the `valid` generator must emit exactly `JSON.stringify(template)`. */
  strictValid?: boolean;
  /**
   * A reproduced, triaged defect: `invariant` outcomes whose detail matches
   * `detail` are EXPECTED on this surface until the referenced code changes.
   * The suite then asserts they still occur (the pin flips red once the
   * reader is fixed, so the entry is removed together with the fix). Any
   * OTHER invariant on the surface still fails; `threw` is never tolerated.
   */
  knownInvariant?: {
    finding: string;
    files: readonly string[];
    detail: RegExp;
  };
  run(
    input: GeneratedInput,
    caseSeed: number,
  ): Promise<CaseVerdict> | CaseVerdict;
}

export interface CaseRecord {
  surface: string;
  generator: string;
  index: number;
  caseSeed: number;
  replay: string;
  outcome: Outcome;
  detail?: string;
  error?: { name: string; message: string; stack?: string };
  input: SerializedInput;
  durationMs: number;
}

export interface HeapSample {
  label: string;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
}

export interface SurfaceSummary {
  surface: string;
  cases: number;
  accepted: number;
  rejected: number;
  lenient: number;
  invariant: number;
  threw: number;
  durationMs: number;
  maxCaseMs: number;
  heapBefore: HeapSample;
  heapAfter: HeapSample;
  heapPeakUsedMb: number;
}

export interface FuzzConfig {
  masterSeed: number;
  casesPerGenerator: number;
  runId: string;
  outDir: string;
  replay: { surface: string; generator: string; index: number } | null;
  onlySurface: string | null;
}

const DEFAULT_MASTER_SEED = 20260904;
const DEFAULT_CASES = 200;
const MAX_RECORDED_FAILURES_PER_CELL = 100;
/** Per-surface jest timeout: a 200-case sweep over 15 generators (3 000
 * hydrations, 2 MiB payloads included) must never trip jest's 30 s default. */
export const FUZZ_TEST_TIMEOUT_MS = 20 * 60_000;

/** Nearest ancestor of cwd holding the workspace manifest (jest runs from
 * apps/mobile; `pnpm -r` style invocations run from the root). */
function repoRoot(): string {
  let dir = nodeProcess.cwd();
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return nodeProcess.cwd();
}

export function loadConfig(): FuzzConfig {
  const env = nodeProcess.env;
  const seed = Number(env['FUZZ_SEED'] ?? DEFAULT_MASTER_SEED);
  const cases = Number(env['FUZZ_CASES'] ?? DEFAULT_CASES);
  if (
    !Number.isSafeInteger(seed) ||
    !Number.isSafeInteger(cases) ||
    cases < 1
  ) {
    throw new Error('FUZZ_SEED and FUZZ_CASES must be positive integers');
  }
  const runId =
    env['FUZZ_RUN_ID'] ??
    `local-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir =
    env['FUZZ_OUT_DIR'] ??
    resolve(repoRoot(), 'artifacts/fuzz-mobile-persisted-state', runId);
  let replay: FuzzConfig['replay'] = null;
  if (env['FUZZ_REPLAY']) {
    const [surface, generator, index] = env['FUZZ_REPLAY'].split(':');
    if (
      !surface ||
      !generator ||
      index === undefined ||
      !Number.isSafeInteger(Number(index))
    ) {
      throw new Error('FUZZ_REPLAY must be <surface>:<generator>:<index>');
    }
    replay = { surface, generator, index: Number(index) };
  }
  return {
    masterSeed: seed,
    casesPerGenerator: cases,
    runId,
    outDir,
    replay,
    onlySurface: env['FUZZ_ONLY_SURFACE'] ?? null,
  };
}

function heap(label: string): HeapSample {
  const usage = nodeProcess.memoryUsage();
  const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 100) / 100;
  return {
    label,
    rssMb: mb(usage.rss),
    heapUsedMb: mb(usage.heapUsed),
    heapTotalMb: mb(usage.heapTotal),
    externalMb: mb(usage.external),
  };
}

function describeError(error: unknown): CaseRecord['error'] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 6).join('\n'),
    };
  }
  return { name: typeof error, message: String(error) };
}

export class FuzzRun {
  readonly config: FuzzConfig;
  readonly startedAt = new Date().toISOString();
  readonly summaries: SurfaceSummary[] = [];
  readonly failures: CaseRecord[] = [];
  readonly lenient: CaseRecord[] = [];
  readonly matrix: Record<string, Record<string, Record<Outcome, number>>> = {};
  readonly heapSamples: HeapSample[] = [];
  readonly knownInvariants: Array<{
    surface: string;
    finding: string;
    files: readonly string[];
    detail: string;
  }> = [];
  private failuresPerCell = new Map<string, number>();

  constructor(
    readonly group: string,
    config: FuzzConfig = loadConfig(),
  ) {
    this.config = config;
  }

  caseSeed(surface: string, generator: string, index: number): number {
    return hashSeed(this.config.masterSeed, surface, generator, index);
  }

  /** True when FUZZ_ONLY_SURFACE / FUZZ_REPLAY leave this surface any cases. */
  targets(surface: string): boolean {
    if (this.config.onlySurface && this.config.onlySurface !== surface)
      return false;
    return !this.config.replay || this.config.replay.surface === surface;
  }

  private shouldRun(
    surface: string,
    generator: string,
    index: number,
  ): boolean {
    if (this.config.onlySurface && this.config.onlySurface !== surface)
      return false;
    const replay = this.config.replay;
    if (!replay) return true;
    return (
      replay.surface === surface &&
      replay.generator === generator &&
      replay.index === index
    );
  }

  async fuzzSurface(surface: Surface): Promise<SurfaceSummary> {
    const generatorNames = surface.generators ?? Object.keys(ALL_GENERATORS);
    const heapBefore = heap(`${surface.name}:before`);
    this.heapSamples.push(heapBefore);
    let heapPeakUsedMb = heapBefore.heapUsedMb;
    const summary: SurfaceSummary = {
      surface: surface.name,
      cases: 0,
      accepted: 0,
      rejected: 0,
      lenient: 0,
      invariant: 0,
      threw: 0,
      durationMs: 0,
      maxCaseMs: 0,
      heapBefore,
      heapAfter: heapBefore,
      heapPeakUsedMb,
    };
    const row = (this.matrix[surface.name] ??= {});
    if (surface.knownInvariant) {
      this.knownInvariants.push({
        surface: surface.name,
        finding: surface.knownInvariant.finding,
        files: surface.knownInvariant.files,
        detail: surface.knownInvariant.detail.source,
      });
    }
    const started = Date.now();
    for (const generatorName of generatorNames) {
      const generator = ALL_GENERATORS[generatorName];
      if (!generator) throw new Error(`unknown generator ${generatorName}`);
      const cell = (row[generatorName] ??= {
        accepted: 0,
        rejected: 0,
        lenient: 0,
        invariant: 0,
        threw: 0,
      });
      for (let index = 0; index < this.config.casesPerGenerator; index++) {
        if (!this.shouldRun(surface.name, generatorName, index)) continue;
        const caseSeed = this.caseSeed(surface.name, generatorName, index);
        const input: GeneratedInput =
          generatorName === 'valid' && surface.strictValid
            ? { kind: 'string', value: JSON.stringify(surface.template) }
            : generator(new Rng(caseSeed), surface.template);
        const caseStarted = Date.now();
        let outcome: Outcome;
        let detail: string | undefined;
        let error: CaseRecord['error'];
        try {
          const verdict = await surface.run(input, caseSeed);
          outcome = verdict.outcome;
          detail = verdict.detail;
          if (generatorName === 'valid' && outcome !== 'accepted') {
            outcome = 'invariant';
            detail = `valid template was not accepted (${verdict.outcome}${
              verdict.detail ? `: ${verdict.detail}` : ''
            })`;
          }
        } catch (caught) {
          outcome = 'threw';
          error = describeError(caught);
        }
        const durationMs = Date.now() - caseStarted;
        summary.cases++;
        summary[outcome]++;
        cell[outcome]++;
        summary.maxCaseMs = Math.max(summary.maxCaseMs, durationMs);
        if (index % 50 === 0) {
          heapPeakUsedMb = Math.max(heapPeakUsedMb, heap('sample').heapUsedMb);
        }
        if (
          outcome === 'threw' ||
          outcome === 'invariant' ||
          outcome === 'lenient'
        ) {
          const record: CaseRecord = {
            surface: surface.name,
            generator: generatorName,
            index,
            caseSeed,
            replay: `FUZZ_SEED=${this.config.masterSeed} FUZZ_REPLAY=${surface.name}:${generatorName}:${index}`,
            outcome,
            ...(detail ? { detail } : {}),
            ...(error ? { error } : {}),
            input: serializeInput(input),
            durationMs,
          };
          if (outcome === 'lenient') {
            if (this.lenient.length < 500) this.lenient.push(record);
          } else if (
            outcome === 'invariant' &&
            surface.knownInvariant?.detail.test(detail ?? '')
          ) {
            // Only the pinned (already-known) finding is capped per cell;
            // every throw and every unpinned invariant is always recorded so
            // assertions() can never lose one behind the cap.
            const key = `${surface.name}|${generatorName}`;
            const recorded = this.failuresPerCell.get(key) ?? 0;
            if (recorded < MAX_RECORDED_FAILURES_PER_CELL) {
              this.failures.push(record);
              this.failuresPerCell.set(key, recorded + 1);
            }
          } else {
            this.failures.push(record);
          }
        }
      }
    }
    summary.durationMs = Date.now() - started;
    summary.heapAfter = heap(`${surface.name}:after`);
    summary.heapPeakUsedMb = Math.max(
      heapPeakUsedMb,
      summary.heapAfter.heapUsedMb,
    );
    this.heapSamples.push(summary.heapAfter);
    this.summaries.push(summary);
    return summary;
  }

  failureCount(surface: string): number {
    const summary = this.summaries.find(entry => entry.surface === surface);
    return summary ? summary.threw + summary.invariant : 0;
  }

  summaryFor(surface: string): SurfaceSummary {
    const summary = this.summaries.find(entry => entry.surface === surface);
    if (!summary) throw new Error(`surface ${surface} has not been fuzzed`);
    return summary;
  }

  /**
   * The suite-level assertion for one fuzzed surface. Returns the messages
   * that must be empty for the surface to pass; each message carries the
   * replay seeds of the offending cases.
   */
  assertions(surface: Surface): string[] {
    const problems: string[] = [];
    const threw = this.failures.filter(
      record => record.surface === surface.name && record.outcome === 'threw',
    );
    if (threw.length > 0) {
      problems.push(this.describeRecords(`${surface.name} threw`, threw));
    }
    const invariants = this.failures.filter(
      record =>
        record.surface === surface.name && record.outcome === 'invariant',
    );
    if (surface.knownInvariant) {
      const pin = surface.knownInvariant;
      const pinned = invariants.filter(record =>
        pin.detail.test(record.detail ?? ''),
      );
      const unpinned = invariants.filter(
        record => !pin.detail.test(record.detail ?? ''),
      );
      if (pinned.length === 0 && !this.config.replay) {
        problems.push(
          `${surface.name}: known finding ${pin.finding} no longer reproduces — remove its knownInvariant pin (${pin.files.join(', ')})`,
        );
      }
      if (unpinned.length > 0) {
        problems.push(
          this.describeRecords(
            `${surface.name} broke an invariant outside its pinned finding`,
            unpinned,
          ),
        );
      }
    } else if (invariants.length > 0) {
      problems.push(
        this.describeRecords(`${surface.name} broke an invariant`, invariants),
      );
    }
    return problems;
  }

  private describeRecords(
    title: string,
    records: CaseRecord[],
    limit = 5,
  ): string {
    const lines = records.slice(0, limit).map(record => {
      const reason = record.error
        ? `${record.error.name}: ${record.error.message}`
        : (record.detail ?? '');
      return `  [${record.outcome}] ${record.replay} input=${record.input.preview} — ${reason}`;
    });
    return `${title}: ${records.length} case(s), first ${lines.length}:\n${lines.join('\n')}`;
  }

  /** Compact, replayable description of a surface's failures for assertion
   * messages: the seeds are in the message, not only in the report file. */
  describeFailures(surface: string, limit = 5): string {
    const failures = this.failures.filter(record => record.surface === surface);
    if (failures.length === 0) return `${surface}: no failures`;
    const lines = failures.slice(0, limit).map(record => {
      const reason = record.error
        ? `${record.error.name}: ${record.error.message}`
        : (record.detail ?? '');
      return `  [${record.outcome}] ${record.replay} input=${record.input.preview} — ${reason}`;
    });
    return `${surface}: ${this.failureCount(surface)} failure(s), first ${lines.length}:\n${lines.join('\n')}`;
  }

  write(): string {
    mkdirSync(this.config.outDir, { recursive: true });
    const finishedAt = new Date().toISOString();
    const jsonPath = resolve(this.config.outDir, `${this.group}.json`);
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          group: this.group,
          runId: this.config.runId,
          masterSeed: this.config.masterSeed,
          casesPerGenerator: this.config.casesPerGenerator,
          replay: this.config.replay,
          node: nodeProcess.version,
          startedAt: this.startedAt,
          finishedAt,
          totals: this.summaries.reduce(
            (acc, summary) => ({
              cases: acc.cases + summary.cases,
              accepted: acc.accepted + summary.accepted,
              rejected: acc.rejected + summary.rejected,
              lenient: acc.lenient + summary.lenient,
              invariant: acc.invariant + summary.invariant,
              threw: acc.threw + summary.threw,
            }),
            {
              cases: 0,
              accepted: 0,
              rejected: 0,
              lenient: 0,
              invariant: 0,
              threw: 0,
            },
          ),
          surfaces: this.summaries,
          knownInvariants: this.knownInvariants,
          matrix: this.matrix,
          failures: this.failures,
          lenient: this.lenient,
          heap: this.heapSamples,
        },
        null,
        2,
      ),
    );
    const matrixPath = resolve(this.config.outDir, `${this.group}.matrix.md`);
    writeFileSync(matrixPath, this.renderMatrix());
    return jsonPath;
  }

  renderMatrix(): string {
    const lines: string[] = [
      `# ${this.group} — seed ${this.config.masterSeed}, ${this.config.casesPerGenerator} cases/generator, run ${this.config.runId}`,
      '',
      '| surface | generator | accepted | rejected | lenient | invariant | threw |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ];
    for (const [surface, row] of Object.entries(this.matrix)) {
      for (const [generator, cell] of Object.entries(row)) {
        lines.push(
          `| ${surface} | ${generator} | ${cell.accepted} | ${cell.rejected} | ${cell.lenient} | ${cell.invariant} | ${cell.threw} |`,
        );
      }
    }
    lines.push(
      '',
      '| surface | cases | failures | duration ms | max case ms | heap used before → after (peak) MB |',
      '| --- | ---: | ---: | ---: | ---: | --- |',
    );
    for (const summary of this.summaries) {
      lines.push(
        `| ${summary.surface} | ${summary.cases} | ${summary.threw + summary.invariant} | ${summary.durationMs} | ${summary.maxCaseMs} | ${summary.heapBefore.heapUsedMb} → ${summary.heapAfter.heapUsedMb} (${summary.heapPeakUsedMb}) |`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
}

/** Shared verdict helpers. */
export const accepted = (detail?: string): CaseVerdict => ({
  outcome: 'accepted',
  ...(detail ? { detail } : {}),
});
export const rejected = (detail?: string): CaseVerdict => ({
  outcome: 'rejected',
  ...(detail ? { detail } : {}),
});
export const lenient = (detail: string): CaseVerdict => ({
  outcome: 'lenient',
  detail,
});
export const invariant = (detail: string): CaseVerdict => ({
  outcome: 'invariant',
  detail,
});

/** Applies a generated input to a kv-style slot: strings verbatim, typed
 * values as the driver would return them. */
export function rawValue(input: GeneratedInput): unknown {
  return input.value;
}
