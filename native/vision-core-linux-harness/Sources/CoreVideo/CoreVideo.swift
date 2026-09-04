/// Linux stand-in for CoreVideo's `CVPixelBuffer`. The vision-core contracts
/// only name the type in protocol signatures; no pixel data is ever touched by
/// the Foundation-only logic this harness exercises.
public final class CVPixelBuffer {
  public init() {}
}
