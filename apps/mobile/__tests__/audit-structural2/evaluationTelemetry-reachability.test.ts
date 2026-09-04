/**
 * AUDIT PROBE (structural #2, mobile-settings-account) — dead/stale code.
 *
 * consentApi.ts exports grant/withdraw helpers for the `evaluation_telemetry`
 * scope ("granted only by an explicit user action" per its doc comment), and
 * runCaptureAnalysis accepts an `evaluationTelemetry` context that is only
 * honoured while that scope is active. This probe asserts that some
 * production module actually reaches those entry points.
 */
// Keeps this file a module so the ambient declarations below stay local.
export {};

// The mobile tsconfig has no Node types (matches
// wf/flow-app-store-compliance-ios-config).
declare const require: (id: string) => unknown;
declare const __dirname: string;
type Dirent = { name: string; isDirectory(): boolean };
type Fs = {
  readFileSync: (path: string, encoding: 'utf8') => string;
  readdirSync: (path: string, opts: { withFileTypes: true }) => Dirent[];
};
const fs = require('fs') as Fs;
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
};

const SRC = path.resolve(__dirname, '../../src');

function walk(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry: Dirent) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
}

function callers(symbol: string, exclude: readonly string[]): string[] {
  return walk(SRC)
    .filter(file => !exclude.some(ex => file.endsWith(ex)))
    .filter(file => fs.readFileSync(file, 'utf8').includes(symbol))
    .map(file => path.relative(SRC, file));
}

describe('AUDIT: evaluation_telemetry consent is reachable from the app', () => {
  it('grantEvaluationTelemetryConsent has at least one production caller', () => {
    const found = callers('grantEvaluationTelemetryConsent', [
      'account/consentApi.ts',
    ]);
    console.log(
      JSON.stringify({ probe: 'evaluationTelemetry/grant-callers', found }),
    );
    expect(found.length).toBeGreaterThan(0);
  });

  it('withdrawEvaluationTelemetryConsent has at least one production caller', () => {
    const found = callers('withdrawEvaluationTelemetryConsent', [
      'account/consentApi.ts',
    ]);
    console.log(
      JSON.stringify({ probe: 'evaluationTelemetry/withdraw-callers', found }),
    );
    expect(found.length).toBeGreaterThan(0);
  });

  it('runCaptureAnalysis is handed an evaluationTelemetry context by some caller', () => {
    const found = callers('evaluationTelemetry', [
      'analysis/runCaptureAnalysis.ts',
      'evaluation/trialCapture.ts',
    ]);
    console.log(
      JSON.stringify({ probe: 'evaluationTelemetry/context-callers', found }),
    );
    expect(found.length).toBeGreaterThan(0);
  });
});
