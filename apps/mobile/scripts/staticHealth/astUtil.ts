import ts from 'typescript';
import type { Category, Finding } from './types';

export function lineCol(
  sf: ts.SourceFile,
  node: ts.Node,
): { line: number; column: number } {
  const pos = node.getStart(sf);
  const lc = sf.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, column: lc.character + 1 };
}

export function lineText(sf: ts.SourceFile, node: ts.Node): string {
  const start = node.getStart(sf);
  const lc = sf.getLineAndCharacterOfPosition(start);
  const lineStart = sf.getPositionOfLineAndCharacter(lc.line, 0);
  const lineEnd = sf.text.indexOf('\n', lineStart);
  return sf.text
    .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    .trim()
    .slice(0, 160);
}

export function excerpt(sf: ts.SourceFile, node: ts.Node, max = 120): string {
  return node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, max);
}

export function makeFinding(
  category: Category,
  file: string,
  sf: ts.SourceFile,
  node: ts.Node,
  anchor: string,
  message: string,
  detail?: Finding['detail'],
): Finding {
  const { line, column } = lineCol(sf, node);
  return {
    category,
    file,
    line,
    column,
    fingerprint: `${category}|${file}|${anchor.replace(/\s+/g, ' ').trim()}`,
    snippet: lineText(sf, node),
    message,
    ...(detail ? { detail } : {}),
  };
}

export function isFunctionLike(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** Nearest enclosing function (arrow, method, declaration). */
export function enclosingFunction(
  node: ts.Node,
): ts.FunctionLikeDeclaration | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (isFunctionLike(cur)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

/** Walk `node`'s subtree but do not descend into nested function bodies. */
export function forEachInSameFunction(
  node: ts.Node,
  visit: (n: ts.Node) => void,
): void {
  const walk = (n: ts.Node) => {
    visit(n);
    n.forEachChild(child => {
      if (isFunctionLike(child)) return;
      walk(child);
    });
  };
  node.forEachChild(child => {
    if (isFunctionLike(child)) return;
    walk(child);
  });
}

export function containsInSameFunction(
  node: ts.Node,
  predicate: (n: ts.Node) => boolean,
): boolean {
  let found = false;
  forEachInSameFunction(node, n => {
    if (!found && predicate(n)) found = true;
  });
  return found;
}

export function containsAnywhere(
  node: ts.Node,
  predicate: (n: ts.Node) => boolean,
): boolean {
  let found = false;
  const walk = (n: ts.Node) => {
    if (found) return;
    if (predicate(n)) {
      found = true;
      return;
    }
    n.forEachChild(walk);
  };
  node.forEachChild(walk);
  return found;
}

export function calleeName(call: ts.CallExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    return `${e.expression.getText()}.${e.name.text}`.slice(-80);
  }
  return e.getText().slice(0, 80);
}

export function lastPropertyName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isIdentifier(e)) return e.text;
  return null;
}

/** `a.b().c().d()` → the outermost method name in a fluent chain. */
export function chainHasMethod(expr: ts.Expression, name: string): boolean {
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === name) return true;
        cur = callee.expression;
        continue;
      }
      return false;
    }
    if (ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    return false;
  }
}

