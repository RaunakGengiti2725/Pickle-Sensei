# PROMPT — Build the Pickle Sensei marketing website

Copy everything below this line into the AI code editor.

---

You are building the official marketing website for **Pickle Sensei**, an iOS
pickleball technique-coaching app. The site must reproduce the app's design
system **exactly** — every color, font, radius, shadow, and line of copy in
this prompt comes from the app's real source code. Treat this document as the
single source of truth. Do not substitute your own palette, fonts, icon
library, or copywriting style.

## 0. Non-negotiables (read first)

1. Use ONLY the design tokens defined below. Never invent a hex value,
   shadow, or radius. If something isn't specified, derive it from the
   nearest token.
2. **Do not fabricate marketing claims.** No invented testimonials, user
   counts, star ratings, press logos, or "trusted by" numbers. The brand
   voice is honest and verifiable. Only use the copy provided here.
3. No emoji anywhere. No third-party icon libraries (no Lucide, Heroicons,
   Font Awesome). Use ONLY the custom SVG icons in Appendix A.
4. No pure black `#000` and no neutral grays — every neutral in this system
   is green-tinted.
5. Headings are Manrope **SemiBold (600)** with tight negative tracking —
   never Bold (700).
6. All numbers (scores, prices, stats) use `font-variant-numeric: tabular-nums`.
7. Where a real URL is unknown (App Store link, social links), use `href="#"`
   with an HTML comment `<!-- TODO: real link -->`. Never invent URLs.
8. Every animation must respect `prefers-reduced-motion: reduce` (render the
   final state instantly).

## 1. Tech setup

- A static marketing site: semantic HTML + modern CSS (vanilla or Tailwind),
  optionally Next.js/Astro if that's your default — but ALL colors/spacing
  must flow from the CSS custom properties in §2 (if using Tailwind, map the
  theme to these variables; never hardcode hex in markup).
- Load Manrope from Google Fonts, weights 400/500/600/700:
  `https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap`
- Mobile-first, responsive at 375 / 768 / 1024 / 1440. Desktop content
  max-width: 1160px, centered. Page gutters: 24px on mobile, 40px ≥1024px.
- Include proper meta tags, OpenGraph tags, and a favicon placeholder.

