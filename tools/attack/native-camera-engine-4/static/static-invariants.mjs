#!/usr/bin/env node
// Linux-plane static harness for native/camera-engine (adversarial tester #4).
//
// Pins the source invariants the mac XCTests rely on, by reading the exact
// production files at HEAD and checking anchored patterns at specific lines,
// then runs "probes" that model the bounds guard on the same arguments the
// XCTests use. This proves what the SOURCE says; it proves NOTHING about
// AVFoundation / XCTest runtime behaviour (that is the Mac's job).
//
//   node tools/attack/native-camera-engine-4/static/static-invariants.mjs [--out <dir>]
//
// Exit codes: 0 all invariants hold and no probe detects a defect;
//             1 an invariant the tests depend on no longer holds (harness is stale);
//             2 invariants hold AND at least one probe detects a defect (finding).
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const outIndex = process.argv.indexOf("--out");
const outDir = resolve(
  outIndex > 0
    ? process.argv[outIndex + 1]
    : `${root}/artifacts/attack/native-camera-engine-4/static`,
);
mkdirSync(outDir, { recursive: true });

const files = {
  engine: "native/camera-engine/Sources/CameraEngine.swift",
  coordinator: "native/camera-engine/Sources/SessionCaptureCoordinator.swift",
  guided: "apps/mobile/ios/LocalPods/PickleNative/Sources/GuidedCaptureViewController.swift",
  bridge: "apps/mobile/ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift",
  swingLab: "native/swing-lab/Sources/main.swift",
};
const src = Object.fromEntries(
  Object.entries(files).map(([k, p]) => [k, readFileSync(`${root}/${p}`, "utf8").split("\n")]),
);
const line = (f, n) => src[f][n - 1] ?? "";
const range = (f, a, b) => src[f].slice(a - 1, b).join("\n");

const invariants = [];
const check = (id, file, lineNo, pattern, note) => {
  const text = line(file, lineNo);
  const ok = pattern.test(text);
  invariants.push({ id, file: `${files[file]}:${lineNo}`, ok, text: text.trim(), note });
};
const checkRange = (id, file, a, b, pattern, note) => {
  const text = range(file, a, b);
  const ok = pattern.test(text);
  invariants.push({ id, file: `${files[file]}:${a}-${b}`, ok, note });
};

// ── Scenario 1: extract() guard order + bounds guard ───────────────────────
check(
  "S1.stopped-guard-first",
  "coordinator",
  196,
  /guard !isStopped else/,
  "alreadyStopped wins over everything",
);
check(
  "S1.notstarted-before-bounds",
  "coordinator",
  200,
  /guard let base, let url else/,
  "recordingNotStarted precedes bounds",
);
check(
  "S1.bounds-guard",
  "coordinator",
  204,
  /guard eventEndMs > eventStartMs else/,
  "the ONLY bounds guard",
);
check("S1.bounds-error", "coordinator", 205, /CoordinatorError\.invalidBounds/, "");
check(
  "S1.absolute-start-trapping-add",
  "coordinator",
  208,
  /let absoluteStartMs = base \+ eventStartMs/,
  "trapping + (Int overflow probe)",
);
check(
  "S1.queue-dispatch-after-guards",
  "coordinator",
  216,
  /extractionQueue\.async/,
  "queue is touched only after all guards",
);
checkRange(
  "S1.no-negative-start-guard",
  "coordinator",
  183,
  224,
  /^(?![\s\S]*eventStartMs\s*(<|>=)\s*0)[\s\S]*$/,
  "no `eventStartMs >= 0` / `< 0` check exists in extract()",
);

