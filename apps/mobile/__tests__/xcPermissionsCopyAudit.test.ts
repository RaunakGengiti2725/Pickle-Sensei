/**
 * xc-journey-notifications-permissions — COPY + PLATFORM CONTRACT audit.
 *
 * Static, filesystem-level checks (no Apple runtime needed) over every file
 * that carries permission-journey copy or permission-requesting code:
 *
 *   1. Info.plist usage strings exist, are non-empty, and obey the dossier
 *      copy rules (docs/APP_STORE_SUBMISSION.md + AGENTS.md).
 *   2. Entitlements carry NO push entitlement (reminders are local-only).
 *   3. Native capture requests ONLY video authorization: no
 *      `requestAccess(for: .audio)`, no audio capture input, no
 *      `PHPhotoLibrary.requestAuthorization` (PHPicker is the picker).
 *   4. Every user-visible sentence in the notification/camera/import surfaces
 *      is free of banned terms (Android, Google Play, guest mode, Live Court,
 *      DUPR, competitors, accuracy %, superlatives, AI-coach equivalence).
 *   5. The exact recovery strings the journey harnesses assert against are
 *      present verbatim in source (drift detector — if product copy changes,
 *      this and the runtime suites fail together with a precise diff).
 *
 * Statements about what Swift DOES at runtime remain INFERRED; this suite
 * pins the source contract only. Output: copy-audit.json.
 */
export {};

declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { readFileSync, existsSync, mkdirSync, writeFileSync } =
  require('fs') as {
    readFileSync: (path: string, encoding: 'utf8') => string;
    existsSync: (path: string) => boolean;
    mkdirSync: (path: string, options: { recursive: boolean }) => void;
    writeFileSync: (path: string, data: string) => void;
  };
const { resolve: resolvePath, join: joinPath } = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

const REPO = resolvePath(__dirname, '..', '..', '..');
const ARTIFACT_DIR =
  process.env['XC_PERMISSIONS_ARTIFACT_DIR'] ??
  joinPath(REPO, 'artifacts', 'xc-journey-notifications-permissions');

function read(rel: string): string {
  const file = joinPath(REPO, rel);
  if (!existsSync(file)) throw new Error(`missing ${rel}`);
  return readFileSync(file, 'utf8');
}

function writeArtifact(name: string, value: unknown) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(joinPath(ARTIFACT_DIR, name), JSON.stringify(value, null, 2));
}

