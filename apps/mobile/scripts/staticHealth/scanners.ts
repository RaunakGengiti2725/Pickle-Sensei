import ts from 'typescript';
import type { Finding } from './types';
import {
  guardGaps,
  calleeName,
  chainHasMethod,
  containsAnywhere,
  containsInSameFunction,
  enclosingFunction,
  excerpt,
  forEachInSameFunction,
  isFunctionLike,
  isThenableType,
  lastPropertyName,
  lineCol,
  makeFinding,
  resolveImplementations,
  unwrapParens,
} from './astUtil';

export interface ScanContext {
  checker: ts.TypeChecker;
  file: string;
  sf: ts.SourceFile;
  /** Production sources, used to locate store-action implementations. */
  searchFiles: readonly ts.SourceFile[];
}

// ─── markers ────────────────────────────────────────────────────────────────

const MARKER_RE = /\b(TODO|FIXME|HACK|XXX|TEMPORARY|STOPSHIP)\b/;
const TS_DIRECTIVE_RE = /@ts-(ignore|expect-error|nocheck)\b/;
const ESLINT_DISABLE_RE = /eslint-disable(-next-line|-line)?\b(.*)$/;

export function scanComments(ctx: ScanContext): Finding[] {
  const { sf, file } = ctx;
  const out: Finding[] = [];
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    sf.languageVariant,
    sf.text,
  );
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const text = scanner.getTokenText();
      const pos = scanner.getTokenStart();
      const lc = sf.getLineAndCharacterOfPosition(pos);
      const base = {
        file,
        line: lc.line + 1,
        column: lc.character + 1,
        snippet: text.split('\n')[0]?.trim().slice(0, 160) ?? '',
      };
      const marker = MARKER_RE.exec(text);
      if (marker) {
        out.push({
          ...base,
          category: 'marker',
          fingerprint: `marker|${file}|${base.snippet}`,
          message: `${marker[1]} marker left in shipping code`,
        });
      }
      const directive = TS_DIRECTIVE_RE.exec(text);
      if (directive) {
        out.push({
          ...base,
          category: 'ts-directive',
          fingerprint: `ts-directive|${file}|${base.snippet}`,
          message: `@ts-${directive[1]} suppresses the type checker`,
        });
      }
      const disable = ESLINT_DISABLE_RE.exec(text);
      if (disable) {
        out.push({
          ...base,
          category: 'eslint-disable',
          fingerprint: `eslint-disable|${file}|${base.snippet}`,
          message: `eslint-disable${disable[1] ?? ''}${(disable[2] ?? '').trim() ? ' ' + (disable[2] ?? '').replace(/\*\/\s*$/, '').trim() : ' (all rules)'}`,
        });
      }
    }
    token = scanner.scan();
  }
  return out;
}

// ─── catches ────────────────────────────────────────────────────────────────

const ERROR_SINK_RE =
  /^(console\.(warn|error|log|info|debug)|\w*[lL]og\w*|\w*[tT]elemetry\w*|\w*[rR]eport\w*|\w*[rR]ecord\w*|\w*[tT]rack\w*|\w*[eE]mit\w*|\w*[cC]apture\w*)$/;

function isEmptyBlock(block: ts.Block): boolean {
  return block.statements.length === 0;
}

function isSwallowHandler(arg: ts.Expression): string | null {
  const fn = unwrapParens(arg);
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const body = fn.body;
    if (ts.isBlock(body)) {
      if (isEmptyBlock(body)) return 'empty handler';
      if (
        body.statements.length === 1 &&
        ts.isReturnStatement(body.statements[0]!) &&
        isTrivialValue(body.statements[0]!.expression)
      ) {
        return `returns ${body.statements[0]!.expression?.getText() ?? 'undefined'}`;
      }
      return null;
    }
    if (isTrivialValue(body)) return `returns ${body.getText()}`;
    return null;
  }
  if (ts.isIdentifier(fn) && /^noop$/i.test(fn.text)) return 'noop';
  return null;
}

function isTrivialValue(e: ts.Expression | undefined): boolean {
  if (!e) return true;
  const u = unwrapParens(e);
  return (
    u.kind === ts.SyntaxKind.NullKeyword ||
    u.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(u) && u.text === 'undefined') ||
    u.kind === ts.SyntaxKind.FalseKeyword ||
    u.kind === ts.SyntaxKind.TrueKeyword ||
    (ts.isVoidExpression(u) && ts.isNumericLiteral(u.expression)) ||
    (ts.isObjectLiteralExpression(u) && u.properties.length === 0) ||
    (ts.isArrayLiteralExpression(u) && u.elements.length === 0)
  );
}

