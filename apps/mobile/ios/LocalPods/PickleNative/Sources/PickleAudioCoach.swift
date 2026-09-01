import AVFoundation
import Foundation
import React

/// AudioCoach native module (spec p. 37): deterministic cue text arrives from
/// the JS cue engine; this module only speaks it via AVSpeechSynthesizer.
/// Real-time loop rule: no network, no LLM, no dynamic content generation here.
///
/// Audio-session policy (on-court coaching):
///  - `.playback` + `.spokenAudio` + `.duckOthers`: cues play through the
///    speaker even with the silent switch on — they are the product's core
///    output on court — and duck (never stop) any music playing.
///  - The session is activated lazily per cue and released with
///    `.notifyOthersOnDeactivation` once the coach goes quiet, so other
///    apps' audio resumes instead of staying ducked forever. Nothing is
///    claimed at app launch.
///  - The camera capture session is video-only (no microphone input), so
///    speech playback and live session capture never contend for a device.
@objc(PickleAudioCoach)
class PickleAudioCoach: NSObject, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  /// Serializes AVAudioSession activation/deactivation off the main thread.
  private let sessionQueue = DispatchQueue(label: "pickle.audio.coach.session")

  override init() {
    super.init()
    synthesizer.delegate = self
  }

  @objc static func requiresMainQueueSetup() -> Bool { false }

  /// Prefer an enhanced-quality US English voice when the device has one
  /// installed; fall back to the default en-US voice, then system default.
  private static let coachVoice: AVSpeechSynthesisVoice? = {
    let enhanced = AVSpeechSynthesisVoice.speechVoices().first { voice in
      voice.language == "en-US" && voice.quality != .default
    }
    return enhanced ?? AVSpeechSynthesisVoice(language: "en-US")
  }()

  @objc func speak(_ text: String, rate: Double) {
    // Legacy single-voice path — kept for callers that predate voice
    // selection. Interrupts immediately (latest rep wins).
    speakResolved(
      text: text,
      voice: Self.coachVoice,
      rate: rate,
      pitch: 1.0,
      volume: 1.0,
      interruption: "immediate"
    )
  }

  /// Coach voice catalog: every installed English AVSpeechSynthesisVoice
  /// with its REAL identifier, quality tier, and (when iOS reports one)
  /// gender. JS ranks these Premium → Enhanced → Default and maps them onto
  /// the curated coach presets — nothing here invents a voice that is not
  /// on the device, so everything works fully offline.
  @objc func listVoices(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let voices = AVSpeechSynthesisVoice.speechVoices()
      .filter { $0.language.hasPrefix("en") }
      .map { voice -> [String: Any] in
        [
          "identifier": voice.identifier,
          "name": voice.name,
          "language": voice.language,
          "quality": Self.qualityLabel(voice.quality),
          "gender": Self.genderLabel(voice.gender),
        ]
      }
    resolve(voices)
  }

  /// Full-control speech path for the selected coach voice.
  /// `options`: voiceId (AVSpeechSynthesisVoice identifier), rate (AVSpeech
  /// 0–1 scale), pitch (0.5–2.0), volume (0–1), interruption:
  ///   - "immediate" — urgent cue ("Paddle up"): cut anything mid-syllable;
  ///   - "word"      — per-swing cue: replace older speech at a word
  ///                   boundary so nothing chops mid-word;
  ///   - "enqueue"   — calm post-rally lines: queue behind current speech.
  /// A missing/uninstalled voiceId falls back to the enhanced-or-default
  /// en-US coach voice, then the system default — speech never fails silent
  /// because a preferred voice disappeared.
  @objc func speakCue(_ text: String, options: NSDictionary) {
    let voiceId = options["voiceId"] as? String
    let voice = voiceId.flatMap { AVSpeechSynthesisVoice(identifier: $0) }
      ?? Self.coachVoice
    speakResolved(
      text: text,
      voice: voice,
      rate: (options["rate"] as? NSNumber)?.doubleValue ?? 0.5,
      pitch: (options["pitch"] as? NSNumber)?.doubleValue ?? 1.0,
      volume: (options["volume"] as? NSNumber)?.doubleValue ?? 1.0,
      interruption: options["interruption"] as? String ?? "word"
    )
  }

  private func speakResolved(
    text: String,
    voice: AVSpeechSynthesisVoice?,
    rate: Double,
    pitch: Double,
    volume: Double,
    interruption: String
  ) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    sessionQueue.async {
      let session = AVAudioSession.sharedInstance()
      try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
      try? session.setActive(true)
      DispatchQueue.main.async {
        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.rate = Float(
          max(Double(AVSpeechUtteranceMinimumSpeechRate),
              min(rate, Double(AVSpeechUtteranceMaximumSpeechRate))))
        utterance.pitchMultiplier = Float(max(0.5, min(pitch, 2.0)))
        utterance.volume = Float(max(0.0, min(volume, 1.0)))
        utterance.prefersAssistiveTechnologySettings = false
        if let voice {
          utterance.voice = voice
        }
        switch interruption {
        case "enqueue":
          break // AVSpeechSynthesizer queues utterances natively.
        case "word":
          self.synthesizer.stopSpeaking(at: .word)
        default:
          self.synthesizer.stopSpeaking(at: .immediate)
        }
        self.synthesizer.speak(utterance)
      }
    }
  }

  private static func qualityLabel(
    _ quality: AVSpeechSynthesisVoiceQuality
  ) -> String {
    if #available(iOS 16.0, *), quality == .premium { return "premium" }
    return quality == .enhanced ? "enhanced" : "default"
  }

  private static func genderLabel(
    _ gender: AVSpeechSynthesisVoiceGender
  ) -> String {
    switch gender {
    case .male: return "male"
    case .female: return "female"
    default: return "unspecified"
    }
  }

  @objc func stop() {
    DispatchQueue.main.async {
      // A deliberate stop (mute toggle, screen exit) finishes the current
      // word instead of chopping mid-syllable.
      self.synthesizer.stopSpeaking(at: .word)
    }
  }

  // MARK: - AVSpeechSynthesizerDelegate

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance
  ) {
    releaseSessionWhenIdle()
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance
  ) {
    releaseSessionWhenIdle()
  }

  /// Deactivate the shared audio session only when no cue is speaking or
  /// queued (a replaced cue fires didCancel while its successor is already
  /// enqueued — the session must stay active for it).
  private func releaseSessionWhenIdle() {
    DispatchQueue.main.async {
      guard !self.synthesizer.isSpeaking else { return }
      self.sessionQueue.async {
        try? AVAudioSession.sharedInstance().setActive(
          false, options: .notifyOthersOnDeactivation)
      }
    }
  }
}
