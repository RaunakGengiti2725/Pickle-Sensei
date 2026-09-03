import AVFoundation
import Foundation
import UIKit

struct GuidedCaptureFailure: LocalizedError {
  let code: String
  let message: String

  var errorDescription: String? { message }
}

// ─── Camera chrome: the app's own visual language, not UIKit's ──────────────
//
// Every control on the camera is drawn here from the design tokens
// (apps/mobile/src/design/tokens.ts) and the stroke-icon language of
// design/icons.tsx: dark "glass" surfaces (surfaceDark at ~60 % with a
// hairline, continuous corners) instead of system blur materials, Manrope
// instead of SF, 1.8-pt round-capped glyphs instead of SF Symbols. Nothing
// here uses UIButton.Configuration or UIVisualEffectView.

enum CaptureChromePalette {
  static let surfaceDark = UIColor(red: 6 / 255, green: 19 / 255, blue: 14 / 255, alpha: 1)
  static let onDark = UIColor(red: 248 / 255, green: 250 / 255, blue: 245 / 255, alpha: 1)
  static let onDarkMuted = UIColor(red: 165 / 255, green: 177 / 255, blue: 170 / 255, alpha: 1)
  static let mint = UIColor(red: 83 / 255, green: 217 / 255, blue: 155 / 255, alpha: 1)
  static let volt = UIColor(red: 215 / 255, green: 250 / 255, blue: 69 / 255, alpha: 1)
  static let flame = UIColor(red: 255 / 255, green: 155 / 255, blue: 66 / 255, alpha: 1)
  static let onVolt = UIColor(red: 20 / 255, green: 32 / 255, blue: 20 / 255, alpha: 1)
  /// Glass fill + hairline shared by every floating surface on the camera.
  static let glassFill = surfaceDark.withAlphaComponent(0.6)
  static let glassHairline = onDark.withAlphaComponent(0.13)

  static func manrope(_ weight: String, _ size: CGFloat) -> UIFont {
    UIFont(name: "Manrope-\(weight)", size: size)
      ?? UIFont.systemFont(ofSize: size, weight: weight == "Bold" ? .bold : .semibold)
  }
}

/// A floating surface: the dark card the rest of the app uses, translucent so
/// the court stays visible behind it. Continuous corners, hairline, soft
/// shadow. Not a blur material on purpose.
final class CaptureGlassView: UIView {
  init(cornerRadius: CGFloat) {
    super.init(frame: .zero)
    backgroundColor = CaptureChromePalette.glassFill
    layer.cornerRadius = cornerRadius
    layer.cornerCurve = .continuous
    layer.borderWidth = 1
    layer.borderColor = CaptureChromePalette.glassHairline.cgColor
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.22
    layer.shadowRadius = 14
    layer.shadowOffset = CGSize(width: 0, height: 6)
    translatesAutoresizingMaskIntoConstraints = false
  }

  required init?(coder: NSCoder) { nil }

  /// An explicit shadow path keeps Core Animation from re-deriving the shadow
  /// from the composited contents every time a label inside changes (an
  /// offscreen pass per frame on the status card otherwise).
  override func layoutSubviews() {
    super.layoutSubviews()
    layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: layer.cornerRadius).cgPath
  }
}

/// Press feedback shared by the chrome: an immediate 0.94 scale so a control
/// feels heard, released with a slightly slower ease-out.
private func installPressScale(on control: UIControl) {
  control.addTarget(control, action: #selector(UIControl.capturePressBegan), for: [.touchDown, .touchDragEnter])
  control.addTarget(
    control,
    action: #selector(UIControl.capturePressEnded),
    for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit]
  )
}

extension UIControl {
  @objc fileprivate func capturePressBegan() {
    UIView.animate(withDuration: 0.12, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      self.transform = CGAffineTransform(scaleX: 0.94, y: 0.94)
    }
  }

  @objc fileprivate func capturePressEnded() {
    UIView.animate(withDuration: 0.16, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      self.transform = .identity
    }
  }
}

/// Stroke glyphs in the icons.tsx language (24-unit box, 1.8 stroke, round
/// caps/joins), scaled to the requested point size.
enum CaptureGlyph {
  case close
  case flip

  func path(size: CGFloat) -> UIBezierPath {
    let scale = size / 24
    let path = UIBezierPath()
    switch self {
    case .close:
      path.move(to: CGPoint(x: 6, y: 6))
      path.addLine(to: CGPoint(x: 18, y: 18))
      path.move(to: CGPoint(x: 18, y: 6))
      path.addLine(to: CGPoint(x: 6, y: 18))
    case .flip:
      // Lens with two counter-rotating arrows — the camera-swap idea drawn
      // in our own stroke language.
      let center = CGPoint(x: 12, y: 12)
      path.append(UIBezierPath(arcCenter: center, radius: 3.2, startAngle: 0, endAngle: .pi * 2, clockwise: true))
      let radius: CGFloat = 8.6
      let top = UIBezierPath(
        arcCenter: center, radius: radius,
        startAngle: .pi * 1.12, endAngle: .pi * 1.86, clockwise: true
      )
      path.append(top)
      let topEnd = CGPoint(x: center.x + radius * cos(.pi * 1.86), y: center.y + radius * sin(.pi * 1.86))
      path.move(to: CGPoint(x: topEnd.x - 3.6, y: topEnd.y - 1.2))
      path.addLine(to: topEnd)
      path.addLine(to: CGPoint(x: topEnd.x - 1.4, y: topEnd.y + 3.4))
      let bottom = UIBezierPath(
        arcCenter: center, radius: radius,
        startAngle: .pi * 0.12, endAngle: .pi * 0.86, clockwise: true
      )
      path.append(bottom)
      let bottomEnd = CGPoint(x: center.x + radius * cos(.pi * 0.86), y: center.y + radius * sin(.pi * 0.86))
      path.move(to: CGPoint(x: bottomEnd.x + 3.6, y: bottomEnd.y + 1.2))
      path.addLine(to: bottomEnd)
      path.addLine(to: CGPoint(x: bottomEnd.x + 1.4, y: bottomEnd.y - 3.4))
    }
    path.apply(CGAffineTransform(scaleX: scale, y: scale))
    return path
  }
}

/// Round glass button carrying one stroke glyph (close, flip). 48-pt target.
final class CaptureGlyphButton: UIControl {
  static let diameter: CGFloat = 48
  private let glass = CaptureGlassView(cornerRadius: CaptureGlyphButton.diameter / 2)
  private let glyphLayer = CAShapeLayer()
  private let glyphSize: CGFloat = 22

