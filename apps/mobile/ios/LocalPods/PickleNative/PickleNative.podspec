Pod::Spec.new do |s|
  s.name         = "PickleNative"
  s.version      = "0.1.0"
  s.summary      = "Pickle Sensei native modules: AudioCoach TTS (AVSpeechSynthesizer)."
  s.homepage     = "https://github.com/pickle-sensei/pickle-sensei"
  s.license      = { :type => "Proprietary", :text => "Internal" }
  s.author       = { "Pickle Sensei" => "dev@picklesensei.local" }
  s.platforms    = { :ios => "15.1" }
  s.source       = { :path => "." }
  s.source_files = "Sources/**/*.{swift,h,m}"
  s.swift_version = "5.9"
  s.dependency "React-Core"
end
