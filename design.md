# Pickle Sensei — Design System

The exact design language of the Pickle Sensei mobile app, documented so a
website can replicate it 1:1. Everything below is extracted from the real
source of truth:

- Tokens: `apps/mobile/src/design/tokens.ts`
- Components: `apps/mobile/src/design/components.tsx`
- Icons: `apps/mobile/src/design/icons.tsx`
- Tab bar / FAB: `apps/mobile/src/navigation/PremiumTabBar.tsx`
- Rank emblems: `apps/mobile/src/components/RankIcon.tsx`
- Brand assets: `apps/mobile/assets/brand/` · Fonts: `apps/mobile/assets/fonts/`

---

## 1. Brand personality

**"A private technique coach."** Calm, premium, honest, equipment-adjacent.
The palette reads like real gear: **court green**, **graphite/ink**, **warm
chalk** surfaces, and exactly one loud accent — the **optic-ball volt**.

Principles that show up everywhere:

1. **One accent.** Volt (`#D7FA45`) is reserved for the most important thing
   on screen (score arcs, the COACH button, key CTAs, eyebrow labels on dark).
   Never use it for large fills of body content.
2. **Warm light, deep dark.** The light theme is warm chalk (`#F7F6F0`), not
   pure white. Dark surfaces are green-tinted near-black (`#06130E`), not gray.
3. **Semantic tokens only.** Screens never invent hex values; every color maps
   to a named token.
4. **Numbers are the hero.** Scores render huge, tight, semibold, and always
   with tabular numerals.
5. **Quiet chrome.** Hairline borders, very soft shadows, generous radii.
   Nothing skeuomorphic, nothing glassy.

---

## 2. Color tokens

### Core palette

| Token | Value | Usage |
|---|---|---|
| `ink` | `#071710` | Primary text on light, dark buttons |
| `inkElevated` | `#10271E` | Elevated dark cards, dark icon buttons |
| `inkSoft` | `#627168` | Secondary/muted text on light, inactive icons |
| `graphite` | `#1A2D25` | Deep neutral (rarely used directly) |
| `surface` | `#F7F6F0` | App background (light) — warm chalk |
| `surfaceElevated` | `#FFFFFF` | Cards, buttons, tab bar |
| `surfaceAlt` | `#EBEFE8` | Soft cards, track backgrounds, neutral pills |
| `surfaceDark` | `#06130E` | App background (dark screens), dark card bases |
| `line` | `#DCE3DC` | Hairline borders/dividers on light |
| `lineDark` | `#21382E` | Hairline borders/dividers on dark |
| `lineStrongDark` | `#4A5550` | Stronger borders on dark |
| `lineMutedDark` | `#31433B` | Muted dividers inside dark cards |

### Brand + accents

| Token | Value | Usage |
|---|---|---|
| `court` | `#087956` | Primary brand green — primary buttons, active tab, links |
| `courtDeep` | `#07563E` | Deep green — gradient starts, court-tone cards, paywall |
| `courtSoft` | `#D8EEE4` | Soft green chips, active-tab pill, icon chips on light |
| `volt` | `#D7FA45` | THE accent — optic ball. Score arcs, COACH FAB, volt CTAs |
| `voltSoft` | `#EFFBC4` | Soft volt tint |
| `mint` | `#53D99B` | Secondary accent, gradient partner of volt |
| `flame` | `#FF9B42` | Streak flame, tertiary accent |
| `onVolt` | `#142014` | Text/icons on volt backgrounds |

### Status (score bands)

Score bands are never color-only — always paired with the number.

| Token | Value | Soft pair | Usage |
|---|---|---|---|
| `good` | `#137A50` | `goodSoft` `#DCEFE4` | Green band (good technique) |
| `warn` | `#A86416` | `warnSoft` `#F6E8CE` | Yellow band (needs work) |
| `bad` | `#A63D36` | `badSoft` `#F4DEDB` | Red band (fix this) |
| unscored | `inkSoft` `#627168` | — | No score yet |

### Text on dark

| Token | Value | Usage |
|---|---|---|
| `onDark` | `#F8FAF5` | Primary text on dark |
| `onDarkMuted` | `#A5B1AA` | Secondary text on dark |
| `onDarkSubtle` | `#93A39B` | Captions on dark |
| `onDarkFaint` | `#819087` | Faintest labels on dark |
| `onDarkDisabled` | `#66736D` | Disabled on dark |

