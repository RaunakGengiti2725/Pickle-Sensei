import AVFoundation
import Foundation
import UIKit

struct GuidedCaptureFailure: LocalizedError {
  let code: String
  let message: String

  var errorDescription: String? { message }
}

/// Full-screen, native guided capture. Camera frames, pose inference, overlay
/// rendering, temporal detection, and movie spooling remain native. React
/// Native receives only low-frequency structured state and the completed clip.
final class GuidedCaptureViewController: UIViewController {
  typealias EventHandler = ([String: Any]) -> Void
  typealias Completion = (Result<[String: Any], GuidedCaptureFailure>) -> Void

  private enum CapturePresentationStage: Equatable {
    case starting
    case targetSelection
    case positioning
    case bodyLocked
    case capturing
    case saving
  }

  private static let preRollMs = 2_000
  private static let postRollMs = 1_500
  private static let observationTimeoutSeconds: TimeInterval = 55

  /// D-029: movement-completion strategy. Read ONCE per session at init;
  /// default is FIXED (`postRollMs` after the detector's movement end — the
  /// shipped behavior, unchanged). ADAPTIVE (settle-or-valley-or-safety, the
  /// D-029 measured candidate) is a flagged instrument settable only through
  /// the RN bridge (`PickleVideoCapture.setCompletionStrategy`); it is NOT
  /// promoted — the D-027-style gate (live-trigger instrumentation + ≥20 gold
  /// events) has not been met. The monitor runs in BOTH strategies so every
  /// automatic capture records what the other strategy would have done.
  private let completionStrategy = CaptureCompletionStrategyStore.strategy
  private let completionMonitor = StrokeCompletionMonitor()

  /// First (and only) finalize decision for this capture, kept for telemetry.
  private struct CompletionFinalize {
    /// Frame timestamp on which the live pipeline committed to stop.
    let atMs: Int
    /// Requested clip end (session-relative) handed to the exporter.
    let requestedEndMs: Int
  }

  private var completionFinalize: CompletionFinalize?

  let captureId = UUID().uuidString.lowercased()
  var onEvent: EventHandler?
  var onComplete: Completion?

  private let engine: CameraEngine
  private let poseProvider = ApplePoseProvider()
  private let detector = TemporalStrokeDetector()
  private let readiness = PoseReadinessEvaluator()
  /// LIVE TARGET SETUP — physically honest for a self-recording athlete:
  /// the user taps WHERE THEY WILL START (they are next to the phone), walks
  /// out, and the person who OCCUPIES that region becomes the target. The
  /// region is initialization only; after lock, identity follows the person.
  private enum TargetAcquisition: Equatable {
    case choosingRegion
    case waitingForOccupant     // user walking to position
    case ambiguous              // ≥2 people in region → "raise your paddle"
    case locked
  }
  private var targetAcquisition: TargetAcquisition = .choosingRegion
  private var startRegion: CGPoint?          // normalized capture space
  private static let startRegionRadius: CGFloat = 0.17
  private var occupancyStreak = 0
  private var occupantTorso: CGPoint?
  private static let occupancyFramesToLock = 9
  /// Ambiguity: per-candidate best wrist elevation (shoulderY - wristY).
  private var gestureBest: [Int: Double] = [:]
  /// PROMOTED 2026-08-28 (D-027, EXP ta-candidate-variants): measured on 36
  /// human-verified replay cases (31 dev + 5 held-out), the shipped sticky
  /// ambiguity dead-ended real scenes and single-frame wrist flicks caused
  /// false gesture locks. Gesture now needs a SUSTAINED raise; if nobody
  /// gestures within the timeout, the occupant closest to the tapped region
  /// locks (the user is the one standing on their chosen spot).
  private static let sustainedGestureFrames = 5
  private static let ambiguityTimeoutMs = 3000
  private var ambiguousSinceMs: Int?
  private var gestureStreaks: [Int: Int] = [:]
  private var targetSeed: CGPoint?           // resolved PERSON anchor
  private var targetSeedSource = "start_region_occupancy"
  /// Always-on target-lock instrumentation (acquire-v4 promotion gate
  /// evidence, D-043 telemetry conventions): observes the shipped D-027
  /// acquisition without influencing it, so a future replay can measure live
  /// tap-to-track distances against the bench gate.
  private var lockInstrumentFirstFrameMs: Int?
  private var lockInstrumentLastFrameMs: Int?
  private var lockInstrumentAmbiguousEnteredMs: Int?
  private var lockInstrumentLock: (torso: CGPoint, source: String, timestampMs: Int)?
  private static let targetLockAlgorithmVersion = "target-lock-live-v1"
  private let targetRing = CAShapeLayer()
  private let selectionHaptic = UIImpactFeedbackGenerator(style: .medium)
  private let evidenceAccumulator = CaptureEvidenceAccumulator()
  private let visionQueue = DispatchQueue(label: "pickle.guided-capture.vision", qos: .userInitiated)
  private let stateLock = NSLock()

  private let overlayView = PoseOverlayView()
  private let statusContainer = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
  private let statusStack = UIStackView()
  private let statusLabel = UILabel()
  private let detailLabel = UILabel()
  private let closeButton = UIButton(type: .system)
  private let lockHaptic = UIImpactFeedbackGenerator(style: .light)
  private let captureHaptic = UINotificationFeedbackGenerator()
  private var previewLayer: AVCaptureVideoPreviewLayer!

