/**
 * INT-security-privacy adversary — secret-scanning gate.
 *
 * `.gitleaks.toml` promises that every allowlist entry is "scoped as narrowly
 * as possible (a specific key name, fixture string, or path) so a real
 * credential landing next to a fixture still fails the gate". This attack
 * runs the REAL gate (`scripts/security-scan.sh --tree`, pinned gitleaks
 * 8.30.1, the repository's own `.gitleaks.toml`) against a throwaway git
 * repository that contains ONE planted synthetic credential per case, at the
 * exact paths the allowlists name, and expects the gate to fail (exit 1) for
 * every one of them. A control plant outside every allowlisted path proves
 * the scanner itself recognises each credential shape, and a sibling plant in
 * the same directory (unlisted file name) isolates the allowlist's PATH as
 * the only difference.
 *
 * The planted values are assembled at runtime so this test file never
 * contains a scannable credential itself. The pinned gitleaks binary is the
 * one `scripts/security-scan.sh` caches (run the gate once on the checkout
 * first so no download happens inside the test).
 *
 *   cd apps/mobile && npx jest --ci --runInBand __tests__/adv/securityScanAllowlist.attack.test.ts
 */
import { spawnSync } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  copyFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCAN_SCRIPT = path.join(REPO_ROOT, 'scripts', 'security-scan.sh');
const GITLEAKS_CONFIG = path.join(REPO_ROOT, '.gitleaks.toml');

// Synthetic credential shapes, joined at runtime from short fragments so this
// file never contains a scannable value itself.
const chunk = (parts: string[]): string => parts.join('');
const AWS_ACCESS_KEY = chunk(['AKIA', 'Q7ZK', '3M2N', '5P6R', '7S2T']);
const RC_SERVER_VALUE = chunk([
  'sk_',
  'Qx7Lm2',
  'Vr9Tk4',
  'Zp1Wn6',
  'Hd3Fs8',
  'Jb5Gy0',
  'Cq',
]);
const SB_SERVICE_VALUE = chunk([
  'sb_',
  'sec',
  'ret_',
  'Vt3Nq8',
  'Rz2Lk7',
  'Xw4Pj9',
  'Hm1Bd6',
]);
const STRIPE_LIVE_VALUE = chunk([
  'sk_',
  'live_',
  'q8Zr2L',
  'm9Xc4V',
  'b7Nk1P',
  'j6Ty3W',
  'q5Es8R',
  'd0Fg',
]);
// Shape the default `generic-api-key` rule flags: an `api_key` assignment
// holding a long high-entropy value.
const GENERIC_API_KEY_LINE = `const ${chunk(['api', '_key'])} = "${chunk([
  'Zq9Xv3',
  'Lm7Kt2',
  'Rp8Wn4',
  'Hd6Fs1',
  'Jb5Gy0',
  'Cq3Ne7',
  'Ua2',
])}";\n`;

interface Plant {
  title: string;
  relativePath: string;
  content: string;
}

const CONTROL_PLANTS: Plant[] = [
  {
    title: 'AWS access key in an unlisted source file',
    relativePath: 'src/control_aws.ts',
    content: `export const region = "${AWS_ACCESS_KEY}";\n`,
  },
  {
    title: 'RevenueCat secret key in an unlisted source file',
    relativePath: 'src/control_rc.ts',
    content: `export const rc = "${RC_SERVER_VALUE}";\n`,
  },
  {
    title: 'Supabase secret key in an unlisted source file',
    relativePath: 'src/control_sb.ts',
    content: `export const sb = "${SB_SERVICE_VALUE}";\n`,
  },
  {
    title: 'Stripe live secret in an unlisted source file',
    relativePath: 'src/control_stripe.ts',
    content: `export const stripe = "${STRIPE_LIVE_VALUE}";\n`,
  },
  {
    title: 'generic high-entropy api_key in an unlisted test file',
    relativePath: 'services/api/src/control_generic.ts',
    content: GENERIC_API_KEY_LINE,
  },
];

