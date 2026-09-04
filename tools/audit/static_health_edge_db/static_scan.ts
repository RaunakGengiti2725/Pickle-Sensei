// Static code-health scan of the production edge function
// (supabase/functions/api/*.ts), AST-based:
//
//   1. error emitters — every errorJson/codedError/serviceUnavailable/json(4xx|5xx)
//      /reject(...)/new Response(...) with status, code, message shape, and
//      whether a 5xx message interpolates anything derived from an error;
//   2. error-taxonomy consistency — code format, code→status stability,
//      server-emitted codes vs. codes the mobile app compares against;
//   3. swallowed errors — catch clauses / .catch handlers classified as
//      silent | fallback | logged | rethrow, floating promises, DB writes whose
//      result is never inspected;
//   4. structure — per-function size/await/nesting metrics, route table size,
//      unsafe casts, module-level mutable state.
//
//   deno run -A --no-check --config tools/audit/static_health_edge_db/deno.json \
//     tools/audit/static_health_edge_db/static_scan.ts [--out path.json]

import {
  endLineOf,
  enclosingNamedFunction,
  lineOf,
  loadSource,
  repoPath,
  stringLiteralValue,
  ts,
  walk,
  type SourceFile,
} from "./lib/ast.ts";
import { inventory } from "./write_inventory.ts";
import { print } from "./lib/print.ts";

const EDGE_FILES = [
  "supabase/functions/api/index.ts",
  "supabase/functions/api/http.ts",
  "supabase/functions/api/rateLimit.ts",
  "supabase/functions/api/cache.ts",
  "supabase/functions/api/externalAccounts.ts",
  "supabase/functions/api/legal.ts",
  "supabase/functions/api/drills.ts",
  "supabase/functions/api/drillMedia.ts",
];

const CODE_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export interface Emitter {
  file: string;
  line: number;
  fn: string;
  via: string;
  status: number | null;
  statusExpr: string;
  code: string | null;
  message: string | null;
  /** Interpolated expressions inside a template message */
  interpolations: string[];
  /** message/body references something that looks like error detail */
  leaksDetail: boolean;
  /** serviceUnavailable(context) without a detail arg — nothing logged */
  noServerDetail: boolean;
}

export interface CatchSite {
  file: string;
  line: number;
  endLine: number;
  fn: string;
  kind: "catch-clause" | "promise-catch";
  binding: string | null;
  bindingUsed: boolean;
  logs: boolean;
  rethrows: boolean;
  returnsResponse: boolean;
  classification: "silent" | "fallback" | "logged" | "rethrow" | "responds";
  bodyPreview: string;
}

export interface FunctionMetric {
  file: string;
  name: string;
  line: number;
  endLine: number;
  lines: number;
  params: number;
  awaits: number;
  returns: number;
  maxDepth: number;
  branches: number;
}

interface ErrorishName {
  (name: string): boolean;
}

const errorish: ErrorishName = (name) =>
  /^(e|err|error|detail|cause|failure|reason|exc|ex)$/i.test(name) ||
  /(error|Error|detail|Detail|stack|cause)$/.test(name);

function templateParts(node: ts.Expression): { text: string; interpolations: string[] } | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { text: node.text, interpolations: [] };
  }
  if (ts.isTemplateExpression(node)) {
    const interpolations: string[] = [];
    let text = node.head.text;
    for (const span of node.templateSpans) {
      interpolations.push(span.expression.getText());
      text += `\${${span.expression.getText()}}${span.literal.text}`;
    }
    return { text, interpolations };
  }
  return null;
}

function mentionsErrorDetail(expr: ts.Node): boolean {
  let found = false;
  walk(expr, (n) => {
    if (found) return;
    if (ts.isIdentifier(n) && errorish(n.text)) {
      const isKey =
        (ts.isPropertyAssignment(n.parent) || ts.isShorthandPropertyAssignment(n.parent)) &&
        n.parent.name === n &&
        !ts.isShorthandPropertyAssignment(n.parent);
      if (!isKey) found = true;
    }
    if (
      ts.isPropertyAccessExpression(n) &&
      /^(message|stack|details|hint|code)$/.test(n.name.text)
    ) {
      // `.message` of anything that isn't a plain literal container
      if (!ts.isObjectLiteralExpression(n.expression)) found = true;
    }
  });
  return found;
}

function numericLiteral(node: ts.Expression | undefined): number | null {
  if (!node) return null;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  return null;
}

