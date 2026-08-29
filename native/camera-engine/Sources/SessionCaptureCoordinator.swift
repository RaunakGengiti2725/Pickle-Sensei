import AVFoundation
import Foundation

/// Continuous session capture (D-040 Gap 1 + Gap 2, native side).
///
/// Owns the rolling camera pipeline for LIVE session play: the AVCapture
/// session records continuously (never finalizing per stroke), every frame is
/// run through native pose extraction, and the resulting wrist-motion series
/// streams to React Native as `session_motion_sample` events — the frozen
/// `{ tMs, v }` contract in apps/mobile/src/flow/session.ts. The JS session
/// engine segments that stream into stroke events and asks back, per closed
/// event, for a clip cut from the rolling recording plus the pose sidecar
/// sliced to the same window (`extract`).
///
/// TIME AXIS — motion samples are rebased to ms since the FIRST camera frame
/// of the session, so JS sees a session-relative axis. Event bounds arrive on
/// that same axis and are converted back to camera-clock timestamps here; the
/// bounds themselves are honored verbatim (rebase is a constant offset, never
/// a window adjustment).
///
/// ROLLING READABILITY — the movie output writes QuickTime fragments
/// (`movieFragmentSeconds`) so the in-progress file is readable up to its
/// last fragment boundary. Extraction polls until the readable duration
/// covers the event window (bounded by `coverageTimeoutMs`) and fails
/// honestly when coverage never arrives — it never guesses at media.
///
/// No UI: React Native owns the session screen. This coordinator has no
/// preview surface; it is camera + pose + motion + media only.
final class SessionCaptureCoordinator: @unchecked Sendable {
  enum CoordinatorError: LocalizedError {
    case alreadyStopped
    case recordingNotStarted
    case invalidBounds
    case windowNotCovered(String)

    var errorDescription: String? {
      switch self {
      case .alreadyStopped:
        return "The session capture has already stopped."
      case .recordingNotStarted:
        return "The session recording has not produced any frames yet."
      case .invalidBounds:
        return "The requested event window is empty or reversed."
      case .windowNotCovered(let message):
        return message
      }
    }
  }

  /// Same context window convention as guided capture
  /// (GuidedCaptureViewController.preRollMs/postRollMs): the EVENT bounds are
  /// exact; pre/post roll only adds surrounding context video and both are
  /// clamped to available footage with the actual values recorded on the clip.
  static let preRollMs = 2_000
  static let postRollMs = 1_500
  /// Rolling pose retention matches guided capture's history window.
  private static let poseHistoryWindowMs = 15_000
  private static let evidenceRetentionMs = 15_000
  /// Fragment interval: extraction latency floor. 1s keeps the readable edge
  /// close behind live while writing at a sane cadence.
  private static let movieFragmentSeconds = 1.0
  private static let maximumSessionSeconds = 1_800.0
  private static let coverageTimeoutMs = 10_000
  private static let coveragePollMs = 250

  let captureId = UUID().uuidString.lowercased()
  /// Rebased (session-relative) timestamp in ms + wrist speed in
  /// normalized-image units/second, per measurable pose frame.
  var onMotionSample: ((Int, Double) -> Void)?

  private let engine: CameraEngine
  private let poseProvider = ApplePoseProvider()
  private let motionStream = SessionMotionStream()
  private let evidenceAccumulator = CaptureEvidenceAccumulator(
    retentionMs: SessionCaptureCoordinator.evidenceRetentionMs
  )
  private let visionQueue = DispatchQueue(label: "pickle.session.vision", qos: .userInteractive)
  private let extractionQueue = DispatchQueue(label: "pickle.session.extract", qos: .userInitiated)
  private let stateLock = NSLock()
  private var poseHistory: [PoseFrame] = []
  private var poseInFlight = false
  private var sessionBaseMs: Int?
  private var lastFrameMs: Int?
  private var recordingURL: URL?
  private var stopped = false

  init() {
    engine = CameraEngine(config: CameraEngine.Config(
      preset: .hd1280x720,
      targetFps: 60,
      maximumObservationSeconds: Self.maximumSessionSeconds,
      movieFragmentSeconds: Self.movieFragmentSeconds
    ))
  }