export function isThenableType(
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean {
  const check = (t: ts.Type): boolean => {
    if (t.isUnion()) return t.types.some(check);
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
    const then = t.getProperty('then');
    if (!then) return false;
    const decl = then.valueDeclaration ?? then.declarations?.[0];
    if (!decl) return false;
    const thenType = checker.getTypeOfSymbolAtLocation(then, decl);
    return thenType.getCallSignatures().length > 0;
  };
  return check(type);
}

export function bodyOf(
  fn: ts.FunctionLikeDeclaration,
): ts.Block | ts.Expression | undefined {
  return fn.body ?? undefined;
}

/**
 * True when every side-effecting statement of an async body sits inside a
 * try/catch (so a `void fn()` caller cannot receive a rejection), i.e. the
 * body is `try { … } catch { … }` optionally preceded by pure declarations
 * and guard returns.
 */
export function bodyFullyGuarded(body: ts.Block | ts.Expression): boolean {
  if (!ts.isBlock(body)) return false;
  let sawTry = false;
  for (const stmt of body.statements) {
    if (ts.isTryStatement(stmt)) {
      if (!stmt.catchClause) return false;
      sawTry = true;
      continue;
    }
    if (ts.isReturnStatement(stmt) && !stmt.expression) continue;
    if (ts.isIfStatement(stmt)) {
      const onlyGuard =
        !containsInSameFunction(stmt, ts.isAwaitExpression) &&
        !containsInSameFunction(stmt, ts.isCallExpression);
      if (onlyGuard) continue;
      return false;
    }
    if (ts.isVariableStatement(stmt) || ts.isExpressionStatement(stmt)) {
      if (containsInSameFunction(stmt, ts.isAwaitExpression)) return false;
      const risky = containsInSameFunction(
        stmt,
        n =>
          ts.isCallExpression(n) &&
          !/^(console\.\w+|use[A-Z]\w*|get[A-Z]\w*|Date\.now|performance\.now|Math\.\w+|\w+\.getState|Boolean|String|Number)$/.test(
            calleeName(n),
          ),
      );
      if (risky) return false;
      continue;
    }
    return false;
  }
  return sawTry;
}

export interface GuardGaps {
  /** `await x` outside any try/catch where x is not `.catch()`-chained. */
  awaits: number;
  /** Non-await calls outside try/catch (could throw synchronously). */
  calls: number;
  /** First unguarded await/call, for the report. */
  first: ts.Node | undefined;
}

const PURE_CALLEE_RE =
  /^(console\.\w+|use[A-Z]\w*|get[A-Z]\w*|Date\.now|performance\.now|Math\.\w+|\w+\.getState|\w+\.getSourceFile|Boolean|String|Number|Array\.isArray|Object\.\w+|JSON\.stringify|set|get|\w+\.set|\w+\.has|\w+\.get|\w+\.add|\w+\.delete|\w+\.push|\w+\.includes|\w+\.map|\w+\.filter|\w+\.some|\w+\.every|\w+\.find|\w+\.trim|\w+\.slice|\w+\.join|\w+\.split|\w+\.toISOString|\w+\.toString|isCurrentConfiguration|getActiveDataOwner|canonicalDataOwner|clearTimeout|clearInterval|setTimeout|resolve|reject)$/;

/**
 * Counts side-effecting work of an async body that is NOT protected by a
 * try/catch — split into awaited promises (a rejection there escapes to a
 * `void` caller as an unhandled rejection) and plain calls (which only
 * escape if they throw synchronously). Nested functions are not entered.
 */
export interface GuardResolver {
  checker: ts.TypeChecker;
  searchFiles: readonly ts.SourceFile[];
}

/** Awaited calls whose every visible implementation is itself fully guarded
 * (no unguarded awaits, transitively up to `depth`) cannot reject. */
function awaitedCalleeIsSafe(
  awaited: ts.Expression,
  resolver: GuardResolver,
  depth: number,
  seen: Set<ts.Node>,
): boolean {
  const call = unwrapParens(awaited);
  // `await new Promise(resolve => setTimeout(resolve, ms))`: an executor that
  // never rejects/throws yields a promise that cannot reject.
  if (ts.isNewExpression(call)) {
    if (
      !ts.isIdentifier(call.expression) ||
      call.expression.text !== 'Promise'
    ) {
      return false;
    }
    const executor = call.arguments?.[0];
    if (!executor || !isFunctionLike(executor) || !executor.body) return false;
    const rejectName =
      executor.parameters[1] && ts.isIdentifier(executor.parameters[1].name)
        ? executor.parameters[1].name.text
        : null;
    return !containsAnywhere(
      executor.body,
      n =>
        ts.isThrowStatement(n) ||
        (rejectName !== null && ts.isIdentifier(n) && n.text === rejectName) ||
        (ts.isCallExpression(n) &&
          !/^(setTimeout|setImmediate|requestAnimationFrame|resolve)$/.test(
            calleeName(n),
          )),
    );
  }
  if (!ts.isCallExpression(call)) return false;
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return false;
  // `await Promise.all([...])` whose every element is `.catch()`-chained or a
  // `Promise.resolve(...)` cannot reject.
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === 'Promise' &&
    /^(all|allSettled)$/.test(call.expression.name.text)
  ) {
    if (call.expression.name.text === 'allSettled') return true;
    const arr = call.arguments[0] ? unwrapParens(call.arguments[0]) : undefined;
    if (!arr || !ts.isArrayLiteralExpression(arr)) return false;
    const safeElement = (e: ts.Expression): boolean => {
      const x = unwrapParens(e);
      if (ts.isConditionalExpression(x)) {
        return safeElement(x.whenTrue) && safeElement(x.whenFalse);
      }
      if (chainHasMethod(x, 'catch')) return true;
      return ts.isCallExpression(x) && calleeName(x) === 'Promise.resolve';
    };
    return arr.elements.every(safeElement);
  }
  const target = unwrapParens(call.expression);
  const impls = isFunctionLike(target)
    ? [target]
    : resolveImplementations(resolver.checker, target, resolver.searchFiles);
  if (impls.length === 0 || impls.some(d => !d.body)) return false;
  // Only awaited rejections are checked transitively; the callee's own
  // synchronous throws are the caller's `calls` tier (see guardGaps).
  return impls.every(d => {
    if (seen.has(d)) return true;
    seen.add(d);
    return guardGaps(d.body!, resolver, depth - 1, seen).awaits === 0;
  });
}