### Overlays & tints

| Token | Value | Usage |
|---|---|---|
| `overlayStrong` | `rgba(4,10,8,0.68)` | Modal backdrop |
| `overlayDeep` | `rgba(7,17,14,0.9)` | Deepest scrim |
| `overlayDark` | `rgba(7,17,14,0.84)` | Dark overlay panels |
| `overlayDarkSoft` | `rgba(7,17,14,0.82)` | Floating pills over imagery |
| `inkTint` | `rgba(11,23,19,0.09)` | Subtle ink tint chip on light |
| `onDarkTint` | `rgba(255,255,255,0.1)` | Subtle white tint chip on dark |
| `shadow` | `#08120E` | Shadow color (green-tinted, never pure black) |

### Rank tier emblems (video-game style)

Each tier has `accent` (stroke), `deep` (fill), `glint` (highlight),
`tint` (background wash at ~16% alpha):

| Tier | accent | deep | glint | tint |
|---|---|---|---|---|
| Bronze | `#D08A4E` | `#3D2415` | `#F2B984` | `rgba(208,138,78,0.16)` |
| Silver | `#C3CFD6` | `#2E373D` | `#E8F1F5` | `rgba(195,207,214,0.16)` |
| Gold | `#E8C25C` | `#3F3110` | `#F7E3A1` | `rgba(232,194,92,0.16)` |
| Platinum | `#8FE6D9` | `#0F3B34` | `#D3FFF6` | `rgba(143,230,217,0.16)` |
| Diamond | `#9CC8FF` | `#14304A` | `#DCEDFF` | `rgba(156,200,255,0.18)` |
| Unranked | `#819087` | `rgba(255,255,255,0.08)` | — | — |

Emblem silhouettes escalate: medal → hex badge → star shield → crest → cut gem.

### CSS custom properties (drop-in)

```css
:root {
  --ink: #071710;            --ink-elevated: #10271E;
  --ink-soft: #627168;       --graphite: #1A2D25;
  --surface: #F7F6F0;        --surface-elevated: #FFFFFF;
  --surface-alt: #EBEFE8;    --surface-dark: #06130E;
  --line: #DCE3DC;           --line-dark: #21382E;
  --line-strong-dark: #4A5550; --line-muted-dark: #31433B;
  --court: #087956;          --court-deep: #07563E;
  --court-soft: #D8EEE4;     --volt: #D7FA45;
  --volt-soft: #EFFBC4;      --mint: #53D99B;
  --flame: #FF9B42;          --on-volt: #142014;
  --good: #137A50;           --good-soft: #DCEFE4;
  --warn: #A86416;           --warn-soft: #F6E8CE;
  --bad: #A63D36;            --bad-soft: #F4DEDB;
  --on-dark: #F8FAF5;        --on-dark-muted: #A5B1AA;
  --on-dark-subtle: #93A39B; --on-dark-faint: #819087;
  --overlay-strong: rgba(4,10,8,0.68);
  --ink-tint: rgba(11,23,19,0.09);
  --on-dark-tint: rgba(255,255,255,0.10);
  --shadow-color: #08120E;
}
```

---

## 3. Typography

**Single family: Manrope** (available on Google Fonts). Weights loaded:
400 Regular, 500 Medium, 600 SemiBold, 700 Bold. Headings use **SemiBold
(600)** — never Bold — with tight negative tracking. All numbers use
**tabular numerals** (`font-variant-numeric: tabular-nums`).

### Type scale

| Style | Weight | Size / Line | Tracking (px → em) | Use |
|---|---|---|---|---|
| `hero` | 600 | 48 / 50 | −2.2px → `-0.046em` | Welcome hero ("See the stroke.") |
| `display` | 600 | 64 / 68 | −2.5px → `-0.039em` | Giant stat numbers, ring score |
| `score` | 600 | 44 / 48 | −1.5px → `-0.034em` | Score numerals in cards |
| `h1` | 600 | 32 / 36 | −1px → `-0.031em` | Screen greetings/titles |
| `h2` | 600 | 21 / 27 | −0.35px → `-0.017em` | Card titles, empty-state titles |
| `h3` | 600 | 17 / 22 | −0.15px → `-0.009em` | Section titles, row values |
| `body` | 400 | 16 / 23 | 0 | Body copy |
| `bodyBold` | 600 | 16 / 22 | 0 | Button labels, row titles |
| `caption` | 500 | 13 / 18 | 0 | Secondary copy, sublabels |
| `micro` | 600 | 11 / 14 | +0.9px → `+0.082em`, UPPERCASE | Eyebrows, pills, tab labels |
| wordmark | 600 | 18 / 22 | −0.5px → `-0.028em` | "Pickle Sensei" next to mark |