## 2. Design tokens (paste as-is)

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
  --volt: #d7fa45; /* THE accent — use sparingly, hero moments only */
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

  /* shadows — extremely soft, green-tinted, never gray/black */
  --shadow-soft: 0 8px 24px rgba(8, 18, 14, 0.07); /* cards */
  --shadow-floating: 0 10px 26px rgba(8, 18, 14, 0.14); /* CTA button, popovers */
  --shadow-nav: 0 8px 20px rgba(8, 18, 14, 0.055); /* sticky nav */

  /* gradients */
  --grad-feature: linear-gradient(135deg, #07563e 0%, #06130e 100%);
  --grad-cta: linear-gradient(135deg, #d7fa45 0%, #53d99b 100%);
  --grad-paywall: linear-gradient(180deg, #06130e 0%, #10271e 58%, #07563e 100%);

  /* motion */
  --ease-out: cubic-bezier(0.33, 1, 0.68, 1);
}
```

## 3. Typography (exact scale)

Family: `'Manrope', system-ui, sans-serif` for everything.

| Class        | Weight | Size/Line   | Letter-spacing        | Use                         |
| ------------ | ------ | ----------- | --------------------- | --------------------------- |
| `.hero`      | 600    | 48px / 50px | `-0.046em`            | Hero headline               |
| `.display`   | 600    | 64px / 68px | `-0.039em` + tabular  | Giant numbers               |
| `.score`     | 600    | 44px / 48px | `-0.034em` + tabular  | Score numerals              |
| `.h1`        | 600    | 32px / 36px | `-0.031em`            | Section headlines           |
| `.h2`        | 600    | 21px / 27px | `-0.017em`            | Card titles                 |
| `.h3`        | 600    | 17px / 22px | `-0.009em`            | Sub-titles, row values      |
| `.body`      | 400    | 16px / 23px | 0                     | Body copy                   |
| `.body-bold` | 600    | 16px / 22px | 0                     | Button labels, row titles   |
| `.caption`   | 500    | 13px / 18px | 0                     | Secondary copy              |
| `.micro`     | 600    | 11px / 14px | `+0.082em`, UPPERCASE | Eyebrows, pills, nav labels |
| `.wordmark`  | 600    | 18px / 22px | `-0.028em`            | "Pickle Sensei" lockup text |

On desktop (≥1024px) the hero may scale up to 64–72px and `.h1` to 40px —
keep the same weights and em-based tracking. Missing values render as an em
dash `—`, never "0" or blank.

## 4. Components (exact specs)

### Buttons

Pill shape (`--r-pill`), min-height 56px (compact: 46px), 1px solid border,
padding 0 24px, `.body-bold` label, 8px gap between icon/label/arrow.
**Primary, volt, and dark variants always end with the trailing 18px arrow
icon (Appendix A).**

| Variant   | bg                   | text        | border    |
| --------- | -------------------- | ----------- | --------- |
| primary   | `--court`            | `--on-dark` | `--court` |
| secondary | `--surface-elevated` | `--ink`     | `--line`  |
| ghost     | transparent          | `--ink`     | `--line`  |
| volt      | `--volt`             | `--on-volt` | `--volt`  |
| dark      | `--ink`              | `--on-dark` | `--ink`   |

States: hover `filter: brightness(0.97)`; active `transform: scale(0.975)`
(110ms `--ease-out`); disabled opacity 0.42; always keep a visible focus ring
(2px `--court` offset 2px).

### Cards

White `--surface-elevated`, radius `--r-lg` (26px), padding 24px,
`--shadow-soft`. Tone variants (no shadow): dark = `--ink-elevated`,
court = `--court-deep`, soft = `--surface-alt`.

### Signature dark gradient panel (the flagship pattern)

`background: var(--grad-feature)`, radius 26–34px, padding 24px. Inside:
volt `.micro` eyebrow → `--on-dark` content → hairline dividers in
`--line-muted-dark`. Stat footers are 3 equal columns separated by 1px
`--line-muted-dark` dividers: `.h3` tabular value over `.caption` label in
`--on-dark-faint`.

### Pills / badges

Fully rounded, padding 6px 10px, `.micro` text. Tones: neutral
(`--surface-alt` bg / `--ink-soft` text), good/warn/bad (soft bg + strong
text), volt (`--volt`/`--on-volt`), dark (`--ink-elevated`/`--on-dark`).

### Icon chips

38–46px circles holding a 20–21px icon. On light: `--court-soft` bg +
`--court` icon. On dark: `--on-dark-tint` bg + `--volt` icon.

### Sticky top nav (adapted from the app's tab bar)

White `--surface-elevated`, 1px `--line` bottom border, `--shadow-nav`,
height 70px. Left: brand lockup (32px mark + 10px gap + wordmark). Center/
right: links in `.micro` style at 13px — inactive `--ink-soft`, active/hover
`--court` inside a `--court-soft` pill (padding 6px 14px). Far right CTA:
pill button with `--grad-cta` background, `--ink` text, wrapped in a 5px
white ring with `--shadow-floating` — this mirrors the app's volt "COACH"
button and is the ONLY gradient button on the site.

### Score ring (build it — this is the app's signature element)

SVG circle, default 154–200px. Track stroke: `--line` (on light) or
`--line-dark` (on dark), width ≈ 6.5% of diameter, round linecaps. Progress
arc: linear gradient `--volt → --mint`, starts at 12 o'clock, fraction =
score/10. Centered number: 600 weight, tabular, font-size = 29% of diameter,
with a `.caption` label under it in `--on-dark-subtle`. On scroll into view:
arc sweeps and number counts up together over 900ms `--ease-out`, once.

### Checkpoint rows (score list)

Row: name `.body-bold` `--ink` (on dark: `--on-dark`) + right-aligned score
`.h3` tabular, colored by band (`--good`/`--warn`/`--bad`). Below: 4px track
(`--surface-alt`, radius 2px) with a band-colored fill. 13px vertical
padding, 1px `--line` bottom border. Fills sweep in from the left
(`transform: scaleX`, transform-origin left, 520ms `--ease-out`) staggered
~90ms apart, once on scroll into view.

### Phone mockup

Where the design calls for app UI, recreate it in HTML/CSS/SVG using these
exact components inside a device frame (`--ink` body, radius 48px, 8px
bezel) — do NOT use screenshots or stock device images.

## 5. Motion rules

- Everything uses `--ease-out`; transform/opacity only.
- Micro-interactions 110–210ms; reveals 520–900ms; nothing loops.
- Scroll reveals: fade + translateY(20px→0) + scale(0.96→1), staggered
  30–90ms per item, each fires once.
- `@media (prefers-reduced-motion: reduce)` disables all of it.

## 6. Page blueprint — single landing page, sections in order

### 6.1 Nav (sticky)

Links: Features · How it works · Score preview · Rank · Pricing. CTA: "Get
the app" (gradient pill, `<!-- TODO: App Store link -->`).

### 6.2 Hero — DARK section (`--surface-dark` background)

- Top-left: brand lockup in light (`--on-dark` tint). Top-right pill:
  `PRIVATE BY DEFAULT` (dark tone pill).
- Headline (`.hero`, `--on-dark`), two lines exactly:
  `See the stroke.` / `Know the fix.`
- Tagline (`.body`, `--on-dark-muted`, max-width 340px):
  `A private technique coach that guides each capture and turns validated
reads into one clear next step.`
- CTA: volt button `Start your first read` (trailing arrow).
- Fine print below (`.caption`, `--on-dark-faint`, centered under CTA):
  `Two successful validated ratings free · Unscored attempts don't count`
- Right side (or below on mobile): the **court illustration card** —
  `--ink-elevated` panel, radius 34px, containing the exact SVG from
  Appendix B (court lines + dashed volt trajectory), overlaid top-left with:
  `.micro` `POSE-GUIDED` in `--volt`, then `.h1` `--on-dark`
  `Automatic capture.`, then `.caption` `--on-dark-muted`
  `No shot picker. No timer.` Bottom-right floating pill
  (`rgba(7,17,14,0.82)` bg): a small rotated-square volt outline dot +
  `.micro` `ON-DEVICE` in `--on-dark`.

### 6.3 Features — LIGHT section (`--surface` background)

Eyebrow `.micro` `--court`: `TWO WAYS TO TRAIN`. Headline `.h1`:
`Ready when you are.`
Two large mode cards side by side (min-height 240px, radius 26px):

1. **Dark gradient card** (`--grad-feature`): volt camera icon in
   `--on-dark-tint` chip, arrow top-right; title `.h2` `--on-dark`
   `Stroke Analysis`; caption `--on-dark-subtle`
   `One movement, deep feedback`.
2. **White card** (1px `--line` border): court icon in `--court-soft` chip;
   title `.h2` `--ink` `Session Analysis`; caption `--ink-soft`
   `Rallies, stroke by stroke`.
   Below, a row of four smaller white cards (radius 18px) reusing the app's
   coach menu, each with a 46px colored icon circle:

- Auto Analyze (volt circle, camera icon) — `Auto capture · validated scores only`
- Live Court (mint circle, court icon) — `Checks camera + model availability`
- Import Video (flame circle, upload icon) — `Choose a real clip from this phone`
- Drill Library (court-soft circle, library icon) — `Guided drills you can search`

### 6.4 How it works — LIGHT

Eyebrow: `HOW IT WORKS`. Three steps, each with a 40px volt circle holding
`.micro` `--on-volt` numbers `01 / 02 / 03`:

1. `Set the phone once.` — `Pickle Sensei guides the rest.`
2. `Play your shot.` — `Pose-guided automatic capture. No shot picker. No timer.`
3. `Get one clear next step.` — `Validated reads only — unscored attempts never count against you.`

### 6.5 Score preview — DARK gradient section (`--grad-feature`)

Eyebrow `.micro` `--volt`: `THE READ`. Headline `.h1` `--on-dark`:
`Your technique, scored honestly.`
Recreate a results panel: score ring (e.g. 7.8) + label `Technique score`,
next to checkpoint rows such as `Paddle preparation 82`, `Contact point 74`,
`Follow-through 61`, `Recovery stance 47` (green/green/yellow/red bands).
Footer stat row: `12 reads · 4 active days · 6 day streak` style columns.
Add caption `--on-dark-subtle`: `Scores appear only after validated analysis.`

### 6.6 Player rank — LIGHT

Eyebrow: `PLAYER RANK`. Headline: `Climb from Bronze to Diamond.`
Body: `Every validated read builds your per-technique scores. Your rating is
the honest average — no shortcuts.`
Five emblem cards in a row using the exact tier colors (accent stroke on
deep fill, tint background wash):
Bronze `#D08A4E`/`#3D2415`/tint `rgba(208,138,78,0.16)` · Silver
`#C3CFD6`/`#2E373D` · Gold `#E8C25C`/`#3F3110` · Platinum
`#8FE6D9`/`#0F3B34` · Diamond `#9CC8FF`/`#14304A`. Emblem shapes escalate:
round medal → hex badge → star shield → pointed crest → cut gem (simple SVG
silhouettes, 2.2px strokes, are fine). Tier name under each in `.micro`.

### 6.7 Privacy — LIGHT, soft card (`--surface-alt`, radius 34px)

Shield icon in a `--court-soft` circle. Headline `.h2`:
`Private by default.` Body: `Analysis runs on your device. Your videos stay
yours. Reminders are opt-in and never include names or scores.`
Three pills: `ON-DEVICE` · `OPT-IN REMINDERS` · `NO ACCOUNT REQUIRED TO TRY`.

### 6.8 Pricing — LIGHT

Eyebrow: `PRICING`. Headline: `Start free. Go Pro when it clicks.`

- Free card (white): `Two successful validated ratings free` + caption
  `Unscored attempts don't count`.
- Pro card (dark gradient, volt `MOST POPULAR` pill): **Pickle Sensei Pro** —
  `$7.99/mo` · `$59.99/yr` · `$159.99 lifetime`, checklist (check icons in
  `--volt`): unlimited validated reads, Live Court sessions, full drill
  library, player rank.
  `<!-- TODO: verify prices against the live App Store listing before publishing -->`
  CTA under both: volt button `Start your first read`.

### 6.9 Final CTA — DARK (`--surface-dark`)

Headline `.hero` (two lines): `Your court is ready.` /
`The first read starts here.`
Volt CTA `Get Pickle Sensei` + the same fine-print line as the hero.

### 6.10 Footer

`--surface-dark`, hairline `--line-dark` top border. Brand lockup (light),
`.caption` `--on-dark-faint` copy: `© 2026 Pickle Sensei · Private by
default`, links (Privacy Policy, Terms, Support — `href="#"` TODO).

## 7. Voice rules (apply to any copy you must add)

- Sentence case headlines that end with a period; often two short beats.
- Eyebrows/labels: UPPERCASE `.micro` with wide tracking.
- Middle-dot `·` separators in fine print.
- An analysis is a **"read"**; the app surface is **"your court"**.
- Qualify claims: "validated", "verified", "on-device". Never hype, never
  invent numbers.

## 8. Acceptance checklist — verify before you finish

- [ ] Page background is `#F7F6F0` (not white); dark sections `#06130E` (not black).
- [ ] Every hex on the page appears in §2. No stray colors.
- [ ] Manrope loads with weights 400/500/600/700; headings are 600, tracking negative.
- [ ] All numbers use tabular numerals.
- [ ] Buttons: pill, 56px, trailing arrow on primary/volt/dark variants.
- [ ] Only Appendix A icons used; stroke 1.8, round caps, no fills.
- [ ] Score ring + checkpoint fills animate once on scroll, 900/520ms ease-out.
- [ ] `prefers-reduced-motion` renders everything static.
- [ ] No fabricated testimonials/stats/press logos anywhere.
- [ ] Responsive at 375/768/1024/1440 with no horizontal scroll.
- [ ] Text contrast ≥ 4.5:1 (the token pairs above already pass — don't lighten them).
- [ ] Focus rings visible on all interactive elements; hit areas ≥ 44px.
- [ ] TODO comments mark every placeholder link/price.

## Appendix A — Icon set (exact SVGs, use verbatim)

All icons: `viewBox="0 0 24 24" fill="none" stroke="currentColor"
stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`.
Render at 17–22px. (Nav icons may use stroke-width 2.)

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
<!-- bell -->
<path
  d="M18 16H6c1.1-1.3 1.7-2.4 1.7-4.6V9.6A4.3 4.3 0 0 1 12 5.3a4.3 4.3 0 0 1 4.3 4.3v1.8c0 2.2.6 3.3 1.7 4.6Z"
/>
<path d="M12 5.3V3.5" /><path d="M10 19a2 2 0 0 0 4 0" />
```

## Appendix B — Hero court illustration (exact SVG)

Place inside the `--ink-elevated` hero card. Colors: court lines
`var(--line-dark)`, trajectory + start dot `var(--volt)`, end dot
`var(--on-dark)`.

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

## Appendix C — Brand mark

The logo is a black-ink silhouette of a pickleball player (headband, paddle
raised, ready stance). The image file `pickle-mark@3x.png` will be provided
in the project — render it at 32px, tinted `--ink` on light backgrounds and
`--on-dark` on dark, next to the wordmark "Pickle Sensei" (18px / 600 /
−0.028em, 10px gap). If the file is missing, leave an `<img>` placeholder
with `alt="Pickle Sensei"` — do NOT generate or substitute a different logo.
