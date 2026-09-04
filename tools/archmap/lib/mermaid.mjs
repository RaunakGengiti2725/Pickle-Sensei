// Mermaid renderers for the extracted model. Output is deterministic (sorted).

function mid(name) {
  return name.replace(/[^A-Za-z0-9]/g, "_");
}

function esc(label) {
  return label.replace(/"/g, "'");
}

/** Package dependency graph grouped by kind (apps / services / packages / tools). */
export function renderPackageGraph(model) {
  const lines = ["flowchart LR"];
  const byKind = {};
  for (const [name, node] of Object.entries(model.workspaces.nodes))
    (byKind[node.kind] ??= []).push(name);
  for (const kind of Object.keys(byKind).sort()) {
    lines.push(`  subgraph ${kind}s`);
    for (const name of byKind[kind].sort()) {
      const node = model.workspaces.nodes[name];
      const tag = node.manager === "npm" ? " (npm)" : "";
      lines.push(`    ${mid(name)}["${esc(name)}${tag}"]`);
    }
    lines.push("  end");
  }
  const seen = new Set();
  for (const [name, node] of Object.entries(model.workspaces.nodes).sort()) {
    const declared = new Set(Object.keys(node.workspaceDeps));
    const observed = new Set(Object.keys(model.imports[name]?.imports ?? {}));
    for (const dep of [...new Set([...declared, ...observed])].sort()) {
      if (!(dep in model.workspaces.nodes)) continue;
      const key = `${name}->${dep}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const style =
        declared.has(dep) && observed.has(dep) ? "-->" : declared.has(dep) ? "-.->" : "==>";
      lines.push(`  ${mid(name)} ${style} ${mid(dep)}`);
    }
  }
  lines.push(
    "  %% solid = declared+imported, dotted = declared only, thick = imported but NOT declared",
  );
  return lines.join("\n");
}

/** Runtime/system diagram: mobile → edge fn → Supabase/RevenueCat/Apple; legacy stack aside. */
export function renderRuntimeGraph(model) {
  const edgeRouteCount = model.routes.edge.routes.length;
  const legacyRouteCount = model.routes.legacy.length;
  const mobileCallCount = Object.keys(model.routes.mobileClientCalls).length;
  const lines = [
    "flowchart TB",
    "  subgraph device[iPhone]",
    '    mobile["apps/mobile (React Native, npm)"]',
    '    pod["PickleNative pod (LocalPods, symlinks → native/)"]',
    '    vision["native/vision-core (Apple Vision pose)"]',
    '    camera["native/camera-engine"]',
    "    mobile --> pod --> camera --> vision",
    "  end",
    "  subgraph shipping_backend[Production backend]",
    `    edge["supabase/functions/api (Deno edge fn, ${edgeRouteCount} /v1 routes)"]`,
    '    pg["Supabase Postgres + RLS (supabase/migrations)"]',
    '    auth["Supabase Auth"]',
    '    upstash["Upstash Redis (optional L2 cache/rate limit)"]',
    "    edge --> pg",
    "    edge --> auth",
    "    edge -.-> upstash",
    "  end",
    "  subgraph external[External platforms]",
    '    rc["RevenueCat"]',
    '    apple["Apple: Sign in with Apple, StoreKit, App Store Connect"]',
    '    google["Google Sign-In"]',
    "  end",
    `  mobile -- "${mobileCallCount} distinct /v1 paths" --> edge`,
    "  mobile --> rc",
    "  mobile --> apple",
    "  mobile --> google",
    "  edge --> rc",
    "  edge --> apple",
    "  subgraph legacy[Legacy / local-only (NOT called by the app)]",
    `    fastify["services/api (Fastify, ${legacyRouteCount} routes)"]`,
    '    worker["services/media-worker"]',
    '    adminweb["apps/admin-web (Vite)"]',
    '    localpg["docker-compose Postgres 5432/5433 + Redis + ElasticMQ"]',
    '    legacymig["packages/database/migrations"]',
    "    adminweb --> fastify --> localpg",
    "    worker --> localpg",
    "    legacymig --> localpg",
    "  end",
    "  subgraph verification[Verification planes]",
    '    ci["ci.yml → scripts/verify-cloud.sh (Linux)"]',
    '    mac["mac-full-verify.yml → scripts/mac-full-verify.sh (ONE self-hosted M4)"]',
    '    smoke["mac-smoke-test.yml (manual, duplicate env probe)"]',
    "    smoke -.-> mac",
    "  end",
  ];
  return lines.join("\n");
}

/** Critical paths as one sequence-like flowchart per path. */
export function renderCriticalPaths(model) {
  const lines = ["flowchart LR"];
  for (const p of model.criticalPaths.paths) {
    lines.push(`  subgraph ${mid(p.id)}["${esc(p.title)}"]`);
    let prev = null;
    p.hops.forEach((hop, i) => {
      const a = `${mid(p.id)}_${i}a`;
      const b = `${mid(p.id)}_${i}b`;
      if (!prev) lines.push(`    ${a}["${esc(hop.from)}"]`);
      lines.push(`    ${b}["${esc(hop.to)}"]`);
      lines.push(`    ${prev ?? a} -- "${hop.plane}" --> ${b}`);
      prev = b;
    });
    lines.push("  end");
  }
  return lines.join("\n");
}

/** Workflow → script → stage graph. */
export function renderWorkflowGraph(model) {
  const lines = ["flowchart LR"];
  for (const [wf, w] of Object.entries(model.workflows).sort()) {
    const id = mid(wf);
    lines.push(`  ${id}["${esc(wf)}\\n${esc(w.triggers.join(", "))}"]`);
    for (const [job, j] of Object.entries(w.jobs).sort()) {
      const jid = `${id}_${mid(job)}`;
      lines.push(`  ${jid}["${esc(job)}\\n${esc(j.runsOn ?? "?")}"]`);
      lines.push(`  ${id} --> ${jid}`);
      for (const n of j.needs) lines.push(`  ${id}_${mid(n)} --> ${jid}`);
      for (const r of j.scriptRefs) lines.push(`  ${jid} --> ${mid(r.path)}["${esc(r.path)}"]`);
    }
  }
  const vc = model.scripts["scripts/verify-cloud.sh"];
  if (vc) {
    for (const s of vc.stageArrays.ALL_STAGES ?? []) {
      const tier = (vc.stageArrays.PR_STAGES ?? []).includes(s) ? "pr+full" : "full only";
      lines.push(`  ${mid("scripts/verify-cloud.sh")} --> vc_${mid(s)}["stage ${s} (${tier})"]`);
    }
  }
  const mac = model.unverifiable.macOnlyStages;
  for (const s of mac)
    lines.push(
      `  ${mid("scripts/mac-full-verify.sh")} --> mac_${mid(s)}["stage ${s} (Apple only)"]`,
    );
  return lines.join("\n");
}

/** Env-var matrix as a Mermaid-free markdown table (docs-ready). */
export function renderEnvTable(model) {
  const rows = [
    "| Variable | Secret-like | Runtimes | Declared in | Consumers |",
    "|---|---|---|---|---|",
  ];
  for (const [name, v] of Object.entries(model.env)) {
    rows.push(
      `| \`${name}\` | ${v.isSecretLike ? "yes" : "no"} | ${v.runtimes.join(", ") || "—"} | ${v.declaredIn.length ? v.declaredIn.slice(0, 2).join("<br>") + (v.declaredIn.length > 2 ? ` (+${v.declaredIn.length - 2})` : "") : "—"} | ${v.consumers.length} |`,
    );
  }
  return rows.join("\n");
}

export function renderRouteTable(model) {
  const rows = [
    "| Route | Edge fn (prod) | services/api (legacy) | apps/mobile calls |",
    "|---|---|---|---|",
  ];
  const edge = new Map(model.routes.edge.routes.map((r) => [`${r.method} ${r.path}`, r]));
  const legacy = new Map(model.routes.legacy.map((r) => [`${r.method} ${r.path}`, r]));
  const mobile = new Set();
  for (const [p, call] of Object.entries(model.routes.mobileClientCalls))
    for (const m of call.methods) mobile.add(`${m} ${p}`);
  const all = [...new Set([...edge.keys(), ...legacy.keys(), ...mobile])].sort();
  for (const k of all) {
    rows.push(
      `| \`${k}\` | ${edge.has(k) ? "yes" : ""} | ${legacy.has(k) ? "yes" : ""} | ${mobile.has(k) ? "yes" : ""} |`,
    );
  }
  return rows.join("\n");
}
