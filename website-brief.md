# Pickle Sensei — Complete Website Brief (zero-context handoff)

You are building the official marketing website for **Pickle Sensei**. You
have never seen this product before — that's fine. This document contains
EVERYTHING you need: what the product is, every real feature, the complete
design system (every color, font, radius, shadow, animation), the exact page
structure, approved copy, and a QA checklist. Treat it as the single source
of truth. Do not add facts, colors, or features that are not in this
document.

---

# PART 1 — THE PRODUCT (context)

## 1.1 What is Pickle Sensei?

Pickle Sensei is an **iPhone app that works as a private pickleball
technique coach**. A player props up their phone at the court, plays, and the
app automatically captures their strokes using on-device pose tracking — no
tapping record, no shot picker, no timer. Each capture is analyzed and, when
the analysis is validated, the player gets an honest technique score with an
evidence-backed breakdown and one clear next step to work on.

The brand's core promise: **"See the stroke. Know the fix."**

The product is deliberately honest and privacy-first. It never invents
scores, never counts failed captures against the player, and keeps video
clips on the player's phone.

## 1.2 How it works (the user journey)

1. **Set the phone once.** The app guides camera placement; pose tracking
   confirms the player is in frame.
2. **Play.** Capture is automatic ("pose-guided"). The player just hits.
3. **Get the read.** A validated analysis returns: an overall technique
   score (0–10, one decimal, e.g. `7.8`), scored checkpoints (0–100 each,
   e.g. "Contact point 74"), and coaching that follows the evidence.
4. **Improve.** Scores build a Bronze→Diamond player rank, trend lines, and
   practice streaks. Guided drills and rights-cleared coaching videos are
   prescribed and saveable.

## 1.3 Feature catalog (all real, shipping features — nothing else exists)

| Feature                                   | What it actually does                                                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stroke Analysis** (a.k.a. Auto Analyze) | The flagship. Analyzes ONE movement with automatic camera capture and deep feedback. Tagline: "One movement, deep feedback."                                                     |
| **Session Analysis / Live Court**         | Follows a full live session with many strokes — "Rallies, stroke by stroke" — and ends with a session summary.                                                                   |
| **Import Video**                          | Analyze an existing real clip from the phone's library.                                                                                                                          |
| **Drill Library**                         | Searchable guided drills with published, rights-cleared coaching videos. Drills can be saved with the plan that prescribed them.                                                 |
| **Player Rank**                           | Bronze → Silver → Gold → Platinum → Diamond emblems, computed only from real validated scores (see 1.5).                                                                         |
| **Progress tracking**                     | Score trend lines, weekly capture volume, active days, pose-tracked time, and a day streak — all from verified automatic captures.                                               |
| **Reminders**                             | Local, fully opt-in practice reminders. Lock-screen-safe: they never include names or scores, and never claim unverified facts.                                                  |
| **Accounts**                              | Sign in with Apple, Sign in with Google, or continue as a guest. Guest sessions stay on the device; connecting an account unlocks free ratings, membership, and synced coaching. |
| **Account deletion**                      | Built into Settings: a two-step, server-verified deletion of the account and all synced data.                                                                                    |

## 1.4 The scoring system (get this right — it's the hero of the product)

- **Overall technique score:** 0–10, shown with one decimal (`7.8`).
  Displayed in a circular "score ring".
- **Checkpoints:** individual technique elements scored 0–100 (e.g. "Paddle
  preparation 82"), each with a band: **green** (good), **yellow** (needs
  work), **red** (fix this). Band color is never shown without the number.
- **Validated only:** a score exists only after a validated, server-accepted
  analysis. Unscored attempts are never punished and never shown as scores.
- Missing values are rendered as an em dash `—`, never `0`.

## 1.5 Player rank

Per-technique scores are averaged into a single rating; the rating maps to a
tier:

| Tier     | Rating     | Emblem colors (accent / deep fill / tint)        |
| -------- | ---------- | ------------------------------------------------ |
| Bronze   | below 3.5  | `#D08A4E` / `#3D2415` / `rgba(208,138,78,0.16)`  |
| Silver   | 3.5 – 4.99 | `#C3CFD6` / `#2E373D` / `rgba(195,207,214,0.16)` |
| Gold     | 5 – 6.49   | `#E8C25C` / `#3F3110` / `rgba(232,194,92,0.16)`  |
| Platinum | 6.5 – 7.49 | `#8FE6D9` / `#0F3B34` / `rgba(143,230,217,0.16)` |
| Diamond  | 7.5+       | `#9CC8FF` / `#14304A` / `rgba(156,200,255,0.18)` |