```css
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap');
body { font-family: 'Manrope', system-ui, sans-serif; font-size: 16px;
       line-height: 1.44; color: var(--ink); background: var(--surface); }
.display, .score, [data-numeric] { font-variant-numeric: tabular-nums; }
.micro { font-size: 11px; line-height: 14px; font-weight: 600;
         letter-spacing: 0.082em; text-transform: uppercase; }
```

Rules:
- Eyebrow labels (`micro`) are ALWAYS uppercase with wide tracking, e.g.
  `THIS WEEK`, `ON-DEVICE`, `POSE-GUIDED`, `SELF SET`, `COACH`.
- Big numbers can scale beyond the scale (e.g. 64px count, ring number =
  29% of ring diameter) but keep the `display` tracking and 600 weight.
- Missing values render as an em dash `—`, never `0` or blank.

---

## 4. Spacing, radius, elevation

### Spacing scale (px)

`xxs 2 · xs 4 · sm 8 · md 16 · lg 24 · xl 32 · xxl 48 · xxxl 64`

- Screen gutter: **24px** (`lg`) on mobile.
- Section titles: `margin-top: 32px; margin-bottom: 16px`.
- Card padding: **24px**. Compact rows: 16px horizontal.
- Odd fine-tuning values (7, 9, 10, 13px gaps) appear inside dense rows —
  they're intentional optical tweaks, keep them.

### Border radius (px)

`xs 8 · sm 12 · md 18 · lg 26 · xl 34 · pill 999`

- Cards: `lg` (26). Feature/hero cards: `xl` (34). List rows: `md` (18).
- Buttons, pills, chips, icon buttons: fully rounded (`pill`).

### Shadows (green-tinted, extremely soft)

| Token | CSS equivalent |
|---|---|
| `soft` (cards) | `box-shadow: 0 8px 24px rgba(8,18,14,0.07)` |
| `floating` (FAB, popovers) | `box-shadow: 0 10px 26px rgba(8,18,14,0.14)` |
| tab bar (upward) | `box-shadow: 0 -8px 20px rgba(8,18,14,0.055)` |

Dark/court/soft-tone cards drop the shadow entirely (flat on dark).

### Borders

Hairline everywhere: `1px solid var(--line)` on light,
`1px solid var(--line-dark)` on dark. Dividers inside dark cards use
`--line-muted-dark`.

---

## 5. Iconography

**Custom hand-drawn stroke icons** — do not swap in an icon font.

- Grid: `24 × 24` viewBox, rendered at 17–22px typically.
- Style: `fill: none`, `stroke-width: 1.8` (2 for tab icons, 2.25 for the
  FAB plus), `stroke-linecap: round`, `stroke-linejoin: round`.
- Default stroke color `#0B1713`; tinted via the semantic tokens.
- Set: home, library, progress, settings, plus, camera, upload, court,
  arrow, chevron, back, close, check, pause, play, lock, person, volume,
  shield, flame, bookmark, crown, spark, bell.
- Copy the exact paths from `apps/mobile/src/design/icons.tsx` — they're
  plain SVG and paste directly into web SVG.

**Brand mark**: black-ink silhouette of a pickleball player (headband, paddle
up, ready stance) — `apps/mobile/assets/brand/pickle-mark@3x.png`, tintable
(rendered in `ink` on light, `onDark` on dark). Lockup = 32px mark + 10px gap
+ "Pickle Sensei" wordmark (18px / 600 / −0.5px).

---

## 6. Components

### Button

Pill-shaped, 56px min-height (46px compact), 1px border, 24px horizontal
padding, `bodyBold` label, 8px gap between icon/label.
**Primary, volt, and dark variants always append a trailing arrow icon (18px).**

| Variant | Background | Text | Border |
|---|---|---|---|
| `primary` | `court` | `onDark` | `court` |
| `secondary` | `surfaceElevated` | `ink` | `line` |
| `ghost` | transparent | `ink` | `line` |
| `danger` | `badSoft` | `bad` | `badSoft` |
| `volt` | `volt` | `onVolt` | `volt` |
| `dark` | `ink` | `onDark` | `ink` |

