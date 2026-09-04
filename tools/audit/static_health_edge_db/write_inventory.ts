// Static inventory of every database access the edge function performs
// (supabase/functions/api/*.ts): PostgREST table reads/writes with their
// exact payload columns, upsert resolution, the client they run as
// (user-scoped `authenticated` vs service role), and every RPC call.
//
// This is the left-hand side of the grant cross-check: grant_matrix.ts joins
// it against the privileges the migrations actually grant in a live Postgres.
//
//   deno run -A --no-check tools/audit/static_health_edge_db/write_inventory.ts \
//     [--out path.json]

import {
  enclosingFunction,
  enclosingNamedFunction,
  flattenChain,
  lineOf,
  loadSource,
  objectShape,
  resolveIdentifierObject,
  stringLiteralValue,
  ts,
  walk,
  type ObjectShape,
} from "./lib/ast.ts";
import { print } from "./lib/print.ts";

export type DbRole = "authenticated" | "service_role" | "unknown";
export type Operation = "select" | "insert" | "update" | "upsert" | "delete" | "rpc";

export interface DbAccess {
  file: string;
  line: number;
  fn: string;
  role: DbRole;
  /** Receiver expression as written, e.g. authed.db / adminDb / user.db */
  receiver: string;
  op: Operation;
  /** Table, view, or RPC function name */
  target: string;
  /** Payload columns for insert/update/upsert (empty for select/delete/rpc) */
  columns: string[];
  /** Columns named in a trailing .select("a, b") (read-back or read) */
  selectColumns: string[];
  /** Columns used in .eq/.in/.gte/.order/... filters (need SELECT) */
  filterColumns: string[];
  /** upsert only */
  upsert?: { onConflict: string | null; ignoreDuplicates: boolean };
  /** rpc only: argument keys */
  rpcArgs?: string[];
  /** Payload had spreads/computed keys we could not resolve statically */
  opaque: boolean;
  /** Result of the awaited call is bound to a variable / returned (false =
   * fire-and-forget statement whose `.error` can never be inspected) */
  resultBound: boolean;
  /** `.error` of the bound result is referenced later in the same function */
  errorChecked: boolean;
  literalValues: Record<string, string>;
}

const FILES = ["supabase/functions/api/index.ts", "supabase/functions/api/externalAccounts.ts"];

const FILTER_METHODS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
  "contains",
  "order",
  "not",
]);

const SERVICE_RECEIVERS = new Set(["adminDb", "billingAdminDb", "serviceDb", "admin"]);
const USER_RECEIVERS = new Set(["authed.db", "user.db", "db"]);

function roleOf(receiver: string): DbRole {
  if (USER_RECEIVERS.has(receiver)) return "authenticated";
  const head = receiver.split(".")[0];
  if (SERVICE_RECEIVERS.has(head) || receiver.includes("adminDb")) return "service_role";
  return "unknown";
}

function splitSelect(list: string): string[] {
  // "a, b, c" → [a,b,c]; embedded resources are not used by this function.
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(":").pop()!.trim());
}

/** Module-level `const NAME = "..."` string constants (e.g. PERMIT_COLUMNS). */
function moduleStringConstants(sf: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const value = stringLiteralValue(decl.initializer);
      if (value !== null) map.set(decl.name.text, value);
    }
  }
  return map;
}

/** Does `name.error` (or destructured `error`) appear in `scope` after `after`? */
function errorReferenced(scope: ts.Node, name: string, after: number): boolean {
  let found = false;
  walk(scope, (node) => {
    if (found || node.getStart() <= after) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name &&
      node.name.text === "error"
    ) {
      found = true;
    }
    // `if (!x)` / `x instanceof Response` on the whole result also counts
    // as inspecting the outcome when the call returns Response|data.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      found = true;
    }
  });
  return found;
}