export function scanEmitters(src: SourceFile): Emitter[] {
  const out: Emitter[] = [];
  walk(src.sf, (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Response"
    ) {
      const init = node.arguments?.[1];
      let status: number | null = null;
      let statusExpr = "";
      if (init && ts.isObjectLiteralExpression(init)) {
        for (const p of init.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "status") {
            status = numericLiteral(p.initializer);
            statusExpr = p.initializer.getText();
          }
        }
      }
      const body = node.arguments?.[0];
      out.push({
        file: src.path,
        line: lineOf(src.sf, node),
        fn: enclosingNamedFunction(src.sf, node),
        via: "new Response",
        status,
        statusExpr,
        code: null,
        message: body ? body.getText().slice(0, 120) : null,
        interpolations: [],
        leaksDetail: body ? (status ?? 0) >= 500 && mentionsErrorDetail(body) : false,
        noServerDetail: false,
      });
      return;
    }
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : null;
    if (!name) return;
    const args = node.arguments;
    const push = (partial: Omit<Emitter, "file" | "line" | "fn">) =>
      out.push({
        file: src.path,
        line: lineOf(src.sf, node),
        fn: enclosingNamedFunction(src.sf, node),
        ...partial,
      });

    if (name === "errorJson" && args.length >= 2) {
      const status = numericLiteral(args[0]);
      const msg = templateParts(args[1]);
      push({
        via: name,
        status,
        statusExpr: args[0].getText(),
        code: null,
        message: msg?.text ?? args[1].getText(),
        interpolations: msg?.interpolations ?? [args[1].getText()],
        leaksDetail: (status ?? 500) >= 500 && mentionsErrorDetail(args[1]),
        noServerDetail: false,
      });
    } else if (name === "codedError" && args.length >= 3) {
      const status = numericLiteral(args[0]);
      const msg = templateParts(args[2]);
      push({
        via: name,
        status,
        statusExpr: args[0].getText(),
        code: stringLiteralValue(args[1]) ?? `<dynamic:${args[1].getText()}>`,
        message: msg?.text ?? args[2].getText(),
        interpolations: msg?.interpolations ?? [args[2].getText()],
        leaksDetail: (status ?? 500) >= 500 && mentionsErrorDetail(args[2]),
        noServerDetail: false,
      });
    } else if (name === "serviceUnavailable") {
      const ctx = templateParts(args[0]);
      push({
        via: name,
        status: 503,
        statusExpr: "503",
        code: null,
        message: ctx?.text ?? args[0]?.getText() ?? null,
        interpolations: ctx?.interpolations ?? (args[0] ? [args[0].getText()] : []),
        leaksDetail: args[0] ? mentionsErrorDetail(args[0]) : false,
        noServerDetail: args.length < 2,
      });
    } else if (name === "json" && args.length >= 2) {
      const status = numericLiteral(args[0]);
      if (status !== null && status >= 400) {
        let code: string | null = null;
        let message: string | null = null;
        let interpolations: string[] = [];
        walk(args[1], (n) => {
          if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) {
            if (n.name.text === "code")
              code = stringLiteralValue(n.initializer) ?? `<dynamic:${n.initializer.getText()}>`;
            if (n.name.text === "message") {
              const t = templateParts(n.initializer);
              message = t?.text ?? n.initializer.getText();
              interpolations = t?.interpolations ?? [n.initializer.getText()];
            }
          }
        });
        push({
          via: "json",
          status,
          statusExpr: args[0].getText(),
          code,
          message,
          interpolations,
          leaksDetail: status >= 500 && mentionsErrorDetail(args[1]),
          noServerDetail: false,
        });
      }
    } else if (name === "reject" && args.length === 3 && stringLiteralValue(args[1])) {
      const msg = templateParts(args[2]);
      push({
        via: "reject(perItem)",
        status: 200,
        statusExpr: "200",
        code: stringLiteralValue(args[1]),
        message: msg?.text ?? args[2].getText(),
        interpolations: msg?.interpolations ?? [args[2].getText()],
        leaksDetail: false,
        noServerDetail: false,
      });
    } else if (
      name === "push" &&
      ts.isPropertyAccessExpression(callee) &&
      callee.expression.getText() === "rejected"
    ) {
      const obj = args[0];
      if (obj && ts.isObjectLiteralExpression(obj)) {
        let code: string | null = null;
        let message: string | null = null;
        let interpolations: string[] = [];
        for (const p of obj.properties) {
          if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
          if (p.name.text === "code") code = stringLiteralValue(p.initializer);
          if (p.name.text === "message") {
            const t = templateParts(p.initializer);
            message = t?.text ?? p.initializer.getText();
            interpolations = t?.interpolations ?? [p.initializer.getText()];
          }
        }
        push({
          via: "rejected.push(perItem)",
          status: 200,
          statusExpr: "200",
          code,
          message,
          interpolations,
          leaksDetail: false,
          noServerDetail: false,
        });
      }
    }
  });
  return out;
}

