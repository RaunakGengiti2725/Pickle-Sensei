import Foundation
import React

@objc(PickleMotion3D)
final class PickleMotion3D: RCTEventEmitter {
  private final class Job {
    let runId: String
    let cancellation = Motion3DCancellation()
    var progressThrottle = Motion3DProgressThrottle()

    init(runId: String) { self.runId = runId }
  }

  private let worker = DispatchQueue(label: "pickle.motion3d.reconstruction", qos: .utility)
  private let events = DispatchQueue(label: "pickle.motion3d.events", qos: .utility)
  private let stateLock = NSLock()
  private var activeJob: Job?
  private var hasListeners = false
  private var invalidated = false

  @objc override static func requiresMainQueueSetup() -> Bool { false }

  @objc override var methodQueue: DispatchQueue { events }

  override func constantsToExport() -> [AnyHashable: Any]! {
    ["available": Motion3DCapability.available, "schemaVersion": 2, "supportedSchemas": [1, 2],
     "supportedPolicies": ["raw-v1", "associated-v2", "associated-roi-v3"]]
  }

  override func supportedEvents() -> [String]! { ["PickleMotion3DProgress"] }

  override func startObserving() {
    stateLock.lock()
    hasListeners = true
    stateLock.unlock()
  }

  override func stopObserving() {
    stateLock.lock()
    hasListeners = false
    stateLock.unlock()
  }

  @objc func reconstruct(
    _ options: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let allowedKeys: Set<String> = ["uri", "captureId", "runId", "policy", "targetSeed"]
    guard (3...5).contains(options.count),
          options.allKeys.allSatisfy({ ($0 as? String).map { allowedKeys.contains($0) } ?? false }),
          let uri = options["uri"] as? String,
          let captureId = options["captureId"] as? String,
          let runId = options["runId"] as? String,
          Motion3DLimits.validIdentifier(captureId), Motion3DLimits.validIdentifier(runId) else {
      Self.reject(.invalidOptions, using: reject)
      return
    }
    let policy: Motion3DPolicy
    let targetSeed: Motion3DTargetSeed?
    do {
      if let value = options["policy"] {
        guard let name = value as? String, let parsed = Motion3DPolicy(rawValue: name) else { throw Motion3DFailure.invalidOptions }
        policy = parsed
      } else { policy = .rawV1 }
      if let value = options["targetSeed"] {
        guard policy != .rawV1 else { throw Motion3DFailure.invalidOptions }
        targetSeed = try Motion3DTargetSeed.parse(value)
      } else { targetSeed = nil }
    } catch {
      Self.reject(.invalidOptions, using: reject)
      return
    }
    guard Motion3DLimits.validStoredURI(uri) else {
      Self.reject(.invalidSource, using: reject)
      return
    }
    guard #available(iOS 17.0, *), Motion3DCapability.available else {
      Self.reject(.unavailable, using: reject)
      return
    }
    stateLock.lock()
    guard !invalidated else {
      stateLock.unlock()
      Self.reject(.cancelled, using: reject)
      return
    }
    guard activeJob == nil else {
      stateLock.unlock()
      Self.reject(.busy, using: reject)
      return
    }
    let job = Job(runId: runId)
    activeJob = job
    stateLock.unlock()
    worker.async { [weak self] in
      guard let self else { job.cancellation.cancel(); return }
      let result: Result<Motion3DReceipt, Motion3DFailure>
      do {
        try job.cancellation.check()
        let support = try FileManager.default.url(
          for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false
        ).standardizedFileURL.resolvingSymlinksInPath()
        let url = try Motion3DSourceSecurity.resolve(
          storedURI: uri,
          capturesDirectory: support.appendingPathComponent("PickleSensei/Captures", isDirectory: true),
          resolveCaptureURL: { ClipMediaStore.resolveCaptureURL(fromStoredUri: $0) }
        )
        let receipt = try AppleMotion3DReconstructor.reconstruct(
          videoURL: url, captureId: captureId, policy: policy, targetSeed: targetSeed, cancellation: job.cancellation,
          progress: { [weak self] progress in self?.emit(progress, for: job) }
        )
        try job.cancellation.check()
        result = .success(receipt)
      } catch {
        var failure = (error as? Motion3DFailure) ?? .decodingFailed
        do { try job.cancellation.check() }
        catch let cancelled as Motion3DFailure { failure = cancelled }
        catch { failure = .cancelled }
        result = .failure(failure)
      }
      self.events.async { [weak self] in
        guard let self else { return }
        self.stateLock.lock()
        guard self.activeJob === job else { self.stateLock.unlock(); return }
        self.activeJob = nil
        let invalidated = self.invalidated
        self.stateLock.unlock()
        guard !invalidated else { Self.reject(.cancelled, using: reject); return }
        do { try job.cancellation.check() }
        catch {
          Self.reject((error as? Motion3DFailure) ?? .cancelled, using: reject)
          return
        }
        switch result {
        case .success(let receipt): resolve(["json": receipt.json, "sha256": receipt.sha256])
        case .failure(let failure): Self.reject(failure, using: reject)
        }
      }
    }
  }

  @objc func cancel(_ runId: String) {
    stateLock.lock()
    let job = activeJob?.runId == runId ? activeJob : nil
    stateLock.unlock()
    job?.cancellation.cancel()
  }

  override func invalidate() {
    stateLock.lock()
    invalidated = true
    hasListeners = false
    let job = activeJob
    stateLock.unlock()
    job?.cancellation.cancel()
    super.invalidate()
  }

  private func emit(_ progress: Motion3DProgress, for job: Job) {
    events.async { [weak self] in
      guard let self else { return }
      self.stateLock.lock()
      let shouldEmit = self.hasListeners && !self.invalidated && self.activeJob === job
      self.stateLock.unlock()
      guard shouldEmit, !job.cancellation.isCancelled, job.progressThrottle.shouldEmit() else { return }
      self.sendEvent(withName: "PickleMotion3DProgress", body: [
        "runId": job.runId,
        "processedFrames": progress.processedFrames,
        "timestampMs": progress.timestampMs,
        "durationMs": progress.durationMs,
      ])
    }
  }

  private static func reject(_ failure: Motion3DFailure, using reject: RCTPromiseRejectBlock) {
    let message: String
    switch failure {
    case .unavailable: message = "3D reconstruction is unavailable on this device or app build."
    case .invalidOptions: message = "The reconstruction request is invalid."
    case .invalidSource: message = "3D reconstruction needs a saved private recording."
    case .exceedsLimits: message = "This recording exceeds the development reconstruction limits."
    case .decodingFailed: message = "The saved recording could not be reconstructed."
    case .cancelled: message = "3D reconstruction was cancelled. Your recording is still saved."
    case .busy: message = "Another 3D reconstruction is finishing. Try again once it completes."
    case .timeout: message = "3D reconstruction took too long. Try a shorter recording."
    }
    reject(failure.rawValue, message, nil)
  }
}