// Each plant sits at a path an allowlist names, but the planted line does NOT
// contain that allowlist's fixture regex. The narrow-scoping promise says the
// gate must still fail.
const ALLOWLISTED_PATH_PLANTS: Plant[] = [
  {
    title:
      'RevenueCat SECRET key beside the public SDK keys in apps/mobile/src/config/runtimeConfig.ts',
    relativePath: 'apps/mobile/src/config/runtimeConfig.ts',
    content: `export const revenueCat = { apple: "appl_placeholder", server: "${RC_SERVER_VALUE}" };\n`,
  },
  {
    title: 'AWS access key in apps/mobile/src/config/runtimeConfig.ts',
    relativePath: 'apps/mobile/src/config/runtimeConfig.ts',
    content: `export const uploads = "${AWS_ACCESS_KEY}";\n`,
  },
  {
    title: 'Supabase secret key in docs/DISTRIBUTION.md',
    relativePath: 'docs/DISTRIBUTION.md',
    content: `# Distribution\n\nSUPABASE_SERVICE_KEY=${SB_SERVICE_VALUE}\n`,
  },
  {
    title: 'AWS access key in docs/DISTRIBUTION.md',
    relativePath: 'docs/DISTRIBUTION.md',
    content: `# Distribution\n\nAWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY}\n`,
  },
  {
    title:
      'AWS access key in apps/mobile/__tests__/wf/be-mobile-security-secrets.test.ts',
    relativePath: 'apps/mobile/__tests__/wf/be-mobile-security-secrets.test.ts',
    content: `const leaked = "${AWS_ACCESS_KEY}";\nexport default leaked;\n`,
  },
  {
    title: 'RevenueCat secret key in a supabase/functions/api/__wf__ test',
    relativePath: 'supabase/functions/api/__wf__/adv_planted.test.ts',
    content: `Deno.env.set("RC_SERVER_VALUE_API_KEY", "${RC_SERVER_VALUE}");\n`,
  },
  {
    title: 'Stripe live secret in a supabase/functions/api/__wf__ test',
    relativePath: 'supabase/functions/api/__wf__/adv_planted_stripe.test.ts',
    content: `const upstream = "${STRIPE_LIVE_VALUE}";\nexport default upstream;\n`,
  },
  {
    title:
      'generic high-entropy api_key (not a *secret-0123456789 fixture) in a services/api test',
    relativePath: 'services/api/test/adv_planted.test.ts',
    content: GENERIC_API_KEY_LINE,
  },
];

// Same credential, same directory, a file name no allowlist names.
const SIBLING_PLANTS: Plant[] = [
  {
    title: 'Supabase secret key in docs/OTHER.md (sibling of DISTRIBUTION.md)',
    relativePath: 'docs/OTHER.md',
    content: `# Other\n\nSUPABASE_SERVICE_KEY=${SB_SERVICE_VALUE}\n`,
  },
  {
    title:
      'AWS access key in apps/mobile/src/config/other.ts (sibling of runtimeConfig.ts)',
    relativePath: 'apps/mobile/src/config/other.ts',
    content: `export const uploads = "${AWS_ACCESS_KEY}";\n`,
  },
  {
    title:
      'Stripe live secret in supabase/functions/api/other.ts (outside __wf__)',
    relativePath: 'supabase/functions/api/other.ts',
    content: `const upstream = "${STRIPE_LIVE_VALUE}";\nexport default upstream;\n`,
  },
];

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function makeRepo(plant: Plant): string {
  const root = mkdtempSync(path.join(tmpdir(), 'adv-gitleaks-'));
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  copyFileSync(SCAN_SCRIPT, path.join(root, 'scripts', 'security-scan.sh'));
  copyFileSync(GITLEAKS_CONFIG, path.join(root, '.gitleaks.toml'));
  const target = path.join(root, plant.relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, plant.content);
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  return root;
}

function runGate(root: string): { status: number | null; output: string } {
  const result = spawnSync(
    'bash',
    [path.join(root, 'scripts', 'security-scan.sh'), '--tree'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      timeout: 120_000,
    },
  );
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

describe('INT-security-privacy: secret-scanning gate allowlists', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('gate exits 0 for a repository without secrets (sanity: the gate itself runs)', () => {
    const root = makeRepo({
      title: 'clean',
      relativePath: 'src/clean.ts',
      content: 'export const ok = true;\n',
    });
    roots.push(root);
    const run = runGate(root);
    expect(run.output).toContain('PASS: no secrets detected');
    expect(run.status).toBe(0);
  });

  describe('control: each planted credential shape is detected outside every allowlisted path', () => {
    it.each(CONTROL_PLANTS.map(plant => [plant.title, plant] as const))(
      '%s',
      (_title, plant) => {
        const root = makeRepo(plant);
        roots.push(root);
        const run = runGate(root);
        expect(run.output).toContain('FAIL: secrets detected');
        expect(run.status).toBe(1);
      },
    );
  });

  describe('control: the same credential in an unlisted sibling file is detected', () => {
    it.each(SIBLING_PLANTS.map(plant => [plant.title, plant] as const))(
      '%s',
      (_title, plant) => {
        const root = makeRepo(plant);
        roots.push(root);
        const run = runGate(root);
        expect(run.output).toContain('FAIL: secrets detected');
        expect(run.status).toBe(1);
      },
    );
  });

  describe('attack: a real credential at an allowlisted path (without the fixture string) must still fail the gate', () => {
    it.each(
      ALLOWLISTED_PATH_PLANTS.map(plant => [plant.title, plant] as const),
    )('%s', (_title, plant) => {
      const root = makeRepo(plant);
      roots.push(root);
      const run = runGate(root);
      expect(run.output).toContain('FAIL: secrets detected');
      expect(run.status).toBe(1);
    });
  });
});