  private var observationURL: URL?
  private var observationTimer: Timer?
  private var visionInFlight = false
  /// Full measured pose sequence (session-relative timestamps), bounded to the
  /// last `poseHistoryWindowMs`. Persisted beside the clip so any future model
  /// can reprocess this swing — temporal data is never collapsed to aggregates.
  private var poseHistory: [PoseFrame] = []
  private static let poseHistoryWindowMs = 15_000
  private var pendingStroke: StrokeEvent?
  private var pendingCaptureEvidence: CaptureEvidenceAccumulator.Summary?
  private var armed = false
  private var recordingStarted = false
  private var processingClip = false
  private var terminal = false
  private var lastReadinessEventState: PoseReadinessEvaluator.State?
  private var lastReadinessEventAtMs = 0
  private var presentedCaptureStage: CapturePresentationStage?

  init(engine: CameraEngine) {
    self.engine = engine
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .fullScreen
  }

  required init?(coder: NSCoder) { nil }

  override var prefersStatusBarHidden: Bool { true }
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

  override func viewDidLoad() {
    super.viewDidLoad()
    configureView()
    bindEngine()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(appEnteredBackground),
      name: UIApplication.didEnterBackgroundNotification,
      object: nil
    )
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    emit(type: "session", values: ["state": "starting"])
    engine.start()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    previewLayer.frame = view.bounds
    overlayView.frame = view.bounds
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    observationTimer?.invalidate()
  }

  func cancelFromBridge() {
    stateLock.lock()
    let isPreparingSavedClip = processingClip
    stateLock.unlock()
    guard !isPreparingSavedClip else { return }
    finishFailure(code: "camera.cancelled", message: "Guided capture was canceled.", abstention: "user_cancelled")
  }

  private func configureView() {
    view.backgroundColor = .black
    previewLayer = engine.makePreviewLayer()
    view.layer.addSublayer(previewLayer)

    overlayView.previewLayer = previewLayer
    overlayView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(overlayView)

    statusContainer.layer.cornerRadius = 22
    statusContainer.layer.cornerCurve = .continuous
    statusContainer.layer.borderWidth = 1
    statusContainer.layer.borderColor = UIColor.white.withAlphaComponent(0.14).cgColor
    statusContainer.clipsToBounds = true
    statusContainer.translatesAutoresizingMaskIntoConstraints = false
    statusContainer.contentView.layoutMargins = UIEdgeInsets(top: 11, left: 16, bottom: 11, right: 16)
    statusContainer.isAccessibilityElement = true
    statusContainer.accessibilityTraits = [.staticText, .updatesFrequently]
    view.addSubview(statusContainer)

    statusLabel.font = Self.scaledFont(name: "Manrope-SemiBold", size: 11, textStyle: .caption1)
    statusLabel.adjustsFontForContentSizeCategory = true
    statusLabel.textColor = UIColor(red: 83 / 255, green: 217 / 255, blue: 155 / 255, alpha: 1)
    statusLabel.textAlignment = .center
    statusLabel.numberOfLines = 2
    statusLabel.text = "STARTING CAMERA"
    statusLabel.translatesAutoresizingMaskIntoConstraints = false

    detailLabel.font = Self.scaledFont(name: "Manrope-SemiBold", size: 17, textStyle: .headline)
    detailLabel.adjustsFontForContentSizeCategory = true
    detailLabel.textColor = .white
    detailLabel.textAlignment = .center
    detailLabel.numberOfLines = 0
    detailLabel.text = "Starting on-device body tracking…"
    detailLabel.translatesAutoresizingMaskIntoConstraints = false

    statusStack.axis = .vertical
    statusStack.alignment = .fill
    statusStack.spacing = 3
    statusStack.translatesAutoresizingMaskIntoConstraints = false
    statusStack.addArrangedSubview(statusLabel)
    statusStack.addArrangedSubview(detailLabel)
    statusContainer.contentView.addSubview(statusStack)

    var closeConfig = UIButton.Configuration.filled()
    closeConfig.baseBackgroundColor = UIColor.black.withAlphaComponent(0.55)
    closeConfig.baseForegroundColor = .white
    closeConfig.cornerStyle = .capsule
    closeConfig.contentInsets = .zero
    closeConfig.image = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(weight: .semibold))
    closeButton.configuration = closeConfig
    closeButton.accessibilityLabel = "Cancel guided capture"
    closeButton.accessibilityHint = "Stops recording and closes the camera"
    closeButton.translatesAutoresizingMaskIntoConstraints = false
    closeButton.addTarget(self, action: #selector(closePressed), for: .touchUpInside)
    view.addSubview(closeButton)

    targetRing.strokeColor = UIColor(red: 83 / 255, green: 217 / 255, blue: 155 / 255, alpha: 1).cgColor
    targetRing.fillColor = UIColor.white.withAlphaComponent(0.10).cgColor
    targetRing.lineWidth = 3
    targetRing.opacity = 0
    view.layer.addSublayer(targetRing)

    let tap = UITapGestureRecognizer(target: self, action: #selector(handleTargetTap(_:)))
    view.addGestureRecognizer(tap)

    NSLayoutConstraint.activate([
      overlayView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      overlayView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      overlayView.topAnchor.constraint(equalTo: view.topAnchor),
      overlayView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

      closeButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 18),
      closeButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 14),
      closeButton.widthAnchor.constraint(equalToConstant: 48),
      closeButton.heightAnchor.constraint(equalToConstant: 48),

      statusContainer.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      statusContainer.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 78),
      statusContainer.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
      statusContainer.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),

      statusStack.leadingAnchor.constraint(equalTo: statusContainer.contentView.layoutMarginsGuide.leadingAnchor),
      statusStack.trailingAnchor.constraint(equalTo: statusContainer.contentView.layoutMarginsGuide.trailingAnchor),
      statusStack.topAnchor.constraint(equalTo: statusContainer.contentView.layoutMarginsGuide.topAnchor),
      statusStack.bottomAnchor.constraint(equalTo: statusContainer.contentView.layoutMarginsGuide.bottomAnchor),
    ])

    updateCapturePresentation(
      stage: .starting,
      title: "STARTING CAMERA",
      detail: "Starting on-device body tracking…",
      overlayState: .starting
    )
  }

  private func bindEngine() {
    engine.onSessionEvent = { [weak self] event in self?.handleSessionEvent(event) }
    engine.onFrame = { [weak self] pixelBuffer, timestampMs in
      self?.handleFrame(pixelBuffer: pixelBuffer, timestampMs: timestampMs)
    }
    engine.onRecordingStarted = { [weak self] _ in
      guard let self else { return }
      self.stateLock.lock()
      self.recordingStarted = true
      self.stateLock.unlock()
      self.emit(type: "session", values: ["state": "observing"])
    }
    engine.onRecordingFinished = { [weak self] result in self?.recordingFinished(result) }
  }

  private func handleSessionEvent(_ event: CameraEngine.SessionEvent) {
    switch event {
    case .configured:
      emit(type: "session", values: ["state": "configured"])
    case .starting:
      emit(type: "session", values: ["state": "starting"])
    case .running:
      DispatchQueue.main.async { [weak self] in self?.beginObservation() }
    case .stopped:
      emit(type: "session", values: ["state": "stopped"])
    case .interrupted(let reason):
      emit(type: "session", values: ["state": "interrupted", "reason": reason])
      finishFailure(
        code: "camera.interrupted",
        message: "Camera capture was interrupted. Try again when the camera is available.",
        abstention: "camera_interrupted"
      )
    case .interruptionEnded:
      emit(type: "session", values: ["state": "interruption_ended"])
    case .failed(let message):
      finishFailure(code: "camera.session_failed", message: message, abstention: "camera_failure")
    }
  }

  private func beginObservation() {
    stateLock.lock()
    let shouldBegin = !terminal && observationURL == nil
    stateLock.unlock()
    guard shouldBegin else { return }

    do {
      let url = try ClipMediaStore.makeObservationURL()
      observationURL = url
      engine.startContinuousRecording(to: url)
      updateCapturePresentation(
        stage: .targetSelection,
        title: "STEP 1 OF 2 · SET YOUR POSITION",
        detail: "Tap where you'll be standing",
        overlayState: .positioning
      )
      lockHaptic.prepare()
      observationTimer = Timer.scheduledTimer(
        withTimeInterval: Self.observationTimeoutSeconds,
        repeats: false
      ) { [weak self] _ in
        self?.finishFailure(
          code: "camera.no_stroke_detected",
          message: "No clear stroke was detected. Reframe the camera and try again.",
          abstention: "no_stroke_detected"
        )
      }
    } catch {
      finishFailure(
        code: "camera.storage_failed",
        message: "A private recording file could not be created.",
        abstention: "storage_failure"
      )
    }
  }

  private func handleFrame(pixelBuffer: CVPixelBuffer, timestampMs: Int) {
    stateLock.lock()
    if terminal {
      stateLock.unlock()
      return
    }
    if let pendingStroke {
      stateLock.unlock()
      handlePostCompletionFrame(
        pendingStroke: pendingStroke,
        pixelBuffer: pixelBuffer,
        timestampMs: timestampMs
      )
      return
    }
    guard !visionInFlight else {
      stateLock.unlock()
      return
    }
    visionInFlight = true
    stateLock.unlock()

    visionQueue.async { [weak self] in
      guard let self else { return }
      defer {
        self.stateLock.lock()
        self.visionInFlight = false
        self.stateLock.unlock()
      }
      do {
        if self.targetAcquisition != .locked && self.startRegion != nil {
          self.considerTargetAcquisition(pixelBuffer: pixelBuffer, timestampMs: timestampMs)
        }
        let pose = try self.poseProvider.extractPose(pixelBuffer: pixelBuffer, timestampMs: timestampMs)
        let snapshot = self.readiness.ingest(pose: pose)
        if snapshot.state == .noPerson {
          self.evidenceAccumulator.ingestMissing(timestampMs: timestampMs)
        } else {
          self.evidenceAccumulator.ingest(pose: pose)
        }
        self.retainPose(pose)
        self.handleReadiness(snapshot)
        if self.startRegion == nil || self.targetAcquisition == .locked {
          // D-029: the completion monitor mirrors the trigger's wrist-motion
          // series, so it ingests exactly the poses the trigger sees.
          self.completionMonitor.ingest(pose: pose)
          self.considerTrigger(pose: pose, readiness: snapshot)
        }
      } catch {
        let snapshot = self.readiness.ingestMissing(timestampMs: timestampMs)
        self.evidenceAccumulator.ingestMissing(timestampMs: timestampMs)
        self.detector.reset()
        self.handleReadiness(snapshot)
      }
    }
  }

  /// Post-completion window (a stroke event is pending). The finalize decision
  /// stays on the frame callback thread, exactly like the shipped fixed
  /// post-roll check it replaces:
  ///   FIXED (default) — stop when a frame reaches `endMs + postRollMs`.
  ///     Timing is byte-identical to the pre-D-029-instrumentation behavior.
  ///   ADAPTIVE (flagged) — stop when the monitor's settle/valley/safety
  ///     decision fires (D-029 semantics), with the requested clip end never
  ///     earlier than the detector's movement end (contact stays protected).
  /// In BOTH strategies the monitor keeps observing poses until the stop
  /// commits, so the clip metadata records the counterfactual strategy too.
  private func handlePostCompletionFrame(
    pendingStroke: StrokeEvent,
    pixelBuffer: CVPixelBuffer,
    timestampMs: Int
  ) {
    stateLock.lock()
    let alreadyFinalized = completionFinalize != nil
    stateLock.unlock()
    if alreadyFinalized {
      // Recording stop is asynchronous; re-issuing is the pre-existing
      // idempotent behavior for frames that arrive while it drains.
      engine.stopContinuousRecording()
      return
    }

    completionMonitor.observeFrame(timestampMs: timestampMs)

    let finalize: CompletionFinalize?
    switch completionStrategy {
    case .fixed:
      finalize = timestampMs >= pendingStroke.endMs + Self.postRollMs
        ? CompletionFinalize(
          atMs: timestampMs,
          requestedEndMs: pendingStroke.endMs + Self.postRollMs
        )
        : nil
    case .adaptive:
      finalize = completionMonitor.adaptiveDecision().map { decision in
        CompletionFinalize(
          atMs: timestampMs,
          requestedEndMs: max(pendingStroke.endMs, decision.endMs)
        )
      }
    }

    if let finalize {
      stateLock.lock()
      if completionFinalize == nil { completionFinalize = finalize }
      stateLock.unlock()
      engine.stopContinuousRecording()
      return
    }

    // Keep the D-029 instrument fed: pose extraction only. Readiness UI,
    // evidence accumulation, pose retention, and the trigger stay untouched
    // in this window, exactly as before the instrumentation.
    stateLock.lock()
    guard !visionInFlight else {
      stateLock.unlock()
      return
    }
    visionInFlight = true
    stateLock.unlock()
    visionQueue.async { [weak self] in
      guard let self else { return }
      defer {
        self.stateLock.lock()
        self.visionInFlight = false
        self.stateLock.unlock()
      }
      if let pose = try? self.poseProvider.extractPose(
        pixelBuffer: pixelBuffer,
        timestampMs: timestampMs
      ) {
        self.completionMonitor.ingest(pose: pose)
      }
    }
  }

  private func retainPose(_ pose: PoseFrame) {
    stateLock.lock()
    defer { stateLock.unlock() }
    // Strictly increasing timestamps are a schema invariant of the sequence.
    if let last = poseHistory.last, pose.timestampMs <= last.timestampMs { return }
    poseHistory.append(pose)
    let cutoff = pose.timestampMs - Self.poseHistoryWindowMs
    if let firstKept = poseHistory.firstIndex(where: { $0.timestampMs >= cutoff }), firstKept > 0 {
      poseHistory.removeFirst(firstKept)
    }
  }

  private func considerTrigger(
    pose: PoseFrame,
    readiness snapshot: PoseReadinessEvaluator.Snapshot
  ) {
    stateLock.lock()
    let alreadyArmed = armed
    let isTerminal = terminal
    let hasPending = pendingStroke != nil
    let recordingIsActive = recordingStarted
    stateLock.unlock()
    guard !isTerminal, !hasPending, recordingIsActive else { return }

    let hasPreRoll: Bool
    if let first = engine.currentRecordingFirstFrameTimestampMs {
      hasPreRoll = pose.timestampMs - first >= Self.preRollMs
    } else {
      hasPreRoll = false
    }

    if !alreadyArmed {
      guard snapshot.isReady, hasPreRoll else {
        detector.reset()
        return
      }
      stateLock.lock()
      armed = true
      stateLock.unlock()
      DispatchQueue.main.async { [weak self] in
        self?.presentBodyLocked(jointCoverage: snapshot.jointCoverage)
      }
      emit(type: "session", values: ["state": "armed"])
    } else if snapshot.state == .noPerson || snapshot.state == .fullBodyRequired {
      detector.reset()
      stateLock.lock()
      armed = false
      stateLock.unlock()
      DispatchQueue.main.async { [weak self] in self?.presentPositioning(snapshot: snapshot) }
      emit(type: "session", values: ["state": "disarmed", "reason": snapshot.state.rawValue])
      return
    }

    guard let event = detector.ingest(pose: pose, paddle: nil), event.confidence >= 0.65 else { return }
    guard let captureEvidence = evidenceAccumulator.summary(
      startMs: event.startMs,
      endMs: event.endMs,
      poseSource: "apple_vision_body_pose",
      poseModelVersion: poseProvider.modelVersion,
      triggerAlgorithmVersion: detector.modelVersion
    ) else {
      finishFailure(
        code: "camera.evidence_unavailable",
        message: "The detected motion did not contain enough tracked pose evidence.",
        abstention: "capture_evidence_unavailable"
      )
      return
    }
    stateLock.lock()
    guard pendingStroke == nil, !terminal else {
      stateLock.unlock()
      return
    }
    pendingStroke = event
    pendingCaptureEvidence = captureEvidence
    stateLock.unlock()
    // D-029: arm the completion instrument at the bench's anchor (the
    // trigger's peak-motion timestamp) for BOTH strategies.
    completionMonitor.arm(
      eventStartMs: event.startMs,
      eventEndMs: event.endMs,
      peakMotionMs: event.peakMotionMs
    )

    var strokePayload: [String: Any] = [
      "startTimestampMs": event.startMs,
      "endTimestampMs": event.endMs,
      "confidence": event.confidence,
      "detectionModelVersion": detector.modelVersion,
      "recognition": [
        "status": event.recognition.status.rawValue,
        "reason": event.recognition.reason ?? "validated_classifier_unavailable",
      ],
    ]
    if let peakMotionMs = event.peakMotionMs {
      strokePayload["peakMotionTimestampMs"] = peakMotionMs
    }
    emit(type: "stroke_detected", values: strokePayload)
    DispatchQueue.main.async { [weak self] in
      self?.updateCapturePresentation(
        stage: .capturing,
        title: "MOTION CAPTURED",
        detail: "Recording the final frames around this movement",
        overlayState: .capturing,
        announcement: "Motion captured. Hold position while the final frames are recorded."
      )
      self?.closeButton.isEnabled = false
      self?.closeButton.alpha = 0.55
    }
  }

  private func handleReadiness(_ snapshot: PoseReadinessEvaluator.Snapshot) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.overlayView.update(snapshot: snapshot)

      self.stateLock.lock()
      let currentlyArmed = self.armed
      self.stateLock.unlock()
      if !currentlyArmed {
        self.presentPositioning(snapshot: snapshot)
      }
    }

    let shouldEmit = snapshot.state != lastReadinessEventState
      || snapshot.timestampMs - lastReadinessEventAtMs >= 500
    guard shouldEmit else { return }
    lastReadinessEventState = snapshot.state
    lastReadinessEventAtMs = snapshot.timestampMs
    emit(type: "readiness", values: [
      "state": snapshot.state.rawValue,
      "poseConfidence": snapshot.poseConfidence,
      "jointCoverage": snapshot.jointCoverage,
      "stableForMs": snapshot.stableForMs,
      "missingJoints": snapshot.missingJoints,
      "source": "apple_vision_body_pose",
      "modelVersion": poseProvider.modelVersion,
    ])
  }

  private func recordingFinished(_ result: Result<CameraEngine.RecordingArtifact, Error>) {
    stateLock.lock()
    let event = pendingStroke
    let captureEvidence = pendingCaptureEvidence
    let isTerminal = terminal
    stateLock.unlock()
    guard !isTerminal else {
      if case .success(let artifact) = result { ClipMediaStore.removeIfPresent(artifact.url) }
      return
    }
    switch result {
    case .failure(let error):
      finishFailure(
        code: "camera.capture_failed",
        message: error.localizedDescription,
        abstention: "recording_failure"
      )
    case .success(let artifact):
      guard let event, let captureEvidence else {
        ClipMediaStore.removeIfPresent(artifact.url)
        finishFailure(
          code: "camera.no_stroke_detected",
          message: "No complete stroke was detected before capture ended.",
          abstention: "no_stroke_detected"
        )
        return
      }
      stateLock.lock()
      processingClip = true
      stateLock.unlock()
      DispatchQueue.main.async { [weak self] in
        self?.updateCapturePresentation(
          stage: .saving,
          title: "SAVING CAPTURE",
          detail: "Preparing the detected motion window on this device",
          overlayState: .saving,
          announcement: "Saving capture."
        )
      }
      emit(type: "processing", values: ["state": "preparing_clip"])
      stateLock.lock()
      let retainedPoseHistory = poseHistory
      let finalize = completionFinalize
      stateLock.unlock()
      // D-029 instrumentation: the exported window end. FIXED keeps the
      // shipped `postRollMs` verbatim — including when the finalize record is
      // absent (defensive) — so default clip content cannot change. ADAPTIVE
      // derives the post-roll from the decided end (never negative: the
      // requested end is clamped to the detector's movement end).
      let effectivePostRollMs: Int
      switch completionStrategy {
      case .fixed:
        effectivePostRollMs = Self.postRollMs
      case .adaptive:
        if let finalize {
          effectivePostRollMs = max(0, finalize.requestedEndMs - event.endMs)
        } else {
          effectivePostRollMs = Self.postRollMs
        }
      }
      // Defensive fallback: if the recording ended without our stop decision
      // (engine-initiated stop), the honest finalize moment is the last
      // recorded frame, clamped to the movement end so the telemetry can
      // never claim a finalize before the movement completed.
      let completionTelemetry = completionMonitor.telemetry(
        strategy: completionStrategy,
        finalizeMs: finalize?.atMs ?? max(artifact.lastFrameTimestampMs, event.endMs)
      )
      ClipMediaStore.exportStrokeWindow(
        artifact: artifact,
        event: event,
        detectionModelVersion: detector.modelVersion,
        captureEvidence: Self.captureEvidencePayload(captureEvidence),
        completionTelemetry: completionTelemetry,
        poseHistory: retainedPoseHistory,
        poseModelVersion: poseProvider.modelVersion,
        preRollMs: Self.preRollMs,
        postRollMs: effectivePostRollMs
      ) { [weak self] exportResult in
        switch exportResult {
        case .success(let payload): self?.finishSuccess(payload)
        case .failure(let error):
          self?.finishFailure(
            code: "camera.processing_failed",
            message: error.localizedDescription,
            abstention: "clip_processing_failure"
          )
        }
      }
    }
  }

  private func finishSuccess(_ payload: [String: Any]) {
    var payload = payload
    if let targetSeed {
      payload["targetSeed"] = [
        "x": Double(targetSeed.x),
        "y": Double(targetSeed.y),
        "source": targetSeedSource,
      ]
    }
    if let targetLock = targetLockTelemetryPayload() {
      payload["targetLock"] = targetLock
    }
    stateLock.lock()
    guard !terminal else {
      stateLock.unlock()
      return
    }
    terminal = true
    stateLock.unlock()

    observationTimer?.invalidate()
    observationTimer = nil
    emit(type: "completed", values: ["recognition": payload["recognition"] as Any])
    engine.stop()
    DispatchQueue.main.async { [weak self] in self?.onComplete?(.success(payload)) }
  }

  private func finishFailure(code: String, message: String, abstention: String) {
    stateLock.lock()
    guard !terminal else {
      stateLock.unlock()
      return
    }
    terminal = true
    stateLock.unlock()

    observationTimer?.invalidate()
    observationTimer = nil
    emit(type: "abstained", values: ["reason": abstention, "message": message])
    stateLock.lock()
    let hadActiveRecording = recordingStarted
    stateLock.unlock()
    engine.stop()
    if !hadActiveRecording { ClipMediaStore.removeIfPresent(observationURL) }
    DispatchQueue.main.async { [weak self] in
      self?.onComplete?(.failure(GuidedCaptureFailure(code: code, message: message)))
    }
  }

  private func emit(type: String, values: [String: Any]) {
    var payload = values
    payload["type"] = type
    payload["captureId"] = captureId
    payload["emittedAtIso"] = ISO8601DateFormatter().string(from: Date())
    onEvent?(payload)
  }

  @objc private func handleTargetTap(_ recognizer: UITapGestureRecognizer) {
    stateLock.lock()
    let alreadyCapturing = pendingStroke != nil || terminal
    stateLock.unlock()
    guard !alreadyCapturing, targetAcquisition == .choosingRegion else { return }
    let viewPoint = recognizer.location(in: view)
    let devicePoint = previewLayer.captureDevicePointConverted(fromLayerPoint: viewPoint)
    guard devicePoint.x.isFinite, devicePoint.y.isFinite else { return }
    startRegion = CGPoint(
      x: min(1, max(0, devicePoint.x)),
      y: min(1, max(0, devicePoint.y))
    )
    targetAcquisition = .waitingForOccupant
    occupancyStreak = 0
    gestureBest = [:]
    gestureStreaks = [:]
    ambiguousSinceMs = nil
    lockInstrumentFirstFrameMs = nil
    lockInstrumentLastFrameMs = nil
    lockInstrumentAmbiguousEnteredMs = nil
    lockInstrumentLock = nil
    selectionHaptic.impactOccurred()

    // Persistent region marker (does not fade — the user is walking away and
    // needs the target zone to stay visible from the court).
    targetRing.path = UIBezierPath(
      arcCenter: viewPoint, radius: 44, startAngle: 0, endAngle: .pi * 2, clockwise: true
    ).cgPath
    targetRing.lineDashPattern = [10, 8]
    targetRing.opacity = 0.9

    emit(type: "target", values: [
      "state": "region_selected",
      "x": String(format: "%.4f", startRegion!.x),
      "y": String(format: "%.4f", startRegion!.y),
    ])
    updateCapturePresentation(
      stage: .targetSelection,
      title: "STARTING SPOT SET",
      detail: "Go to your position",
      overlayState: .positioning,
      prominent: true
    )
  }

  /// Torso midpoint of a pose frame in normalized capture space.
  private static func torsoMid(of pose: PoseFrame) -> CGPoint? {
    var xs: [Double] = []
    var ys: [Double] = []
    for name in ["left_shoulder", "right_shoulder", "left_hip", "right_hip"] {
      guard let mark = pose.landmarks.first(where: { $0.name == name && $0.visibility >= 0.2 })
      else { continue }
      xs.append(mark.x)
      ys.append(mark.y)
    }
    guard xs.count >= 3 else { return nil }
    return CGPoint(x: xs.reduce(0, +) / Double(xs.count), y: ys.reduce(0, +) / Double(ys.count))
  }

  /// Wrist elevation above shoulders — the "raise your paddle" signal.
  private static func wristElevation(of pose: PoseFrame) -> Double {
    let shoulders = pose.landmarks.filter { $0.name.hasSuffix("shoulder") && $0.visibility >= 0.2 }
    let wrists = pose.landmarks.filter { $0.name.hasSuffix("wrist") && $0.visibility >= 0.2 }
    guard let shoulderY = shoulders.map(\.y).min(), let wristY = wrists.map(\.y).min() else {
      return -1
    }
    return shoulderY - wristY // positive when a wrist is above the shoulders
  }

  /// Region-occupancy target acquisition. Runs on the vision queue while the
  /// target is not yet locked. The REGION never re-decides identity later —
  /// on lock, the pose provider anchor is seeded to the PERSON and follows
  /// them anywhere on court.
  private func considerTargetAcquisition(pixelBuffer: CVPixelBuffer, timestampMs: Int) {
    guard let region = startRegion else { return }
    lockInstrumentFirstFrameMs = lockInstrumentFirstFrameMs ?? timestampMs
    lockInstrumentLastFrameMs = timestampMs
    let people = (try? poseProvider.extractAllPoses(
      pixelBuffer: pixelBuffer, timestampMs: timestampMs
    )) ?? []
    let occupants = people.compactMap { pose -> (pose: PoseFrame, torso: CGPoint)? in
      guard let torso = Self.torsoMid(of: pose) else { return nil }
      let distance = hypot(torso.x - region.x, torso.y - region.y)
      return distance <= Self.startRegionRadius ? (pose, torso) : nil
    }

    if targetAcquisition == .ambiguous {
      ambiguousSinceMs = ambiguousSinceMs ?? timestampMs
      // "Raise your paddle" — a SUSTAINED raise (not a single-frame flick,
      // which natural swings produce constantly) confirms the user.
      for (index, occupant) in occupants.enumerated() {
        let elevation = Self.wristElevation(of: occupant.pose)
        gestureBest[index] = max(gestureBest[index] ?? -1, elevation)
        let streak = elevation > 0.03 ? (gestureStreaks[index] ?? 0) + 1 : 0
        gestureStreaks[index] = streak
        if streak >= Self.sustainedGestureFrames {
          lockTarget(at: occupant.torso, source: "gesture_confirmed", timestampMs: timestampMs)
          return
        }
      }
      // Nobody gestures in real scenes (measured): after the timeout, the
      // person standing closest to the user's OWN tapped spot is the user.
      if let since = ambiguousSinceMs,
         timestampMs - since >= Self.ambiguityTimeoutMs,
         let closest = occupants.min(by: {
           hypot($0.torso.x - region.x, $0.torso.y - region.y)
             < hypot($1.torso.x - region.x, $1.torso.y - region.y)
         }) {
        lockTarget(at: closest.torso, source: "ambiguity_timeout", timestampMs: timestampMs)
      }
      return
    }

    if occupants.count >= 2 {
      targetAcquisition = .ambiguous
      lockInstrumentAmbiguousEnteredMs = lockInstrumentAmbiguousEnteredMs ?? timestampMs
      emit(type: "target", values: ["state": "ambiguous"])
      DispatchQueue.main.async { [weak self] in
        self?.updateCapturePresentation(
          stage: .targetSelection,
          title: "TWO PLAYERS IN YOUR SPOT",
          detail: "Raise your paddle",
          overlayState: .positioning,
          prominent: true
        )
      }
      return
    }
    guard let occupant = occupants.first else {
      occupancyStreak = 0
      return
    }
    occupancyStreak += 1
    occupantTorso = occupant.torso
    if occupancyStreak >= Self.occupancyFramesToLock {
      lockTarget(at: occupant.torso, source: "start_region_occupancy", timestampMs: timestampMs)
    }
  }

  private func lockTarget(at torso: CGPoint, source: String, timestampMs: Int) {
    targetAcquisition = .locked
    targetSeed = torso
    targetSeedSource = source
    lockInstrumentLock = (torso: torso, source: source, timestampMs: timestampMs)
    poseProvider.setPrimaryPersonSeed(x: Double(torso.x), y: Double(torso.y))
    emit(type: "target", values: [
      "state": "locked",
      "source": source,
      "x": String(format: "%.4f", torso.x),
      "y": String(format: "%.4f", torso.y),
    ])
    DispatchQueue.main.async { [weak self] in
      // Region marker disappears: identity now belongs to the PERSON.
      self?.targetRing.opacity = 0
      self?.updateCapturePresentation(
        stage: .positioning,
        title: "PLAYER LOCKED ✓",
        detail: "Swing when ready",
        overlayState: .positioning,
        prominent: true
      )
    }
  }

  /// Target-lock telemetry payload (`targetLock`, schema v1). Present whenever
  /// the user tapped a start region; absent otherwise (honest absence, no
  /// reconstruction). Timestamps are camera-clock milliseconds and are NOT
  /// rebased to the exported clip window — the lock precedes it; only
  /// durations are persisted.
  private func targetLockTelemetryPayload() -> [String: Any]? {
    guard let tap = startRegion else { return nil }
    var payload: [String: Any] = [
      "schemaVersion": 1,
      "algorithmVersion": Self.targetLockAlgorithmVersion,
      "coordinateSystem": "normalized_capture_space",
      "tapPoint": ["x": Double(tap.x), "y": Double(tap.y)],
      "params": [
        "startRegionRadius": Double(Self.startRegionRadius),
        "occupancyFramesToLock": Self.occupancyFramesToLock,
        "sustainedGestureFrames": Self.sustainedGestureFrames,
        "ambiguityTimeoutMs": Self.ambiguityTimeoutMs,
        "gestureElevationThreshold": 0.03,
      ],
    ]
    let ambiguityEntered = lockInstrumentAmbiguousEnteredMs != nil
    payload["ambiguityEntered"] = ambiguityEntered
    if let entered = lockInstrumentAmbiguousEnteredMs {
      let endMs = lockInstrumentLock?.timestampMs ?? lockInstrumentLastFrameMs ?? entered
      payload["ambiguityDurationMs"] = max(0, endMs - entered)
    }
    if let lock = lockInstrumentLock {
      payload["lockOutcome"] = "locked"
      payload["lockSource"] = lock.source
      payload["lockTorso"] = ["x": Double(lock.torso.x), "y": Double(lock.torso.y)]
      payload["tapToLockDistance"] = Double(
        hypot(lock.torso.x - tap.x, lock.torso.y - tap.y)
      )
      payload["timeToLockMs"] = max(
        0, lock.timestampMs - (lockInstrumentFirstFrameMs ?? lock.timestampMs)
      )
    } else {
      payload["lockOutcome"] = "no_lock"
    }
    return payload
  }

  @objc private func closePressed() {
    cancelFromBridge()
  }

  @objc private func appEnteredBackground() {
    stateLock.lock()
    let isPreparingSavedClip = processingClip
    stateLock.unlock()
    guard !isPreparingSavedClip else { return }
    finishFailure(
      code: "camera.backgrounded",
      message: "Guided capture stopped when the app left the foreground.",
      abstention: "app_backgrounded"
    )
  }

  private func presentPositioning(snapshot: PoseReadinessEvaluator.Snapshot) {
    let coveragePercent = Self.coveragePercent(snapshot.jointCoverage)
    updateCapturePresentation(
      stage: .positioning,
      title: "POSITIONING · \(coveragePercent)% KEY JOINTS",
      detail: Self.message(for: snapshot.state),
      overlayState: .positioning
    )
  }

  private func presentBodyLocked(jointCoverage: Double) {
    let coveragePercent = Self.coveragePercent(jointCoverage)
    updateCapturePresentation(
      stage: .bodyLocked,
      title: "BODY LOCKED · \(coveragePercent)% KEY JOINTS",
      detail: "Swing naturally — capture starts from your movement",
      overlayState: .locked,
      announcement: "Body locked. Swing naturally; capture starts from your movement."
    )
  }

  private func updateCapturePresentation(
    stage: CapturePresentationStage,
    title: String,
    detail: String,
    overlayState: PoseOverlayView.CaptureState,
    prominent: Bool
  ) {
    updateCapturePresentation(stage: stage, title: title, detail: detail, overlayState: overlayState)
    // Distance-readable: the athlete may be 15–25 feet from the phone.
    detailLabel.font = prominent
      ? Self.scaledFont(name: "Manrope-Bold", size: 26, textStyle: .title1)
      : Self.scaledFont(name: "Manrope-SemiBold", size: 17, textStyle: .headline)
  }

  private func updateCapturePresentation(
    stage: CapturePresentationStage,
    title: String,
    detail: String,
    overlayState: PoseOverlayView.CaptureState,
    announcement: String? = nil
  ) {
    assert(Thread.isMainThread)
    let stageChanged = stage != presentedCaptureStage
    let hadPresentedStage = presentedCaptureStage != nil
    presentedCaptureStage = stage
    overlayView.setCaptureState(overlayState)

    if stageChanged {
      switch stage {
      case .bodyLocked:
        lockHaptic.impactOccurred(intensity: 0.68)
        captureHaptic.prepare()
      case .capturing:
        captureHaptic.notificationOccurred(.success)
      case .starting, .targetSelection, .positioning, .saving:
        break
      }
    }

    let titleColor: UIColor
    switch stage {
    case .starting, .targetSelection, .positioning:
      titleColor = UIColor(red: 83 / 255, green: 217 / 255, blue: 155 / 255, alpha: 1)
    case .bodyLocked, .capturing:
      titleColor = UIColor(red: 215 / 255, green: 250 / 255, blue: 69 / 255, alpha: 1)
    case .saving:
      titleColor = UIColor(red: 248 / 255, green: 250 / 255, blue: 245 / 255, alpha: 1)
    }

    let applyText = {
      self.statusLabel.text = title
      self.statusLabel.textColor = titleColor
      self.detailLabel.text = detail
    }
    if stageChanged, hadPresentedStage, !UIAccessibility.isReduceMotionEnabled {
      UIView.transition(
        with: statusStack,
        duration: 0.18,
        options: [.transitionCrossDissolve, .beginFromCurrentState, .allowUserInteraction],
        animations: applyText
      )
    } else {
      applyText()
    }

    statusContainer.accessibilityLabel = "Camera status. \(title). \(detail)"
    if stageChanged, let announcement, UIAccessibility.isVoiceOverRunning {
      // UIKit has no web-style aria-live politeness setting. Queue a single
      // finite announcement after the labels settle and discard it if the
      // camera has already advanced to another stage.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
        guard self?.presentedCaptureStage == stage else { return }
        UIAccessibility.post(notification: .announcement, argument: announcement)
      }
    }
  }

  private static func coveragePercent(_ coverage: Double) -> Int {
    Int((min(1, max(0, coverage)) * 100).rounded())
  }

  private static func scaledFont(
    name: String,
    size: CGFloat,
    textStyle: UIFont.TextStyle
  ) -> UIFont {
    let base = UIFont(name: name, size: size) ?? UIFont.systemFont(ofSize: size, weight: .semibold)
    return UIFontMetrics(forTextStyle: textStyle).scaledFont(for: base)
  }

  private static func message(for state: PoseReadinessEvaluator.State) -> String {
    switch state {
    case .noPerson: return "Step fully into frame"
    case .fullBodyRequired: return "Keep your full body visible"
    case .moveCloser: return "Move a little closer"
    case .moveFarther: return "Move a little farther back"
    case .holdStill: return "Hold still for a moment"
    case .ready: return "Ready — swing when comfortable"
    }
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
