// Shared TypeScript-AST helpers for the static-health audit harness.
// The edge function is parsed with the real TypeScript parser (npm:typescript)
// so call chains such as `authed.db.from("x").upsert({...}, {...})` are read
// structurally, never with regexes over source text.

import ts from "typescript";

export { ts };

export const REPO_ROOT = new URL("../../../../", import.meta.url);

export interface SourceFile {
  /** Repo-relative path, e.g. supabase/functions/api/index.ts */
  path: string;
  text: string;
  sf: ts.SourceFile;
}

export function repoPath(relative: string): string {
  return new URL(relative, REPO_ROOT).pathname;
}

export function loadSource(relative: string): SourceFile {
  const text = Deno.readTextFileSync(repoPath(relative));
  const sf = ts.createSourceFile(relative, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  return { path: relative, text, sf };
}

export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

export function endLineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Flatten `a.b(c).d(e)` into ordered segments: [{name:"a"},{name:"b",args},...]. */
export interface ChainSegment {
  name: string;
  call: ts.CallExpression | null;
}

export function flattenChain(expr: ts.Expression): ChainSegment[] {
  const segments: ChainSegment[] = [];
  let current: ts.Expression = expr;
  for (;;) {
    if (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        segments.unshift({ name: callee.name.text, call: current });
        current = callee.expression;
        continue;
      }
      if (ts.isIdentifier(callee)) {
        segments.unshift({ name: callee.text, call: current });
        break;
      }
      break;
    }
    if (ts.isPropertyAccessExpression(current)) {
      segments.unshift({ name: current.name.text, call: null });
      current = current.expression;
      continue;
    }
    if (ts.isIdentifier(current)) {
      segments.unshift({ name: current.text, call: null });
      break;
    }
    if (current.kind === ts.SyntaxKind.ThisKeyword) {
      segments.unshift({ name: "this", call: null });
      break;
    }
    break;
  }
  return segments;
}

export function stringLiteralValue(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** Enclosing function-like declaration for a node (or null at module scope). */
export function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

export function enclosingNamedFunction(sf: ts.SourceFile, node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
    current = current.parent;
  }
  return `<module>@${lineOf(sf, node)}`;
}

/** Object literal keys (string keys of `{ a: 1, "b": 2, c }`; spreads and
 * computed keys are reported so the caller can flag them as opaque). */
export interface ObjectShape {
  keys: string[];
  spreads: number;
  computed: number;
  /** For keys whose value is a string literal — used for enum-like columns. */
  literalValues: Record<string, string>;
}

export function objectShape(node: ts.Expression | undefined): ObjectShape | null {
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  const shape: ObjectShape = { keys: [], spreads: 0, computed: 0, literalValues: {} };
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) {
      shape.spreads += 1;
      continue;
    }
    if (ts.isPropertyAssignment(prop)) {
      if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) {
        shape.keys.push(prop.name.text);
        const lit = stringLiteralValue(prop.initializer);
        if (lit !== null) shape.literalValues[prop.name.text] = lit;
      } else if (ts.isComputedPropertyName(prop.name)) {
        shape.computed += 1;
      }
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      shape.keys.push(prop.name.text);
    }
  }
  return shape;
}

/** Track `const patch: Record<string, unknown> = {...}; patch.x = ...` so a
 * write that passes an identifier still yields its full key set. */
export function resolveIdentifierObject(
  sf: ts.SourceFile,
  fn: ts.Node,
  name: string,
): ObjectShape | null {
  let shape: ObjectShape | null = null;
  walk(fn, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      shape = objectShape(node.initializer);
    }
  });
  if (!shape) return null;
  const resolved: ObjectShape = shape;
  walk(fn, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === name
    ) {
      const key = node.left.name.text;
      if (!resolved.keys.includes(key)) resolved.keys.push(key);
      const lit = stringLiteralValue(node.right);
      if (lit !== null) resolved.literalValues[key] = lit;
    }
  });
  void sf;
  return resolved;
}
