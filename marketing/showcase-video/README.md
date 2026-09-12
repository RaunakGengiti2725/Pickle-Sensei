# Pickle Sensei — app showcase reel

A 41 s, 1080×1920, 30 fps vertical showcase (Reels / TikTok / App Store preview) built on
2026-09-11. Everything is rendered from `timeline.html`, a single deterministic motion
timeline: `window.__setTime(t)` positions every element for time `t`, `render.js` drives
headless Chromium through it frame by frame and pipes PNGs into ffmpeg.

## Story (seconds)

| Time  | Beat                                                                                |
| ----- | ----------------------------------------------------------------------------------- |
| 0–4   | Ninja mascot drops in and lands (Higgsfield Kling 3.0 clip, played in reverse)      |
| 4–11  | Real Welcome screen → tap → Home → Coach button → Auto Analyze                      |
| 11–16 | Capture screen: Watching → Swing detected → Clip saved · analyzing                  |
| 16–21 | Five checkpoint cards (Ready position, Contact point, Paddle path, Follow-through…) |
| 21–26 | Estimated DUPR ring (3.87, 7.8/10 technique) with a one-line DUPR explainer         |
| 26–31 | "The problem · Priority" card plus the projected estimate after the fix             |
| 31–36 | Drill Library with the drill matched to the fix                                     |
| 36–41 | Ninja slashes the frame to black; slogan "Every swing, seen."                       |

## What is real and what is illustrative

- `sim/welcome.png` is a real screenshot of the app (iPhone 16 Pro simulator).
- Home, capture, result and drill screens are HTML replicas built from `design.md`
  tokens and the app's real copy strings. The simulator has no camera and the app needs
  sign-in, so they could not be captured live.
- Every number (DUPR estimate, technique score, checkpoint results, drills, coaches)
  is illustrative. The shipping app abstains until a validated model is released and
  the drill catalog ships empty (see `README.md` at the repo root).
- The capture scene currently shows the app's own capture-guide silhouette as a
  placeholder. Swap in real footage with `swap_swing.sh` (below).

## Provenance

- `clips/kling-intro-leap.mp4`, `clips/kling-outro-slash.mp4`: generated with Kling 3.0
  (pro, 9:16, 5 s, silent) through the Higgsfield MCP from `assets/mascot.png` as the
  start frame (the outro also used a solid black end frame). Prompts are in the git
  history of this README's first commit message.
- `assets/mascot.png`: the app mascot (same artwork as `apps/mobile/assets/mascot`).
- Fonts (Manrope, OFL) and brand marks are copied from `apps/mobile/assets` by
  `prepare.sh`; they are not duplicated in git.
- Audio: `audio.py` synthesizes every sound (whooshes, taps, chimes, pad) with numpy.
  There is no licensed music track; add one when posting.

## Render

Requirements: Node ≥ 20, ffmpeg, python3 with numpy + scipy, and Playwright's Chromium.

```bash
cd marketing/showcase-video
npm i --no-save playwright-core && npx playwright install chromium
./prepare.sh                      # fonts, brand assets, clip frames, audio.wav
node render.js --mode=pipe --out=v_noaudio.mp4
ffmpeg -i v_noaudio.mp4 -i audio.wav -c:v copy -c:a aac -b:a 192k -shortest PickleSensei_showcase.mp4
```

Preview one frame per second as PNGs instead of a full render:

```bash
node render.js --every=30 --out=preview
```

Render specific moments (seconds):

```bash
node render.js --times=8,12.2,23.5 --out=keyf
```

## Swap in the real swing clip

```bash
./swap_swing.sh /path/to/swing.mov 0 1.9
```

Arguments: where the 4.6 s capture window starts in the source clip, and seconds into
that window when the paddle meets the ball (drives the "Swing detected" beat). The
script re-extracts frames, flips `SWING_MODE` to `clip`, re-renders and re-muxes.

## Editing

All timing lives in `setTime(t)` and the `CAPS` caption table inside `timeline.html`.
Colors are the app tokens from `design.md`; screens are laid out in iPhone points
(402×874) and scaled into the phone frame. A full render takes about three minutes.
