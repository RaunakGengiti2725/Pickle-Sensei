# T — Competitor Benchmark Research: Pickleball + Adjacent AI Form/Technique Analysis (2025–2026)

Run date: 2026-08-28. Feeds `docs/CLAIM_REVIEW.md` Gate J ("Competitor evidence").
Public information only. Every factual row cites the URL it came from. Where a vendor
site is a JS-rendered SPA that returned empty on direct fetch, the row is marked
`[search-index]` (content retrieved verbatim via web search of that URL); directly
fetched pages are marked `[fetched]`. Anything not confirmable is marked UNVERIFIED.
No metrics were fabricated; vendor numbers are labeled CLAIMED unless independently
demonstrated.

---

## 1. The real players

### 1.1 Pickleball-specific analysis

**PB Vision** (Pickleball Vision AI Inc.) — full-game upload analytics
- Platform: iPhone/iPad + Apple Watch (preview/record control since v3.5.0, Jul) `[fetched]` https://apps.apple.com/us/app/pb-vision/id6467020610 ; Android `[search-index]` https://play.google.com/store/apps/details?id=com.pb.vision.app ; works with footage recorded outside the app (Play review praises this).
- Capture setup: phone on tripod/fence mount ≥5 ft high, entire court + all 4 corners + all players visible, ~0.5x wide lens, stable; videos ≤30 min, cut to 1 game `[search-index]` https://help.pb.vision/articles/1108176-framing-and-court-alignment-guidelines , https://help.pb.vision/en/help/articles/1981767-video-upload-troubleshooting
- Player identity: tracks all players and "recreat[es] your entire game in 3D"; players tag themselves via shared game links (coach flow) `[search-index]` https://pb.vision/ , https://pb.vision/coaches . No advertised single-athlete auto-lock; identity is post-hoc tagging.
- Auto stroke detection: yes, per-shot classification across full games — drives, drops, dinks, lobs, Ernes, ATPs, serves, returns; filterable by player/stroke side (forehand/backhand/volley) `[fetched]` App Store; `[search-index]` https://help.pb.vision/articles/8569324-using-shot-explorer
- Technique feedback: shot-by-shot **quality/accuracy scores + "coaching cues"** — outcome analytics, not biomechanical form analysis (no joint/paddle mechanics advertised) `[fetched]` App Store; `[search-index]` https://pb.vision/
- Contact-moment detection: not advertised. Phase/timeline: Shot Explorer + 3D shot trajectories + rally-only replay + bookmarks/draw mode `[fetched]` App Store.
- Coaching depth/validation: 6 automatic skill ratings (Kitchen Game, Ball Control, Defense, Offense, Court IQ, Targeting / App Store lists Serve, Return, Offense, Defense, Consistency, Agility). **No published expert/independent validation found — UNVERIFIED.**
- Drills: coaching cues + "practice with purpose" positioning; no structured drill engine advertised.
- Latency: cloud post-processing; vendor: "most videos process in about 30 minutes" `[search-index]` help.pb.vision (Video Upload Troubleshooting). Real-world Play review reports 3–24h advertised in-app and a 26h instance `[search-index]` Google Play listing. CLAIMED 30min vs observed multi-hour tail.
- Session/aggregate analytics: core product — per-game stats + Historical Trends across games (subscription) `[search-index]` https://help.pb.vision/articles/9743996-subscriptions-minutes-ambassador-program
- Pricing: Starter $19.99/mo (100 min) or $99.99/yr (1,200 min); Premium $49.99/mo (400 min) or $396/yr (4,800 min); minute packs $9.99/60min → $99.99/1,200min; first upload free (≤25 min) `[search-index]` help.pb.vision subscriptions article; https://pb.vision/gift confirms tiers.
- Privacy posture: App Store label — data **linked to you** incl. Device ID/usage for third-party advertising, developer marketing, analytics `[fetched]` App Store App Privacy. Training-data reuse policy: UNVERIFIED (not stated in fetched materials).
- Real-world gaps (their own store reviews `[fetched]`): no manual correction when AI mislabels ("The fact that it cannot be corrected makes all the game stats wrong"), 30-min cap forces per-game restarts, playback bugs.

