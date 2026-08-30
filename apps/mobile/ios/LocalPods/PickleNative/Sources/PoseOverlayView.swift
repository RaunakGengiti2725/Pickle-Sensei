import AVFoundation
import UIKit

/// Draws only evidence produced by current Apple Vision observations. Instead
/// of a stick figure, the athlete is rendered as a BODY HEAT MAP: soft
/// additive glows placed at observed landmarks and along observed limb lines,
/// whose color and size come from each joint's measured movement speed
/// (cool teal at rest → mint → volt → flame at full swing speed). The heat
/// map, body-bound lock, and short motion trails disappear when inference
/// loses the athlete; only the static full-body framing guide stays. No
/// decorative scanner or synthetic body data is drawn: every glow center is
/// an observed landmark or a point on the straight line between two observed
/// landmarks, and every intensity is a measured speed.
final class PoseOverlayView: UIView {
  enum CaptureState: Equatable {
    case starting
    case positioning
    case locked
    case capturing
    case saving

    var showsBodyLock: Bool {
      switch self {
      case .locked, .capturing, .saving: return true
      case .starting, .positioning: return false
      }
    }
  }

  private enum Palette {
    static let mint = UIColor(red: 83 / 255, green: 217 / 255, blue: 155 / 255, alpha: 1)
    static let volt = UIColor(red: 215 / 255, green: 250 / 255, blue: 69 / 255, alpha: 1)
    static let onDark = UIColor(red: 248 / 255, green: 250 / 255, blue: 245 / 255, alpha: 1)
  }

  /// Measured-speed heat ramp: deep teal → mint → volt → flame. Values are
  /// the app's design tokens (color.mint / color.volt / color.flame).
  private static let heatStops: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [
    (0.00, 26 / 255, 166 / 255, 138 / 255),
    (0.35, 83 / 255, 217 / 255, 155 / 255),
    (0.70, 215 / 255, 250 / 255, 69 / 255),
    (1.00, 255 / 255, 155 / 255, 66 / 255),
  ]

  private let bodyLockLayer = CAShapeLayer()
  weak var previewLayer: AVCaptureVideoPreviewLayer?

  private var landmarks: [String: PoseLandmark] = [:]
  /// Shoulders and knees are tracked in addition to the default joints so the
  /// whole heat map is backed by per-joint MEASURED speeds — never a guessed
  /// intensity for an untracked region.
  private var trailBuffer = PoseMotionTrailBuffer(
    config: PoseMotionTrailBuffer.Config(
      trackedJoints: [
        "left_shoulder", "right_shoulder",
        "left_elbow", "right_elbow",
        "left_wrist", "right_wrist",
        "left_hip", "right_hip",
        "left_knee", "right_knee",
        "left_ankle", "right_ankle",
      ]
    )
  )
  private var latestTimestampMs: Int?
  private var readinessState: PoseReadinessEvaluator.State = .noPerson
  private var jointCoverage = 0.0
  private var captureState: CaptureState = .starting
  /// Quantized-gradient cache so per-frame drawing never re-allocates
  /// CGGradients (keyed by heat bucket × alpha bucket).
  private var gradientCache: [Int: CGGradient] = [:]

  private static let segments: [(String, String)] = [
    ("left_shoulder", "right_shoulder"),
    ("left_shoulder", "left_elbow"),
    ("left_elbow", "left_wrist"),
    ("right_shoulder", "right_elbow"),
    ("right_elbow", "right_wrist"),
    ("left_shoulder", "left_hip"),
    ("right_shoulder", "right_hip"),
    ("left_hip", "right_hip"),
    ("left_hip", "left_knee"),
    ("left_knee", "left_ankle"),
    ("right_hip", "right_knee"),
    ("right_knee", "right_ankle"),
  ]
  /// The head landmark glows only when Vision actually observed it
  /// (ApplePoseProvider maps VN `.nose` to "head").
  private static let headJoints = ["head"]
  private static let minimumTrailSpeed = 0.06
  private static let fullIntensitySpeed = 1.25

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    backgroundColor = .clear
    isOpaque = false
    contentMode = .redraw