  init(glyph: CaptureGlyph, accessibilityLabel: String, accessibilityHint: String) {
    super.init(frame: .zero)
    isAccessibilityElement = true
    accessibilityTraits = .button
    self.accessibilityLabel = accessibilityLabel
    self.accessibilityHint = accessibilityHint
    translatesAutoresizingMaskIntoConstraints = false
    glass.isUserInteractionEnabled = false
    addSubview(glass)
    glyphLayer.path = glyph.path(size: glyphSize).cgPath
    glyphLayer.fillColor = UIColor.clear.cgColor
    glyphLayer.strokeColor = CaptureChromePalette.onDark.cgColor
    glyphLayer.lineWidth = 1.8
    glyphLayer.lineCap = .round
    glyphLayer.lineJoin = .round
    layer.addSublayer(glyphLayer)
    installPressScale(on: self)
    NSLayoutConstraint.activate([
      glass.leadingAnchor.constraint(equalTo: leadingAnchor),
      glass.trailingAnchor.constraint(equalTo: trailingAnchor),
      glass.topAnchor.constraint(equalTo: topAnchor),
      glass.bottomAnchor.constraint(equalTo: bottomAnchor),
      widthAnchor.constraint(equalToConstant: Self.diameter),
      heightAnchor.constraint(equalToConstant: Self.diameter),
    ])
  }

  required init?(coder: NSCoder) { nil }

  /// Touches that begin on this control belong to it: no recognizer owned by
  /// an ancestor (the preview's zoom pinch) may begin from
  /// them — the same protection UIKit gives UISlider's thumb. Without it a
  /// parent tap recognizer claims the tap and cancels the control's touches.
  override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    gestureRecognizer.view === self
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    glyphLayer.frame = CGRect(
      x: (bounds.width - glyphSize) / 2, y: (bounds.height - glyphSize) / 2,
      width: glyphSize, height: glyphSize
    )
    CATransaction.commit()
  }

  override var isEnabled: Bool {
    didSet { alpha = isEnabled ? 1 : 0.42 }
  }
}

/// Text chip in Manrope small caps — zoom presets and the AUTO FRAME toggle.
/// `isOn` swaps to the volt accent; nothing else changes shape.
final class CaptureTextChip: UIControl {
  private let label = UILabel()
  private let fill = UIView()
  private let baseAlpha: CGFloat

  var isOn = false {
    didSet { render() }
  }

  var text: String {
    get { label.text ?? "" }
    set { label.text = newValue }
  }

  init(text: String, glass: Bool, minWidth: CGFloat = 40, height: CGFloat = 36) {
    baseAlpha = glass ? 1 : 0
    super.init(frame: .zero)
    isAccessibilityElement = true
    accessibilityTraits = .button
    translatesAutoresizingMaskIntoConstraints = false
    fill.isUserInteractionEnabled = false
    fill.layer.cornerRadius = height / 2
    fill.layer.cornerCurve = .continuous
    if glass {
      fill.backgroundColor = CaptureChromePalette.glassFill
      fill.layer.borderWidth = 1
      fill.layer.borderColor = CaptureChromePalette.glassHairline.cgColor
    }
    fill.translatesAutoresizingMaskIntoConstraints = false
    addSubview(fill)
    label.font = CaptureChromePalette.manrope("SemiBold", 13)
    label.textAlignment = .center
    label.text = text
    label.translatesAutoresizingMaskIntoConstraints = false
    label.isUserInteractionEnabled = false
    addSubview(label)
    installPressScale(on: self)
    NSLayoutConstraint.activate([
      fill.leadingAnchor.constraint(equalTo: leadingAnchor),
      fill.trailingAnchor.constraint(equalTo: trailingAnchor),
      fill.topAnchor.constraint(equalTo: topAnchor),
      fill.bottomAnchor.constraint(equalTo: bottomAnchor),
      label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      label.centerYAnchor.constraint(equalTo: centerYAnchor),
      heightAnchor.constraint(equalToConstant: height),
      widthAnchor.constraint(greaterThanOrEqualToConstant: minWidth),
    ])
    render()
  }

  required init?(coder: NSCoder) { nil }

  /// Touches that begin on this control belong to it: no recognizer owned by
  /// an ancestor (the preview's zoom pinch) may begin from
  /// them — the same protection UIKit gives UISlider's thumb. Without it a
  /// parent tap recognizer claims the tap and cancels the control's touches.
  override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    gestureRecognizer.view === self
  }

  private func render() {
    label.textColor = isOn ? CaptureChromePalette.volt : CaptureChromePalette.onDark.withAlphaComponent(0.82)
    label.font = CaptureChromePalette.manrope(isOn ? "Bold" : "SemiBold", 13)
    if baseAlpha == 0 {
      fill.backgroundColor = isOn ? CaptureChromePalette.onDark.withAlphaComponent(0.14) : .clear
    } else {
      fill.layer.borderColor = (isOn ? CaptureChromePalette.volt.withAlphaComponent(0.7) : CaptureChromePalette.glassHairline).cgColor
    }
    accessibilityValue = isOn ? "On" : "Off"
  }

  override var isEnabled: Bool {
    didSet { alpha = isEnabled ? 1 : 0.42 }
  }
}

/// The one control every camera user already knows: a ring with a solid
/// core. Idle it reads "record" (volt core); while recording the core morphs
/// into a stop square in the brand's flame. Press feedback is an immediate
/// 0.94 scale so the control feels heard.
final class CaptureShutterButton: UIControl {
  static let ringDiameter: CGFloat = 78
  private static let coreDiameter: CGFloat = 60
  private static let stopDiameter: CGFloat = 30

  private let ring = CALayer()
  private let core = CAGradientLayer()
  private(set) var isRecording = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    isAccessibilityElement = true
    accessibilityTraits = .button
    ring.borderColor = CaptureChromePalette.onDark.withAlphaComponent(0.96).cgColor
    ring.borderWidth = 3
    ring.shadowColor = UIColor.black.cgColor
    ring.shadowOpacity = 0.3
    ring.shadowRadius = 10
    ring.shadowOffset = CGSize(width: 0, height: 4)
    // A faint top-light on the core so it reads as a physical button, not a
    // flat disc; the gradient stays within the brand volt.
    core.type = .radial
    core.startPoint = CGPoint(x: 0.35, y: 0.3)
    core.endPoint = CGPoint(x: 1, y: 1)
    layer.addSublayer(ring)
    layer.addSublayer(core)
    setRecording(false, animated: false)
    installPressScale(on: self)
  }

  required init?(coder: NSCoder) { nil }

  /// Touches that begin on this control belong to it: no recognizer owned by
  /// an ancestor (the preview's zoom pinch) may begin from them — the same
  /// protection UIKit gives UISlider's thumb. Without it a parent recognizer
  /// could claim the touch and cancel the control's own.
  override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    gestureRecognizer.view === self
  }

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
    ring.shadowPath = UIBezierPath(ovalIn: ring.bounds).cgPath
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
    accessibilityLabel = recording ? "Stop and analyze" : "Start recording"
    accessibilityHint = recording
      ? "Stops the recording and analyzes the strongest swing in it"
      : "Starts recording; the stroke is captured automatically when you swing"
    let diameter = recording ? Self.stopDiameter : Self.coreDiameter
    let cornerRadius = recording ? 8 : Self.coreDiameter / 2
    let base = recording ? CaptureChromePalette.flame : CaptureChromePalette.volt
    let apply = {
      self.core.bounds = CGRect(x: 0, y: 0, width: diameter, height: diameter)
      self.core.cornerRadius = cornerRadius
      self.core.colors = [
        base.lighter(by: 0.18).cgColor,
        base.cgColor,
        base.darker(by: 0.08).cgColor,
      ]
      self.core.locations = [0, 0.55, 1]
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
}

