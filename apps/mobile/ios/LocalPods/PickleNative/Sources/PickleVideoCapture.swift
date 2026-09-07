import AVFoundation
import Foundation
import PhotosUI
import React
import UniformTypeIdentifiers
import UIKit

/// React Native entry point for automatic guided capture and real video import.
/// It never returns a score or named stroke: guided capture returns a measured
/// clip plus an explicit unknown recognition until a validated classifier is
/// installed behind the native contract.
@objc(PickleVideoCapture)
final class PickleVideoCapture: RCTEventEmitter, PHPickerViewControllerDelegate {
  private enum Operation: Equatable {
    case guided(String)
    case importing(String)
    case extracting(String)
    case comparing(String)
  }

  private let importMediaQueue = DispatchQueue(label: "com.picklesensei.import-media", qos: .userInitiated)
  private var mediaOperation: ClipMediaOperation?
  private var guidedMediaOperation: ClipMediaOperation?
  private var mediaResult: Result<[String: Any], Error>?
  private var currentByteComparison: CurrentClipByteComparison?
  private var mediaCompletionEvent: [String: Any]?
  private var importPickerDismissing = false
  private var importSelectionReceived = false
  private var resolve: RCTPromiseResolveBlock?
  private var reject: RCTPromiseRejectBlock?
  private var operation: Operation?
  private weak var guidedController: GuidedCaptureViewController?
  private weak var importPicker: PHPickerViewController?
  private var hasEventListeners = false
  private var sessionCoordinator: SessionCaptureCoordinator?
  private let motionTimestampFormatter = ISO8601DateFormatter()

  @objc override static func requiresMainQueueSetup() -> Bool { true }

  deinit {
    guidedMediaOperation?.cancel()
    guidedMediaOperation?.cleanupOwnedOutputs()
  }

  override func supportedEvents() -> [String]! {
    ["PickleCameraEvent"]
  }

  override func startObserving() {
    hasEventListeners = true
  }

  override func stopObserving() {
    hasEventListeners = false
  }

  @objc func capture(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    beginGuidedCapture(handedness: nil, resolve: resolve, reject: reject)
  }

  @objc func captureWithOptions(
    _ options: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let value = options["handedness"] as? String,
          let handedness = TemporalStrokeDetector.Handedness(rawValue: value) else {
      reject("camera.invalid_options", "Choose your hitting hand before recording.", nil)
      return
    }
    beginGuidedCapture(handedness: handedness, resolve: resolve, reject: reject)
  }