    bodyLockLayer.fillColor = UIColor.clear.cgColor
    bodyLockLayer.strokeColor = Palette.volt.cgColor
    bodyLockLayer.lineWidth = 3
    bodyLockLayer.lineCap = .round
    bodyLockLayer.lineJoin = .round
    layer.addSublayer(bodyLockLayer)
  }

  required init?(coder: NSCoder) { nil }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    bodyLockLayer.frame = bounds
    CATransaction.commit()
    redraw()
  }

  /// Readiness state and coverage arrive from the evidence evaluator. The view
  /// never infers lock from landmark geometry alone.
  func update(snapshot: PoseReadinessEvaluator.Snapshot) {
    assert(Thread.isMainThread)
    readinessState = snapshot.state
    jointCoverage = snapshot.jointCoverage
    latestTimestampMs = snapshot.timestampMs

    if snapshot.state == .noPerson {
      landmarks.removeAll(keepingCapacity: true)
      trailBuffer.clear()
    } else {
      var nextLandmarks: [String: PoseLandmark] = [:]
      for landmark in snapshot.landmarks { nextLandmarks[landmark.name] = landmark }
      landmarks = nextLandmarks
      trailBuffer.ingest(landmarks: snapshot.landmarks, timestampMs: snapshot.timestampMs)
    }
    setNeedsDisplay()
    redraw()
  }

  func setCaptureState(_ nextState: CaptureState) {
    assert(Thread.isMainThread)
    let acquiredLock = nextState == .locked && captureState != .locked
    captureState = nextState
    setNeedsDisplay()
    redraw()
    if acquiredLock { animateLockAcquired() }
  }

  func clear() {
    assert(Thread.isMainThread)
    landmarks.removeAll(keepingCapacity: true)
    trailBuffer.clear()
    latestTimestampMs = nil
    readinessState = .noPerson
    jointCoverage = 0
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    bodyLockLayer.path = nil
    CATransaction.commit()
    setNeedsDisplay()
    redraw()
  }

  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext(),
          let previewLayer,
          let latestTimestampMs,
          !landmarks.isEmpty
    else { return }

    context.saveGState()
    context.setBlendMode(.screen)
    context.setLineCap(.round)
    context.setLineJoin(.round)

    let measuredSegments = trailBuffer.segments(at: latestTimestampMs)
    var newestSegmentByJoint: [String: PoseMotionTrailSegment] = [:]
    for segment in measuredSegments {
      if let current = newestSegmentByJoint[segment.joint], current.ageFraction <= segment.ageFraction {
        continue
      }
      newestSegmentByJoint[segment.joint] = segment
    }

    // Per-joint heat: the newest measured speed, normalized to the full-swing
    // ceiling and faded by sample age. A joint with no fresh measurement has
    // zero heat — it still glows the cool "observed" base, nothing hotter.
    var heatByJoint: [String: CGFloat] = [:]
    for (joint, segment) in newestSegmentByJoint {
      let speed = CGFloat(
        min(1, max(0, segment.normalizedSpeedPerSecond / Self.fullIntensitySpeed))
      )
      let freshness = CGFloat(max(0, 1 - segment.ageFraction))
      heatByJoint[joint] = speed * (0.4 + 0.6 * freshness)
    }
    let heat: (String) -> CGFloat = { heatByJoint[$0] ?? 0 }

    let layerPoint: (PoseLandmark) -> CGPoint = { landmark in
      previewLayer.layerPointConverted(
        fromCaptureDevicePoint: CGPoint(x: landmark.x, y: landmark.y)
      )
    }

    // The glow radius follows the observed body scale (torso extent in layer
    // points) so the aura hugs the athlete whether near or far.
    let radiusUnit = glowRadiusUnit(layerPoint: layerPoint)

    // Global brightness: dimmer while positioning, full once locked, calm
    // while saving; partial joint coverage dims everything proportionally.
    let stateAlpha: CGFloat
    switch captureState {
    case .starting, .positioning: stateAlpha = 0.8
    case .locked, .capturing: stateAlpha = 1
    case .saving: stateAlpha = 0.62
    }
    let coverageAlpha = CGFloat(min(1, max(0.52, jointCoverage)))
    let globalAlpha = stateAlpha * coverageAlpha

    // ── Torso mass: observed shoulder/hip corners fill the trunk ─────────
    if let leftShoulder = visibleLandmark("left_shoulder"),
       let rightShoulder = visibleLandmark("right_shoulder"),
       let leftHip = visibleLandmark("left_hip"),
       let rightHip = visibleLandmark("right_hip") {
      let corners = [leftShoulder, rightShoulder, leftHip, rightHip]
      let points = corners.map(layerPoint)
      let torsoHeat =
        (heat("left_shoulder") + heat("right_shoulder") + heat("left_hip") + heat("right_hip")) / 4
      let shoulderMid = midpoint(points[0], points[1])
      let hipMid = midpoint(points[2], points[3])
      let centroid = midpoint(shoulderMid, hipMid)
      for (center, scale) in [(centroid, 2.1), (shoulderMid, 1.5), (hipMid, 1.4)] {
        drawGlow(
          context: context,
          center: center,
          radius: radiusUnit * scale * (1 + 0.35 * torsoHeat),
          heat: torsoHeat,
          alpha: (0.1 + 0.14 * torsoHeat) * globalAlpha
        )
      }
    }

    // ── Limb heat: interpolated between each segment's two OBSERVED ends ──
    for (startName, endName) in Self.segments {
      guard let start = visibleLandmark(startName), let end = visibleLandmark(endName) else {
        continue
      }
      let startPoint = layerPoint(start)
      let endPoint = layerPoint(end)
      let startHeat = heat(startName)
      let endHeat = heat(endName)
      let length = hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y)
      let steps = max(2, min(5, Int(length / max(radiusUnit, 1))))
      for step in 0 ... steps {
        let t = CGFloat(step) / CGFloat(steps)
        let pointHeat = startHeat + (endHeat - startHeat) * t
        drawGlow(
          context: context,
          center: CGPoint(
            x: startPoint.x + (endPoint.x - startPoint.x) * t,
            y: startPoint.y + (endPoint.y - startPoint.y) * t
          ),
          radius: radiusUnit * (0.85 + 1.05 * pointHeat),
          heat: pointHeat,
          alpha: (0.09 + 0.15 * pointHeat) * globalAlpha
        )
      }
    }

    // ── Joint cores + observed head: brighter nuclei over the aura ───────
    for name in Set(Self.segments.flatMap { [$0.0, $0.1] }) {
      guard let landmark = visibleLandmark(name) else { continue }
      let visibilityAlpha = CGFloat(0.5 + 0.5 * min(1, max(0, (landmark.visibility - 0.35) / 0.65)))
      let jointHeat = heat(name)
      drawGlow(
        context: context,
        center: layerPoint(landmark),
        radius: radiusUnit * (0.55 + 0.95 * jointHeat),
        heat: jointHeat,
        alpha: (0.17 + 0.21 * jointHeat) * visibilityAlpha * globalAlpha
      )
    }
    for name in Self.headJoints {
      guard let landmark = visibleLandmark(name) else { continue }
      drawGlow(
        context: context,
        center: layerPoint(landmark),
        radius: radiusUnit * 1.1,
        heat: 0,
        alpha: 0.12 * globalAlpha
      )
    }

    // ── Motion trails: measured displacement streaks ride on the heat ────
    // At most 12 joints × 7 segments are drawn. Width, color, and opacity
    // come from observed displacement and timestamp age, not a looping
    // effect.
    for segment in measuredSegments {
      guard segment.normalizedSpeedPerSecond >= Self.minimumTrailSpeed else { continue }
      let speed = CGFloat(
        min(1, max(0, segment.normalizedSpeedPerSecond / Self.fullIntensitySpeed))
      )
      let freshness = CGFloat(max(0, 1 - segment.ageFraction))
      let alpha = (0.12 + 0.52 * freshness) * (0.45 + 0.55 * speed) * stateAlpha
      context.setStrokeColor(heatColor(speed).withAlphaComponent(alpha).cgColor)
      context.setLineWidth(1.75 + 3.25 * speed)
      context.beginPath()
      context.move(
        to: previewLayer.layerPointConverted(
          fromCaptureDevicePoint: CGPoint(x: segment.startX, y: segment.startY)
        )
      )
      context.addLine(
        to: previewLayer.layerPointConverted(
          fromCaptureDevicePoint: CGPoint(x: segment.endX, y: segment.endY)
        )
      )
      context.strokePath()
    }
    context.restoreGState()
  }

  /// Only the body-lock brackets remain layer-drawn; the heat map itself is
  /// rendered in draw(_:) from the same observed landmarks.
  private func redraw() {
    guard previewLayer != nil else { return }
    let visibleLayerPoints = landmarks.values.compactMap { landmark -> CGPoint? in
      guard landmark.visibility >= 0.35, let previewLayer else { return nil }
      return previewLayer.layerPointConverted(
        fromCaptureDevicePoint: CGPoint(x: landmark.x, y: landmark.y)
      )
    }

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    bodyLockLayer.path = captureState.showsBodyLock
      ? bodyLockPath(around: visibleLayerPoints)?.cgPath
      : fixedFramingGuidePath()?.cgPath

    switch captureState {
    case .starting, .positioning:
      let guideAlpha: CGFloat
      switch readinessState {
      case .ready: guideAlpha = 0.94
      case .noPerson: guideAlpha = 0.58
      case .fullBodyRequired, .moveCloser, .moveFarther, .holdStill: guideAlpha = 0.72
      }
      bodyLockLayer.strokeColor = Palette.mint.withAlphaComponent(guideAlpha).cgColor
    case .locked, .capturing:
      bodyLockLayer.strokeColor = Palette.volt.cgColor
    case .saving:
      bodyLockLayer.strokeColor = Palette.onDark.cgColor
    }
    // Readiness remains separately tracked even after lock so a future visual
    // treatment cannot silently reinterpret geometry as evaluator evidence.
    bodyLockLayer.opacity = bodyLockLayer.path == nil ? 0 : 1
    CATransaction.commit()
  }

  // ── Heat-map drawing helpers ──────────────────────────────────────────────

  private func drawGlow(
    context: CGContext,
    center: CGPoint,
    radius: CGFloat,
    heat: CGFloat,
    alpha: CGFloat
  ) {
    guard alpha > 0.015, radius > 1 else { return }
    guard let gradient = cachedGradient(heat: heat, alpha: min(1, alpha)) else { return }
    context.drawRadialGradient(
      gradient,
      startCenter: center,
      startRadius: 0,
      endCenter: center,
      endRadius: radius,
      options: .drawsAfterEndLocation
    )
  }

  /// Gradients are quantized (24 heat × 20 alpha buckets) and cached; per
  /// frame drawing allocates nothing.
  private func cachedGradient(heat: CGFloat, alpha: CGFloat) -> CGGradient? {
    let heatBucket = Int((min(1, max(0, heat)) * 23).rounded())
    let alphaBucket = Int((min(1, max(0, alpha)) * 19).rounded())
    let key = heatBucket * 100 + alphaBucket
    if let cached = gradientCache[key] { return cached }
    let color = heatColor(CGFloat(heatBucket) / 23)
    let bucketAlpha = CGFloat(alphaBucket) / 19
    let gradient = CGGradient(
      colorsSpace: CGColorSpaceCreateDeviceRGB(),
      colors: [
        color.withAlphaComponent(bucketAlpha).cgColor,
        color.withAlphaComponent(bucketAlpha * 0.42).cgColor,
        color.withAlphaComponent(0).cgColor,
      ] as CFArray,
      locations: [0, 0.55, 1]
    )
    if let gradient { gradientCache[key] = gradient }
    return gradient
  }

  /// Piecewise-linear ramp over `heatStops` (teal → mint → volt → flame).
  private func heatColor(_ t: CGFloat) -> UIColor {
    let clamped = min(1, max(0, t))
    let stops = Self.heatStops
    for index in 1 ..< stops.count where clamped <= stops[index].0 {
      let (fromT, fromR, fromG, fromB) = stops[index - 1]
      let (toT, toR, toG, toB) = stops[index]
      let span = max(toT - fromT, 0.0001)
      let local = (clamped - fromT) / span
      return UIColor(
        red: fromR + (toR - fromR) * local,
        green: fromG + (toG - fromG) * local,
        blue: fromB + (toB - fromB) * local,
        alpha: 1
      )
    }
    let last = stops[stops.count - 1]
    return UIColor(red: last.1, green: last.2, blue: last.3, alpha: 1)
  }

  /// Base glow radius from the observed torso extent so the aura scales with
  /// the athlete's on-screen size. Falls back to a fixed unit while the torso
  /// is not fully observed.
  private func glowRadiusUnit(layerPoint: (PoseLandmark) -> CGPoint) -> CGFloat {
    guard let leftShoulder = visibleLandmark("left_shoulder"),
          let rightShoulder = visibleLandmark("right_shoulder"),
          let leftHip = visibleLandmark("left_hip"),
          let rightHip = visibleLandmark("right_hip")
    else { return 15 }
    let shoulderMid = midpoint(layerPoint(leftShoulder), layerPoint(rightShoulder))
    let hipMid = midpoint(layerPoint(leftHip), layerPoint(rightHip))
    let torsoLength = hypot(hipMid.x - shoulderMid.x, hipMid.y - shoulderMid.y)
    return min(30, max(9, torsoLength * 0.17))
  }

  private func midpoint(_ a: CGPoint, _ b: CGPoint) -> CGPoint {
    CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
  }

  private func visibleLandmark(_ name: String) -> PoseLandmark? {
    guard let landmark = landmarks[name], landmark.visibility >= 0.35 else { return nil }
    return landmark
  }

  private func fixedFramingGuidePath() -> UIBezierPath? {
    guard bounds.width > 0, bounds.height > 0 else { return nil }
    // A static, deliberately spacious target helps the athlete place their
    // complete body before any pose exists. It is a framing affordance, not a
    // scanner, and never animates.
    let guideRect = CGRect(
      x: bounds.width * 0.14,
      y: bounds.height * 0.24,
      width: bounds.width * 0.72,
      height: bounds.height * 0.62
    )
    return cornerPath(in: guideRect)
  }

  private func bodyLockPath(around points: [CGPoint]) -> UIBezierPath? {
    guard let first = points.first else { return nil }
    var minX = first.x
    var maxX = first.x
    var minY = first.y
    var maxY = first.y
    for point in points.dropFirst() {
      minX = min(minX, point.x)
      maxX = max(maxX, point.x)
      minY = min(minY, point.y)
      maxY = max(maxY, point.y)
    }

    let inset: CGFloat = 18
    let left = max(12, minX - inset)
    let right = min(bounds.width - 12, maxX + inset)
    let top = max(12, minY - inset)
    let bottom = min(bounds.height - 12, maxY + inset)
    guard right > left, bottom > top else { return nil }

    return cornerPath(in: CGRect(x: left, y: top, width: right - left, height: bottom - top))
  }

  private func cornerPath(in rect: CGRect) -> UIBezierPath {
    let left = rect.minX
    let right = rect.maxX
    let top = rect.minY
    let bottom = rect.maxY
    let corner = min(28, min(rect.width, rect.height) * 0.18)
    let path = UIBezierPath()
    path.move(to: CGPoint(x: left, y: top + corner))
    path.addLine(to: CGPoint(x: left, y: top))
    path.addLine(to: CGPoint(x: left + corner, y: top))
    path.move(to: CGPoint(x: right - corner, y: top))
    path.addLine(to: CGPoint(x: right, y: top))
    path.addLine(to: CGPoint(x: right, y: top + corner))
    path.move(to: CGPoint(x: right, y: bottom - corner))
    path.addLine(to: CGPoint(x: right, y: bottom))
    path.addLine(to: CGPoint(x: right - corner, y: bottom))
    path.move(to: CGPoint(x: left + corner, y: bottom))
    path.addLine(to: CGPoint(x: left, y: bottom))
    path.addLine(to: CGPoint(x: left, y: bottom - corner))
    return path
  }

  private func animateLockAcquired() {
    bodyLockLayer.removeAnimation(forKey: "bodyLockAcquired")
    guard !UIAccessibility.isReduceMotionEnabled, bodyLockLayer.path != nil else { return }

    let stroke = CABasicAnimation(keyPath: "strokeEnd")
    stroke.fromValue = 0
    stroke.toValue = 1
    let opacity = CABasicAnimation(keyPath: "opacity")
    opacity.fromValue = 0.35
    opacity.toValue = 1
    let group = CAAnimationGroup()
    group.animations = [stroke, opacity]
    group.duration = 0.24
    group.timingFunction = CAMediaTimingFunction(name: .easeOut)
    bodyLockLayer.add(group, forKey: "bodyLockAcquired")
  }
}
