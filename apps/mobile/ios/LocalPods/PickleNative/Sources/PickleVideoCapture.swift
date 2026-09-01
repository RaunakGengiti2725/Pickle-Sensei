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
  private enum Operation {
    case guided
    case importing(String)
  }

  private var resolve: RCTPromiseResolveBlock?
  private var reject: RCTPromiseRejectBlock?
  private var operation: Operation?
  private weak var guidedController: GuidedCaptureViewController?
  private weak var importPicker: PHPickerViewController?
  private var hasEventListeners = false
  private var sessionCoordinator: SessionCaptureCoordinator?
  private let motionTimestampFormatter = ISO8601DateFormatter()

  @objc override static func requiresMainQueueSetup() -> Bool { true }

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
    DispatchQueue.main.async {
      guard self.begin(operation: .guided, resolve: resolve, reject: reject) else { return }
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
            guard case .guided? = self.operation else {
              engine.stop()
              return
            }
            self.emit([
              "type": "permission",
              "state": "granted",
              "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
            ])
            self.presentGuidedCapture(engine: engine)
          }
        } catch CameraEngine.EngineError.permissionDenied {
          await MainActor.run {
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
      let importId = UUID().uuidString.lowercased()
      guard self.begin(operation: .importing(importId), resolve: resolve, reject: reject) else { return }

      var configuration = PHPickerConfiguration(photoLibrary: .shared())
      configuration.filter = .videos
      configuration.selectionLimit = 1
      configuration.preferredAssetRepresentationMode = .current
      let picker = PHPickerViewController(configuration: configuration)
      picker.delegate = self
      picker.modalPresentationStyle = .fullScreen

      guard let presenter = Self.topViewController() else {
        self.finishWithError(
          code: "camera.presentation_failed",
          message: "The video library could not be opened."
        )
        return
      }
      self.importPicker = picker
      self.emit([
        "type": "import",
        "state": "selecting",
        "captureId": importId,
        "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
      ])
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
      guard let url = URL(string: uri), url.isFileURL else {
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
      guard standardized.path.hasPrefix(capturesRoot.path + "/") else {
        reject("file.outside_captures", "Only private capture artifacts can be read.", nil)
        return
      }
      do {
        let contents = try String(contentsOf: standardized, encoding: .utf8)
        resolve(contents)
      } catch {
        reject("file.read_failed", "The capture artifact could not be read.", error)
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
    let seedX = (request["seedX"] as? NSNumber)?.doubleValue
    let seedY = (request["seedY"] as? NSNumber)?.doubleValue

    DispatchQueue.global(qos: .userInitiated).async {
      // Same private-storage guard as readTextFile: this analyzes the app's
      // own capture artifacts, it is not a general video-processing API.
      guard let url = URL(string: uri), url.isFileURL else {
        reject("file.invalid_uri", "Only file:// URIs can be analyzed.", nil)
        return
      }
      let videoURL = url.standardizedFileURL.resolvingSymlinksInPath()
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
      guard videoURL.path.hasPrefix(capturesRoot.path + "/") else {
        reject("file.outside_captures", "Only private capture videos can be analyzed.", nil)
        return
      }

      let captureId = videoURL.deletingPathExtension().lastPathComponent
      let fail: (String, String, Error?) -> Void = { code, message, error in
        self.emit([
          "type": "import_pose_extraction",
          "state": "failed",
          "captureId": captureId,
          "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
        ])
        reject(code, message, error)
      }

      let asset = AVURLAsset(url: videoURL)
      guard let track = asset.tracks(withMediaType: .video).first else {
        fail("camera.invalid_media", "The video does not contain a video track.", nil)
        return
      }
      let durationSeconds = CMTimeGetSeconds(asset.duration)
      guard durationSeconds.isFinite, durationSeconds > 0 else {
        fail("camera.invalid_media", "The video duration could not be read.", nil)
        return
      }
      guard durationSeconds <= Self.importedPoseMaxDurationSeconds else {
        fail(
          "camera.import_too_long",
          "This video is \(Int(durationSeconds.rounded())) seconds long. Trim it to under 60 seconds and import it again.",
          nil
        )
        return
      }

      let reader: AVAssetReader
      do {
        reader = try AVAssetReader(asset: asset)
      } catch {
        fail("camera.import_pose_failed", error.localizedDescription, error)
        return
      }
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
        fail("camera.import_pose_failed", "The video frames could not be decoded.", nil)
        return
      }
      reader.add(output)
      guard reader.startReading() else {
        fail(
          "camera.import_pose_failed",
          reader.error?.localizedDescription ?? "The video could not be read.",
          reader.error
        )
        return
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
      var framesProcessed = 0
      var poses: [PoseFrame] = []
      var nextProgressEmission = 0.1
      var reachedCap = false

      self.emit([
        "type": "import_pose_extraction",
        "state": "extracting",
        "progress": 0.0,
        "captureId": captureId,
        "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
      ])

      while !reachedCap, let sample = output.copyNextSampleBuffer() {
        autoreleasepool {
          let pts = CMSampleBufferGetPresentationTimeStamp(sample)
          guard pts.isNumeric, let pixelBuffer = CMSampleBufferGetImageBuffer(sample) else { return }
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
          guard elapsedMs.isFinite, elapsedMs >= 0 else { return }
          if elapsedMs > Self.importedPoseMaxDurationSeconds * 1000 {
            reachedCap = true
            return
          }
          guard elapsedMs - lastKeptElapsedMs >= minimumIntervalMs else { return }
          lastKeptElapsedMs = elapsedMs
          let timestampMs = Int(elapsedMs.rounded())
          lastKeptTimestampMs = timestampMs
          framesProcessed += 1
          // Extraction failures (no person, no landmarks) leave a gap; the
          // sequence only ever contains measured poses.
          if let pose = try? poseProvider.extractPose(
            pixelBuffer: pixelBuffer,
            timestampMs: timestampMs,
            orientation: orientation
          ) {
            poses.append(pose)
          }
          let progress = min(1.0, elapsedMs / max(durationMs, 1.0))
          if progress >= nextProgressEmission {
            nextProgressEmission = progress + 0.1
            self.emit([
              "type": "import_pose_extraction",
              "state": "extracting",
              "progress": progress,
              "captureId": captureId,
              "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
            ])
          }
        }
      }

      if reachedCap {
        reader.cancelReading()
      } else if reader.status == .failed {
        fail(
          "camera.import_pose_failed",
          reader.error?.localizedDescription ?? "The video frames could not be decoded.",
          reader.error
        )
        return
      }
      guard framesProcessed > 0 else {
        fail("camera.invalid_media", "The video does not contain decodable frames.", nil)
        return
      }
      guard !poses.isEmpty else {
        fail("camera.import_no_person", "No person could be tracked in this video.", nil)
        return
      }

      do {
        guard let poseSequence = try ClipMediaStore.writeImportedPoseSequenceSidecar(
          besideVideoAt: videoURL,
          poseHistory: poses,
          poseModelVersion: poseProvider.modelVersion,
          windowEndTimestampMs: lastKeptTimestampMs
        ) else {
          fail("camera.import_pose_failed", "The pose sequence could not be persisted.", nil)
          return
        }
        // framesTotal counts frames pose extraction actually RAN on (after
        // fps decimation) so framesWithPose/framesTotal is an honest coverage
        // ratio of the analyzed timeline.
        var payload: [String: Any] = [
          "poseSequence": poseSequence,
          "framesWithPose": poses.count,
          "framesTotal": framesProcessed,
        ]
        if let posterURL = ClipMediaStore.writePosterFrame(besideVideoAt: videoURL) {
          payload["posterUri"] = posterURL.absoluteString
        }
        self.emit([
          "type": "import_pose_extraction",
          "state": "completed",
          "progress": 1.0,
          "captureId": captureId,
          "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
        ])
        resolve(payload)
      } catch {
        fail("camera.import_pose_failed", error.localizedDescription, error)
      }
    }
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
      if let guided = self.guidedController {
        guided.cancelFromBridge()
        return
      }
      if let picker = self.importPicker {
        picker.dismiss(animated: true) {
          self.finishWithError(code: "camera.cancelled", message: "Video import was canceled.")
        }
        return
      }
      if self.operation != nil {
        self.finishWithError(code: "camera.cancelled", message: "Camera capture was canceled.")
      }
    }
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    guard case .importing(let importId)? = operation else { return }
    guard let provider = results.first?.itemProvider else {
      picker.dismiss(animated: true) {
        self.emit([
          "type": "abstained",
          "reason": "user_cancelled",
          "captureId": importId,
          "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
        ])
        self.finishWithError(code: "camera.cancelled", message: "Video import was canceled.")
      }
      return
    }

    let movieIdentifier = provider.registeredTypeIdentifiers.first {
      UTType($0)?.conforms(to: .movie) == true
    } ?? UTType.movie.identifier
    guard provider.hasItemConformingToTypeIdentifier(movieIdentifier) else {
      picker.dismiss(animated: true) {
        self.finishWithError(
          code: "camera.invalid_media",
          message: "The selected item is not a supported video."
        )
      }
      return
    }

    emit([
      "type": "import",
      "state": "copying",
      "captureId": importId,
      "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
    ])
    provider.loadFileRepresentation(forTypeIdentifier: movieIdentifier) { [weak self, weak picker] url, error in
      guard let self else { return }
      do {
        if let error { throw error }
        guard let url else { throw ClipMediaStoreError.invalidMedia }
        // The provider URL is ephemeral and must be copied before this callback
        // returns. The destination uses data protection in Application Support.
        let destination = try ClipMediaStore.persistImportedVideo(from: url)
        let payload = try ClipMediaStore.importedPayload(for: destination)
        DispatchQueue.main.async {
          picker?.dismiss(animated: true) {
            self.emit([
              "type": "import",
              "state": "completed",
              "captureId": importId,
              "emittedAtIso": ISO8601DateFormatter().string(from: Date()),
            ])
            self.finishWithSuccess(payload)
          }
        }
      } catch {
        DispatchQueue.main.async {
          picker?.dismiss(animated: true) {
            self.finishWithError(
              code: "camera.import_failed",
              message: error.localizedDescription,
              error: error
            )
          }
        }
      }
    }
  }

  private func begin(
    operation: Operation,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) -> Bool {
    guard self.operation == nil else {
      reject("camera.busy", "Another camera operation is already active.", nil)
      return false
    }
    self.operation = operation
    self.resolve = resolve
    self.reject = reject
    return true
  }

  private func presentGuidedCapture(engine: CameraEngine) {
    guard let presenter = Self.topViewController() else {
      engine.stop()
      finishWithError(
        code: "camera.presentation_failed",
        message: "The guided camera could not be opened."
      )
      return
    }

    let controller = GuidedCaptureViewController(engine: engine)
    guidedController = controller
    controller.onEvent = { [weak self] event in self?.emit(event) }
    controller.onComplete = { [weak self, weak controller] result in
      guard let self else { return }
      controller?.dismiss(animated: true) {
        switch result {
        case .success(let payload): self.finishWithSuccess(payload)
        case .failure(let failure):
          self.finishWithError(code: failure.code, message: failure.message, error: failure)
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
    resolve = nil
    reject = nil
    operation = nil
    guidedController = nil
    importPicker = nil
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
