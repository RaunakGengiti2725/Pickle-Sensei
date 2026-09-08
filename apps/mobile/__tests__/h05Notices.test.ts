/**
 * H05-01 — third-party notices verified against a Release JS bundle + source
 * map.
 *
 * `scripts/verify-notices.mjs` builds the iOS Release JS bundle the way the
 * Xcode "Bundle React Native code and images" phase does (Metro → hermesc →
 * composeSourceMaps.cjs), enumerates the npm packages whose sources are in
 * the composed map and diffs them against `THIRD_PARTY_NOTICES.md`, the
 * committed membership inventory. The committed inventory in turn must be
 * covered by the shipped `assets/legal/ThirdPartyNotices.txt`.
 *
 * The build itself takes ~40s, so these tests exercise the same script with
 * `--bundle`/`--source-map` (skip the build; verify an existing pair) against
 * synthetic Hermes-shaped artifacts derived from the committed inventory.
 * The acceptance command `node scripts/verify-notices.mjs` runs the real
 * build.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mobileRoot = path.resolve(__dirname, '..');
const script = path.join(mobileRoot, 'scripts', 'verify-notices.mjs');
const noticesPath = path.join(mobileRoot, 'THIRD_PARTY_NOTICES.md');
const receiptPath = path.join(
  mobileRoot,
  'scripts',
  'third-party-notices.sources.json',
);
const shippedNoticesPath = path.join(
  mobileRoot,
  'assets',
  'legal',
  'ThirdPartyNotices.txt',
);

const DEBUG_ID = '0f3b6c2e-1a4d-4e5f-8a9b-0c1d2e3f4a5b';
const HERMES_MAGIC = 'c61fbc03c103191f';

interface Member {
  path: string;
  version: string;
}

interface ReceiptComponent {
  id: string;
  version: string;
  lockPath?: string;
  sourceIds: string[];
}

interface Receipt {
  components: ReceiptComponent[];
}

interface Report {
  verdict: string;
  plane: string;
  bundle: { sha256: string; hermesVersion: number };
  sourceMap: { debugIDs: string[] };
  npmMembers: Member[];
  diff: {
    bundledNotListed: Member[];
    listedNotBundled: Member[];
    versionDrift: { path: string; bundled: string; listed: string }[];
  };
  problems: string[];
  followUp: string[];
}

/** Rows of the "Bundled npm packages" section of THIRD_PARTY_NOTICES.md. */
function parseListedMembers(markdown: string): Member[] {
  const section = markdown
    .split(/^## /m)
    .find(part => part.startsWith('Bundled npm packages'));
  if (!section) return [];
  const members: Member[] = [];
  for (const line of section.split('\n')) {
    const match = /^- `(node_modules\/[^`]+)` `([^`]+)`/.exec(line);
    if (match && match[1] && match[2])
      members.push({ path: match[1], version: match[2] });
  }
  return members;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hermesBundle(debugId: string): Buffer {
  const header = Buffer.alloc(32);
  Buffer.from(HERMES_MAGIC, 'hex').copy(header, 0);
  header.writeUInt32LE(98, 8);
  return Buffer.concat([
    header,
    Buffer.from(`__debugid__ ${debugId} `),
    Buffer.alloc(64, 0),
  ]);
}

/**
 * A complete flattened v3 map: one source per mapped line, every source
 * referenced by exactly one segment (`AAAA`, then `ACAA` = source index + 1).
 */
function sourceMap(
  members: Member[],
  extraNodeModuleFiles: string[] = [],
  debugId: string = DEBUG_ID,
): Buffer {
  const root = '/build/apps/mobile';
  const sources = [
    `${root}/index.js`,
    `${root}/App.tsx`,
    ...members.map(member => `${root}/${member.path}/index.js`),
    ...extraNodeModuleFiles.map(file => `${root}/${file}`),
  ];
  const mappings = ['AAAA', ...sources.slice(1).map(() => 'ACAA')].join(';');
  return Buffer.from(
    JSON.stringify({
      version: 3,
      sources,
      sourcesContent: sources.map(source => `// ${source}\n`),
      names: [],
      mappings,
      debugId,
      debug_id: debugId,
    }),
  );
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  report: Report | null;
}

function runVerify(
  dir: string,
  args: string[],
  pair: { bundle: Buffer; map: Buffer },
): RunResult {
  const bundlePath = path.join(dir, 'main.jsbundle');
  const mapPath = path.join(dir, 'main.jsbundle.map');
  writeFileSync(bundlePath, pair.bundle);
  writeFileSync(mapPath, pair.map);
  const outDir = path.join(dir, 'out');
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--bundle',
      bundlePath,
      '--source-map',
      mapPath,
      '--out',
      outDir,
      ...args,
    ],
    { cwd: mobileRoot, encoding: 'utf8', timeout: 25000 },
  );
  let report: Report | null = null;
  try {
    report = JSON.parse(
      readFileSync(path.join(outDir, 'report.json'), 'utf8'),
    ) as Report;
  } catch {
    report = null;
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    report,
  };
}