export function scanCatches(src: SourceFile): CatchSite[] {
  const out: CatchSite[] = [];
  const classify = (
    node: ts.Node,
    body: ts.Node,
    kind: CatchSite["kind"],
    binding: string | null,
  ) => {
    let logs = false;
    let rethrows = false;
    let returnsResponse = false;
    let bindingUsed = false;
    walk(body, (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const recv = n.expression.expression.getText();
        if (recv === "console" || /log|logger|captureAccessLog|logJson/.test(recv)) logs = true;
      }
      if (ts.isThrowStatement(n)) rethrows = true;
      if (ts.isReturnStatement(n) && n.expression) {
        const t = n.expression.getText();
        if (/errorJson|codedError|serviceUnavailable|json\(|new Response|Response/.test(t))
          returnsResponse = true;
      }
      if (binding && ts.isIdentifier(n) && n.text === binding && n !== body) bindingUsed = true;
    });
    // binding identifier declared in the clause itself is not a "use"
    if (kind === "catch-clause" && binding) {
      let uses = 0;
      walk(body, (n) => {
        if (ts.isIdentifier(n) && n.text === binding) uses += 1;
      });
      bindingUsed = uses > 0;
    }
    let classification: CatchSite["classification"] = "silent";
    if (rethrows) classification = "rethrow";
    else if (returnsResponse) classification = "responds";
    else if (logs) classification = "logged";
    else {
      let hasStatements = false;
      if (ts.isBlock(body)) hasStatements = body.statements.length > 0;
      else hasStatements = true;
      classification = hasStatements ? "fallback" : "silent";
    }
    const preview = body.getText().replace(/\s+/g, " ").slice(0, 160);
    out.push({
      file: src.path,
      line: lineOf(src.sf, node),
      endLine: endLineOf(src.sf, node),
      fn: enclosingNamedFunction(src.sf, node),
      kind,
      binding,
      bindingUsed,
      logs,
      rethrows,
      returnsResponse,
      classification,
      bodyPreview: preview,
    });
  };
  walk(src.sf, (node) => {
    if (ts.isCatchClause(node)) {
      const binding =
        node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)
          ? node.variableDeclaration.name.text
          : null;
      classify(node, node.block, "catch-clause", binding);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch" &&
      node.arguments[0] &&
      (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
    ) {
      const fn = node.arguments[0];
      const binding =
        fn.parameters[0] && ts.isIdentifier(fn.parameters[0].name)
          ? fn.parameters[0].name.text
          : null;
      classify(node, fn.body, "promise-catch", binding);
    }
  });
  return out;
}

/** Statements that start a promise-returning chain without awaiting or
 * binding it (fire-and-forget). Heuristic: expression statement whose call
 * chain contains fetch/.from(/.rpc(/.then( and no await. */