// ── Scenario 2/3: observer scoping + fallback strings ──────────────────────
checkRange(
  "S23.observers-installed-in-configure",
  "engine",
  223,
  269,
  /installObservers\(\)/,
  "observers exist only after a successful configure",
);
checkRange(
  "S23.observers-scoped-to-session",
  "engine",
  610,
  631,
  /object: session[\s\S]*object: session[\s\S]*object: session/,
  "three observers, all object: session",
);
checkRange(
  "S3.reason-string-describing",
  "engine",
  639,
  648,
  /reason = String\(describing: interruption\)[\s\S]*reason = "unknown"/,
  "",
);
checkRange(
  "S2.runtime-error-fallback",
  "engine",
  654,
  658,
  /\?\? "The camera session failed\."/,
  "nil-error fallback text",
);

// ── Scenario 4/9: startContinuousRecording guard order ─────────────────────
checkRange(
  "S49.not-running-first",
  "engine",
  527,
  551,
  /guard self\.session\.isRunning else[\s\S]*EngineError\.sessionNotRunning[\s\S]*guard !self\.movieOutput\.isRecording else[\s\S]*EngineError\.recordingAlreadyActive[\s\S]*fileExists\(atPath: url\.path\)[\s\S]*removeItem\(at: url\)[\s\S]*startRecording\(to: url, recordingDelegate: self\)/,
  "sessionNotRunning → recordingAlreadyActive → remove pre-existing file → start",
);

