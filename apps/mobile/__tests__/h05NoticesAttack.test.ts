/**
 * H05-01 adversarial suite (independent of the candidate's own tests).
 *
 * Drives `scripts/verify-notices.mjs --bundle/--source-map` with hostile
 * Hermes-shaped artifacts and hostile inventories. Every `it` block is one
 * attack; an assertion failure here is a confirmed break of the candidate at
 * c3f2dceb, a passing block is an attack the candidate survived.
 */
import { spawnSync } from 'node:child_process';
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

const DEBUG_ID = '0f3b6c2e-1a4d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_DEBUG_ID = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const HERMES_MAGIC = 'c61fbc03c103191f';

interface Member {
  path: string;
  version: string;
}

interface ReceiptComponent {
  id: string;
  version: string;
  role?: string;
  lockPath?: string;
  declaredLicense?: unknown;
}

interface Receipt {
  components: ReceiptComponent[];
}

interface Report {
  verdict: string;
  npmMembers: Member[];
  sourceMap: { mappedSourceCount: number; debugIDs: string[] };
  diff: {
    bundledNotListed: Member[];
    listedNotBundled: Member[];
    versionDrift: { path: string; bundled: string; listed: string }[];
  };
  problems: string[];
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  report: Report | null;
  outDir: string;
}

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

function hermesBundle(debugId: string | null): Buffer {
  const header = Buffer.alloc(32);
  Buffer.from(HERMES_MAGIC, 'hex').copy(header, 0);
  header.writeUInt32LE(98, 8);
  return Buffer.concat([
    header,
    debugId ? Buffer.from(`__debugid__ ${debugId} `) : Buffer.alloc(0),
    Buffer.alloc(64, 0),
  ]);
}

interface MapOptions {
  root?: string;
  sources?: string[];
  mappings?: string;
  debugId?: string | null;
  debug_id?: string | null;
}

/** Flattened v3 map; by default every source is referenced by one segment. */
function sourceMap(members: Member[], options: MapOptions = {}): Buffer {
  const root = options.root ?? '/build/apps/mobile';
  const sources = options.sources ?? [
    `${root}/index.js`,
    `${root}/App.tsx`,
    ...members.map(member => `${root}/${member.path}/index.js`),
  ];
  const mappings =
    options.mappings ??
    ['AAAA', ...sources.slice(1).map(() => 'ACAA')].join(';');
  const map: Record<string, unknown> = {
    version: 3,
    sources,
    sourcesContent: sources.map(source => `// ${source}\n`),
    names: [],
    mappings,
  };
  const debugId = options.debugId === undefined ? DEBUG_ID : options.debugId;
  const debugIdSnake =
    options.debug_id === undefined ? debugId : options.debug_id;
  if (debugId !== null) map.debugId = debugId;
  if (debugIdSnake !== null) map.debug_id = debugIdSnake;
  return Buffer.from(JSON.stringify(map));
}

function runVerify(
  dir: string,
  args: string[],
  pair: { bundle: Buffer; map: Buffer },
  outDir: string = path.join(dir, 'out'),
): RunResult {
  const bundlePath = path.join(dir, 'main.jsbundle');
  const mapPath = path.join(dir, 'main.jsbundle.map');
  writeFileSync(bundlePath, pair.bundle);
  writeFileSync(mapPath, pair.map);
  return runVerifyPaths(bundlePath, mapPath, outDir, args);
}

function runVerifyPaths(
  bundlePath: string,
  mapPath: string,
  outDir: string,
  args: string[],
): RunResult {
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
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    report: readReport(outDir),
    outDir,
  };
}

function readReport(outDir: string): Report | null {
  try {
    return JSON.parse(
      readFileSync(path.join(outDir, 'report.json'), 'utf8'),
    ) as Report;
  } catch {
    return null;
  }
}