export function scanFloatingPromises(
  src: SourceFile,
): Array<{ file: string; line: number; fn: string; text: string }> {
  const out: Array<{ file: string; line: number; fn: string; text: string }> = [];
  walk(src.sf, (node) => {
    if (!ts.isExpressionStatement(node)) return;
    const e = node.expression;
    if (ts.isAwaitExpression(e) || ts.isVoidExpression(e)) return;
    if (!ts.isCallExpression(e)) return;
    const text = e.getText();
    if (/\.(from|rpc)\(|^fetch\(|\.then\(/.test(text) && !/\.catch\(/.test(text)) {
      out.push({
        file: src.path,
        line: lineOf(src.sf, node),
        fn: enclosingNamedFunction(src.sf, node),
        text: text.slice(0, 160),
      });
    }
  });
  return out;
}

export function scanFunctions(src: SourceFile): FunctionMetric[] {
  const out: FunctionMetric[] = [];
  const measure = (node: ts.SignatureDeclaration & { body?: ts.Node }, name: string) => {
    if (!node.body) return;
    let awaits = 0;
    let returns = 0;
    let branches = 0;
    let maxDepth = 0;
    const depthWalk = (n: ts.Node, depth: number) => {
      let next = depth;
      if (
        ts.isIfStatement(n) ||
        ts.isForStatement(n) ||
        ts.isForOfStatement(n) ||
        ts.isForInStatement(n) ||
        ts.isWhileStatement(n) ||
        ts.isDoStatement(n) ||
        ts.isSwitchStatement(n) ||
        ts.isTryStatement(n) ||
        ts.isConditionalExpression(n) ||
        ts.isCatchClause(n)
      ) {
        branches += 1;
        next = depth + 1;
        if (next > maxDepth) maxDepth = next;
      }
      if (ts.isCaseClause(n)) branches += 1;
      if (ts.isAwaitExpression(n)) awaits += 1;
      if (ts.isReturnStatement(n)) returns += 1;
      // Do not descend into nested functions: they get their own metric.
      if (
        n !== node &&
        (ts.isFunctionDeclaration(n) ||
          ts.isFunctionExpression(n) ||
          ts.isArrowFunction(n) ||
          ts.isMethodDeclaration(n))
      ) {
        return;
      }
      ts.forEachChild(n, (c) => depthWalk(c, next));
    };
    depthWalk(node.body, 0);
    const line = lineOf(src.sf, node);
    const endLine = endLineOf(src.sf, node);
    out.push({
      file: src.path,
      name,
      line,
      endLine,
      lines: endLine - line + 1,
      params: node.parameters.length,
      awaits,
      returns,
      maxDepth,
      branches,
    });
  };
  walk(src.sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) measure(node, node.name.text);
    else if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isVariableDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name)
    ) {
      measure(node, node.parent.name.text);
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name))
      measure(node, node.name.text);
  });
  return out;
}

export interface StructureFacts {
  totalLines: Record<string, number>;
  routeCases: Array<{ route: string; line: number }>;
  unsafeCasts: Array<{ file: string; line: number; text: string }>;
  anyUsages: Array<{ file: string; line: number; text: string }>;
  lintSuppressions: Array<{ file: string; line: number; text: string }>;
  moduleMutableState: Array<{ file: string; line: number; text: string }>;
  envReads: Array<{ file: string; line: number; name: string }>;
}

