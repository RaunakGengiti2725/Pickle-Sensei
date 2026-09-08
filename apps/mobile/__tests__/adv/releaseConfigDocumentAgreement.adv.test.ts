/**
 * INT-release-config adversary — document / config / manifest agreement.
 *
 * Attacked head: 30a4065036a917514fb4984fde73f87867f38619.
 *
 * Every test here encodes the behaviour the release area CLAIMS (AGENTS.md
 * "App Store release invariants", docs/APP_STORE_SUBMISSION.md §1 "single
 * source of truth", infra/release/release-manifest.json rules). A failing
 * test is a confirmed disagreement between two release-identity sources on
 * this revision; a passing test is evidence the boundary held.
 *
 * Static only: reads committed files. Nothing here needs Xcode, a device,
 * StoreKit, RevenueCat or Apple credentials, and nothing writes.
 *
 *   cd apps/mobile && npx jest --ci __tests__/adv/releaseConfigDocumentAgreement.adv.test.ts
 */

export {};

declare const require: (id: string) => unknown;
declare const __dirname: string;
const fs = require('fs') as {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, encoding: 'utf8') => string;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(MOBILE_ROOT, '..', '..');

function read(relativeToRepo: string): string {
  const abs = path.join(REPO_ROOT, relativeToRepo);
  if (!fs.existsSync(abs)) {
    throw new Error(`release source missing: ${relativeToRepo}`);
  }
  return fs.readFileSync(abs, 'utf8');
}

const dossier = read('docs/APP_STORE_SUBMISSION.md');
const manifestText = read('infra/release/release-manifest.json');
const manifest = JSON.parse(manifestText) as {
  versionScheme: {
    marketingVersion: string;
    buildNumber: number;
    rules: Record<string, string>;
  };
  environments: Record<
    'development' | 'staging' | 'production',
    {
      apiOrigin: string | null;
      mobileConfig: string;
      realUserData: boolean;
    }
  >;
};
const pbxproj = read('apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj');
const infoPlist = read('apps/mobile/ios/PickleSensei/Info.plist');
const entitlements = read(
  'apps/mobile/ios/PickleSensei/PickleSensei.entitlements',
);
const appfile = read('apps/mobile/ios/fastlane/Appfile');
const fastfile = read('apps/mobile/ios/fastlane/Fastfile');
const runtimeConfig = read('apps/mobile/src/config/runtimeConfig.ts');
const podfileLock = read('apps/mobile/ios/Podfile.lock');
const packageLock = JSON.parse(read('apps/mobile/package-lock.json')) as {
  packages: Record<string, { version: string }>;
};
const distributionDoc = read('docs/DISTRIBUTION.md');

/** `| Fact | Value | Source |` row of the dossier §1 identity table. */
function dossierRow(fact: string): string {
  const line = dossier
    .split('\n')
    .find(l => l.startsWith(`| ${fact}`) && l.split('|').length >= 4);
  if (!line) throw new Error(`dossier §1 row "${fact}" not found`);
  const cells = line.split('|').map(c => c.trim());
  return cells[2] ?? '';
}

function pbxValues(setting: string): string[] {
  const pattern = new RegExp(`^\\s*${setting} = "?([^;"]+)"?;`, 'gm');
  const values: string[] = [];
  for (const match of pbxproj.matchAll(pattern)) {
    values.push((match[1] ?? '').trim());
  }
  return values;
}

function runtimeConst(name: string): string | null {
  const match = runtimeConfig.match(
    new RegExp(`^const ${name}(?:: string \\| null)? =\\s*'([^']*)';`, 'm'),
  );
  return match ? (match[1] ?? null) : null;
}

const VERSION = manifest.versionScheme.marketingVersion;
const BUILD = manifest.versionScheme.buildNumber;

// ─── A1: build number — dossier vs Fastfile ──────────────────────────────────

