import AVFoundation
import CryptoKit
import Foundation

enum ClipMediaStoreError: LocalizedError {
  case invalidMedia
  case exportUnavailable
  case exportFailed(String)

  var errorDescription: String? {
    switch self {
    case .invalidMedia:
      return "The selected video does not contain a valid video track."
    case .exportUnavailable:
      return "A private clip could not be created from this recording."
    case .exportFailed(let message):
      return message
    }
  }
}

enum ClipMediaStore {
  private static var capturesDirectory: URL {
    get throws {
      let support = try FileManager.default.url(
        for: .applicationSupportDirectory,
        in: .userDomainMask,
        appropriateFor: nil,
        create: true
      )
      let directory = support.appendingPathComponent("PickleSensei/Captures", isDirectory: true)
      try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
      )
      return directory
    }
  }

  static func makeObservationURL() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("PickleSensei-Observation", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appendingPathComponent("observation-\(UUID().uuidString.lowercased()).mov")
  }

  static func persistImportedVideo(from source: URL) throws -> URL {
    let ext = source.pathExtension.isEmpty ? "mov" : source.pathExtension.lowercased()
    let destination = try capturesDirectory
      .appendingPathComponent("import-\(UUID().uuidString.lowercased()).\(ext)")
    if FileManager.default.fileExists(atPath: destination.path) {
      try FileManager.default.removeItem(at: destination)
    }
    try FileManager.default.copyItem(at: source, to: destination)
    return destination
  }

  static func removeIfPresent(_ url: URL?) {
    guard let url, FileManager.default.fileExists(atPath: url.path) else { return }
    try? FileManager.default.removeItem(at: url)
  }

  static func exportStrokeWindow(
    artifact: CameraEngine.RecordingArtifact,
    event: StrokeEvent,
    detectionModelVersion: String,
    captureEvidence: [String: Any],
    completionTelemetry: StrokeCompletionMonitor.Telemetry? = nil,
    poseHistory: [PoseFrame],
    poseModelVersion: String,
    preRollMs: Int,
    postRollMs: Int,
    /// Guided capture owns its finished recording and discards it after the
    /// trim; session capture exports from a STILL-ROLLING recording that must
    /// survive for later events.
    removeSourceRecording: Bool = true,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    let asset = AVURLAsset(url: artifact.url)
    guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
      completion(.failure(ClipMediaStoreError.exportUnavailable))
      return
    }

    let requestedStartTimestamp = event.startMs - preRollMs
    let requestedEndTimestamp = event.endMs + postRollMs
    let selectedStartTimestamp = max(artifact.firstFrameTimestampMs, requestedStartTimestamp)
    let selectedEndTimestamp = min(artifact.lastFrameTimestampMs, requestedEndTimestamp)
    guard selectedEndTimestamp > selectedStartTimestamp else {
      completion(.failure(ClipMediaStoreError.invalidMedia))
      return
    }

    let startSeconds = Double(selectedStartTimestamp - artifact.firstFrameTimestampMs) / 1000
    let durationSeconds = Double(selectedEndTimestamp - selectedStartTimestamp) / 1000
    let destination: URL
    do {
      destination = try capturesDirectory
        .appendingPathComponent("stroke-\(UUID().uuidString.lowercased()).mov")
    } catch {
      completion(.failure(error))
      return
    }

    export.outputURL = destination
    export.outputFileType = .mov
    export.shouldOptimizeForNetworkUse = false
    export.timeRange = CMTimeRange(
      start: CMTime(seconds: startSeconds, preferredTimescale: 600),
      duration: CMTime(seconds: durationSeconds, preferredTimescale: 600)
    )
    export.exportAsynchronously {
      switch export.status {
      case .completed:
        do {
          let actualPreRoll = max(0, event.startMs - selectedStartTimestamp)
          let actualPostRoll = max(0, selectedEndTimestamp - event.endMs)
          var trigger: [String: Any] = [
            "startMs": max(0, event.startMs - selectedStartTimestamp),
            "endMs": max(0, event.endMs - selectedStartTimestamp),
            "confidence": event.confidence,
            "source": "temporal_pose_motion",
            "modelVersion": detectionModelVersion,
          ]
          if let peakMotionMs = event.peakMotionMs {
            trigger["peakMotionMs"] = max(0, peakMotionMs - selectedStartTimestamp)
          }
          var additional: [String: Any] = [
            "preRollMs": actualPreRoll,
            "postRollMs": actualPostRoll,
            "trigger": trigger,
            "captureEvidence": captureEvidence,
            "ballSpeed": [
              "status": "unavailable",
              "reason": "calibrated_ball_tracker_unavailable",
            ],
            "recognition": recognitionPayload(event.recognition),
          ]
          if let completionTelemetry {
            // D-029 movement-completion instrumentation: recorded for BOTH
            // strategies (fixed default and flagged adaptive) with the same
            // clip-relative rebase as the trigger block, so offline replay
            // can compare FIXED vs ADAPTIVE decisions on real live captures.
            additional["completion"] = StrokeCompletionMonitor.payload(
              for: completionTelemetry,
              rebasedTo: selectedStartTimestamp
            )
          }
          if let poseSequenceRef = try writePoseSequenceSidecar(
            besideClipAt: destination,
            poseHistory: poseHistory,
            poseModelVersion: poseModelVersion,
            windowStartTimestampMs: selectedStartTimestamp,
            windowEndTimestampMs: selectedEndTimestamp
          ) {
            additional["poseSequence"] = poseSequenceRef
          }
          let payload = try measuredPayload(
            for: destination,
            captureMode: "automatic_pose_trigger",
            additional: additional
          )
          if removeSourceRecording { removeIfPresent(artifact.url) }
          completion(.success(payload))
        } catch {
          removeIfPresent(destination)
          completion(.failure(error))
        }
      case .cancelled:
        removeIfPresent(destination)
        completion(.failure(VisionFailure.cancelled))
      case .failed:
        removeIfPresent(destination)
        completion(.failure(
          ClipMediaStoreError.exportFailed(
            export.error?.localizedDescription ?? "The captured stroke could not be prepared."
          )
        ))
      default:
        break
      }
    }
  }

  static func importedPayload(for url: URL) throws -> [String: Any] {
    try measuredPayload(
      for: url,
      captureMode: "imported_video",
      additional: [
        "ballSpeed": [
          "status": "unavailable",
          "reason": "analysis_not_run",
        ],
        "recognition": recognitionPayload(
          .unknown(reason: "analysis_not_run")
        ),
      ]
    )
  }

  private static func measuredPayload(
    for url: URL,
    captureMode: String,
    additional: [String: Any]
  ) throws -> [String: Any] {
    let asset = AVURLAsset(url: url)
    guard let track = asset.tracks(withMediaType: .video).first else {
      throw ClipMediaStoreError.invalidMedia
    }
    let durationSeconds = CMTimeGetSeconds(asset.duration)
    guard durationSeconds.isFinite, durationSeconds > 0 else {
      throw ClipMediaStoreError.invalidMedia
    }
    let transformed = track.naturalSize.applying(track.preferredTransform)
    let width = Int(abs(transformed.width).rounded())
    let height = Int(abs(transformed.height).rounded())
    guard width > 0, height > 0 else { throw ClipMediaStoreError.invalidMedia }

    var payload: [String: Any] = [
      "uri": url.absoluteString,
      "durationMs": Int((durationSeconds * 1000).rounded()),
      "width": width,
      "height": height,
      "fps": Double(track.nominalFrameRate),
      "capturedAtIso": ISO8601DateFormatter().string(from: Date()),
      "captureMode": captureMode,
    ]
    if let size = try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber {
      payload["byteSize"] = size.int64Value
    }
    additional.forEach { payload[$0.key] = $0.value }
    return payload
  }

  /// Writes the measured pose sequence beside the clip in the canonical
  /// framework-neutral wire format (`pickle.pose-sequence.v1`) so any future
  /// model can reprocess this capture. Timestamps become clip-relative. When
  /// no frames landed inside the window, no sidecar is written — an honest
  /// absence, never an empty fabrication.
  private static func writePoseSequenceSidecar(
    besideClipAt clipURL: URL,
    poseHistory: [PoseFrame],
    poseModelVersion: String,
    windowStartTimestampMs: Int,
    windowEndTimestampMs: Int
  ) throws -> [String: Any]? {
    let clipAsset = AVURLAsset(url: clipURL)
    guard let track = clipAsset.tracks(withMediaType: .video).first else { return nil }
    let transformed = track.naturalSize.applying(track.preferredTransform)
    let width = Int(abs(transformed.width).rounded())
    let height = Int(abs(transformed.height).rounded())

    var frames: [[String: Any]] = []
    var frameIndex = 0
    for pose in poseHistory {
      guard pose.timestampMs >= windowStartTimestampMs,
            pose.timestampMs <= windowEndTimestampMs else { continue }
      let landmarks: [[String: Any]] = pose.landmarks.map { mark in
        ["n": mark.name, "x": mark.x, "y": mark.y, "v": mark.visibility]
      }
      frames.append([
        "i": frameIndex,
        "t": pose.timestampMs - windowStartTimestampMs,
        "c": pose.confidence,
        "l": landmarks,
      ])
      frameIndex += 1
    }
    guard !frames.isEmpty else { return nil }

    let document: [String: Any] = [
      "schemaVersion": 1,
      "format": "pickle.pose-sequence.v1",
      "coordinateSystem": "normalized_image_top_left",
      "poseModelVersion": poseModelVersion,
      "video": [
        "w": width,
        "h": height,
        "fps": Double(track.nominalFrameRate),
      ],
      "frames": frames,
    ]
    let data = try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys])
    let sidecarURL = clipURL.deletingPathExtension().appendingPathExtension("pose.json")
    try data.write(to: sidecarURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()

    return [
      "schemaVersion": 1,
      "format": "pickle.pose-sequence.v1",
      "uri": sidecarURL.absoluteString,
      "frameCount": frames.count,
      "sha256": digest,
      "coordinateSystem": "normalized_image_top_left",
      "poseModelVersion": poseModelVersion,
    ]
  }

  private static func recognitionPayload(_ recognition: StrokeRecognition) -> [String: Any] {
    var payload: [String: Any] = ["status": recognition.status.rawValue]
    if let shotType = recognition.shotType { payload["shotType"] = shotType }
    if let confidence = recognition.confidence { payload["confidence"] = confidence }
    if let reason = recognition.reason { payload["reason"] = reason }
    if let modelVersion = recognition.modelVersion { payload["modelVersion"] = modelVersion }
    return payload
  }
}