export function scanCatches(ctx: ScanContext): Finding[] {
  const { sf, file } = ctx;
  const out: Finding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCatchClause(node)) {
      const fn = enclosingFunction(node);
      const fnName = describeFunction(fn);
      if (isEmptyBlock(node.block)) {
        const hasComment =
          node.block.getFullText(sf).replace(/[{}\s]/g, '').length > 0;
        out.push(
          makeFinding(
            'empty-catch',
            file,
            sf,
            node,
            `${fnName}#${excerpt(sf, node.parent as ts.Node, 60)}`,
            hasComment
              ? 'catch block is empty (comment only) — the error is dropped'
              : 'catch block is empty — the error is dropped without a trace',
            { function: fnName, commentOnly: hasComment },
          ),
        );
      } else {
        const binding = node.variableDeclaration;
        const bindingName =
          binding && ts.isIdentifier(binding.name) ? binding.name.text : null;
        const referencesError =
          bindingName !== null &&
          containsAnywhere(
            node.block,
            n => ts.isIdentifier(n) && n.text === bindingName,
          );
        const hasSink = containsAnywhere(
          node.block,
          n =>
            (ts.isCallExpression(n) && ERROR_SINK_RE.test(calleeName(n))) ||
            ts.isThrowStatement(n),
        );
        const rethrows = containsInSameFunction(
          node.block,
          ts.isThrowStatement,
        );
        if (!referencesError && !hasSink && !rethrows) {
          out.push(
            makeFinding(
              'catch-drops-error',
              file,
              sf,
              node,
              `${fnName}#${excerpt(sf, node.block, 80)}`,
              'catch recovers without inspecting, logging, or reporting the error (failure class is invisible in the field)',
              {
                function: fnName,
                recovery: excerpt(sf, node.block, 140),
              },
            ),
          );
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'catch' &&
      node.arguments.length === 1
    ) {
      const how = isSwallowHandler(node.arguments[0]!);
      if (how) {
        const fn = enclosingFunction(node);
        out.push(
          makeFinding(
            'catch-swallows-rejection',
            file,
            sf,
            node,
            `${describeFunction(fn)}#${excerpt(sf, node.expression.expression, 80)}`,
            `.catch(${how}) discards the rejection — the failure class is never observed`,
            {
              function: describeFunction(fn),
              promise: excerpt(sf, node.expression.expression, 140),
              handler: how,
            },
          ),
        );
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

export function describeFunction(
  fn: ts.FunctionLikeDeclaration | undefined,
): string {
  if (!fn) return '<module>';
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  let cur: ts.Node = fn;
  while (cur.parent) {
    const p = cur.parent;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name))
      return p.name.text;
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name))
      return p.name.text;
    if (ts.isCallExpression(p)) {
      const outer = enclosingFunction(p);
      const outerName = describeFunction(outer);
      return `${outerName}>${calleeName(p)}`;
    }
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isArrowFunction(p)
    ) {
      return describeFunction(p as ts.FunctionLikeDeclaration);
    }
    cur = p;
  }
  return '<anonymous>';
}

// ─── casts ──────────────────────────────────────────────────────────────────