  func start() async throws {
    try await engine.requestPermissionAndConfigure()
    engine.onFrame = { [weak self] pixelBuffer, timestampMs in
      self?.handleFrame(pixelBuffer: pixelBuffer, timestampMs: timestampMs)
    }
    engine.onRecordingFinished = { result in
      // The rolling recording is session-scoped scratch: per-event clips have
      // already been exported into private capture storage by the time it
      // finalizes, so the finished movie itself is discarded.
      if case .success(let artifact) = result {
        ClipMediaStore.removeIfPresent(artifact.url)
      }
    }
    let url = try ClipMediaStore.makeObservationURL()
    stateLock.lock()
    recordingURL = url
    stateLock.unlock()
    engine.start()
    engine.startContinuousRecording(to: url)
  }

  func stop() {
    stateLock.lock()
    stopped = true
    stateLock.unlock()
    engine.stopContinuousRecording()
    engine.stop()
  }

  /// Cuts one closed event's window from the rolling recording. Bounds are on
  /// the rebased session axis (see TIME AXIS above); pre/post roll adds
  /// context exactly like guided capture and is clamped to available footage.
  func extract(
    eventStartMs: Int,
    eventEndMs: Int,
    peakMs: Int?,
    confidence: Double,
    detectionModelVersion: String,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    stateLock.lock()
    let base = sessionBaseMs
    let url = recordingURL
    let isStopped = stopped
    stateLock.unlock()
    guard !isStopped else {
      completion(.failure(CoordinatorError.alreadyStopped))
      return
    }
    guard let base, let url else {
      completion(.failure(CoordinatorError.recordingNotStarted))
      return
    }
    guard eventEndMs > eventStartMs else {
      completion(.failure(CoordinatorError.invalidBounds))
      return
    }
    let absoluteStartMs = base + eventStartMs
    let absoluteEndMs = base + eventEndMs
    let event = StrokeEvent(
      startMs: absoluteStartMs,
      endMs: absoluteEndMs,
      peakMotionMs: peakMs.map { base + $0 },
      confidence: confidence
    )
    extractionQueue.async {
      self.awaitCoverageAndExport(
        event: event,
        recordingURL: url,
        detectionModelVersion: detectionModelVersion,
        completion: completion
      )
    }
  }

  // MARK: - Frames

  private func handleFrame(pixelBuffer: CVPixelBuffer, timestampMs: Int) {
    stateLock.lock()
    if sessionBaseMs == nil { sessionBaseMs = timestampMs }
    lastFrameMs = timestampMs
    let skip = poseInFlight
    if !skip { poseInFlight = true }
    stateLock.unlock()
    guard !skip else { return }

    visionQueue.async { [weak self] in
      guard let self else { return }
      defer {
        self.stateLock.lock()
        self.poseInFlight = false
        self.stateLock.unlock()
      }
      do {
        let pose = try self.poseProvider.extractPose(
          pixelBuffer: pixelBuffer,
          timestampMs: timestampMs
        )
        self.evidenceAccumulator.ingest(pose: pose)
        self.retainPose(pose)
        if let sample = self.motionStream.ingest(pose: pose) {
          self.stateLock.lock()
          let base = self.sessionBaseMs
          self.stateLock.unlock()
          if let base {
            self.onMotionSample?(sample.timestampMs - base, sample.value)
          }
        }
      } catch {
        // A frame without a usable pose is an honest miss, recorded as such.
        self.evidenceAccumulator.ingestMissing(timestampMs: timestampMs)
      }
    }
  }

  private func retainPose(_ pose: PoseFrame) {
    stateLock.lock()
    defer { stateLock.unlock() }
    if let last = poseHistory.last, pose.timestampMs <= last.timestampMs { return }
    poseHistory.append(pose)
    let cutoff = pose.timestampMs - Self.poseHistoryWindowMs
    if let firstKept = poseHistory.firstIndex(where: { $0.timestampMs >= cutoff }), firstKept > 0 {
      poseHistory.removeFirst(firstKept)
    }
  }

  // MARK: - Extraction

