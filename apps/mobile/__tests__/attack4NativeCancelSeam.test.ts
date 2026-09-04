/**
 * ADVERSARIAL PASS 3 / tester #4 — S9 native seam, Linux-side STATIC pin.
 *
 * This file does NOT execute Swift and makes NO claim about iOS runtime
 * behaviour (that needs the M4 runner, which this pass must not trigger).
 * It pins what the SOURCE of the native bridge says about cancelling an
 * in-flight imported-pose extraction, so the JS finding in
 * attack4AnalyzeScreenLifecycle ("cancel() is not called at unmount") can be
 * read together with "…and cancel() would have nothing to cancel anyway".
 *
 * Classification: INFERRED (source inspection), executable so it stays true.
 */
// Node built-ins, shimmed exactly like importedRealFootageAnalysis.test.ts:
// the mobile tsconfig deliberately excludes node typings. `export {}` keeps
// the shims module-scoped (a script-scoped `declare const require` would
// redeclare the global for the whole project).
export {};
declare const require: (id: string) => unknown;
declare const __dirname: string;
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const swiftPath = join(
  __dirname,
  '..',
  'ios',
  'LocalPods',
  'PickleNative',
  'Sources',
  'PickleVideoCapture.swift',
);
const capturePath = join(__dirname, '..', 'src', 'camera', 'capture.ts');

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`signature not found: ${signature}`);
  // Walk braces from the first `{` after the signature.
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

describe('S9 native seam (static, INFERRED — not iOS runtime evidence)', () => {
  const swift = readFileSync(swiftPath, 'utf8');
  const ts = readFileSync(capturePath, 'utf8');

  it('the native Operation enum has no case for an imported-pose extraction', () => {
    const enumBody = functionBody(swift, 'private enum Operation');
    expect(enumBody).toContain('case guided');
    expect(enumBody).toContain('case importing(String)');
    expect(enumBody).not.toMatch(/extract/i);
  });

  it('extractImportedPoseSequence never registers itself as the active operation (no begin(operation:), no self.operation assignment)', () => {
    const body = functionBody(swift, '@objc func extractImportedPoseSequence(');
    expect(body).not.toContain('begin(operation:');
    expect(body).not.toContain('self.operation =');
    expect(body).not.toContain('guidedController');
    expect(body).not.toContain('importPicker');
    // The reader loop has no cancellation flag to observe.
    expect(body).not.toMatch(/isCancelled|cancelled\s*=|cancelRequested/);
  });

  it('cancel() only knows guidedController / importPicker / operation — an extraction in flight matches none of them', () => {
    const body = functionBody(swift, '@objc func cancel()');
    expect(body).toContain('self.guidedController');
    expect(body).toContain('self.importPicker');
    expect(body).toContain('self.operation != nil');
    expect(body).not.toMatch(/extract|reader\.cancelReading/);
  });

  it('the TS bridge contract exposes no per-extraction cancel handle (only the global cancel())', () => {
    const body = functionBody(
      ts,
      'export async function extractImportedPoseSequence(',
    );
    expect(body).not.toMatch(/AbortSignal|signal|cancel/);
    expect(ts).toContain('export function cancelCameraOperation(): void');
  });
});