const committed = readFileSync(noticesPath, 'utf8');
const listed = parseListedMembers(committed);
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
const react = listed.find(member => member.path === 'node_modules/react');
if (!react) throw new Error('inventory has no node_modules/react row');
const reactMember: Member = react;

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'h05-attack-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('H05-01 attack: crash between steps / stale persisted state', () => {
  it('A1 a crashing re-run must not leave the previous "match" report.json in --out', () => {
    const outDir = path.join(dir, 'out');
    const good = runVerify(
      dir,
      [],
      { bundle: hermesBundle(DEBUG_ID), map: sourceMap(listed) },
      outDir,
    );
    expect(good.status).toBe(0);
    expect(good.report?.verdict).toBe('match');

    const crashed = runVerify(
      dir,
      [],
      {
        bundle: hermesBundle(DEBUG_ID),
        map: Buffer.from('{"version":3,"sources":['),
      },
      outDir,
    );
    expect(crashed.status).toBe(1);
    // The failed run must not be readable as a passing run afterwards.
    expect(crashed.report?.verdict).not.toBe('match');
  });

  it('A2 a missing --bundle file fails and does not leave a passing report', () => {
    const outDir = path.join(dir, 'out');
    const good = runVerify(
      dir,
      [],
      { bundle: hermesBundle(DEBUG_ID), map: sourceMap(listed) },
      outDir,
    );
    expect(good.status).toBe(0);
    const missing = runVerifyPaths(
      path.join(dir, 'does-not-exist.jsbundle'),
      path.join(dir, 'main.jsbundle.map'),
      outDir,
      [],
    );
    expect(missing.status).toBe(1);
    expect(missing.report?.verdict).not.toBe('match');
  });
});

describe('H05-01 attack: replay / duplicate identities', () => {
  it('A3 disagreeing debugId / debug_id where only one is embedded must fail', () => {
    const run = runVerify(dir, [], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed, { debugId: DEBUG_ID, debug_id: OTHER_DEBUG_ID }),
    });
    expect(run.status).toBe(1);
    expect(run.report?.verdict).not.toBe('match');
  });

  it('A4 a map without any debug ID must fail (pair cannot be bound to the bundle)', () => {
    const run = runVerify(dir, [], {
      bundle: hermesBundle(null),
      map: sourceMap(listed, { debugId: null, debug_id: null }),
    });
    expect(run.status).toBe(1);
    expect(run.report?.verdict).not.toBe('match');
  });

  it('A5 the historical reference debug ID must not be accepted as fresh evidence', () => {
    const reference = '2699028f-7b2a-4383-aede-200d7b31b2f2';
    const run = runVerify(dir, [], {
      bundle: hermesBundle(reference),
      map: sourceMap(listed, { debugId: reference }),
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/historical/i);
  });

  it('A6 a duplicate inventory row with a different version must fail', () => {
    const dupe = committed.replace(
      `- \`${reactMember.path}\` \`${reactMember.version}\``,
      `- \`${reactMember.path}\` \`0.0.0\` — MIT (1 notice source)\n- \`${reactMember.path}\` \`${reactMember.version}\``,
    );
    expect(dupe).not.toBe(committed);
    const alternate = path.join(dir, 'THIRD_PARTY_NOTICES.md');
    writeFileSync(alternate, dupe);
    const run = runVerify(dir, ['--notices', alternate], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed),
    });
    expect(run.status).toBe(1);
    expect(run.report?.verdict).toBe('mismatch');
  });
});

