Pod::Spec.new do |s|
  s.name         = "PickleNative"
  s.version      = "0.1.0"
  s.summary      = "Pickle Sensei native modules: auth, camera capture, and audio coaching."
  s.homepage     = "https://github.com/pickle-sensei/pickle-sensei"
  s.license      = { :type => "Proprietary", :text => "Internal" }
  s.author       = { "Pickle Sensei" => "dev@picklesensei.local" }
  s.platforms    = { :ios => "15.1" }
  s.source       = { :path => "." }
  # Sources/Core contains repository-relative symlinks to the canonical native
  # camera and vision implementations. CocoaPods requires source globs to stay
  # below the local pod root, while the symlinks keep a single implementation.
  s.source_files = [
    "Sources/*.{swift,h,m}",
    "Sources/Core/CameraEngine.swift",
    "Sources/Core/SessionCaptureCoordinator.swift",
    "Sources/Core/SessionMotionStream.swift",
    "Sources/Core/ApplePoseProvider.swift",
    "Sources/Core/CaptureEvidenceAccumulator.swift",
    "Sources/Core/PoseMotionTrail.swift",
    "Sources/Core/PoseReadinessEvaluator.swift",
    "Sources/Core/TemporalStrokeDetector.swift",
    "Sources/Core/VisionCoreContracts.swift"
  ]
  s.swift_version = "5.9"
  s.dependency "React-Core"
end