  private func awaitCoverageAndExport(
    event: StrokeEvent,
    recordingURL: URL,
    detectionModelVersion: String,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    let requiredEndMs = event.endMs + Self.postRollMs
    let deadline = Date().addingTimeInterval(Double(Self.coverageTimeoutMs) / 1_000)
    var bestReadableEndMs: Int?
    var recordingFirstMs: Int?

    while Date() < deadline {
      stateLock.lock()
      let isStopped = stopped
      stateLock.unlock()
      guard let firstMs = engine.currentRecordingFirstFrameTimestampMs
        ?? recordingFirstMs else {
        if isStopped {
          completion(.failure(CoordinatorError.recordingNotStarted))
          return
        }
        Thread.sleep(forTimeInterval: Double(Self.coveragePollMs) / 1_000)
        continue
      }
      recordingFirstMs = firstMs
      // A fresh asset per poll: fragment metadata is only re-read on open.
      let asset = AVURLAsset(url: recordingURL)
      let readableSeconds = CMTimeGetSeconds(asset.duration)
      if readableSeconds.isFinite, readableSeconds > 0 {
        let readableEndMs = firstMs + Int((readableSeconds * 1_000).rounded())
        bestReadableEndMs = max(bestReadableEndMs ?? readableEndMs, readableEndMs)
        if readableEndMs >= requiredEndMs { break }
        // The recording will never grow past its final frame once stopped.
        if isStopped, let lastMs = latestFrameMs(), readableEndMs >= min(lastMs, requiredEndMs) {
          break
        }
      } else if isStopped {
        break
      }
      Thread.sleep(forTimeInterval: Double(Self.coveragePollMs) / 1_000)
    }

    guard let firstMs = recordingFirstMs ?? engine.currentRecordingFirstFrameTimestampMs,
          let readableEndMs = bestReadableEndMs else {
      completion(.failure(CoordinatorError.windowNotCovered(
        "The rolling recording produced no readable media for this event."
      )))
      return
    }
    // The event bounds themselves must be covered; post-roll is context and
    // clamps like guided capture. An event past the readable edge is a
    // truthful failure, not a shrunken window.
    guard readableEndMs >= event.endMs else {
      completion(.failure(CoordinatorError.windowNotCovered(
        "The rolling recording covers up to \(readableEndMs)ms but the event ends at \(event.endMs)ms."
      )))
      return
    }

    stateLock.lock()
    let retainedPoseHistory = poseHistory
    stateLock.unlock()

    // The accumulator is single-queue; summarize on the vision queue so no
    // ingest races this read.
    let captureEvidence = visionQueue.sync {
      evidenceAccumulator.summary(
        startMs: event.startMs,
        endMs: event.endMs,
        poseSource: "apple_vision_body_pose",
        poseModelVersion: poseProvider.modelVersion,
        triggerAlgorithmVersion: detectionModelVersion
      )
    }
    guard let captureEvidence else {
      completion(.failure(CoordinatorError.windowNotCovered(
        "No usable pose was measured inside the event window."
      )))
      return
    }

    ClipMediaStore.exportStrokeWindow(
      artifact: CameraEngine.RecordingArtifact(
        url: recordingURL,
        firstFrameTimestampMs: firstMs,
        lastFrameTimestampMs: readableEndMs
      ),
      event: event,
      detectionModelVersion: detectionModelVersion,
      captureEvidence: Self.captureEvidencePayload(captureEvidence),
      poseHistory: retainedPoseHistory,
      poseModelVersion: poseProvider.modelVersion,
      preRollMs: Self.preRollMs,
      postRollMs: Self.postRollMs,
      removeSourceRecording: false,
      completion: completion
    )
  }

  private func latestFrameMs() -> Int? {
    stateLock.lock()
    defer { stateLock.unlock() }
    return lastFrameMs
  }

  private static func captureEvidencePayload(
    _ evidence: CaptureEvidenceAccumulator.Summary
  ) -> [String: Any] {
    [
      "schemaVersion": evidence.schemaVersion,
      "window": evidence.window,
      "poseSource": evidence.poseSource,
      "poseModelVersion": evidence.poseModelVersion,
      "triggerAlgorithmVersion": evidence.triggerAlgorithmVersion,
      "motionUnit": evidence.motionUnit,
      "analysisInputFrameCount": evidence.analysisInputFrameCount,
      "poseFrameCount": evidence.poseFrameCount,
      "poseMissingFrameCount": evidence.poseMissingFrameCount,
      "trackedDurationMs": evidence.trackedDurationMs,
      "meanCanonicalJointVisibility": evidence.meanCanonicalJointVisibility,
      "meanJointCoverage": evidence.meanJointCoverage,
      "minimumJointCoverage": evidence.minimumJointCoverage,
      "fullBodyVisibleFrameCount": evidence.fullBodyVisibleFrameCount,
      "jointMotion": evidence.jointMotion.map { motion in
        [
          "joint": motion.joint,
          "sampleCount": motion.sampleCount,
          "meanNormalizedPerSecond": motion.meanNormalizedPerSecond,
          "peakNormalizedPerSecond": motion.peakNormalizedPerSecond,
        ] as [String: Any]
      },
    ]
  }
}