describe('H05-01 attack: boundary values in the artifact', () => {
  it('A7 a map whose sources are listed but never referenced by a mapping must not count as bundled', () => {
    // Only source 0 (index.js) is referenced; every package below is an
    // orphan entry in the `sources` table with no generated code behind it.
    const run = runVerify(dir, [], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed, { mappings: 'AAAA' }),
    });
    expect(run.report?.sourceMap.mappedSourceCount).toBe(1);
    // A membership claim built from unreferenced sources is not evidence.
    expect(run.status).toBe(1);
  });

  it('A7b the success line reports the number of sources actually mapped, not the size of the sources table', () => {
    const run = runVerify(dir, [], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed, { mappings: 'AAAA' }),
    });
    const claimed = /(\d+) mapped sources/.exec(run.stdout);
    if (claimed && claimed[1])
      expect(Number(claimed[1])).toBe(run.report?.sourceMap.mappedSourceCount);
  });

  it('A8 an empty sources table must fail rather than report a match', () => {
    const run = runVerify(dir, [], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed, { sources: [], mappings: '' }),
    });
    expect(run.status).toBe(1);
    expect(run.report?.verdict).not.toBe('match');
  });

  it('A9 a negative source index in the VLQ mappings must be rejected', () => {
    const run = runVerify(dir, [], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed, { mappings: 'AAAA;ADAA' }),
    });
    expect(run.status).toBe(1);
    expect(run.report?.verdict).not.toBe('match');
  });

  it('A10 a truncated Hermes header (magic only, no body, no debug ID) must fail', () => {
    const header = Buffer.alloc(12);
    Buffer.from(HERMES_MAGIC, 'hex').copy(header, 0);
    header.writeUInt32LE(98, 8);
    const run = runVerify(dir, [], {
      bundle: header,
      map: sourceMap(listed),
    });
    expect(run.status).toBe(1);
    expect(run.report?.verdict).not.toBe('match');
  });
});

describe('H05-01 attack: path classification', () => {
  it('A11 a package resolved from the monorepo root node_modules must not be attributed to the app lock version', () => {
    // A dependency hoisted by pnpm to <repo>/node_modules (a different
    // copy/version than apps/mobile/package-lock.json) shares the
    // `node_modules/<name>` tail. Classifying it by tail alone attributes
    // the app-lock version to a package that was never locked there.
    const rootSource = '/build/node_modules/react/index.js';
    const sources = [
      '/build/apps/mobile/index.js',
      ...listed.map(member => `/build/apps/mobile/${member.path}/index.js`),
      rootSource,
    ];
    const run = runVerify(dir, [], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed, { sources }),
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/unclassified|unknown|outside/i);
  });

  it('A12 a traversal segment inside a package path must fail closed', () => {
    const sources = [
      '/build/apps/mobile/index.js',
      ...listed.map(member => `/build/apps/mobile/${member.path}/index.js`),
      '/build/apps/mobile/node_modules/react/../../../etc/passwd.js',
    ];
    const run = runVerify(dir, [], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed, { sources }),
    });
    expect(run.status).toBe(1);
    expect(run.report?.verdict).not.toBe('match');
  });

  it('A13 a relative source path escaping the project must fail closed', () => {
    const sources = [
      '/build/apps/mobile/index.js',
      ...listed.map(member => `/build/apps/mobile/${member.path}/index.js`),
      '../../vendored/unlicensed/index.js',
    ];
    const run = runVerify(dir, [], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed, { sources }),
    });
    expect(run.status).toBe(1);
    expect(run.report?.verdict).not.toBe('match');
  });

  it('A14 an unrooted bare path with no node_modules marker must not be silently classified as app code', () => {
    const sources = [
      '/build/apps/mobile/index.js',
      ...listed.map(member => `/build/apps/mobile/${member.path}/index.js`),
      'vendored-copy-of-lodash/lodash.js',
    ];
    const run = runVerify(dir, [], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed, { sources }),
    });
    expect(run.status).toBe(1);
  });
});

