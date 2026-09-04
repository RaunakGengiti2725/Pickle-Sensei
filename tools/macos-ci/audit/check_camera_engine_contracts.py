#!/usr/bin/env python3
"""Static structural contract checks for native/camera-engine (Linux-runnable).

Usage: check_camera_engine_contracts.py [--json <report path>]

CameraEngine.swift and SessionCaptureCoordinator.swift are compiled ONLY
inside the iOS app (they use iOS-only AVFoundation API) and belong to no
XCTest target on any plane, so their lifecycle contracts cannot be executed
here. What CAN be demonstrated without a toolchain is whether the code path a
contract needs EXISTS at all. Each check below names the contract, the
file:line range it inspects, and the concrete failure mode when the path is
missing. A FAIL is a structural fact about the source, not a runtime claim.

Checks (S = SessionCaptureCoordinator.swift, C = CameraEngine.swift):

  S1  start() installs engine.onSessionEvent so .failed/.interrupted reach
      the caller (C emits them at start():309-318, runtime error 654-658,
      interruption 639-648).
  S2  start()'s onRecordingFinished handler observes .failure (C reports
      .sessionNotRunning / .recordingAlreadyActive / file errors /
      recordingFailed through that callback: 530,534,542,734,740).
  S3  the rolling-file deletion in onRecordingFinished is gated on no
      extraction being in flight (awaitCoverageAndExport reads the same URL
      via AVURLAsset + exportStrokeWindow: 307, 362-377).
  S4  the coordinator restarts the spool when the movie output's
      maxRecordedDuration (maximumSessionSeconds) finalizes the rolling file
      (C:249-252 hard-caps every recording; C:743 reports it as .success).
  S5  extract() precondition order alreadyStopped → recordingNotStarted →
      invalidBounds, all truthful failures (expected PASS).
  S6  coverage polling is bounded by coverageTimeoutMs with a
      coveragePollMs sleep and never fabricates media (expected PASS).
  S7  pose history retention is bounded (poseHistoryWindowMs) and frames are
      dropped, not queued, while a pose is in flight (expected PASS).
  C1  start() before configure emits .failed (expected PASS).
  C2  startContinuousRecording guards session.isRunning and
      movieOutput.isRecording (expected PASS).
  C3  the recording delegate deletes the file on suppression, on error
      without AVErrorRecordingSuccessfullyFinishedKey, and when no valid
      frames were recorded (expected PASS).
  C4  discardActiveRecording decides on the session queue against
      movieOutput.isRecording before arming suppression (expected PASS).
  C5  stop() clears recording timestamps only when nothing was recording
      (delegate owns the clear otherwise) (expected PASS).
  C6  connection policies pin portrait + non-mirrored for both outputs and
      are re-applied after every camera switch (expected PASS).
  C7  interruption / runtime-error observers are installed exactly once and
      removed in deinit (expected PASS).
  C9  no public API arms recording-finish suppression without checking
      movieOutput.isRecording (expected PASS).
  C8  NO camera-engine source references networking, Supabase, RevenueCat,
      Keychain or SQLite (media never leaves the device) (expected PASS).
  W1  swing-lab pose wire constants (schemaVersion 1, format, coordinate
      system) match packages/swing-domain/src/observations.ts and
      ClipMediaStore's sidecar writer (expected PASS).

Exit 0 when every check holds, 1 when any fails.
"""
from __future__ import annotations

import json
import os
import re
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
ENGINE = os.path.join(REPO_ROOT, "native/camera-engine/Sources/CameraEngine.swift")
COORD = os.path.join(REPO_ROOT, "native/camera-engine/Sources/SessionCaptureCoordinator.swift")
SWING_LAB = os.path.join(REPO_ROOT, "native/swing-lab/Sources/main.swift")
SERIALIZATION_TS = os.path.join(REPO_ROOT, "packages/swing-domain/src/observations.ts")
CLIP_MEDIA_STORE = os.path.join(
    REPO_ROOT, "apps/mobile/ios/LocalPods/PickleNative/Sources/ClipMediaStore.swift"
)


def read(path: str) -> str:
    with open(path) as fh:
        return fh.read()


def line_of(text: str, needle: str, start: int = 0) -> int | None:
    index = text.find(needle, start)
    if index < 0:
        return None
    return text.count("\n", 0, index) + 1


