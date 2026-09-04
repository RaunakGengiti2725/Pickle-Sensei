// Linux stand-in for the single CoreVideo type the contracts mention.
// `PoseProviding.extractPose(from: CVPixelBuffer, ...)` is never called on
// Linux (ApplePoseProvider needs Vision and is excluded from the proxy).
#if !canImport(CoreVideo)
public final class CVPixelBuffer {}
#endif
