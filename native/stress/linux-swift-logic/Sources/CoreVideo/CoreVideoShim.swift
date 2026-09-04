// Linux-only stand-in so the Foundation-only PickleVisionCore stages
// (VisionCoreContracts mentions CVPixelBuffer in the PoseProviding /
// PaddleDetecting protocol signatures) compile without the Apple SDK. Nothing
// here is ever dereferenced: ApplePoseProvider is not part of this package.
public typealias CVPixelBuffer = AnyObject