const BANNED: Array<{ rule: RegExp; why: string }> = [
  { rule: /android/i, why: 'platform mention (dossier)' },
  { rule: /google play/i, why: 'platform mention (dossier)' },
  { rule: /guest mode/i, why: 'removed concept (dossier)' },
  { rule: /live court/i, why: 'removed concept (dossier)' },
  { rule: /\bDUPR\b/, why: 'third-party rating (dossier)' },
  { rule: /swingvision|pb vision|selkirk|joola/i, why: 'competitor (dossier)' },
  {
    rule: /\d+(\.\d+)?\s?%\s*(accura|correct|precis)/i,
    why: 'accuracy % claim',
  },
  {
    rule: /\b(most accurate|#1|best-in-class|the best)\b/i,
    why: 'superlative',
  },
  {
    rule: /(replaces?|as good as|equivalent to) (a |your )?(human )?coach/i,
    why: 'AI-coach equivalence',
  },
  { rule: /\bpush notifications?\b/i, why: 'reminders are local only' },
];

/** User-visible sentences from a TSX/TS source: string literals and JSX text
 *  that read like prose (two+ words, letters). Code-ish tokens are ignored. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

function userVisibleSentences(rel: string, raw: string): string[] {
  const source = stripComments(raw);
  const out = new Set<string>();
  const literal = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
  for (const match of source.matchAll(literal)) {
    const text = (match[1] ?? match[2] ?? '').trim();
    if (
      /[A-Za-z]{2,}[\s—–-][A-Za-z’']{1,}/.test(text) &&
      !/^[a-z0-9_.:/-]+$/.test(text)
    ) {
      out.add(text);
    }
  }
  if (rel.endsWith('.tsx')) {
    const jsxText = />\s*([^<>{}]*[A-Za-z]{2,}\s[A-Za-z’'][^<>{}]*?)\s*</g;
    for (const match of source.matchAll(jsxText)) {
      out.add(match[1]!.replace(/\s+/g, ' ').trim());
    }
  }
  return [...out];
}

const SURFACES = [
  'apps/mobile/src/screens/NotificationSettingsScreen.tsx',
  'apps/mobile/src/notifications/NotificationPrimingCard.tsx',
  'apps/mobile/src/notifications/copy.ts',
  'apps/mobile/src/notifications/plan.ts',
  'apps/mobile/src/notifications/service.ts',
  'apps/mobile/src/notifications/notificationStore.ts',
  'apps/mobile/src/screens/OnboardingScreen.tsx',
  'apps/mobile/src/screens/AnalyzeScreen.tsx',
  'apps/mobile/src/camera/capture.ts',
  'apps/mobile/ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift',
  'apps/mobile/ios/LocalPods/PickleNative/Sources/GuidedCaptureViewController.swift',
  'native/camera-engine/Sources/CameraEngine.swift',
];

/** Exact strings the runtime harnesses assert on. */
const CONTRACT_STRINGS: Array<{ file: string; text: string }> = [
  {
    file: 'apps/mobile/src/screens/NotificationSettingsScreen.tsx',
    text: 'Notifications are off in system settings',
  },
  {
    file: 'apps/mobile/src/screens/NotificationSettingsScreen.tsx',
    text: 'Open system settings',
  },
  {
    file: 'apps/mobile/src/screens/NotificationSettingsScreen.tsx',
    text: 'Couldn’t open Settings from here',
  },
  {
    file: 'apps/mobile/src/screens/NotificationSettingsScreen.tsx',
    text: 'Notifications → Pickle Sensei to allow them.',
  },
  {
    file: 'apps/mobile/src/screens/NotificationSettingsScreen.tsx',
    text: 'Couldn’t check notification permission',
  },
  {
    file: 'apps/mobile/src/screens/NotificationSettingsScreen.tsx',
    text: 'Check again',
  },
  {
    file: 'apps/mobile/src/screens/NotificationSettingsScreen.tsx',
    text: 'Turn on reminders',
  },
  {
    file: 'apps/mobile/src/screens/NotificationSettingsScreen.tsx',
    text: 'Paused until notifications are allowed',
  },
  {
    file: 'apps/mobile/src/screens/NotificationSettingsScreen.tsx',
    text: 'Scheduled from your real practice history',
  },
  {
    file: 'apps/mobile/src/screens/NotificationSettingsScreen.tsx',
    text: 'Reminders couldn’t be scheduled on this phone',
  },
  {
    file: 'apps/mobile/src/screens/NotificationSettingsScreen.tsx',
    text: 'This change couldn’t be saved on this phone',
  },
  {
    file: 'apps/mobile/src/notifications/NotificationPrimingCard.tsx',
    text: 'Reminders couldn’t be turned on. Try again, or allow notifications',
  },
  {
    file: 'apps/mobile/src/notifications/NotificationPrimingCard.tsx',
    text: 'Not now',
  },
  {
    file: 'apps/mobile/src/screens/AnalyzeScreen.tsx',
    text: 'Capture interrupted',
  },
  {
    file: 'apps/mobile/src/screens/AnalyzeScreen.tsx',
    text: 'Nothing was rated.',
  },
  { file: 'apps/mobile/src/screens/AnalyzeScreen.tsx', text: 'Try again' },
  {
    file: 'apps/mobile/src/camera/capture.ts',
    text: 'Real guided camera capture is not available on this device.',
  },
  {
    file: 'apps/mobile/src/camera/capture.ts',
    text: 'Real video import is not available on this device.',
  },
  {
    file: 'apps/mobile/ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift',
    text: 'Allow camera access in Settings to analyze a stroke.',
  },
  {
    file: 'apps/mobile/ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift',
    text: 'Allow camera access in Settings to record a session.',
  },
  {
    file: 'apps/mobile/ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift',
    text: 'camera.permission_denied',
  },
  {
    file: 'apps/mobile/ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift',
    text: 'Video import was canceled.',
  },
  {
    file: 'apps/mobile/ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift',
    text: 'The video library could not be opened.',
  },
  {
    file: 'apps/mobile/ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift',
    text: 'The selected item is not a supported video.',
  },
];

function plistString(plist: string, key: string): string | null {
  const match = new RegExp(
    `<key>${key}</key>\\s*<string>([^<]*)</string>`,
  ).exec(plist);
  return match ? match[1]! : null;
}

describe('xc permissions copy + platform contract audit', () => {
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
  };

  afterAll(() => {
    writeArtifact('copy-audit.json', report);
  });

  it('Info.plist declares camera / photo-library / microphone strings within the dossier rules', () => {
    const plist = read('apps/mobile/ios/PickleSensei/Info.plist');
    const usage = {
      NSCameraUsageDescription: plistString(plist, 'NSCameraUsageDescription'),
      NSPhotoLibraryUsageDescription: plistString(
        plist,
        'NSPhotoLibraryUsageDescription',
      ),
      NSMicrophoneUsageDescription: plistString(
        plist,
        'NSMicrophoneUsageDescription',
      ),
    };
    report['infoPlistUsageStrings'] = usage;
    const problems: string[] = [];
    for (const [key, value] of Object.entries(usage)) {
      if (!value || value.trim().length <= 20)
        problems.push(`${key}: missing/short`);
      for (const { rule, why } of BANNED) {
        if (value && rule.test(value)) problems.push(`${key}: ${why}`);
      }
    }
    expect(problems).toEqual([]);
    // Camera + photo strings state the on-device/private posture the dossier requires.
    expect(usage.NSCameraUsageDescription).toMatch(/on-device/i);
    expect(usage.NSPhotoLibraryUsageDescription).toMatch(/system picker/i);
    // No location / contacts / tracking strings — none of those are used.
    for (const key of [
      'NSLocationWhenInUseUsageDescription',
      'NSContactsUsageDescription',
      'NSUserTrackingUsageDescription',
      'NSSpeechRecognitionUsageDescription',
    ]) {
      expect(plist).not.toContain(`<key>${key}</key>`);
    }
  });

  it('entitlements carry no push entitlement (reminders are local only)', () => {
    const entitlements = read(
      'apps/mobile/ios/PickleSensei/PickleSensei.entitlements',
    );
    expect(entitlements).not.toContain('aps-environment');
    expect(entitlements).toContain('com.apple.developer.applesignin');
    const plist = read('apps/mobile/ios/PickleSensei/Info.plist');
    const backgroundModes =
      /<key>UIBackgroundModes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
    report['backgroundModes'] = backgroundModes
      ? backgroundModes[1]!.trim()
      : null;
    if (backgroundModes)
      expect(backgroundModes[1]).not.toContain('remote-notification');
  });

  it('native capture requests video authorization only; import uses PHPicker without a library permission request', () => {
    const engine = read('native/camera-engine/Sources/CameraEngine.swift');
    const capture = read(
      'apps/mobile/ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift',
    );
    const guided = read(
      'apps/mobile/ios/LocalPods/PickleNative/Sources/GuidedCaptureViewController.swift',
    );
    const native = engine + capture + guided;
    const findings = {
      videoAuthorizationChecks: (
        native.match(/authorizationStatus\(for:\s*\.video\)/g) ?? []
      ).length,
      videoRequestAccess: (
        native.match(/requestAccess\(for:\s*\.video\)/g) ?? []
      ).length,
      audioRequestAccess: (
        native.match(/requestAccess\(for:\s*\.audio\)/g) ?? []
      ).length,
      audioAuthorizationChecks: (
        native.match(/authorizationStatus\(for:\s*\.audio\)/g) ?? []
      ).length,
      audioCaptureDevice: (
        native.match(
          /AVCaptureDevice\.default\(for:\s*\.audio\)|mediaType:\s*\.audio|AVCaptureAudioDataOutput|AVMediaType\.audio/g,
        ) ?? []
      ).length,
      photoLibraryAuthorization: (
        native.match(
          /PHPhotoLibrary\.(requestAuthorization|authorizationStatus)/g,
        ) ?? []
      ).length,
      phPicker: (capture.match(/PHPickerViewController/g) ?? []).length,
      deniedBranchFailsClosed:
        /case \.denied, \.restricted:\s*\n\s*granted = false/.test(engine),
      unknownDefaultFailsClosed:
        /@unknown default:\s*\n\s*granted = false/.test(engine),
    };
    report['nativePermissionContract'] = findings;
    expect(findings.videoAuthorizationChecks).toBeGreaterThan(0);
    expect(findings.videoRequestAccess).toBeGreaterThan(0);
    expect(findings.audioRequestAccess).toBe(0);
    expect(findings.audioAuthorizationChecks).toBe(0);
    expect(findings.audioCaptureDevice).toBe(0);
    expect(findings.photoLibraryAuthorization).toBe(0);
    expect(findings.phPicker).toBeGreaterThan(0);
    expect(findings.deniedBranchFailsClosed).toBe(true);
    expect(findings.unknownDefaultFailsClosed).toBe(true);
  });

  it('every user-visible sentence on the permission surfaces is free of banned terms', () => {
    const perFile: Record<
      string,
      { sentences: number; hits: Array<{ text: string; why: string }> }
    > = {};
    for (const rel of SURFACES) {
      const source = read(rel);
      const sentences = userVisibleSentences(rel, source);
      const hits: Array<{ text: string; why: string }> = [];
      for (const text of sentences) {
        for (const { rule, why } of BANNED) {
          if (rule.test(text)) hits.push({ text, why });
        }
      }
      perFile[rel] = { sentences: sentences.length, hits };
    }
    report['bannedCopyScan'] = perFile;
    const allHits = Object.entries(perFile).flatMap(([file, r]) =>
      r.hits.map(h => ({ file, ...h })),
    );
    expect(allHits).toEqual([]);
    expect(
      Object.values(perFile).reduce((n, r) => n + r.sentences, 0),
    ).toBeGreaterThan(100);
  });

  it('the recovery strings the runtime harnesses assert on exist verbatim in source', () => {
    const missing = CONTRACT_STRINGS.filter(
      ({ file, text }) => !read(file).includes(text),
    );
    report['contractStrings'] = {
      checked: CONTRACT_STRINGS.length,
      missing,
    };
    expect(missing).toEqual([]);
  });

  it('the dossier documents the microphone string as declared-but-never-requested and the camera as video only', () => {
    const dossier = read('docs/APP_STORE_SUBMISSION.md');
    expect(dossier).toMatch(/Microphone \(declared, never requested/);
    expect(dossier).toMatch(/Capture is video only/);
    expect(dossier).toMatch(/system picker \(PHPicker\)/);
    expect(dossier).toMatch(/No push notifications entitlement/);
    report['dossierCrossCheck'] = {
      microphoneDeclaredNeverRequested: true,
      captureVideoOnly: true,
      phPickerNoPrompt: true,
      noPushEntitlement: true,
      infoPlistMicrophoneString: plistString(
        read('apps/mobile/ios/PickleSensei/Info.plist'),
        'NSMicrophoneUsageDescription',
      ),
      note: 'The plist microphone string reads as a present-tense capability ("can include court audio") while 1.0 never requests the mic — the dossier already flags removing the key in 1.0.1 (docs/APP_STORE_SUBMISSION.md §5.1.1). Recorded as an observation, not a defect.',
    };
  });
});