/** `q = q.then(run, run); await q;` — the awaited promise is a local queue
 * whose two-handler `.then` makes its outcome that of `run`, which the
 * body walk already analyses as a local helper. */
function isTwoHandlerQueueAwait(
  awaited: ts.Expression,
  body: ts.Node,
): boolean {
  const id = unwrapParens(awaited);
  if (!ts.isIdentifier(id)) return false;
  let ok = false;
  forEachInSameFunction(body, n => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      n.left.text === id.text &&
      ts.isCallExpression(n.right) &&
      ts.isPropertyAccessExpression(n.right.expression) &&
      n.right.expression.name.text === 'then' &&
      n.right.arguments.length === 2
    ) {
      ok = true;
    }
  });
  return ok;
}

export function guardGaps(
  body: ts.Block | ts.Expression,
  resolver?: GuardResolver,
  depth = 2,
  seen: Set<ts.Node> = new Set(),
): GuardGaps {
  const gaps: GuardGaps = { awaits: 0, calls: 0, first: undefined };
  const walk = (node: ts.Node, guarded: boolean) => {
    // Local helpers (`const run = async () => {…}` / `function run() {}`) are
    // analysed as part of the body — they are what the body awaits. Inline
    // callbacks handed to other calls are not entered.
    if (
      node !== body &&
      isFunctionLike(node) &&
      !ts.isFunctionDeclaration(node) &&
      !(node.parent && ts.isVariableDeclaration(node.parent))
    ) {
      return;
    }
    if (ts.isTryStatement(node)) {
      walk(node.tryBlock, guarded || !!node.catchClause);
      if (node.catchClause) walk(node.catchClause.block, guarded);
      if (node.finallyBlock) walk(node.finallyBlock, guarded);
      return;
    }
    if (!guarded) {
      if (ts.isAwaitExpression(node)) {
        if (
          !chainHasMethod(node.expression, 'catch') &&
          !isTwoHandlerQueueAwait(node.expression, body) &&
          !(
            resolver &&
            depth > 0 &&
            awaitedCalleeIsSafe(node.expression, resolver, depth, seen)
          )
        ) {
          gaps.awaits += 1;
          // The awaited rejection is the stronger signal: prefer it.
          if (!gaps.first || !ts.isAwaitExpression(gaps.first))
            gaps.first = node;
        }
      } else if (
        ts.isCallExpression(node) &&
        !withinAwaitOperand(node) &&
        !PURE_CALLEE_RE.test(calleeName(node))
      ) {
        gaps.calls += 1;
        gaps.first ??= node;
      }
    }
    node.forEachChild(child => walk(child, guarded));
  };
  walk(body, false);
  return gaps;
}

/** `await a.b().catch(…)` — every call in the awaited chain belongs to the
 * await, which is classified separately. */
function withinAwaitOperand(call: ts.CallExpression): boolean {
  let cur: ts.Node = call;
  while (cur.parent) {
    const p: ts.Node = cur.parent;
    if (ts.isAwaitExpression(p)) return true;
    if (
      (ts.isPropertyAccessExpression(p) && p.expression === cur) ||
      (ts.isCallExpression(p) && p.expression === cur) ||
      ts.isParenthesizedExpression(p) ||
      ts.isNonNullExpression(p)
    ) {
      cur = p;
      continue;
    }
    return false;
  }
  return false;
}

export function resolveFunctionDeclaration(
  checker: ts.TypeChecker,
  expr: ts.Expression,
): ts.FunctionLikeDeclaration | undefined {
  let target: ts.Node = expr;
  if (ts.isPropertyAccessExpression(expr)) target = expr.name;
  const symbol = checker.getSymbolAtLocation(target);
  if (!symbol) return undefined;
  return resolveCandidates(checker, symbol, [], 0)[0];
}

