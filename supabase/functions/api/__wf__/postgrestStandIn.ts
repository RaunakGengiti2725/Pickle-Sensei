// A minimal PostgREST stand-in for the read side of a table: applies `order`,
// `limit`, `offset` and the `or=(…)` logic tree PostgREST accepts (comparisons
// + nested and/or, quoted values with backslash escapes), clamps `limit` to a
// configurable `maxRows` exactly like PostgREST's db-max-rows does (silently,
// with HTTP 200), and throws on any grammar it does not understand so a
// malformed filter string produced by the edge fn fails the test instead of
// being ignored. Used by the routes harness (so paged reads see the page they
// asked for, not the whole table again) and by the pagination pins.

export type StandInRow = Record<string, unknown>;
type Comparison = { kind: "cmp"; column: string; op: "lt" | "gt" | "eq"; value: string };
type LogicNode =
  Comparison | { kind: "and"; children: LogicNode[] } | { kind: "or"; children: LogicNode[] };

class LogicParser {
  private index = 0;
  constructor(private readonly input: string) {}

  static parse(input: string): LogicNode {
    const parser = new LogicParser(input);
    const node = parser.tree();
    if (parser.index !== input.length) {
      throw new Error(`trailing input in logic tree: ${input.slice(parser.index)}`);
    }
    return node;
  }

  private tree(): LogicNode {
    const identifier = this.identifier();
    if (identifier === "and" || identifier === "or") {
      this.expect("(");
      const children: LogicNode[] = [this.tree()];
      while (this.peek() === ",") {
        this.index += 1;
        children.push(this.tree());
      }
      this.expect(")");
      return identifier === "and" ? { kind: "and", children } : { kind: "or", children };
    }
    this.expect(".");
    const op = this.identifier();
    if (op !== "lt" && op !== "gt" && op !== "eq") throw new Error(`unsupported operator ${op}`);
    this.expect(".");
    return { kind: "cmp", column: identifier, op, value: this.value() };
  }

  private identifier(): string {
    const match = /^[a-z_][a-z0-9_]*/.exec(this.input.slice(this.index));
    if (!match) throw new Error(`identifier expected at ${this.index} in ${this.input}`);
    this.index += match[0].length;
    return match[0];
  }

  private value(): string {
    if (this.peek() !== '"') {
      const match = /^[^,)]*/.exec(this.input.slice(this.index));
      this.index += match![0].length;
      return match![0];
    }
    this.index += 1;
    let out = "";
    for (;;) {
      const char = this.input[this.index];
      if (char === undefined) throw new Error("unterminated quoted value");
      this.index += 1;
      if (char === '"') break;
      if (char === "\\") {
        out += this.input[this.index];
        this.index += 1;
        continue;
      }
      out += char;
    }
    const next = this.peek();
    if (next !== undefined && next !== "," && next !== ")") {
      throw new Error(`quoted value must be followed by , or ) at ${this.index}`);
    }
    return out;
  }

  private peek(): string | undefined {
    return this.input[this.index];
  }

  private expect(char: string): void {
    if (this.peek() !== char) {
      throw new Error(`expected ${char} at ${this.index} in ${this.input}`);
    }
    this.index += 1;
  }
}

function matches(row: StandInRow, node: LogicNode): boolean {
  if (node.kind === "and") return node.children.every((child) => matches(row, child));
  if (node.kind === "or") return node.children.some((child) => matches(row, child));
  const actual = String(row[node.column]);
  if (node.op === "eq") return actual === node.value;
  if (node.op === "lt") return actual < node.value;
  return actual > node.value;
}

export interface StandInOptions {
  /** PostgREST `db-max-rows`: every page is clamped to it, silently, with 200. */
  maxRows?: number;
}

/** True when the request asks for a page (`limit`) or carries a logic filter —
 * the reads the stand-in must answer faithfully rather than with the table. */
export function isPagedSelect(url: URL): boolean {
  return url.searchParams.has("limit") || url.searchParams.has("or");
}

export function postgrestSelect<Row extends StandInRow>(
  url: URL,
  table: readonly Row[],
  options: StandInOptions = {},
): Row[] {
  let rows: Row[] = [...table];
  const logic = url.searchParams.get("or");
  if (logic !== null) {
    const node = LogicParser.parse(`or${logic}`);
    rows = rows.filter((row) => matches(row, node));
  }
  const orderTerms = (url.searchParams.get("order") ?? "").split(",").filter(Boolean);
  if (orderTerms.length > 0) {
    const terms = orderTerms.map((term) => {
      const [column, direction] = term.split(".");
      if (direction !== "asc" && direction !== "desc") throw new Error(`bad order term ${term}`);
      return { column, descending: direction === "desc" };
    });
    rows.sort((a, b) => {
      for (const term of terms) {
        const left = String(a[term.column]);
        const right = String(b[term.column]);
        if (left === right) continue;
        const cmp = left < right ? -1 : 1;
        return term.descending ? -cmp : cmp;
      }
      return 0;
    });
  }
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limitParam = url.searchParams.get("limit");
  const requested = limitParam === null ? Number.POSITIVE_INFINITY : Number(limitParam);
  const limit = Math.min(requested, options.maxRows ?? Number.POSITIVE_INFINITY);
  return rows.slice(offset, Number.isFinite(limit) ? offset + limit : undefined);
}
