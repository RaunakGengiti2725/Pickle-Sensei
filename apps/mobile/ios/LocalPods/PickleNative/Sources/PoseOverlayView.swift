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
    normalizedImageMapper().layerPoint(point)
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

  /// The displayed-picture mapping resolved ONCE (the AVFoundation rect
  /// conversion is not free) so a frame's dozens of landmarks are placed
  /// with plain arithmetic.
  func normalizedImageMapper() -> NormalizedImageMapper {
    let rect = displayedVideoRect
    let usable = rect.width > 0 && rect.height > 0 && rect.width.isFinite && rect.height.isFinite
    // Not laid out / not attached yet: scale into the layer bounds so the
    // overlay degrades to approximately-placed rather than exploding.
    return NormalizedImageMapper(
      rect: usable ? rect : CGRect(origin: .zero, size: bounds.size),
      mirrored: usable && displayedVideoIsMirrored
    )
  }
}

struct NormalizedImageMapper {
  let rect: CGRect
  let mirrored: Bool

  func layerPoint(_ point: CGPoint) -> CGPoint {
    let normalizedX = mirrored ? 1 - point.x : point.x
    return CGPoint(x: rect.minX + normalizedX * rect.width, y: rect.minY + point.y * rect.height)
  }
}

/// Draws only evidence produced by current Apple Vision observations. The
/// athlete is rendered as an EXOSKELETON over a translucent BODY HEAT MAP:
/// crisp bone lines and joint nuclei between observed landmarks (so the user
/// sees exactly what the camera tracks), under soft glows whose color and
/// size come from each joint's measured movement speed (cool teal at rest →
/// mint → volt → flame at full swing speed). The heat is deliberately
/// translucent — it marks where motion is, it never paints the athlete over.
///
/// RENDERING (2026-09-02): everything is Core Animation layers updated once
/// per pose frame inside a single transaction — shape layers for bones,
/// joints, limb heat and trails, one radial gradient layer per joint glow.
/// The previous `draw(_:)` implementation re-rasterized the full-screen
/// bitmap on the CPU with ~90 radial gradients per frame and saturated the
/// main thread (laggy chrome, delayed touches). Layers are composited on the
/// GPU; per-frame CPU work is now path building only. Nothing here is
/// decorative or synthetic: every bone end, glow center and trail segment is
/// an observed landmark, and every intensity is a measured speed.
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
    static let flame = UIColor(red: 255 / 255, green: 155 / 255, blue: 66 / 255, alpha: 1)
    static let onDark = UIColor(red: 248 / 255, green: 250 / 255, blue: 245 / 255, alpha: 1)
    static let contour = UIColor.black.withAlphaComponent(0.32)
  }

  /// Measured-speed heat ramp: deep teal → mint → volt → flame. Values are
  /// the app's design tokens (color.mint / color.volt / color.flame).
  private static let heatStops: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [
    (0.00, 26 / 255, 166 / 255, 138 / 255),
    (0.35, 83 / 255, 217 / 255, 155 / 255),
    (0.70, 215 / 255, 250 / 255, 69 / 255),
    (1.00, 255 / 255, 155 / 255, 66 / 255),
  ]

  weak var previewLayer: AVCaptureVideoPreviewLayer?
  /// The framing brackets' rect in view coordinates, supplied by the
  /// controller from its laid-out chrome (the GUIDE BAND between the status
  /// card and the shutter row) so brackets, silhouette and controls can never
  /// overlap. Nil → a proportional fallback guide.
  var guideRect: CGRect? {
    didSet {
      guard guideRect != oldValue else { return }
      renderBodyLock()
    }
  }

  // ── Layers, bottom → top ─────────────────────────────────────────────────
  private let torsoGlow = CAGradientLayer()
  private var jointGlows: [String: CAGradientLayer] = [:]
  /// Hot limbs as wide translucent strokes, bucketed by heat so each layer
  /// keeps a single color (mint / volt / flame).
  private let limbHeatLayers: [CAShapeLayer] = [CAShapeLayer(), CAShapeLayer(), CAShapeLayer()]
  private let trailLayer = CAShapeLayer()
  private let boneContourLayer = CAShapeLayer()
  private let boneLayer = CAShapeLayer()
  private let jointContourLayer = CAShapeLayer()
  private let jointLayer = CAShapeLayer()
  private let hotJointRingLayer = CAShapeLayer()
  private let bodyLockLayer = CAShapeLayer()

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
  private static let canonicalJoints: [String] = Array(Set(segments.flatMap { [$0.0, $0.1] })).sorted()
  /// The head landmark glows only when Vision actually observed it
  /// (ApplePoseProvider maps VN `.nose` to "head").
  private static let headJoint = "head"
  private static let minimumTrailSpeed = 0.06
  private static let fullIntensitySpeed = 1.25
  /// Heat translucency: the glows sit UNDER the exoskeleton and are scaled by
  /// this factor so the body reads through them. Tuned so a full-speed limb is
  /// clearly flame-colored yet the athlete stays visible.
  private static let heatOpacity: CGFloat = 0.55
  /// Exoskeleton stroke geometry, in points at radiusUnit = 15 (scaled with
  /// the observed torso so near and far athletes get proportional bones).
  private static let boneWidthAtUnit: CGFloat = 2.6
  private static let jointRadiusAtUnit: CGFloat = 3.6
  private static let limbHeatBuckets: [(min: CGFloat, color: UIColor)] = [
    (0.2, Palette.mint), (0.5, Palette.volt), (0.8, Palette.flame),
  ]

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    backgroundColor = .clear
    isOpaque = false

    torsoGlow.type = .radial
    torsoGlow.startPoint = CGPoint(x: 0.5, y: 0.5)
    torsoGlow.endPoint = CGPoint(x: 1, y: 0.5)
    torsoGlow.opacity = 0
    layer.addSublayer(torsoGlow)
    for joint in Self.canonicalJoints + [Self.headJoint] {
      let glow = CAGradientLayer()
      glow.type = .radial
      glow.startPoint = CGPoint(x: 0.5, y: 0.5)
      glow.endPoint = CGPoint(x: 1, y: 0.5)
      glow.opacity = 0
      layer.addSublayer(glow)
      jointGlows[joint] = glow
    }
    for (index, limb) in limbHeatLayers.enumerated() {
      limb.fillColor = UIColor.clear.cgColor
      limb.strokeColor = Self.limbHeatBuckets[index].color.cgColor
      limb.lineCap = .round
      limb.lineJoin = .round
      layer.addSublayer(limb)
    }
    trailLayer.fillColor = UIColor.clear.cgColor
    trailLayer.strokeColor = Palette.volt.cgColor
    trailLayer.lineCap = .round
    trailLayer.lineJoin = .round
    layer.addSublayer(trailLayer)

    boneContourLayer.fillColor = UIColor.clear.cgColor
    boneContourLayer.strokeColor = Palette.contour.cgColor
    boneContourLayer.lineCap = .round
    boneContourLayer.lineJoin = .round
    layer.addSublayer(boneContourLayer)
    boneLayer.fillColor = UIColor.clear.cgColor
    boneLayer.strokeColor = Palette.onDark.cgColor
    boneLayer.lineCap = .round
    boneLayer.lineJoin = .round
    layer.addSublayer(boneLayer)
    jointContourLayer.fillColor = Palette.contour.cgColor
    jointContourLayer.strokeColor = UIColor.clear.cgColor
    layer.addSublayer(jointContourLayer)
    jointLayer.fillColor = Palette.onDark.cgColor
    jointLayer.strokeColor = UIColor.clear.cgColor
    layer.addSublayer(jointLayer)
    hotJointRingLayer.fillColor = UIColor.clear.cgColor
    hotJointRingLayer.strokeColor = Palette.flame.cgColor
    layer.addSublayer(hotJointRingLayer)

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
    for shape in [trailLayer, boneContourLayer, boneLayer, jointContourLayer, jointLayer, hotJointRingLayer, bodyLockLayer] + limbHeatLayers {
      shape.frame = bounds
    }
    CATransaction.commit()
    render()
  }

  // ── Inputs ────────────────────────────────────────────────────────────────

  /// Guided-capture update path: the RAW measured pose plus the evaluator's
  /// verdict. The exoskeleton follows every observed landmark (per-landmark
  /// visibility floor 0.35) even on frames the readiness evaluator rejects
  /// for low whole-frame confidence — the user sees the body being tracked
  /// the instant Vision finds it, while arming stays strictly evaluator-gated.
  /// `pose` nil means Vision found no person: the body clears.
  func update(pose: PoseFrame?, readinessState state: PoseReadinessEvaluator.State, jointCoverage coverage: Double, timestampMs: Int) {
    assert(Thread.isMainThread)
    readinessState = state
    jointCoverage = coverage
    latestTimestampMs = timestampMs
    if let pose {
      ingest(landmarks: pose.landmarks, timestampMs: pose.timestampMs)
    } else {
      landmarks.removeAll(keepingCapacity: true)
      trailBuffer.clear()
    }
    render()
  }

  /// Live-session update path: a raw measured pose frame (no readiness
  /// evaluator runs during session play). Joint coverage is the measured
  /// fraction of visible canonical joints — the same joints the heat map
  /// draws — so brightness still follows real evidence.
  func update(pose: PoseFrame) {
    assert(Thread.isMainThread)
    latestTimestampMs = pose.timestampMs
    readinessState = .ready
    let visibleCount = pose.landmarks.filter {
      Self.canonicalJoints.contains($0.name) && $0.visibility >= 0.35
    }.count
    jointCoverage = Self.canonicalJoints.isEmpty
      ? 0
      : Double(visibleCount) / Double(Self.canonicalJoints.count)
    ingest(landmarks: pose.landmarks, timestampMs: pose.timestampMs)
    render()
  }

  func setCaptureState(_ nextState: CaptureState) {
    assert(Thread.isMainThread)
    guard nextState != captureState else { return }
    let acquiredLock = nextState == .locked
    captureState = nextState
    render()
    if acquiredLock { animateLockAcquired() }
  }

  func clear() {
    assert(Thread.isMainThread)
    landmarks.removeAll(keepingCapacity: true)
    trailBuffer.clear()
    latestTimestampMs = nil
    readinessState = .noPerson
    jointCoverage = 0
    render()
  }

  private func ingest(landmarks incoming: [PoseLandmark], timestampMs: Int) {
    var next: [String: PoseLandmark] = [:]
    next.reserveCapacity(incoming.count)
    for landmark in incoming { next[landmark.name] = landmark }
    landmarks = next
    trailBuffer.ingest(landmarks: incoming, timestampMs: timestampMs)
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /// One transaction per pose frame: paths and glow geometry are rebuilt from
  /// the current landmarks and handed to Core Animation with implicit
  /// animations disabled (the pose IS the animation).
  private func render() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    renderBodyLockLocked()

    guard let previewLayer, let latestTimestampMs, !landmarks.isEmpty, bounds.width > 0 else {
      hideBody()
      return
    }
    let mapper = previewLayer.normalizedImageMapper()
    var points: [String: CGPoint] = [:]
    points.reserveCapacity(landmarks.count)
    for (name, landmark) in landmarks where landmark.visibility >= 0.35 {
      points[name] = mapper.layerPoint(CGPoint(x: landmark.x, y: landmark.y))
    }

    // Per-joint heat: the newest measured speed, normalized to the full-swing
    // ceiling and faded by sample age. A joint with no fresh measurement has
    // zero heat — it still shows the cool "observed" base, nothing hotter.
    let measuredSegments = trailBuffer.segments(at: latestTimestampMs)
    var newestSegmentByJoint: [String: PoseMotionTrailSegment] = [:]
    for segment in measuredSegments {
      if let current = newestSegmentByJoint[segment.joint], current.ageFraction <= segment.ageFraction {
        continue
      }
      newestSegmentByJoint[segment.joint] = segment
    }
    var heatByJoint: [String: CGFloat] = [:]
    for (joint, segment) in newestSegmentByJoint {
      let speed = CGFloat(min(1, max(0, segment.normalizedSpeedPerSecond / Self.fullIntensitySpeed)))
      let freshness = CGFloat(max(0, 1 - segment.ageFraction))
      heatByJoint[joint] = speed * (0.4 + 0.6 * freshness)
    }
    let heat: (String) -> CGFloat = { heatByJoint[$0] ?? 0 }

    // Glow radius follows the observed body scale (torso extent in layer
    // points) so the aura hugs the athlete whether near or far.
    let radiusUnit = glowRadiusUnit(points: points)
    let scale = max(0.6, min(1.6, radiusUnit / 15))

    // Global brightness: dimmer while positioning, full once locked, calm
    // while saving; partial joint coverage dims everything proportionally.
    let stateAlpha: CGFloat
    switch captureState {
    case .starting, .positioning: stateAlpha = 0.8
    case .locked, .capturing: stateAlpha = 1
    case .saving: stateAlpha = 0.62
    }
    let coverageAlpha = CGFloat(min(1, max(0.52, jointCoverage)))
    let skeletonAlpha = stateAlpha * coverageAlpha
    let heatAlpha = skeletonAlpha * Self.heatOpacity

    // ── Torso mass glow ──────────────────────────────────────────────────
    if let leftShoulder = points["left_shoulder"], let rightShoulder = points["right_shoulder"],
       let leftHip = points["left_hip"], let rightHip = points["right_hip"] {
      let torsoHeat = (heat("left_shoulder") + heat("right_shoulder") + heat("left_hip") + heat("right_hip")) / 4
      let centroid = midpoint(midpoint(leftShoulder, rightShoulder), midpoint(leftHip, rightHip))
      place(
        glow: torsoGlow,
        center: centroid,
        radius: radiusUnit * 2.1 * (1 + 0.35 * torsoHeat),
        heat: torsoHeat,
        alpha: (0.1 + 0.14 * torsoHeat) * heatAlpha
      )
    } else {
      torsoGlow.opacity = 0
    }

    // ── Joint glows (the heat map proper) ────────────────────────────────
    for joint in Self.canonicalJoints {
      guard let glow = jointGlows[joint] else { continue }
      guard let center = points[joint], let landmark = landmarks[joint] else {
        glow.opacity = 0
        continue
      }
      let jointHeat = heat(joint)
      let visibilityAlpha = CGFloat(0.5 + 0.5 * min(1, max(0, (landmark.visibility - 0.35) / 0.65)))
      place(
        glow: glow,
        center: center,
        radius: radiusUnit * (1.15 + 1.35 * jointHeat),
        heat: jointHeat,
        alpha: (0.16 + 0.24 * jointHeat) * visibilityAlpha * heatAlpha
      )
    }
    if let headGlow = jointGlows[Self.headJoint] {
      if let head = points[Self.headJoint] {
        place(glow: headGlow, center: head, radius: radiusUnit * 1.1, heat: 0, alpha: 0.12 * heatAlpha)
      } else {
        headGlow.opacity = 0
      }
    }

    // ── Bones + hot limbs ────────────────────────────────────────────────
    let bones = UIBezierPath()
    let limbPaths = limbHeatLayers.map { _ in UIBezierPath() }
    for (startName, endName) in Self.segments {
      guard let start = points[startName], let end = points[endName] else { continue }
      bones.move(to: start)
      bones.addLine(to: end)
      let boneHeat = (heat(startName) + heat(endName)) / 2
      for (index, bucket) in Self.limbHeatBuckets.enumerated().reversed() where boneHeat >= bucket.min {
        limbPaths[index].move(to: start)
        limbPaths[index].addLine(to: end)
        break
      }
    }
    // Neck: observed head down to the observed shoulder midpoint.
    if let head = points[Self.headJoint], let leftShoulder = points["left_shoulder"], let rightShoulder = points["right_shoulder"] {
      bones.move(to: head)
      bones.addLine(to: midpoint(leftShoulder, rightShoulder))
    }
    let boneWidth = Self.boneWidthAtUnit * scale
    boneContourLayer.path = bones.cgPath
    boneContourLayer.lineWidth = boneWidth + 2.2 * scale
    boneContourLayer.opacity = Float(skeletonAlpha)
    boneLayer.path = bones.cgPath
    boneLayer.lineWidth = boneWidth
    boneLayer.opacity = Float(0.92 * skeletonAlpha)
    for (index, limb) in limbHeatLayers.enumerated() {
      limb.path = limbPaths[index].cgPath
      limb.lineWidth = radiusUnit * 1.5
      limb.opacity = Float(0.2 * heatAlpha)
    }

    // ── Joint nuclei + hot rings ─────────────────────────────────────────
    let jointRadius = Self.jointRadiusAtUnit * scale
    let joints = UIBezierPath()
    let contours = UIBezierPath()
    let rings = UIBezierPath()
    for joint in Self.canonicalJoints {
      guard let center = points[joint] else { continue }
      let jointHeat = heat(joint)
      let radius = jointRadius * (1 + 0.35 * jointHeat)
      joints.append(UIBezierPath(ovalIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)))
      let contourRadius = radius + 1.1 * scale
      contours.append(UIBezierPath(ovalIn: CGRect(
        x: center.x - contourRadius, y: center.y - contourRadius, width: contourRadius * 2, height: contourRadius * 2
      )))
      if jointHeat > 0.45 {
        let ringRadius = radius + 3.2 * scale * jointHeat
        rings.append(UIBezierPath(ovalIn: CGRect(
          x: center.x - ringRadius, y: center.y - ringRadius, width: ringRadius * 2, height: ringRadius * 2
        )))
      }
    }
    jointContourLayer.path = contours.cgPath
    jointContourLayer.opacity = Float(skeletonAlpha)
    jointLayer.path = joints.cgPath
    jointLayer.opacity = Float(0.96 * skeletonAlpha)
    hotJointRingLayer.path = rings.cgPath
    hotJointRingLayer.lineWidth = 1.2 * scale
    hotJointRingLayer.opacity = Float(0.55 * skeletonAlpha)

    // ── Motion trails: measured displacement streaks ─────────────────────
    // Width and color are a single value per layer (the volt mid-ramp); only
    // segments above the measurement floor are drawn, newest ones included.
    let trail = UIBezierPath()
    var trailCount = 0
    for segment in measuredSegments where segment.normalizedSpeedPerSecond >= Self.minimumTrailSpeed {
      trail.move(to: mapper.layerPoint(CGPoint(x: segment.startX, y: segment.startY)))
      trail.addLine(to: mapper.layerPoint(CGPoint(x: segment.endX, y: segment.endY)))
      trailCount += 1
    }
    trailLayer.path = trailCount > 0 ? trail.cgPath : nil
    trailLayer.lineWidth = 2.4 * scale
    trailLayer.opacity = Float(0.42 * heatAlpha)
  }

  private func hideBody() {
    torsoGlow.opacity = 0
    for glow in jointGlows.values { glow.opacity = 0 }
    for shape in [trailLayer, boneContourLayer, boneLayer, jointContourLayer, jointLayer, hotJointRingLayer] + limbHeatLayers {
      shape.path = nil
    }
  }

  /// Positions one radial glow: a square gradient layer centered on the
  /// landmark whose colors follow the heat ramp. Gradient stops are set every
  /// frame (cheap — no rasterization happens here; the GPU shades it).
  private func place(glow: CAGradientLayer, center: CGPoint, radius: CGFloat, heat: CGFloat, alpha: CGFloat) {
    guard alpha > 0.015, radius > 1 else {
      glow.opacity = 0
      return
    }
    let color = heatColor(heat)
    glow.bounds = CGRect(x: 0, y: 0, width: radius * 2, height: radius * 2)
    glow.position = center
    glow.colors = [
      color.cgColor,
      color.withAlphaComponent(0.42).cgColor,
      color.withAlphaComponent(0).cgColor,
    ]
    glow.locations = [0, 0.55, 1]
    glow.opacity = Float(min(1, alpha))
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
  private func glowRadiusUnit(points: [String: CGPoint]) -> CGFloat {
    guard let leftShoulder = points["left_shoulder"], let rightShoulder = points["right_shoulder"],
          let leftHip = points["left_hip"], let rightHip = points["right_hip"]
    else { return 15 }
    let shoulderMid = midpoint(leftShoulder, rightShoulder)
    let hipMid = midpoint(leftHip, rightHip)
    let torsoLength = hypot(hipMid.x - shoulderMid.x, hipMid.y - shoulderMid.y)
    return min(30, max(9, torsoLength * 0.17))
  }

  private func midpoint(_ a: CGPoint, _ b: CGPoint) -> CGPoint {
    CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
  }

  // ── Body lock / framing guide ─────────────────────────────────────────────

  private func renderBodyLock() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    renderBodyLockLocked()
    CATransaction.commit()
  }

  /// Brackets: the static framing guide while positioning, the body-bound lock
  /// once the evaluator armed. Called inside an open transaction.
  private func renderBodyLockLocked() {
    guard let previewLayer else { return }
    let path: UIBezierPath?
    if captureState.showsBodyLock {
      let mapper = previewLayer.normalizedImageMapper()
      let visiblePoints = landmarks.values.compactMap { landmark -> CGPoint? in
        guard landmark.visibility >= 0.35 else { return nil }
        return mapper.layerPoint(CGPoint(x: landmark.x, y: landmark.y))
      }
      path = bodyLockPath(around: visiblePoints)
    } else {
      path = fixedFramingGuidePath()
    }
    bodyLockLayer.path = path?.cgPath

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
    bodyLockLayer.opacity = path == nil ? 0 : 1
  }

  private func fixedFramingGuidePath() -> UIBezierPath? {
    guard bounds.width > 0, bounds.height > 0 else { return nil }
    // A static, deliberately spacious target helps the athlete place their
    // complete body before any pose exists. It is a framing affordance, not a
    // scanner, and never animates. The controller supplies the rect (the
    // guide band it also lays the silhouette in), so brackets and outline
    // read as one guide and neither can sit under the chrome.
    if let guideRect, guideRect.width > 40, guideRect.height > 80 {
      return cornerPath(in: guideRect)
    }
    let fallback = CGRect(
      x: bounds.width * 0.1,
      y: bounds.height * 0.24,
      width: bounds.width * 0.8,
      height: bounds.height * 0.56
    )
    return cornerPath(in: fallback)
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