describe('A1 dossier §1 "Build number" row agrees with the Fastfile', () => {
  const row = dossierRow('Build number');

  test('the Fastfile no longer computes latest_testflight_build_number + 1', () => {
    expect(fastfile).not.toMatch(
      /latest_testflight_build_number\([^)]*\)\s*\+/,
    );
    expect(fastfile).not.toMatch(/increment_build_number/);
  });

  test('the dossier names the committed identity, not the removed fastlane increment, as the build-number source', () => {
    // The dossier is "the authoritative answer key"; the Fastfile at this
    // revision never increments, so the row must not say fastlane assigns
    // latest_testflight_build_number + 1.
    expect(row).not.toMatch(/latest_testflight_build_number\s*\+\s*1/);
    expect(row).not.toMatch(/Assigned by fastlane/i);
    expect(row).toMatch(
      /release-manifest\.json|CURRENT_PROJECT_VERSION|committed/i,
    );
  });
});

// ─── A2: committed build vs documented upload history ────────────────────────

describe('A2 committed buildNumber honours "never reused or reset" against the documented upload history', () => {
  // Newest uploaded build documented by the repository itself.
  const distributionMatch = distributionDoc.match(
    /build number\s+greater than (\d+)/i,
  );
  const dossierMatch = dossierRow('Build number').match(
    /Build (\d+) was validated/,
  );

  test('the repository documents the newest uploaded build (evidence input)', () => {
    expect(distributionMatch?.[1]).toBeDefined();
    expect(dossierMatch?.[1]).toBeDefined();
    expect(distributionMatch?.[1]).toBe(dossierMatch?.[1]);
  });

  test('the committed identity is greater than the newest documented uploaded build', () => {
    const newestUploaded = Number(distributionMatch?.[1] ?? dossierMatch?.[1]);
    expect(Number.isSafeInteger(newestUploaded)).toBe(true);
    // versionScheme.rules.buildNumber: "monotonically increasing integer across
    // all releases; ... never reused or reset". Builds 1–3 were uploaded.
    expect(BUILD).toBeGreaterThan(newestUploaded);
    for (const value of pbxValues('CURRENT_PROJECT_VERSION')) {
      expect(Number(value)).toBeGreaterThan(newestUploaded);
    }
  });
});

// ─── A3: release-manifest environment claims vs runtimeConfig.ts ─────────────