export function scanStructure(sources: SourceFile[]): StructureFacts {
  const facts: StructureFacts = {
    totalLines: {},
    routeCases: [],
    unsafeCasts: [],
    anyUsages: [],
    lintSuppressions: [],
    moduleMutableState: [],
    envReads: [],
  };
  for (const src of sources) {
    facts.totalLines[src.path] = src.text.split("\n").length;
    const lines = src.text.split("\n");
    lines.forEach((l, i) => {
      if (/deno-lint-ignore|@ts-ignore|@ts-expect-error|eslint-disable/.test(l)) {
        facts.lintSuppressions.push({ file: src.path, line: i + 1, text: l.trim().slice(0, 120) });
      }
    });
    walk(src.sf, (node) => {
      if (ts.isCaseClause(node) && src.path.endsWith("index.ts")) {
        const v = stringLiteralValue(node.expression);
        if (v && /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD) \//.test(v)) {
          facts.routeCases.push({ route: v, line: lineOf(src.sf, node) });
        }
      }
      if (
        ts.isAsExpression(node) &&
        ts.isAsExpression(node.expression) &&
        node.expression.type.kind === ts.SyntaxKind.UnknownKeyword
      ) {
        facts.unsafeCasts.push({
          file: src.path,
          line: lineOf(src.sf, node),
          text: node.getText().replace(/\s+/g, " ").slice(0, 120),
        });
      }
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        facts.anyUsages.push({
          file: src.path,
          line: lineOf(src.sf, node),
          text: node.parent.getText().replace(/\s+/g, " ").slice(0, 120),
        });
      }
      if (
        ts.isVariableStatement(node) &&
        node.parent === src.sf &&
        (node.declarationList.flags & ts.NodeFlags.Let) !== 0
      ) {
        facts.moduleMutableState.push({
          file: src.path,
          line: lineOf(src.sf, node),
          text: node.getText().replace(/\s+/g, " ").slice(0, 120),
        });
      }
      if (
        ts.isVariableStatement(node) &&
        node.parent === src.sf &&
        /new (Map|Set)\(/.test(node.getText()) &&
        !/^const [A-Z_]+ = new Set\(\[/.test(node.getText().trim())
      ) {
        facts.moduleMutableState.push({
          file: src.path,
          line: lineOf(src.sf, node),
          text: node.getText().replace(/\s+/g, " ").slice(0, 120),
        });
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.getText() === "Deno.env.get" &&
        node.arguments[0]
      ) {
        facts.envReads.push({
          file: src.path,
          line: lineOf(src.sf, node),
          name: stringLiteralValue(node.arguments[0]) ?? node.arguments[0].getText(),
        });
      }
    });
  }
  return facts;
}

/** Dotted error codes the mobile app compares `.code` against, and codes it
 * constructs itself (client-local taxonomy). */
export function scanMobileCodes(): {
  compared: Array<{ file: string; line: number; code: string }>;
  constructed: Set<string>;
} {
  const compared: Array<{ file: string; line: number; code: string }> = [];
  const constructed = new Set<string>();
  const root = repoPath("apps/mobile/src");
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of Deno.readDirSync(dir)) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        visit(p);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        files.push(p);
      }
    }
  };
  visit(root);
  for (const abs of files) {
    const text = Deno.readTextFileSync(abs);
    const rel = abs.slice(repoPath("").length);
    const sf = ts.createSourceFile(
      rel,
      text,
      ts.ScriptTarget.ES2022,
      true,
      abs.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    walk(sf, (node) => {
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
      ) {
        for (const [side, other] of [
          [node.left, node.right],
          [node.right, node.left],
        ] as const) {
          const lit = stringLiteralValue(side);
          if (lit && CODE_RE.test(lit) && /\bcode\b/.test(other.getText())) {
            compared.push({ file: rel, line: lineOf(sf, node), code: lit });
          }
        }
      }
      // Client-local taxonomy: codes the app constructs (`new XError('a.b')`,
      // `{ code: 'a.b' }`) or declares in a string-literal union type.
      if (ts.isNewExpression(node) && node.arguments) {
        for (const a of node.arguments) {
          const lit = stringLiteralValue(a);
          if (lit && CODE_RE.test(lit)) constructed.add(lit);
        }
      }
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "code"
      ) {
        const v = stringLiteralValue(node.initializer);
        if (v && CODE_RE.test(v)) constructed.add(v);
      }
      if (
        ts.isLiteralTypeNode(node) &&
        ts.isStringLiteral(node.literal) &&
        CODE_RE.test(node.literal.text)
      ) {
        constructed.add(node.literal.text);
      }
      if (ts.isCallExpression(node) && /Error|fail|reject|throw/i.test(node.expression.getText())) {
        for (const a of node.arguments) {
          const lit = stringLiteralValue(a);
          if (lit && CODE_RE.test(lit)) constructed.add(lit);
        }
      }
      // Sets of codes the client treats as a taxonomy, e.g. TRANSIENT_SYNC_REJECTION_CODES.
      if (
        ts.isNewExpression(node) &&
        node.expression.getText() === "Set" &&
        node.arguments?.[0] &&
        ts.isArrayLiteralExpression(node.arguments[0])
      ) {
        for (const el of node.arguments[0].elements) {
          const lit = stringLiteralValue(el);
          if (lit && CODE_RE.test(lit))
            compared.push({ file: rel, line: lineOf(sf, el), code: lit });
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        /_CODE$|_REJECTION$/.test(node.name.text)
      ) {
        const lit = stringLiteralValue(node.initializer);
        if (lit && CODE_RE.test(lit))
          compared.push({ file: rel, line: lineOf(sf, node), code: lit });
      }
    });
  }
  return { compared, constructed };
}

/** Codes minted by the iOS native module (PickleNative Swift sources) and
 * surfaced to JS through the capture bridge, e.g. camera.import_too_long. */
export function scanNativeBridgeCodes(): Set<string> {
  const out = new Set<string>();
  const root = repoPath("apps/mobile/ios/LocalPods");
  const visit = (dir: string) => {
    for (const entry of Deno.readDirSync(dir)) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory) visit(p);
      else if (entry.name.endsWith(".swift")) {
        for (const m of Deno.readTextFileSync(p).matchAll(/"([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)"/g))
          out.add(m[1]);
      }
    }
  };
  try {
    visit(root);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return out;
}

/** Error codes minted inside SQL functions (RPC rejections such as
 * shot.session_not_found travel through apply_synced_shot → route → app). */