// ── Scenario 6: delegate success-key path ──────────────────────────────────
checkRange(
  "S6.success-key-keeps-file",
  "engine",
  727,
  749,
  /AVErrorRecordingSuccessfullyFinishedKey\] as\? Bool\) != true[\s\S]*removeItem\(at: outputFileURL\)[\s\S]*guard let first, let last, last > first else[\s\S]*removeItem\(at: outputFileURL\)[\s\S]*recordingFailed\("No valid camera frames were recorded\."\)[\s\S]*onRecordingFinished\?\(\.success\(/,
  "",
);
check(
  "S6.max-duration-from-config",
  "engine",
  249,
  /movieOutput\.maxRecordedDuration = CMTime\(/,
  "",
);

// ── Scenario 5: weak registry ──────────────────────────────────────────────
checkRange(
  "S5.weak-entry",
  "coordinator",
  78,
  81,
  /weak var value: SessionCaptureCoordinator\?/,
  "",
);
checkRange("S5.active-derefs-weak", "coordinator", 86, 90, /registry\[captureId\]\?\.value/, "");
checkRange(
  "S5.anyActive-filters-nil",
  "coordinator",
  95,
  99,
  /contains \{ \$0\.value != nil \}/,
  "",
);
checkRange("S5.deinit-unregisters", "coordinator", 146, 148, /deinit[\s\S]*unregister\(\)/, "");
checkRange("S5.stop-unregisters", "coordinator", 171, 178, /unregister\(\)/, "");
checkRange(
  "S5.no-session-event-listener",
  "coordinator",
  150,
  169,
  /^(?![\s\S]*onSessionEvent)[\s\S]*$/,
  "start() never wires engine.onSessionEvent",
);

// ── Scenario 7/8: bridge + guided capture strings ──────────────────────────
checkRange(
  "S7.permission-denied-code",
  "bridge",
  69,
  80,
  /catch CameraEngine\.EngineError\.permissionDenied[\s\S]*"camera\.permission_denied"[\s\S]*"Allow camera access in Settings to analyze a stroke\."/,
  "",
);
check(
  "S7.fresh-engine-per-call",
  "bridge",
  48,
  /let engine = CameraEngine\(\)/,
  "no cached permission state across calls",
);
checkRange(
  "S7.permission-before-configure",
  "engine",
  134,
  149,
  /case \.denied, \.restricted:[\s\S]*granted = false[\s\S]*guard granted else \{ throw EngineError\.permissionDenied \}[\s\S]*try await configureAuthorizedSession\(\)/,
  "",
);
checkRange(
  "S8.interrupted-abstention",
  "guided",
  1265,
  1271,
  /case \.interrupted\(let reason\):[\s\S]*"camera\.interrupted"[\s\S]*abstention: "camera_interrupted"/,
  "",
);
checkRange(
  "S8.finishFailure-cleanup",
  "guided",
  2078,
  2099,
  /terminal = true[\s\S]*engine\.stop\(\)[\s\S]*if !hadActiveRecording \{ ClipMediaStore\.removeIfPresent\(observationURL\) \}/,
  "spool removed directly only when no recording was active",
);
checkRange(
  "S8.terminal-success-removed",
  "guided",
  1916,
  1919,
  /guard !isTerminal else \{[\s\S]*removeIfPresent\(artifact\.url\)/,
  "an artifact finishing after terminal is removed",
);
check("S8.idle-timer-disabled", "guided", 713, /isIdleTimerDisabled = true/, "");
check(
  "S8.idle-timer-restored",
  "guided",
  721,
  /isIdleTimerDisabled = SessionCaptureCoordinator\.anyActive\(\)/,
  "",
);

// ── swing-lab CLI: dispatch/arg parsing ────────────────────────────────────
checkRange(
  "SL.frame-ms-any-int",
  "swingLab",
  941,
  973,
  /flagValue\("--ms", in: arguments\)\.flatMap\(\{ Int\(\$0\) \}\)/,
  "--ms accepts any Int (negative allowed)",
);
checkRange(
  "SL.error-exit-1",
  "swingLab",
  941,
  973,
  /swing-lab error: \\\(error\)[\s\S]*exit\(1\)/,
  "",
);

// ── Probes: model the extract() bounds guard on the XCTest arguments ───────
// The guard is copied VERBATIM from line 204 so this cannot drift silently:
const guardSource = line("coordinator", 204).match(/guard (.+) else/)[1]; // "eventEndMs > eventStartMs"
const guardFn = new Function("eventStartMs", "eventEndMs", `return (${guardSource});`);
const probes = [
  { id: "S1.probe.(500,500)", args: [500, 500], expected: "invalidBounds" },
  { id: "S1.probe.(600,500)", args: [600, 500], expected: "invalidBounds" },
  { id: "S1.probe.(-1,10)", args: [-1, 10], expected: "invalidBounds" },
  { id: "S1.probe.(-5000,-1)", args: [-5000, -1], expected: "invalidBounds" },
  { id: "S1.probe.(0,1)", args: [0, 1], expected: "accepted" },
].map((p) => {
  const passesGuard = guardFn(...p.args);
  const observed = passesGuard ? "accepted (dispatched to extractionQueue)" : "invalidBounds";
  const status = observed.startsWith(p.expected) ? "HELD" : "BROKEN";
  return { ...p, guard: guardSource, observed, status };
});

const gitSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const report = {
  tool: "native-camera-engine-4/static-invariants",
  plane: "linux-static",
  claim: "source-level only; no Apple runtime behaviour is asserted",
  sha: gitSha,
  invariants,
  probes,
  invariantsFailed: invariants.filter((i) => !i.ok).map((i) => i.id),
  probesBroken: probes.filter((p) => p.status === "BROKEN").map((p) => p.id),
};
writeFileSync(`${outDir}/static-invariants.json`, JSON.stringify(report, null, 2) + "\n");

for (const i of invariants) console.log(`${i.ok ? "HOLD " : "STALE"} ${i.id.padEnd(40)} ${i.file}`);
for (const p of probes)
  console.log(
    `${p.status.padEnd(6)} ${p.id.padEnd(40)} guard=${p.guard} args=${JSON.stringify(p.args)} → ${p.observed}`,
  );
console.log(`\nreport: ${outDir}/static-invariants.json`);

if (report.invariantsFailed.length) {
  console.error(`invariants no longer hold: ${report.invariantsFailed.join(", ")}`);
  process.exit(1);
}
if (report.probesBroken.length) {
  console.error(`probes detected defects: ${report.probesBroken.join(", ")}`);
  process.exit(2);
}