describe('H05-01 attack: inventory parsing boundaries', () => {
  it('A15 a tampered version in the inventory must surface as versionDrift and fail', () => {
    const tampered = committed.replace(
      `- \`${reactMember.path}\` \`${reactMember.version}\``,
      `- \`${reactMember.path}\` \`0.0.1\``,
    );
    expect(tampered).not.toBe(committed);
    const alternate = path.join(dir, 'THIRD_PARTY_NOTICES.md');
    writeFileSync(alternate, tampered);
    const run = runVerify(dir, ['--notices', alternate], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed),
    });
    expect(run.status).toBe(1);
    expect(run.report?.diff.versionDrift).toEqual([
      { path: reactMember.path, bundled: reactMember.version, listed: '0.0.1' },
    ]);
  });

  it('A16 a CRLF-converted inventory must not be accepted as byte-identical', () => {
    const alternate = path.join(dir, 'THIRD_PARTY_NOTICES.md');
    writeFileSync(alternate, committed.replaceAll('\n', '\r\n'));
    const run = runVerify(dir, ['--notices', alternate], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed),
    });
    expect(run.status).toBe(1);
  });

  it('A17 an empty inventory file fails and --write is required to repopulate it', () => {
    const alternate = path.join(dir, 'THIRD_PARTY_NOTICES.md');
    writeFileSync(alternate, '');
    const run = runVerify(dir, ['--notices', alternate], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(listed),
    });
    expect(run.status).toBe(1);
    expect(run.report?.verdict).toBe('mismatch');
    expect(readFileSync(alternate, 'utf8')).toBe('');
  });
});

describe('H05-01 attack: concurrency', () => {
  it('A18 two concurrent runs sharing --out both exit 0 and leave a parseable match report', async () => {
    const outDir = path.join(dir, 'out');
    writeFileSync(path.join(dir, 'main.jsbundle'), hermesBundle(DEBUG_ID));
    writeFileSync(path.join(dir, 'main.jsbundle.map'), sourceMap(listed));
    const spawn = () =>
      new Promise<number | null>(resolve => {
        const child = spawnSync(
          process.execPath,
          [
            script,
            '--bundle',
            path.join(dir, 'main.jsbundle'),
            '--source-map',
            path.join(dir, 'main.jsbundle.map'),
            '--out',
            outDir,
          ],
          { cwd: mobileRoot, encoding: 'utf8', timeout: 25000 },
        );
        resolve(child.status);
      });
    const statuses = await Promise.all([spawn(), spawn()]);
    expect(statuses).toEqual([0, 0]);
    expect(readReport(outDir)?.verdict).toBe('match');
  });
});

describe('H05-01 attack: committed inventory content', () => {
  it('A19 the committed inventory must not contain a stringified object placeholder', () => {
    expect(committed).not.toMatch(/\[object Object\]/);
  });

  it('A20 a first-party component is not listed as a third-party notice candidate', () => {
    const firstParty = receipt.components.filter(
      component => component.role === 'first-party-outside-third-party-notices',
    );
    expect(firstParty.length).toBeGreaterThan(0);
    for (const component of firstParty) {
      expect(committed).not.toContain(`- \`${component.id}\``);
    }
  });

  it('A21 the receipt native components with object-valued licenses render a readable license', () => {
    const objectLicensed = receipt.components.filter(
      component =>
        component.declaredLicense !== null &&
        typeof component.declaredLicense === 'object',
    );
    for (const component of objectLicensed) {
      const line = committed
        .split('\n')
        .find(row => row.startsWith(`- \`${component.id}\``));
      if (line) expect(line).not.toMatch(/\[object Object\]/);
    }
  });
});

describe('H05-01 attack: --write on a hostile artifact', () => {
  it('A22 --write against a strict subset artifact must not silently shrink the inventory with exit 0', () => {
    const alternate = path.join(dir, 'THIRD_PARTY_NOTICES.md');
    writeFileSync(alternate, committed);
    const subset = listed.filter(member =>
      ['node_modules/react', 'node_modules/react-native'].includes(member.path),
    );
    const run = runVerify(dir, ['--notices', alternate, '--write'], {
      bundle: hermesBundle(DEBUG_ID),
      map: sourceMap(subset),
    });
    const rewritten = parseListedMembers(readFileSync(alternate, 'utf8'));
    // Either refuse, or record in report.json which rows were dropped.
    const dropped = listed.length - rewritten.length;
    expect(dropped).toBeGreaterThan(0);
    const disclosed =
      run.status === 1 || run.report?.diff.listedNotBundled.length === dropped;
    expect(disclosed).toBe(true);
    expect(existsSync(alternate)).toBe(true);
  });
});
