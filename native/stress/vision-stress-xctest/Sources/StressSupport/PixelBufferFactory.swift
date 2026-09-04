import CoreVideo
import Foundation

/// Builds CVPixelBuffers of arbitrary size/format with deterministic contents.
public enum PixelBufferFactory {
  public enum Fill {
    case constant(UInt8)
    case noise(seed: UInt64)
    /// Vertical gradient (a plausible, non-degenerate image).
    case gradient
  }

  public static func make(
    width: Int,
    height: Int,
    format: OSType = kCVPixelFormatType_32BGRA,
    fill: Fill
  ) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    let attributes: [CFString: Any] = [
      kCVPixelBufferIOSurfacePropertiesKey: [:] as [String: Any],
    ]
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault,
      width,
      height,
      format,
      attributes as CFDictionary,
      &buffer
    )
    guard status == kCVReturnSuccess, let buffer else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }

    let planeCount = max(1, CVPixelBufferGetPlaneCount(buffer))
    var rng = SeededRNG(seed: 0)
    if case .noise(let seed) = fill { rng = SeededRNG(seed: seed) }
    for plane in 0..<planeCount {
      let isPlanar = CVPixelBufferIsPlanar(buffer)
      guard let base = isPlanar
        ? CVPixelBufferGetBaseAddressOfPlane(buffer, plane)
        : CVPixelBufferGetBaseAddress(buffer)
      else { continue }
      let rows = isPlanar
        ? CVPixelBufferGetHeightOfPlane(buffer, plane)
        : CVPixelBufferGetHeight(buffer)
      let bytesPerRow = isPlanar
        ? CVPixelBufferGetBytesPerRowOfPlane(buffer, plane)
        : CVPixelBufferGetBytesPerRow(buffer)
      let total = rows * bytesPerRow
      let pointer = base.assumingMemoryBound(to: UInt8.self)
      switch fill {
      case .constant(let value):
        memset(pointer, Int32(value), total)
      case .noise:
        var index = 0
        while index + 8 <= total {
          var word = rng.next()
          memcpy(pointer + index, &word, 8)
          index += 8
        }
        while index < total {
          pointer[index] = UInt8(truncatingIfNeeded: rng.next())
          index += 1
        }
      case .gradient:
        for row in 0..<rows {
          let value = rows > 1 ? UInt8(truncatingIfNeeded: row * 255 / (rows - 1)) : 128
          memset(pointer + row * bytesPerRow, Int32(value), bytesPerRow)
        }
      }
    }
    return buffer
  }
}
