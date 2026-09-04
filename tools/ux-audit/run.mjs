#!/usr/bin/env node
/**
 * Playwright driver for the pre-auth screen UX/a11y/i18n audit.
 *
 *   node build.mjs && node run.mjs [--only <regex>] [--no-extras]
 *        [--devices w320,w375] [--scales L,XXXL] [--out <dir>] [--run-id <id>]
 *
 * For every (scenario × device × scale) cell it renders the screen through
 * react-native-web in headless Chromium, drives the scenario's UI actions,
 * pulls the measured tree, runs analyze.mjs, and writes:
 *
 *   <out>/cases/<caseId>.json    measured tree + analysis + heap numbers
 *   <out>/shots/<caseId>.png     2x screenshot
 *   <out>/matrix.json            one row per cell (counts, violation rules)
 *   <out>/violations.json        every violation with its seed + node evidence
 *   <out>/summary.md             human-readable matrix
 *   <out>/run.log                driver log
 *
 * Layout evidence only: react-native-web ≠ UIKit. Anything this reports is a
 * reproducible layout fact of the RN component tree under these inputs, not
 * proof of iOS runtime behaviour.
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { analyze } from "./analyze.mjs";
import { caseId, DEVICES, SCALES, SCENARIOS, LONG_STRINGS } from "./scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1];
}
const only = flag("--only", null) ? new RegExp(flag("--only", null)) : null;
const includeExtras = !args.includes("--no-extras");
const runId = flag("--run-id", new Date().toISOString().replace(/[:.]/g, "-"));
const outDir = path.resolve(flag("--out", path.join(repoRoot, "artifacts", "ux-audit", runId)));
const headless = !args.includes("--headed");

fs.mkdirSync(path.join(outDir, "cases"), { recursive: true });
fs.mkdirSync(path.join(outDir, "shots"), { recursive: true });
const logPath = path.join(outDir, "run.log");
const logStream = fs.createWriteStream(logPath, { flags: "a" });
function log(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  logStream.write(`${stamped}\n`);
  process.stdout.write(`${stamped}\n`);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function serveRepo() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/tools/ux-audit/harness/index.html";
    const file = path.join(repoRoot, rel);
    if (!file.startsWith(repoRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function findChrome() {
  if (process.env.UX_AUDIT_CHROME) return process.env.UX_AUDIT_CHROME;
  for (const bin of ["google-chrome", "chromium", "chromium-browser", "google-chrome-stable"]) {
    try {
      return execSync(`command -v ${bin}`, { encoding: "utf8" }).trim();
    } catch {
      // try next
    }
  }
  throw new Error("No Chromium binary found; set UX_AUDIT_CHROME=/path/to/chrome");
}

async function drive(page, actions) {
  for (const action of actions) {
    if (action.type === "fill") {
      const input = page.locator(`[aria-label="${action.label}"]`).first();
      await input.click();
      await input.fill(action.value);
    } else if (action.type === "click") {
      await page.locator(`[aria-label="${action.label}"]`).first().click();
    } else if (action.type === "clickRole") {
      await page.locator(`[role="${action.role}"]`).nth(action.index).click();
    } else if (action.type === "wait") {
      // Real wall-clock wait for timer-driven product behaviour (splash
      // watchdog, exit fade) — the harness does not fake timers.
      await page.waitForTimeout(action.ms);
    } else {
      throw new Error(`unknown action ${JSON.stringify(action)}`);
    }
    // Let LockedScroll's onLayout/onContentSizeChange round-trip settle.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60))),
        ),
    );
  }
}

async function main() {
  const server = await serveRepo();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const chromePath = findChrome();
  log(`chrome=${chromePath} base=${base} out=${outDir}`);
  log(`chrome version: ${execSync(`"${chromePath}" --version`, { encoding: "utf8" }).trim()}`);

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless,
    args: ["--enable-precise-memory-info", "--font-render-hinting=none", "--disable-lcd-text"],
  });

  const deviceFilter = flag("--devices", null)?.split(",");
  const scaleFilter = flag("--scales", null)?.split(",");
  const devices = DEVICES.filter((d) =>
    deviceFilter ? deviceFilter.includes(d.id) : includeExtras || !d.extra,
  );
  const scales = SCALES.filter((s) =>
    scaleFilter ? scaleFilter.includes(s.id) : includeExtras || !s.extra,
  );
  const scenarios = SCENARIOS.filter((s) => !only || only.test(s.id));
  const matrix = [];
  const allViolations = [];
  const errors = [];
  const started = Date.now();

  for (const device of devices) {
    const context = await browser.newContext({
      viewport: { width: device.width, height: device.height },
      deviceScaleFactor: 2,
      hasTouch: true,
      locale: "en-US",
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        consoleErrors.push(`${msg.type()}: ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await page.goto(`${base}/`, { waitUntil: "load" });
    await page.waitForFunction(() => typeof window.__ux !== "undefined");

    for (const scenario of scenarios) {
      for (const scale of scales) {
        const id = caseId(scenario, device, scale);
        if (only && !only.test(id) && !only.test(scenario.id)) continue;
        consoleErrors.length = 0;
        const seed = {
          caseId: id,
          scenario: scenario.id,
          scenarioNote: scenario.note ?? null,
          device: device.id,
          viewport: { width: device.width, height: device.height },
          insets: device.insets,
          scale: scale.id,
          fontScale: scale.fontScale,
          render: scenario.render,
          drive: scenario.drive,
          extra: Boolean(device.extra || scale.extra),
        };
        const t0 = Date.now();
        let snapshot = null;
        let analysis = null;
        let error = null;
        let events = [];
        let calls = [];
        let heap = null;
        try {
          await page.evaluate(
            ({ render, fontScale, insets }) => window.__ux.render({ ...render, fontScale, insets }),
            { render: scenario.render, fontScale: scale.fontScale, insets: device.insets },
          );
          await drive(page, scenario.drive);
          snapshot = await page.evaluate(() => window.__ux.measure());
          const pageErrors = consoleErrors.filter(
            (e) => e.startsWith("pageerror:") || e.startsWith("error:"),
          );
          if (pageErrors.length > 0) {
            throw new Error(
              `render raised ${pageErrors.length} error(s): ${pageErrors[0].slice(0, 300)}`,
            );
          }
          if (snapshot.nodes.length < 5) {
            throw new Error(`render produced only ${snapshot.nodes.length} nodes`);
          }
          events = await page.evaluate(() => window.__ux.events());
          calls = await page.evaluate(() => window.__ux.calls());
          analysis = analyze(snapshot);
          if (scenario.expectEvents) {
            const want = JSON.stringify(scenario.expectEvents);
            const got = JSON.stringify(events);
            if (want !== got) {
              analysis.violations.push({
                rule: "expected-events",
                severity: "P1",
                node: null,
                detail: `screen callbacks ${got} but scenario expects ${want}`,
              });
            }
          }
          const metrics = await cdp.send("Performance.getMetrics");
          const pick = (name) => metrics.metrics.find((m) => m.name === name)?.value ?? null;
          heap = {
            jsHeapUsedBytes: pick("JSHeapUsedSize"),
            jsHeapTotalBytes: pick("JSHeapTotalSize"),
            domNodes: pick("Nodes"),
            layoutCount: pick("LayoutCount"),
            recalcStyleCount: pick("RecalcStyleCount"),
          };
          await page.screenshot({ path: path.join(outDir, "shots", `${id}.png`) });
        } catch (err) {
          error = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
          errors.push({ caseId: id, error });
          try {
            await page.screenshot({ path: path.join(outDir, "shots", `${id}.ERROR.png`) });
          } catch {
            // ignore
          }
        }
        const durationMs = Date.now() - t0;
        const record = {
          seed,
          durationMs,
          error,
          consoleErrors: [...consoleErrors],
          events,
          calls,
          heap,
          snapshot,
          analysis,
        };
        fs.writeFileSync(path.join(outDir, "cases", `${id}.json`), JSON.stringify(record, null, 1));
        const violations = analysis?.violations ?? [];
        for (const v of violations) allViolations.push({ ...seed, ...v });
        const ruleCounts = {};
        for (const v of violations) ruleCounts[v.rule] = (ruleCounts[v.rule] ?? 0) + 1;
        matrix.push({
          caseId: id,
          scenario: scenario.id,
          device: device.id,
          scale: scale.id,
          fontScale: scale.fontScale,
          extra: seed.extra,
          error: error ? error.split("\n")[0] : null,
          consoleErrors: consoleErrors.length,
          nodes: analysis?.counts.nodes ?? null,
          controls: analysis?.counts.controls ?? null,
          fontsReady: snapshot?.fontsReady ?? null,
          heapUsedMB: heap?.jsHeapUsedBytes ? +(heap.jsHeapUsedBytes / 1048576).toFixed(1) : null,
          durationMs,
          ruleCounts,
        });
        log(
          `${id} ${error ? "ERROR" : "ok"} ${durationMs}ms violations=${violations.length} ${JSON.stringify(ruleCounts)}`,
        );
      }
    }
    await context.close();
  }
  await browser.close();
  server.close();

  const rules = [...new Set(allViolations.map((v) => v.rule))].sort();
  const byRule = Object.fromEntries(
    rules.map((r) => [r, allViolations.filter((v) => v.rule === r).length]),
  );
  const summary = {
    runId,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    commit: execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim(),
    chrome: execSync(`"${chromePath}" --version`, { encoding: "utf8" }).trim(),
    node: process.version,
    cells: matrix.length,
    cellsWithErrors: errors.length,
    scenarios: scenarios.map((s) => s.id),
    devices: devices.map((d) => ({ id: d.id, ...d })),
    scales: scales.map((s) => ({ id: s.id, fontScale: s.fontScale, extra: Boolean(s.extra) })),
    longStrings: LONG_STRINGS,
    violationsByRule: byRule,
    errors,
  };
  fs.writeFileSync(path.join(outDir, "matrix.json"), JSON.stringify(matrix, null, 1));
  fs.writeFileSync(path.join(outDir, "violations.json"), JSON.stringify(allViolations, null, 1));
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, "summary.md"), renderSummary(summary, matrix, allViolations));
  log(
    `done cells=${matrix.length} errors=${errors.length} violations=${allViolations.length} out=${outDir}`,
  );
  logStream.end();
  process.exitCode = errors.length > 0 ? 1 : 0;
}

function renderSummary(summary, matrix, violations) {
  const lines = [];
  lines.push(`# UX audit run ${summary.runId}`);
  lines.push("");
  lines.push(`commit ${summary.commit} · ${summary.chrome} · node ${summary.node}`);
  lines.push(
    `${summary.cells} cells, ${summary.cellsWithErrors} harness errors, ${violations.length} violations`,
  );
  lines.push("");
  lines.push("## Violations by rule");
  lines.push("");
  lines.push("| rule | count |");
  lines.push("| --- | ---: |");
  for (const [rule, count] of Object.entries(summary.violationsByRule)) {
    lines.push(`| ${rule} | ${count} |`);
  }
  lines.push("");
  lines.push("## Matrix (scenario × device × scale → violations by rule; `-` = clean)");
  lines.push("");
  const devices = [...new Set(matrix.map((m) => m.device))];
  const scales = [...new Set(matrix.map((m) => m.scale))];
  lines.push(
    `| scenario | ${devices.flatMap((d) => scales.map((s) => `${d}/${s}`)).join(" | ")} |`,
  );
  lines.push(`| --- | ${devices.flatMap(() => scales.map(() => "---")).join(" | ")} |`);
  for (const scenario of [...new Set(matrix.map((m) => m.scenario))]) {
    const cells = devices.flatMap((d) =>
      scales.map((s) => {
        const row = matrix.find((m) => m.scenario === scenario && m.device === d && m.scale === s);
        if (!row) return "";
        if (row.error) return "ERR";
        const parts = Object.entries(row.ruleCounts)
          .filter(([rule]) => rule !== "below-fold")
          .map(([rule, n]) => `${rule.replace(/[a-z-]+?-/g, (m) => m[0] + "-")}:${n}`);
        return parts.length ? parts.join(" ") : "-";
      }),
    );
    lines.push(`| ${scenario} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Heap (JSHeapUsedSize MB after measure, per cell)");
  lines.push("");
  lines.push("| caseId | heapUsedMB | domNodes | durationMs |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const row of matrix) {
    lines.push(
      `| ${row.caseId} | ${row.heapUsedMB ?? ""} | ${row.nodes ?? ""} | ${row.durationMs} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 2;
});
