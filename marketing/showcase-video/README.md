# Pickle Sensei — app showcase reel

A 27 s, 1080×1920, 30 fps vertical showcase (Reels / TikTok / App Store preview). Everything
is rendered from `timeline.html`, one deterministic motion timeline: `window.__setTime(t)`
positions every element for time `t`, and `render.js` drives headless Chromium through it
frame by frame, piping PNGs into ffmpeg.

## Story (seconds)

| Time    | Beat                                                                   | Voice line                            |
| ------- | ---------------------------------------------------------------------- | ------------------------------------- |
| 0–2.6   | App icon and wordmark                                                  | "This is Pickle Sensei."              |
| 2.6–4.5 | Real Welcome screen, tap "Start your first read"                       | "One tap to start."                   |
| 4.5–5.9 | Real Home, tap the Coach button                                        | "Tap Coach."                          |
| 5.9–7.5 | Real Coach menu, tap Import Video                                      | "Import your swing."                  |
| 7.5–11  | The owner's swing clip with a scan line sweeping top to bottom         | "It reads every frame."               |
| 11–13.9 | Score page (1 of 4): estimated DUPR ring, note, insight, THIS SET      | "Then your estimated DUPR."           |
| 13.9–17 | The problem (2 of 4): replay card frozen at contact, PRIORITY FIX card | "The one thing to fix first."         |
| 17–19.5 | Drills (3 of 4): three matched drills, one saved                       | "Then drills that fix it."            |
| 19.5–26 | App icon, wordmark, "Try it free today" App Store bar                  | "Every swing, seen." / "Try it free…" |

## What is real and what is illustrative

- `sim/welcome.png`, `sim/home.png`, `sim/coach.png` are real screenshots of the app on the
  iPhone 16 Pro simulator (guest mode, onboarding completed as "Raunak").
- `clips/swing.mp4` is the owner's own clip, downscaled to 1080p. The scan line is a
  motion-graphics effect: the clip was not run through the analysis pipeline.
- The Score and The problem pages are laid out from the app's own guide-shell contract in `AGENTS.md`
  (dark shell, segmented progress, `ESTIMATED DUPR · <STROKE>` kicker, `ScoreRing` 220 with
  the ESTIMATED eyebrow and DUPR unit inside the arc, `DUPR_ESTIMATE_NOTE`, one insight
  sentence, THIS SET card, pinned footer) using the app's tokens and copy. The drill cards reproduce `DrillLibraryScreen`'s card (title, meta line, description, coach, "Form guide & videos", bookmark) at 1.8× the app's points. Their numbers, fault, and drills
  are illustrative: the shipping app abstains until a validated model is
  released, and ratings require a connected account.

## Provenance

- Voiceover: ten lines generated with ElevenLabs (voice "Ainsley") through the Higgsfield
  MCP, committed as `vo/vo1.mp3` … `vo/vo10.mp3`. Every other sound is synthesized in
  `audio.py`. There is no licensed music track; add one when posting.
- Fonts (Manrope, OFL) and the app icon are copied from the app by `prepare.sh`.

## Render

Requirements: Node ≥ 20, ffmpeg, python3 with numpy + scipy, and Playwright's Chromium.

```bash
cd marketing/showcase-video
npm i --no-save playwright-core && npx playwright install chromium
./prepare.sh                      # fonts, icon, clip frames, voice wavs, audio.wav
node render.js --mode=pipe --out=v_noaudio.mp4
ffmpeg -i v_noaudio.mp4 -i audio.wav -c:v copy -c:a aac -b:a 192k -shortest PickleSensei_showcase.mp4
```

Preview one frame per second as PNGs, or specific moments:

```bash
node render.js --every=30 --out=preview
node render.js --times=1.8,12.4,17.8 --out=keyf
```

## Editing

Timing lives in `setTime(t)` and the `CAPS` table (captions and voice cues) in
`timeline.html`; the same cue times are used by `audio.py` (`VO` dict). To replace the swing
footage, overwrite `clips/swing.mp4` (portrait, about 3.7 s) and re-run `prepare.sh`; the
`SWING_N` constant in `timeline.html` must match the extracted frame count.