describe('A3 release-manifest environment claims describe the committed runtimeConfig.ts', () => {
  const apiBaseUrl = runtimeConst('API_BASE_URL');
  const dossierBackend = dossierRow('Backend').match(/`([^`]+)`/)?.[1] ?? null;

  test('runtimeConfig.ts commits the production API origin the dossier names (evidence input)', () => {
    expect(apiBaseUrl).not.toBeNull();
    expect(apiBaseUrl).toBe(dossierBackend);
  });

  test('manifest environments describe the committed runtimeConfig.ts (origin committed, not injected; defaults not all null)', () => {
    // runtimeConfig.ts commits a non-null API origin, RevenueCat key, Google
    // client ids and App Store id; the manifest says production values are
    // "injected at build time; never committed", development defaults are
    // "all null", and production.apiOrigin is "tbd".
    const claims = {
      productionApiOrigin: manifest.environments.production.apiOrigin,
      productionMobileConfigClaimsNeverCommitted: /never committed/i.test(
        manifest.environments.production.mobileConfig,
      ),
      developmentMobileConfigClaimsAllNull: /all null/i.test(
        manifest.environments.development.mobileConfig,
      ),
    };
    expect(claims).toEqual({
      productionApiOrigin: apiBaseUrl,
      productionMobileConfigClaimsNeverCommitted: false,
      developmentMobileConfigClaimsAllNull: false,
    });
  });
});

// ─── A4: third-party SDKs in the binary vs the dossier ───────────────────────

describe('A4 dossier "Third-party SDKs in binary" matches the locked native dependencies', () => {
  const row = dossierRow('Third-party SDKs in binary');
  const sentryPod = podfileLock.match(/^ {2}- RNSentry \(([\d.]+)\)/m);
  const sentryPrivacyBundleLinked = pbxproj.includes(
    'SentryPrivacy.bundle in Resources',
  );
  const sentryNpm = packageLock.packages['node_modules/@sentry/react-native'];

  test('the crash-reporting SDK is locked into the iOS build (evidence input)', () => {
    expect(sentryPod?.[1]).toBeDefined();
    expect(sentryNpm?.version).toBe(sentryPod?.[1]);
    expect(sentryPrivacyBundleLinked).toBe(true);
  });

  test('the dossier row lists the Sentry SDK Podfile.lock links and does not deny a crash-reporting SDK', () => {
    // Disabled-at-runtime is not absent-from-binary: RNSentry + Sentry.xcframework
    // and SentryPrivacy.bundle ship in the archive whatever the transport flag.
    expect(row).toMatch(/Sentry/i);
    expect(row).not.toMatch(/No analytics, crash-reporting, or ad SDK/);
  });

  test('the SDK versions the dossier does state match the locks', () => {
    const billing = dossierRow('Billing');
    const purchases =
      packageLock.packages['node_modules/react-native-purchases'];
    expect(purchases).toBeDefined();
    expect(billing).toContain(
      `\`react-native-purchases\` ${purchases?.version ?? ''}`,
    );
    const revenueCatPod = podfileLock.match(
      /^ {2}- RevenueCat \(([\d.]+)\)/m,
    )?.[1];
    expect(revenueCatPod).toBeDefined();
    expect(billing).toContain(`\`RevenueCat\` ${revenueCatPod ?? ''}`);
    const googlePod = podfileLock.match(
      /^ {2}- GoogleSignIn \(([\d.]+)\)/m,
    )?.[1];
    expect(googlePod).toBeDefined();
    expect(row).toContain(`GoogleSignIn ${googlePod ?? ''}`);
  });
});

// ─── A5: version / minimum-iOS triple ────────────────────────────────────────

describe('A5 marketing version and minimum iOS agree everywhere', () => {
  test('dossier, manifest, pbxproj (every configuration) and APP_VERSION carry one marketing version', () => {
    expect(dossierRow('Marketing version')).toBe(VERSION);
    const versions = new Set(pbxValues('MARKETING_VERSION'));
    expect(versions).toEqual(new Set([VERSION]));
    expect(runtimeConst('APP_VERSION')).toBe(VERSION);
  });

  test('every configuration carries the manifest build', () => {
    expect(new Set(pbxValues('CURRENT_PROJECT_VERSION'))).toEqual(
      new Set([String(BUILD)]),
    );
  });

  test('minimum iOS in the dossier equals every IPHONEOS_DEPLOYMENT_TARGET of the app target', () => {
    const minimum = dossierRow('Minimum iOS').match(/^(\d+\.\d+)/)?.[1];
    expect(minimum).toBeDefined();
    const targets = new Set(pbxValues('IPHONEOS_DEPLOYMENT_TARGET'));
    expect(targets).toEqual(new Set([minimum]));
  });

  test('Info.plist sources both version keys from build settings', () => {
    expect(infoPlist).toMatch(
      /<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/,
    );
    expect(infoPlist).toMatch(
      /<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/,
    );
    expect(infoPlist.match(/<key>CFBundleVersion<\/key>/g)?.length).toBe(1);
    expect(
      infoPlist.match(/<key>CFBundleShortVersionString<\/key>/g)?.length,
    ).toBe(1);
  });
});

// ─── A6: bundle id / team / App Store id / entitlements ──────────────────────

