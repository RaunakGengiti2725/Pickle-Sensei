import ts from 'typescript';
import { DELETION_SERVER_POLICY } from '../src/account/deletionOperationContracts';

declare const __dirname: string;
const { readFileSync, readdirSync } = jest.requireActual<{
  readFileSync(file: string, encoding: 'utf8'): string;
  readdirSync(
    directory: string,
    options: { withFileTypes: true },
  ): Array<{ name: string; isDirectory(): boolean }>;
}>('node:fs');
const path = jest.requireActual<{
  resolve(...parts: string[]): string;
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
}>('node:path');

const root = path.resolve(__dirname, '..');
const modules = [
  'deletionOperationContracts',
  'deletionCapabilityVault',
  'deletionOperationJournal',
  'deletionOperationTransport',
  'deletionOperation',
];
const owned = new Set(
  modules.map(name => path.join(root, 'src/account', `${name}.ts`)),
);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(file)
      : /\.[jt]sx?$/.test(file)
        ? [file]
        : [];
  });
}

test('none of the currently bundled sources import or export the new standalone foundation', () => {
  const files = [
    ...sourceFiles(path.join(root, 'src')),
    path.join(root, 'App.tsx'),
    path.join(root, 'index.js'),
  ];
  for (const file of files.filter(file => !owned.has(file))) {
    const imports = ts.preProcessFile(
      readFileSync(file, 'utf8'),
      true,
      true,
    ).importedFiles;
    const links = imports.filter(item =>
      modules.some(name =>
        new RegExp(`(?:^|/)${name}(?:\\.[jt]s)?$`).test(item.fileName),
      ),
    );
    expect({ file: path.relative(root, file), links }).toEqual({
      file: path.relative(root, file),
      links: [],
    });
  }
});

test.each(modules)(
  '%s has no runtime dependency on shipping app/auth/db/config/native code',
  name => {
    const file = path.join(root, 'src/account', `${name}.ts`);
    const source = readFileSync(file, 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    for (const match of compiled.matchAll(/require\(["']([^"']+)["']\)/g)) {
      expect(modules.map(module => `./${module}`)).toContain(match[1]);
    }
    expect(source).not.toMatch(
      /\b(?:AsyncStorage|NativeModules|resetGenericPassword|purgeOwnerData|setActiveDataOwner|clearPersistedSession|unlink)\b/,
    );
    expect(source).not.toMatch(/\bconsole\s*\./);
  },
);

test('server lifetime constants remain an unapproved external draft, not a local deletion or retention promise', () => {
  expect(DELETION_SERVER_POLICY).toEqual({
    statusCapabilityLifetimeSeconds: 86_400,
    operationRetentionSeconds: 604_800,
    legallyApproved: false,
    deploymentApproved: false,
  });
});