Emblem silhouettes escalate by tier: round medal → hexagonal badge → star
shield → pointed crest → cut gem. Rank-ups trigger a one-time celebration in
the app.

## 1.6 Pricing & free tier

- **Free:** 2 lifetime free validated ratings per verified account.
  Crucially: _only a successful validated score uses a free rating — every
  unscored outcome returns the allowance._ (This fairness rule is a real
  selling point; feature it.)
- **Pickle Sensei Pro** (subscription/one-time): `$7.99/month`,
  `$59.99/year`, `$159.99 lifetime`.
  `<!-- TODO: verify prices against the live App Store listing before publishing -->`
- Pro benefits (use these verbatim — they are the app's own honest list):
  1. **Unlimited validated ratings** — "Automatic capture, evidence-backed
     checkpoints, and no invented score."
  2. **Coaching that follows evidence** — "When reviewed work exists, a
     server-accepted score sets its priority and reassessment baseline."
  3. **Rank and progress from real scores** — "Bronze-to-Diamond player rank
     and trend lines built only from server-accepted analyses."
  4. **Reviewed practice, kept together** — "Published drills and
     rights-cleared coaching videos can be saved with the plan that
     prescribed them."

## 1.7 Privacy & trust facts (safe to state on the site)

- Capture and pose tracking run on the player's device.
- Video clips stay on the phone; validated scores sync to the account.
- Private by default; reminders are opt-in and never include names or scores.
- Guest mode requires no account and stays entirely on-device.
- Account + all synced data can be permanently deleted in-app.
- Privacy Policy and Terms pages already exist (hosted by the app's backend).
  `<!-- TODO: get the exact public /privacy and /terms URLs from the team -->`

## 1.8 Platform & audience

- **iOS / iPhone only right now.** Do not mention Android or a web app.
- Audience: recreational-to-competitive pickleball players who want to
  improve technique without hiring a coach; privacy-conscious; ages ~25–65.
- The website's ONE job: communicate the product honestly and drive App
  Store downloads. `<!-- TODO: App Store link -->`

## 1.9 Vocabulary (use it, don't paraphrase it)

- An analysis is a **"read"** ("Start your first read", "Recent reads").
- The player's home surface is **"your court"** ("Your court is ready.").
- Always qualify scores: **"validated"**, **"verified"**, **"server-accepted"**.
- The center action in the app is the **"Coach"** button.

---

# PART 2 — BRAND & DESIGN SYSTEM (reproduce exactly)

## 2.1 Personality

Calm, premium, honest, equipment-adjacent. The palette reads like real gear:
**court green**, **graphite/ink**, **warm chalk** surfaces, and exactly one
loud accent — **optic-ball volt**. Quiet chrome: hairline borders, very soft
green-tinted shadows, generous radii. Numbers are the hero.

Five rules that define the look:

1. **One accent.** Volt `#D7FA45` marks only the most important element per
   view. Never large text blocks, never body backgrounds.
2. **Warm light, deep dark.** Light background is warm chalk `#F7F6F0`
   (never pure white); dark sections are green-tinted near-black `#06130E`
   (never pure black or gray).
3. **Tokens only.** Every color on the site must come from §2.2.
4. **Numbers are the hero.** Big, tight, SemiBold, tabular numerals.
5. **SemiBold headings.** Manrope 600 with tight negative tracking — never 700.

## 2.2 Color tokens (paste as-is)

```css
:root {
  /* neutrals — all green-tinted */
  --ink: #071710; /* primary text on light, dark buttons */
  --ink-elevated: #10271e; /* elevated dark cards */
  --ink-soft: #627168; /* secondary text on light */
  --surface: #f7f6f0; /* page background — warm chalk, NOT white */
  --surface-elevated: #ffffff; /* cards, nav bar */
  --surface-alt: #ebefe8; /* soft cards, track backgrounds */
  --surface-dark: #06130e; /* dark sections background */
  --line: #dce3dc; /* hairline borders on light */
  --line-dark: #21382e; /* hairline borders on dark */
  --line-muted-dark: #31433b; /* dividers inside dark cards */

  /* brand */
  --court: #087956; /* primary green — buttons, links, active nav */
  --court-deep: #07563e; /* gradient start, deep panels */
  --court-soft: #d8eee4; /* soft green chips, active-nav pill */
  --volt: #d7fa45; /* THE accent — hero moments only */
  --volt-soft: #effbc4;
  --mint: #53d99b; /* gradient partner of volt */
  --flame: #ff9b42; /* streak flame accent */
  --on-volt: #142014; /* text on volt */

  /* status (score bands) */
  --good: #137a50;
  --good-soft: #dcefe4;
  --warn: #a86416;
  --warn-soft: #f6e8ce;
  --bad: #a63d36;
  --bad-soft: #f4dedb;

  /* text on dark */
  --on-dark: #f8faf5;
  --on-dark-muted: #a5b1aa;
  --on-dark-subtle: #93a39b;
  --on-dark-faint: #819087;

  /* overlays / tints */
  --overlay-strong: rgba(4, 10, 8, 0.68);
  --ink-tint: rgba(11, 23, 19, 0.09);
  --on-dark-tint: rgba(255, 255, 255, 0.1);

  /* spacing scale (px): 2 4 8 16 24 32 48 64 */
  --sp-xxs: 2px;
  --sp-xs: 4px;
  --sp-sm: 8px;
  --sp-md: 16px;
  --sp-lg: 24px;
  --sp-xl: 32px;
  --sp-xxl: 48px;
  --sp-xxxl: 64px;

  /* radii */
  --r-xs: 8px;
  --r-sm: 12px;
  --r-md: 18px;
  --r-lg: 26px;
  --r-xl: 34px;
  --r-pill: 999px;

  /* shadows — extremely soft, green-tinted */
  --shadow-soft: 0 8px 24px rgba(8, 18, 14, 0.07); /* cards */
  --shadow-floating: 0 10px 26px rgba(8, 18, 14, 0.14); /* CTA, popovers */
  --shadow-nav: 0 8px 20px rgba(8, 18, 14, 0.055); /* sticky nav */

  /* gradients */
  --grad-feature: linear-gradient(135deg, #07563e 0%, #06130e 100%);
  --grad-cta: linear-gradient(135deg, #d7fa45 0%, #53d99b 100%);
  --grad-paywall: linear-gradient(180deg, #06130e 0%, #10271e 58%, #07563e 100%);

  /* motion */
  --ease-out: cubic-bezier(0.33, 1, 0.68, 1);
}
```

## 2.3 Typography

Single family: **Manrope** (Google Fonts), weights 400 / 500 / 600 / 700:
`https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap`

| Style     | Weight | Size/Line   | Letter-spacing        | Use                         |
| --------- | ------ | ----------- | --------------------- | --------------------------- |
| hero      | 600    | 48px / 50px | `-0.046em`            | Hero headline               |
| display   | 600    | 64px / 68px | `-0.039em`, tabular   | Giant numbers               |
| score     | 600    | 44px / 48px | `-0.034em`, tabular   | Score numerals              |
| h1        | 600    | 32px / 36px | `-0.031em`            | Section headlines           |
| h2        | 600    | 21px / 27px | `-0.017em`            | Card titles                 |
| h3        | 600    | 17px / 22px | `-0.009em`            | Sub-titles, row values      |
| body      | 400    | 16px / 23px | 0                     | Body copy                   |
| body-bold | 600    | 16px / 22px | 0                     | Button labels, row titles   |
| caption   | 500    | 13px / 18px | 0                     | Secondary copy              |
| micro     | 600    | 11px / 14px | `+0.082em`, UPPERCASE | Eyebrows, pills, nav labels |
| wordmark  | 600    | 18px / 22px | `-0.028em`            | "Pickle Sensei" lockup text |

- Desktop (≥1024px): hero may scale to 64–72px, h1 to 40px — same weights
  and em tracking.
- ALL numbers: `font-variant-numeric: tabular-nums`.
- Eyebrow labels are ALWAYS uppercase micro with wide tracking
  (`THIS WEEK`, `ON-DEVICE`, `POSE-GUIDED`, `PRIVATE BY DEFAULT`).

## 2.4 Components (exact specs)

### Buttons

Pill shape, min-height 56px (compact 46px), 1px solid border, padding
0 24px, body-bold label, 8px gaps. **Primary, volt, and dark variants always
end with a trailing 18px arrow icon** (Appendix A).

| Variant   | bg                   | text        | border    |
| --------- | -------------------- | ----------- | --------- |
| primary   | `--court`            | `--on-dark` | `--court` |
| secondary | `--surface-elevated` | `--ink`     | `--line`  |
| ghost     | transparent          | `--ink`     | `--line`  |
| volt      | `--volt`             | `--on-volt` | `--volt`  |
| dark      | `--ink`              | `--on-dark` | `--ink`   |

States: hover `filter: brightness(0.97)`; active `transform: scale(0.975)`
over 110ms `--ease-out`; disabled opacity 0.42; visible 2px `--court` focus
ring, offset 2px.

### Cards

White `--surface-elevated`, radius 26px, padding 24px, `--shadow-soft`.
Tone variants (no shadow): dark `--ink-elevated` · court `--court-deep` ·
soft `--surface-alt`.

### Signature dark gradient panel (the flagship visual pattern)

`background: var(--grad-feature)` (deep green → near-black, 135°), radius
26–34px. Inside: volt micro eyebrow → `--on-dark` content → hairline
dividers `--line-muted-dark`. Stat footers: equal columns split by 1px
dividers; h3 tabular value over caption label in `--on-dark-faint`.

### Pills / badges

Fully rounded, padding 6px 10px, micro text. Tones: neutral
(`--surface-alt`/`--ink-soft`), good/warn/bad (soft bg + strong text), volt
(`--volt`/`--on-volt`), dark (`--ink-elevated`/`--on-dark`).

### Icon chips

38–46px circles with a 20–21px icon. Light: `--court-soft` bg + `--court`
icon. Dark: `--on-dark-tint` bg + `--volt` icon.

### Sticky top nav

White, 1px `--line` bottom border, `--shadow-nav`, 70px tall. Left: brand
lockup (32px mark + 10px gap + wordmark). Links: micro-style at 13px,
inactive `--ink-soft`, active/hover `--court` inside a `--court-soft` pill
(6px 14px padding). Right CTA: pill button with `--grad-cta` background and
`--ink` text, wrapped in a 5px white ring with `--shadow-floating`. This is
the ONLY gradient button on the site (it mirrors the app's "Coach" button).

### Score ring (build in SVG — the signature element)

154–200px circle. Track: `--line` (light) / `--line-dark` (dark), stroke
width ≈ 6.5% of diameter, round caps. Progress arc: gradient
`--volt → --mint`, starts at 12 o'clock, fraction = score/10. Centered
number: weight 600, tabular, font-size = 29% of diameter; caption label
below in `--on-dark-subtle`. On scroll into view: arc sweeps + number counts
up together, 900ms `--ease-out`, once.

### Checkpoint rows (score list)

Name (body-bold) + right-aligned score (h3, tabular, colored by band).
Below: 4px track (`--surface-alt`, radius 2px) with band-colored fill. 13px
vertical padding, 1px hairline bottom border. Fills sweep from the left
(`scaleX`, origin left, 520ms `--ease-out`), staggered ~90ms, once.

### Phone mockups

Recreate app UI in HTML/CSS/SVG with these exact components inside a device
frame (`--ink` body, radius 48px, 8px bezel). Never use screenshots or stock
device images.

## 2.5 Motion rules

- Everything uses `--ease-out`; animate transform/opacity only.
- Micro-interactions 110–210ms; reveals 520–900ms; nothing loops.
- Scroll reveals: fade + translateY(20px→0) + scale(0.96→1), staggered
  30–90ms, fire once.
- `@media (prefers-reduced-motion: reduce)`: render final states instantly.

## 2.6 Copywriting voice

- Sentence case headlines that end with a period, often two short beats:
  "See the stroke. Know the fix." / "Ready when you are."
- Eyebrows: UPPERCASE micro (`POSE-GUIDED`, `ON-DEVICE`).
- Middle-dot `·` separators in fine print.
- Honest, calm, zero hype. Qualify claims ("validated", "verified"). Never
  superlatives, never invented numbers.

---

# PART 3 — THE WEBSITE TO BUILD

## 3.1 Requirements

- Single-page marketing site (+ anchor nav). Static HTML + modern CSS
  (vanilla or Tailwind; Next.js/Astro acceptable) — all styling must flow
  from the §2.2 variables; never hardcode hex in markup.
- Mobile-first; breakpoints 375 / 768 / 1024 / 1440. Content max-width
  1160px centered; gutters 24px mobile, 40px ≥1024px.
- Proper meta/OpenGraph tags, favicon placeholder, semantic HTML,
  heading hierarchy h1→h6 without skips.

## 3.2 Page structure (in order, with approved copy)

### A. Sticky nav

Links: Features · How it works · The read · Rank · Pricing · FAQ.
CTA: `Get the app` (gradient pill, `<!-- TODO: App Store link -->`).

### B. Hero — DARK (`--surface-dark`)

- Top-left: brand lockup (light). Top-right: dark pill `PRIVATE BY DEFAULT`.
- Headline (hero type, `--on-dark`), exactly two lines:
  `See the stroke.` / `Know the fix.`
- Tagline (body, `--on-dark-muted`, max-width 340px): `A private technique
coach that guides each capture and turns validated reads into one clear
next step.`
- CTA: volt button `Start your first read` (trailing arrow).
- Fine print (caption, `--on-dark-faint`): `Two successful validated
ratings free · Unscored attempts don't count`
- Visual: the court illustration card — `--ink-elevated` panel, radius 34px,
  containing the exact SVG from Appendix B. Overlay top-left: micro `POSE-
GUIDED` in `--volt` → h1 `--on-dark` `Automatic capture.` → caption
  `--on-dark-muted` `No shot picker. No timer.` Bottom-right floating pill
  (`rgba(7,17,14,0.82)` bg): small rotated-square volt outline + micro
  `ON-DEVICE` in `--on-dark`.

### C. Features — LIGHT (`--surface`)

Eyebrow `TWO WAYS TO TRAIN` (micro, `--court`). Headline (h1):
`Ready when you are.`
Two large mode cards (min-height 240px, radius 26px):

1. Dark gradient card: volt camera icon in `--on-dark-tint` chip, arrow
   top-right; h2 `--on-dark` `Stroke Analysis`; caption `--on-dark-subtle`
   `One movement, deep feedback`.
2. White card (1px `--line` border): court icon in `--court-soft` chip;
   h2 `Session Analysis`; caption `Rallies, stroke by stroke`.
   Below: four smaller white cards (radius 18px, 46px colored icon circles):

- **Auto Analyze** (volt circle, camera) — `Auto capture · validated scores only`
- **Live Court** (mint circle, court) — `Follow a full live session`
- **Import Video** (flame circle, upload) — `Choose a real clip from this phone`
- **Drill Library** (court-soft circle, library) — `Guided drills you can search`

### D. How it works — LIGHT

Eyebrow `HOW IT WORKS`. Three steps with 40px volt circles holding micro
`--on-volt` numerals `01 / 02 / 03`:

1. `Set the phone once.` — `Pickle Sensei guides the rest.`
2. `Play your shot.` — `Pose-guided automatic capture. No shot picker. No timer.`
3. `Get one clear next step.` — `Validated reads only — unscored attempts never count against you.`

### E. The read — DARK gradient section (`--grad-feature`)

Eyebrow `THE READ` (micro, `--volt`). Headline (h1, `--on-dark`):
`Your technique, scored honestly.`
Recreate a results panel: score ring showing `7.8` labeled
`Technique score`, beside checkpoint rows:
`Paddle preparation 82` (green) · `Contact point 74` (green) ·
`Follow-through 61` (yellow) · `Recovery stance 47` (red).
Stat footer columns: `12 reads` · `4 active days` · `6 day streak`.
Caption (`--on-dark-subtle`): `Scores appear only after validated analysis.`

### F. Player rank — LIGHT

Eyebrow `PLAYER RANK`. Headline: `Climb from Bronze to Diamond.`
Body: `Every validated read builds your per-technique scores. Your rating is
the honest average — no shortcuts.`
Five emblem cards using the exact tier colors from §1.5 (accent stroke on
deep fill, tint wash background; simple SVG silhouettes with 2.2px strokes:
medal → hex badge → star shield → crest → cut gem). Tier name under each in
micro.

### G. Privacy — LIGHT, soft panel (`--surface-alt`, radius 34px)

Shield icon in `--court-soft` circle. h2: `Private by default.`
Body: `Capture and pose tracking run on your device. Clips stay on your
phone. Reminders are opt-in and never include names or scores. You can
permanently delete your account and synced data anytime, right in the app.`
Pills: `ON-DEVICE CAPTURE` · `OPT-IN REMINDERS` · `IN-APP ACCOUNT DELETION`.

### H. Pricing — LIGHT

Eyebrow `PRICING`. Headline: `Start free. Go Pro when it clicks.`

- **Free card** (white): h2 `Two validated ratings, free.` Body: `Only a
successful validated score uses a free rating. Every unscored outcome
returns the allowance.`
- **Pro card** (dark gradient, volt `MOST POPULAR` pill): **Pickle Sensei
  Pro** — `$7.99/mo` · `$59.99/yr` · `$159.99 lifetime` (tabular numerals).
  Checklist with volt check icons — use the four Pro benefits verbatim from
  §1.6.
  CTA under both: volt button `Start your first read`.

### I. FAQ — LIGHT (accordion, plus icon rotates 45° when open)

Use ONLY these Q&As:

1. **Do I need an account to try it?** `No. Guest sessions stay on this
device. Connect Apple or Google to use free ratings, membership, and
synced coaching.`
2. **How do the free ratings work?** `Every verified account includes two
lifetime free validated ratings. Only a successful validated score uses
one — unscored attempts return the allowance.`
3. **What happens to my videos?** `Clips stay on your phone. Validated
scores sync to your account so your rank and progress are real.`
4. **Can I delete my data?** `Yes. Settings includes a two-step account
deletion that permanently removes your account and all synced data.`
5. **What devices are supported?** `Pickle Sensei is an iPhone app.`

### J. Final CTA — DARK (`--surface-dark`)

Headline (hero, two lines): `Your court is ready.` / `The first read starts
here.` Volt CTA `Get Pickle Sensei` + the hero fine-print line.

### K. Footer

`--surface-dark`, 1px `--line-dark` top border. Brand lockup (light),
caption `--on-dark-faint`: `© 2026 Pickle Sensei · Private by default`.
Links: Privacy Policy · Terms · Support — `href="#"` with
`<!-- TODO: real URLs (privacy/terms pages already exist on the backend) -->`.

## 3.3 Assets

- **Logo:** `pickle-mark@3x.png` will be provided — a black-ink silhouette
  of a pickleball player (headband, paddle raised, ready stance). Render at
  32px, tinted `--ink` on light / `--on-dark` on dark, next to the wordmark
  "Pickle Sensei". If missing, leave an `<img alt="Pickle Sensei">`
  placeholder — do NOT generate or substitute a different logo.
- **Icons:** only Appendix A. **Illustration:** only Appendix B.
- No stock photos, no AI-generated imagery, no app screenshots.

---

# PART 4 — HARD RULES & ACCEPTANCE CHECKLIST

## 4.1 Hard rules

1. Use ONLY §2.2 tokens — never invent a hex, shadow, or radius.
2. **No fabricated marketing:** no testimonials, user counts, star ratings,
   press logos, awards, or "trusted by" claims. None exist. Use only the
   copy in this brief.
3. No emoji anywhere. No icon libraries (no Lucide/Heroicons/Font Awesome) —
   Appendix A only.
4. No pure black `#000`, no pure-gray neutrals, no white page background.
5. Headings: Manrope 600 with negative tracking — never 700.
6. Unknown URLs stay `href="#"` + TODO comment. Never invent URLs.
7. Don't mention Android, web app, AI model names, or team details.
8. All animation respects `prefers-reduced-motion`.

## 4.2 Acceptance checklist (verify every line before finishing)

- [ ] Page background `#F7F6F0`; dark sections `#06130E`.
- [ ] Every rendered color exists in §2.2 (or the §1.5 tier table).
- [ ] Manrope 400/500/600/700 loaded; headings 600 with correct em tracking.
- [ ] All numbers (scores, prices, stats) use tabular numerals.
- [ ] Buttons: pill, 56px min-height, trailing arrow on primary/volt/dark.
- [ ] Nav CTA is the only gradient button; it has the 5px white ring.
- [ ] Score ring: track/gradient/rounded caps/12-o'clock start; 900ms
      one-time sweep with synchronized count-up.
- [ ] Checkpoint bars: 4px tracks, band colors, 520ms staggered reveal.
- [ ] Reduced motion renders everything static.
- [ ] All copy matches this brief exactly (headlines, taglines, fine print).
- [ ] Zero fabricated claims/numbers/logos.
- [ ] Responsive at 375/768/1024/1440; no horizontal scroll.
- [ ] Contrast ≥ 4.5:1 for text (token pairs already pass — don't lighten).
- [ ] Visible focus rings; interactive targets ≥ 44px.
- [ ] TODO comments on every placeholder link/price.

---

# APPENDIX A — Icon set (exact SVGs, use verbatim)

All icons: `viewBox="0 0 24 24" fill="none" stroke="currentColor"
stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`.
Render at 17–22px (nav icons may use stroke-width 2).

```html
<!-- arrow -->
<line x1="5" y1="12" x2="19" y2="12" /><polyline points="14,7 19,12 14,17" />
<!-- chevron -->
<polyline points="9,5 16,12 9,19" />
<!-- check -->
<polyline points="5,12.5 9.5,17 19,7" />
<!-- close -->
<line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
<!-- plus -->
<line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
<!-- camera -->
<rect x="3" y="6.5" width="18" height="13" rx="3" />
<path d="M8 6.5 9.4 4.5h5.2L16 6.5" /><circle cx="12" cy="13" r="3.5" />
<!-- court -->
<rect x="3" y="3.5" width="18" height="17" rx="2" />
<line x1="12" y1="3.5" x2="12" y2="20.5" />
<line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" />
<!-- upload -->
<path d="M12 15V4M8 8l4-4 4 4" />
<path d="M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13" />
<!-- library -->
<rect x="4" y="3.5" width="16" height="17" rx="2.5" />
<line x1="8" y1="8" x2="16" y2="8" /><line x1="8" y1="12" x2="16" y2="12" />
<line x1="8" y1="16" x2="13" y2="16" />
<!-- progress -->
<path d="M4 18.5 9 13l3.5 3 7-9" /><polyline points="15.5,7 19.5,7 19.5,11" />
<!-- home -->
<path d="M3.5 10.5 12 3.8l8.5 6.7" />
<path d="M5.5 9.5v10.2h13V9.5M9.5 19.7v-6h5v6" />
<!-- flame -->
<path
  d="M13.2 2.8c.7 3.5-1.6 4.8-2.7 6.4-.9 1.3-.8 2.7.3 3.7-.1-2.3 1.5-3.4 3-4.4.2 2 2.9 3.6 2.9 6.8 0 3.3-2.2 5.7-5.2 5.7s-5.3-2.3-5.3-5.6c0-4 3.2-6.2 7-12.6Z"
/>
<!-- spark -->
<path d="m12 2 1.5 6.5L20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5Z" />
<!-- shield -->
<path d="M12 3 19 6v5c0 4.6-2.8 8.1-7 10-4.2-1.9-7-5.4-7-10V6Z" />
<!-- lock -->
<rect x="5" y="10" width="14" height="11" rx="2.5" />
<path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
<!-- crown -->
<path d="m4 8 4 3 4-6 4 6 4-3-1.5 10h-13Z" />
<line x1="6" y1="21" x2="18" y2="21" />
<!-- play -->
<path d="m9 7 8 5-8 5Z" />
<!-- person -->
<circle cx="12" cy="8" r="3.5" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
<!-- bookmark -->
<path d="M6 3.5h12v17L12 17l-6 3.5Z" />
<!-- bell -->
<path
  d="M18 16H6c1.1-1.3 1.7-2.4 1.7-4.6V9.6A4.3 4.3 0 0 1 12 5.3a4.3 4.3 0 0 1 4.3 4.3v1.8c0 2.2.6 3.3 1.7 4.6Z"
/>
<path d="M12 5.3V3.5" /><path d="M10 19a2 2 0 0 0 4 0" />
```

# APPENDIX B — Hero court illustration (exact SVG)

A pickleball court drawn in thin dark-green lines with a dashed volt ball
trajectory. Place inside the hero's `--ink-elevated` card.

```html
<svg viewBox="0 0 340 300" width="100%" height="100%" fill="none">
  <path d="M35 42h270v216H35z" stroke="#21382E" stroke-width="1.5" />
  <line x1="170" y1="42" x2="170" y2="258" stroke="#21382E" stroke-width="1.5" />
  <line x1="35" y1="120" x2="305" y2="120" stroke="#21382E" stroke-width="1.5" />
  <line x1="35" y1="180" x2="305" y2="180" stroke="#21382E" stroke-width="1.5" />
  <path
    d="M84 221c35-72 80-87 147-109"
    stroke="#D7FA45"
    stroke-width="2.5"
    stroke-dasharray="4 7"
    stroke-linecap="round"
  />
  <circle cx="84" cy="221" r="8" fill="#D7FA45" />
  <circle cx="231" cy="112" r="5" fill="#F8FAF5" />
</svg>
```
