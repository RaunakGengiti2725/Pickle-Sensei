// ADVERSARIAL PASS (native-swing-lab-camera-engine #2) — Linux-side STATIC pin
// of native/swing-lab/Sources/main.swift control flow for the CLI scenarios.
//
// This does NOT execute Swift/AVFoundation (Linux cannot). It pins, from the
// source text, the facts the Mac harness (cli-attacks.sh) asserts at runtime,
// so a later edit that changes the contract is caught on the cloud plane too.
// Every assertion is labelled INFERRED in the pass report.
//
// Run: node --test tools/attack/native-swing-lab/static-review.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mainSwift = readFileSync(
  resolve(here, "../../../native/swing-lab/Sources/main.swift"),
  "utf8",
);
const lines = mainSwift.split("\n");
const lineOf = (needle, from = 0) => {
  const index = lines.findIndex((line, i) => i >= from && line.includes(needle));
  assert.notEqual(index, -1, `expected main.swift to contain: ${needle}`);
  return index + 1;
};
/** 1-based line `lineNo`, optionally `offset` lines after it. */
const at = (lineNo, offset = 0) => lines[lineNo - 1 + offset];
/** Lines strictly AFTER 1-based `lineNo`, `count` of them. */
const after = (lineNo, count) => lines.slice(lineNo, lineNo + count).join("\n");

test("S1a — extract without --out reaches usage(), which exits 2 (never a silent run)", () => {
  const usage = lineOf("func usage() -> Never {");
  assert.match(after(usage, 9), /exit\(2\)/);
  const dispatch = lineOf('case "extract":');
  assert.match(
    at(dispatch, 1),
    /guard arguments\.count >= 2, let outDir = flagValue\("--out", in: arguments\) else \{ usage\(\) \}/,
  );
});

test("S1a-dangling — `--out` as the last token yields nil (usage), not an empty path", () => {
  const flagValue = lineOf("func flagValue(_ name: String, in args: [String]) -> String? {");
  assert.match(at(flagValue, 1), /index \+ 1 < args\.count else \{ return nil \}/);
});

test('S1b — extract creates the out dir with `try` BEFORE opening the video; the throw reaches the top-level catch → "swing-lab error:" + exit 1', () => {
  const runExtract = lineOf("func runExtract(videoPath: String, outDir: String) async throws {");
  const mkdir = lineOf(
    "try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)",
    runExtract,
  );
  const reader = lineOf("let readerBox = try await UprightVideoReader(url: videoURL)", runExtract);
  assert.ok(
    mkdir < reader,
    "createDirectory must precede the reader (a read-only parent fails before any decode)",
  );
  assert.ok(
    !/try\?\s*FileManager\.default\.createDirectory/.test(mainSwift),
    "createDirectory must not be try? (that would swallow EACCES)",
  );
  const catchLine = lineOf("} catch {", lineOf("// MARK: - Dispatch"));
  assert.match(at(catchLine, 1), /swing-lab error: \\\(error\)/);
  assert.match(at(catchLine, 2), /exit\(1\)/);
});

test("S2a — overlay parses pose.json with `try` (truncated JSON throws → exit 1), and the output file is only removed AFTER parsing succeeds", () => {
  const load = lineOf(
    "func loadOverlayData(posePath: String, analysisPath: String?) throws -> OverlayData {",
  );
  const poseParse = lineOf(
    "let poseRaw = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: posePath)))",
    load,
  );
  assert.ok(poseParse - load <= 3, "pose parse is the first statement of the loader");
  const runOverlay = lineOf(
    "func runOverlay(videoPath: String, posePath: String, analysisPath: String?, outPath: String) async throws {",
  );
  const parse = lineOf(
    "let overlay = try loadOverlayData(posePath: posePath, analysisPath: analysisPath)",
    runOverlay,
  );
  const remove = lineOf("try? FileManager.default.removeItem(at: outURL)", runOverlay);
  assert.ok(parse < remove, "a corrupt --pose must not destroy a pre-existing --out file");
});

test("S2b — frames missing `l` / wrong-typed fields are skipped (`as? … ?? []`, `guard … else { continue }`), never force-unwrapped", () => {
  const load = lineOf("func loadOverlayData(");
  const body = after(load, 14);
  assert.match(body, /for frame in poseRaw\?\["frames"\] as\? \[\[String: Any\]\] \?\? \[\]/);
  assert.match(body, /guard let t = frame\["t"\] as\? Int else \{ continue \}/);
  assert.match(body, /for mark in frame\["l"\] as\? \[\[String: Any\]\] \?\? \[\]/);
  assert.match(body, /guard let name = mark\["n"\] as\? String,/);
  assert.doesNotMatch(
    body,
    /frame\["[a-z]"\]!|mark\["[a-z]"\]!|as! /,
    "no force unwrap / force cast in the pose loader",
  );
});

test("S3a — a file with no readable video track throws before any output file is written (but AFTER the out dir was created)", () => {
  const init = lineOf("init(url: URL) async throws {");
  const guardLine = lineOf(
    "guard let track = try await asset.loadTracks(withMediaType: .video).first else {",
    init,
  );
  assert.match(at(guardLine, 1), /throw NSError\(domain: "swing-lab", code: 1/);
  const runExtract = lineOf("func runExtract(");
  const reader = lineOf("let readerBox = try await UprightVideoReader(url: videoURL)", runExtract);
  const firstWrite = lineOf('to: "\\(outDir)/scenes.json"', runExtract);
  assert.ok(reader < firstWrite);
});

test("S3b — PREDICTED BREAK: runExtract has NO zero-frame guard; framesSeen == 0 still writes pose.json (frames: []) and exits 0", () => {
  const runExtract = lineOf("func runExtract(");
  const end = lineOf("func writeJSON(_ object: [String: Any], to path: String) throws {");
  const body = lines.slice(runExtract, end).join("\n");
  // The loop counts frames…
  assert.match(body, /while let frame = readerBox\.next\(\) \{\s*\n\s*framesSeen \+= 1/);
  // …but nothing between the loop and the writes rejects framesSeen == 0 /
  // frames.isEmpty. If someone adds the guard, this assertion flips and the
  // finding is closed.
  const guardPattern =
    /(framesSeen\s*==\s*0|frames\.isEmpty|framesSeen\s*<\s*1|frames\.count\s*==\s*0)[^\n]*\n[^\n]*throw/;
  assert.doesNotMatch(
    body,
    guardPattern,
    'a zero-frame guard now exists — close finding "swing-lab extract exits 0 with frames: [] on a 0-frame video"',
  );
  assert.match(body, /try writeJSON\(poseWire, to: "\\\(outDir\)\/pose\.json"\)/);
  // The ONLY downstream guard is the CI helper, not the CLI:
  const checker = readFileSync(resolve(here, "../../macos-ci/check-swing-lab-extract.py"), "utf8");
  assert.match(
    checker,
    /if frames_seen <= 0:\n\s+sys\.exit\("::error::the video reader produced no frames"\)/,
  );
});

test('S4 — `extract --out DIR` (video omitted) is accepted by the arity guard: "--out" becomes the video path', () => {
  const dispatch = lineOf('case "extract":');
  // arguments = ["extract", "--out", "DIR"] → count 3 >= 2 and flagValue finds DIR.
  assert.match(at(dispatch, 1), /arguments\.count >= 2/);
  assert.match(at(dispatch, 2), /runExtract\(videoPath: arguments\[1\]/);
  // No check excludes a flag token from being taken as the video path.
  assert.doesNotMatch(at(dispatch, 1), /hasPrefix\("--"\)/);
});
