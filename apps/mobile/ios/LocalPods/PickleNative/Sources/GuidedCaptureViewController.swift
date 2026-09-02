import AVFoundation
import Foundation
import UIKit

struct GuidedCaptureFailure: LocalizedError {
  let code: String
  let message: String

  var errorDescription: String? { message }
}

/// The one control every camera user already knows: a white ring with a
/// solid core. Idle it reads "record" (volt core); while recording the core
/// morphs into the red stop square, exactly like the system camera. Press
/// feedback is an immediate 0.94 scale so the control feels heard.
final class CaptureShutterButton: UIControl {
  private static let ringDiameter: CGFloat = 78
  private static let coreDiameter: CGFloat = 62
  private static let stopDiameter: CGFloat = 30
  private static let volt = UIColor(red: 215 / 255, green: 250 / 255, blue: 69 / 255, alpha: 1)
  private static let recordRed = UIColor(red: 1, green: 69 / 255, blue: 58 / 255, alpha: 1)

  private let ring = CALayer()
  private let core = CALayer()
  private(set) var isRecording = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    isAccessibilityElement = true
    accessibilityTraits = .button
    ring.borderColor = UIColor.white.withAlphaComponent(0.96).cgColor
    ring.borderWidth = 4
    ring.shadowColor = UIColor.black.cgColor
    ring.shadowOpacity = 0.28
    ring.shadowRadius = 8
    ring.shadowOffset = CGSize(width: 0, height: 2)
    core.backgroundColor = Self.volt.cgColor
    layer.addSublayer(ring)
    layer.addSublayer(core)
    setRecording(false, animated: false)
    addTarget(self, action: #selector(pressBegan), for: [.touchDown, .touchDragEnter])
    addTarget(self, action: #selector(pressEnded), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
  }

  required init?(coder: NSCoder) { nil }

  override var intrinsicContentSize: CGSize {
    CGSize(width: Self.ringDiameter, height: Self.ringDiameter)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let center = CGPoint(x: bounds.midX, y: bounds.midY)
    ring.bounds = CGRect(x: 0, y: 0, width: Self.ringDiameter, height: Self.ringDiameter)
    ring.position = center
    ring.cornerRadius = Self.ringDiameter / 2
    core.position = center
    CATransaction.commit()
  }

  override var isEnabled: Bool {
    didSet { alpha = isEnabled ? 1 : 0.42 }
  }

  /// Nothing appears from nothing: the core scales between its two sizes
  /// with a short spring instead of swapping.
  func setRecording(_ recording: Bool, animated: Bool) {
    isRecording = recording
    accessibilityLabel = recording ? "Stop recording" : "Start recording"
    accessibilityHint = recording
      ? "Discards this attempt and returns to setup"
      : "Starts recording; the stroke is captured automatically when you swing"
    let diameter = recording ? Self.stopDiameter : Self.coreDiameter
    let cornerRadius = recording ? 8 : Self.coreDiameter / 2
    let color = recording ? Self.recordRed : Self.volt
    let apply = {
      self.core.bounds = CGRect(x: 0, y: 0, width: diameter, height: diameter)
      self.core.cornerRadius = cornerRadius
      self.core.backgroundColor = color.cgColor
    }
    guard animated, !UIAccessibility.isReduceMotionEnabled else {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      apply()
      CATransaction.commit()
      return
    }
    CATransaction.begin()
    CATransaction.setAnimationDuration(0.26)
    CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(controlPoints: 0.23, 1, 0.32, 1))
    apply()
    CATransaction.commit()
  }

  @objc private func pressBegan() {
    UIView.animate(withDuration: 0.12, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      self.transform = CGAffineTransform(scaleX: 0.94, y: 0.94)
    }
  }

  @objc private func pressEnded() {
    UIView.animate(withDuration: 0.16, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      self.transform = .identity
    }
  }
}

/// Full-screen, native guided capture. Camera frames, pose inference, overlay
/// rendering, temporal detection, and movie spooling remain native. React
/// Native receives only low-frequency structured state and the completed clip.
///
/// Flow (2026-09-01 redesign — one familiar control):
///   composing  → the camera runs but records NOTHING; the translucent
///                silhouette guide shows where to stand; the shutter is live.
///   recording  → the shutter starts the rolling spool; the athlete walks to
///                the outline; readiness copy is large enough to read from the
///                court; the trigger arms itself on a stable full-body read.
///   capturing  → the swing was detected; the clip window is finalized.
/// Stopping a recording (shutter again) or an observation timeout discards
/// the spool and returns to composing — the camera never closes with an
/// error for the ordinary "I need another go" case.
final class GuidedCaptureViewController: UIViewController {
  typealias EventHandler = ([String: Any]) -> Void
  typealias Completion = (Result<[String: Any], GuidedCaptureFailure>) -> Void

  private enum CapturePresentationStage: Equatable {
    case starting
    case composing
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
  /// OPTIONAL START-SPOT TAP — for crowded courts. The user may tap WHERE
  /// THEY WILL START while composing; the person who OCCUPIES that region
  /// once recording begins becomes the target. Without a tap the largest
  /// full-body person is tracked (ApplePoseProvider's primary-person rule).
  /// The region is initialization only; after lock, identity follows the person.
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
  /// Translucent alignment guide (the app's player silhouette, template
  /// image tinted white). Where to stand and how big to be in frame — sized
  /// so a body matching it lands inside the readiness evaluator's height
  /// window. Fades as the live exoskeleton takes over, hidden once locked.
  private let silhouetteView = UIImageView()
  private let statusContainer = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
  private let statusStack = UIStackView()
  private let statusLabel = UILabel()
  private let detailLabel = UILabel()
  private let closeButton = UIButton(type: .system)
  private let lockHaptic = UIImpactFeedbackGenerator(style: .light)
  private let captureHaptic = UINotificationFeedbackGenerator()
  private var previewLayer: AVCaptureVideoPreviewLayer!

