/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import type { Finding } from './types';
import type { MobileProgram } from './program';
import { isProductionPath, isTestPath, relPath } from './program';
import { lineCol, lineText } from './astUtil';

interface ExportRecord {
  file: string;
  name: string;
  node: ts.Node;
  sf: ts.SourceFile;
  refsProd: number;
  /** Production importer file → reference count (settled after reachability). */
  refsProdFrom: Map<string, number>;
  refsTest: number;
  /** Uses inside the declaring module itself (excluding the declaration). */
  refsLocal: number;
  reexportedBy: string[];
}

/**
 * ts-prune style dead-export detection using the type checker's symbol
 * graph instead of text matching:
 *  - for each exported symbol of every production module, find every
 *    identifier in the program whose resolved symbol is that export (or an
 *    alias of it) in a *different* file;
 *  - classify referencing files as production or test;
 *  - report exports with zero production references (`dead-export`, only
 *    tests reach it → `test-only-export`) and files no production file imports.
 */
export function scanDeadExports(mp: MobileProgram): Finding[] {
  const { program, checker } = mp;
  /** Keyed by the ORIGIN symbol (aliases resolved), one record per declared
   * export. Barrels (`export * from`, `export { x } from`) therefore never
   * create a second record for the same declaration — their re-exports are
   * counted on the origin, and a barrel nobody imports shows up as a
   * `dead-file` instead. */
  const records = new Map<ts.Symbol, ExportRecord>();
  const importedFiles = new Map<string, { prod: number; test: number }>();
  /** Production import graph (importer → imported), for reachability from
   * the Metro entry: a cluster of files that only import each other is dead
   * even though every member has a production importer. */
  const prodEdges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    const set = prodEdges.get(from) ?? new Set<string>();
    set.add(to);
    prodEdges.set(from, set);
  };

  const entrypoints = new Set(['App.tsx', 'index.js']);

  const originOf = (sym: ts.Symbol): ts.Symbol =>
    sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;

  for (const sf of mp.productionFiles) {
    const rel = relPath(mp.root, sf.fileName);
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) continue;
    for (const exp of checker.getExportsOfModule(moduleSymbol)) {
      const origin = originOf(exp);
      const decl = origin.declarations?.[0];
      if (!decl) continue;
      // Re-exports of another module's symbol are counted on the origin.
      if (decl.getSourceFile() !== sf) continue;
      if (records.has(origin)) continue;
      records.set(origin, {
        file: rel,
        name: exp.name,
        node: decl,
        sf,
        refsProd: 0,
        refsProdFrom: new Map(),
        refsTest: 0,
        refsLocal: 0,
        reexportedBy: [],
      });
    }
  }

  const recordFor = (sym: ts.Symbol): ExportRecord | undefined =>
    records.get(sym);

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!sf.fileName.startsWith(mp.root)) continue;
    const rel = relPath(mp.root, sf.fileName);
    const fromTest = isTestPath(rel);
    const fromProd = isProductionPath(rel);
    if (!fromTest && !fromProd) continue;

    const visit = (node: ts.Node) => {
      // Module-level import bookkeeping.
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const resolved = program.getSourceFile(
          resolveModule(program, sf, node.moduleSpecifier.text) ?? '',
        );
        if (resolved) {
          const target = relPath(mp.root, resolved.fileName);
          const cur = importedFiles.get(target) ?? { prod: 0, test: 0 };
          if (fromTest) cur.test += 1;
          else {
            cur.prod += 1;
            addEdge(rel, target);
          }
          importedFiles.set(target, cur);
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]!) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            /^(require|jest\.requireActual)$/.test(node.expression.text)) ||
          (ts.isPropertyAccessExpression(node.expression) &&
            /^(requireActual|requireMock|mock|doMock)$/.test(
              node.expression.name.text,
            )))
      ) {
        const resolved = program.getSourceFile(
          resolveModule(program, sf, node.arguments[0]!.text) ?? '',
        );
        if (resolved) {
          const target = relPath(mp.root, resolved.fileName);
          const cur = importedFiles.get(target) ?? { prod: 0, test: 0 };
          if (fromTest) cur.test += 1;
          else {
            cur.prod += 1;
            addEdge(rel, target);
          }
          importedFiles.set(target, cur);
        }
      }

      const countUse = (rec: ExportRecord, at: ts.Node) => {
        if (rec.file === rel) {
          if (at !== declarationName(rec.node)) rec.refsLocal += 1;
          return;
        }
        const isReexport =
          ts.isExportSpecifier(at.parent) ||
          (ts.isImportSpecifier(at.parent) && isReexportedImport(at.parent));
        if (isReexport) {
          // A barrel's own `export { x }` line is not a use of x.
          if (!rec.reexportedBy.includes(rel)) rec.reexportedBy.push(rel);
        } else if (fromTest) rec.refsTest += 1;
        else rec.refsProdFrom.set(rel, (rec.refsProdFrom.get(rel) ?? 0) + 1);
      };

      if (ts.isIdentifier(node)) {
        const sym = checker.getSymbolAtLocation(node);
        if (sym) {
          const origin = originOf(sym);
          const rec = recordFor(origin) ?? recordFor(sym);
          if (rec) countUse(rec, node);
        }
      }
      // `const { x } = require('./m') as typeof import('./m')` (lazy native
      // module loading): the binding name is a fresh local symbol, so the
      // export is found through the destructured object's property type.
      if (
        ts.isBindingElement(node) &&
        ts.isObjectBindingPattern(node.parent) &&
        !node.dotDotDotToken
      ) {
        const propNode = node.propertyName ?? node.name;
        if (ts.isIdentifier(propNode)) {
          const prop = checker
            .getTypeAtLocation(node.parent)
            .getProperty(propNode.text);
          if (prop) {
            const origin = originOf(prop);
            const rec = recordFor(origin) ?? recordFor(prop);
            if (rec) countUse(rec, propNode);
          }
        }
      }
      // `export * from './x'` makes every export of x reachable through this
      // barrel; the barrel itself is reported as dead-file if unused.
      if (
        ts.isExportDeclaration(node) &&
        !node.exportClause &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const resolved = program.getSourceFile(
          resolveModule(program, sf, node.moduleSpecifier.text) ?? '',
        );
        if (resolved) {
          const target = relPath(mp.root, resolved.fileName);
          for (const rec of records.values()) {
            if (rec.file === target && !rec.reexportedBy.includes(rel)) {
              rec.reexportedBy.push(rel);
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }

  // `index.js` (the Metro entry) is plain JS and outside the tsconfig program:
  // its named imports are matched to exports by name on the resolved module.
  const indexJs = path.join(mp.root, 'index.js');
  if (fs.existsSync(indexJs)) {
    const jsSf = ts.createSourceFile(
      indexJs,
      fs.readFileSync(indexJs, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    jsSf.forEachChild(stmt => {
      if (
        !ts.isImportDeclaration(stmt) ||
        !ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        return;
      }
      const resolved = program.getSourceFile(
        resolveModule(program, jsSf, stmt.moduleSpecifier.text) ?? '',
      );
      if (!resolved) return;
      const target = relPath(mp.root, resolved.fileName);
      const cur = importedFiles.get(target) ?? { prod: 0, test: 0 };
      cur.prod += 1;
      addEdge('index.js', target);
      importedFiles.set(target, cur);
      const clause = stmt.importClause;
      if (!clause) return;
      const imported = new Set<string>();
      if (clause.name) imported.add('default');
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          imported.add((el.propertyName ?? el.name).text);
        }
      }
      for (const rec of records.values()) {
        if (rec.file === target && imported.has(rec.name)) {
          rec.refsProdFrom.set(
            'index.js',
            (rec.refsProdFrom.get('index.js') ?? 0) + 1,
          );
        }
      }
    });
  }

  const reachable = new Set<string>();
  const queue = [...entrypoints];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const next of prodEdges.get(cur) ?? []) queue.push(next);
  }

  const out: Finding[] = [];
  for (const rec of records.values()) {
    if (entrypoints.has(rec.file)) continue;
    let refsFromDead = 0;
    for (const [from, n] of rec.refsProdFrom) {
      if (reachable.has(from)) rec.refsProd += n;
      else refsFromDead += n;
    }
    if (rec.refsProd > 0) continue;
    const target = declarationName(rec.node);
    const { line, column } = lineCol(rec.sf, target);
    const isTypeOnly = isTypeOnlyDeclaration(rec.node);
    const category = rec.refsTest > 0 ? 'test-only-export' : 'dead-export';
    const unusedSymbol = rec.refsLocal === 0 && rec.refsTest === 0;
    out.push({
      category,
      file: rec.file,
      line,
      column,
      fingerprint: `${category}|${rec.file}|${rec.name}`,
      snippet: lineText(rec.sf, target),
      message:
        refsFromDead > 0
          ? `export \`${rec.name}\` is used only by unreachable modules (${refsFromDead} refs)${rec.refsTest > 0 ? ` and __tests__ (${rec.refsTest} refs)` : ''}`
          : rec.refsTest > 0
            ? `export \`${rec.name}\` is referenced only from __tests__ (${rec.refsTest} refs) — no production caller`
            : unusedSymbol
              ? `\`${rec.name}\` is exported but referenced nowhere — not even in its own module (dead code)`
              : `export \`${rec.name}\` has no reference outside its own module (${rec.refsLocal} local uses; \`export\` is unnecessary)`,
      detail: {
        name: rec.name,
        typeOnly: isTypeOnly,
        refsTest: rec.refsTest,
        refsLocal: rec.refsLocal,
        refsFromUnreachable: refsFromDead,
        fileReachable: reachable.has(rec.file),
        unusedSymbol,
        reexportedBy: rec.reexportedBy,
      },
    });
  }

  for (const sf of mp.productionFiles) {
    const rel = relPath(mp.root, sf.fileName);
    if (entrypoints.has(rel) || reachable.has(rel)) continue;
    const refs = importedFiles.get(rel) ?? { prod: 0, test: 0 };
    const deadImporters = [...prodEdges.entries()]
      .filter(([, targets]) => targets.has(rel))
      .map(([from]) => from)
      .sort();
    out.push({
      category: 'dead-file',
      file: rel,
      line: 1,
      column: 1,
      fingerprint: `dead-file|${rel}`,
      snippet: sf.text.split('\n')[0]?.trim().slice(0, 160) ?? '',
      message:
        deadImporters.length > 0
          ? `module is unreachable from index.js/App.tsx — imported only by other unreachable modules (${deadImporters.join(', ')})${refs.test > 0 ? ` and ${refs.test} test import(s)` : ''}`
          : refs.test > 0
            ? `module is imported only by tests (${refs.test} imports) — not reachable from index.js/App.tsx`
            : 'module is never imported by any production or test file',
      detail: {
        importedByTests: refs.test,
        importedByUnreachable: deadImporters,
        lines: sf.getLineAndCharacterOfPosition(sf.end).line + 1,
      },
    });
  }
  return out;
}