export function scanMigrationCodes(): Array<{ file: string; line: number; code: string }> {
  const out: Array<{ file: string; line: number; code: string }> = [];
  const dir = repoPath("supabase/migrations");
  const names = [...Deno.readDirSync(dir)]
    .map((e) => e.name)
    .filter((n) => n.endsWith(".sql"))
    .sort();
  const SCHEMA_PREFIX =
    /^(public|auth|extensions|pg_catalog|net|cron|vault|storage|realtime|graphql_public|supabase_functions|pg_temp)\./;
  for (const name of names) {
    const lines = Deno.readTextFileSync(`${dir}/${name}`).split("\n");
    lines.forEach((l, i) => {
      for (const m of l.matchAll(/'([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)'/g)) {
        if (!SCHEMA_PREFIX.test(m[1]))
          out.push({ file: `supabase/migrations/${name}`, line: i + 1, code: m[1] });
      }
    });
  }
  return out;
}

export interface Check {
  id: string;
  pass: boolean;
  summary: string;
  details: unknown;
}

export function runScan() {
  const sources = EDGE_FILES.map(loadSource);
  const emitters = sources.flatMap(scanEmitters);
  const catches = sources.flatMap(scanCatches);
  const floating = sources.flatMap(scanFloatingPromises);
  const functions = sources.flatMap(scanFunctions).sort((a, b) => b.lines - a.lines);
  const structure = scanStructure(sources);
  const accesses = inventory();
  const mobile = scanMobileCodes();
  const sqlCodes = scanMigrationCodes();
  const nativeCodes = scanNativeBridgeCodes();

  const serverCodes = new Map<string, Set<number>>();
  for (const e of emitters) {
    if (!e.code || e.code.startsWith("<dynamic")) continue;
    const set = serverCodes.get(e.code) ?? new Set<number>();
    if (e.status !== null) set.add(e.status);
    serverCodes.set(e.code, set);
  }
  for (const c of sqlCodes) {
    // RPC rejections surface either per-item (200) or as the route's coded
    // 4xx; the SQL side does not fix an HTTP status.
    if (!serverCodes.has(c.code)) serverCodes.set(c.code, new Set<number>());
  }
  const fiveXx = emitters.filter((e) => (e.status ?? 0) >= 500);
  const fiveXxLeaks = fiveXx.filter((e) => e.leaksDetail);
  const dynamicStatus = emitters.filter((e) => e.status === null && e.via !== "new Response");
  const badCodes = [...serverCodes.keys()].filter((c) => !CODE_RE.test(c));
  const codeStatusConflicts = [...serverCodes.entries()]
    .filter(([, statuses]) => statuses.size > 1 && !(statuses.size === 2 && statuses.has(200)))
    .map(([code, statuses]) => ({ code, statuses: [...statuses].sort() }));
  const uncoded4xx = emitters.filter(
    (e) => e.status !== null && e.status >= 400 && e.status < 500 && !e.code,
  );
  const interpolated4xx = emitters.filter(
    (e) => e.status !== null && e.status >= 400 && e.interpolations.length > 0,
  );

  const comparedCodes = [...new Set(mobile.compared.map((c) => c.code))].sort();
  const serverCodeSet = new Set(serverCodes.keys());
  const clientCodesUnknownToServer = comparedCodes.filter(
    (c) => !serverCodeSet.has(c) && !mobile.constructed.has(c) && !nativeCodes.has(c),
  );
  const serverCodesUnreferencedByClient = [...serverCodeSet]
    .filter((c) => !comparedCodes.includes(c))
    .sort();

  const silentCatches = catches.filter((c) => c.classification === "silent");
  // An empty catch whose block carries a comment is a documented fall-through
  // (cache miss on corrupt entry etc.); an empty catch with NO comment is the
  // failure mode this check exists for.
  const undocumentedSilent = silentCatches.filter((c) => !/\/\/|\/\*/.test(c.bodyPreview));
  const fallbackCatches = catches.filter((c) => c.classification === "fallback");
  const unusedBindings = catches.filter((c) => c.binding && !c.bindingUsed);
  const unboundWrites = accesses.filter((a) => !a.resultBound && a.op !== "select");
  const uncheckedWrites = accesses.filter(
    (a) => a.resultBound && !a.errorChecked && a.op !== "select",
  );
  const noDetail503 = emitters.filter((e) => e.noServerDetail);

  const checks: Check[] = [
    {
      id: "5xx_no_error_detail_in_body",
      pass: fiveXxLeaks.length === 0,
      summary: `${fiveXx.length} 5xx emitters; ${fiveXxLeaks.length} interpolate error-derived values into the body`,
      details: fiveXxLeaks,
    },
    {
      id: "status_literal_everywhere",
      pass: dynamicStatus.length === 0,
      summary: `${dynamicStatus.length} emitters use a non-literal status`,
      details: dynamicStatus,
    },
    {
      id: "code_format_namespace_dot_snake",
      pass: badCodes.length === 0,
      summary: `${serverCodes.size} distinct server codes; ${badCodes.length} malformed`,
      details: badCodes,
    },
    {
      id: "code_to_status_stable",
      pass: codeStatusConflicts.length === 0,
      summary: `${codeStatusConflicts.length} codes emitted with more than one HTTP status`,
      details: codeStatusConflicts,
    },
    {
      id: "client_compared_codes_exist_on_server",
      pass: clientCodesUnknownToServer.length === 0,
      summary: `${comparedCodes.length} codes compared by apps/mobile; ${clientCodesUnknownToServer.length} neither emitted by the edge fn/SQL nor constructed client-side/native`,
      details: { unknownToServer: clientCodesUnknownToServer, compared: mobile.compared },
    },
    {
      id: "no_undocumented_silent_catch",
      pass: undocumentedSilent.length === 0,
      summary: `${catches.length} catch sites; ${silentCatches.length} silent (empty body), ${undocumentedSilent.length} of those without an explanatory comment`,
      details: {
        undocumented: undocumentedSilent,
        documented: silentCatches.filter((c) => !undocumentedSilent.includes(c)),
      },
    },
    {
      id: "no_floating_db_or_fetch_promise",
      pass: floating.length === 0,
      summary: `${floating.length} fire-and-forget promise statements`,
      details: floating,
    },
    {
      id: "every_db_write_result_inspected",
      pass: unboundWrites.length === 0 && uncheckedWrites.length === 0,
      summary: `${accesses.filter((a) => a.op !== "select").length} write/rpc calls; ${unboundWrites.length} discard the result entirely, ${uncheckedWrites.length} bind it but never read .error`,
      details: { unbound: unboundWrites, unchecked: uncheckedWrites },
    },
    {
      id: "service_unavailable_always_logs_detail",
      pass: noDetail503.length === 0,
      summary: `${noDetail503.length} serviceUnavailable(...) calls pass no detail, so the operator log carries only the context label`,
      details: noDetail503,
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    files: EDGE_FILES,
    pass: checks.every((c) => c.pass),
    checks,
    taxonomy: {
      serverCodes: Object.fromEntries(
        [...serverCodes.entries()].map(([k, v]) => [k, [...v].sort()]),
      ),
      uncoded4xxCount: uncoded4xx.length,
      uncoded4xx: uncoded4xx.map((e) => ({
        file: e.file,
        line: e.line,
        status: e.status,
        message: e.message,
      })),
      interpolated4xx: interpolated4xx.map((e) => ({
        file: e.file,
        line: e.line,
        status: e.status,
        code: e.code,
        message: e.message,
        interpolations: e.interpolations,
      })),
      serverCodesUnreferencedByClient,
      clientConstructedCodes: [...mobile.constructed].sort(),
      nativeBridgeCodes: [...nativeCodes].sort(),
      sqlCodes,
    },
    emitters,
    catches,
    swallowed: { silent: silentCatches, fallback: fallbackCatches, unusedBindings },
    structure: {
      ...structure,
      routeCount: structure.routeCases.length,
      functionsOver100Lines: functions.filter((f) => f.lines > 100),
      functionsDepthOver4: functions.filter((f) => f.maxDepth > 4),
      top15: functions.slice(0, 15),
      functionCount: functions.length,
    },
  };
}

if (import.meta.main) {
  const outIdx = Deno.args.indexOf("--out");
  const report = runScan();
  const text = JSON.stringify(report, null, 2);
  if (outIdx >= 0 && Deno.args[outIdx + 1]) {
    Deno.writeTextFileSync(Deno.args[outIdx + 1], text);
  } else {
    print(text);
  }
  const summary = report.checks
    .map((c) => `${c.pass ? "PASS" : "FAIL"} ${c.id}: ${c.summary}`)
    .join("\n");
  console.error(summary);
  Deno.exit(report.pass ? 0 : 1);
}