  private func beginGuidedCapture(
    handedness: TemporalStrokeDetector.Handedness?,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let guidedOperation = ClipMediaOperation()
      let guidedId = guidedOperation.id
      guard self.begin(operation: .guided(guidedId), resolve: resolve, reject: reject) else { return }
      self.guidedMediaOperation = guidedOperation
      let engine = CameraEngine()
      self.emit([
        "type": "permission",
        "state": "requesting",
        "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
      ])
      Task {
        do {
          try await engine.requestPermissionAndConfigure()
          await MainActor.run {
            guard case .guided(let currentId)? = self.operation, currentId == guidedId else {
              engine.stop()
              return
            }
            self.emit([
              "type": "permission",
              "state": "granted",
              "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
            ])
            self.presentGuidedCapture(engine: engine, handedness: handedness, guidedId: guidedId)
          }
        } catch CameraEngine.EngineError.permissionDenied {
          await MainActor.run {
            guard case .guided(let currentId)? = self.operation, currentId == guidedId else { return }
            self.emit([
              "type": "permission",
              "state": "denied",
              "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
            ])
            self.finishWithError(
              code: "camera.permission_denied",
              message: "Allow camera access in Settings to analyze a stroke."
            )
          }
        } catch {
          await MainActor.run {
            guard case .guided(let currentId)? = self.operation, currentId == guidedId else { return }
            self.finishWithError(
              code: "camera.configuration_failed",
              message: error.localizedDescription,
              error: error
            )
          }
        }
      }
    }
  }

  @objc func importVideo(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let mediaOperation = ClipMediaOperation()
      let importId = mediaOperation.id
      guard self.begin(operation: .importing(importId), resolve: resolve, reject: reject) else { return }
      self.mediaOperation = mediaOperation

      var configuration = PHPickerConfiguration(photoLibrary: .shared())
      configuration.filter = .videos
      configuration.selectionLimit = 1
      configuration.preferredAssetRepresentationMode = .current
      let picker = PHPickerViewController(configuration: configuration)
      picker.delegate = self
      picker.modalPresentationStyle = .fullScreen

      guard let presenter = Self.topViewController() else {
        self.finishMediaOperation(mediaOperation, result: .failure(ImportMediaFailure(
          code: "camera.presentation_failed",
          message: "The video library could not be opened."
        )))
        return
      }
      self.importPicker = picker
      self.emitMedia([
        "type": "import",
        "state": "selecting",
        "captureId": importId,
        "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
      ], operation: mediaOperation)
      presenter.present(picker, animated: true)
    }
  }

  /// Reads a capture artifact (e.g. a pose-sequence sidecar) as UTF-8 text.
  /// Restricted to the app's private capture storage — this is an artifact
  /// reader for the analysis pipeline, not a general file API.
  @objc func readTextFile(
    _ uri: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      // A sidecar recorded before a rebuild names the OLD container path;
      // resolve it into today's Captures directory before the storage guard.
      guard
        let url = ClipMediaStore.resolveCaptureURL(fromStoredUri: uri),
        url.isFileURL
      else {
        reject("file.invalid_uri", "Only file:// URIs can be read.", nil)
        return
      }
      let standardized = url.standardizedFileURL.resolvingSymlinksInPath()
      guard let support = try? FileManager.default.url(
        for: .applicationSupportDirectory,
        in: .userDomainMask,
        appropriateFor: nil,
        create: false
      ) else {
        reject("file.unavailable", "Private storage is unavailable.", nil)
        return
      }
      let capturesRoot = support
        .appendingPathComponent("PickleSensei/Captures", isDirectory: true)
        .standardizedFileURL
        .resolvingSymlinksInPath()
      guard standardized.path.hasPrefix(capturesRoot.path + "/"), ClipMediaStore.isPrivateCaptureURL(standardized) else {
        reject("file.outside_captures", "Only private capture artifacts can be read.", nil)
        return
      }
      do {
        let values = try standardized.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true, let byteSize = values.fileSize,
              byteSize > 0, byteSize <= ProvisionalImportBudget.maximumSidecarBytes else {
          reject("file.invalid_artifact", "The capture artifact exceeds the supported size or is empty.", nil)
          return
        }
        let handle = try FileHandle(forReadingFrom: standardized)
        defer { try? handle.close() }
        guard let data = try handle.read(upToCount: ProvisionalImportBudget.maximumSidecarBytes + 1),
              data.count == byteSize,
              let contents = String(data: data, encoding: .utf8) else {
          reject("file.invalid_artifact", "The capture artifact is not valid UTF-8 text.", nil)
          return
        }
        resolve(contents)
      } catch {
        reject("file.read_failed", "The capture artifact could not be read.", error)
      }
    }
  }

  /// Fresh bounded comparison to unsigned supplied metadata. Not certification
  /// of original media, an owner, rights or attestation; never writes artifacts.
  @objc func compareCapturedClipBytes(
    _ request: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let expectation: NativeClipByteExpectation
    do {
      expectation = try NativeClipByteExpectation(request: request)
    } catch {
      reject(NativeClipByteExpectation.invalid.code, NativeClipByteExpectation.invalid.message, error)
      return
    }
    DispatchQueue.main.async {
      let mediaOperation = ClipMediaOperation(id: expectation.operationId)
      guard self.begin(operation: .comparing(mediaOperation.id), resolve: resolve, reject: reject) else { return }
      self.mediaOperation = mediaOperation
      self.armMediaDeadline(mediaOperation, seconds: ProvisionalImportBudget.copyTimeoutSeconds)
      guard mediaOperation.startWork() else {
        self.cancelMediaOperation(mediaOperation, reason: .timedOut)
        return
      }
      self.importMediaQueue.async {
        let result = Result {
          try ClipMediaStore.compareCapturedClipBytes(expectation, operation: mediaOperation)
        }
        mediaOperation.endWork()
        DispatchQueue.main.async {
          guard self.mediaOperation === mediaOperation,
                case .comparing(let currentId)? = self.operation, currentId == mediaOperation.id else {
            mediaOperation.cancel()
            return
          }
          switch result {
          case .success(let comparison):
            self.currentByteComparison = comparison
            self.finishMediaOperation(mediaOperation, result: .success(comparison.payload))
          case .failure(let error):
            self.finishMediaOperation(mediaOperation, result: .failure(error))
          }
        }
      }
    }
  }

  /// Imported clips arrive without the pose sidecar guided capture produces
  /// live, so they cannot be analyzed. Longer imports would grind through
  /// tens of thousands of Vision calls, so processing is capped at 60s.
  private static let importedPoseMaxDurationSeconds = 60.0

  /// Extracts a REAL pose sequence from an already-imported video so imported
  /// clips become analyzable exactly like guided captures: the sidecar is
  /// written by the same `pickle.pose-sequence.v1` writer (identical JSON
  /// schema, sha256 over the exact bytes on disk, same directory
  /// conventions). Honesty rules: timestamps are true frame presentation
  /// times rebased so the first decoded frame is 0; frames where Vision finds
  /// no person are honest gaps — never interpolated or duplicated.
  ///
  /// Request: { uri: file:// URL inside the app's Captures dir,
  ///            seedX?/seedY?: normalized (0..1, top-left origin) "tap
  ///            yourself" seed applied BEFORE the first frame }.
  @objc func extractImportedPoseSequence(
    _ request: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let uri = request["uri"] as? String else {
      reject("camera.invalid_extraction_request", "The pose extraction request is missing 'uri'.", nil)
      return
    }
    let requestedId = request["operationId"] ?? UUID().uuidString.lowercased()
    guard let operationId = requestedId as? String,
          operationId.range(of: "^[A-Za-z0-9_-]{1,128}\\z", options: .regularExpression) != nil else {
      reject("camera.invalid_extraction_request", "The import operation id is invalid.", nil)
      return
    }
    let seedX = (request["seedX"] as? NSNumber)?.doubleValue
    let seedY = (request["seedY"] as? NSNumber)?.doubleValue
    if request["seedX"] != nil || request["seedY"] != nil {
      guard let seedX, let seedY, seedX.isFinite, seedY.isFinite,
            (0...1).contains(seedX), (0...1).contains(seedY) else {
        reject("camera.invalid_extraction_request", "The target seed must be inside the video frame.", nil)
        return
      }
    }

    DispatchQueue.main.async {
      let mediaOperation = ClipMediaOperation(id: operationId)
      guard self.begin(operation: .extracting(operationId), resolve: resolve, reject: reject) else { return }
      self.mediaOperation = mediaOperation
      self.armMediaDeadline(mediaOperation, seconds: ProvisionalImportBudget.extractionTimeoutSeconds)
      guard mediaOperation.startWork() else {
        self.cancelMediaOperation(mediaOperation, reason: .timedOut)
        return
      }
      self.importMediaQueue.async {
        let result = Result {
          try autoreleasepool {
            try self.performImportedPoseExtraction(
              uri: uri, seedX: seedX, seedY: seedY, mediaOperation: mediaOperation
            )
          }
        }
        self.finishMediaOperation(mediaOperation, result: result, completionEvent: [
          "type": "import_pose_extraction",
          "state": "completed",
          "progress": 1.0,
          "captureId": ClipMediaStore.fileURL(from: uri)?.deletingPathExtension().lastPathComponent ?? operationId,
          "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
        ])
      }
    }
  }

  private func performImportedPoseExtraction(
    uri: String,
    seedX: Double?,
    seedY: Double?,
    mediaOperation: ClipMediaOperation
  ) throws -> [String: Any] {
    try mediaOperation.checkActive()
    // Same private-storage guard as readTextFile: this analyzes the app's
    // own capture artifacts, it is not a general video-processing API.
    guard let url = ClipMediaStore.resolveCaptureURL(fromStoredUri: uri), url.isFileURL else {
      throw ImportMediaFailure(code: "file.invalid_uri", message: "Only file:// URIs can be analyzed.")
    }
    let videoURL = url.standardizedFileURL.resolvingSymlinksInPath()
    guard let support = try? FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: false
    ) else {
      throw ImportMediaFailure(code: "file.unavailable", message: "Private storage is unavailable.")
    }
    let capturesRoot = support
      .appendingPathComponent("PickleSensei/Captures", isDirectory: true)
      .standardizedFileURL
      .resolvingSymlinksInPath()
    guard videoURL.path.hasPrefix(capturesRoot.path + "/"), ClipMediaStore.isPrivateCaptureURL(videoURL) else {
      throw ImportMediaFailure(code: "file.outside_captures", message: "Only private capture videos can be analyzed.")
    }

    let captureId = videoURL.deletingPathExtension().lastPathComponent
    let metadata = try ClipMediaStore.preflightImport(from: videoURL, operation: mediaOperation)
    let asset = metadata.asset
    let track = metadata.track
    let durationSeconds = metadata.durationSeconds
    guard durationSeconds <= Self.importedPoseMaxDurationSeconds else {
      throw ImportMediaFailure(code: "camera.import_too_long", message: "Trim this video to 60 seconds or less and import it again.")
    }

    let reader = try AVAssetReader(asset: asset)
    let readerCancellation = mediaOperation.onCancel { reader.cancelReading() }
    defer {
      reader.cancelReading()
      mediaOperation.removeCancellationHandler(readerCancellation)
    }
    try mediaOperation.checkActive()
    // Offline decode: no realtime constraint, same biplanar 4:2:0 format
    // the live capture pipeline feeds Vision.
    let output = AVAssetReaderTrackOutput(
      track: track,
      outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
      ]
    )
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else {
      throw ImportMediaFailure(code: "camera.import_pose_failed", message: "The video frames could not be decoded.")
    }
    reader.add(output)
    guard reader.startReading() else {
      throw reader.error ?? ImportMediaFailure(code: "camera.import_pose_failed", message: "The video could not be read.")
    }

    // FRESH provider per extraction: primary-person stickiness must never
    // leak across videos. A tap seed initializes WHICH person is primary
    // before the first frame; temporal stickiness then follows them.
    let poseProvider = ApplePoseProvider()
    if let seedX, let seedY {
      poseProvider.setPrimaryPersonSeed(x: seedX, y: seedY)
    }

    // ≤61fps processing budget via interval decimation on REAL presentation
    // timestamps: the epsilon absorbs sub-millisecond PTS jitter so genuine
    // ≤61fps video is never decimated, while 120/240fps slo-mo settles at
    // ~60fps. Skipped frames are simply not processed — the kept frames
    // keep their true PTS, so the timeline is never resampled.
    let minimumIntervalMs = 1000.0 / 61.0 - 0.51
    let durationMs = durationSeconds * 1000
    // Imported files carry their rotation in preferredTransform while the
    // reader vends UNROTATED buffers. Vision must be told the mapping so
    // landmarks come back in display-normalized space — the same space the
    // payload's width/height and the user's player tap use. (Guided capture
    // is unaffected: its connection delivers upright buffers.)
    let orientation = Self.imageOrientation(for: track.preferredTransform)
    var firstFramePTS: CMTime?
    var lastKeptElapsedMs = -Double.infinity
    var lastKeptTimestampMs = 0
    var framesDecoded = 0
    var framesProcessed = 0
    var poses: [PoseFrame] = []
    var nextProgressEmission = 0.1

    emitMedia([
      "type": "import_pose_extraction",
      "state": "extracting",
      "progress": 0.0,
      "captureId": captureId,
      "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
    ], operation: mediaOperation)

    while true {
      try mediaOperation.checkActive()
      let hasSample = try autoreleasepool { () throws -> Bool in
        guard let sample = output.copyNextSampleBuffer() else { return false }
        try mediaOperation.checkActive()
        framesDecoded += 1
        guard framesDecoded <= ProvisionalImportBudget.maximumDecodedFrames else { throw ImportMediaFailure.resourceLimit }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        guard pts.isNumeric, let pixelBuffer = CMSampleBufferGetImageBuffer(sample) else { return true }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        guard width > 0, height > 0,
              width <= ProvisionalImportBudget.maximumFrameDimension,
              height <= ProvisionalImportBudget.maximumFrameDimension,
              width * height <= ProvisionalImportBudget.maximumFramePixels,
              CVPixelBufferGetDataSize(pixelBuffer) <= ProvisionalImportBudget.maximumDecodedFrameBytes else {
          throw ImportMediaFailure.resourceLimit
        }
        let anchor: CMTime
        if let existing = firstFramePTS {
          anchor = existing
        } else {
          firstFramePTS = pts
          anchor = pts
        }
        let elapsedMs = CMTimeGetSeconds(CMTimeSubtract(pts, anchor)) * 1000
        // REAL frame PTS only: a sample that rewinds time is skipped (an
        // honest gap) rather than remapped onto a fabricated axis.
        guard elapsedMs.isFinite, elapsedMs >= 0 else { return true }
        guard elapsedMs <= Self.importedPoseMaxDurationSeconds * 1000 else {
          throw ImportMediaFailure(code: "camera.import_too_long", message: "Trim this video to 60 seconds or less and import it again.")
        }
        guard elapsedMs <= durationMs + 1 else { throw ClipMediaStoreError.invalidMedia }
        guard elapsedMs - lastKeptElapsedMs >= minimumIntervalMs else { return true }
        lastKeptElapsedMs = elapsedMs
        let timestampMs = Int(elapsedMs.rounded())
        lastKeptTimestampMs = timestampMs
        framesProcessed += 1
        guard framesProcessed <= ProvisionalImportBudget.maximumPoseFrames else { throw ImportMediaFailure.resourceLimit }
        try mediaOperation.checkActive()
        // Extraction failures (no person, no landmarks) leave a gap; the
        // sequence only ever contains measured poses.
        if let pose = try? poseProvider.extractPose(
          pixelBuffer: pixelBuffer,
          timestampMs: timestampMs,
          orientation: orientation
        ) {
          guard pose.landmarks.count <= ProvisionalImportBudget.maximumLandmarksPerPose else { throw ImportMediaFailure.resourceLimit }
          poses.append(pose)
        }
        try mediaOperation.checkActive()
        let progress = min(1.0, elapsedMs / max(durationMs, 1.0))
        if progress >= nextProgressEmission {
          nextProgressEmission = progress + 0.1
          emitMedia([
            "type": "import_pose_extraction",
            "state": "extracting",
            "progress": progress,
            "captureId": captureId,
            "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
          ], operation: mediaOperation)
        }
        return true
      }
      if !hasSample { break }
    }

    try mediaOperation.checkActive()
    guard reader.status == .completed else {
      throw reader.error ?? ImportMediaFailure(code: "camera.import_pose_failed", message: "The video frames could not be decoded.")
    }
    guard framesProcessed > 0 else {
      throw ImportMediaFailure(code: "camera.invalid_media", message: "The video does not contain decodable frames.")
    }
    guard !poses.isEmpty else {
      throw ImportMediaFailure(code: "camera.import_no_person", message: "No person could be tracked in this video.")
    }

    guard let poseSequence = try ClipMediaStore.writeImportedPoseSequenceSidecar(
      besideVideoAt: videoURL,
      poseHistory: poses,
      poseModelVersion: poseProvider.modelVersion,
      windowEndTimestampMs: lastKeptTimestampMs,
      metadata: metadata,
      operation: mediaOperation
    ) else {
      throw ImportMediaFailure(code: "camera.import_pose_failed", message: "The pose sequence could not be persisted.")
    }
    // framesTotal counts frames pose extraction actually RAN on (after
    // fps decimation) so framesWithPose/framesTotal is an honest coverage
    // ratio of the analyzed timeline.
    var payload: [String: Any] = [
      "poseSequence": poseSequence,
      "framesWithPose": poses.count,
      "framesTotal": framesProcessed,
    ]
    if let posterURL = ClipMediaStore.writePosterFrame(besideVideoAt: videoURL, operation: mediaOperation, metadata: metadata) {
      payload["posterUri"] = posterURL.absoluteString
    }
    try mediaOperation.checkActive()
    return payload
  }

  /// D-029 instrumentation switch: selects the movement-completion strategy
  /// for FUTURE guided captures ("fixed" | "adaptive"). Process-wide,
  /// non-persistent, and ALWAYS "fixed" at launch — the shipped default never
  /// changes unless a caller explicitly flips it for a session. Adaptive is a
  /// measured D-029 candidate, not a promotion; captures record completion
  /// telemetry under BOTH strategies either way. Resolves with the effective
  /// strategy so callers cannot assume a silent success.
  @objc func setCompletionStrategy(
    _ strategy: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let parsed = CaptureCompletionStrategy(rawValue: strategy) else {
      reject(
        "camera.invalid_completion_strategy",
        "Unknown completion strategy '\(strategy)'. Expected 'fixed' or 'adaptive'.",
        nil
      )
      return
    }
    resolve(CaptureCompletionStrategyStore.set(parsed).rawValue)
  }

  /// D-040 Gap 1+2: starts the continuous session capture. Resolves with the
  /// session receipt once the camera is recording; wrist-motion samples then
  /// stream as `session_motion_sample` PickleCameraEvents (frozen `{tMs, v}`
  /// contract) until stopSessionCapture. One session capture at a time —
  /// concurrent guided capture is allowed to stay independent, but a second
  /// session capture is rejected.
  @objc func startSessionCapture(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard self.sessionCoordinator == nil else {
        reject("camera.session_busy", "A session capture is already active.", nil)
        return
      }
      let coordinator = SessionCaptureCoordinator()
      coordinator.onMotionSample = { [weak self] tMs, v in
        guard let self else { return }
        self.emit([
          "type": "session_motion_sample",
          "tMs": tMs,
          "v": v,
          "captureId": coordinator.captureId,
          "emittedAtIso": self.motionTimestampFormatter.string(from: Date()),
        ])
      }
      self.sessionCoordinator = coordinator
      Task {
        do {
          try await coordinator.start()
          await MainActor.run {
            // Court sessions run minutes with nobody touching the phone;
            // auto-lock would kill the rolling recording mid-session.
            // Restored when the session capture stops.
            UIApplication.shared.isIdleTimerDisabled = true
            resolve(["sessionCaptureId": coordinator.captureId])
          }
        } catch CameraEngine.EngineError.permissionDenied {
          await MainActor.run {
            self.sessionCoordinator = nil
            reject(
              "camera.permission_denied",
              "Allow camera access in Settings to record a session.",
              nil
            )
          }
        } catch {
          await MainActor.run {
            self.sessionCoordinator = nil
            reject("camera.session_start_failed", error.localizedDescription, error)
          }
        }
      }
    }
  }

  @objc func stopSessionCapture(
    _ sessionCaptureId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard let coordinator = self.sessionCoordinator,
            coordinator.captureId == sessionCaptureId else {
        reject("camera.session_not_found", "No active session capture matches this id.", nil)
        return
      }
      self.sessionCoordinator = nil
      coordinator.stop()
      UIApplication.shared.isIdleTimerDisabled = false
      resolve(true)
    }
  }

  /// Cuts one closed event's clip (plus pose sidecar) from the rolling
  /// session recording. Bounds are the JS session engine's exact proposal
  /// bounds on the session-relative axis; the receipt is the same measured
  /// automatic-capture payload guided capture returns.
  @objc func extractSessionEventClip(
    _ request: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard
        let sessionCaptureId = request["sessionCaptureId"] as? String,
        let startMs = (request["startMs"] as? NSNumber)?.intValue,
        let endMs = (request["endMs"] as? NSNumber)?.intValue,
        let confidence = (request["confidence"] as? NSNumber)?.doubleValue,
        let detectionModelVersion = request["detectionModelVersion"] as? String
      else {
        reject("camera.invalid_extraction_request", "The event clip request is malformed.", nil)
        return
      }
      let peakMs = (request["peakMs"] as? NSNumber)?.intValue
      guard let coordinator = self.sessionCoordinator,
            coordinator.captureId == sessionCaptureId else {
        reject("camera.session_not_found", "No active session capture matches this id.", nil)
        return
      }
      coordinator.extract(
        eventStartMs: startMs,
        eventEndMs: endMs,
        peakMs: peakMs,
        confidence: confidence,
        detectionModelVersion: detectionModelVersion
      ) { result in
        DispatchQueue.main.async {
          switch result {
          case .success(let payload): resolve(payload)
          case .failure(let error):
            reject("camera.extraction_failed", error.localizedDescription, error)
          }
        }
      }
    }
  }

  @objc func cancel() {
    DispatchQueue.main.async {
      if let mediaOperation = self.mediaOperation {
        self.cancelMediaOperation(mediaOperation)
        return
      }
      if let guidedOperation = self.guidedMediaOperation {
        guidedOperation.cancel()
        guidedOperation.cleanupOwnedOutputs()
        if let guided = self.guidedController {
          guided.cancelFromBridge()
        } else {
          self.finishWithError(code: "camera.cancelled", message: "Camera capture was canceled.")
        }
        return
      }
      if self.operation != nil {
        self.finishWithError(code: "camera.cancelled", message: "Camera capture was canceled.")
      }
    }
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    guard let mediaOperation, importPicker === picker, !importSelectionReceived,
          !mediaOperation.isCancelled,
          case .importing(let importId)? = operation, importId == mediaOperation.id else { return }
    importSelectionReceived = true
    guard let provider = results.first?.itemProvider else {
      emitMedia([
        "type": "abstained",
        "reason": "user_cancelled",
        "captureId": importId,
        "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
      ], operation: mediaOperation)
      cancelMediaOperation(mediaOperation)
      return
    }

    let movieIdentifier = provider.registeredTypeIdentifiers.first {
      UTType($0)?.conforms(to: .movie) == true
    } ?? UTType.movie.identifier
    guard provider.hasItemConformingToTypeIdentifier(movieIdentifier) else {
      finishMediaOperation(mediaOperation, result: .failure(ImportMediaFailure(
        code: "camera.invalid_media",
        message: "The selected item is not a supported video."
      )))
      return
    }

    emitMedia([
      "type": "import",
      "state": "copying",
      "captureId": importId,
      "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
    ], operation: mediaOperation)
    armMediaDeadline(mediaOperation, seconds: ProvisionalImportBudget.copyTimeoutSeconds)
    let progress = provider.loadFileRepresentation(forTypeIdentifier: movieIdentifier) { [weak self] url, error in
      guard mediaOperation.startWork() else { return }
      guard let self else {
        mediaOperation.cancel()
        mediaOperation.endWork()
        mediaOperation.cleanupOwnedOutputs()
        return
      }
      let result: Result<[String: Any], Error> = self.importMediaQueue.sync {
        Result {
          try autoreleasepool {
            try mediaOperation.checkActive()
            if let error { throw error }
            guard let url else { throw ClipMediaStoreError.invalidMedia }
            // The provider URL is ephemeral and must be copied before this callback
            // returns. The destination uses data protection in Application Support.
            let metadata = try ClipMediaStore.preflightImport(from: url, operation: mediaOperation, copying: true)
            let destination = try ClipMediaStore.persistImportedVideo(from: url, metadata: metadata, operation: mediaOperation)
            // Poster/metadata describe the completed private copy, not the
            // ephemeral provider URL (which may change or disappear on return).
            let copiedMetadata = try ClipMediaStore.preflightImport(from: destination, operation: mediaOperation)
            return try ClipMediaStore.importedPayload(for: destination, metadata: copiedMetadata, operation: mediaOperation)
          }
        }
      }
      self.finishMediaOperation(mediaOperation, result: result, completionEvent: [
        "type": "import",
        "state": "completed",
        "captureId": importId,
        "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
      ])
    }
    _ = mediaOperation.onCancel { progress.cancel() }
  }

  private func armMediaDeadline(_ mediaOperation: ClipMediaOperation, seconds: TimeInterval) {
    mediaOperation.setDeadline(seconds: seconds)
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self, weak mediaOperation] in
      guard let self, let mediaOperation, self.mediaOperation === mediaOperation else { return }
      self.cancelMediaOperation(mediaOperation, reason: .timedOut)
    }
  }

  private func cancelMediaOperation(_ mediaOperation: ClipMediaOperation, reason: ImportMediaFailure = .cancelled) {
    guard self.mediaOperation === mediaOperation else { return }
    let callback = reject
    resolve = nil
    reject = nil
    mediaOperation.cancel(reason)
    callback?(reason.code, reason.message, reason)
    finishMediaOperationIfReady(mediaOperation)
  }

  private func finishMediaOperation(
    _ mediaOperation: ClipMediaOperation,
    result: Result<[String: Any], Error>,
    completionEvent: [String: Any]? = nil
  ) {
    mediaOperation.endWork()
    DispatchQueue.main.async {
      guard self.mediaOperation === mediaOperation else {
        mediaOperation.cleanupOwnedOutputs()
        return
      }
      self.mediaResult = result
      self.mediaCompletionEvent = completionEvent
      self.finishMediaOperationIfReady(mediaOperation)
    }
  }

  private func finishMediaOperationIfReady(_ mediaOperation: ClipMediaOperation) {
    guard self.mediaOperation === mediaOperation else { return }
    if let picker = importPicker {
      guard !importPickerDismissing else { return }
      importPickerDismissing = true
      picker.dismiss(animated: true) {
        guard self.mediaOperation === mediaOperation else { return }
        self.importPicker = nil
        self.importPickerDismissing = false
        self.finishMediaOperationIfReady(mediaOperation)
      }
      return
    }
    guard !mediaOperation.isWorking else { return }
    do {
      try mediaOperation.checkActive()
      guard let mediaResult else { return }
      let payload = try mediaResult.get()
      if case .comparing(let currentId)? = operation {
        guard currentId == mediaOperation.id, let comparison = currentByteComparison else {
          throw NativeClipByteExpectation.invalid
        }
        // Final descriptor/path check on the publication queue, after the exact
        // operation epoch and drain fences; no asynchronous hop before resolve.
        try comparison.verifyUnchanged(operation: mediaOperation)
      }
      try mediaOperation.commitOwnedOutputs()
      let callback = resolve
      if let event = mediaCompletionEvent { emitMedia(event, operation: mediaOperation) }
      clearOperation()
      callback?(payload)
    } catch {
      let fallbackCode: String
      if case .extracting? = operation {
        fallbackCode = "camera.import_pose_failed"
        if reject != nil, var event = mediaCompletionEvent {
          event["state"] = "failed"
          event.removeValue(forKey: "progress")
          emitMedia(event, operation: mediaOperation)
        }
      } else if case .comparing? = operation {
        fallbackCode = "camera.byte_comparison_unavailable"
      } else {
        fallbackCode = "camera.import_failed"
      }
      let failure = error as? ImportMediaFailure ?? ImportMediaFailure(
        code: error is ClipMediaStoreError ? "camera.invalid_media" : fallbackCode,
        message: error.localizedDescription
      )
      mediaOperation.cancel(failure)
      mediaOperation.cleanupOwnedOutputs()
      let callback = reject
      clearOperation()
      callback?(failure.code, failure.message, error)
    }
  }

  private func emitMedia(_ payload: [String: Any], operation mediaOperation: ClipMediaOperation) {
    let send = {
      guard self.mediaOperation === mediaOperation, !mediaOperation.isCancelled, self.hasEventListeners else { return }
      var payload = payload
      payload["operationId"] = mediaOperation.id
      self.sendEvent(withName: "PickleCameraEvent", body: payload)
    }
    if Thread.isMainThread { send() } else { DispatchQueue.main.async(execute: send) }
  }

  private func begin(
    operation: Operation,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) -> Bool {
    guard self.operation == nil, self.mediaOperation == nil, self.guidedMediaOperation == nil else {
      reject("camera.busy", "Another camera operation is already active.", nil)
      return false
    }
    self.operation = operation
    self.resolve = resolve
    self.reject = reject
    return true
  }

  private func presentGuidedCapture(
    engine: CameraEngine,
    handedness: TemporalStrokeDetector.Handedness?,
    guidedId: String
  ) {
    guard let presenter = Self.topViewController() else {
      engine.stop()
      finishWithError(
        code: "camera.presentation_failed",
        message: "The guided camera could not be opened."
      )
      return
    }

    guard let guidedOperation = guidedMediaOperation, guidedOperation.id == guidedId,
          !guidedOperation.isCancelled else {
      engine.stop()
      finishWithError(code: "camera.cancelled", message: "Camera capture was canceled.")
      return
    }
    let controller = GuidedCaptureViewController(engine: engine, operation: guidedOperation, handedness: handedness)
    guidedController = controller
    controller.onEvent = { [weak self] event in
      let send = {
        guard let self, self.guidedMediaOperation === guidedOperation,
              case .guided(let currentId)? = self.operation, currentId == guidedId,
              !guidedOperation.isCancelled || event["type"] as? String == "abstained",
              self.hasEventListeners else { return }
        self.sendEvent(withName: "PickleCameraEvent", body: event)
      }
      if Thread.isMainThread { send() } else { DispatchQueue.main.async(execute: send) }
    }
    controller.onComplete = { [weak self, weak controller] result in
      guard let self, let controller, self.guidedMediaOperation === guidedOperation,
            case .guided(let currentId)? = self.operation, currentId == guidedId else {
        guidedOperation.cancel()
        guidedOperation.cleanupOwnedOutputs()
        return
      }
      controller.dismiss(animated: true) {
        guard self.guidedMediaOperation === guidedOperation,
              case .guided(let currentId)? = self.operation, currentId == guidedId else {
          guidedOperation.cancel()
          guidedOperation.cleanupOwnedOutputs()
          return
        }
        do {
          let payload = try result.get()
          try guidedOperation.checkActive()
          guard self.resolve != nil, JSONSerialization.isValidJSONObject(payload) else {
            throw ClipMediaStoreError.invalidEvidence
          }
          // Main queue + exact native operation identity is the owner epoch.
          // There is no async hop between revalidation, commit, and publication.
          try guidedOperation.commitOwnedOutputs()
          controller.didPublishClip(payload)
          self.finishWithSuccess(payload)
        } catch {
          guidedOperation.cancel()
          guidedOperation.cleanupOwnedOutputs()
          let failure = error as? GuidedCaptureFailure
          self.finishWithError(
            code: failure?.code ?? (error as? ImportMediaFailure)?.code ?? "camera.processing_failed",
            message: failure?.message ?? error.localizedDescription,
            error: error
          )
        }
      }
    }
    presenter.present(controller, animated: true)
  }

  private func emit(_ payload: [String: Any]) {
    guard hasEventListeners else { return }
    DispatchQueue.main.async {
      guard self.hasEventListeners else { return }
      self.sendEvent(withName: "PickleCameraEvent", body: payload)
    }
  }

  private func finishWithSuccess(_ payload: [String: Any]) {
    let callback = resolve
    clearOperation()
    callback?(payload)
  }

  private func finishWithError(code: String, message: String, error: Error? = nil) {
    let callback = reject
    clearOperation()
    callback?(code, message, error)
  }

  private func clearOperation() {
    if let guidedOperation = guidedMediaOperation {
      guidedOperation.cancel()
      guidedOperation.afterWorkDrains { [weak self] in
        guidedOperation.cleanupOwnedOutputs()
        let clear = {
          guard let self, self.guidedMediaOperation === guidedOperation else { return }
          self.guidedMediaOperation = nil
        }
        if Thread.isMainThread { clear() } else { DispatchQueue.main.async(execute: clear) }
      }
    }
    resolve = nil
    reject = nil
    operation = nil
    guidedController = nil
    importPicker = nil
    mediaOperation = nil
    mediaResult = nil
    currentByteComparison = nil
    mediaCompletionEvent = nil
    importPickerDismissing = false
    importSelectionReceived = false
  }

  /// Standard mapping from a video track's preferredTransform to the Vision
  /// orientation of its buffers (rotation only; recorded video never mirrors).
  private static func imageOrientation(for transform: CGAffineTransform) -> CGImagePropertyOrientation {
    if transform.a == 0, transform.b == 1, transform.c == -1, transform.d == 0 { return .right }
    if transform.a == 0, transform.b == -1, transform.c == 1, transform.d == 0 { return .left }
    if transform.a == -1, transform.b == 0, transform.c == 0, transform.d == -1 { return .down }
    return .up
  }

  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow)
      ?? scenes.first?.windows.first
    var current = window?.rootViewController
    while let presented = current?.presentedViewController { current = presented }
    if let navigation = current as? UINavigationController {
      return navigation.visibleViewController
    }
    if let tabs = current as? UITabBarController {
      return tabs.selectedViewController
    }
    return current
  }
}
