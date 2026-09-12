# Pickle Sensei — app showcase reel

A 24 s, 1080×1920, 30 fps vertical showcase (Reels / TikTok / App Store preview). Everything
is rendered from `timeline.html`, one deterministic motion timeline: `window.__setTime(t)`
positions every element for time `t`, and `render.js` drives headless Chromium through it
frame by frame, piping PNGs into ffmpeg.

## Story (seconds)

One continuous narration drives everything: captions appear word by word on the spoken
timestamps, and scenes cut on phrase starts.

| Time      | Beat                                                         | Narration                                                |
| --------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| 0–2       | App icon and wordmark                                        | "This is Pickle Sensei."                                 |
| 2–3.9     | Real Welcome screen, tap on the word "tap"                   | "It starts with a single tap."                           |
| 3.9–6.3   | Real Home, Coach tap on "Coach"; Coach menu, tap on "import" | "Tap Coach, import a swing,"                             |
| 6.3–10.1  | The owner's swing clip with the scan line                    | "and it reads every frame."                              |
| 10.1–12.8 | Score page (1 of 4), ring sweeps on "estimated DUPR"         | "Then it gives you an estimated DUPR,"                   |
| 12.8–15.4 | The problem (2 of 4), replay card frozen at contact          | "finds the one thing to fix first,"                      |
| 15.4–18.7 | Drill Library cards large on the canvas, one gets saved      | "and matches the drills that fix it."                    |
| 18.7–24.4 | App icon, wordmark, "Try it free today" App Store bar        | "Every swing, seen. Try it free today on the App Store." |

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

- Voiceover: one continuous ElevenLabs take (voice "Petra") through the Higgsfield MCP,
  committed as `narration/petra.mp3`. Word timestamps came from faster-whisper (`base.en`) and
  are hard-coded in the `CAPS` table; `audio.py` inserts four short silences at sentence
  boundaries (after "frame.", "DUPR,", "first," and "it.") so the UI has time. Every other sound is synthesized in
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

Timing lives in `setTime(t)` and the `CAPS` table (word timestamps) in `timeline.html`;
the pause insertions live in `audio.py` (`pad_at`). Re-recording the narration means
re-aligning the words (faster-whisper with `word_timestamps=True`) and updating both. To replace the swing
footage, overwrite `clips/swing.mp4` (portrait, about 3.7 s) and re-run `prepare.sh`; the
`SWING_N` constant in `timeline.html` must match the extracted frame count.
