/**
 * Node built-ins for stress-campaign artifacts. The mobile tsconfig excludes
 * node typings (same shim as __tests__/matrix); it lives in its own module
 * because babel-plugin-jest-hoist rejects a `declare const require` binding
 * in a file that also contains `jest.mock()` factories.
 */
declare const require: (id: string) => unknown;
declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
};

const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

export const env: Record<string, string | undefined> = process.env;

/** `<cwd>/artifacts/<sub>` — jest runs with cwd = apps/mobile. */
export function defaultArtifactDir(sub: string): string {
  return join(process.cwd(), 'artifacts', sub);
}

export function writeJsonArtifact(
  dir: string,
  name: string,
  value: unknown,
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}
