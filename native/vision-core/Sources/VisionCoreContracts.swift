import Foundation
import CoreVideo

/// VisionCore contracts (directive §13/§61) — the native mirror of
/// packages/vision-contracts. React Native orchestrates; native owns camera
/// buffers, preprocessing, model execution, temporal detection, and the live
/// inference loop. Coordinate space: normalized-image (x,y ∈ [0,1], origin
/// top-left, rotation already applied) unless stated otherwise.

public struct PoseLandmark: Sendable {
  public let name: String
  public let x: Double
  public let y: Double
  public let visibility: Double

  public init(name: String, x: Double, y: Double, visibility: Double) {
    self.name = name
    self.x = x
    self.y = y
    self.visibility = visibility
  }
}

public struct PoseFrame: Sendable {
  public let timestampMs: Int
  public let landmarks: [PoseLandmark]
  public let confidence: Double

  public init(timestampMs: Int, landmarks: [PoseLandmark], confidence: Double) {
    self.timestampMs = timestampMs
    self.landmarks = landmarks
    self.confidence = confidence
  }
}

public struct PaddleFrame: Sendable {
  public let timestampMs: Int
  public let bbox: CGRect?
  public let handleEnd: CGPoint?
  public let throat: CGPoint?
  public let center: CGPoint?
  public let tip: CGPoint?
  public let confidence: Double

  public init(timestampMs: Int, bbox: CGRect?, handleEnd: CGPoint?, throat: CGPoint?, center: CGPoint?, tip: CGPoint?, confidence: Double) {
    self.timestampMs = timestampMs
    self.bbox = bbox
    self.handleEnd = handleEnd
    self.throat = throat
    self.center = center
    self.tip = tip
    self.confidence = confidence
  }
}

public struct StrokeEvent: Sendable {
  public let startMs: Int
  public let endMs: Int
  /// Timestamp of the detector's peak camera-relative wrist/paddle motion.
  /// This is not evidence of ball contact.
  public let peakMotionMs: Int?
  public let confidence: Double
  /// Motion detection and shot recognition are intentionally separate. A
  /// temporal trigger is useful for automatic capture, but it is not evidence
  /// for a named pickleball stroke without a validated classifier.
  public let recognition: StrokeRecognition

  public init(
    startMs: Int,
    endMs: Int,
    peakMotionMs: Int?,
    confidence: Double,
    recognition: StrokeRecognition = .unknown(reason: "validated_classifier_unavailable")
  ) {
    self.startMs = startMs
    self.endMs = endMs
    self.peakMotionMs = peakMotionMs
    self.confidence = confidence
    self.recognition = recognition
  }
}

public enum StrokeRecognitionStatus: String, Sendable {
  case recognized
  case unknown
  case abstained
}

public struct StrokeRecognition: Sendable {
  public let status: StrokeRecognitionStatus
  public let shotType: String?
  public let confidence: Double?
  public let reason: String?
  public let modelVersion: String?

  public init(
    status: StrokeRecognitionStatus,
    shotType: String? = nil,
    confidence: Double? = nil,
    reason: String? = nil,
    modelVersion: String? = nil
  ) {
    self.status = status
    self.shotType = shotType
    self.confidence = confidence
    self.reason = reason
    self.modelVersion = modelVersion
  }

  public static func unknown(reason: String) -> StrokeRecognition {
    StrokeRecognition(status: .unknown, reason: reason)
  }

  public static func abstained(reason: String) -> StrokeRecognition {
    StrokeRecognition(status: .abstained, reason: reason)
  }
}

public enum VisionFailure: Error, Sendable {
  case notConfigured(String)
  case unsupportedDevice(String)
  case lowConfidence(String)
  case corruptedMedia(String)
  case cancelled
}

public protocol PoseProviding: Sendable {
  var modelVersion: String { get }
  func extractPose(pixelBuffer: CVPixelBuffer, timestampMs: Int) throws -> PoseFrame
}

public protocol PaddleDetecting: Sendable {
  var modelVersion: String { get }
  func detectPaddle(pixelBuffer: CVPixelBuffer, timestampMs: Int) throws -> PaddleFrame
}

public protocol StrokeDetecting: AnyObject {
  var modelVersion: String { get }
  /// Feed per-frame features; returns a stroke event when one completes.
  func ingest(pose: PoseFrame, paddle: PaddleFrame?) -> StrokeEvent?
  func reset()
}
