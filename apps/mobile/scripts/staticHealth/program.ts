/// <reference types="node" />
import * as path from 'path';
import ts from 'typescript';

export interface MobileProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
  options: ts.CompilerOptions;
  /** Absolute apps/mobile root. */
  root: string;
  /** Shipping sources: App.tsx + src/** (never __tests__). */
  productionFiles: ts.SourceFile[];
  /** Jest suites and their helpers under __tests__/. */
  testFiles: ts.SourceFile[];
}

export const MOBILE_ROOT = path.resolve(__dirname, '..', '..');

export function relPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

export function isProductionPath(rel: string): boolean {
  return rel === 'App.tsx' || rel.startsWith('src/');
}

export function isTestPath(rel: string): boolean {
  return rel.startsWith('__tests__/');
}

export function loadMobileProgram(root: string = MOBILE_ROOT): MobileProgram {
  const configPath = path.join(root, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    skipLibCheck: true,
  };
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options,
  });
  const productionFiles: ts.SourceFile[] = [];
  const testFiles: ts.SourceFile[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const rel = relPath(root, sf.fileName);
    if (rel.startsWith('..') || rel.includes('node_modules/')) continue;
    if (isProductionPath(rel)) productionFiles.push(sf);
    else if (isTestPath(rel)) testFiles.push(sf);
  }
  productionFiles.sort((a, b) => a.fileName.localeCompare(b.fileName));
  testFiles.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return {
    program,
    checker: program.getTypeChecker(),
    options,
    root,
    productionFiles,
    testFiles,
  };
}
