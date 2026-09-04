/**
 * Minimal typed access to the Node runtime the harness runs on. apps/mobile
 * compiles with the React Native tsconfig (no @types/node), so — like the
 * existing __tests__ that read fixtures — we declare exactly what we use.
 */
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; rss: number };
  getBuiltinModule?: (id: string) => unknown;
};
declare const performance: { now(): number };

export interface FsModule {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, options: { recursive: boolean }): void;
}

export interface PathModule {
  join(...parts: string[]): string;
}

export const fs = require('fs') as FsModule;
export const path = require('path') as PathModule;
export const harnessDir = __dirname;

export function env(name: string): string | undefined {
  return process.env[name];
}

export function heapUsed(): number {
  return process.memoryUsage().heapUsed;
}

export function rss(): number {
  return process.memoryUsage().rss;
}

export function nowMs(): number {
  return performance.now();
}

export function builtinModule(id: string): unknown {
  if (typeof process.getBuiltinModule === 'function') {
    try {
      return process.getBuiltinModule(id);
    } catch {
      return null;
    }
  }
  try {
    return require(id);
  } catch {
    return null;
  }
}
