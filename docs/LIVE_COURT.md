# LIVE COURT

The product's centerpiece (directive §4, spec pp. 9, 35–37). Near-screenless: player hits, app scores, coach speaks.

## Loop

```
CameraEngine 720p60 → rolling ~2.0s YUV ring buffer (native/camera-engine)
→ pose sampling 15–30fps (ApplePoseProvider baseline, native/vision-core)
→ TemporalStrokeDetector: velocity state machine, min-confidence trigger,
  refractory period (no paddle-twirl false strokes)
→ stroke window frozen (~2s pre + ~1.5s post)
→ phases → features → scoring engine (same math as single-shot; native mirror
  must pass the shared golden vectors)
→ CueEngine (@pickle/audio-coach-core): CORRECTION / IMPROVEMENT /
  PERSONAL_BEST / REPEAT / STABLE / SILENCE with cooldowns
→ PickleAudioCoach (AVSpeechSynthesizer; .playback + .duckOthers so cues play
  through the silent switch; latest cue preempts stale ones)
→ local persistence (SQLite) → outbox sync
```

Zero network dependency for the core loop. Cues also render on-screen (never audio-only, §56).

## Implementation state (honest)

| Piece                                                    | State                                                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| LiveCourtEngine (rep → analyze → cue → summary), pure TS | TESTED (jest, real scoring + real cue engine)                                                                           |
| Cue engine + cooldown/silence rules                      | TESTED (unit, incl. spec dialogue)                                                                                      |
| Native TTS module (PickleAudioCoach pod)                 | Built into the app (iOS build succeeded); speaks in dev sessions                                                        |
| Session persistence + summary + outbox                   | TESTED (jest logic suites; server finalize integration-tested)                                                          |
| CameraEngine rolling buffer (Swift)                      | IMPLEMENTED, parse-verified; not yet wired into the RN app                                                              |
| ApplePoseProvider (real Vision body-pose)                | IMPLEMENTED, parse-verified; wiring + accuracy validation pending                                                       |
| TemporalStrokeDetector heuristic v0                      | IMPLEMENTED, parse-verified; learned model replaces it behind the same protocol                                         |
| Dev mode                                                 | Reps driven by the labeled FixtureVisionProvider on a 6s cadence — banner on screen, `source:"fixture"` in every record |
| Thermal capability tiers A/B/C                           | NOT_STARTED (device-tier column + config shipped; runtime adaptation with native wiring)                                |

## Performance targets (gates, not aspirations — spec p. 36)

stroke recall >95% (supported setup) · false strokes <1/10min · first score p50 <1.5s / p95 <2.5s · cue <3s · 30-min session without thermal failure · crash-free >99.5%. Measured once the native loop is wired; no invented benchmark numbers before then.