def body_of(text: str, header: str) -> tuple[str, int, int] | None:
    """Return the brace-balanced body following `header` plus its 1-based line span."""
    start = text.find(header)
    if start < 0:
        return None
    open_brace = text.find("{", start)
    depth = 0
    for index in range(open_brace, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                first_line = text.count("\n", 0, start) + 1
                last_line = text.count("\n", 0, index) + 1
                return text[open_brace : index + 1], first_line, last_line
    return None


class Report:
    def __init__(self) -> None:
        self.checks: list[dict] = []

    def check(self, code: str, name: str, ok: bool, where: str, failure_mode: str) -> None:
        self.checks.append(
            {"code": code, "name": name, "ok": bool(ok), "where": where, "failure_mode": failure_mode}
        )
        status = "PASS" if ok else "FAIL"
        print(f"{status} {code} {name} [{where}]")
        if not ok:
            print(f"     failure mode: {failure_mode}")


def main(argv: list[str]) -> int:
    json_out = argv[argv.index("--json") + 1] if "--json" in argv else None
    report = Report()
    engine = read(ENGINE)
    coord = read(COORD)

    # ── SessionCaptureCoordinator ────────────────────────────────────────────
    start = body_of(coord, "func start() async throws")
    assert start is not None, "SessionCaptureCoordinator.start() not found"
    start_body, start_first, start_last = start
    start_where = f"SessionCaptureCoordinator.swift:{start_first}-{start_last}"

    report.check(
        "S1",
        "start() installs engine.onSessionEvent",
        "onSessionEvent" in start_body or "engine.onSessionEvent" in coord,
        start_where,
        "CameraEngine emits .failed when start() runs unconfigured or session.startRunning() "
        "fails (CameraEngine.swift:309-318), .failed on AVCaptureSessionRuntimeError (654-658) "
        "and .interrupted on AVCaptureSessionWasInterrupted (639-648); nothing in the "
        "coordinator observes them, so a session that never runs or dies mid-session is "
        "invisible to React Native until extract() times out after 10 s with windowNotCovered.",
    )

    finished = body_of(start_body, "engine.onRecordingFinished = {")
    finished_body = finished[0] if finished else ""
    report.check(
        "S2",
        "onRecordingFinished handler observes .failure",
        ".failure" in finished_body,
        start_where,
        "startContinuousRecording reports .sessionNotRunning / .recordingAlreadyActive / a "
        "file-removal error and the delegate reports recording errors ONLY through "
        "onRecordingFinished(.failure) (CameraEngine.swift:530,534,542,734,740); the handler "
        "matches `.success` only, so a rolling recording that never started or failed is "
        "silently dropped and every later extract() fails after the 10 s coverage poll.",
    )

    report.check(
        "S3",
        "rolling-file deletion is gated on no extraction in flight",
        bool(finished_body)
        and any(token in finished_body for token in ("extractionQueue", "inFlight", "pending", "stateLock")),
        start_where,
        "The handler deletes the finished rolling movie immediately (ClipMediaStore.removeIfPresent) "
        "while awaitCoverageAndExport may still be polling AVURLAsset(url: recordingURL) or running "
        "exportStrokeWindow on that URL (SessionCaptureCoordinator.swift:307,362-377) — the stopped "
        "branch of the poll loop (313-318) exists precisely to finish an event cut after stop(), "
        "but the file it needs is removed underneath it once the movie finalizes.",
    )

    report.check(
        "S4",
        "spool restarts when maximumSessionSeconds finalizes the rolling file",
        any(token in finished_body for token in ("startContinuousRecording", "flipCameraRestartingSpool")),
        start_where,
        "movieOutput.maxRecordedDuration = maximumSessionSeconds (1800 s) hard-stops the ONE rolling "
        "recording (CameraEngine.swift:249-252, delivered as .success at 743-749); the coordinator "
        "deletes it and never records again while engine.onFrame keeps streaming motion samples, so "
        "every event after 30 min fails with windowNotCovered after a 10 s poll.",
    )

    extract = body_of(coord, "func extract(")
    assert extract is not None
    extract_body = extract[0]
    order = [
        extract_body.find("CoordinatorError.alreadyStopped"),
        extract_body.find("CoordinatorError.recordingNotStarted"),
        extract_body.find("CoordinatorError.invalidBounds"),
    ]
    report.check(
        "S5",
        "extract() precondition order alreadyStopped → recordingNotStarted → invalidBounds",
        all(i >= 0 for i in order) and order == sorted(order) and "eventEndMs > eventStartMs" in extract_body,
        f"SessionCaptureCoordinator.swift:{extract[1]}-{extract[2]}",
        "a rejected extract would be misattributed",
    )

    poll = body_of(coord, "private func awaitCoverageAndExport(")
    assert poll is not None
    poll_body = poll[0]
    report.check(
        "S6",
        "coverage polling bounded by coverageTimeoutMs with coveragePollMs sleeps; no synthetic media",
        "coverageTimeoutMs" in poll_body
        and "coveragePollMs" in poll_body
        and "while Date() < deadline" in poll_body
        and "windowNotCovered" in poll_body
        and "Thread.sleep" in poll_body,
        f"SessionCaptureCoordinator.swift:{poll[1]}-{poll[2]}",
        "extraction could block forever or invent coverage",
    )

    retain = body_of(coord, "private func retainPose(")
    handle = body_of(coord, "private func handleFrame(")
    assert retain is not None and handle is not None
    report.check(
        "S7",
        "pose history bounded by poseHistoryWindowMs; frames dropped (not queued) while poseInFlight",
        "poseHistoryWindowMs" in retain[0]
        and "removeFirst" in retain[0]
        and "let skip = poseInFlight" in handle[0]
        and "guard !skip else { return }" in handle[0],
        f"SessionCaptureCoordinator.swift:{handle[1]}-{retain[2]}",
        "unbounded memory or a growing Vision backlog under load",
    )

    # ── CameraEngine ─────────────────────────────────────────────────────────
    start_fn = body_of(engine, "public func start()")
    assert start_fn is not None
    report.check(
        "C1",
        "start() before configure emits .failed",
        "guard self.isConfigured else" in start_fn[0] and '.failed("The camera session is not configured.")' in start_fn[0],
        f"CameraEngine.swift:{start_fn[1]}-{start_fn[2]}",
        "an unconfigured start would silently do nothing",
    )

    rec = body_of(engine, "public func startContinuousRecording(to url: URL)")
    assert rec is not None
    report.check(
        "C2",
        "startContinuousRecording guards session.isRunning and movieOutput.isRecording",
        "guard self.session.isRunning else" in rec[0]
        and "EngineError.sessionNotRunning" in rec[0]
        and "guard !self.movieOutput.isRecording else" in rec[0]
        and "EngineError.recordingAlreadyActive" in rec[0],
        f"CameraEngine.swift:{rec[1]}-{rec[2]}",
        "AVFoundation would throw an exception on a double start",
    )

    delegate = body_of(engine, "didFinishRecordingTo outputFileURL: URL,")
    assert delegate is not None
    dbody = delegate[0]
    suppressed_branch = body_of(dbody, "if suppressed")
    error_branch = body_of(dbody, "if (nsError.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool) != true")
    frames_branch = body_of(dbody, "guard let first, let last, last > first else")
    report.check(
        "C3",
        "recording delegate deletes the file on suppression, on real error, and on no-valid-frames",
        all(
            branch is not None and "FileManager.default.removeItem(at: outputFileURL)" in branch[0]
            for branch in (suppressed_branch, error_branch, frames_branch)
        )
        and frames_branch is not None
        and "No valid camera frames were recorded." in frames_branch[0],
        f"CameraEngine.swift:{delegate[1]}-{delegate[2]}",
        "a dead recording file would leak in the private captures directory",
    )

    discard = body_of(engine, "public func discardActiveRecording()")
    assert discard is not None
    report.check(
        "C4",
        "discardActiveRecording arms suppression only on the session queue after movieOutput.isRecording",
        "sessionQueue.async" in discard[0]
        and discard[0].find("guard self.movieOutput.isRecording else { return }") < discard[0].find("suppressNextRecordingFinish = true"),
        f"CameraEngine.swift:{discard[1]}-{discard[2]}",
        "a leaked suppression would swallow the next real capture",
    )

    stop_fn = body_of(engine, "public func stop()")
    assert stop_fn is not None
    report.check(
        "C5",
        "stop() clears recording timestamps only when nothing was recording",
        "let wasRecording = self.movieOutput.isRecording" in stop_fn[0]
        and "if !wasRecording { self.clearRecordingTimestamps() }" in stop_fn[0],
        f"CameraEngine.swift:{stop_fn[1]}-{stop_fn[2]}",
        "the delegate would lose the trim timestamps",
    )

    policies = body_of(engine, "private func applyConnectionPoliciesLocked()")
    switch_fn = body_of(engine, "private func performCameraSwitchLocked(")
    assert policies is not None and switch_fn is not None
    report.check(
        "C6",
        "portrait + non-mirrored on both outputs; policies re-applied after camera switch",
        policies[0].count("videoOrientation = .portrait") == 2
        and policies[0].count("isVideoMirrored = false") == 2
        and policies[0].count("automaticallyAdjustsVideoMirroring = false") == 2
        and "applyConnectionPoliciesLocked()" in switch_fn[0],
        f"CameraEngine.swift:{policies[1]}-{switch_fn[2]}",
        "a flipped camera would record mirrored/landscape media",
    )

    install = body_of(engine, "private func installObservers()")
    deinit_fn = body_of(engine, "deinit")
    assert install is not None and deinit_fn is not None
    report.check(
        "C7",
        "interruption/interruptionEnded/runtimeError observers installed once, removed in deinit",
        "guard !observersInstalled else { return }" in install[0]
        and all(
            name in install[0]
            for name in (".AVCaptureSessionWasInterrupted", ".AVCaptureSessionInterruptionEnded", ".AVCaptureSessionRuntimeError")
        )
        and "removeObservers()" in deinit_fn[0],
        f"CameraEngine.swift:{install[1]}-{install[2]}",
        "duplicate or dangling NotificationCenter observers",
    )

    unguarded = body_of(engine, "public func suppressNextRecordingFinishAndDiscard()")
    consumers = [
        os.path.join(REPO_ROOT, "apps/mobile/ios/LocalPods/PickleNative/Sources", name)
        for name in os.listdir(os.path.join(REPO_ROOT, "apps/mobile/ios/LocalPods/PickleNative/Sources"))
        if name.endswith(".swift")
    ]
    callers = [
        os.path.relpath(path, REPO_ROOT)
        for path in consumers + [COORD]
        if "suppressNextRecordingFinishAndDiscard()" in read(path)
    ]
    report.check(
        "C9",
        "no public entry point arms recording-finish suppression without checking movieOutput.isRecording",
        unguarded is None or "movieOutput.isRecording" in unguarded[0],
        f"CameraEngine.swift:{unguarded[1]}-{unguarded[2]}" if unguarded else "CameraEngine.swift",
        "suppressNextRecordingFinishAndDiscard() sets suppressNextRecordingFinish = true unconditionally "
        "and off the session queue; armed while nothing records, the flag survives until the NEXT real "
        "recording finishes and that capture is silently deleted (the hazard discardActiveRecording's own "
        f"doc comment at 574-579 describes). Current callers outside the engine: {callers or 'none (dead API)'}",
    )

    forbidden = re.compile(
        r"URLSession|Supabase|RevenueCat|Purchases|Keychain|SecItem|sqlite|SQLite|Alamofire|import Network|GoogleSignIn",
    )
    hits = [
        f"{os.path.relpath(path, REPO_ROOT)}:{index + 1}"
        for path, text in ((ENGINE, engine), (COORD, coord), (SWING_LAB, read(SWING_LAB)))
        for index, line in enumerate(text.splitlines())
        if forbidden.search(line)
    ]
    report.check(
        "C8",
        "no networking/Supabase/RevenueCat/Keychain/SQLite references in native scope",
        not hits,
        "native/camera-engine, native/swing-lab",
        f"media could leave the device: {hits}",
    )

    # ── Pose wire constants ──────────────────────────────────────────────────
    swing_lab = read(SWING_LAB)
    serialization = read(SERIALIZATION_TS)
    clip_store = read(CLIP_MEDIA_STORE)
    wire_ok = (
        '"schemaVersion": 1' in swing_lab
        and '"format": "pickle.pose-sequence.v1"' in swing_lab
        and '"coordinateSystem": "normalized_image_top_left"' in swing_lab
        and '"pickle.pose-sequence.v1"' in serialization
        and '"normalized_image_top_left"' in serialization
        and '"pickle.pose-sequence.v1"' in clip_store
        and '"normalized_image_top_left"' in clip_store
    )
    report.check(
        "W1",
        "pose wire constants agree across swing-lab, ClipMediaStore sidecar and swing-domain parser",
        wire_ok,
        f"main.swift:{line_of(swing_lab, '\"format\": \"pickle.pose-sequence.v1\"')}, "
        f"ClipMediaStore.swift:{line_of(clip_store, '\"pickle.pose-sequence.v1\"')}, "
        f"observations.ts:{line_of(serialization, '\"pickle.pose-sequence.v1\"')}",
        "the app's strict parser would reject CLI/native output",
    )

    failed = [c for c in report.checks if not c["ok"]]
    if json_out:
        with open(json_out, "w") as fh:
            json.dump({"checks": report.checks, "passed": len(report.checks) - len(failed), "failed": len(failed)}, fh, indent=2)
    print(f"{len(report.checks) - len(failed)} passed, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