private extension UIColor {
  func lighter(by amount: CGFloat) -> UIColor { blended(toward: .white, amount) }
  func darker(by amount: CGFloat) -> UIColor { blended(toward: .black, amount) }

  private func blended(toward other: UIColor, _ amount: CGFloat) -> UIColor {
    var r1: CGFloat = 0, g1: CGFloat = 0, b1: CGFloat = 0, a1: CGFloat = 0
    var r2: CGFloat = 0, g2: CGFloat = 0, b2: CGFloat = 0, a2: CGFloat = 0
    getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
    other.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
    return UIColor(
      red: r1 + (r2 - r1) * amount,
      green: g1 + (g2 - g1) * amount,
      blue: b1 + (b2 - b1) * amount,
      alpha: a1
    )
  }
}

/// Full-screen, native guided capture. Camera frames, pose inference, overlay
/// rendering, temporal detection, and movie spooling remain native. React
/// Native receives only low-frequency structured state and the completed clip.
///
/// Flow (2026-09-02 — record button, then TRUE auto capture):
///   composing  → the camera is live but records NOTHING; the translucent
///                silhouette shows where to stand; the shutter is the record
///                control. (The athlete decides when recording starts — an
///                auto-start on open was tried and rejected in the field.)
///   recording  → the shutter started the rolling spool; the athlete walks to
///                the outline; readiness copy (large enough to read from the
///                court) is framing ADVICE only — the detector sees every
///                trackable frame and fires on the swing wherever the body
///                stands. "BODY TRACKED" is a status, not a gate. There is no
///                start-spot tap.
///   capturing  → the swing was detected; the clip window is finalized.
/// The shutter while recording is STOP & ANALYZE: an offline pass over the
/// retained pose history finds the strongest swing-like window (permissive
/// trigger) and finalizes the recording around it; with no such window the
/// recording stops and the camera returns to composing with a notice — no
/// clip is invented. Observation timeouts and the movie output's hard cap
/// restart the spool silently while recording; nothing returns the athlete
/// to setup except their own stop.
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
  /// The live trigger waits this long after a spool (re)starts before it may
  /// fire, so a swing already under way when the file began — one the clip
  /// could not contain — is never half-captured. The export's pre-roll clamps
  /// to the file start; this is the only warm-up.
  private static let triggerWarmupMs = 1_000
  /// STOP & ANALYZE excludes the final stretch before the stop: that is the
  /// athlete walking up to the phone, not the swing. The pass itself is
  /// `TemporalStrokeDetector.strongestEvent(in:)` with its permissive
  /// `manualStopConfig` (pinned by vision-core tests).
  private static let manualStopApproachMs = 1_200
  /// Kept 10 s under CameraEngine's 60 s hard movie cap so a late stroke can
  /// never be lost to the cap while the timer waits on a busy main thread.
  private static let observationTimeoutSeconds: TimeInterval = 50

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
  private var lastAcquisitionScanMs = Int.min
  private static let acquisitionScanIntervalMs = 100
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
  /// Retention matches `poseHistoryWindowMs`: STOP & ANALYZE summarizes a
  /// motion window that can be 10+ s old, and the default 4 s would have
  /// left it without evidence.
  private let evidenceAccumulator = CaptureEvidenceAccumulator(retentionMs: 15_000)
  /// Pose inference IS the product's latency: the queue runs at the highest
  /// QoS so the exoskeleton and trigger see every frame Vision can deliver.
  private let visionQueue = DispatchQueue(label: "pickle.guided-capture.vision", qos: .userInteractive)
  private let stateLock = NSLock()

  private let overlayView = PoseOverlayView()
  /// Translucent alignment guide (the app's player silhouette, template
  /// image tinted white). Where to stand and how big to be in frame — laid
  /// out in the GUIDE BAND between the status card and the shutter row (see
  /// viewDidLayoutSubviews), so it can never sit under any chrome. Fades as
  /// the live exoskeleton takes over, hidden once locked.
  private let silhouetteView = UIImageView()
  /// Status card: state dot + kicker on the first row, the instruction on
  /// the second. Fixed height so the guide band below it never jitters as
  /// copy changes.
  private let statusContainer = CaptureGlassView(cornerRadius: 22)
  private let statusDot = UIView()
  private let statusLabel = UILabel()
  private let detailLabel = UILabel()
  private static let statusCardHeight: CGFloat = 68
  private let closeButton = CaptureGlyphButton(
    glyph: .close,
    accessibilityLabel: "Close camera",
    accessibilityHint: "Stops any recording and closes the camera"
  )
  private let lockHaptic = UIImpactFeedbackGenerator(style: .light)
  private let captureHaptic = UINotificationFeedbackGenerator()
  private var previewLayer: AVCaptureVideoPreviewLayer!

  // ── Camera chrome (shutter / REC chip / zoom / flip / auto-frame) ────────
  // Top bar: close · zoom presets (REC chip while recording) · —
  // Guide band: brackets + silhouette, derived from the layout above/below.
  // Bottom row: AUTO FRAME chip (when supported) · shutter · flip.
  private let shutterButton = CaptureShutterButton()
  private let shutterHint = UILabel()
  private let recChip = CaptureGlassView(cornerRadius: 18)
  private let recDot = UIView()
  private let recTimerLabel = UILabel()
  private var recTimer: Timer?
  private var recordingStartedAt: Date?
  private let flipButton = CaptureGlyphButton(
    glyph: .flip,
    accessibilityLabel: "Flip camera",
    accessibilityHint: "Switches between the rear and front cameras"
  )
  private let centerStageButton = CaptureTextChip(text: "AUTO FRAME", glass: true, minWidth: 96, height: 40)
  private let zoomContainer = CaptureGlassView(cornerRadius: 22)
  private let zoomStack = UIStackView()
  private var zoomPresetButtons: [CaptureTextChip] = []
  private var lastZoomState: CameraEngine.ZoomState?
  private var pinchBaseDisplayZoom: CGFloat = 1
  private let controlHaptic = UIImpactFeedbackGenerator(style: .light)
  private static let controlMint = CaptureChromePalette.mint
  private static let controlVolt = CaptureChromePalette.volt
  private static let recordRed = CaptureChromePalette.flame

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
  /// The pending stroke came from STOP & ANALYZE's offline pass, not the live
  /// trigger: no completion instrument ran for it and its provenance says so.
  /// Guarded by `stateLock`.
  private var pendingStrokeIsManual = false
  private var armed = false
  /// Consecutive armed frames without a full body (vision queue only).
  private var armedLossStreak = 0
  /// ≈0.5 s at the ~30 fps Vision sustains: long enough to ride out a
  /// follow-through that clips the frame edge, short enough that a player who
  /// walked off is re-gated by readiness before the next attempt.
  private static let armedLossFramesToDisarm = 15
  private var recordingStarted = false
  /// True from the shutter press until the capture finishes or the athlete
  /// stops. Guarded by `stateLock` — the frame callback reads it.
  private var recordingRequested = false
  /// A finished spool that must be DISCARDED rather than read as a capture
  /// (stop with no swing found). Restarts go through the engine's own
  /// suppression; this is the second fence for an in-flight finish.
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
    let band = guideBand()
    silhouetteView.frame = band.insetBy(dx: view.bounds.width * 0.08, dy: 0)
    overlayView.guideRect = band.insetBy(dx: view.bounds.width * 0.06, dy: 0)
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

  /// The GUIDE BAND: the vertical space between the status card and the
  /// shutter row, measured from the laid-out chrome so the silhouette and
  /// framing brackets can never sit under a control. On a 6.1" phone this is
  /// ≈26 %…82 % of the screen; a body matching the silhouette then spans
  /// ≈0.4 of the frame shoulders→ankles — inside the readiness evaluator's
  /// 0.32…0.88 window with room for the swing.
  private func guideBand() -> CGRect {
    let bounds = view.bounds
    let statusBottom = statusContainer.frame.maxY > 0
      ? statusContainer.frame.maxY
      : view.safeAreaInsets.top + 8 + CaptureGlyphButton.diameter + 10 + Self.statusCardHeight
    let shutterTop = shutterButton.frame.minY > 0
      ? shutterButton.frame.minY
      : bounds.height - view.safeAreaInsets.bottom - 24 - CaptureShutterButton.ringDiameter
    let top = statusBottom + 14
    let bottom = shutterTop - 18
    guard bottom > top + 120 else {
      // Degenerate layout (not laid out yet, or a tiny window): a safe band.
      return CGRect(x: 0, y: bounds.height * 0.24, width: bounds.width, height: bounds.height * 0.56)
    }
    return CGRect(x: 0, y: top, width: bounds.width, height: bottom - top)
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

    // Status card — left-aligned, editorial: dot + kicker, then the instruction.
    statusContainer.isAccessibilityElement = true
    statusContainer.accessibilityTraits = [.staticText, .updatesFrequently]
    view.addSubview(statusContainer)

    statusDot.backgroundColor = Self.controlMint
    statusDot.layer.cornerRadius = 4
    statusDot.translatesAutoresizingMaskIntoConstraints = false
    statusContainer.addSubview(statusDot)

    statusLabel.font = CaptureChromePalette.manrope("SemiBold", 11)
    statusLabel.textColor = Self.controlMint
    statusLabel.textAlignment = .left
    statusLabel.numberOfLines = 1
    statusLabel.adjustsFontSizeToFitWidth = true
    statusLabel.minimumScaleFactor = 0.8
    statusLabel.text = "STARTING CAMERA"
    statusLabel.translatesAutoresizingMaskIntoConstraints = false
    statusContainer.addSubview(statusLabel)

    // One line, shrinking to fit: the card keeps one height in every state
    // so the guide band below it never moves.
    detailLabel.font = CaptureChromePalette.manrope("SemiBold", 17)
    detailLabel.textColor = CaptureChromePalette.onDark
    detailLabel.textAlignment = .left
    detailLabel.numberOfLines = 1
    detailLabel.adjustsFontSizeToFitWidth = true
    detailLabel.minimumScaleFactor = 0.7
    detailLabel.lineBreakMode = .byTruncatingTail
    detailLabel.text = "Starting on-device body tracking…"
    detailLabel.translatesAutoresizingMaskIntoConstraints = false
    statusContainer.addSubview(detailLabel)

    closeButton.addTarget(self, action: #selector(closePressed), for: .touchUpInside)
    view.addSubview(closeButton)

    targetRing.strokeColor = Self.controlMint.cgColor
    targetRing.fillColor = UIColor.white.withAlphaComponent(0.10).cgColor
    targetRing.lineWidth = 3
    targetRing.opacity = 0
    view.layer.addSublayer(targetRing)

    // The preview owns ONE gesture: pinch-to-zoom. (The start-spot tap was
    // removed with the record button — auto capture has nothing to tap.)
    // UIKit exempts just its own stock controls from a parent view's
    // recognizers; our chrome is custom UIControls, so the delegate refuses
    // touches that begin on a control or a chrome surface, and
    // cancelsTouchesInView=false guarantees a recognized gesture can never
    // take a touch away from a view underneath it.
    let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handleZoomPinch(_:)))
    pinch.cancelsTouchesInView = false
    pinch.delegate = self
    view.addGestureRecognizer(pinch)

    configureCameraControls()

    let safe = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      overlayView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      overlayView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      overlayView.topAnchor.constraint(equalTo: view.topAnchor),
      overlayView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

      // Top bar row.
      closeButton.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 16),
      closeButton.topAnchor.constraint(equalTo: safe.topAnchor, constant: 8),

      // Status card spans the width under the top bar; fixed height keeps the
      // guide band stable while the copy changes.
      statusContainer.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 16),
      statusContainer.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -16),
      statusContainer.topAnchor.constraint(equalTo: closeButton.bottomAnchor, constant: 10),
      statusContainer.heightAnchor.constraint(equalToConstant: Self.statusCardHeight),

      statusDot.leadingAnchor.constraint(equalTo: statusContainer.leadingAnchor, constant: 16),
      statusDot.centerYAnchor.constraint(equalTo: statusLabel.centerYAnchor),
      statusDot.widthAnchor.constraint(equalToConstant: 8),
      statusDot.heightAnchor.constraint(equalToConstant: 8),

      statusLabel.leadingAnchor.constraint(equalTo: statusDot.trailingAnchor, constant: 8),
      statusLabel.trailingAnchor.constraint(equalTo: statusContainer.trailingAnchor, constant: -16),
      statusLabel.topAnchor.constraint(equalTo: statusContainer.topAnchor, constant: 12),

      detailLabel.leadingAnchor.constraint(equalTo: statusContainer.leadingAnchor, constant: 16),
      detailLabel.trailingAnchor.constraint(equalTo: statusContainer.trailingAnchor, constant: -16),
      detailLabel.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 4),
      detailLabel.bottomAnchor.constraint(lessThanOrEqualTo: statusContainer.bottomAnchor, constant: -8),
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

  private func configureCameraControls() {
    // Bottom row: AUTO FRAME chip (when the camera supports it) · SHUTTER
    // (record, then stop & analyze) · flip. Top bar: close · zoom presets ·
    // REC chip while recording. Everything is our own glass + glyph language.
    shutterButton.translatesAutoresizingMaskIntoConstraints = false
    shutterButton.isEnabled = false
    shutterButton.addTarget(self, action: #selector(shutterPressed), for: .touchUpInside)
    view.addSubview(shutterButton)

    shutterHint.font = CaptureChromePalette.manrope("Medium", 12)
    shutterHint.textColor = CaptureChromePalette.onDark.withAlphaComponent(0.78)
    shutterHint.textAlignment = .center
    shutterHint.numberOfLines = 1
    shutterHint.text = "Tap to start recording"
    shutterHint.layer.shadowColor = UIColor.black.cgColor
    shutterHint.layer.shadowOpacity = 0.6
    shutterHint.layer.shadowRadius = 4
    shutterHint.layer.shadowOffset = CGSize(width: 0, height: 1)
    shutterHint.alpha = 0
    shutterHint.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(shutterHint)

    flipButton.addTarget(self, action: #selector(flipPressed), for: .touchUpInside)
    view.addSubview(flipButton)

    centerStageButton.accessibilityLabel = "Auto frame"
    centerStageButton.accessibilityHint = "Automatically keeps you framed while you move"
    centerStageButton.addTarget(self, action: #selector(centerStagePressed), for: .touchUpInside)
    centerStageButton.isHidden = true
    view.addSubview(centerStageButton)

    zoomContainer.clipsToBounds = false
    view.addSubview(zoomContainer)

    zoomStack.axis = .horizontal
    zoomStack.alignment = .center
    zoomStack.spacing = 2
    zoomStack.translatesAutoresizingMaskIntoConstraints = false
    zoomContainer.addSubview(zoomStack)

    // REC chip: the universal "this is recording" signal + elapsed time, in
    // the brand's flame and Manrope figures.
    recChip.alpha = 0
    recChip.isAccessibilityElement = true
    recChip.accessibilityLabel = "Recording"
    view.addSubview(recChip)

    recDot.backgroundColor = Self.recordRed
    recDot.layer.cornerRadius = 5
    recDot.translatesAutoresizingMaskIntoConstraints = false
    recChip.addSubview(recDot)

    recTimerLabel.font = CaptureChromePalette.manrope("Bold", 14)
    recTimerLabel.textColor = CaptureChromePalette.onDark
    recTimerLabel.text = "0:00"
    recTimerLabel.translatesAutoresizingMaskIntoConstraints = false
    recChip.addSubview(recTimerLabel)

    let safe = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      shutterButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      shutterButton.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -24),
      shutterButton.widthAnchor.constraint(equalToConstant: CaptureShutterButton.ringDiameter),
      shutterButton.heightAnchor.constraint(equalToConstant: CaptureShutterButton.ringDiameter),

      shutterHint.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      shutterHint.topAnchor.constraint(equalTo: shutterButton.bottomAnchor, constant: 4),
      shutterHint.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
      shutterHint.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),

      flipButton.centerYAnchor.constraint(equalTo: shutterButton.centerYAnchor),
      flipButton.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -28),

      centerStageButton.centerYAnchor.constraint(equalTo: shutterButton.centerYAnchor),
      centerStageButton.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 24),

      // Zoom presets share the top bar with the close button (left) and the
      // REC chip (right): centered when there is room, otherwise pushed off
      // whichever neighbour they would overlap (narrow phones).
      zoomContainer.leadingAnchor.constraint(greaterThanOrEqualTo: closeButton.trailingAnchor, constant: 8),
      zoomContainer.trailingAnchor.constraint(lessThanOrEqualTo: recChip.leadingAnchor, constant: -8),
      zoomContainer.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
      zoomContainer.heightAnchor.constraint(equalToConstant: 44),

      zoomStack.leadingAnchor.constraint(equalTo: zoomContainer.leadingAnchor, constant: 4),
      zoomStack.trailingAnchor.constraint(equalTo: zoomContainer.trailingAnchor, constant: -4),
      zoomStack.topAnchor.constraint(equalTo: zoomContainer.topAnchor),
      zoomStack.bottomAnchor.constraint(equalTo: zoomContainer.bottomAnchor),

      recChip.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -16),
      recChip.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
      recChip.heightAnchor.constraint(equalToConstant: 36),

      recDot.leadingAnchor.constraint(equalTo: recChip.leadingAnchor, constant: 14),
      recDot.centerYAnchor.constraint(equalTo: recChip.centerYAnchor),
      recDot.widthAnchor.constraint(equalToConstant: 10),
      recDot.heightAnchor.constraint(equalToConstant: 10),

      recTimerLabel.leadingAnchor.constraint(equalTo: recDot.trailingAnchor, constant: 8),
      recTimerLabel.trailingAnchor.constraint(equalTo: recChip.trailingAnchor, constant: -16),
      recTimerLabel.centerYAnchor.constraint(equalTo: recChip.centerYAnchor),
    ])
    let zoomCentered = zoomContainer.centerXAnchor.constraint(equalTo: view.centerXAnchor)
    zoomCentered.priority = .defaultHigh
    zoomCentered.isActive = true
  }

  private static let zoomPresets: [CGFloat] = [0.5, 1, 2, 3]

  private func renderZoomState(_ state: CameraEngine.ZoomState) {
    lastZoomState = state

    // Auto frame (Center Stage): rendered wherever the hardware supports it;
    // volt when on.
    centerStageButton.isHidden = !state.centerStageSupported
    centerStageButton.isOn = state.centerStageEnabled

    // Zoom presets inside the device's real range. Hidden only while auto
    // frame owns framing (manual zoom is suspended by the system); recording
    // is always on, so they stay available beside the REC chip.
    zoomPresetButtons.forEach { $0.removeFromSuperview() }
    zoomPresetButtons = []
    let presets = Self.zoomPresets.filter {
      $0 >= state.minDisplayZoom - 0.01 && $0 <= state.maxDisplayZoom + 0.01
    }
    let active = Self.nearestPreset(in: presets, to: state.displayZoom)
    for preset in presets {
      let isActive = preset == active
      let title = isActive
        ? String(format: abs(state.displayZoom.rounded() - state.displayZoom) < 0.05 ? "%.0f×" : "%.1f×", state.displayZoom)
        : Self.presetLabel(preset)
      let chip = CaptureTextChip(text: title, glass: false, minWidth: 44, height: 36)
      chip.isOn = isActive
      chip.accessibilityLabel = "Zoom \(Self.presetLabel(preset))"
      chip.addAction(
        UIAction { [weak self] _ in
          self?.controlHaptic.impactOccurred(intensity: 0.5)
          self?.engine.setDisplayZoom(preset, animated: true)
        },
        for: .touchUpInside
      )
      zoomStack.addArrangedSubview(chip)
      zoomPresetButtons.append(chip)
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

  /// Framing controls stay available the whole session. They only become
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
    flipButton.isEnabled = allowed
    centerStageButton.isEnabled = allowed
    zoomContainer.alpha = allowed ? 1 : 0.45
    zoomContainer.isUserInteractionEnabled = allowed
    zoomPresetButtons.forEach { $0.isEnabled = allowed }
    // The shutter is live from the first camera frame until the stroke is
    // caught: the record control while composing, STOP & ANALYZE while
    // recording, inert once a stroke is being finalized.
    switch presentedCaptureStage {
    case .composing, .positioning, .bodyLocked:
      shutterButton.isEnabled = true
    case .starting, .capturing, .saving, .none:
      shutterButton.isEnabled = false
    }
    let hintVisible = presentedCaptureStage == .composing
      || presentedCaptureStage == .positioning
      || presentedCaptureStage == .bodyLocked
    shutterHint.text = presentedCaptureStage == .composing
      ? "Tap to start recording"
      : "Tap to stop and analyze"
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

  /// THREADING: the detector, readiness evaluator, evidence accumulator and
  /// every target-acquisition variable are owned by `visionQueue` (they are
  /// mutated per frame there). Main-thread code never touches them directly;
  /// it enqueues the mutation so it serializes with frame processing instead
  /// of racing a Swift dictionary/array mid-update.
  private func onVisionQueue(_ work: @escaping () -> Void) {
    visionQueue.async(execute: work)
  }

  private func resetAcquisitionForCameraChange() {
    assert(Thread.isMainThread)
    stateLock.lock()
    armed = false
    poseHistory = []
    stateLock.unlock()

    targetRing.opacity = 0
    onVisionQueue { [self] in
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
      armedLossStreak = 0
      detector.reset()
      readiness.reset()
      evidenceAccumulator.reset()
      poseProvider.resetPrimaryPersonAnchor()
    }

    emit(type: "target", values: ["state": "reset", "reason": "camera_flipped"])
    if isRecordingRequested {
      updateCapturePresentation(
        stage: .positioning,
        title: "RECORDING",
        detail: "Step into the outline",
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
    emit(type: "session", values: ["state": "composing"])
    presentComposing(snapshot: nil)
  }

  // ── Recording lifecycle (shutter → rolling spool → auto capture) ──────────

  private enum RecordingStart {
    /// The shutter was pressed: fresh history, REC timer from zero, copy.
    case initial
    /// The rolling spool was replaced (timeout or the movie output's hard
    /// cap) with nothing detected: silent, the athlete never sees a gap.
    case restart
  }

  private func startRecording(_ kind: RecordingStart) {
    assert(Thread.isMainThread)
    do {
      let url = try ClipMediaStore.makeObservationURL()
      stateLock.lock()
      observationURL = url
      recordingStarted = false
      recordingRequested = true
      discardRecordingOnFinish = false
      pendingStrokeIsManual = false
      completionFinalize = nil
      if kind == .initial {
        armed = false
        poseHistory = []
      }
      stateLock.unlock()
      onVisionQueue { [self] in
        detector.reset()
        armedLossStreak = 0
        if kind == .initial { evidenceAccumulator.reset() }
      }
      engine.startContinuousRecording(to: url)
      scheduleObservationTimer()
      emit(type: "session", values: [
        "state": "recording_started",
        "reason": kind == .initial ? "shutter" : "spool_restart",
      ])
      guard kind == .initial else { return }
      transientNotice = nil
      recordingStartedAt = Date()
      captureHaptic.prepare()
      controlHaptic.impactOccurred(intensity: 0.8)
      shutterButton.setRecording(true, animated: true)
      showRecChip(true)
      updateCapturePresentation(
        stage: .positioning,
        title: "RECORDING",
        detail: "Step into the outline",
        overlayState: .positioning,
        prominent: true,
        announcement: "Recording. Walk to your spot and swing; the stroke is captured automatically. Tap stop to analyze what you have."
      )
    } catch {
      finishFailure(
        code: "camera.storage_failed",
        message: "A private recording file could not be created.",
        abstention: "storage_failure"
      )
    }
  }

  private func scheduleObservationTimer() {
    observationTimer?.invalidate()
    observationTimer = Timer.scheduledTimer(
      withTimeInterval: Self.observationTimeoutSeconds,
      repeats: false
    ) { [weak self] _ in
      self?.observationTimedOut()
    }
  }

  /// Rolling spool: nothing was detected in this file, so it is replaced by a
  /// fresh one under the movie output's hard cap — same camera, no callback
  /// for the discarded file, REC timer untouched. The detector restarts so no
  /// event can straddle two files; the pose history is kept (STOP & ANALYZE
  /// only considers poses inside the current file).
  private func observationTimedOut() {
    assert(Thread.isMainThread)
    stateLock.lock()
    let canRestart = pendingStroke == nil && !processingClip && recordingRequested && !terminal
    stateLock.unlock()
    guard canRestart else { return }
    emit(type: "session", values: ["state": "recording_stopped", "reason": "observation_timeout"])
    do {
      let url = try ClipMediaStore.makeObservationURL()
      stateLock.lock()
      observationURL = url
      recordingStarted = false
      stateLock.unlock()
      onVisionQueue { [self] in
        detector.reset()
        armedLossStreak = 0
      }
      engine.flipCameraRestartingSpool(to: lastZoomState?.position ?? .back, nextRecordingURL: url)
      scheduleObservationTimer()
      emit(type: "session", values: ["state": "recording_started", "reason": "spool_restart"])
    } catch {
      finishFailure(
        code: "camera.storage_failed",
        message: "A private recording file could not be created.",
        abstention: "storage_failure"
      )
    }
  }

  @objc private func shutterPressed() {
    guard !terminal else { return }
    if isRecordingRequested {
      captureFromStop()
    } else if presentedCaptureStage == .composing {
      startRecording(.initial)
    }
  }

  /// STOP & ANALYZE. The live trigger can miss a swing the athlete knows
  /// happened (a soft dink, a body partly clipped by the frame edge), so the
  /// stop button never just discards: an offline pass runs the same detector
  /// over the retained pose history with a permissive trigger, the strongest
  /// motion window it finds becomes the stroke, and the recording is
  /// finalized around it. If nothing in the history moved like a swing, the
  /// recording stops and the camera returns to composing with a notice — the
  /// athlete asked to stop, and no clip is invented.
  private func captureFromStop() {
    assert(Thread.isMainThread)
    stateLock.lock()
    let canStop = pendingStroke == nil && !processingClip && recordingRequested && recordingStarted
    let history = poseHistory
    stateLock.unlock()
    guard canStop else { return }
    controlHaptic.impactOccurred(intensity: 0.8)
    let fileStartMs = engine.currentRecordingFirstFrameTimestampMs
    let stopMs = engine.currentRecordingLastFrameTimestampMs ?? history.last?.timestampMs
    emit(type: "session", values: ["state": "manual_stop_requested"])

    onVisionQueue { [self] in
      let version = Self.manualStopModelVersion(detector.modelVersion)
      guard let stopMs,
            let event = Self.manualStopEvent(history: history, fileStartMs: fileStartMs, stopMs: stopMs),
            let evidence = evidenceAccumulator.summary(
              startMs: event.startMs,
              endMs: event.endMs,
              poseSource: "apple_vision_body_pose",
              poseModelVersion: poseProvider.modelVersion,
              triggerAlgorithmVersion: version
            )
      else {
        emit(type: "session", values: ["state": "manual_stop_no_motion"])
        DispatchQueue.main.async { [weak self] in
          self?.stopRecordingWithoutCapture(notice: "No swing found — tap record and swing again")
        }
        return
      }
      stateLock.lock()
      guard pendingStroke == nil, !terminal, recordingRequested else {
        stateLock.unlock()
        return
      }
      pendingStroke = event
      pendingCaptureEvidence = evidence
      pendingStrokeIsManual = true
      // The user decided the end: finalize at the stop, the export's post-roll
      // clamps to the last recorded frame.
      completionFinalize = CompletionFinalize(atMs: stopMs, requestedEndMs: event.endMs)
      stateLock.unlock()

      var strokePayload: [String: Any] = [
        "startTimestampMs": event.startMs,
        "endTimestampMs": event.endMs,
        "confidence": event.confidence,
        "detectionModelVersion": version,
        "source": "manual_stop",
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
          title: "SWING FOUND",
          detail: "Saving the swing",
          overlayState: .capturing,
          announcement: "Swing found. Saving."
        )
        self.closeButton.isEnabled = false
        self.closeButton.alpha = 0.55
      }
      engine.stopContinuousRecording()
    }
  }

  /// Provenance for a stop-button window: the live detector's version plus
  /// the pass that produced it, so an analysis can never be mistaken for a
  /// live-trigger capture.
  private static func manualStopModelVersion(_ liveVersion: String) -> String {
    "\(liveVersion)/manual-stop-relaxed-1"
  }

  /// Offline pass over the retained history: only poses inside the current
  /// file (a rolling restart may have replaced it) and older than the
  /// approach window count. The strongest event wins; nil when nothing moved
  /// like a swing.
  private static func manualStopEvent(history: [PoseFrame], fileStartMs: Int?, stopMs: Int) -> StrokeEvent? {
    let cutoff = stopMs - manualStopApproachMs
    let lowerBound = fileStartMs ?? Int.min
    let usable = history.filter { $0.timestampMs >= lowerBound && $0.timestampMs <= cutoff }
    guard usable.count >= 8 else { return nil }
    return TemporalStrokeDetector.strongestEvent(in: usable)
  }

  /// Stop pressed with no swing in the history: the spool is discarded
  /// through the engine's own suppression (decided on the session queue
  /// against the movie output's real state) and the camera composes again
  /// with a notice. Not a failure — the athlete simply gets another go.
  private func stopRecordingWithoutCapture(notice: String) {
    assert(Thread.isMainThread)
    stateLock.lock()
    let canStop = pendingStroke == nil && !processingClip && recordingRequested && !terminal
    if canStop {
      recordingRequested = false
      recordingStarted = false
      armed = false
      poseHistory = []
      observationURL = nil
      discardRecordingOnFinish = true
    }
    stateLock.unlock()
    guard canStop else { return }
    observationTimer?.invalidate()
    observationTimer = nil
    engine.discardActiveRecording()
    onVisionQueue { [self] in
      detector.reset()
      evidenceAccumulator.reset()
      armedLossStreak = 0
    }
    emit(type: "session", values: ["state": "recording_stopped", "reason": "user_stopped"])
    controlHaptic.impactOccurred(intensity: 0.6)
    shutterButton.setRecording(false, animated: true)
    showRecChip(false)
    transientNotice = (notice, Date().addingTimeInterval(4))
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
        if recording, self.targetAcquisition != .locked, self.startRegion != nil,
           timestampMs - self.lastAcquisitionScanMs >= Self.acquisitionScanIntervalMs {
          // The occupancy hunt is a SECOND full-body inference; at every frame
          // it halved the pose rate the trigger sees. ~10 Hz is plenty to lock
          // a person standing on a spot.
          self.lastAcquisitionScanMs = timestampMs
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
        self.handleReadiness(snapshot, pose: pose)
        if recording, self.startRegion == nil || self.targetAcquisition == .locked {
          // D-029: the completion monitor mirrors the trigger's wrist-motion
          // series, so it ingests exactly the poses the trigger sees.
          self.completionMonitor.ingest(pose: pose)
          self.considerTrigger(pose: pose, readiness: snapshot)
        }
      } catch {
        // No person this frame (motion blur mid-swing is the common cause).
        // The detector is NOT reset: its ≤250 ms sample-gap rule already
        // ignores speeds across a gap, so a stroke in progress survives a
        // dropped frame instead of being silently discarded.
        let snapshot = self.readiness.ingestMissing(timestampMs: timestampMs)
        if recording { self.evidenceAccumulator.ingestMissing(timestampMs: timestampMs) }
        self.handleReadiness(snapshot, pose: nil)
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
    let wasTracked = armed
    let isTerminal = terminal
    let hasPending = pendingStroke != nil
    let recordingIsActive = recordingStarted && recordingRequested
    stateLock.unlock()
    guard !isTerminal, !hasPending, recordingIsActive else { return }

    // BODY TRACKED is presentation + telemetry, NOT a gate. The previous
    // design armed the trigger only after readiness said `ready` (full body
    // inside the margins, 0.32–0.88 tall, 450 ms still) and reset the
    // detector on every other frame — so an athlete standing a step too far
    // ("Move a little closer") could swing all day and nothing was ever
    // detected. Now the detector sees every trackable frame; readiness only
    // decides what the status card says.
    if snapshot.isReady {
      armedLossStreak = 0
      if !wasTracked {
        stateLock.lock()
        armed = true
        stateLock.unlock()
        DispatchQueue.main.async { [weak self] in
          self?.presentBodyLocked(jointCoverage: snapshot.jointCoverage)
        }
        emit(type: "session", values: ["state": "armed"])
      }
    } else if wasTracked, snapshot.state == .noPerson || snapshot.state == .fullBodyRequired {
      // A swing routinely pushes a knee or ankle past the frame edge for a
      // few frames (follow-through). Tolerate a short loss; drop the lock
      // only once the athlete has really left (≈half a second).
      armedLossStreak += 1
      if armedLossStreak >= Self.armedLossFramesToDisarm {
        armedLossStreak = 0
        stateLock.lock()
        armed = false
        stateLock.unlock()
        DispatchQueue.main.async { [weak self] in self?.presentPositioning(snapshot: snapshot) }
        emit(type: "session", values: ["state": "disarmed", "reason": snapshot.state.rawValue])
      }
    } else {
      armedLossStreak = 0
    }

    // Warm-up: a swing already under way when this file began could not be
    // exported whole, so the trigger waits `triggerWarmupMs` after the first
    // recorded frame (the detector keeps ingesting so its speed history is
    // continuous when the gate opens).
    let warmedUp: Bool
    if let first = engine.currentRecordingFirstFrameTimestampMs {
      warmedUp = pose.timestampMs - first >= Self.triggerWarmupMs
    } else {
      warmedUp = false
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
    let detected = detector.ingest(pose: pose, paddle: nil)
    guard warmedUp, let event = detected else { return }
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
    pendingStrokeIsManual = false
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
        detail: "Hold — saving the swing",
        overlayState: .capturing,
        announcement: "Motion captured. Hold position while the final frames are recorded."
      )
      self.closeButton.isEnabled = false
      self.closeButton.alpha = 0.55
    }
  }

  /// `pose` is the raw measured frame (nil when Vision found nobody). The
  /// overlay draws it directly so the exoskeleton locks onto the body the
  /// instant it is observed — including frames the readiness evaluator
  /// rejects for low whole-frame confidence, which used to blank the body.
  /// Arming still goes through the evaluator's verdict only.
  private func handleReadiness(_ snapshot: PoseReadinessEvaluator.Snapshot, pose: PoseFrame?) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.overlayView.update(
        pose: pose,
        readinessState: snapshot.state,
        jointCoverage: snapshot.jointCoverage,
        timestampMs: snapshot.timestampMs
      )

      self.lastComposingSnapshot = snapshot
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
        // The movie output hit its hard duration cap without a stroke. The
        // recording is automatic, so this is not a state the athlete should
        // ever notice: the file is dropped and a fresh spool starts at once.
        ClipMediaStore.removeIfPresent(artifact.url)
        emit(type: "session", values: ["state": "recording_stopped", "reason": "no_stroke_detected"])
        DispatchQueue.main.async { [weak self] in
          guard let self else { return }
          self.stateLock.lock()
          let stillWanted = self.recordingRequested && !self.terminal
          self.recordingStarted = false
          self.observationURL = nil
          self.stateLock.unlock()
          guard stillWanted else { return }
          self.startRecording(.restart)
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
          detail: "Preparing your clip",
          overlayState: .saving,
          announcement: "Saving capture."
        )
      }
      emit(type: "processing", values: ["state": "preparing_clip"])
      stateLock.lock()
      let retainedPoseHistory = poseHistory
      let finalize = completionFinalize
      let manualStop = pendingStrokeIsManual
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
      // STOP & ANALYZE: the user decided the end, no completion instrument
      // ran, and the provenance names the offline pass — never the live
      // trigger's version.
      let completionTelemetry: StrokeCompletionMonitor.Telemetry? = manualStop
        ? nil
        : completionMonitor.telemetry(
          strategy: completionStrategy,
          finalizeMs: finalize?.atMs ?? max(artifact.lastFrameTimestampMs, event.endMs)
        )
      ClipMediaStore.exportStrokeWindow(
        artifact: artifact,
        event: event,
        detectionModelVersion: manualStop
          ? Self.manualStopModelVersion(detector.modelVersion)
          : detector.modelVersion,
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
    // Target state belongs to the vision queue; read it there. This runs on
    // the export completion thread, never on the vision queue itself, so the
    // synchronous hop cannot deadlock.
    visionQueue.sync {
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

  private static let isoFormatter = ISO8601DateFormatter()

  private func emit(type: String, values: [String: Any]) {
    var payload = values
    payload["type"] = type
    payload["captureId"] = captureId
    payload["emittedAtIso"] = Self.isoFormatter.string(from: Date())
    onEvent?(payload)
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
  /// that the shutter is the next step; a transient notice (stop with no
  /// swing found) takes precedence until it expires.
  private func presentComposing(snapshot: PoseReadinessEvaluator.Snapshot?) {
    assert(Thread.isMainThread)
    if let snapshot { lastComposingSnapshot = snapshot }
    let personVisible = (snapshot ?? lastComposingSnapshot).map { $0.state != .noPerson } ?? false
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
    updateCapturePresentation(
      stage: .composing,
      title: personVisible ? "SET UP · BODY TRACKED" : "SET UP",
      detail: personVisible ? "Tap record, then take your spot" : "Match the outline, then tap record",
      overlayState: .positioning
    )
  }

  /// Recording, body not yet tracked: the readiness message is framing ADVICE
  /// (detection runs regardless). A transient notice (stop pressed with no
  /// swing in the history) takes precedence until it expires.
  private func presentPositioning(snapshot: PoseReadinessEvaluator.Snapshot) {
    let coveragePercent = Self.coveragePercent(snapshot.jointCoverage)
    let detail: String
    if let notice = transientNotice, notice.until > Date() {
      detail = notice.text
    } else {
      transientNotice = nil
      detail = snapshot.state == .noPerson ? "Step into the outline" : Self.message(for: snapshot.state)
    }
    updateCapturePresentation(
      stage: .positioning,
      title: snapshot.state == .noPerson
        ? "RECORDING"
        : "RECORDING · \(coveragePercent)% KEY JOINTS",
      detail: detail,
      overlayState: .positioning,
      prominent: true
    )
  }

  private func presentBodyLocked(jointCoverage: Double) {
    let coveragePercent = Self.coveragePercent(jointCoverage)
    updateCapturePresentation(
      stage: .bodyLocked,
      title: "BODY TRACKED · \(coveragePercent)% KEY JOINTS",
      detail: "Swing when ready",
      overlayState: .locked,
      prominent: true,
      announcement: "Body tracked. Swing naturally; the stroke is captured from your movement."
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
    // Distance-readable: the athlete may be 15–25 feet from the phone. One
    // line at 24 pt (shrinking to fit) keeps the card's fixed height honest.
    detailLabel.font = CaptureChromePalette.manrope(prominent ? "Bold" : "SemiBold", prominent ? 24 : 17)
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
      detailLabel.font = CaptureChromePalette.manrope("SemiBold", 17)
    }
    updateSilhouette(stage: stage)
    // This runs once per pose frame; the labels only re-measure when the
    // copy actually changed (UILabel re-lays out on every assignment).
    let copyChanged = title != statusLabel.text || detail != detailLabel.text
    guard stageChanged || copyChanged else { return }

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

    // State color: mint while setting up, flame while recording, volt once
    // the body is locked / the swing is caught, chalk while saving. Carried
    // by both the kicker and the status dot.
    let titleColor: UIColor
    switch stage {
    case .starting, .composing:
      titleColor = Self.controlMint
    case .positioning:
      titleColor = Self.recordRed
    case .bodyLocked, .capturing:
      titleColor = Self.controlVolt
    case .saving:
      titleColor = CaptureChromePalette.onDark
    }

    let applyText = {
      self.statusLabel.text = title
      self.statusLabel.textColor = titleColor
      self.statusDot.backgroundColor = titleColor
      self.detailLabel.text = detail
    }
    if stageChanged, hadPresentedStage, !UIAccessibility.isReduceMotionEnabled {
      UIView.transition(
        with: statusContainer,
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

  /// Framing advice while recording. Detection is live in every one of these
  /// states, so the copy never implies a swing would not count.
  private static func message(for state: PoseReadinessEvaluator.State) -> String {
    switch state {
    case .noPerson: return "Step into the outline"
    case .fullBodyRequired: return "Keep your whole body in view"
    case .moveCloser: return "A little closer, then swing"
    case .moveFarther: return "A little farther back, then swing"
    case .holdStill: return "Set your feet, then swing"
    case .ready: return "Swing when ready"
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

// ─── Touch ownership: controls first, preview second ─────────────────────────

extension GuidedCaptureViewController: UIGestureRecognizerDelegate {
  /// Every floating surface a touch may begin on. A touch inside any of them
  /// (or inside any UIControl) belongs to that view, never to the preview
  /// gestures — the shutter, close, flip, zoom and auto-frame controls must
  /// always receive their own taps.
  private var chromeSurfaces: [UIView] {
    [statusContainer, zoomContainer, recChip]
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldReceive touch: UITouch
  ) -> Bool {
    var candidate: UIView? = touch.view
    while let current = candidate, current !== view {
      if current is UIControl { return false }
      if chromeSurfaces.contains(where: { $0 === current }) { return false }
      candidate = current.superview
    }
    return true
  }

  /// Tap and pinch coexist: a pinch that starts as two taps must not block
  /// either recognizer from finishing.
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    true
  }
}