function isTypeOnlyDeclaration(node: ts.Node): boolean {
  return (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    (ts.isExportSpecifier(node) && node.isTypeOnly)
  );
}

function declarationName(node: ts.Node): ts.Node {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isExportSpecifier(node)) &&
    node.name
  ) {
    return node.name;
  }
  return node;
}

/** `import { x } from './a'; export { x };` — the import line is bookkeeping
 * for a re-export, not a use, when the same file exports the binding. */
function isReexportedImport(spec: ts.ImportSpecifier): boolean {
  const sf = spec.getSourceFile();
  const local = spec.name.text;
  let reexported = false;
  sf.forEachChild(stmt => {
    if (
      ts.isExportDeclaration(stmt) &&
      !stmt.moduleSpecifier &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause) &&
      stmt.exportClause.elements.some(
        e => (e.propertyName ?? e.name).text === local,
      )
    ) {
      reexported = true;
    }
  });
  return reexported;
}

function resolveModule(
  program: ts.Program,
  from: ts.SourceFile,
  specifier: string,
): string | undefined {
  const opts = program.getCompilerOptions();
  const res = ts.resolveModuleName(specifier, from.fileName, opts, ts.sys);
  const resolved = res.resolvedModule?.resolvedFileName;
  if (resolved && !res.resolvedModule?.isExternalLibraryImport) return resolved;
  return undefined;
}
