import AVFoundation
import UIKit

/// Landmark ↔ screen mapping for pose evidence drawn over a live preview.
///
/// Pose landmarks live in NORMALIZED-IMAGE space: x,y ∈ [0,1], origin
/// top-left, **rotation already applied** (VisionCoreContracts) — the space
/// of the upright buffers the data connection delivers. The preview layer's
/// own point-conversion APIs (`layerPointConverted(fromCaptureDevicePoint:)`)
/// expect the UNROTATED sensor space used by focus/exposure points of
/// interest, which is a different space; feeding landmarks through them drew
/// the whole body heat map rotated 90° off the athlete. The displayed
/// picture rect (gravity + crop applied) plus the preview connection's
/// mirroring flag are sufficient to place a normalized-image point exactly.
extension AVCaptureVideoPreviewLayer {
  /// The full video picture rect in layer coordinates. The unit metadata
  /// rect always maps to the whole displayed picture regardless of the
  /// connection's rotation or mirroring (those only permute its corners).
  var displayedVideoRect: CGRect {
    layerRectConverted(fromMetadataOutputRect: CGRect(x: 0, y: 0, width: 1, height: 1))
  }

  private var displayedVideoIsMirrored: Bool {
    connection?.isVideoMirrored ?? false
  }

  /// Normalized-image point (top-left origin, rotation applied) → layer point.
  func layerPoint(fromNormalizedImagePoint point: CGPoint) -> CGPoint {
    let rect = displayedVideoRect
    guard rect.width > 0, rect.height > 0,
          rect.width.isFinite, rect.height.isFinite else {
      // Not laid out / not attached yet: scale into the layer bounds so the
      // overlay degrades to approximately-placed rather than exploding.
      return CGPoint(x: point.x * bounds.width, y: point.y * bounds.height)
    }
    let normalizedX = displayedVideoIsMirrored ? 1 - point.x : point.x
    return CGPoint(
      x: rect.minX + normalizedX * rect.width,
      y: rect.minY + point.y * rect.height
    )
  }

  /// Layer point → normalized-image point (inverse of the mapping above),
  /// clamped to [0,1]. Used to express user taps in the SAME space pose
  /// landmarks use so region/occupancy math compares like with like.
  func normalizedImagePoint(fromLayerPoint point: CGPoint) -> CGPoint {
    let rect = displayedVideoRect
    guard rect.width > 0, rect.height > 0,
          rect.width.isFinite, rect.height.isFinite else {
      return CGPoint(
        x: min(1, max(0, bounds.width > 0 ? point.x / bounds.width : 0)),
        y: min(1, max(0, bounds.height > 0 ? point.y / bounds.height : 0))
      )
    }
    let normalizedX = (point.x - rect.minX) / rect.width
    let normalizedY = (point.y - rect.minY) / rect.height
    return CGPoint(
      x: min(1, max(0, displayedVideoIsMirrored ? 1 - normalizedX : normalizedX)),
      y: min(1, max(0, normalizedY))
    )
  }
}