const committed = existsSync(noticesPath)
  ? readFileSync(noticesPath, 'utf8')
  : '';
const listed = parseListedMembers(committed);
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
const shipped = readFileSync(shippedNoticesPath, 'utf8');

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'h05-notices-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('THIRD_PARTY_NOTICES.md (committed inventory)', () => {
  it('lists the Release bundle membership with the app runtime anchors', () => {
    expect(listed.length).toBeGreaterThan(1);
    const paths = listed.map(member => member.path);
    expect(paths).toContain('node_modules/react');
    expect(paths).toContain('node_modules/react-native');
    expect(new Set(paths).size).toBe(paths.length);
    expect([...paths].sort()).toEqual(paths);
  });

  it('every listed package is a locked receipt component with notice sources', () => {
    expect(listed.length).toBeGreaterThan(1);
    for (const member of listed) {
      const component = receipt.components.find(
        item => item.id === `npm:${member.path}`,
      );
      expect(component?.lockPath).toBe(member.path);
      expect(component?.version).toBe(member.version);
      expect(component?.sourceIds.length).toBeGreaterThan(0);
    }
  });

  it('every listed package has its notice in the shipped ThirdPartyNotices.txt', () => {
    expect(listed.length).toBeGreaterThan(1);
    for (const member of listed) {
      expect(shipped).toContain(`\nComponent: npm:${member.path}\n`);
    }
  });

  it('states the Mac-plane follow-up instead of claiming binary membership', () => {
    expect(committed).toMatch(/--check-app/);
    expect(committed).toMatch(/Mac/);
    expect(committed).not.toMatch(
      /certif(?:ies|ied) the (?:shipped|final) binary/i,
    );
  });
});

describe('scripts/verify-notices.mjs against an existing bundle/map pair', () => {
  it('passes when the map membership equals THIRD_PARTY_NOTICES.md and writes a report', () => {
    const run = runVerify(dir, [], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed),
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/membership matches THIRD_PARTY_NOTICES\.md/);
    expect(run.report).not.toBeNull();
    const report = run.report as Report;
    expect(report.verdict).toBe('match');
    expect(report.plane).toBe('linux-js-bundle');
    expect(report.npmMembers).toEqual(listed);
    expect(report.diff).toEqual({
      bundledNotListed: [],
      listedNotBundled: [],
      versionDrift: [],
    });
    expect(report.problems).toEqual([]);
    expect(report.sourceMap.debugIDs).toEqual([DEBUG_ID]);
    expect(report.bundle.sha256).toBe(sha256(hermesBundle(DEBUG_ID)));
    expect(report.followUp.join('\n')).toMatch(/--check-app/);
  });

  it('fails when a listed package is not in the bundle (stale notice inventory)', () => {
    const dropped = listed.find(
      member => member.path !== 'node_modules/react',
    ) as Member;
    const run = runVerify(dir, [], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed.filter(member => member !== dropped)),
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(
      new RegExp(
        `listed in THIRD_PARTY_NOTICES\\.md but not bundled: ${dropped.path}@${dropped.version}`,
      ),
    );
    expect(run.report?.verdict).toBe('mismatch');
    expect(run.report?.diff.listedNotBundled).toEqual([dropped]);
  });

  it('fails when a bundled package is missing from THIRD_PARTY_NOTICES.md', () => {
    const missing = listed.find(
      member => member.path !== 'node_modules/react',
    ) as Member;
    const truncated = committed
      .split('\n')
      .filter(line => !line.startsWith(`- \`${missing.path}\` `))
      .join('\n');
    const alternate = path.join(dir, 'THIRD_PARTY_NOTICES.md');
    writeFileSync(alternate, truncated);
    const run = runVerify(dir, ['--notices', alternate], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed),
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(
      new RegExp(
        `bundled but not listed in THIRD_PARTY_NOTICES\\.md: ${missing.path}@${missing.version}`,
      ),
    );
    expect(run.report?.diff.bundledNotListed).toEqual([missing]);
  });

  it('fails closed on a bundled path outside the locked dependency closure', () => {
    const run = runVerify(dir, [], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed, ['node_modules/h05-unlocked-package/index.js']),
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/unclassified source paths/);
  });

  it('fails when the source-map debug ID is not embedded in the bundle', () => {
    const run = runVerify(dir, [], {
      bundle: hermesBundle('11111111-2222-4333-8444-555555555555'),
      map: sourceMap(listed),
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/debug ID/i);
  });

  it('--write regenerates THIRD_PARTY_NOTICES.md byte-identically from the receipt', () => {
    const alternate = path.join(dir, 'THIRD_PARTY_NOTICES.md');
    const run = runVerify(dir, ['--notices', alternate, '--write'], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed),
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(readFileSync(alternate, 'utf8')).toBe(committed);
  });

  it('refuses a half-specified pair instead of silently building', () => {
    const result = spawnSync(
      process.execPath,
      [script, '--bundle', path.join(dir, 'main.jsbundle')],
      { cwd: mobileRoot, encoding: 'utf8', timeout: 25000 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--source-map/);
  });
});
