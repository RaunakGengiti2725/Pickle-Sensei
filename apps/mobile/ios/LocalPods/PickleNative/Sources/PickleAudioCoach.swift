import AVFoundation
import Foundation

/// AudioCoach native module (spec p. 37): deterministic cue text arrives from
/// the JS cue engine; this module only speaks it via AVSpeechSynthesizer.
/// Real-time loop rule: no network, no LLM, no dynamic content generation here.
@objc(PickleAudioCoach)
class PickleAudioCoach: NSObject {
  private let synthesizer = AVSpeechSynthesizer()

  override init() {
    super.init()
    // Play through the speaker even in silent-switch positions: coaching cues
    // are the product's core output on court.
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
    try? AVAudioSession.sharedInstance().setActive(true)
  }

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func speak(_ text: String, rate: Double) {
    let utterance = AVSpeechUtterance(string: text)
    utterance.rate = Float(max(0.1, min(rate, 0.7)))
    utterance.prefersAssistiveTechnologySettings = false
    // Cancel any queued cue: latest rep wins, stale cues never stack up.
    synthesizer.stopSpeaking(at: .immediate)
    synthesizer.speak(utterance)
  }

  @objc func stop() {
    synthesizer.stopSpeaking(at: .immediate)
  }
}
