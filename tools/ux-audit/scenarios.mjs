/**
 * Deterministic scenario matrix for the pre-auth screen audit. Every case is
 * fully described by (scenario id, device id, scale id) — those three strings
 * are the "seed" recorded next to every finding, and `run.mjs --only <caseId>`
 * replays exactly one cell.
 *
 * The long strings are the harness's i18n stress inputs. The product ships
 * English-only copy (`CFBundleDevelopmentRegion` en, no localization tables),
 * so the only user-controlled text that reaches these four screens is the
 * onboarding first name (maxLength 40) and the auth error message surfaced
 * by SignInScreen. Those are the two injection points exercised below.
 */

/** iOS Dynamic Type body sizes (17pt base) → `PixelRatio.getFontScale()`. */
export const SCALES = [
  { id: "L", fontScale: 1, note: "default (Large, body 17pt)" },
  { id: "XXL", fontScale: 21 / 17, note: "XXL (body 21pt)" },
  { id: "XXXL", fontScale: 23 / 17, note: "XXXL (body 23pt)" },
  // Extras beyond the brief; reported separately as informational.
  { id: "AX1", fontScale: 28 / 17, note: "Accessibility 1 (body 28pt)", extra: true },
  { id: "AX5", fontScale: 53 / 17, note: "Accessibility 5 (body 53pt)", extra: true },
];

/**
 * Viewport widths. The deployment target is iOS 15.1 (project.pbxproj), so
 * 320pt devices (iPhone SE 1st gen / 6s / 7, iOS 15.x) are in the supported
 * device set; 375 covers SE 2/3 + Display Zoom on every notch phone; 430 is
 * the widest current iPhone. 393 is an extra mid-size sanity cell.
 */
export const DEVICES = [
  {
    id: "w320",
    width: 320,
    height: 568,
    insets: { top: 20, right: 0, bottom: 0, left: 0 },
    note: "iPhone SE (1st gen) — 320x568, status bar 20",
  },
  {
    id: "w375",
    width: 375,
    height: 667,
    insets: { top: 20, right: 0, bottom: 0, left: 0 },
    note: "iPhone SE (2nd/3rd gen) — 375x667, status bar 20",
  },
  {
    id: "w430",
    width: 430,
    height: 932,
    insets: { top: 59, right: 0, bottom: 34, left: 0 },
    note: "iPhone 15 Pro Max — 430x932, notch 59 / home indicator 34",
  },
  {
    id: "w393",
    width: 393,
    height: 852,
    insets: { top: 59, right: 0, bottom: 34, left: 0 },
    note: "iPhone 15 — 393x852 (extra cell)",
    extra: true,
  },
];

/** Long-string corpus (all ≤ 40 code points so TextInput maxLength keeps them). */
export const LONG_STRINGS = {
  // 40 chars, single German compound — no break opportunity.
  german40: "Donaudampfschifffahrtsgesellschaftskapit",
  // 40 CJK ideographs — every glyph is a break opportunity but full-width.
  cjk40: "匹克球教练匹克球教练匹克球教练匹克球教练匹克球教练匹克球教练匹克球教练匹克球教练",
  // 40 chars Arabic (RTL), spaces present.
  arabic40: "محمد عبد الرحمن بن عبد العزيز آل سعود ال",
  // 40 chars Cyrillic, no spaces — a single unbreakable token.
  cyrillic40: "Александровнаконстантинопольскаяпетровна",
  // 40 chars Latin with no break opportunity (control for the compound case).
  latin40: "Abcdefghijklmnopqrstuvwxyzabcdefghijklmn",
  // Long auth error messages (sanitized server text can be arbitrary length).
  errorCyrillic:
    "Не удалось завершить вход через выбранного поставщика удостоверений, потому что сервер вернул неожиданный ответ. Попробуйте ещё раз через несколько минут.",
  errorGerman:
    "Authentifizierungsdienstkonfigurationsfehler: Die Anmeldeinformationsüberprüfungsinfrastruktur ist vorübergehend nicht erreichbar.",
  errorCjk:
    "登录失败：身份验证服务器返回了意外的响应。请检查您的网络连接，然后在几分钟后重试。如果问题仍然存在，请联系支持团队。",
  errorArabic:
    "تعذّر إكمال تسجيل الدخول لأن خادم المصادقة أعاد استجابة غير متوقعة. يرجى التحقق من اتصال الشبكة والمحاولة مرة أخرى بعد بضع دقائق.",
};