describe('A6 bundle identifier, team, App Store id and entitlements agree', () => {
  const bundleId = dossierRow('Bundle ID').replace(/`/g, '');
  const team = dossierRow('Apple Developer team').match(/`([A-Z0-9]+)`/)?.[1];

  test('one PRODUCT_BUNDLE_IDENTIFIER across configurations, equal to dossier, Appfile and diagnostics.bundleIdentifier', () => {
    expect(bundleId).toBe('com.picklesensei');
    expect(new Set(pbxValues('PRODUCT_BUNDLE_IDENTIFIER'))).toEqual(
      new Set([bundleId]),
    );
    expect(appfile).toContain(`app_identifier("${bundleId}")`);
    expect(runtimeConfig).toMatch(
      new RegExp(`bundleIdentifier: '${bundleId.replace(/\./g, '\\.')}'`),
    );
    expect(infoPlist).toContain(
      '<key>CFBundleIdentifier</key>\n\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>',
    );
  });

  test('DEVELOPMENT_TEAM in every configuration equals the dossier team and the Appfile team', () => {
    expect(team).toBeDefined();
    expect(new Set(pbxValues('DEVELOPMENT_TEAM'))).toEqual(new Set([team]));
    expect(appfile).toContain(`team_id("${team ?? ''}")`);
  });

  test('APP_STORE_ID in runtimeConfig equals the App Store id the dossier submits under', () => {
    const appStoreId = runtimeConst('APP_STORE_ID');
    expect(appStoreId).toMatch(/^\d{9,10}$/);
    // The dossier records the Apple ID (App Store id) in its ASC sections.
    expect(dossier).toContain(appStoreId ?? 'MISSING');
    expect(runtimeConfig).toContain(
      'https://apps.apple.com/app/id${APP_STORE_ID}?action=write-review',
    );
  });

  test('entitlements declare exactly the capabilities the dossier claims (Sign in with Apple; no push)', () => {
    const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map(
      m => m[1],
    );
    expect(keys).toEqual(['com.apple.developer.applesignin']);
    expect(entitlements).not.toContain('aps-environment');
    expect(dossierRow('Capabilities / entitlements')).toContain(
      'com.apple.developer.applesignin',
    );
    expect(pbxValues('CODE_SIGN_ENTITLEMENTS')).toEqual([
      'PickleSensei/PickleSensei.entitlements',
      'PickleSensei/PickleSensei.entitlements',
    ]);
  });

  test('iPhone-only, portrait-only, arm64 (dossier "Platform" row)', () => {
    expect(new Set(pbxValues('TARGETED_DEVICE_FAMILY'))).toEqual(
      new Set(['1']),
    );
    expect(dossierRow('Platform')).toContain('TARGETED_DEVICE_FAMILY = 1');
    const orientations = infoPlist.match(
      /<key>UISupportedInterfaceOrientations<\/key>\s*<array>([\s\S]*?)<\/array>/,
    )?.[1];
    expect(orientations?.match(/<string>/g)?.length).toBe(1);
    expect(orientations).toContain('UIInterfaceOrientationPortrait');
    expect(infoPlist).toMatch(
      /<key>UIRequiredDeviceCapabilities<\/key>\s*<array>\s*<string>arm64<\/string>\s*<\/array>/,
    );
    expect(infoPlist).toMatch(/<key>LSRequiresIPhoneOS<\/key>\s*<true\/>/);
  });

  test('export compliance exemption declared as the dossier states', () => {
    expect(infoPlist).toMatch(
      /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/,
    );
    expect(dossierRow('Export compliance')).toContain(
      'ITSAppUsesNonExemptEncryption = false',
    );
  });
});

// ─── A7: Google Sign-In return URL scheme ────────────────────────────────────

describe('A7 Info.plist Google return URL scheme is the reversed committed iOS client id', () => {
  test('exactly one URL scheme, equal to the reversed GOOGLE_IOS_CLIENT_ID', () => {
    const iosClientId = runtimeConst('GOOGLE_IOS_CLIENT_ID');
    expect(iosClientId).toMatch(/^[\w-]+\.apps\.googleusercontent\.com$/);
    const [clientPart] = (iosClientId ?? '').split(
      '.apps.googleusercontent.com',
    );
    const reversed = `com.googleusercontent.apps.${clientPart ?? ''}`;
    const schemes = [
      ...infoPlist.matchAll(
        /<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g,
      ),
    ].flatMap(m =>
      [...(m[1] ?? '').matchAll(/<string>([^<]+)<\/string>/g)].map(s => s[1]),
    );
    expect(schemes).toEqual([reversed]);
    // The dossier's Google OAuth row names the same iOS client id prefix.
    expect(dossierRow('Google OAuth client IDs')).toContain(
      (clientPart ?? '').slice(0, 40),
    );
  });
});

// ─── A8: legal URLs ──────────────────────────────────────────────────────────

describe('A8 legal URLs derive from the committed API origin and match the dossier', () => {
  test('privacy and terms are `${API_BASE_URL}/privacy` and `/terms` and equal the dossier URLs', () => {
    const apiBaseUrl = runtimeConst('API_BASE_URL') ?? '';
    expect(runtimeConfig).toContain(
      'legalPrivacyUrl: API_BASE_URL ? `${API_BASE_URL}/privacy` : null',
    );
    expect(runtimeConfig).toContain(
      'legalTermsUrl: API_BASE_URL ? `${API_BASE_URL}/terms` : null',
    );
    expect(dossierRow('Privacy policy URL')).toBe(`\`${apiBaseUrl}/privacy\``);
    expect(dossierRow('Terms of use URL')).toBe(`\`${apiBaseUrl}/terms\``);
  });
});

