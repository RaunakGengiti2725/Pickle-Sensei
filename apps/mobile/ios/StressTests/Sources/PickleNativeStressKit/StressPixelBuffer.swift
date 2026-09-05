import Foundation
@testable import PickleNativeStressCore
#if canImport(CoreVideo)
import CoreVideo
#endif

/// Pixel buffers for the stress campaigns. On Apple platforms these are real
/// `CVPixelBuffer`s (the Vision tests fill them); on Linux the contracts shim
/// makes `CVPixelBuffer` an opaque class and only `blank()` is meaningful.
public enum StressPixelBuffer {
  #if canImport(CoreVideo)
  /// 420f biplanar buffer (the format both capture paths feed Vision), or nil
  /// when CoreVideo refuses the geometry (e.g. 0×0).
  public static func make(width: Int, height: Int, fill: (UnsafeMutableRawPointer, Int, Int) -> Void = { _, _, _ in }) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault,
      width,
      height,
      kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
      [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary,
      &buffer
    )
    guard status == kCVReturnSuccess, let buffer else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    for plane in 0 ..< CVPixelBufferGetPlaneCount(buffer) {
      if let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane) {
        fill(base, CVPixelBufferGetBytesPerRowOfPlane(buffer, plane) * CVPixelBufferGetHeightOfPlane(buffer, plane), plane)
      }
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    return buffer
  }

  public static func blank() -> CVPixelBuffer {
    guard let buffer = make(width: 2, height: 2) else { preconditionFailure("CoreVideo refused a 2×2 420f buffer") }
    return buffer
  }

  /// Deterministic noise (seeded) — a "corrupt" decode.
  public static func noise(width: Int, height: Int, seed: UInt64) -> CVPixelBuffer? {
    var rng = StressRNG(seed: seed)
    return make(width: width, height: height) { base, byteCount, _ in
      let bytes = base.assumingMemoryBound(to: UInt8.self)
      for index in 0 ..< byteCount { bytes[index] = UInt8(truncatingIfNeeded: rng.next()) }
    }
  }
  #else
  public static func blank() -> CVPixelBuffer { CVPixelBuffer() }
  #endif
}