  // ── Camera chrome (shutter / REC chip / zoom / flip / Center Stage) ───────
  private let shutterButton = CaptureShutterButton()
  private let shutterHint = UILabel()
  private let recChip = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
  private let recDot = UIView()
  private let recTimerLabel = UILabel()
  private var recTimer: Timer?
  private var recordingStartedAt: Date?
  private let flipButton = UIButton(type: .system)
  private let centerStageButton = UIButton(type: .system)
  private let zoomContainer = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
  private let zoomStack = UIStackView()
  private var zoomPresetButtons: [UIButton] = []
  private var lastZoomState: CameraEngine.ZoomState?
  private var pinchBaseDisplayZoom: CGFloat = 1
  private let controlHaptic = UIImpactFeedbackGenerator(style: .light)
  private static let controlMint = UIColor(red: 83 / 255, green: 217 / 255, blue: 155 / 255, alpha: 1)
  private static let controlVolt = UIColor(red: 215 / 255, green: 250 / 255, blue: 69 / 255, alpha: 1)
  private static let recordRed = UIColor(red: 1, green: 69 / 255, blue: 58 / 255, alpha: 1)

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
  /// True from the shutter press until the spool finishes (success, user stop
  /// or timeout). Guarded by `stateLock` — the frame callback reads it.
  private var recordingRequested = false
  /// Set when a stop/timeout should DISCARD the finished spool and return to
  /// composing instead of treating the finish as a capture.
  private var discardRecordingOnFinish = false
  private var processingClip = false
  private var terminal = false
  private var lastReadinessEventState: PoseReadinessEvaluator.State?
  private var lastReadinessEventAtMs = 0
  private var presentedCaptureStage: CapturePresentationStage?
  /// Short-lived setup notice ("Recording stopped…") shown in composing
  /// until it expires or the user acts; readiness copy resumes after.
  private var transientNotice: (text: String, until: Date)?
  private var lastComposingSnapshot: PoseReadinessEvaluator.Snapshot?

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
    // The athlete steps away from the phone; auto-lock mid-capture would
    // kill the camera. Restored in viewWillDisappear.
    UIApplication.shared.isIdleTimerDisabled = true
    emit(type: "session", values: ["state": "starting"])
    engine.start()
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    // Never re-enable auto-lock underneath a still-running session capture.
    UIApplication.shared.isIdleTimerDisabled = SessionCaptureCoordinator.anyActive()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    previewLayer.frame = view.bounds
    overlayView.frame = view.bounds
    silhouetteView.frame = Self.silhouetteFrame(in: view.bounds)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    observationTimer?.invalidate()
    recTimer?.invalidate()
  }