/**
 * Every implementation a call through `symbol` may reach:
 *  - function declarations / arrow initializers / useCallback bodies;
 *  - destructured or selected store actions (`const { hydrate } = useStore()`,
 *    `useStore(s => s.hydrate)`): the property is declared on an interface,
 *    so the implementing object-literal property assignments across
 *    `searchFiles` with the same name and a function initializer are returned.
 */
export function resolveImplementations(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  searchFiles: readonly ts.SourceFile[],
): ts.FunctionLikeDeclaration[] {
  let target: ts.Node = expr;
  if (ts.isPropertyAccessExpression(expr)) target = expr.name;
  const symbol = checker.getSymbolAtLocation(target);
  if (!symbol) return [];
  return resolveCandidates(checker, symbol, searchFiles, 0);
}

function resolveCandidates(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  searchFiles: readonly ts.SourceFile[],
  depth: number,
): ts.FunctionLikeDeclaration[] {
  if (depth > 3) return [];
  const resolved =
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const out: ts.FunctionLikeDeclaration[] = [];
  for (const decl of resolved.declarations ?? []) {
    if (isFunctionLike(decl)) {
      out.push(decl);
      continue;
    }
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = unwrapParens(decl.initializer);
      if (isFunctionLike(init)) {
        out.push(init);
        continue;
      }
      if (ts.isCallExpression(init)) {
        const name = calleeName(init);
        if (/^(useCallback|useMemo)$/.test(name)) {
          const first = init.arguments[0];
          if (first && isFunctionLike(first)) out.push(first);
          continue;
        }
        // `const hydrate = useStore(s => s.hydrate)` — selector returns a
        // property access; resolve that property.
        const selector = init.arguments[0];
        if (
          selector &&
          ts.isArrowFunction(selector) &&
          !ts.isBlock(selector.body)
        ) {
          const body = unwrapParens(selector.body);
          if (ts.isPropertyAccessExpression(body)) {
            const propSym = checker.getSymbolAtLocation(body.name);
            if (propSym) {
              out.push(
                ...resolveCandidates(checker, propSym, searchFiles, depth + 1),
              );
            }
          }
        }
      }
      continue;
    }
    if (ts.isBindingElement(decl)) {
      // `const { hydrate } = useStore()` → property `hydrate` of the type.
      const propName = ts.isIdentifier(decl.propertyName ?? decl.name)
        ? (decl.propertyName ?? decl.name).getText()
        : null;
      const parentDecl = decl.parent.parent;
      if (
        propName &&
        ts.isVariableDeclaration(parentDecl) &&
        parentDecl.initializer
      ) {
        const type = checker.getTypeAtLocation(parentDecl.initializer);
        const prop = type.getProperty(propName);
        if (prop) {
          out.push(...resolveCandidates(checker, prop, searchFiles, depth + 1));
        }
      }
      continue;
    }
    if (ts.isPropertyAssignment(decl)) {
      const init = unwrapParens(decl.initializer);
      if (isFunctionLike(init)) out.push(init);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(decl)) {
      const s = checker.getShorthandAssignmentValueSymbol(decl);
      if (s) out.push(...resolveCandidates(checker, s, searchFiles, depth + 1));
      continue;
    }
    if (
      ts.isPropertySignature(decl) ||
      ts.isPropertyDeclaration(decl) ||
      ts.isMethodSignature(decl)
    ) {
      const name = decl.name.getText();
      const home = decl.getSourceFile();
      const dir = home.fileName.slice(0, home.fileName.lastIndexOf('/') + 1);
      const ordered = [
        home,
        ...searchFiles.filter(f => f !== home && f.fileName.startsWith(dir)),
      ];
      for (const sf of ordered) {
        const found = findPropertyImplementations(sf, name);
        if (found.length) {
          out.push(...found);
          break;
        }
      }
    }
  }
  return out;
}

function findPropertyImplementations(
  sf: ts.SourceFile,
  name: string,
): ts.FunctionLikeDeclaration[] {
  const out: ts.FunctionLikeDeclaration[] = [];
  const visit = (n: ts.Node) => {
    if (
      (ts.isPropertyAssignment(n) || ts.isMethodDeclaration(n)) &&
      n.name.getText() === name
    ) {
      if (ts.isMethodDeclaration(n)) out.push(n);
      else {
        const init = unwrapParens(n.initializer);
        if (isFunctionLike(init)) out.push(init);
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

export function unwrapParens(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}
