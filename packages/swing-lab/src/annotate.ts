import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { CHECKPOINTS, SHOT_TYPES } from "@pickle/shared-types";
import {
  ANNOTATION_SCHEMA_VERSION,
  validateAnnotation,
  type SwingAnnotation,
} from "./annotationSchema.js";

/**
 * Local annotation server. Serves capture bundles (clip + form) to a browser
 * on localhost and writes one annotation JSON per annotator per bundle.
 * No accounts, no network beyond loopback — this is a lab bench tool.
 *
 *   pnpm annotate <bundles-dir> [port]
 */

const rootDir = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 4741);

function listBundles(): string[] {
  return readdirSync(rootDir)
    .filter((name) => {
      const dir = join(rootDir, name);
      return (
        statSync(dir).isDirectory() &&
        readdirSync(dir).some((file) => /^clip\.(mp4|mov)$/i.test(file))
      );
    })
    .sort();
}

function clipPath(bundle: string): string | null {
  const dir = join(rootDir, bundle);
  const clip = readdirSync(dir).find((file) => /^clip\.(mp4|mov)$/i.test(file));
  return clip ? join(dir, clip) : null;
}

function annotationsFor(bundle: string): Record<string, SwingAnnotation> {
  const dir = join(rootDir, bundle, "annotation");
  if (!existsSync(dir)) return {};
  const out: Record<string, SwingAnnotation> = {};
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as SwingAnnotation;
      out[parsed.annotatorId ?? file] = parsed;
    } catch {
      // Unreadable annotation files are surfaced by their absence.
    }
  }
  return out;
}

/** Reject any path that escapes the bundles root. */
function safeBundle(name: string): string | null {
  const candidate = normalize(name);
  if (candidate.includes("..") || candidate.includes("/") || candidate.includes("\\")) return null;
  return existsSync(join(rootDir, candidate)) ? candidate : null;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${port}`);
  try {
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(pageHtml());
      return;
    }
    if (url.pathname === "/api/bundles") {
      const bundles = listBundles().map((bundle) => ({
        bundle,
        annotators: Object.keys(annotationsFor(bundle)),
      }));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ bundles, checkpoints: CHECKPOINTS, strokes: SHOT_TYPES }));
      return;
    }
    if (url.pathname === "/api/clip") {
      const bundle = safeBundle(url.searchParams.get("bundle") ?? "");
      const path = bundle ? clipPath(bundle) : null;
      if (!path) {
        response.writeHead(404);
        response.end();
        return;
      }
      const stats = statSync(path);
      response.writeHead(200, {
        "content-type": path.endsWith(".mov") ? "video/quicktime" : "video/mp4",
        "content-length": stats.size,
      });
      response.end(readFileSync(path));
      return;
    }
    if (url.pathname === "/api/annotation" && request.method === "GET") {
      const bundle = safeBundle(url.searchParams.get("bundle") ?? "");
      const annotator = url.searchParams.get("annotator") ?? "";
      if (!bundle || !annotator) {
        response.writeHead(400);
        response.end();
        return;
      }
      const existing = annotationsFor(bundle)[annotator] ?? null;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(existing));
      return;
    }
    if (url.pathname === "/api/annotation" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        try {
          const incoming = JSON.parse(body) as SwingAnnotation;
          const bundle = safeBundle(incoming.captureBundle);
          const problems = validateAnnotation(incoming);
          if (!bundle) problems.push("unknown bundle");
          if (!/^[a-z0-9_-]{2,32}$/i.test(incoming.annotatorId ?? "")) {
            problems.push("annotatorId must be 2-32 filename-safe chars");
          }
          if (problems.length > 0) {
            response.writeHead(422, { "content-type": "application/json" });
            response.end(JSON.stringify({ problems }));
            return;
          }
          const dir = join(rootDir, bundle!, "annotation");
          mkdirSync(dir, { recursive: true });
          const filePath = join(dir, `${incoming.annotatorId}.json`);
          const previous = existsSync(filePath)
            ? (JSON.parse(readFileSync(filePath, "utf8")) as SwingAnnotation)
            : null;
          const revision = (previous?.revision ?? 0) + 1;
          const record: SwingAnnotation = {
            ...incoming,
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            revision,
            createdAtIso: previous?.createdAtIso ?? new Date().toISOString(),
            history: [
              ...(previous?.history ?? []),
              { revision, savedAtIso: new Date().toISOString() },
            ],
          };
          writeFileSync(filePath, JSON.stringify(record, null, 2));
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ saved: true, revision }));
        } catch (error) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ problems: [String(error)] }));
        }
      });
      return;
    }
    response.writeHead(404);
    response.end();
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`annotation bench: http://127.0.0.1:${port}  (bundles: ${rootDir})`);
  console.log(`bundles found: ${listBundles().length}`);
});

function pageHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>swing-lab annotation bench</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px -apple-system, sans-serif; background: #101613; color: #e8f0ea; margin: 0; display: grid; grid-template-columns: 300px 1fr 420px; height: 100vh; }
  #bundles { border-right: 1px solid #263229; overflow-y: auto; padding: 12px; }
  #bundles h2, #form h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #9fb3a6; }
  .bundle { padding: 8px 10px; border-radius: 8px; cursor: pointer; margin-bottom: 4px; }
  .bundle:hover { background: #1a241e; }
  .bundle.active { background: #223428; }
  .done { color: #8fd694; font-size: 12px; }
  #main { display: flex; flex-direction: column; padding: 12px; gap: 8px; }
  video { width: 100%; max-height: 70vh; background: #000; border-radius: 10px; }
  #controls { display: flex; gap: 8px; flex-wrap: wrap; }
  button { background: #223428; border: 1px solid #35533f; border-radius: 8px; padding: 6px 10px; cursor: pointer; color: #d9eadd; }
  button:hover { background: #2b4433; }
  #form { border-left: 1px solid #263229; overflow-y: auto; padding: 12px; }
  label { display: block; margin: 10px 0 4px; color: #b9c9bd; }
  select, input[type=text], input[type=number], textarea { width: 100%; background: #16201a; border: 1px solid #2c3b31; color: #e8f0ea; border-radius: 6px; padding: 6px; }
  .mark { display: grid; grid-template-columns: 1fr auto auto; gap: 6px; align-items: center; margin-bottom: 4px; }
  .mark span.value { font-variant-numeric: tabular-nums; color: #8fd694; }
  .cp { display: grid; grid-template-columns: 1fr 70px; gap: 6px; align-items: center; margin-bottom: 3px; }
  .fault { display: grid; grid-template-columns: 1fr 60px 1fr auto; gap: 6px; margin-bottom: 4px; }
  #save { width: 100%; margin-top: 14px; padding: 10px; font-weight: 600; background: #2e5b3a; }
  #status { margin-top: 8px; min-height: 20px; color: #8fd694; }
  #status.err { color: #e08a8a; white-space: pre-wrap; }
</style></head>
<body>
  <div id="bundles"><h2>Bundles</h2><div id="bundleList"></div></div>
  <div id="main">
    <video id="video" controls muted playsinline></video>
    <div id="controls">
      <button data-rate="0.25">0.25×</button><button data-rate="0.5">0.5×</button><button data-rate="1">1×</button>
      <button data-step="-10">-10f</button><button data-step="-5">-5f</button><button data-step="-1">-1f</button>
      <button data-step="1">+1f</button><button data-step="5">+5f</button><button data-step="10">+10f</button>
      <span id="time" style="align-self:center;color:#8fd694;font-variant-numeric:tabular-nums"></span>
      <span style="align-self:center;color:#6f8577;font-size:11px">keys: ←/→ ±1 · shift ±5 · alt ±10 · space play</span>
    </div>
  </div>
  <div id="form">
    <h2>Annotation</h2>
    <label>Annotator id</label><input id="annotator" type="text" placeholder="coach_a">
    <label>Stroke</label><select id="stroke"></select>
    <label>Handedness</label><select id="handedness"><option>right</option><option>left</option><option>unsure</option></select>
    <label>Analyzable footage?</label><select id="analyzable"><option value="true">yes</option><option value="false">no</option></select>
    <input id="notAnalyzableReason" type="text" placeholder="why not (if no)">
    <label>Phase boundaries (click Mark at the moment)</label>
    <div id="marks"></div>
    <label>Contact uncertainty</label>
    <select id="contactUnc">
      <option value="">unset</option><option value="exact">exact</option>
      <option value="plus_minus_1">±1 frame</option><option value="plus_minus_2">±2 frames</option>
      <option value="uncertain">uncertain</option>
    </select>
    <label>Object labels (pause, pick target, click the video)</label>
    <div style="display:flex;gap:6px;align-items:center">
      <select id="labelTarget" style="width:90px">
        <option value="paddle">paddle</option>
        <option value="ball">ball</option>
      </select>
      <select id="labelVis" style="flex:1"></select>
      <button id="markNoPoint" title="record a no-point visibility at current time">Mark</button>
    </div>
    <div id="paddleList" style="max-height:110px;overflow-y:auto;font-size:12px;margin-top:4px"></div>
    <div id="ballList" style="max-height:110px;overflow-y:auto;font-size:12px;margin-top:4px;color:#e8d9a0"></div>
    <label>Checkpoint scores (0-100, blank = not assessable)</label>
    <div id="cps"></div>
    <label>Overall technique (0-100)</label><input id="overall" type="number" min="0" max="100">
    <label>Faults</label>
    <div id="faults"></div>
    <button id="addFault">+ add fault</button>
    <label>Annotator confidence (0-1)</label><input id="conf" type="number" min="0" max="1" step="0.05" value="0.8">
    <label>Notes</label><textarea id="notes" rows="3"></textarea>
    <button id="save">Save annotation</button>
    <div id="status"></div>
  </div>
<script>
const MARKS = [
  ["preparationStartMs", "preparation start"],
  ["accelerationStartMs", "acceleration start"],
  ["contactMs", "contact"],
  ["followThroughEndMs", "follow-through end"],
];
let CHECKPOINTS = [], STROKES = [], current = null;
const marks = {}, state = { faults: [], paddleFrames: [], ballFrames: [] };
const $ = (id) => document.getElementById(id);
const video = $("video");
const VIS_OPTIONS = {
  paddle: ["visible", "occluded", "absent"],
  ball: ["visible", "occluded", "not_visible", "uncertain"],
};

function refreshVisOptions() {
  const target = $("labelTarget").value;
  $("labelVis").innerHTML = VIS_OPTIONS[target]
    .map((v, i) => \`<option value="\${v}"\${i === 0 ? " selected" : ""}>\${v}\${v === "visible" ? " (click video)" : ""}</option>\`)
    .join("");
}

function framesFor(target) {
  return target === "ball" ? state.ballFrames : state.paddleFrames;
}

function renderLabelLists() {
  for (const target of ["paddle", "ball"]) {
    const el = $(target === "ball" ? "ballList" : "paddleList");
    el.innerHTML = framesFor(target)
      .slice()
      .sort((a, b) => a.tMs - b.tMs)
      .map((frame, index) =>
        \`<div>\${target[0]} \${frame.tMs}ms · \${frame.visibility}\${frame.point ? \` @ (\${frame.point.x.toFixed(3)}, \${frame.point.y.toFixed(3)})\` : ""} <a href="#" data-del="\${target}:\${index}">✕</a></div>\`)
      .join("");
  }
  document.querySelectorAll("[data-del]").forEach((el) =>
    el.addEventListener("click", (event) => {
      event.preventDefault();
      const [target, index] = el.dataset.del.split(":");
      framesFor(target)
        .sort((a, b) => a.tMs - b.tMs)
        .splice(Number(index), 1);
      renderLabelLists();
    }));
}

function addLabelFrame(target, frame) {
  const frames = framesFor(target);
  // One label per timestamp: replace an existing label within 20ms.
  const existing = frames.findIndex((entry) => Math.abs(entry.tMs - frame.tMs) < 20);
  if (existing >= 0) frames.splice(existing, 1);
  frames.push(frame);
  renderLabelLists();
}

function stepFrames(count) {
  video.pause();
  video.currentTime = Math.max(0, video.currentTime + count / 30);
}

async function boot() {
  const data = await (await fetch("/api/bundles")).json();
  CHECKPOINTS = data.checkpoints; STROKES = data.strokes;
  $("stroke").innerHTML = [...STROKES, "not_a_pickleball_stroke", "unsure"]
    .map((s) => \`<option>\${s}</option>\`).join("");
  $("cps").innerHTML = CHECKPOINTS.map((c) =>
    \`<div class="cp"><span>\${c}</span><input type="number" min="0" max="100" data-cp="\${c}"></div>\`).join("");
  $("marks").innerHTML = MARKS.map(([key, label]) =>
    \`<div class="mark"><span>\${label}</span><span class="value" id="mark-\${key}">—</span><button data-mark="\${key}">Mark</button></div>\`).join("");
  $("bundleList").innerHTML = data.bundles.map((b) =>
    \`<div class="bundle" data-bundle="\${b.bundle}">\${b.bundle}<div class="done">\${b.annotators.length ? "✓ " + b.annotators.join(", ") : ""}</div></div>\`).join("");
  document.querySelectorAll(".bundle").forEach((el) =>
    el.addEventListener("click", () => select(el.dataset.bundle)));
  document.querySelectorAll("[data-mark]").forEach((el) =>
    el.addEventListener("click", () => {
      marks[el.dataset.mark] = Math.round(video.currentTime * 1000);
      $("mark-" + el.dataset.mark).textContent = marks[el.dataset.mark] + "ms";
    }));
  document.querySelectorAll("[data-rate]").forEach((el) =>
    el.addEventListener("click", () => { video.playbackRate = Number(el.dataset.rate); }));
  document.querySelectorAll("[data-step]").forEach((el) =>
    el.addEventListener("click", () => stepFrames(Number(el.dataset.step))));
  document.addEventListener("keydown", (event) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    const step = event.altKey ? 10 : event.shiftKey ? 5 : 1;
    if (event.key === "ArrowLeft") { event.preventDefault(); stepFrames(-step); }
    else if (event.key === "ArrowRight") { event.preventDefault(); stepFrames(step); }
    else if (event.key === " ") { event.preventDefault(); video.paused ? video.play() : video.pause(); }
  });
  refreshVisOptions();
  $("labelTarget").addEventListener("change", refreshVisOptions);
  video.addEventListener("timeupdate", () => { $("time").textContent = Math.round(video.currentTime * 1000) + "ms"; });
  // Object labeling: click the paused video to place a visible point in
  // normalized video coordinates (letterboxing accounted for).
  video.addEventListener("click", (event) => {
    if (!video.paused || $("labelVis").value !== "visible" || !video.videoWidth) return;
    const rect = video.getBoundingClientRect();
    const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
    const drawnW = video.videoWidth * scale, drawnH = video.videoHeight * scale;
    const offsetX = (rect.width - drawnW) / 2, offsetY = (rect.height - drawnH) / 2;
    const x = (event.clientX - rect.left - offsetX) / drawnW;
    const y = (event.clientY - rect.top - offsetY) / drawnH;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    addLabelFrame($("labelTarget").value, {
      tMs: Math.round(video.currentTime * 1000),
      point: { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) },
      visibility: "visible",
    });
  });
  $("markNoPoint").addEventListener("click", () => {
    const visibility = $("labelVis").value;
    if (visibility === "visible") return; // visible labels come from video clicks
    addLabelFrame($("labelTarget").value, {
      tMs: Math.round(video.currentTime * 1000), point: null, visibility,
    });
  });
  $("addFault").addEventListener("click", addFaultRow);
  $("save").addEventListener("click", save);
  const first = data.bundles[0]; if (first) select(first.bundle);
}

function addFaultRow(prefill) {
  const row = document.createElement("div");
  row.className = "fault";
  row.innerHTML = \`<select class="f-cp">\${CHECKPOINTS.map((c) => \`<option>\${c}</option>\`).join("")}</select>
    <select class="f-sev"><option>1</option><option>2</option><option>3</option></select>
    <input class="f-note" type="text" placeholder="note"><button class="f-del">✕</button>\`;
  row.querySelector(".f-del").addEventListener("click", () => row.remove());
  if (prefill) {
    row.querySelector(".f-cp").value = prefill.checkpoint;
    row.querySelector(".f-sev").value = String(prefill.severity);
    row.querySelector(".f-note").value = prefill.note ?? "";
  }
  $("faults").appendChild(row);
}

async function select(bundle) {
  current = bundle;
  document.querySelectorAll(".bundle").forEach((el) =>
    el.classList.toggle("active", el.dataset.bundle === bundle));
  video.src = "/api/clip?bundle=" + encodeURIComponent(bundle);
  Object.keys(marks).forEach((key) => delete marks[key]);
  MARKS.forEach(([key]) => { $("mark-" + key).textContent = "—"; });
  $("faults").innerHTML = "";
  state.paddleFrames = [];
  state.ballFrames = [];
  renderLabelLists();
  const annotator = $("annotator").value.trim();
  if (annotator) {
    const existing = await (await fetch(\`/api/annotation?bundle=\${encodeURIComponent(bundle)}&annotator=\${encodeURIComponent(annotator)}\`)).json();
    if (existing) hydrate(existing);
  }
}

function hydrate(a) {
  $("stroke").value = a.stroke; $("handedness").value = a.handedness;
  $("analyzable").value = String(a.analyzable);
  $("notAnalyzableReason").value = a.notAnalyzableReason ?? "";
  $("overall").value = a.overallScore ?? ""; $("conf").value = a.annotatorConfidence;
  $("notes").value = a.notes ?? "";
  for (const [key] of MARKS) {
    if (a.phases?.[key] != null) { marks[key] = a.phases[key]; $("mark-" + key).textContent = a.phases[key] + "ms"; }
  }
  document.querySelectorAll("[data-cp]").forEach((el) => {
    const value = a.checkpointScores?.[el.dataset.cp];
    el.value = value == null ? "" : value;
  });
  (a.faults ?? []).forEach(addFaultRow);
  state.paddleFrames = a.paddleFrames ?? [];
  state.ballFrames = a.ballFrames ?? [];
  if (a.contactUncertainty) $("contactUnc").value = a.contactUncertainty;
  renderLabelLists();
}

async function save() {
  const checkpointScores = {};
  document.querySelectorAll("[data-cp]").forEach((el) => {
    checkpointScores[el.dataset.cp] = el.value === "" ? null : Number(el.value);
  });
  const faults = [...document.querySelectorAll(".fault")].map((row) => ({
    checkpoint: row.querySelector(".f-cp").value,
    severity: Number(row.querySelector(".f-sev").value),
    note: row.querySelector(".f-note").value,
  }));
  const body = {
    schemaVersion: 1,
    captureBundle: current,
    annotatorId: $("annotator").value.trim(),
    createdAtIso: new Date().toISOString(),
    revision: 0,
    stroke: $("stroke").value,
    handedness: $("handedness").value,
    analyzable: $("analyzable").value === "true",
    notAnalyzableReason: $("notAnalyzableReason").value || null,
    phases: Object.fromEntries(MARKS.map(([key]) => [key, marks[key] ?? null])),
    faults,
    contactUncertainty: $("contactUnc").value || null,
    paddleFrames: state.paddleFrames,
    ballFrames: state.ballFrames,
    checkpointScores,
    overallScore: $("overall").value === "" ? null : Number($("overall").value),
    annotatorConfidence: Number($("conf").value),
    notes: $("notes").value,
    history: [],
  };
  const response = await fetch("/api/annotation", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  const status = $("status");
  if (response.ok) {
    status.className = ""; status.textContent = "saved (revision " + result.revision + ")"; boot();
  } else {
    status.className = "err"; status.textContent = (result.problems ?? ["save failed"]).join("\\n");
  }
}
boot();
</script></body></html>`;
}
