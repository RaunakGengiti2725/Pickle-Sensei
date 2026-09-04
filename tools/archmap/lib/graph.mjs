// Directed-graph algorithms used by the archmap invariants. Pure functions, no I/O.

/**
 * Tarjan strongly-connected components. `edges` is Map<node, Set<node>>.
 * Returns only components with >1 node or a self-loop (i.e. real cycles),
 * each sorted, and the list sorted, for deterministic output.
 */
export function findCycles(edges) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let counter = 0;
  const nodes = [...new Set([...edges.keys(), ...[...edges.values()].flatMap((s) => [...s])])];
  nodes.sort();

  const strongconnect = (v) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of [...(edges.get(v) ?? [])].sort()) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      const selfLoop = comp.length === 1 && (edges.get(v)?.has(v) ?? false);
      if (comp.length > 1 || selfLoop) sccs.push(comp.sort());
    }
  };
  for (const n of nodes) if (!index.has(n)) strongconnect(n);
  sccs.sort((a, b) => (a.join(",") < b.join(",") ? -1 : 1));
  return sccs;
}

/** Reverse-reachability: which nodes transitively depend on `target`. */
export function dependentsOf(edges, target) {
  const reverse = new Map();
  for (const [from, tos] of edges) {
    for (const to of tos) {
      if (!reverse.has(to)) reverse.set(to, new Set());
      reverse.get(to).add(from);
    }
  }
  const seen = new Set();
  const queue = [target];
  while (queue.length) {
    const n = queue.shift();
    for (const d of reverse.get(n) ?? []) {
      if (!seen.has(d)) {
        seen.add(d);
        queue.push(d);
      }
    }
  }
  seen.delete(target);
  return [...seen].sort();
}

/** Forward transitive closure from `start` (excluding start). */
export function reachableFrom(edges, start) {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const n = queue.shift();
    for (const d of edges.get(n) ?? []) {
      if (!seen.has(d)) {
        seen.add(d);
        queue.push(d);
      }
    }
  }
  seen.delete(start);
  return [...seen].sort();
}

/**
 * Articulation-style single points of failure relative to a set of roots:
 * a node X is a SPOF for root R if every path from R to some leaf/dependency
 * goes through X — approximated here as: removing X removes ≥1 node from R's
 * reachable set other than X itself. Returns [{node, roots:[...], severed:[...]}].
 */
export function singlePointsOfFailure(edges, roots) {
  const out = [];
  const allNodes = [...new Set([...edges.keys(), ...[...edges.values()].flatMap((s) => [...s])])];
  allNodes.sort();
  const baseline = new Map(roots.map((r) => [r, new Set(reachableFrom(edges, r))]));
  for (const x of allNodes) {
    if (roots.includes(x)) continue;
    const pruned = new Map();
    for (const [from, tos] of edges) {
      if (from === x) continue;
      pruned.set(from, new Set([...tos].filter((t) => t !== x)));
    }
    const hits = [];
    const severed = new Set();
    for (const r of roots) {
      if (!baseline.get(r).has(x)) continue;
      const after = new Set(reachableFrom(pruned, r));
      const lost = [...baseline.get(r)].filter((n) => n !== x && !after.has(n));
      if (lost.length > 0) {
        hits.push(r);
        for (const l of lost) severed.add(l);
      }
    }
    if (hits.length > 0) out.push({ node: x, roots: hits, severed: [...severed].sort() });
  }
  return out;
}

export function fanIn(edges) {
  const counts = new Map();
  for (const tos of edges.values()) for (const t of tos) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([node, count]) => ({ node, count }))
    .sort((a, b) => b.count - a.count || (a.node < b.node ? -1 : 1));
}

export function edgesToList(edges) {
  const list = [];
  for (const [from, tos] of edges) for (const to of tos) list.push({ from, to });
  list.sort((a, b) => (a.from + "→" + a.to < b.from + "→" + b.to ? -1 : 1));
  return list;
}
