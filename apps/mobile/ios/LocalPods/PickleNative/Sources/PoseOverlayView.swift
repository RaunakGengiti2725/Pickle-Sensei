import AVFoundation
import UIKit

/// Draws only evidence produced by current Apple Vision observations. The
/// observed skeleton, body-bound lock, and short motion trails disappear when
/// inference loses the athlete; only the static full-body framing guide stays.
/// No decorative scanner or synthetic body data is drawn.
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

  private let skeletonBackdropLayer = CAShapeLayer()
  private let skeletonLayer = CAShapeLayer()
  private let jointLayer = CAShapeLayer()
  private let bodyLockLayer = CAShapeLayer()
  weak var previewLayer: AVCaptureVideoPreviewLayer?

  private var landmarks: [String: PoseLandmark] = [:]
  private var trailBuffer = PoseMotionTrailBuffer()
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
  private static let minimumTrailSpeed = 0.06
  private static let minimumHaloSpeed = 0.12
  private static let fullIntensitySpeed = 1.25

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    backgroundColor = .clear
    isOpaque = false
    contentMode = .redraw

    skeletonBackdropLayer.fillColor = UIColor.clear.cgColor
    skeletonBackdropLayer.strokeColor = UIColor.black.withAlphaComponent(0.58).cgColor
    skeletonBackdropLayer.lineWidth = 6
    skeletonBackdropLayer.lineCap = .round
    skeletonBackdropLayer.lineJoin = .round
    layer.addSublayer(skeletonBackdropLayer)

    skeletonLayer.fillColor = UIColor.clear.cgColor
    skeletonLayer.strokeColor = Palette.mint.cgColor
    skeletonLayer.lineWidth = 2.75
    skeletonLayer.lineCap = .round
    skeletonLayer.lineJoin = .round
    layer.addSublayer(skeletonLayer)

    jointLayer.fillColor = Palette.volt.cgColor
    layer.addSublayer(jointLayer)

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
    skeletonBackdropLayer.frame = bounds
    skeletonLayer.frame = bounds
    jointLayer.frame = bounds
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
    skeletonBackdropLayer.path = nil
    skeletonLayer.path = nil
    jointLayer.path = nil
    bodyLockLayer.path = nil
    CATransaction.commit()
    setNeedsDisplay()
    redraw()
  }

  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext(),
          let previewLayer,
          let latestTimestampMs
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

    // One short-lived halo per tracked joint makes measured movement intensity
    // legible without leaving a persistent or looping "heat" effect.
    for segment in newestSegmentByJoint.values {
      guard segment.normalizedSpeedPerSecond >= Self.minimumHaloSpeed else { continue }
      let speed = CGFloat(
        min(1, max(0, segment.normalizedSpeedPerSecond / Self.fullIntensitySpeed))
      )
      let freshness = CGFloat(max(0, 1 - segment.ageFraction))
      let point = previewLayer.layerPointConverted(
        fromCaptureDevicePoint: CGPoint(x: segment.endX, y: segment.endY)
      )
      let color = trailColor(speed: speed)
      guard let gradient = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: [
          color.withAlphaComponent((0.14 + 0.24 * speed) * freshness).cgColor,
          color.withAlphaComponent(0).cgColor,
        ] as CFArray,
        locations: [0, 1]
      ) else { continue }
      let radius = 12 + 22 * speed
      context.drawRadialGradient(
        gradient,
        startCenter: point,
        startRadius: 0,
        endCenter: point,
        endRadius: radius,
        options: .drawsAfterEndLocation
      )
    }

    // At most 8 joints × 7 segments are drawn. Width, color, and opacity come
    // from observed displacement and timestamp age, not a looping effect.
    for segment in measuredSegments {
      guard segment.normalizedSpeedPerSecond >= Self.minimumTrailSpeed else { continue }
      let speed = CGFloat(
        min(1, max(0, segment.normalizedSpeedPerSecond / Self.fullIntensitySpeed))
      )
      let freshness = CGFloat(max(0, 1 - segment.ageFraction))
      let alpha = (0.12 + 0.52 * freshness) * (0.45 + 0.55 * speed)
      context.setStrokeColor(trailColor(speed: speed).withAlphaComponent(alpha).cgColor)
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

  private func redraw() {
    guard let previewLayer else { return }
    let skeletonPath = UIBezierPath()
    for (startName, endName) in Self.segments {
      guard let start = visiblePoint(startName), let end = visiblePoint(endName) else { continue }
      skeletonPath.move(to: previewLayer.layerPointConverted(fromCaptureDevicePoint: start))
      skeletonPath.addLine(to: previewLayer.layerPointConverted(fromCaptureDevicePoint: end))
    }

    let visibleLayerPoints = landmarks.values.compactMap { landmark -> CGPoint? in
      guard landmark.visibility >= 0.35 else { return nil }
      return previewLayer.layerPointConverted(
        fromCaptureDevicePoint: CGPoint(x: landmark.x, y: landmark.y)
      )
    }
    let jointsPath = UIBezierPath()
    for point in visibleLayerPoints {
      jointsPath.append(
        UIBezierPath(ovalIn: CGRect(x: point.x - 3.5, y: point.y - 3.5, width: 7, height: 7))
      )
    }

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    skeletonBackdropLayer.path = skeletonPath.cgPath
    skeletonLayer.path = skeletonPath.cgPath
    jointLayer.path = jointsPath.cgPath
    bodyLockLayer.path = captureState.showsBodyLock
      ? bodyLockPath(around: visibleLayerPoints)?.cgPath
      : fixedFramingGuidePath()?.cgPath

    let coverageAlpha = CGFloat(min(1, max(0.52, jointCoverage)))
    switch captureState {
    case .starting, .positioning:
      skeletonLayer.strokeColor = Palette.mint.withAlphaComponent(coverageAlpha).cgColor
      jointLayer.fillColor = Palette.volt.withAlphaComponent(coverageAlpha).cgColor
      let guideAlpha: CGFloat
      switch readinessState {
      case .ready: guideAlpha = 0.94
      case .noPerson: guideAlpha = 0.58
      case .fullBodyRequired, .moveCloser, .moveFarther, .holdStill: guideAlpha = 0.72
      }
      bodyLockLayer.strokeColor = Palette.mint.withAlphaComponent(guideAlpha).cgColor
    case .locked, .capturing:
      skeletonLayer.strokeColor = Palette.volt.cgColor
      jointLayer.fillColor = Palette.volt.cgColor
      bodyLockLayer.strokeColor = Palette.volt.cgColor
    case .saving:
      skeletonLayer.strokeColor = Palette.onDark.cgColor
      jointLayer.fillColor = Palette.volt.cgColor
      bodyLockLayer.strokeColor = Palette.onDark.cgColor
    }
    // Readiness remains separately tracked even after lock so a future visual
    // treatment cannot silently reinterpret geometry as evaluator evidence.
    bodyLockLayer.opacity = bodyLockLayer.path == nil ? 0 : 1
    CATransaction.commit()
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

  private func visiblePoint(_ name: String) -> CGPoint? {
    guard let landmark = landmarks[name], landmark.visibility >= 0.35 else { return nil }
    return CGPoint(x: landmark.x, y: landmark.y)
  }

  private func trailColor(speed: CGFloat) -> UIColor {
    let red = (83 + (215 - 83) * speed) / 255
    let green = (217 + (250 - 217) * speed) / 255
    let blue = (155 + (69 - 155) * speed) / 255
    return UIColor(red: red, green: green, blue: blue, alpha: 1)
  }
}
