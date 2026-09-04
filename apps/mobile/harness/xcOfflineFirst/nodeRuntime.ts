/**
 * Typed access to the Node runtime for the XC harness. The React Native
 * tsconfig ships no `@types/node`, so — like `__tests__/wf/*` — the harness
 * declares the handful of Node surfaces it needs instead of importing them.
 */

export interface NodeFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, options: { recursive: boolean }): void;
}

export interface NodePath {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}

export interface NodeProcess {
  readonly env: Record<string, string | undefined>;
  readonly version: string;
  memoryUsage(): {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
}

declare const process: NodeProcess;

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const nodeFs = require('fs') as NodeFs;
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const nodePath = require('path') as NodePath;
export const nodeProcess: NodeProcess = process;

export function heapSnapshot() {
  const usage = nodeProcess.memoryUsage();
  const mib = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
  return {
    rssMiB: mib(usage.rss),
    heapUsedMiB: mib(usage.heapUsed),
    heapTotalMiB: mib(usage.heapTotal),
    externalMiB: mib(usage.external),
  };
}
