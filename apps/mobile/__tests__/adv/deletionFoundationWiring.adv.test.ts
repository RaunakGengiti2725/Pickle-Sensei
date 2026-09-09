import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * INT-deletion-managed-media adversary: is the durable deletion foundation
 * (`src/account/deletionOperation.ts` + journal + capability vault +
 * transport — the client half of the Edge `operationId`/`statusCapability`
 * contract) reachable from the shipping app at all?
 *
 * A module that only tests import does not deliver a behaviour. This test
 * walks every non-test source file under `src/` and records which of them
 * import the foundation, and which import the legacy challenge-only client.
 */

const SRC = join(__dirname, '..', '..', 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const FOUNDATION_MODULES = [
  'deletionOperation',
  'deletionOperationJournal',
  'deletionOperationTransport',
  'deletionCapabilityVault',
  'deletionOperationContracts',
];

function importersOf(moduleBase: string): string[] {
  const pattern = new RegExp(`from\\s+['"][^'"]*/${moduleBase}(?:\\.js)?['"]`);
  return sourceFiles(SRC)
    .filter(file => {
      const own = FOUNDATION_MODULES.some(m =>
        file.endsWith(`/account/${m}.ts`),
      );
      return !own && pattern.test(readFileSync(file, 'utf8'));
    })
    .map(file => relative(SRC, file))
    .sort();
}

describe('ADV deletion foundation wiring', () => {
  it('OBSERVED the shipping deletion surface still calls the legacy challenge-only client', () => {
    const legacyImporters = importersOf('deletion');
    expect(legacyImporters).toContain('screens/ManageAccountScreen.tsx');
    const screen = readFileSync(
      join(SRC, 'screens', 'ManageAccountScreen.tsx'),
      'utf8',
    );
    expect(screen).toMatch(/confirmAccountDeletion\(\s*apiSessionForDeletion/);
    expect(screen).not.toMatch(/operationId|statusCapability/);
  });

  it('ATTACK the durable deletion foundation must be reachable from a shipping (non-test) module', () => {
    const importers = FOUNDATION_MODULES.flatMap(importersOf);
    // Expected: at least the account-deletion screen or the auth store wires
    // createDeletionOperationFoundation so lost responses / 202 in_progress /
    // relaunch are recovered through the journal + status capability.
    expect(importers).not.toEqual([]);
  });
});