export function scanCasts(ctx: ScanContext): Finding[] {
  const { sf, file } = ctx;
  const out: Finding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (node.type.kind === ts.SyntaxKind.AnyKeyword) {
        out.push(
          makeFinding(
            'as-any',
            file,
            sf,
            node,
            excerpt(sf, node, 80),
            '`as any` removes type safety for everything downstream',
          ),
        );
      } else if (
        node.type.kind === ts.SyntaxKind.UnknownKeyword &&
        node.parent &&
        (ts.isAsExpression(node.parent) ||
          ts.isTypeAssertionExpression(node.parent))
      ) {
        out.push(
          makeFinding(
            'double-cast',
            file,
            sf,
            node.parent,
            excerpt(sf, node.parent, 80),
            '`as unknown as T` bypasses structural checking — the shape of T is asserted, not verified',
            { target: node.parent.type.getText(sf).slice(0, 80) },
          ),
        );
      }
    }
    if (ts.isNonNullExpression(node)) {
      const inner = unwrapParens(node.expression);
      const isIndex =
        ts.isElementAccessExpression(inner) ||
        (ts.isCallExpression(inner) &&
          /^(find|at|pop|shift|get)$/.test(lastPropertyName(inner) ?? ''));
      out.push(
        makeFinding(
          isIndex ? 'non-null-index' : 'non-null',
          file,
          sf,
          node,
          excerpt(sf, node, 80),
          isIndex
            ? 'non-null assertion on an index/lookup result defeats noUncheckedIndexedAccess — throws TypeError when the slot is empty'
            : 'non-null assertion — throws TypeError at runtime if the value is null/undefined',
        ),
      );
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

// ─── promises ───────────────────────────────────────────────────────────────

export function scanPromises(ctx: ScanContext): Finding[] {
  const { sf, file, checker } = ctx;
  const out: Finding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isExpressionStatement(node)) {
      const expr = node.expression;
      if (ts.isVoidExpression(expr)) {
        const inner = unwrapParens(expr.expression);
        const type = safeType(checker, inner);
        if (type && isThenableType(checker, type)) {
          const verdict = classifyVoided(checker, inner, ctx.searchFiles);
          if (verdict) {
            const fn = enclosingFunction(node);
            out.push(
              makeFinding(
                'voided-promise-unhandled',
                file,
                sf,
                node,
                `${describeFunction(fn)}#${excerpt(sf, inner, 80)}`,
                `\`void\` discards a promise that can reject: ${verdict.reason}. A rejection surfaces only as an unhandled-rejection warning (silent in release).`,
                {
                  function: describeFunction(fn),
                  callee: verdict.callee,
                  declaredAt: verdict.declaredAt,
                  risk: verdict.risk,
                  unguardedAwaits: verdict.unguardedAwaits ?? null,
                  unguardedCalls: verdict.unguardedCalls ?? null,
                },
              ),
            );
          }
        }
      } else if (
        !ts.isAwaitExpression(expr) &&
        !ts.isYieldExpression(expr) &&
        // `queue = queue.then(run, run)` stores the promise; not floating.
        !(
          ts.isBinaryExpression(expr) &&
          ts.isToken(expr.operatorToken) &&
          expr.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          expr.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        )
      ) {
        const inner = unwrapParens(expr);
        const type = safeType(checker, inner);
        if (type && isThenableType(checker, type)) {
          const handled =
            ts.isCallExpression(inner) && chainHasMethod(inner, 'catch');
          const thenOnly =
            !handled &&
            ts.isCallExpression(inner) &&
            chainHasMethod(inner, 'then');
          if (thenOnly) {
            const fn = enclosingFunction(node);
            out.push(
              makeFinding(
                'then-without-catch',
                file,
                sf,
                node,
                `${describeFunction(fn)}#${excerpt(sf, inner, 80)}`,
                '.then() chain has no .catch() — rejection of the source or the handler is unobserved',
                { function: describeFunction(fn) },
              ),
            );
          } else if (!handled) {
            const fn = enclosingFunction(node);
            // `(async () => { … })()` — inspect the IIFE body directly.
            const iife =
              ts.isCallExpression(inner) &&
              isFunctionLike(unwrapParens(inner.expression))
                ? (unwrapParens(inner.expression) as ts.FunctionLikeDeclaration)
                : undefined;
            const gaps = iife?.body
              ? guardGaps(iife.body, { checker, searchFiles: ctx.searchFiles })
              : undefined;
            const risk = gaps
              ? gaps.awaits > 0
                ? 'await'
                : gaps.calls > 0
                  ? 'sync-call'
                  : 'none'
              : 'unknown';
            if (risk !== 'none') {
              out.push(
                makeFinding(
                  'floating-promise',
                  file,
                  sf,
                  node,
                  `${describeFunction(fn)}#${excerpt(sf, inner, 80)}`,
                  `promise-returning expression is neither awaited, returned, voided nor .catch()-ed${
                    gaps
                      ? ` — IIFE body has ${gaps.awaits} await(s) / ${gaps.calls} call(s) outside try/catch`
                      : ''
                  }`,
                  {
                    function: describeFunction(fn),
                    risk,
                    unguardedAwaits: gaps?.awaits ?? null,
                    unguardedCalls: gaps?.calls ?? null,
                    firstGap: gaps?.first ? excerpt(sf, gaps.first, 70) : null,
                  },
                ),
              );
            }
          }
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

function safeType(
  checker: ts.TypeChecker,
  node: ts.Expression,
): ts.Type | undefined {
  try {
    return checker.getTypeAtLocation(node);
  } catch {
    return undefined;
  }
}

interface VoidVerdict {
  reason: string;
  callee: string;
  declaredAt: string | null;
  /** 'await': an awaited promise can reject outside try/catch (rejection
   * escapes). 'sync-call': only synchronous throws could escape. 'unknown':
   * body not visible. 'then': .then chain without .catch. */
  risk: 'await' | 'sync-call' | 'unknown' | 'then';
  unguardedAwaits?: number;
  unguardedCalls?: number;
}

/**
 * Returns null when the voided promise is provably handled (chain ends in
 * .catch, or the callee's async body is wrapped in try/catch). Otherwise a
 * verdict explaining why a rejection can escape.
 */
function classifyVoided(
  checker: ts.TypeChecker,
  inner: ts.Expression,
  searchFiles: readonly ts.SourceFile[],
): VoidVerdict | null {
  if (ts.isCallExpression(inner) && chainHasMethod(inner, 'catch')) return null;
  let call: ts.CallExpression | undefined;
  let cur: ts.Expression = inner;
  while (ts.isCallExpression(cur)) {
    const callee = cur.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      /^(then|finally)$/.test(callee.name.text) &&
      ts.isCallExpression(callee.expression)
    ) {
      cur = callee.expression;
      continue;
    }
    call = cur;
    break;
  }
  if (!call) {
    return {
      reason:
        'expression is not a direct call; cannot prove the chain handles rejection',
      callee: excerpt(inner.getSourceFile(), inner, 60),
      declaredAt: null,
      risk: 'unknown',
    };
  }
  const hasThen = ts.isCallExpression(inner) && chainHasMethod(inner, 'then');
  const target = unwrapParens(call.expression);
  const decls: ts.FunctionLikeDeclaration[] = isFunctionLike(target)
    ? [target]
    : resolveImplementations(checker, target, searchFiles);
  const name = calleeName(call);
  const withBody = decls.filter(d => d.body);
  if (withBody.length === 0) {
    return {
      reason: `callee \`${name}\` is external or its body is not visible — handler unknown`,
      callee: name,
      declaredAt: null,
      risk: 'unknown',
    };
  }
  const locate = (decl: ts.FunctionLikeDeclaration): string => {
    const declSf = decl.getSourceFile();
    const { line } = lineCol(declSf, decl);
    return `${declSf.fileName.split('/apps/mobile/')[1] ?? declSf.fileName}:${line}`;
  };
  if (hasThen) {
    return {
      reason: `.then() handler attached to \`${name}\` without .catch() — the handler's own throw and the source rejection both escape`,
      callee: name,
      declaredAt: withBody.map(locate).join(','),
      risk: 'then',
    };
  }
  const gapsByDecl = withBody.map(d => ({
    d,
    gaps: guardGaps(d.body!, { checker, searchFiles }),
  }));
  const unguarded = gapsByDecl.filter(
    ({ gaps }) => gaps.awaits > 0 || gaps.calls > 0,
  );
  if (unguarded.length === 0) return null;
  const first = unguarded[0]!;
  const isAsync =
    first.d.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ??
    false;
  const declaredAt = unguarded.map(({ d }) => locate(d)).join(',');
  const awaits = unguarded.reduce((n, u) => n + u.gaps.awaits, 0);
  const calls = unguarded.reduce((n, u) => n + u.gaps.calls, 0);
  const firstGap = first.gaps.first;
  const firstText = firstGap
    ? excerpt(firstGap.getSourceFile(), firstGap, 70)
    : '';
  return {
    reason: `\`${name}\` (${isAsync ? 'async' : 'promise-returning'}, ${declaredAt}) has ${awaits} await(s) and ${calls} call(s) outside try/catch — first: ${firstText}`,
    callee: name,
    declaredAt,
    risk: awaits > 0 ? 'await' : 'sync-call',
    unguardedAwaits: awaits,
    unguardedCalls: calls,
  };
}

// ─── timers / subscriptions ─────────────────────────────────────────────────

const EFFECT_HOOKS =
  /^(useEffect|useLayoutEffect|useFocusEffect|useInsertionEffect)$/;
const TIMER_FNS =
  /^(setInterval|setTimeout|requestAnimationFrame|setImmediate)$/;
const SUBSCRIBE_METHODS =
  /^(addEventListener|addListener|subscribe|addChangeListener|on)$/;
const CLEANUP_RE =
  /\b(clearInterval|clearTimeout|cancelAnimationFrame|clearImmediate|remove|unsubscribe|removeEventListener|removeListener|off|cancel|abort|dispose|close|stop|clear|release|destroy|detach|removeAllListeners|current\s*=\s*null|current\s*=\s*false|=\s*false|=\s*null)\b/;

export function scanTimers(ctx: ScanContext): Finding[] {
  const { sf, file } = ctx;
  const out: Finding[] = [];
  const fileText = sf.text;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const prop = lastPropertyName(node);
      const isTimer =
        ts.isIdentifier(node.expression) &&
        TIMER_FNS.test(node.expression.text);
      const isSubscribe =
        ts.isPropertyAccessExpression(node.expression) &&
        SUBSCRIBE_METHODS.test(prop ?? '') &&
        !/^(observable|stream|store)$/.test(
          node.expression.expression.getText(sf),
        ) &&
        node.arguments.length >= 1;
      if ((isTimer || isSubscribe) && !isAwaitedDelayTimer(node)) {
        const kind = isTimer ? (node.expression as ts.Identifier).text : prop!;
        const effect = enclosingEffectCall(node);
        const fn = enclosingFunction(node);
        const clearFn =
          kind === 'setInterval' ? 'clearInterval' : 'clearTimeout';
        if (isTimer && !fn && !fileCallsFunction(sf, clearFn)) {
          out.push(
            makeFinding(
              'module-timer-uncleared',
              file,
              sf,
              node,
              `<module>#${kind}#${excerpt(sf, node, 60)}`,
              `module-level ${kind} with no ${kind === 'setInterval' ? 'clearInterval' : 'clearTimeout'} in the file — runs for the process lifetime`,
              { kind },
            ),
          );
        } else if (effect) {
          const cb = effect.arguments[0];
          const effectBody = cb && isFunctionLike(cb) ? cb.body : undefined;
          const cleanup = effectBody
            ? findCleanupReturn(effectBody)
            : undefined;
          // A timer scheduled inside a nested helper of the effect (e.g. a
          // scheduler closure) counts as effect-owned only if the effect's own
          // cleanup can reach it; we still require a cleanup to exist.
          if (
            !cleanup &&
            effectBody &&
            handleRemovedInCallback(node, effectBody, sf)
          ) {
            // e.g. `const l = anim.addListener(..); anim.start(() => anim.removeListener(l))`
            // — removed on completion, not on unmount. Tracked, not reported.
          } else if (!cleanup) {
            out.push(
              makeFinding(
                'effect-without-cleanup',
                file,
                sf,
                node,
                `${describeFunction(fn)}#${kind}#${excerpt(sf, node, 60)}`,
                `${kind} scheduled inside ${calleeName(effect)} whose callback returns no cleanup — fires after unmount / re-registers on every dependency change`,
                { hook: calleeName(effect), kind },
              ),
            );
          } else if (!CLEANUP_RE.test(cleanup.getText(sf))) {
            out.push(
              makeFinding(
                'effect-cleanup-incomplete',
                file,
                sf,
                node,
                `${describeFunction(fn)}#${kind}#${excerpt(sf, node, 60)}`,
                `${kind} scheduled inside ${calleeName(effect)} but its cleanup never clears/removes anything`,
                {
                  hook: calleeName(effect),
                  kind,
                  cleanup: excerpt(sf, cleanup, 120),
                },
              ),
            );
          }
        } else if (kind === 'setInterval' || isSubscribe) {
          // Outside an effect: the handle must be retained and cleared somewhere.
          const parent = node.parent;
          const retained =
            ts.isVariableDeclaration(parent) ||
            ts.isBinaryExpression(parent) ||
            ts.isPropertyAssignment(parent) ||
            ts.isReturnStatement(parent) ||
            ts.isArrowFunction(parent) ||
            ts.isCallExpression(parent) ||
            ts.isArrayLiteralExpression(parent);
          if (!retained) {
            out.push(
              makeFinding(
                'timer-handle-discarded',
                file,
                sf,
                node,
                `${describeFunction(fn)}#${kind}#${excerpt(sf, node, 60)}`,
                `${kind} handle is discarded — nothing can ever clear/unsubscribe it`,
                { kind, function: describeFunction(fn) },
              ),
            );
          } else if (ts.isBinaryExpression(parent)) {
            const lhs = parent.left.getText(sf);
            const refName = lhs.replace(/\.current$/, '');
            const clearedSomewhere = new RegExp(
              `(clearInterval|clearTimeout|remove|unsubscribe|cancel)\\s*\\(\\s*${escapeRe(lhs)}|${escapeRe(lhs)}\\??\\.(remove|unsubscribe|cancel)\\s*\\(|${escapeRe(refName)}\\.current\\??\\.(remove|unsubscribe)\\s*\\(|${escapeRe(lhs)}\\s*=\\s*null`,
            ).test(fileText);
            if (!clearedSomewhere) {
              out.push(
                makeFinding(
                  'ref-timer-not-cleared',
                  file,
                  sf,
                  node,
                  `${describeFunction(fn)}#${kind}#${lhs}`,
                  `${kind} handle stored in \`${lhs}\` is never cleared/unsubscribed anywhere in the file`,
                  { kind, handle: lhs, function: describeFunction(fn) },
                ),
              );
            } else if (fn && isComponentFile(sf) && lhs.endsWith('.current')) {
              const hasUnmountCleanup = hasEffectCleanupReferencing(
                sf,
                refName,
                helpersClearing(sf, lhs),
              );
              if (!hasUnmountCleanup) {
                out.push(
                  makeFinding(
                    'ref-timer-not-cleared',
                    file,
                    sf,
                    node,
                    `${describeFunction(fn)}#${kind}#${lhs}#unmount`,
                    `${kind} handle in \`${lhs}\` is cleared by handlers but no effect cleanup clears it on unmount`,
                    { kind, handle: lhs, function: describeFunction(fn) },
                  ),
                );
              }
            }
          }
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

function fileCallsFunction(sf: ts.SourceFile, name: string): boolean {
  return containsAnywhere(
    sf,
    n =>
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === name,
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isComponentFile(sf: ts.SourceFile): boolean {
  return /\.tsx$/.test(sf.fileName) || /\buse[A-Z]\w*\s*\(/.test(sf.text);
}

function enclosingEffectCall(node: ts.Node): ts.CallExpression | undefined {
  let cur: ts.Node | undefined = node.parent;
  let depth = 0;
  while (cur) {
    if (
      ts.isCallExpression(cur) &&
      EFFECT_HOOKS.test(calleeName(cur)) &&
      cur.arguments[0] &&
      isFunctionLike(unwrapParens(cur.arguments[0]))
    ) {
      return cur;
    }
    // `useFocusEffect(useCallback(() => {...}, []))`
    if (
      ts.isCallExpression(cur) &&
      calleeName(cur) === 'useCallback' &&
      cur.parent &&
      ts.isCallExpression(cur.parent) &&
      EFFECT_HOOKS.test(calleeName(cur.parent))
    ) {
      return cur.parent;
    }
    if (isFunctionLike(cur)) depth += 1;
    if (depth > 4) return undefined;
    cur = cur.parent;
  }
  return undefined;
}

function findCleanupReturn(
  body: ts.Block | ts.Expression,
): ts.Node | undefined {
  if (!ts.isBlock(body)) {
    const e = unwrapParens(body);
    return isFunctionLike(e) ? e : undefined;
  }
  let found: ts.Node | undefined;
  forEachInSameFunction(body, n => {
    if (found) return;
    if (ts.isReturnStatement(n) && n.expression) {
      const e = unwrapParens(n.expression);
      if (isFunctionLike(e) || ts.isIdentifier(e) || ts.isCallExpression(e)) {
        found = e;
      }
    }
  });
  if (found && ts.isIdentifier(found)) {
    // `return cleanup;` — resolve to the local declaration for text matching.
    const name = found.text;
    let decl: ts.Node | undefined;
    forEachInSameFunction(body, n => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === name &&
        n.initializer
      ) {
        decl = n.initializer;
      }
      if (ts.isFunctionDeclaration(n) && n.name?.text === name) decl = n;
    });
    return decl ?? found;
  }
  return found;
}

/** An effect cleanup (or the effect body itself, for `if (!visible)`-style
 * teardown) references the ref directly or calls a local helper that clears it. */
function hasEffectCleanupReferencing(
  sf: ts.SourceFile,
  refName: string,
  helpers: readonly string[],
): boolean {
  const mentions = (text: string): boolean =>
    text.includes(refName) ||
    helpers.some(h => new RegExp(`\\b${escapeRe(h)}\\s*\\(`).test(text));
  let ok = false;
  const visit = (node: ts.Node) => {
    if (ok) return;
    if (ts.isCallExpression(node) && EFFECT_HOOKS.test(calleeName(node))) {
      const cb = node.arguments[0];
      if (cb && isFunctionLike(cb) && cb.body) {
        const cleanup = findCleanupReturn(cb.body);
        if (cleanup && mentions(cleanup.getText(sf))) ok = true;
        else if (helpers.length > 0 && mentions(cb.body.getText(sf))) ok = true;
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return ok;
}

/** Names of local functions whose body clears `lhs` (e.g. `stopCountdown`). */
function helpersClearing(sf: ts.SourceFile, lhs: string): string[] {
  const names: string[] = [];
  const clears = new RegExp(
    `(clearInterval|clearTimeout|cancelAnimationFrame|clearImmediate)\\s*\\(\\s*${escapeRe(lhs)}`,
  );
  const visit = (node: ts.Node) => {
    let name: string | undefined;
    let body: ts.Node | undefined;
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      name = node.name.text;
      body = node.body;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isFunctionLike(unwrapParens(node.initializer))
    ) {
      name = node.name.text;
      body = unwrapParens(node.initializer);
    }
    if (name && body && clears.test(body.getText(sf))) names.push(name);
    node.forEachChild(visit);
  };
  visit(sf);
  return names;
}

/** `await new Promise(resolve => setTimeout(resolve, ms))` — a one-shot delay
 * primitive whose callback only resolves; nothing to clear. */
function isAwaitedDelayTimer(call: ts.CallExpression): boolean {
  if (
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== 'setTimeout'
  ) {
    return false;
  }
  let cur: ts.Node | undefined = call.parent;
  let hops = 0;
  while (cur && hops < 4) {
    if (ts.isNewExpression(cur)) {
      return (
        ts.isIdentifier(cur.expression) && cur.expression.text === 'Promise'
      );
    }
    if (ts.isBlock(cur) || ts.isStatement(cur)) hops += 1;
    cur = cur.parent;
  }
  return false;
}

/** The handle returned by `call` (bound to a local) is passed to a
 * remove/unsubscribe call somewhere inside the same effect body. */
function handleRemovedInCallback(
  call: ts.CallExpression,
  effectBody: ts.Node,
  sf: ts.SourceFile,
): boolean {
  const parent = call.parent;
  if (!ts.isVariableDeclaration(parent) || !ts.isIdentifier(parent.name)) {
    return false;
  }
  const handle = parent.name.text;
  const re = new RegExp(
    `\\.(removeListener|removeEventListener|remove|unsubscribe|off)\\s*\\(\\s*${escapeRe(handle)}\\b|\\b${escapeRe(handle)}\\??\\.(remove|unsubscribe)\\s*\\(`,
  );
  return re.test(effectBody.getText(sf));
}

// ─── loops ──────────────────────────────────────────────────────────────────

const POLL_GUARD_RE =
  /\b(cancel|abort|signal|stop|live\(\)|generation|disposed|closed|deadline|budget|attempt|retries|maxAttempts|timeout|length|size|hasNext|next\(\)|done|cursor|offset|page)\b/i;

export function scanLoops(ctx: ScanContext): Finding[] {
  const { sf, file } = ctx;
  const out: Finding[] = [];
  const visit = (node: ts.Node) => {
    let infinite = false;
    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      infinite = node.expression.kind === ts.SyntaxKind.TrueKeyword;
    } else if (ts.isForStatement(node)) {
      infinite = !node.condition;
    }
    // `while (!ready()) { await … }` — exits only when the data condition
    // flips; without a cancellation token / deadline / attempt budget in
    // the condition or body it spins for as long as the producer is silent.
    if (
      !infinite &&
      (ts.isWhileStatement(node) || ts.isDoStatement(node)) &&
      containsInSameFunction(node.statement, ts.isAwaitExpression) &&
      !containsInSameFunction(
        node.statement,
        n =>
          ts.isBreakStatement(n) ||
          ts.isReturnStatement(n) ||
          ts.isThrowStatement(n),
      )
    ) {
      const text =
        node.expression.getText(sf) + ' ' + node.statement.getText(sf);
      const fn = enclosingFunction(node);
      if (!POLL_GUARD_RE.test(text)) {
        out.push(
          makeFinding(
            'poll-loop',
            file,
            sf,
            node,
            `${describeFunction(fn)}#${excerpt(sf, node, 60)}`,
            'await-loop exits only on a data condition — no cancellation token, deadline, or attempt budget is consulted',
            {
              function: describeFunction(fn),
              condition: excerpt(sf, node.expression, 80),
            },
          ),
        );
      }
    }
    if (infinite && ts.isIterationStatement(node, false)) {
      const body = node.statement;
      const exits = containsInSameFunction(
        body,
        n =>
          ts.isBreakStatement(n) ||
          ts.isReturnStatement(n) ||
          ts.isThrowStatement(n),
      );
      const awaits = containsInSameFunction(body, ts.isAwaitExpression);
      const fn = enclosingFunction(node);
      if (!exits) {
        out.push(
          makeFinding(
            'unbounded-loop',
            file,
            sf,
            node,
            `${describeFunction(fn)}#${excerpt(sf, node, 60)}`,
            'infinite loop with no break/return/throw inside its own body',
            { function: describeFunction(fn), hasAwait: awaits },
          ),
        );
      } else if (awaits) {
        const condText = body.getText(sf);
        const guarded = POLL_GUARD_RE.test(condText);
        if (!guarded) {
          out.push(
            makeFinding(
              'poll-loop',
              file,
              sf,
              node,
              `${describeFunction(fn)}#${excerpt(sf, node, 60)}`,
              'await-loop exits only on a data condition — no cancellation token, deadline, or attempt budget is consulted',
              { function: describeFunction(fn) },
            ),
          );
        }
      }
    }
    // Self-rescheduling timers: fn body schedules setTimeout(<fn or arrow calling fn>).
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'setTimeout'
    ) {
      const fn = enclosingFunction(node);
      const fnName = describeFunction(fn);
      const arg0 = node.arguments[0];
      if (fn && arg0 && fnName !== '<anonymous>' && fnName !== '<module>') {
        const argText = arg0.getText(sf);
        const reschedules =
          (ts.isIdentifier(arg0) && arg0.text === fnName) ||
          new RegExp(`\\b${escapeRe(fnName)}\\s*\\(`).test(argText);
        if (reschedules) {
          const guard =
            fn.body &&
            /\b(if\s*\(|return|cancel|stop|live\(\)|generation|attempt|max|budget|deadline)\b/i.test(
              fn.body.getText(sf),
            );
          out.push(
            makeFinding(
              'self-rescheduling-timer',
              file,
              sf,
              node,
              `${fnName}#${excerpt(sf, node, 60)}`,
              guard
                ? `\`${fnName}\` re-arms itself via setTimeout (guarded — verify the guard covers unmount/sign-out)`
                : `\`${fnName}\` re-arms itself via setTimeout with no visible stop condition`,
              { function: fnName, guarded: Boolean(guard) },
            ),
          );
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

// ─── flags / constant branches ──────────────────────────────────────────────

const FLAGGY_NAME =
  /(flag|enabled|enable|disabled|feature|experiment|rollout|kill|switch|toggle|beta|legacy|debug|mock|fake|stub|allow)/i;

export function scanFlags(ctx: ScanContext): Finding[] {
  const { sf, file } = ctx;
  const out: Finding[] = [];
  const boolConsts = new Map<string, ts.VariableDeclaration>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
    if (!isConst) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const init = unwrapParens(d.initializer);
      if (
        init.kind === ts.SyntaxKind.TrueKeyword ||
        init.kind === ts.SyntaxKind.FalseKeyword
      ) {
        boolConsts.set(d.name.text, d);
      }
    }
  }
  for (const [name, d] of boolConsts) {
    const usedInCondition = containsAnywhere(
      sf,
      n =>
        ts.isIdentifier(n) &&
        n.text === name &&
        n !== d.name &&
        isConditionPosition(n),
    );
    const exported =
      d.parent.parent &&
      ts.isVariableStatement(d.parent.parent) &&
      (d.parent.parent.modifiers?.some(
        m => m.kind === ts.SyntaxKind.ExportKeyword,
      ) ??
        false);
    if (usedInCondition || FLAGGY_NAME.test(name)) {
      out.push(
        makeFinding(
          'boolean-const-flag',
          file,
          sf,
          d,
          name,
          `module-level boolean constant \`${name} = ${d.initializer!.getText(sf)}\` ${usedInCondition ? 'gates code paths — the other branch is dead at build time' : 'looks like a feature flag'}${exported ? ' (exported)' : ''}`,
          {
            name,
            value: d.initializer!.getText(sf),
            usedInCondition,
            exported,
          },
        ),
      );
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      const cond = unwrapParens(
        ts.isIfStatement(node) ? node.expression : node.condition,
      );
      if (
        cond.kind === ts.SyntaxKind.TrueKeyword ||
        cond.kind === ts.SyntaxKind.FalseKeyword ||
        (ts.isIdentifier(cond) && boolConsts.has(cond.text)) ||
        (ts.isPrefixUnaryExpression(cond) &&
          ts.isIdentifier(cond.operand) &&
          boolConsts.has(cond.operand.text))
      ) {
        out.push(
          makeFinding(
            'constant-condition',
            file,
            sf,
            node,
            excerpt(sf, cond, 60),
            `condition \`${excerpt(sf, cond, 60)}\` is a compile-time constant — one branch is dead code`,
          ),
        );
      }
    }
    if (ts.isBinaryExpression(node)) {
      const text = node.getText(sf).replace(/\s+/g, ' ');
      const m = /^Platform\.OS\s*(===|!==|==|!=)\s*'(\w+)'$/.exec(text);
      if (m) {
        const fn = enclosingFunction(node);
        out.push(
          makeFinding(
            'platform-branch',
            file,
            sf,
            node,
            `${describeFunction(fn)}#${text}`,
            `platform branch \`${text}\` — the app ships iPhone-only; the non-iOS side is unreachable on the release target`,
            { platform: m[2]!, op: m[1]!, function: describeFunction(fn) },
          ),
        );
      }
    }
    if (
      ts.isIdentifier(node) &&
      node.text === '__DEV__' &&
      !ts.isVariableDeclaration(node.parent)
    ) {
      const fn = enclosingFunction(node);
      out.push(
        makeFinding(
          'dev-branch',
          file,
          sf,
          node,
          `${describeFunction(fn)}#${excerpt(sf, node.parent, 60)}`,
          '__DEV__ branch — behaviour differs between debug and release builds',
          { function: describeFunction(fn) },
        ),
      );
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(sf) === 'Platform' &&
      node.expression.name.text === 'select'
    ) {
      const fn = enclosingFunction(node);
      out.push(
        makeFinding(
          'platform-branch',
          file,
          sf,
          node,
          `${describeFunction(fn)}#${excerpt(sf, node, 60)}`,
          'Platform.select — the app ships iPhone-only; non-iOS keys are unreachable on the release target',
          { platform: 'select', op: 'select', function: describeFunction(fn) },
        ),
      );
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

function isConditionPosition(n: ts.Node): boolean {
  const p = n.parent;
  if (!p) return false;
  if (ts.isIfStatement(p) && p.expression === n) return true;
  if (ts.isConditionalExpression(p) && p.condition === n) return true;
  if (ts.isPrefixUnaryExpression(p)) return isConditionPosition(p);
  if (
    ts.isBinaryExpression(p) &&
    (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      p.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return true;
  }
  if (ts.isWhileStatement(p) && p.expression === n) return true;
  return false;
}
