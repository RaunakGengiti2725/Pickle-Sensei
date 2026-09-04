/**
 * Detector-level pins for scripts/staticHealth: each scanner must flag the
 * canonical bad shape AND stay quiet on the accepted good shape used in the
 * shipping app (guarded voids, awaited delay timers, cleaned-up effects,
 * bounded polls, serialized queues). A detector that goes blind would let
 * `staticHealthRatchet.test.ts` pass vacuously; a detector that over-fires
 * would make the ratchet unusable. Fixtures are compiled through the real
 * TypeScript checker so type-based rules (thenable detection) are exercised.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ts from 'typescript';
import {
  scanCasts,
  scanCatches,
  scanComments,
  scanFlags,
  scanLoops,
  scanPromises,
  scanTimers,
  type ScanContext,
} from '../scripts/staticHealth/scanners';
import type { Category } from '../scripts/staticHealth/types';

const PRELUDE = `
declare function setTimeout(cb: () => void, ms?: number): number;
declare function setInterval(cb: () => void, ms?: number): number;
declare function clearTimeout(h: number | undefined): void;
declare function clearInterval(h: number | undefined): void;
declare function useEffect(cb: () => void | (() => void), deps?: unknown[]): void;
declare function useRef<T>(v: T): { current: T };
declare const Platform: { OS: 'ios' | 'android' };
declare const __DEV__: boolean;
declare function work(): Promise<void>;
declare function sync(): void;
`;

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-health-fixture-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function compile(source: string): ScanContext {
  const file = path.join(dir, `fixture${counter++}.ts`);
  fs.writeFileSync(file, PRELUDE + source);
  const program = ts.createProgram([file], {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    lib: ['lib.es2022.d.ts'],
    noEmit: true,
    types: [],
  });
  const sf = program.getSourceFile(file);
  if (!sf) throw new Error(`fixture did not load: ${file}`);
  return {
    checker: program.getTypeChecker(),
    file: path.basename(file),
    sf,
    searchFiles: [sf],
  };
}

function categories(source: string): Category[] {
  const ctx = compile(source);
  return [
    ...scanComments(ctx),
    ...scanCatches(ctx),
    ...scanCasts(ctx),
    ...scanPromises(ctx),
    ...scanTimers(ctx),
    ...scanLoops(ctx),
    ...scanFlags(ctx),
  ]
    .map(f => f.category)
    .sort();
}

describe('markers, catches, casts', () => {
  it('flags TODO/FIXME/HACK/XXX/STOPSHIP comments only', () => {
    expect(
      categories(`
        // TODO: later
        /* FIXME broken */
        // HACK
        // XXX
        // STOPSHIP
        // to do list (not a marker)
        export const a = 1;
      `),
    ).toEqual(['marker', 'marker', 'marker', 'marker', 'marker']);
  });

  it('flags an empty catch, a catch that drops the error, and a trivial .catch()', () => {
    expect(
      categories(`
        export async function f(p: Promise<number>) {
          try { sync(); } catch {}
          try { sync(); } catch (e) { return null; }
          await p.catch(() => null);
          p.catch(() => {});
        }
      `),
    ).toEqual([
      'catch-drops-error',
      'catch-swallows-rejection',
      'catch-swallows-rejection',
      'empty-catch',
    ]);
  });

  it('accepts a catch that uses the error and a .catch() that reports it', () => {
    expect(
      categories(`
        declare function report(e: unknown): void;
        export async function f(p: Promise<number>) {
          try { sync(); } catch (e) { report(e); }
          await p.catch(e => { report(e); return 0; });
        }
      `),
    ).toEqual([]);
  });

  it('flags as-any, double casts and non-null assertions', () => {
    expect(
      categories(`
        export const a = (1 as any) as string;
        export const b = 'x' as unknown as number;
        const arr: string[] = [];
        export const c = arr[0]!;
        export const d = (null as string | null)!;
      `),
    ).toEqual(['as-any', 'double-cast', 'non-null', 'non-null-index']);
  });
});

describe('promises', () => {
  it('flags a floating promise, a .then() without rejection handling, and a voided call whose rejection is unguarded', () => {
    expect(
      categories(`
        export function f() {
          work();
          work().then(() => 1);
          void work();
        }
      `),
    ).toEqual([
      'floating-promise',
      'then-without-catch',
      'voided-promise-unhandled',
    ]);
  });

  it('accepts awaited, returned, caught, and try/catch-guarded voided work', () => {
    expect(
      categories(`
        declare function report(e: unknown): void;
        export async function g() { return work(); }
        export function f() {
          void work().catch(report);
          void (async () => {
            try { await work(); } catch (e) { console.warn(e); }
          })();
        }
        export async function h() { await work(); }
      `),
    ).toEqual([]);
  });

  it('accepts a serialized queue whose then() takes a rejection handler', () => {
    expect(
      categories(`
        let queue: Promise<void> = Promise.resolve();
        export async function f() {
          const run = async () => { await work(); };
          queue = queue.then(run, run);
          await queue;
        }
      `),
    ).toEqual([]);
  });
});

describe('timers, subscriptions, effects', () => {
  it('flags a discarded interval handle, an effect timer with no cleanup, and a cleanup that clears nothing', () => {
    expect(
      categories(`
        export function a() { setInterval(() => sync(), 1000); }
        export function Comp() {
          useEffect(() => {
            const h = setTimeout(() => sync(), 1000);
          }, []);
          useEffect(() => {
            const h = setTimeout(() => sync(), 1000);
            return () => { sync(); };
          }, []);
          return null;
        }
      `),
    ).toEqual([
      'effect-cleanup-incomplete',
      'effect-without-cleanup',
      'timer-handle-discarded',
    ]);
  });

  it('flags a self-rescheduling timer and a module-level interval', () => {
    expect(
      categories(`
        export function tick() { setTimeout(tick, 1000); }
        export const handle = setInterval(() => sync(), 1000);
      `),
    ).toEqual(['module-timer-uncleared', 'self-rescheduling-timer']);
  });

  it('accepts an awaited one-shot delay and an effect that clears its timer', () => {
    expect(
      categories(`
        export async function delay() {
          await new Promise<void>(resolve => setTimeout(() => resolve(), 100));
        }
        export function Comp() {
          useEffect(() => {
            const h = setTimeout(() => sync(), 1000);
            return () => clearTimeout(h);
          }, []);
          return null;
        }
      `),
    ).toEqual([]);
  });

  it('accepts a ref-held timer cleared through a helper, flags one never cleared', () => {
    expect(
      categories(`
        export function Good() {
          const ref = useRef<number | undefined>(undefined);
          const stop = () => { clearTimeout(ref.current); };
          useEffect(() => {
            ref.current = setTimeout(() => sync(), 1000);
            return stop;
          }, []);
          return null;
        }
      `),
    ).toEqual([]);
    expect(
      categories(`
        export function Bad() {
          const ref = useRef<number | undefined>(undefined);
          const start = () => {
            ref.current = setInterval(() => sync(), 1000);
          };
          return start;
        }
      `),
    ).toEqual(['ref-timer-not-cleared']);
  });
});

describe('loops', () => {
  it('flags while(true) without break and an await-poll with no deadline', () => {
    expect(
      categories(`
        export function spin() { while (true) { sync(); } }
        export async function poll(ready: () => boolean) {
          while (!ready()) { await work(); }
        }
      `),
    ).toEqual(['poll-loop', 'unbounded-loop']);
  });

  it('accepts a loop that breaks and a poll bounded by attempts', () => {
    expect(
      categories(`
        export function spin() { while (true) { if (Math.random() > 0.5) break; } }
        export async function poll(ready: () => boolean) {
          for (let attempt = 0; attempt < 10 && !ready(); attempt++) { await work(); }
        }
      `),
    ).toEqual([]);
  });
});

describe('flags and branches', () => {
  it('flags boolean const flags, constant conditions, platform and __DEV__ branches', () => {
    expect(
      categories(`
        export const ENABLE_THING = false;
        export function f(x: number) {
          if (false) { sync(); }
          if (Platform.OS === 'android') { sync(); }
          if (__DEV__) { sync(); }
          return x;
        }
      `),
    ).toEqual([
      'boolean-const-flag',
      'constant-condition',
      'dev-branch',
      'platform-branch',
    ]);
  });
});