  func cancelFromBridge() {
    stateLock.lock()
    let isPreparingSavedClip = processingClip
    stateLock.unlock()
    guard !isPreparingSavedClip else { return }
    finishFailure(code: "camera.cancelled", message: "Guided capture was canceled.", abstention: "user_cancelled")
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  /// The silhouette occupies the same vertical band the framing brackets
  /// enclose (PoseOverlayView.fixedFramingGuidePath): head near 18% of the
  /// screen, shoes near 86%. A body matching it spans ≈0.5 of the frame from
  /// shoulders to ankles — the middle of the readiness evaluator's
  /// 0.32…0.88 window, with room for the swing.
  private static func silhouetteFrame(in bounds: CGRect) -> CGRect {
    let height = bounds.height * 0.68
    let width = bounds.width * 0.86
    return CGRect(
      x: bounds.midX - width / 2,
      y: bounds.height * 0.86 - height,
      width: width,
      height: height
    )
  }

  private func configureView() {
    view.backgroundColor = .black
    previewLayer = engine.makePreviewLayer()
    view.layer.addSublayer(previewLayer)

    silhouetteView.image = UIImage(named: "CaptureSilhouette")?.withRenderingMode(.alwaysTemplate)
    silhouetteView.tintColor = .white
    silhouetteView.contentMode = .scaleAspectFit
    silhouetteView.alpha = 0
    silhouetteView.isUserInteractionEnabled = false
    silhouetteView.isAccessibilityElement = false
    view.addSubview(silhouetteView)

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
    statusLabel.textColor = Self.controlMint
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

    closeButton.configuration = Self.capsuleConfig(symbol: "xmark")
    closeButton.accessibilityLabel = "Close camera"
    closeButton.accessibilityHint = "Stops any recording and closes the camera"
    closeButton.translatesAutoresizingMaskIntoConstraints = false
    closeButton.addTarget(self, action: #selector(closePressed), for: .touchUpInside)
    view.addSubview(closeButton)

    targetRing.strokeColor = Self.controlMint.cgColor
    targetRing.fillColor = UIColor.white.withAlphaComponent(0.10).cgColor
    targetRing.lineWidth = 3
    targetRing.opacity = 0
    view.layer.addSublayer(targetRing)

    let tap = UITapGestureRecognizer(target: self, action: #selector(handleTargetTap(_:)))
    view.addGestureRecognizer(tap)

    let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handleZoomPinch(_:)))
    view.addGestureRecognizer(pinch)

    configureCameraControls()

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
    engine.onZoomStateChanged = { [weak self] state in
      DispatchQueue.main.async { self?.renderZoomState(state) }
    }
    engine.readZoomState { [weak self] state in
      DispatchQueue.main.async { self?.renderZoomState(state) }
    }
  }

  // ── Camera controls: build / render / interact ────────────────────────────

  private static func capsuleConfig(symbol: String, pointSize: CGFloat = 17) -> UIButton.Configuration {
    var config = UIButton.Configuration.filled()
    config.baseBackgroundColor = UIColor.black.withAlphaComponent(0.5)
    config.baseForegroundColor = .white
    config.cornerStyle = .capsule
    config.contentInsets = .zero
    config.image = UIImage(
      systemName: symbol,
      withConfiguration: UIImage.SymbolConfiguration(pointSize: pointSize, weight: .semibold)
    )
    return config
  }

  private func configureCameraControls() {
    // Bottom row, system-camera layout: Center Stage · SHUTTER · flip.
    shutterButton.translatesAutoresizingMaskIntoConstraints = false
    shutterButton.isEnabled = false
    shutterButton.addTarget(self, action: #selector(shutterPressed), for: .touchUpInside)
    view.addSubview(shutterButton)

    shutterHint.font = Self.scaledFont(name: "Manrope-Medium", size: 12, textStyle: .caption1)
    shutterHint.adjustsFontForContentSizeCategory = true
    shutterHint.textColor = UIColor.white.withAlphaComponent(0.78)
    shutterHint.textAlignment = .center
    shutterHint.numberOfLines = 1
    shutterHint.text = "Others on court? Tap where you’ll stand."
    shutterHint.layer.shadowColor = UIColor.black.cgColor
    shutterHint.layer.shadowOpacity = 0.6
    shutterHint.layer.shadowRadius = 4
    shutterHint.layer.shadowOffset = CGSize(width: 0, height: 1)
    shutterHint.alpha = 0
    shutterHint.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(shutterHint)

    flipButton.configuration = Self.capsuleConfig(symbol: "arrow.triangle.2.circlepath.camera")
    flipButton.accessibilityLabel = "Flip camera"
    flipButton.accessibilityHint = "Switches between the rear and front cameras"
    flipButton.translatesAutoresizingMaskIntoConstraints = false
    flipButton.addTarget(self, action: #selector(flipPressed), for: .touchUpInside)
    view.addSubview(flipButton)

    centerStageButton.configuration = Self.capsuleConfig(symbol: "person.and.background.dotted")
    centerStageButton.accessibilityLabel = "Center Stage"
    centerStageButton.accessibilityHint = "Automatically keeps you framed, like FaceTime"
    centerStageButton.translatesAutoresizingMaskIntoConstraints = false
    centerStageButton.addTarget(self, action: #selector(centerStagePressed), for: .touchUpInside)
    centerStageButton.isHidden = true
    view.addSubview(centerStageButton)

    zoomContainer.layer.cornerRadius = 22
    zoomContainer.layer.cornerCurve = .continuous
    zoomContainer.clipsToBounds = true
    zoomContainer.layer.borderWidth = 1
    zoomContainer.layer.borderColor = UIColor.white.withAlphaComponent(0.14).cgColor
    zoomContainer.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(zoomContainer)

    zoomStack.axis = .horizontal
    zoomStack.alignment = .center
    zoomStack.spacing = 4
    zoomStack.translatesAutoresizingMaskIntoConstraints = false
    zoomContainer.contentView.addSubview(zoomStack)

    // REC chip: universal "this is recording" signal + elapsed time.
    recChip.layer.cornerRadius = 16
    recChip.layer.cornerCurve = .continuous
    recChip.clipsToBounds = true
    recChip.layer.borderWidth = 1
    recChip.layer.borderColor = UIColor.white.withAlphaComponent(0.14).cgColor
    recChip.alpha = 0
    recChip.isAccessibilityElement = true
    recChip.accessibilityLabel = "Recording"
    recChip.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(recChip)

    recDot.backgroundColor = Self.recordRed
    recDot.layer.cornerRadius = 5
    recDot.translatesAutoresizingMaskIntoConstraints = false
    recChip.contentView.addSubview(recDot)

    recTimerLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 14, weight: .semibold)
    recTimerLabel.textColor = .white
    recTimerLabel.text = "0:00"
    recTimerLabel.translatesAutoresizingMaskIntoConstraints = false
    recChip.contentView.addSubview(recTimerLabel)

    NSLayoutConstraint.activate([
      shutterButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      shutterButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -30),
      shutterButton.widthAnchor.constraint(equalToConstant: 78),
      shutterButton.heightAnchor.constraint(equalToConstant: 78),

      shutterHint.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      shutterHint.topAnchor.constraint(equalTo: shutterButton.bottomAnchor, constant: 6),
      shutterHint.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
      shutterHint.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),

      flipButton.centerYAnchor.constraint(equalTo: shutterButton.centerYAnchor),
      flipButton.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -30),
      flipButton.widthAnchor.constraint(equalToConstant: 52),
      flipButton.heightAnchor.constraint(equalToConstant: 52),

      centerStageButton.centerYAnchor.constraint(equalTo: shutterButton.centerYAnchor),
      centerStageButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 30),
      centerStageButton.widthAnchor.constraint(equalToConstant: 52),
      centerStageButton.heightAnchor.constraint(equalToConstant: 52),

      zoomContainer.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      zoomContainer.bottomAnchor.constraint(equalTo: shutterButton.topAnchor, constant: -22),
      zoomContainer.heightAnchor.constraint(equalToConstant: 44),

      zoomStack.leadingAnchor.constraint(equalTo: zoomContainer.contentView.leadingAnchor, constant: 6),
      zoomStack.trailingAnchor.constraint(equalTo: zoomContainer.contentView.trailingAnchor, constant: -6),
      zoomStack.topAnchor.constraint(equalTo: zoomContainer.contentView.topAnchor),
      zoomStack.bottomAnchor.constraint(equalTo: zoomContainer.contentView.bottomAnchor),

      recChip.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      recChip.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
      recChip.heightAnchor.constraint(equalToConstant: 32),

      recDot.leadingAnchor.constraint(equalTo: recChip.contentView.leadingAnchor, constant: 12),
      recDot.centerYAnchor.constraint(equalTo: recChip.contentView.centerYAnchor),
      recDot.widthAnchor.constraint(equalToConstant: 10),
      recDot.heightAnchor.constraint(equalToConstant: 10),

      recTimerLabel.leadingAnchor.constraint(equalTo: recDot.trailingAnchor, constant: 8),
      recTimerLabel.trailingAnchor.constraint(equalTo: recChip.contentView.trailingAnchor, constant: -14),
      recTimerLabel.centerYAnchor.constraint(equalTo: recChip.contentView.centerYAnchor),
    ])
  }

  private static let zoomPresets: [CGFloat] = [0.5, 1, 2, 3]

  private func renderZoomState(_ state: CameraEngine.ZoomState) {
    lastZoomState = state

    // Center Stage: rendered wherever the hardware supports it; volt when on.
    centerStageButton.isHidden = !state.centerStageSupported
    var centerStageConfig = centerStageButton.configuration
    centerStageConfig?.baseForegroundColor = state.centerStageEnabled ? Self.controlVolt : .white
    centerStageConfig?.baseBackgroundColor = state.centerStageEnabled
      ? UIColor.black.withAlphaComponent(0.78)
      : UIColor.black.withAlphaComponent(0.5)
    centerStageButton.configuration = centerStageConfig
    centerStageButton.accessibilityValue = state.centerStageEnabled ? "On" : "Off"

    // Zoom cluster: presets inside the device's real range. Hidden while
    // Center Stage owns framing (manual zoom is suspended by the system).
    zoomPresetButtons.forEach { $0.removeFromSuperview() }
    zoomPresetButtons = []
    let presets = Self.zoomPresets.filter {
      $0 >= state.minDisplayZoom - 0.01 && $0 <= state.maxDisplayZoom + 0.01
    }
    let active = Self.nearestPreset(in: presets, to: state.displayZoom)
    for preset in presets {
      var config = UIButton.Configuration.filled()
      let isActive = preset == active
      config.baseBackgroundColor = isActive ? UIColor.white.withAlphaComponent(0.22) : .clear
      config.baseForegroundColor = isActive ? Self.controlVolt : UIColor.white.withAlphaComponent(0.82)
      config.cornerStyle = .capsule
      config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 11, bottom: 8, trailing: 11)
      let title = isActive
        ? String(format: abs(state.displayZoom.rounded() - state.displayZoom) < 0.05 ? "%.0f×" : "%.1f×", state.displayZoom)
        : Self.presetLabel(preset)
      config.attributedTitle = AttributedString(
        title,
        attributes: AttributeContainer([
          .font: UIFont.monospacedDigitSystemFont(ofSize: 13, weight: isActive ? .bold : .semibold),
        ])
      )
      let button = UIButton(configuration: config)
      button.accessibilityLabel = "Zoom \(Self.presetLabel(preset))"
      button.addAction(
        UIAction { [weak self] _ in
          self?.controlHaptic.impactOccurred(intensity: 0.5)
          self?.engine.setDisplayZoom(preset, animated: true)
        },
        for: .touchUpInside
      )
      zoomStack.addArrangedSubview(button)
      zoomPresetButtons.append(button)
    }
    zoomContainer.isHidden = presets.count < 2 || state.centerStageEnabled
    applyControlAvailability()
  }

  private static func presetLabel(_ preset: CGFloat) -> String {
    preset < 1 ? ".5" : String(format: "%.0f×", preset)
  }

  private static func nearestPreset(in presets: [CGFloat], to value: CGFloat) -> CGFloat? {
    presets.min(by: { abs($0 - value) < abs($1 - value) })
  }

  /// Framing controls stay ON SCREEN the whole session. They only become
  /// inert (dimmed) for the few seconds a detected stroke's clip is being
  /// finalized — a lens or framing change mid-write would corrupt the
  /// evidence file itself.
  private var controlsCurrentlyAllowed: Bool {
    presentedCaptureStage != .capturing && presentedCaptureStage != .saving
  }

  private func updateControlVisibility() {
    if let state = lastZoomState {
      renderZoomState(state)
    } else {
      applyControlAvailability()
    }
  }

  private func applyControlAvailability() {
    let allowed = controlsCurrentlyAllowed
    for control in [flipButton, centerStageButton] {
      control.isEnabled = allowed
      control.alpha = allowed ? 1 : 0.45
    }
    zoomContainer.alpha = allowed ? 1 : 0.45
    zoomContainer.isUserInteractionEnabled = allowed
    zoomPresetButtons.forEach { $0.isEnabled = allowed }
    // The shutter is live from the first camera frame until the stroke is
    // caught; it is the record control while composing and the stop control
    // while recording.
    switch presentedCaptureStage {
    case .composing, .positioning, .bodyLocked:
      shutterButton.isEnabled = true
    case .starting, .capturing, .saving, .none:
      shutterButton.isEnabled = false
    }
    let hintVisible = presentedCaptureStage == .composing
    UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState]) {
      self.shutterHint.alpha = hintVisible ? 1 : 0
    }
  }

  @objc private func handleZoomPinch(_ recognizer: UIPinchGestureRecognizer) {
    guard controlsCurrentlyAllowed, let state = lastZoomState, !state.centerStageEnabled else { return }
    switch recognizer.state {
    case .began:
      pinchBaseDisplayZoom = state.displayZoom
    case .changed:
      engine.setDisplayZoom(pinchBaseDisplayZoom * recognizer.scale, animated: false)
    default:
      break
    }
  }

  @objc private func flipPressed() {
    guard controlsCurrentlyAllowed, let state = lastZoomState else { return }
    controlHaptic.impactOccurred(intensity: 0.6)
    let next: AVCaptureDevice.Position = state.position == .back ? .front : .back

    // A flip restarts composition: the tapped start region and occupancy
    // evidence describe the OLD scene.
    let wasRecording = isRecordingRequested
    resetAcquisitionForCameraChange()

    if wasRecording {
      // Mid-recording flip restarts the spool on the new camera so the
      // evidence chain contains only whole single-camera files.
      do {
        let url = try ClipMediaStore.makeObservationURL()
        stateLock.lock()
        observationURL = url
        recordingStarted = false
        stateLock.unlock()
        engine.flipCameraRestartingSpool(to: next, nextRecordingURL: url)
      } catch {
        finishFailure(
          code: "camera.storage_failed",
          message: "A private recording file could not be created.",
          abstention: "storage_failure"
        )
      }
    } else {
      engine.switchCamera(to: next)
    }
  }

  @objc private func centerStagePressed() {
    guard controlsCurrentlyAllowed, let state = lastZoomState else { return }
    controlHaptic.impactOccurred(intensity: 0.6)
    engine.setCenterStageEnabled(!state.centerStageEnabled)
    emit(type: "camera_controls", values: [
      "centerStage": !state.centerStageEnabled ? "enabled" : "disabled",
    ])
  }

  private var isRecordingRequested: Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return recordingRequested
  }

  private func resetAcquisitionForCameraChange() {
    assert(Thread.isMainThread)
    stateLock.lock()
    armed = false
    poseHistory = []
    stateLock.unlock()

    targetAcquisition = .choosingRegion
    startRegion = nil
    occupancyStreak = 0
    occupantTorso = nil
    gestureBest = [:]
    gestureStreaks = [:]
    ambiguousSinceMs = nil
    targetSeed = nil
    targetSeedSource = "start_region_occupancy"
    lockInstrumentFirstFrameMs = nil
    lockInstrumentLastFrameMs = nil
    lockInstrumentAmbiguousEnteredMs = nil
    lockInstrumentLock = nil
    targetRing.opacity = 0

    detector.reset()
    readiness.reset()
    evidenceAccumulator.reset()
    poseProvider.resetPrimaryPersonAnchor()

    emit(type: "target", values: ["state": "reset", "reason": "camera_flipped"])
    if isRecordingRequested {
      updateCapturePresentation(
        stage: .positioning,
        title: "RECORDING",
        detail: "Walk into the outline",
        overlayState: .positioning,
        prominent: true
      )
    } else {
      presentComposing(snapshot: nil)
    }
  }

  private func handleSessionEvent(_ event: CameraEngine.SessionEvent) {
    switch event {
    case .configured:
      emit(type: "session", values: ["state": "configured"])
    case .starting:
      emit(type: "session", values: ["state": "starting"])
    case .running:
      DispatchQueue.main.async { [weak self] in self?.cameraBecameLive() }
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

  /// The camera is live: compose. Nothing is recorded until the shutter.
  private func cameraBecameLive() {
    stateLock.lock()
    let alreadyLive = terminal || presentedCaptureStage != .starting
    stateLock.unlock()
    guard !alreadyLive else { return }
    lockHaptic.prepare()
    selectionHaptic.prepare()
    emit(type: "session", values: ["state": "composing"])
    presentComposing(snapshot: nil)
  }

  // ── Recording lifecycle (shutter) ─────────────────────────────────────────

  @objc private func shutterPressed() {
    guard !terminal else { return }
    if isRecordingRequested {
      stopRecordingFromShutter()
    } else if presentedCaptureStage == .composing {
      startRecordingFromShutter()
    }
  }

  private func startRecordingFromShutter() {
    assert(Thread.isMainThread)
    do {
      let url = try ClipMediaStore.makeObservationURL()
      stateLock.lock()
      observationURL = url
      recordingStarted = false
      recordingRequested = true
      discardRecordingOnFinish = false
      armed = false
      poseHistory = []
      stateLock.unlock()
      detector.reset()
      evidenceAccumulator.reset()
      transientNotice = nil
      if startRegion != nil {
        // A tapped start spot resumes its occupancy hunt now that the user
        // is walking out to it.
        targetAcquisition = .waitingForOccupant
        occupancyStreak = 0
        lockInstrumentFirstFrameMs = nil
        lockInstrumentLastFrameMs = nil
      }
      recordingStartedAt = Date()
      engine.startContinuousRecording(to: url)
      captureHaptic.prepare()
      controlHaptic.impactOccurred(intensity: 0.8)
      shutterButton.setRecording(true, animated: true)
      showRecChip(true)
      observationTimer?.invalidate()
      observationTimer = Timer.scheduledTimer(
        withTimeInterval: Self.observationTimeoutSeconds,
        repeats: false
      ) { [weak self] _ in
        self?.observationTimedOut()
      }
      emit(type: "session", values: ["state": "recording_started"])
      updateCapturePresentation(
        stage: .positioning,
        title: "RECORDING",
        detail: "Walk into the outline",
        overlayState: .positioning,
        prominent: true,
        announcement: "Recording. Walk to your spot; the stroke is captured automatically when you swing."
      )
    } catch {
      finishFailure(
        code: "camera.storage_failed",
        message: "A private recording file could not be created.",
        abstention: "storage_failure"
      )
    }
  }

  /// Shutter pressed while recording: discard the spool and go back to
  /// setup. Not a failure — the user simply wants another go.
  private func stopRecordingFromShutter() {
    assert(Thread.isMainThread)
    stateLock.lock()
    let canStop = pendingStroke == nil && !processingClip && recordingRequested
    if canStop { discardRecordingOnFinish = true }
    stateLock.unlock()
    guard canStop else { return }
    controlHaptic.impactOccurred(intensity: 0.6)
    emit(type: "session", values: ["state": "recording_stopped", "reason": "user_stopped"])
    endRecordingAndCompose(notice: "Recording stopped — tap record when you’re set")
  }

  private func observationTimedOut() {
    assert(Thread.isMainThread)
    stateLock.lock()
    let canReset = pendingStroke == nil && !processingClip && recordingRequested && !terminal
    if canReset { discardRecordingOnFinish = true }
    stateLock.unlock()
    guard canReset else { return }
    emit(type: "session", values: ["state": "recording_stopped", "reason": "observation_timeout"])
    endRecordingAndCompose(notice: "No stroke seen in \(Int(Self.observationTimeoutSeconds))s — tap record to try again")
  }

  /// Shared tail for user stop + timeout: the engine stops and discards the
  /// active spool without a finish callback (decided against the movie
  /// output's real state — see CameraEngine.discardActiveRecording), then
  /// the controller composes again. `discardRecordingOnFinish` stays armed
  /// as a second guard in case a finish is already in flight; the next
  /// shutter press clears it.
  private func endRecordingAndCompose(notice: String) {
    observationTimer?.invalidate()
    observationTimer = nil
    stateLock.lock()
    recordingRequested = false
    recordingStarted = false
    armed = false
    poseHistory = []
    observationURL = nil
    stateLock.unlock()
    // The movie output creates the spool file only once recording actually
    // starts, so a discard against the engine's real state is all the cleanup
    // this path needs — nothing to remove when the start never landed.
    engine.discardActiveRecording()
    detector.reset()
    evidenceAccumulator.reset()
    if startRegion != nil { targetAcquisition = .choosingRegion }
    shutterButton.setRecording(false, animated: true)
    showRecChip(false)
    transientNotice = (notice, Date().addingTimeInterval(3.5))
    presentComposing(snapshot: lastComposingSnapshot)
  }

  private func showRecChip(_ visible: Bool) {
    recTimer?.invalidate()
    recTimer = nil
    if visible {
      recTimerLabel.text = "0:00"
      recTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
        self?.tickRecTimer()
      }
      if !UIAccessibility.isReduceMotionEnabled {
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 1
        pulse.toValue = 0.25
        pulse.duration = 0.7
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        recDot.layer.add(pulse, forKey: "recPulse")
      }
    } else {
      recDot.layer.removeAnimation(forKey: "recPulse")
    }
    UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState]) {
      self.recChip.alpha = visible ? 1 : 0
    }
  }

  private func tickRecTimer() {
    guard let startedAt = recordingStartedAt else { return }
    let elapsed = max(0, Int(Date().timeIntervalSince(startedAt)))
    recTimerLabel.text = String(format: "%d:%02d", elapsed / 60, elapsed % 60)
    recChip.accessibilityValue = "\(elapsed) seconds"
  }

  // ── Frames ────────────────────────────────────────────────────────────────

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
    let recording = recordingRequested
    stateLock.unlock()

    visionQueue.async { [weak self] in
      guard let self else { return }
      defer {
        self.stateLock.lock()
        self.visionInFlight = false
        self.stateLock.unlock()
      }
      do {
        if recording, self.targetAcquisition != .locked, self.startRegion != nil {
          self.considerTargetAcquisition(pixelBuffer: pixelBuffer, timestampMs: timestampMs)
        }
        let pose = try self.poseProvider.extractPose(pixelBuffer: pixelBuffer, timestampMs: timestampMs)
        let snapshot = self.readiness.ingest(pose: pose)
        if recording {
          if snapshot.state == .noPerson {
            self.evidenceAccumulator.ingestMissing(timestampMs: timestampMs)
          } else {
            self.evidenceAccumulator.ingest(pose: pose)
          }
          self.retainPose(pose)
        }
        self.handleReadiness(snapshot)
        if recording, self.startRegion == nil || self.targetAcquisition == .locked {
          // D-029: the completion monitor mirrors the trigger's wrist-motion
          // series, so it ingests exactly the poses the trigger sees.
          self.completionMonitor.ingest(pose: pose)
          self.considerTrigger(pose: pose, readiness: snapshot)
        }
      } catch {
        let snapshot = self.readiness.ingestMissing(timestampMs: timestampMs)
        if recording { self.evidenceAccumulator.ingestMissing(timestampMs: timestampMs) }
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
    let recordingIsActive = recordingStarted && recordingRequested
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

    // NO CONFIDENCE GATE HERE, BY CONSTRUCTION. `StrokeEvent.confidence` is
    // `min(0.95, 0.5 + peakSpeed / (triggerWristSpeed * 4))` and an event is
    // only emitted once `peakSpeed >= triggerWristSpeed`, so the value is
    // structurally floored at 0.75 for EVERY config — a `>= 0.65` check here
    // read like a quality bar but could never reject a single event. Removed
    // rather than retuned: trigger confidence is an ordinal restatement of
    // peak wrist speed, not a calibrated probability, so the real quality
    // controls are the detector's own `triggerWristSpeed` / `minStrokeMs` /
    // `maxStrokeMs` thresholds. Re-adding a gate here needs calibration data.
    guard let event = detector.ingest(pose: pose, paddle: nil) else { return }
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
      guard let self else { return }
      self.observationTimer?.invalidate()
      self.observationTimer = nil
      self.updateCapturePresentation(
        stage: .capturing,
        title: "MOTION CAPTURED",
        detail: "Hold — recording the final frames",
        overlayState: .capturing,
        announcement: "Motion captured. Hold position while the final frames are recorded."
      )
      self.closeButton.isEnabled = false
      self.closeButton.alpha = 0.55
    }
  }

  private func handleReadiness(_ snapshot: PoseReadinessEvaluator.Snapshot) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.overlayView.update(snapshot: snapshot)

      self.stateLock.lock()
      let currentlyArmed = self.armed
      let recording = self.recordingRequested
      self.stateLock.unlock()
      if !recording {
        self.presentComposing(snapshot: snapshot)
      } else if !currentlyArmed {
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
    let discard = discardRecordingOnFinish
    discardRecordingOnFinish = false
    stateLock.unlock()
    guard !isTerminal else {
      if case .success(let artifact) = result { ClipMediaStore.removeIfPresent(artifact.url) }
      return
    }
    if discard {
      // A stop/timeout already returned the UI to composing (and normally
      // the engine suppressed this callback). Nothing to keep.
      if case .success(let artifact) = result { ClipMediaStore.removeIfPresent(artifact.url) }
      return
    }
    switch result {
    case .failure(let error):
      if let engineError = error as? CameraEngine.EngineError,
         case .recordingAlreadyActive = engineError {
        // The shutter was pressed again while the discarded spool was still
        // draining. Retry the start shortly; the discarded spool's finish is
        // suppressed, so the retry lands on an idle movie output.
        stateLock.lock()
        let wantsRecording = recordingRequested && !recordingStarted
        let url = observationURL
        stateLock.unlock()
        guard wantsRecording, let url else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
          guard let self, self.isRecordingRequested else { return }
          self.stateLock.lock()
          let stillPending = !self.recordingStarted && self.observationURL == url
          self.stateLock.unlock()
          if stillPending { self.engine.startContinuousRecording(to: url) }
        }
        return
      }
      finishFailure(
        code: "camera.capture_failed",
        message: error.localizedDescription,
        abstention: "recording_failure"
      )
    case .success(let artifact):
      guard let event, let captureEvidence else {
        // The movie output hit its hard duration cap without a stroke: an
        // honest "nothing detected" — back to setup, not an error screen.
        ClipMediaStore.removeIfPresent(artifact.url)
        emit(type: "session", values: ["state": "recording_stopped", "reason": "no_stroke_detected"])
        DispatchQueue.main.async { [weak self] in
          guard let self else { return }
          self.stateLock.lock()
          self.recordingRequested = false
          self.recordingStarted = false
          self.armed = false
          self.poseHistory = []
          self.observationURL = nil
          self.stateLock.unlock()
          self.observationTimer?.invalidate()
          self.observationTimer = nil
          self.detector.reset()
          self.shutterButton.setRecording(false, animated: true)
          self.showRecChip(false)
          self.transientNotice = ("No complete stroke was detected — tap record to try again", Date().addingTimeInterval(3.5))
          self.presentComposing(snapshot: self.lastComposingSnapshot)
        }
        return
      }
      stateLock.lock()
      processingClip = true
      stateLock.unlock()
      DispatchQueue.main.async { [weak self] in
        self?.showRecChip(false)
        self?.updateCapturePresentation(
          stage: .saving,
          title: "SAVING CAPTURE",
          detail: "Preparing your clip on this device",
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
    DispatchQueue.main.async { [weak self] in self?.recTimer?.invalidate() }
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
    DispatchQueue.main.async { [weak self] in self?.recTimer?.invalidate() }
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

  /// Optional start-spot tap while composing (re-tapping moves the spot).
  /// Ignored once recording has started: identity is then decided by the
  /// occupancy flow (with a spot) or the primary-person rule (without).
  @objc private func handleTargetTap(_ recognizer: UITapGestureRecognizer) {
    stateLock.lock()
    let alreadyCapturing = pendingStroke != nil || terminal
    let recording = recordingRequested
    stateLock.unlock()
    guard !alreadyCapturing, !recording, presentedCaptureStage == .composing else { return }
    let viewPoint = recognizer.location(in: view)
    // Ignore taps on the chrome so a missed shutter press never sets a spot.
    for control in [shutterButton, flipButton, centerStageButton, zoomContainer, closeButton, statusContainer] as [UIView] {
      if !control.isHidden, control.alpha > 0.05, control.frame.insetBy(dx: -8, dy: -8).contains(viewPoint) { return }
    }
    // The start region is compared against pose torso midpoints, which live
    // in NORMALIZED-IMAGE space (top-left origin, rotation applied). The
    // preview layer's captureDevicePointConverted returns the UNROTATED
    // sensor space — a different space that skewed the region for every
    // off-center tap — so the tap is mapped through the displayed picture
    // rect instead, landing in the exact space the occupancy math uses.
    let imagePoint = previewLayer.normalizedImagePoint(fromLayerPoint: viewPoint)
    guard imagePoint.x.isFinite, imagePoint.y.isFinite else { return }
    startRegion = CGPoint(
      x: min(1, max(0, imagePoint.x)),
      y: min(1, max(0, imagePoint.y))
    )
    targetAcquisition = .choosingRegion
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
    shutterHint.text = "Starting spot set — tap record"
    transientNotice = ("Spot set. Tap record, then walk to it", Date().addingTimeInterval(3.5))
    presentComposing(snapshot: lastComposingSnapshot)
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
    if targetAcquisition == .choosingRegion { targetAcquisition = .waitingForOccupant }
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
          stage: .positioning,
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

  // ── Presentation ──────────────────────────────────────────────────────────

  /// Setup state: no recording. Copy tells the user what the camera sees and
  /// that the shutter is the next step; a transient notice (stop/timeout/
  /// spot set) takes precedence until it expires.
  private func presentComposing(snapshot: PoseReadinessEvaluator.Snapshot?) {
    assert(Thread.isMainThread)
    if let snapshot { lastComposingSnapshot = snapshot }
    let effective = snapshot ?? lastComposingSnapshot
    if let notice = transientNotice, notice.until > Date() {
      updateCapturePresentation(
        stage: .composing,
        title: "SET UP",
        detail: notice.text,
        overlayState: .positioning
      )
      return
    }
    transientNotice = nil
    let personVisible = effective.map { $0.state != .noPerson } ?? false
    let spotSet = startRegion != nil
    updateCapturePresentation(
      stage: .composing,
      title: personVisible ? "SET UP · BODY TRACKED" : "SET UP",
      detail: spotSet
        ? "Tap record, then walk to your spot"
        : personVisible
          ? "Tap record, then take your position"
          : "Line up with the outline, then tap record",
      overlayState: .positioning
    )
  }

  private func presentPositioning(snapshot: PoseReadinessEvaluator.Snapshot) {
    let coveragePercent = Self.coveragePercent(snapshot.jointCoverage)
    updateCapturePresentation(
      stage: .positioning,
      title: snapshot.state == .noPerson
        ? "RECORDING"
        : "RECORDING · \(coveragePercent)% KEY JOINTS",
      detail: snapshot.state == .noPerson ? "Walk into the outline" : Self.message(for: snapshot.state),
      overlayState: .positioning,
      prominent: true
    )
  }

  private func presentBodyLocked(jointCoverage: Double) {
    let coveragePercent = Self.coveragePercent(jointCoverage)
    updateCapturePresentation(
      stage: .bodyLocked,
      title: "BODY LOCKED · \(coveragePercent)% KEY JOINTS",
      detail: "Swing when ready",
      overlayState: .locked,
      prominent: true,
      announcement: "Body locked. Swing naturally; capture starts from your movement."
    )
  }

  private func updateCapturePresentation(
    stage: CapturePresentationStage,
    title: String,
    detail: String,
    overlayState: PoseOverlayView.CaptureState,
    prominent: Bool,
    announcement: String? = nil
  ) {
    updateCapturePresentation(
      stage: stage,
      title: title,
      detail: detail,
      overlayState: overlayState,
      announcement: announcement
    )
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
      updateControlVisibility()
      detailLabel.font = Self.scaledFont(name: "Manrope-SemiBold", size: 17, textStyle: .headline)
    }
    updateSilhouette(stage: stage)

    if stageChanged {
      switch stage {
      case .bodyLocked:
        lockHaptic.impactOccurred(intensity: 0.68)
        captureHaptic.prepare()
      case .capturing:
        captureHaptic.notificationOccurred(.success)
      case .starting, .composing, .positioning, .saving:
        break
      }
    }

    let titleColor: UIColor
    switch stage {
    case .starting, .composing:
      titleColor = Self.controlMint
    case .positioning:
      titleColor = Self.recordRed
    case .bodyLocked, .capturing:
      titleColor = Self.controlVolt
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

  /// Silhouette opacity per stage: strongest while composing, softer once
  /// the exoskeleton is tracking a body during recording, gone once locked.
  private func updateSilhouette(stage: CapturePresentationStage) {
    let personVisible = (lastComposingSnapshot?.state ?? .noPerson) != .noPerson
    let target: CGFloat
    switch stage {
    case .starting: target = 0
    case .composing: target = personVisible ? 0.2 : 0.3
    case .positioning: target = personVisible ? 0.14 : 0.26
    case .bodyLocked, .capturing, .saving: target = 0
    }
    guard abs(silhouetteView.alpha - target) > 0.01 else { return }
    UIView.animate(withDuration: 0.25, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      self.silhouetteView.alpha = target
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