**SwingVision** (tennis + pickleball) — real-time match stats/line calling
- Platform: iPhone/iPad on iOS/iPadOS 18, Apple Watch, Mac; **no Android** (2023 newsletter: delayed after Pixel 7 overheating + Samsung 60fps limits `[search-index]` https://swing.vision/newsletters/android-update ; still iPhone-only per third party `[search-index]` https://www.ten-fifty5.com/post/swingvision-alternative-for-android ; Android engineer job posting live `[search-index]` https://builtin.com/job/senior-android-engineer/3185947 ).
- Capture setup: single camera behind baseline — ground tripod, fence mount, or their "Swing Stick" (phone holder + built-in angle guides, clips to fences); Siri audio-guided framing; net tape/full court in frame `[search-index]` https://swing.vision/guides/set-up-your-recording ; Swing Stick praised for pickleball-court fences `[search-index]` https://betterpickleball.com/swingvision-review/
- Player identity: automatic player+ball tracking for match participants (patented single-camera AI) `[fetched]` https://apps.apple.com/us/app/swingvision-tennis-pickleball/id989461317 . No single-athlete lock-on-busy-court flow advertised.
- Auto stroke detection: yes — shot type, speed, depth, placement, rally length; highlights by shot type `[fetched]` App Store.
- Technique feedback: stats-driven ("personalized coaching after each session"); Pro plan lists "Review technique & export raw data" = video review + data export, **not automated biomechanics scoring** `[search-index]` https://swing.vision/
- Contact-moment detection: not advertised as a user-facing feature. Phase/timeline: shot-by-shot / point-by-point video review, dead-time trimming, slow-mo line challenges on Watch `[fetched]` App Store.
- Accuracy claims: shot speed within ~10% and 97% line-call accuracy on close calls (≤10 cm) **with ideal setup + 60fps** — vendor numbers `[search-index]` https://swing.vision/ ; 93%→97% upgrade history `[search-index]` https://swing.vision/newsletters/ai-highlights ; echoed by press `[search-index]` https://www.tennisnerd.net/news/live-line-calling-from-swingvision/43158
- **Independent validation (unique in this set):** peer-reviewed study, Int. J. of Performance Analysis in Sport (2023), 1,065 strokes, 6 players, two camera angles vs human-analyst criterion: "SwingVision is trustworthy, and users should be aware of possible errors derived from angle differences" — **tennis match stats, not pickleball, not technique** `[search-index]` https://doi.org/10.1080/24748668.2023.2268475
- Latency: real-time on-device processing ("no internet required... stats, highlights and officiating in real-time") `[search-index]` swing.vision + builtin.com job page; real-time line calls `[fetched]` App Store. DEMONSTRATED at product level (shipping feature), no published ms-level numbers.
- Session analytics: match scoreboards, stats over time, weekly goals, team platform `[fetched]` App Store; `[search-index]` https://swing.vision/teams
- Pricing: SwingVision Pro $179.99/yr or $14.99/mo `[fetched]` App Store.
- Privacy posture: App Store label — analytics/diagnostics **not linked** to identity; Usage Data used for cross-app tracking `[fetched]` App Store App Privacy. Training-data reuse: UNVERIFIED.
- Real-world gaps (store reviews `[fetched]`): auto-scoring errors ("gets 1 or 2 games wrong and 10+ points wrong"), clunky correction flow. Backers: Andy Roddick, Lindsay Davenport; official app of Tennis Australia/LTA/ITA `[fetched]` App Store.

**SportsReflector** (20+ sports incl. pickleball) — 0–100 form scores
- Platform: iPhone/iPad/Apple Watch `[fetched]` https://apps.apple.com/us/app/sportsreflector-ai-coach/id6759809796
- Capture setup: live recording, video upload, multi-angle or multi-frame capture; user-framed (no guided court setup) `[fetched]` App Store.
- Player identity: no auto athlete lock advertised; user records themself.
- Auto stroke detection: user selects sport/technique; no advertised automatic stroke-type detection.
- Technique feedback: per-technique **0–100 form score** + category ratings + written feedback + follow-up Q&A; pickleball-specific: dink paddle-face angle, third-shot-drop trajectory/follow-through, serve mechanics, volley form `[search-index]` https://sportsreflector.com/ai-coaching/pickleball , https://sportsreflector.com/compatible-sports-and-use-cases
- Contact-moment: CLAIMS "exact paddle angle at contact", wrist pronation measurement, 240fps processing `[search-index]` https://sportsreflector.com/ai-faq/pickleball — no methodology, no dataset, no validation published.
- Accuracy claim: "computer vision at 94.4% accuracy" `[search-index]` sportsreflector.com/ai-faq/pickleball — **CLAIMED, zero published evidence; no expert-calibration evidence found (consistent with CLAIM_REVIEW.md).**
- Coaching depth/validation: "AI feedback is general guidance only and does not replace professional coaching" disclaimer `[fetched]` App Store. Team of 3 (developer response) `[fetched]` App Store reviews. 12 ratings, 3.9★.
- Drills: 150+ drills, multi-week programs, AR real-time overlays `[fetched]` App Store.
- Latency: "instant"/"real-time AR" CLAIMED `[fetched]` App Store; no numbers.
- Pricing: $14.99/mo per their own FAQ `[search-index]` sportsreflector.com/ai-faq/pickleball ; 3-day trial `[fetched]` App Store.
- Privacy: App Store label — Health & Fitness data + User ID **linked to you** `[fetched]` App Store. Training-data reuse: UNVERIFIED.

**LLM-wrapper tail (pickleball "AI coach" apps)** — all CLAIMED capability, none publish accuracy/validation:
- **AI Pickleball Coach** — upload clip → LLM feedback + drill plans from 3 onboarding questions `[search-index]` https://apps.apple.com/us/app/ai-pickleball-coach/id6740565765
- **Coach Pickle** — 31 coach-authored drills across DUPR bands 2.5–5.0+, per-drill AI video review ("prop your phone on the fence"), ratings + prioritized fixes (Pro) `[search-index]` https://apps.apple.com/us/app/coach-pickle/id6761891829 — most structured of the tail; drill authorship = "coach-authored" CLAIMED, no named validation.
- **Pickleball Stroke Analyzer** — "AI video analysis... paddle angle, body position, timing" `[search-index]` https://apps.apple.com/us/app/pickleball-stroke-analyzer/id6748886798
- **DinkAI** `[fetched]` https://apps.apple.com/us/app/dinkai-your-pickleball-coach/id6755826435 — swing mechanics/paddle angle/footwork feedback CLAIMED; reality check: 6 ratings 3.7★, top review "Vibecoded mess... genuinely doesn't work"; developer's other apps include TallerTeen and a calorie tracker; privacy label "Data Not Collected".
- **Pickle Ai: Pickleball Coach GO** — upload gameplay → tips `[search-index]` https://apps.apple.com/us/app/pickle-ai-pickleball-coach-go/id6756892870
- Takeaway: the "per-stroke technique feedback" space in pickleball is currently occupied by unvalidated 0–100 scores and LLM wrappers. Nobody demonstrates measurement.

### 1.2 Adjacent racket/rotational-sport technique tech (capability benchmarks)

- **SevenSix Tennis** (tennis-only, iPhone): auto-detects body movement, swing curve, timing, **ball impact point**; performance score = similarity to a professional player + kinetic-chain timing; "instant, in real-time"; LLM "AI Coach Assistant" using recorded swings `[search-index]` https://sevensixtennis.com/ , https://apps.apple.com/us/app/sevensix-tennis-ai-coach/id1505604446 . No pickleball. Validation: "packed with the experience of world-renowned technical tennis coaches" — CLAIMED, unnamed methodology.
- **Sportsbox AI 3D Golf** (golf-only): markerless 3D kinematics from a single slow-mo (120fps+) face-on phone video; 6 viewing angles; angular/linear measurements (turn, bend, sway, lift); **auto swing detection that records/cuts clips**; coach Watchlists with goal ranges = real-time corrective feedback; content from named top-50 instructors `[search-index]` https://www.sportsbox.ai/support , https://apps.apple.com/us/app/sportsbox-3d-golf/id1578921026 , https://www.sportsbox.ai/press-releases/3dpractice-launch . IAPs listed: 3D Player $15.99, 3D Pro $79.99/$799.99 `[search-index]` App Store. No pickleball product found (UNVERIFIED beyond absence from their listings). This is the demonstrated ceiling for phone-based 3D kinematics in a paddle-adjacent motion.
- **OnForm** (any-sport coach platform, incl. pickleball coaches): 1080p up to 240fps capture, slow-mo/frame-by-frame, drawing + voice-over, side-by-side/overlay compare, **AI skeleton tracking**, auto-detect hands-free recording, multi-cam up to 4 angles, radar integrations; 3D + kinematic sequence **golf-only**, computed on-device in ~10 s on iPhone 16 Pro (their number) `[search-index]` https://onform.com/video-analysis-for-coaches/ , https://support.onform.com/article/153-user-guide-onform-video-analysis-app , https://onform.com/sports/ ("150+ sports"). Technique judgment comes from the **human coach**, not AI. Pricing: Coach tiers; Coach Pro $59/mo or $599/yr (new plans effective 2026-04-06; upgrade promo $49/$499) `[search-index]` https://onform.com/pricing/ , https://support.onform.com/article/180-new-coaching-tiers-and-pricing-plans . Coached athletes free.

### 1.3 Big platforms (no technique analysis — fitness only)

- **Apple**: Pickleball workout type in the Watch Workout app; Apple Heart & Movement Study analyzed 250,000+ pickleball/tennis workouts (90-min avg pickleball sessions; pickleball surpassed tennis in July 2023) `[fetched]` https://www.apple.com/newsroom/2023/10/new-apple-research-highlights-the-health-benefits-of-pickleball/ . Health metrics only; no stroke or form analysis. No pickleball technique feature in Apple Fitness+ found — UNVERIFIED/none found.
- **Garmin**: pickleball activity profile (e.g., Venu 3, Forerunner 165), indoor/outdoor variants; tracks time, HR, calories, VO2 max, intensity minutes, Body Battery `[fetched]` https://www.garmin.com/en-US/blog/fitness/activating-the-pickleball-feature-on-your-garmin-watch/ (2024-07-24). No stroke/technique analysis.
- Implication: the platforms legitimize pickleball as a tracked activity but leave the technique-analysis lane open; they also set user expectations that "pickleball tracking" is free.

---

## 2. Comparison matrix vs Pickle Sensei's ACTUAL current state

Pickle Sensei column sourced from internal evidence: `docs/CLAIM_REVIEW.md` (gates A–J, verdict FAIL),
`docs/STATUS_BOARD.md` (baseline cascade TARGET 5/5 → … → STROKE 1/5; strict survival 1/5),
`docs/CAMERA_EXPERIENCE.md` (guided capture state machine). "PS" = Pickle Sensei.

| Dimension | PB Vision | SwingVision | SportsReflector | LLM tail (DinkAI etc.) | Sportsbox 3D Golf (adjacent) | OnForm (coach tool) | **Pickle Sensei (actual)** |
|---|---|---|---|---|---|---|---|
| Platform | iOS+Watch, Android, web | iOS/iPadOS 18+, Watch, Mac; NO Android | iOS, Watch | iOS | iOS, Android | iOS full; Android limited | iOS/Android app in dev; **nothing shipped publicly** |
| Capture setup | Tripod/fence ≥5 ft, full court, ≤30-min games | Fence/Swing Stick behind baseline, Siri-guided framing | User-framed selfie/tripod video | "Prop phone on fence" | Slow-mo 120fps+ face-on, user-framed | Coach-held or tripod, up to 240fps | Courtside phone, guided state machine (POSITIONING→LOCKING→BODY LOCKED→MOTION CAPTURED), walk-away one-stroke flow |
| Auto athlete identity on busy court | Post-hoc player tagging | Match-participant tracking | None | None | N/A (single golfer) | None (human selects) | **Automatic target lock; evidence-gated; reverts when joints lost** — differentiated, but survival depends on cascade (TA 5/5 on gold, tiny n) |
| Auto stroke-event detection | Full-game shot segmentation (DEMONSTRATED product) | Full-match shot segmentation, real-time (DEMONSTRATED product) | No (user declares) | No (user uploads clip) | Auto swing detection + auto-cut (golf) | Auto-record trigger only | Auto motion-window detection live (EVENT 3/5 on gold cascade); declared + auto modes; **not yet reliable** |
| Stroke-type ID | Yes: dink/drive/drop/lob/Erne/ATP/serve/return | Yes: by shot type | User-declared | User-declared | N/A | No | Declared-vs-predicted separation designed; STROKE 1/5 survival on gold |
| Per-stroke technique feedback | No (quality/outcome scores + cues) | No (stats + video review) | **Yes — 0–100, UNVALIDATED** | "Yes" — LLM text, unvalidated | Yes — 3D kinematic measurements (golf) | Human coach judgment | Designed (contact/phase analysis) but **Result deliberately withholds score/faults/drills until coach validation (0 coach labels so far)** |
| Contact-moment detection | Not advertised | Not advertised (internal to tracking) | CLAIMED ("paddle angle at contact") no evidence | No | Impact position in 3D (golf) | Manual frame-scrub | Built + measured honestly: CONTACT 1/5 survival, abstains on compact strokes — #1 cascade loss |
| Phase/timeline replay | Shot Explorer, 3D trajectories, rally replay | Shot-by-shot/point-by-point, slow-mo challenges | Side-by-side compare | No | 6-angle 3D replay, frame-by-frame | Slow-mo, overlay compare | Phase timeline designed; PHASE 1/5 survival on gold |
| Coaching depth / validated by whom | 6 skill ratings — no published validation | Stats coaching; **independent peer-reviewed validation of tennis match stats (1,065 strokes, 2023)**; pro/federation backing | "94.4%" CLAIMED, nothing published | Nothing | Named top instructors author content; kinematics vs lab claims | The coach IS the validator | Refuses to ship unvalidated scores; coach-review schema+queue exist, **0 qualified coach labels** |
| Drills | Cues only | Suggested drills/goals (Editors' Choice blurb) | 150+ drills, AR programs | Drill plans (LLM) | 150+ practice guides by named coaches | Coach-assigned | Drills withheld by design pending validation |
| Latency | CLAIMED ~30 min cloud; observed multi-hour tail | Real-time on-device (shipping); no ms figures published | "Instant" CLAIMED | Seconds–minutes CLAIMED | Near-real-time watchlist feedback (golf) | ~10 s for golf 3D on iPhone 16 Pro (their number) | **iPhone latency NOT MEASURED; research path ~23 s vs ≤5 s target** (Gate F FAIL) |
| Session/aggregate analytics | Core product: per-game + historical trends | Core product: match stats over time, teams | Progress tracking | Minimal | Lesson tracking | Athlete library | Session multi-event engine IN_FLIGHT (workstream E); nothing shipped |
| Pricing | $19.99–49.99/mo, $99.99–396/yr, minute packs | $179.99/yr ($14.99/mo) | $14.99/mo | ~$ trials/subs | $15.99–79.99/mo tiers | Coach $59/mo ($599/yr) Pro tier | N/A (pre-release) |
| Privacy on training data | Ads-linked device data (App Store label); training reuse UNVERIFIED | Analytics not linked to identity (label); training reuse UNVERIFIED | Health data linked (label); training reuse UNVERIFIED | DinkAI: "Data Not Collected" (label) | UNVERIFIED | UNVERIFIED | Internal PRIVACY.md governs; local clip storage per CAMERA_EXPERIENCE.md; not yet a public posture |

---

## 3. CLAIMED vs DEMONSTRATED ledger

| Claim | Holder | Status |
|---|---|---|
| 97% close-call line accuracy; speed within 10% (60fps, ideal setup) | SwingVision | CLAIMED by vendor with stated conditions; adjacent independent peer-reviewed study demonstrates stat trustworthiness for **tennis** with angle caveats (doi.org/10.1080/24748668.2023.2268475) — strongest evidence posture in the field |
| Real-time on-device processing | SwingVision | DEMONSTRATED as a shipping product behavior (live line challenges); no published latency figures |
| ~30-min cloud processing | PB Vision | CLAIMED; user review documents 3–24h in-app estimate and a 26h case |
| 6-dimension skill ratings measure skill | PB Vision | CLAIMED; no published validation |
| 0–100 form score, "94.4% accuracy", paddle angle at contact, 240fps | SportsReflector | CLAIMED; no methodology, no dataset, no expert calibration published; 3-person team; disclaimer that AI feedback is "general guidance only" |
| Pro-similarity performance score, ball-impact detection | SevenSix (tennis) | CLAIMED; no published validation |
| Swing mechanics/paddle-angle feedback | DinkAI + LLM tail | CLAIMED; DinkAI's own store reviews report non-functioning analysis |
| Single-video 3D kinematics comparable to lab systems | Sportsbox / OnForm (golf) | Partially demonstrated ecosystem traction (golf instruction market, named coaches); lab-equivalence claims themselves UNVERIFIED here |
| "Best pickleball analyzer" | **Pickle Sensei** | **FAIL — may not be used** (docs/CLAIM_REVIEW.md verdict; approved language: "Pickle Sensei is still being validated.") |

---

## 4. Brutal conclusions

### 4.1 What a legitimate "best pickleball analyzer" claim would require against these specific products
1. **Beat SwingVision's evidence posture, not just its features.** They have vendor accuracy numbers with stated conditions AND an independent peer-reviewed study. A best-in-class claim needs a comparable-case benchmark (same footage, published protocol) vs SwingVision + PB Vision at minimum, plus our own independent validation. Gate J currently FAILs precisely here.
2. **Match demonstrated reliability at scale before claiming superiority anywhere.** PB Vision and SwingVision ship full-game/full-match segmentation to thousands of users; our strict cascade survival is **1/5 on 5 gold events** (Gate A/D FAIL). Claims are impossible while n=5 and survival=20%.
3. **Real-device latency numbers.** SwingVision is real-time on-device; PB Vision is ~30-min cloud. We are an unmeasured research path at ~23 s vs a ≤5 s target (Gate F FAIL). "Best" requires a measured iPhone number that at least beats PB Vision's cloud round-trip and approaches SwingVision's real-time bar for the single-stroke flow.
4. **Ship the validated technique score SportsReflector fakes.** The 0–100-with-no-evidence lane is already occupied. The only defensible "best" position is *expert-calibrated* per-stroke feedback — which requires the first coach cohort (Gate H: 0 labels today).
5. **A session mode that at least reaches PB Vision's table stakes** (per-stroke breakdown of continuous play with player attribution and trends), since "analyzer" in this market is read as match analytics.

### 4.2 Competitor capabilities that are table stakes we currently lack
- Full-session stroke-by-stroke analytics with aggregate trends (PB Vision core; SwingVision core) — our session engine is IN_FLIGHT, unshipped.
- Robust ball/paddle/contact perception under common conditions — we have documented catastrophic slices (ball body-overlap 0-recall; edge-on paddle; contact abstains on compact strokes; Gate E FAIL).
- Measured on-device latency and a production capture→result path (Gate F FAIL).
- Any public product surface, pricing, and privacy policy (all competitors have these; we have internal docs).
- User-visible correction/override when AI errs — PB Vision is criticized for lacking it; SwingVision partially has it; our abstention-first design must not become abstention-only UX.

### 4.3 Honest-abstention / validation-discipline properties that ARE differentiators
- **Walk-away single-stroke capture with automatic athlete lock + auto event detection**: no pickleball competitor advertises target-identity lock on a busy court; PB Vision uses post-hoc tagging, SwingVision tracks match participants in a framed court, SportsReflector/LLM tail require self-framed clips. Sportsbox (golf) proves auto-capture UX value in an adjacent market. This is real, differentiated capture UX — *if* the cascade behind it becomes reliable.
- **Declared-vs-predicted separation and abstention-first perception**: nobody in the set advertises abstention or calibrated refusal; the market default is confident wrong answers (documented in SwingVision/PB Vision/DinkAI reviews). This is a defensible trust position — but it is a differentiator only when paired with a useful non-abstained rate (workstream U's usable-result metric).
- **Refusing to ship unvalidated 0–100 scores**: directly contrasts SportsReflector's "94.4%" and the LLM tail. When Gate H flips (first qualified coach labels), "every score traceable to expert labels" becomes a claim no pickleball competitor can currently make.
- **Contact-moment + phase timeline per stroke**: unoccupied in pickleball (only CLAIMED by SportsReflector). If contact fusion (workstream A) fixes the #1 cascade loss, this becomes the technical moat; today it is our weakest measured link (1/5).

### 4.4 Bottom line for CLAIM_REVIEW Gate J
External evidence confirms the claim gate must remain **FAIL**. The honest positioning today:
pickleball has (a) demonstrated match-analytics leaders (SwingVision, PB Vision) who do not do
per-stroke biomechanical technique feedback, and (b) an unvalidated technique-score tail. Pickle
Sensei's designed lane — validated, abstention-honest, single-stroke technique analysis with
automatic capture — is genuinely unoccupied, but every measured internal gate says we have not
earned it yet. Approved language stands: "Pickle Sensei is still being validated."

---

## 5. Source register (fetch status)

Fetched directly (webfetch, content on disk this session):
1. https://apps.apple.com/us/app/swingvision-tennis-pickleball/id989461317 — features, $179.99/yr, privacy label, reviews
2. https://apps.apple.com/us/app/pb-vision/id6467020610 — features, Watch support, privacy label, reviews
3. https://apps.apple.com/us/app/sportsreflector-ai-coach/id6759809796 — features, disclaimer, 3-person team, privacy label
4. https://apps.apple.com/us/app/dinkai-your-pickleball-coach/id6755826435 — claims vs reviews, "Data Not Collected"
5. https://www.apple.com/newsroom/2023/10/new-apple-research-highlights-the-health-benefits-of-pickleball/ — Watch pickleball workout, 250k-workout study
6. https://www.garmin.com/en-US/blog/fitness/activating-the-pickleball-feature-on-your-garmin-watch/ — Garmin pickleball activity profile

Search-indexed (URL content quoted via web search; direct fetch JS-blocked/empty where attempted):
7. https://pb.vision/ · 8. https://pb.vision/coaches · 9. https://pb.vision/clubs · 10. https://pb.vision/gift
11. https://help.pb.vision/articles/9743996-subscriptions-minutes-ambassador-program (pricing)
12. https://help.pb.vision/articles/1108176-framing-and-court-alignment-guidelines (setup, ~30-min processing)
13. https://help.pb.vision/en/help/articles/1981767-video-upload-troubleshooting (30-min cap)
14. https://help.pb.vision/articles/8569324-using-shot-explorer (stroke filters)
15. https://play.google.com/store/apps/details?id=com.pb.vision.app (Android; processing-time review)
16. https://swing.vision/ (accuracy claims, iOS 18 requirement, Pro features)
17. https://swing.vision/guides/set-up-your-recording (capture setup)
18. https://swing.vision/newsletters/ai-highlights (93%→97% history)
19. https://swing.vision/newsletters/android-update (no Android; device requirements)
20. https://swing.vision/teams (team analytics)
21. https://doi.org/10.1080/24748668.2023.2268475 (independent validation study, abstract)
22. https://www.tennisnerd.net/news/live-line-calling-from-swingvision/43158 (press corroboration)
23. https://betterpickleball.com/swingvision-review/ (Swing Stick on pickleball fences)
24. https://builtin.com/job/senior-android-engineer/3185947 (on-device real-time positioning)
25. https://www.ten-fifty5.com/post/swingvision-alternative-for-android (iPhone-only corroboration)
26. https://sportsreflector.com/ai-coaching/pickleball · 27. https://sportsreflector.com/ai-faq/pickleball ("94.4%", $14.99/mo) · 28. https://sportsreflector.com/compatible-sports-and-use-cases
29. https://apps.apple.com/us/app/ai-pickleball-coach/id6740565765 · 30. https://apps.apple.com/us/app/coach-pickle/id6761891829 · 31. https://apps.apple.com/us/app/pickleball-stroke-analyzer/id6748886798 · 32. https://apps.apple.com/us/app/pickle-ai-pickleball-coach-go/id6756892870
33. https://sevensixtennis.com/ · 34. https://apps.apple.com/us/app/sevensix-tennis-ai-coach/id1505604446
35. https://www.sportsbox.ai/support · 36. https://apps.apple.com/us/app/sportsbox-3d-golf/id1578921026 · 37. https://play.google.com/store/apps/details?id=com.sportsbox.golfai · 38. https://www.sportsbox.ai/press-releases/3dpractice-launch
39. https://onform.com/pricing/ · 40. https://onform.com/video-analysis-for-coaches/ · 41. https://onform.com/sports/ · 42. https://support.onform.com/article/180-new-coaching-tiers-and-pricing-plans · 43. https://support.onform.com/article/153-user-guide-onform-video-analysis-app · 44. https://apps.apple.com/us/app/onform-video-analysis-app/id1490334045

Internal (Pickle Sensei actual state): docs/CLAIM_REVIEW.md, docs/STATUS_BOARD.md, docs/CAMERA_EXPERIENCE.md.