/// Draws only evidence produced by current Apple Vision observations. The
/// athlete is rendered as an EXOSKELETON over a translucent BODY HEAT MAP:
/// crisp bone lines and joint nuclei between observed landmarks (so the user
/// sees exactly what the camera tracks), under soft additive glows whose
/// color and size come from each joint's measured movement speed (cool teal
/// at rest → mint → volt → flame at full swing speed). The heat is
/// deliberately translucent — it marks where motion is, it never paints the
/// athlete over. Skeleton, heat, body-bound lock, and short motion trails
/// disappear when inference loses the athlete; only the static full-body
/// framing guide stays. No decorative scanner or synthetic body data is drawn:
/// every glow center and bone end is an observed landmark or a point on the
/// straight line between two observed landmarks, and every intensity is a
/// measured speed.
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
  /// Heat translucency (2026-09-01): the glows sit UNDER the exoskeleton and
  /// are scaled by this factor so the body reads through them. Tuned so a
  /// full-speed limb is clearly flame-colored yet the athlete stays visible.
  private static let heatOpacity: CGFloat = 0.55
  /// Exoskeleton stroke geometry, in points at radiusUnit = 15 (scaled with
  /// the observed torso so near and far athletes get proportional bones).
  private static let boneWidthAtUnit: CGFloat = 2.6
  private static let jointRadiusAtUnit: CGFloat = 3.6

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

  /// Live-session update path: a raw measured pose frame (no readiness
  /// evaluator runs during session play). Joint coverage is the measured
  /// fraction of visible canonical joints — the same joints the heat map
  /// draws — so brightness still follows real evidence.
  func update(pose: PoseFrame) {
    assert(Thread.isMainThread)
    latestTimestampMs = pose.timestampMs
    readinessState = .ready
    var nextLandmarks: [String: PoseLandmark] = [:]
    for landmark in pose.landmarks { nextLandmarks[landmark.name] = landmark }
    landmarks = nextLandmarks
    let canonical = Set(Self.segments.flatMap { [$0.0, $0.1] })
    let visibleCount = pose.landmarks.filter {
      canonical.contains($0.name) && $0.visibility >= 0.35
    }.count
    jointCoverage = canonical.isEmpty
      ? 0
      : Double(visibleCount) / Double(canonical.count)
    trailBuffer.ingest(landmarks: pose.landmarks, timestampMs: pose.timestampMs)
    setNeedsDisplay()
    redraw()
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
      previewLayer.layerPoint(
        fromNormalizedImagePoint: CGPoint(x: landmark.x, y: landmark.y)
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
    // Heat glows are translucent by design (heatOpacity); the exoskeleton
    // drawn afterwards uses the un-attenuated state/coverage alpha.
    let skeletonAlpha = stateAlpha * coverageAlpha
    let globalAlpha = skeletonAlpha * Self.heatOpacity

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
      let alpha = (0.12 + 0.52 * freshness) * (0.45 + 0.55 * speed) * stateAlpha * Self.heatOpacity
      context.setStrokeColor(heatColor(speed).withAlphaComponent(alpha).cgColor)
      context.setLineWidth(1.75 + 3.25 * speed)
      context.beginPath()
      context.move(
        to: previewLayer.layerPoint(
          fromNormalizedImagePoint: CGPoint(x: segment.startX, y: segment.startY)
        )
      )
      context.addLine(
        to: previewLayer.layerPoint(
          fromNormalizedImagePoint: CGPoint(x: segment.endX, y: segment.endY)
        )
      )
      context.strokePath()
    }
    context.restoreGState()

    drawExoskeleton(
      context: context,
      layerPoint: layerPoint,
      heat: heat,
      radiusUnit: radiusUnit,
      alpha: skeletonAlpha
    )
  }

  // ── Exoskeleton ───────────────────────────────────────────────────────────

  /// Crisp bones + joint nuclei over the heat, in NORMAL blend mode so the
  /// dark contour keeps the lines legible on bright backgrounds (screen blend
  /// can only lighten). Bone color is white tinted toward the measured heat
  /// of its two joints, so a fast limb reads warm without losing its edge.
  /// Every line ends at an observed landmark — nothing is inferred.
  private func drawExoskeleton(
    context: CGContext,
    layerPoint: (PoseLandmark) -> CGPoint,
    heat: (String) -> CGFloat,
    radiusUnit: CGFloat,
    alpha: CGFloat
  ) {
    guard alpha > 0.02 else { return }
    let scale = max(0.6, min(1.6, radiusUnit / 15))
    let boneWidth = Self.boneWidthAtUnit * scale
    let jointRadius = Self.jointRadiusAtUnit * scale
    let contour = UIColor.black.withAlphaComponent(0.32 * alpha)

    context.saveGState()
    context.setBlendMode(.normal)
    context.setLineCap(.round)
    context.setLineJoin(.round)

    var bones: [(CGPoint, CGPoint, CGFloat)] = []
    for (startName, endName) in Self.segments {
      guard let start = visibleLandmark(startName), let end = visibleLandmark(endName) else { continue }
      bones.append((layerPoint(start), layerPoint(end), (heat(startName) + heat(endName)) / 2))
    }
    // Neck: observed head down to the observed shoulder midpoint.
    if let head = visibleLandmark("head"),
       let leftShoulder = visibleLandmark("left_shoulder"),
       let rightShoulder = visibleLandmark("right_shoulder") {
      let neckBase = midpoint(layerPoint(leftShoulder), layerPoint(rightShoulder))
      bones.append((layerPoint(head), neckBase, (heat("left_shoulder") + heat("right_shoulder")) / 2))
    }

    // Contour pass first so every bone carries a thin dark edge.
    context.setStrokeColor(contour.cgColor)
    context.setLineWidth(boneWidth + 2.2 * scale)
    for (start, end, _) in bones {
      context.beginPath()
      context.move(to: start)
      context.addLine(to: end)
      context.strokePath()
    }
    for (start, end, boneHeat) in bones {
      context.setStrokeColor(boneColor(heat: boneHeat).withAlphaComponent(0.9 * alpha).cgColor)
      context.setLineWidth(boneWidth)
      context.beginPath()
      context.move(to: start)
      context.addLine(to: end)
      context.strokePath()
    }

    // Joint nuclei: filled disc with the same contour; hot joints grow a ring.
    let jointNames = Set(Self.segments.flatMap { [$0.0, $0.1] })
    for name in jointNames {
      guard let landmark = visibleLandmark(name) else { continue }
      let center = layerPoint(landmark)
      let jointHeat = heat(name)
      let radius = jointRadius * (1 + 0.35 * jointHeat)
      let visibilityAlpha = CGFloat(0.55 + 0.45 * min(1, max(0, (landmark.visibility - 0.35) / 0.65)))
      let disc = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
      context.setFillColor(contour.cgColor)
      context.fillEllipse(in: disc.insetBy(dx: -1.1 * scale, dy: -1.1 * scale))
      context.setFillColor(boneColor(heat: jointHeat).withAlphaComponent(0.96 * alpha * visibilityAlpha).cgColor)
      context.fillEllipse(in: disc)
      if jointHeat > 0.45 {
        let ringRadius = radius + 3.2 * scale * jointHeat
        context.setStrokeColor(heatColor(jointHeat).withAlphaComponent(0.55 * alpha * jointHeat).cgColor)
        context.setLineWidth(1.2 * scale)
        context.strokeEllipse(in: CGRect(
          x: center.x - ringRadius, y: center.y - ringRadius, width: ringRadius * 2, height: ringRadius * 2
        ))
      }
    }
    context.restoreGState()
  }

  /// White tinted toward the heat ramp as measured speed rises; at rest the
  /// exoskeleton is a clean, neutral white.
  private func boneColor(heat: CGFloat) -> UIColor {
    let clamped = min(1, max(0, heat))
    guard clamped > 0.02 else { return Palette.onDark }
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
    heatColor(clamped).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
    let mix = 0.7 * clamped
    return UIColor(
      red: 248 / 255 * (1 - mix) + red * mix,
      green: 250 / 255 * (1 - mix) + green * mix,
      blue: 245 / 255 * (1 - mix) + blue * mix,
      alpha: 1
    )
  }

  /// Only the body-lock brackets remain layer-drawn; the heat map itself is
  /// rendered in draw(_:) from the same observed landmarks.
  private func redraw() {
    guard previewLayer != nil else { return }
    let visibleLayerPoints = landmarks.values.compactMap { landmark -> CGPoint? in
      guard landmark.visibility >= 0.35, let previewLayer else { return nil }
      return previewLayer.layerPoint(
        fromNormalizedImagePoint: CGPoint(x: landmark.x, y: landmark.y)
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
    // scanner, and never animates. The rect encloses the silhouette guide
    // GuidedCaptureViewController lays out (head ≈18%, shoes ≈86% of the
    // screen) with a small margin, so brackets and outline read as one guide.
    let guideRect = CGRect(
      x: bounds.width * 0.1,
      y: bounds.height * 0.15,
      width: bounds.width * 0.8,
      height: bounds.height * 0.74
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