States: pressed → opacity 0.92 + scale 0.975; disabled → opacity 0.42.
Web: use `:active { transform: scale(0.975); }` and a subtle hover
(e.g. `filter: brightness(0.97)`); keep visible focus rings.

### Card

White (`surfaceElevated`), radius 26, padding 24, `soft` shadow.
Tones: `dark` = `inkElevated` (no shadow) · `court` = `courtDeep` (no shadow)
· `soft` = `surfaceAlt` (no shadow).

### Signature dark gradient card (the hero pattern)

Feature cards (practice week, rank banner, mode cards, progress hero) use a
**diagonal deep-green gradient**: `courtDeep → surfaceDark`
(`linear-gradient(135deg, #07563E 0%, #06130E 100%)`), radius 26–34,
volt `micro` eyebrow, `onDark` content, dividers in `lineMutedDark`.
The paywall uses `surfaceDark → inkElevated (58%) → courtDeep`.

### Pill / badge

Fully rounded, `10px × 6px` padding, `micro` uppercase text.
Tones: neutral (`surfaceAlt`/`inkSoft`), good, warn, bad (soft bg + strong
fg), volt (`volt`/`onVolt`), dark (`inkElevated`/`onDark`).

### Icon button

44 × 44 circle, `surfaceElevated` bg, hairline `line` border (dark:
`inkElevated` + `lineDark`), 20px icon.

### Screen header

52px min-height row: 44px action slot (back/close icon button) · centered
eyebrow (`micro`, `inkSoft`) over title (`h3`) · 44px right slot.

### Score ring (signature element)

- Default 154px; stroke = max(8, 6.5% of size), rounded caps.
- Track: `line` (light) / `lineDark` (dark). Progress arc: **gradient
  `volt → accent`** (accent defaults to volt), starting at 12 o'clock.
- Score number centered: 600 weight, size = 29% of diameter, tabular.
- Fraction = score / 10. Arc sweeps in over **900ms ease-out-cubic** while
  the number counts up on the same easing; both land together.

### Checkpoint row (score list)

Row: name (`bodyBold`, ink) + right-aligned score (`h3`, tinted by band,
tabular). Below: 4px track (`surfaceAlt`, radius 2) with band-colored fill.
13px vertical padding, hairline bottom border. Fill sweeps in from the left
(scaleX, 520ms ease-out-cubic) with staggered delays.

### Trend chart

Pure SVG polyline: 3px rounded stroke in `court` (light) or `volt` (dark),
under-filled with a vertical gradient of the line color at 20% → 0% opacity.
Empty state is a caption: "Your trend appears after two scored reps."

### Stat

Big value (`score` type, `ink`/`onDark`, accent option `court`/`volt`) over a
`caption` label in `inkSoft`/`onDarkSubtle`.

### Empty / error / loading states

Centered column: 54px circular glyph (`courtSoft` bg + 24px `court` spark
icon; error: `badSoft` + `bad` close icon) → `h2` title → `body` copy
(`inkSoft`, max-width 300–310px) → optional action. Loading: 52px hairline
ring around a small spinner (`court` light / `volt` dark).

### List row (recent reads)

76px min-height white row, radius 18, 16px horizontal padding, 9px gap below:
38px uppercase date column (`micro`, `inkSoft`) · title (`bodyBold`,
capitalize) + time (`caption`) · score (25px `score` type) · 17px chevron.

### Streak badge

32px-tall pill: white bg, hairline border, flame icon in `flame` + tabular
count.

### Bottom navigation (→ website header/nav)

- White bar, hairline top border, subtle upward shadow, 70px tall.
- 5 slots: Home, Library, **COACH** (center), Progress, Settings.
- Active tab: icon inside a 32×28 `courtSoft` pill, tint `court`;
  inactive tint `inkSoft`. Labels are `micro` at 11px.
- **COACH FAB**: 68px circle, `volt → mint` diagonal gradient
  (`linear-gradient(135deg, #D7FA45, #53D99B)`), plus icon in `ink`, wrapped
  in a 5px white ring with `floating` shadow, raised 24px above the bar.
  Opening rotates the plus 45° and fades in an `overlayStrong` backdrop;
  action rows (68px white cards, radius 26, 46px colored icon circles in
  volt/mint/flame/courtSoft) stagger upward.