export function inventory(): DbAccess[] {
  const out: DbAccess[] = [];
  for (const rel of FILES) {
    const src = loadSource(rel);
    const constants = moduleStringConstants(src.sf);
    walk(src.sf, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      if (!ts.isPropertyAccessExpression(callee)) return;
      const method = callee.name.text;
      if (method !== "from" && method !== "rpc") return;
      // Only consider the OUTERMOST chain that contains this .from/.rpc: walk
      // up through property/call parents to the full expression.
      let top: ts.Node = node;
      while (
        top.parent &&
        (ts.isPropertyAccessExpression(top.parent) || ts.isCallExpression(top.parent)) &&
        (ts.isCallExpression(top.parent)
          ? top.parent.expression === top
          : top.parent.expression === top)
      ) {
        top = top.parent;
      }
      const receiver = callee.expression.getText(src.sf);
      const segments = flattenChain(top as ts.Expression);
      const fromIdx = segments.findIndex((s) => s.name === method && s.call === node);
      const chain = segments.slice(fromIdx);
      const target =
        stringLiteralValue(node.arguments[0]) ?? `<dynamic:${node.arguments[0]?.getText(src.sf)}>`;
      const fnNode = enclosingFunction(node) ?? src.sf;

      const access: DbAccess = {
        file: rel,
        line: lineOf(src.sf, node),
        fn: enclosingNamedFunction(src.sf, node),
        role: roleOf(receiver),
        receiver,
        op: "select",
        target,
        columns: [],
        selectColumns: [],
        filterColumns: [],
        opaque: false,
        resultBound: false,
        errorChecked: false,
        literalValues: {},
      };

      if (method === "rpc") {
        access.op = "rpc";
        const args = objectShape(node.arguments[1]);
        access.rpcArgs = args?.keys ?? [];
      }

      for (const seg of chain.slice(1)) {
        if (!seg.call) continue;
        const arg0 = seg.call.arguments[0];
        if (seg.name === "insert" || seg.name === "update" || seg.name === "upsert") {
          access.op = seg.name;
          let shape: ObjectShape | null = objectShape(arg0);
          if (!shape && arg0 && ts.isIdentifier(arg0)) {
            shape = resolveIdentifierObject(src.sf, fnNode, arg0.text);
          }
          if (!shape && arg0 && ts.isArrayLiteralExpression(arg0)) {
            const keys = new Set<string>();
            let opaque = false;
            for (const el of arg0.elements) {
              const s = objectShape(el);
              if (!s) opaque = true;
              else for (const k of s.keys) keys.add(k);
            }
            shape = { keys: [...keys], spreads: opaque ? 1 : 0, computed: 0, literalValues: {} };
          }
          if (shape) {
            access.columns = shape.keys;
            access.opaque = shape.spreads > 0 || shape.computed > 0;
            access.literalValues = shape.literalValues;
          } else {
            access.opaque = true;
          }
          if (seg.name === "upsert") {
            const opts = objectShape(seg.call.arguments[1]);
            let onConflict: string | null = null;
            let ignoreDuplicates = false;
            if (seg.call.arguments[1] && ts.isObjectLiteralExpression(seg.call.arguments[1])) {
              for (const p of seg.call.arguments[1].properties) {
                if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
                if (p.name.text === "onConflict") onConflict = stringLiteralValue(p.initializer);
                if (p.name.text === "ignoreDuplicates") {
                  ignoreDuplicates = p.initializer.kind === ts.SyntaxKind.TrueKeyword;
                }
              }
            }
            void opts;
            access.upsert = { onConflict, ignoreDuplicates };
          }
        } else if (seg.name === "delete") {
          access.op = "delete";
        } else if (FILTER_METHODS.has(seg.name)) {
          const col = stringLiteralValue(arg0);
          if (col !== null && !access.filterColumns.includes(col)) access.filterColumns.push(col);
        } else if (seg.name === "select") {
          let list = stringLiteralValue(arg0);
          if (list === null && arg0 && ts.isIdentifier(arg0)) {
            list = constants.get(arg0.text) ?? null;
          }
          if (list !== null) access.selectColumns = splitSelect(list);
          else if (arg0) access.opaque = true;
        }
      }

      // Result binding: `const x = await chain` / `return chain` / part of
      // Promise.all destructuring / bare statement.
      let holder: ts.Node = top;
      while (
        holder.parent &&
        (ts.isAwaitExpression(holder.parent) || ts.isParenthesizedExpression(holder.parent))
      ) {
        holder = holder.parent;
      }
      const parent = holder.parent;
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        access.resultBound = true;
        access.errorChecked = errorReferenced(fnNode, parent.name.text, parent.getEnd());
      } else if (parent && ts.isReturnStatement(parent)) {
        access.resultBound = true;
        access.errorChecked = true; // caller inspects
      } else if (parent && ts.isArrowFunction(parent)) {
        access.resultBound = true;
        access.errorChecked = true; // wrapper (readAllRows page fn) inspects
      } else if (parent && ts.isArrayLiteralExpression(parent)) {
        // Promise.all([...]) → destructured names
        access.resultBound = true;
        const idx = parent.elements.indexOf(holder as ts.Expression);
        let decl: ts.Node | undefined = parent.parent;
        while (decl && !ts.isVariableDeclaration(decl)) decl = decl.parent;
        if (decl && ts.isVariableDeclaration(decl) && ts.isArrayBindingPattern(decl.name)) {
          const el = decl.name.elements[idx];
          if (el && ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
            access.errorChecked = errorReferenced(fnNode, el.name.text, decl.getEnd());
          }
        }
      } else if (parent && ts.isExpressionStatement(parent)) {
        access.resultBound = false;
        access.errorChecked = false;
      } else if (parent && ts.isBinaryExpression(parent)) {
        access.resultBound = true;
        access.errorChecked = true; // `x = await ...` — treat as bound; rare
      } else {
        access.resultBound = true;
        access.errorChecked = true; // conservative for shapes we do not model
      }
      out.push(access);
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

if (import.meta.main) {
  const outIdx = Deno.args.indexOf("--out");
  const rows = inventory();
  const report = {
    generatedAt: new Date().toISOString(),
    files: FILES,
    count: rows.length,
    byOp: Object.fromEntries(
      (["select", "insert", "update", "upsert", "delete", "rpc"] as Operation[]).map((op) => [
        op,
        rows.filter((r) => r.op === op).length,
      ]),
    ),
    byRole: Object.fromEntries(
      (["authenticated", "service_role", "unknown"] as DbRole[]).map((role) => [
        role,
        rows.filter((r) => r.role === role).length,
      ]),
    ),
    unboundResults: rows
      .filter((r) => !r.resultBound)
      .map((r) => `${r.file}:${r.line} ${r.op} ${r.target}`),
    uncheckedErrors: rows
      .filter((r) => r.resultBound && !r.errorChecked)
      .map((r) => `${r.file}:${r.line} ${r.op} ${r.target}`),
    accesses: rows,
  };
  const text = JSON.stringify(report, null, 2);
  if (outIdx >= 0 && Deno.args[outIdx + 1]) {
    Deno.writeTextFileSync(Deno.args[outIdx + 1], text);
    console.error(`wrote ${Deno.args[outIdx + 1]} (${rows.length} accesses)`);
  } else {
    print(text);
  }
}
