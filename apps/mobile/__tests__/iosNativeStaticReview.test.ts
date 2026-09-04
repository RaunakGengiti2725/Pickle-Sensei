/**
 * Pins the Linux-checkable release configuration of the iOS app by running
 * tools/ios-static-review/audit.mjs against the checked-in Info.plist,
 * entitlements, privacy manifest, project.pbxproj, shared scheme, Podfile,
 * fastlane and the PickleNative shipping sources, and by replaying a handful
 * of mutation-fuzz cases to prove the guards still catch real regressions.
 *
 * Everything here is static: it proves what the repository declares, not
 * how iOS behaves at runtime (that evidence comes from the Mac runner).
 */
export {};

// Node built-ins, typed the same way be-mobile-security-secrets.test.ts does
// (the RN tsconfig ships no node types).
declare const require: (id: string) => unknown;
declare const __dirname: string;
type SpawnResult = { status: number | null; stdout: string; stderr: string };
type SpawnOptions = { cwd: string; encoding: 'utf8'; maxBuffer: number };
const { execFileSync, spawnSync } = require('child_process') as {
  execFileSync: (
    file: string,
    args: string[],
    options: { encoding: 'utf8' },
  ) => string;
  spawnSync: (
    file: string,
    args: string[],
    options: SpawnOptions,
  ) => SpawnResult;
};
const { mkdtempSync, readFileSync, rmSync } = require('fs') as {
  mkdtempSync: (prefix: string) => string;
  readFileSync: (p: string, encoding: 'utf8') => string;
  rmSync: (p: string, options: { recursive: true; force: true }) => void;
};
const { tmpdir } = require('os') as { tmpdir: () => string };
const { join, resolve } = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

type Row = {
  id: string;
  category: string;
  status: 'pass' | 'fail' | 'warn' | 'info' | 'unknown';
  detail: string;
  evidence: string;
  provenance: string;
};
type AuditJson = {
  counts: Record<string, number>;
  rows: Row[];
  matrices: {
    usageStrings: Array<{
      key: string;
      declared: boolean;
      requiredByApiHits: number;
    }>;
    requiredReasonApis: Array<{
      category: string;
      declaredReasons: string[];
      appCodeHits: string[];
    }>;
    releaseBuildSettings: Array<{
      key: string;
      release: string | null;
      ok: boolean;
    }>;
  };
};

const NODE = 'node';
const mobileRoot = resolve(__dirname, '..');
const auditScript = join(mobileRoot, 'tools', 'ios-static-review', 'audit.mjs');
const fuzzScript = join(
  mobileRoot,
  'tools',
  'ios-static-review',
  'mutation-fuzz.mjs',
);