const ONB_STEPS = [
  "name",
  "gender",
  "level",
  "handedness",
  "goal",
  "problem",
  "reveal",
  "notifications",
];

const DEFAULT_STORE = {
  app: { onboardingBusy: false, onboardingError: null },
  auth: { busy: false, error: null },
};

/**
 * Each scenario: `render` is the Scenario object passed to window.__ux.render;
 * `drive` is a list of UI actions run through Playwright afterwards.
 * Action shapes:
 *   { type: 'fill', label, value }   — type into the control with aria-label
 *   { type: 'click', label }         — click control with aria-label
 *   { type: 'clickRole', role, index } — click nth element with role
 *   { type: 'wait', ms }             — real wall-clock wait (timer paths)
 * `expectEvents` (optional): exact list of screen callbacks that must have
 * fired by the end of `drive`; a mismatch is recorded as a P1 violation.
 */
export const SCENARIOS = [];

function add(s) {
  SCENARIOS.push(s);
}

add({
  id: "welcome",
  screen: "welcome",
  render: { screen: "welcome" },
  drive: [],
});

add({
  id: "splash-ready-skip",
  screen: "splash",
  note: "ready=true, video onProgress@1.5s → Skip visible",
  render: { screen: "splash", splash: { ready: true, video: "progress" } },
  drive: [],
});
add({
  id: "splash-skip-press",
  screen: "splash",
  note: "ready=true, press Skip intro → exit fade (520ms) → onFinished",
  render: { screen: "splash", splash: { ready: true, video: "progress" } },
  drive: [
    { type: "click", label: "Skip intro" },
    { type: "wait", ms: 900 },
  ],
  expectEvents: ["splash.onFinished"],
});
add({
  id: "splash-video-error",
  screen: "splash",
  note: "ready=true, video onError → treated as playback over → onFinished (no Skip ever shown)",
  render: { screen: "splash", splash: { ready: true, video: "error" } },
  drive: [{ type: "wait", ms: 900 }],
  expectEvents: ["splash.onFinished"],
});
add({
  id: "splash-not-ready",
  screen: "splash",
  note: "ready=false, video onError → overlay must stay up (hydration not done), no Skip",
  render: { screen: "splash", splash: { ready: false, video: "error" } },
  drive: [{ type: "wait", ms: 900 }],
  expectEvents: [],
});
add({
  id: "splash-stall",
  screen: "splash",
  note: "ready=true, video never reports → WATCHDOG_MS=8000 → onFinished; no Skip",
  render: { screen: "splash", splash: { ready: true, video: "stall" } },
  drive: [{ type: "wait", ms: 8800 }],
  expectEvents: ["splash.onFinished"],
});

add({
  id: "signin-idle",
  screen: "signin",
  render: { screen: "signin" },
  drive: [],
});
add({
  id: "signin-busy",
  screen: "signin",
  render: {
    screen: "signin",
    store: { ...DEFAULT_STORE, auth: { busy: true, error: null } },
  },
  drive: [],
});
for (const [key, code] of [
  ["errorCyrillic", "auth.failed"],
  ["errorGerman", "auth.not_configured"],
  ["errorCjk", "auth.failed"],
  ["errorArabic", "auth.failed"],
]) {
  add({
    id: `signin-error-${key.replace("error", "").toLowerCase()}`,
    screen: "signin",
    note: `auth.error.code=${code}, message=LONG_STRINGS.${key}`,
    render: {
      screen: "signin",
      store: {
        ...DEFAULT_STORE,
        auth: { busy: false, error: { code, message: LONG_STRINGS[key] } },
      },
    },
    drive: [],
  });
}