// ─── A9: iOS-only scope in user-facing copy ──────────────────────────────────

describe('A9 iOS-only scope: no forbidden platform/competitor copy in shipped string literals', () => {
  const FORBIDDEN =
    /\b(Android|Google Play|Play Store|guest mode|Live Court|DUPR|SwingVision|PB Vision|Selkirk|JOOLA)\b/;

  const walk = (dir: string, out: string[]): string[] => {
    const entries = (
      require('fs') as {
        readdirSync: (
          p: string,
          o: { withFileTypes: true },
        ) => { name: string; isDirectory: () => boolean }[];
      }
    ).readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules')
          continue;
        walk(full, out);
      } else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name)
      ) {
        out.push(full);
      }
    }
    return out;
  };

  /** String-literal bodies of a TS source with comments removed. */
  const literals = (source: string): string[] => {
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    const found: string[] = [];
    for (const match of withoutComments.matchAll(
      /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g,
    )) {
      found.push(match[1] ?? match[2] ?? match[3] ?? '');
    }
    return found;
  };

  test('no src/ string literal mentions Android, Google Play, guest mode, Live Court, DUPR or a competitor', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(MOBILE_ROOT, 'src'), [])) {
      for (const literal of literals(fs.readFileSync(file, 'utf8'))) {
        if (FORBIDDEN.test(literal)) {
          offenders.push(
            `${path.resolve(file).slice(MOBILE_ROOT.length + 1)}: ${literal.slice(0, 120)}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the account-deletion confirmation shown on iOS does not mention Google Play', () => {
    // Not platform-gated: this notice is what an iPhone user reads after
    // deleting the account.
    const source = fs.readFileSync(
      path.join(MOBILE_ROOT, 'src', 'screens', 'ManageAccountScreen.tsx'),
      'utf8',
    );
    const notices = [
      ...source.matchAll(/title: 'Account deleted',\s*detail:\s*'([^']*)'/g),
    ].map(m => m[1] ?? '');
    expect(notices.length).toBe(3);
    expect(notices.filter(n => FORBIDDEN.test(n))).toEqual([]);
  });

  test('Info.plist usage strings carry no forbidden copy', () => {
    const strings = [...infoPlist.matchAll(/<string>([^<]*)<\/string>/g)].map(
      m => m[1] ?? '',
    );
    expect(strings.filter(s => FORBIDDEN.test(s))).toEqual([]);
  });
});