let workDir: string;
let audit: AuditJson;
let auditExit: number;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ios-static-review-'));
  const out = join(workDir, 'audit.json');
  const run = spawnSync(NODE, [auditScript, '--json', out], {
    cwd: mobileRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  auditExit = run.status ?? -1;
  audit = JSON.parse(readFileSync(out, 'utf8')) as AuditJson;
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const byId = (id: string): Row => {
  const row = audit.rows.find(r => r.id === id);
  if (!row) throw new Error(`audit row ${id} missing`);
  return row;
};
const failing = (category?: string) =>
  audit.rows
    .filter(r => r.status === 'fail' && (!category || r.category === category))
    .map(r => `${r.id}: ${r.detail}`);

describe('iOS native static review (Linux, static)', () => {
  it('parses every plist and resolves shipping sources', () => {
    expect(byId('inputs.info_plist_parses').status).toBe('pass');
    expect(byId('inputs.entitlements_parses').status).toBe('pass');
    expect(byId('inputs.privacy_manifest_parses').status).toBe('pass');
    expect(audit.counts.unknown).toBe(0);
  });

  it('declares a usage string for every privacy-gated API the shipping code calls', () => {
    expect(failing('usage-strings')).toEqual([]);
    const camera = audit.matrices.usageStrings.find(
      u => u.key === 'NSCameraUsageDescription',
    );
    expect(camera).toMatchObject({ declared: true });
    expect(camera?.requiredByApiHits).toBeGreaterThan(0);
    const undeclared = audit.matrices.usageStrings.filter(
      u => u.requiredByApiHits > 0 && !u.declared,
    );
    expect(undeclared).toEqual([]);
  });

  it('keeps the privacy manifest consistent with required-reason API use', () => {
    expect(failing('privacy-manifest')).toEqual([]);
    for (const api of audit.matrices.requiredReasonApis) {
      if (api.appCodeHits.length > 0)
        expect(api.declaredReasons.length).toBeGreaterThan(0);
    }
    expect(byId('privacy.tracking_false').status).toBe('pass');
  });

  it('carries exactly the Sign in with Apple entitlement', () => {
    expect(failing('entitlements')).toEqual([]);
    expect(
      byId('entitlement.com.apple.developer.applesignin.present').status,
    ).toBe('pass');
    expect(byId('entitlement.applesignin_default').status).toBe('pass');
    expect(byId('entitlement.wired_all_configs').status).toBe('pass');
    expect(byId('entitlement.no_push').status).toBe('pass');
  });

  it('has no ATS exceptions, no background modes and restores the idle timer', () => {
    expect(failing('ats')).toEqual([]);
    expect(failing('background')).toEqual([]);
    expect(byId('ats.arbitrary_loads_false').status).toBe('pass');
    expect(byId('background.no_modes').status).toBe('pass');
    expect(byId('background.no_bg_task_apis').status).toBe('pass');
    expect(byId('background.idle_timer_restored').status).toBe('pass');
  });

  it('registers exactly the reversed Google client id as URL scheme', () => {
    expect(failing('url-types')).toEqual([]);
    expect(byId('url.google_reversed_client_id_matches').status).toBe('pass');
    expect(byId('url.no_unexpected_schemes').status).toBe('pass');
    expect(byId('url.no_duplicate_schemes').status).toBe('pass');
  });

  it('builds Release with stripping, no assertions, optimisation and no DEBUG condition', () => {
    const buildFails = failing('release-build').filter(
      f => !f.startsWith('scheme.blueprint.'),
    );
    expect(buildFails).toEqual([]);
    expect(audit.matrices.releaseBuildSettings.filter(s => !s.ok)).toEqual([]);
    expect(byId('scheme.archive_release').status).toBe('pass');
    expect(byId('build.appdelegate_bundle_url').status).toBe('pass');
    expect(byId('build.release.no_swift_DEBUG_condition').status).toBe('pass');
    expect(byId('build.podfile_new_arch_pinned').status).toBe('pass');
  });

  it('ships no print/NSLog and no sensitive public log interpolation', () => {
    expect(failing('logging')).toEqual([]);
    expect(byId('logging.no_print_nslog').status).toBe('pass');
    expect(byId('logging.no_public_sensitive_interpolation').status).toBe(
      'pass',
    );
    expect(byId('logging.no_secret_literals').status).toBe('pass');
  });

  it('matches the dossier identity (bundle id, team, name, versions, App Store id)', () => {
    expect(failing('dossier')).toEqual([]);
    expect(failing('plist')).toEqual([]);
  });

  // Known static defect at this commit: the shared scheme still references a
  // PickleSenseiTests target whose blueprint id no longer exists in
  // project.pbxproj. `test.failing` flips red the moment it is fixed so the
  // marker gets removed.
  test.failing(
    'shared scheme references only targets that exist in project.pbxproj',
    () => {
      expect(byId('scheme.blueprint.PickleSenseiTests').status).toBe('pass');
    },
  );

  it('exits non-zero only because of the known scheme defect', () => {
    expect(auditExit).toBe(1);
    expect(failing()).toEqual([
      expect.stringMatching(/^scheme\.blueprint\.PickleSenseiTests: /),
    ]);
  });
});

describe('mutation replay: guards still catch release regressions', () => {
  const replay = (caseId: string) => {
    const out = join(workDir, `${caseId}.json`);
    const run = spawnSync(
      NODE,
      [
        fuzzScript,
        '--random',
        '0',
        '--replay',
        caseId,
        '--workers',
        '1',
        '--out',
        out,
        '--work-dir',
        join(workDir, 'sandbox'),
      ],
      { cwd: mobileRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    const json = JSON.parse(readFileSync(out, 'utf8')) as {
      results: Array<{ verdict: string; detectedBy: string[] }>;
    };
    const first = json.results[0];
    if (!first) throw new Error(`no result for ${caseId}`);
    return { exit: run.status, ...first };
  };

  it.each([
    'info.drop_camera_string',
    'info.ats_arbitrary_true',
    'info.add_background_audio',
    'info.url_scheme_typo',
    'ent.drop_applesignin',
    'priv.tracking_true',
    'pbx.release_swift_onone',
    'pbx.release_debug_condition',
    'scheme.archive_debug',
    'appdelegate.always_metro',
    'swift.log_token_public',
    'swift.add_location_manager',
  ])('kills %s', caseId => {
    const r = replay(caseId);
    expect(r.verdict).toBe('killed');
    expect(r.detectedBy.length).toBeGreaterThan(0);
    expect(r.exit).toBe(0);
  });

  it.each([
    'info.benign_whitespace',
    'info.benign_reorder',
    'pbx.benign_debug_onone',
    'swift.benign_comment_print',
  ])('stays green on benign edit %s', caseId => {
    const r = replay(caseId);
    expect(r.verdict).toBe('clean');
    expect(r.exit).toBe(0);
  });

  it('the harness itself is executable from the repo root', () => {
    const version = execFileSync(NODE, ['--version'], {
      encoding: 'utf8',
    });
    expect(version).toMatch(/^v\d+/);
  });
});