/** Drive onboarding from step 1 to `stepIndex` (0-based) with `name`. */
function onboardingDrive(stepIndex, name) {
  const actions = [];
  if (stepIndex >= 1) {
    actions.push({ type: "fill", label: "First name", value: name });
    actions.push({ type: "click", label: "Continue" });
  }
  for (let i = 1; i < stepIndex; i += 1) {
    // gender/level/handedness/goal/problem are radio steps; reveal has no
    // choice — Continue only.
    if (ONB_STEPS[i] !== "reveal") {
      actions.push({ type: "clickRole", role: "radio", index: 0 });
    }
    actions.push({ type: "click", label: "Continue" });
  }
  return actions;
}

// Step 1 (name) — empty, then every long-string variant typed in.
add({
  id: "onb-1-name-empty",
  screen: "onboarding",
  render: { screen: "onboarding", onboarding: { mode: "preauth" } },
  drive: [],
});
for (const key of ["german40", "cjk40", "arabic40", "cyrillic40", "latin40"]) {
  add({
    id: `onb-1-name-${key}`,
    screen: "onboarding",
    note: `First name = LONG_STRINGS.${key}`,
    render: { screen: "onboarding", onboarding: { mode: "preauth" } },
    drive: [{ type: "fill", label: "First name", value: LONG_STRINGS[key] }],
  });
}
// Steps 2–6 (radio steps) with a short name.
for (let step = 1; step <= 5; step += 1) {
  add({
    id: `onb-${step + 1}-${ONB_STEPS[step]}`,
    screen: "onboarding",
    render: { screen: "onboarding", onboarding: { mode: "preauth" } },
    drive: onboardingDrive(step, "Sam"),
  });
}
// Step 7 (reveal) — headline interpolates the first name.
for (const key of ["german40", "cjk40", "arabic40", "cyrillic40"]) {
  add({
    id: `onb-7-reveal-${key}`,
    screen: "onboarding",
    note: `reveal headline with First name = LONG_STRINGS.${key}`,
    render: { screen: "onboarding", onboarding: { mode: "preauth" } },
    drive: onboardingDrive(6, LONG_STRINGS[key]),
  });
}
add({
  id: "onb-7-reveal-short",
  screen: "onboarding",
  render: { screen: "onboarding", onboarding: { mode: "preauth" } },
  drive: onboardingDrive(6, "Sam"),
});
// Step 8 (notifications) idle / busy / error.
add({
  id: "onb-8-notifications",
  screen: "onboarding",
  render: { screen: "onboarding", onboarding: { mode: "preauth" } },
  drive: onboardingDrive(7, "Sam"),
});
add({
  id: "onb-8-notifications-busy",
  screen: "onboarding",
  render: {
    screen: "onboarding",
    onboarding: { mode: "preauth" },
    store: {
      ...DEFAULT_STORE,
      app: { onboardingBusy: true, onboardingError: null },
    },
  },
  drive: onboardingDrive(7, "Sam"),
});
add({
  id: "onb-8-notifications-error-german",
  screen: "onboarding",
  note: "appStore.onboardingError = LONG_STRINGS.errorGerman",
  render: {
    screen: "onboarding",
    onboarding: { mode: "preauth" },
    store: {
      ...DEFAULT_STORE,
      app: { onboardingBusy: false, onboardingError: LONG_STRINGS.errorGerman },
    },
  },
  drive: onboardingDrive(7, "Sam"),
});
// In-account mode: header shows Leave setup; its confirmation dialog.
add({
  id: "onb-account-1-name",
  screen: "onboarding",
  render: { screen: "onboarding", onboarding: { mode: "account" } },
  drive: [],
});
add({
  id: "onb-account-leave-dialog",
  screen: "onboarding",
  note: "mode=account, tap Leave setup → BrandDialog",
  render: { screen: "onboarding", onboarding: { mode: "account" } },
  drive: [{ type: "click", label: "Leave setup" }],
});

export function caseId(scenario, device, scale) {
  return `${scenario.id}__${device.id}__${scale.id}`;
}