---

## 7. Motion

All motion is **ease-out-cubic** (`cubic-bezier(0.33, 1, 0.68, 1)`),
transform/opacity-only, and every animation has a reduced-motion fallback
that renders the final state instantly.

| Interaction | Spec |
|---|---|
| Press in / out | scale → 0.975 in 110ms / back in 150ms; pressed opacity 0.92 |
| Score ring reveal | 900ms arc sweep + synchronized number count-up, once on mount |
| Bar fill reveal | scaleX 0 → 1 from left, 520ms, staggered per row |
| Menu / backdrop | 210ms fade + rise; rows stagger (translateY 20+7i → 0, scale 0.96 → 1) |
| FAB toggle | rotate 0 → 45°, scale 1 → 1.04 |

Web equivalents:

```css
:root { --ease-out: cubic-bezier(0.33, 1, 0.68, 1); }
.pressable:active { transform: scale(0.975); transition: transform 110ms var(--ease-out); }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
```

Reveal animations happen **once** (the "score-reveal moment"), never loop.

---

## 8. Voice & copy

- **Sentence case headlines that end with a period.** Often split into two
  short beats: "See the stroke. / Know the fix." · "Ready when you are."
  · "Your court is ready."
- **Eyebrows are uppercase micro labels**: `POSE-GUIDED`, `THIS WEEK`,
  `ON-DEVICE`, `PRIVATE BY DEFAULT`.
- **Middle-dot separators** in fine print: "Two successful validated ratings
  free · Unscored attempts don't count".
- Vocabulary: an analysis is a **"read"**; the home surface is **"your
  court"**; the FAB is the **"Coach"**.
- Honest and privacy-forward: never claim unverified facts; qualify with
  "validated", "verified", "on-device". Errors state cause + recovery
  ("Your court couldn't load" + retry).
- Empty states are encouraging, never guilt-y: "Your first read starts here."

---

## 9. Page anatomy (reference layouts)

### Light page (Home pattern)

`surface` background · 24px gutters · top row: brand lockup left, pills right
(skill pill + streak badge) · `h1` greeting (margin-top 32) · two mode cards
side-by-side (min-height 148, radius 26; primary = dark gradient with volt
icon chip, secondary = white with hairline border and `courtSoft` icon chip)
· full-width dark gradient stats card (radius 34) · `SectionTitle` + soft
cards / list rows. Bottom padding ≈ 92px to clear the nav.

### Dark page (Welcome/marketing pattern)

`surfaceDark` background · brand lockup (light) + dark pill top row ·
`hero` headline in `onDark` + `body` tagline in `onDarkMuted` (max-width 340)
· illustration card: `inkElevated`, radius 34, containing a line-drawn court
(1.5px `lineDark` strokes) with a **dashed volt trajectory**
(`stroke-dasharray: 4 7`, round caps) and volt/onDark dots · volt button ·
faint centered caption.

This is the strongest template for a landing page hero.

### Web adaptation notes

- Keep the mobile gutters (24px) below 768px; on desktop, center content in a
  max-width container (~1100–1200px) and let cards sit on the `surface`
  chalk background with the same radii/shadows.
- The bottom tab bar becomes a top nav: same white bar, hairline bottom
  border, `court` active state with `courtSoft` pill highlight, and the
  volt-gradient COACH button as the nav CTA.
- Buttons/pills/rows keep 44px+ hit areas; add hover states (brightness or
  2% tint shift) since mobile has none, and always keep focus rings.
- Contrast pairs already pass AA: `ink` on `surface`, `onDark` on
  `surfaceDark`/`courtDeep`, `onVolt` on `volt`, band colors on their soft
  pairs. Don't lighten them.

---

## 10. Do / Don't

**Do**
- Use volt sparingly, on dark, for the single most important element.
- Round everything: pills for interactive, 18–34px for containers.
- Show scores as `X.X` with tabular numerals; use `—` when absent.
- Pair every band color with its number or label (never color-only).
- Keep shadows barely-there and green-tinted.

**Don't**
- No pure black (`#000`) or pure gray neutrals — everything is green-tinted.
- No bold (700) headings — the look is SemiBold + tight tracking.
- No emoji as icons; only the custom 1.8px stroke set.
- No decorative/looping animation; motion only marks cause → effect.
- No hype copy ("world's best") — claims stay verifiable and calm.
