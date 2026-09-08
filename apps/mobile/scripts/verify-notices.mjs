#!/usr/bin/env node
/**
 * Third-party notices verified against a Release JS bundle + source map, on
 * Linux (or any host with Node; no Xcode, no Pods).
 *
 * node scripts/verify-notices.mjs                       # build + verify
 * node scripts/verify-notices.mjs --write               # build + rewrite THIRD_PARTY_NOTICES.md
 * node scripts/verify-notices.mjs --bundle B --source-map M [--write]
 *
 * The default mode reproduces what Xcode's "Bundle React Native code and
 * images" phase does for a Release build of the shipping entry point
 * (index.js): Metro `bundle --platform ios --dev false --minify false`, then
 * `hermesc -emit-binary -O -output-source-map`, then the project composer
 * `src/diagnostics/composeSourceMaps.cjs`. The composed map is the same shape
 * `generate-third-party-notices.mjs --check-app` consumes from a real .app.
 *
 * Verification (all of it must hold, otherwise exit 1):
 *   1. the receipt (`third-party-notices.sources.json`) is valid and bound to
 *      the current lockfiles;
 *   2. the bundle/map pair is a complete Hermes v3 artifact whose debug ID is
 *      embedded in the bundle, with every source path classified against the
 *      locked npm closure (no unknown packages);
 *   3. every npm package observed in the map has verbatim notice text in the
 *      receipt and in the shipped `assets/legal/ThirdPartyNotices.txt`;
 *   4. the observed npm membership (path@version) equals the inventory in
 *      `THIRD_PARTY_NOTICES.md`, and that file is byte-identical to what this
 *      script would regenerate from the receipt for that membership.
 *
 * `--bundle`/`--source-map` verify an existing pair instead of building (used
 * by `__tests__/h05Notices.test.ts`). `--out DIR` chooses where build outputs,
 * logs and `report.json` go (default `<repo>/artifacts/verify-notices`).
 * `--notices PATH` overrides the inventory path.
 *
 * What this does NOT prove: which native pods/frameworks Xcode actually linked
 * into the Mach-O, or that the final archived .app carries the same JS bundle.
 * That is the Mac-plane follow-up: run `generate-third-party-notices.mjs
 * --check-app` against the archived Release .app on the M4 runner. It is not
 * a rights certification or an App Store clearance.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import {
  OUTPUT,
  RECEIPT,
  ROOT,
  coverageProblems,
  freshArtifactProblems,
  inspectArtifact,
  makeArtifactEvidence,
  sha256,
  validateReceipt,
} from './generate-third-party-notices.mjs';

export const NOTICES = 'THIRD_PARTY_NOTICES.md';
export const PLANE = 'linux-js-bundle';
export const ENTRY_FILE = 'index.js';
const HERMESC_BIN = {
  linux: 'linux64-bin',
  darwin: 'osx-bin',
  win32: 'win64-bin',
};
const MEMBER_LINE = /^- `(node_modules\/[^`]+)` `([^`\s]+)`(?: — (.*))?$/;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = values => [...values].sort(cmp);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
const memberKey = member => `${member.path}@${member.version}`;

export function hermescPath(platform = process.platform) {
  const bin = HERMESC_BIN[platform];
  if (!bin) throw new Error(`No hermesc binary for platform ${platform}`);
  return join(
    ROOT,
    'node_modules',
    'hermes-compiler',
    'hermesc',
    bin,
    platform === 'win32' ? 'hermesc.exe' : 'hermesc',
  );
}

function parseArgs(argv) {
  const flags = new Set(['--write']);
  const valued = new Set(['--bundle', '--source-map', '--out', '--notices']);
  const args = { write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (flags.has(arg)) args[arg.slice(2)] = true;
    else if (valued.has(arg)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--'))
        throw new Error(`${arg} requires a path`);
      args[arg.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
      i += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (Boolean(args.bundle) !== Boolean(args.sourceMap))
    throw new Error(
      'Verifying an existing artifact requires both --bundle and --source-map',
    );
  return args;
}

function run(log, command, args, { cwd = ROOT, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  writeFileSync(
    log,
    [
      `$ ${[command, ...args].join(' ')}`,
      `exit: ${result.status ?? `signal ${result.signal}`}`,
      '--- stdout',
      result.stdout ?? '',
      '--- stderr',
      result.stderr ?? '',
    ].join('\n'),
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args[0] ?? ''} exited ${result.status ?? result.signal}; see ${log}`,
    );
}

/** Metro → hermesc → composeSourceMaps.cjs, exactly like the Release Xcode phase. */
export function buildReleaseArtifact(out) {
  mkdirSync(join(out, 'assets'), { recursive: true });
  const node = process.execPath;
  const rn = join(ROOT, 'node_modules', 'react-native');
  const metroBundle = join(out, 'index.jsbundle');
  const packagerMap = join(out, 'main.jsbundle.packager.map');
  const hermesBundle = join(out, 'main.jsbundle');
  const hermesMap = join(out, 'main.jsbundle.hbc.map');
  const composedMap = join(out, 'main.jsbundle.map');
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    CI: '1',
    SENTRY_DISABLE_AUTO_UPLOAD: 'true',
    SENTRY_DISABLE_XCODE_DEBUG_UPLOAD: 'true',
  };
  run(
    join(out, 'metro.log'),
    node,
    [
      join(rn, 'scripts', 'bundle.js'),
      'bundle',
      '--entry-file',
      ENTRY_FILE,
      '--platform',
      'ios',
      '--dev',
      'false',
      '--reset-cache',
      '--bundle-output',
      metroBundle,
      '--assets-dest',
      join(out, 'assets'),
      '--sourcemap-output',
      packagerMap,
      '--minify',
      'false',
      '--config-cmd',
      `'${node}' '${join(rn, 'cli.js')}' config`,
    ],
    { env },
  );
  const hermesc = hermescPath();
  if (!existsSync(hermesc))
    throw new Error(`hermesc not installed at ${hermesc}; run npm ci`);
  run(
    join(out, 'hermesc.log'),
    hermesc,
    [
      '-emit-binary',
      '-max-diagnostic-width=80',
      '-O',
      '-output-source-map',
      '-out',
      hermesBundle,
      metroBundle,
    ],
    { env },
  );
  // hermesc writes `<out bundle>.map`; keep it beside the composed map.
  renameSync(composedMap, hermesMap);
  run(
    join(out, 'compose.log'),
    node,
    [
      join(ROOT, 'src', 'diagnostics', 'composeSourceMaps.cjs'),
      packagerMap,
      hermesMap,
      '-o',
      composedMap,
    ],
    { env },
  );
  return { bundle: hermesBundle, sourceMap: composedMap };
}

export function parseNotices(markdown) {
  const heading = /^## Bundled npm packages \((\d+)\)$/m.exec(markdown);
  if (!heading)
    throw new Error(`${NOTICES} has no "## Bundled npm packages (N)" section`);
  const section = markdown
    .slice(heading.index + heading[0].length)
    .split(/^## /m)[0];
  const members = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('- ')) continue;
    const match = MEMBER_LINE.exec(line);
    if (!match) throw new Error(`${NOTICES}: malformed member line: ${line}`);
    members.push({ path: match[1], version: match[2] });
  }
  const paths = members.map(member => member.path);
  if (
    new Set(paths).size !== paths.length ||
    json(sorted(paths)) !== json(paths)
  )
    throw new Error(`${NOTICES}: member lines must be unique and sorted`);
  return { members, declared: Number(heading[1]) };
}

function componentFor(receipt, id) {
  const component = receipt.components.find(item => item.id === id);
  if (!component) throw new Error(`Receipt has no component ${id}`);
  return component;
}

export function renderNotices(receipt, npmMembers) {
  const members = [...npmMembers].sort((a, b) => cmp(a.path, b.path));
  const natives = receipt.components
    .filter(item => !item.id.startsWith('npm:'))
    .sort((a, b) => cmp(a.id, b.id));
  const memberLine = member => {
    const component = componentFor(receipt, `npm:${member.path}`);
    if (component.version !== member.version)
      throw new Error(
        `Receipt pins ${component.id}@${component.version}, bundle has ${member.version}`,
      );
    const license = component.declaredLicense ?? 'license text only';
    return `- \`${member.path}\` \`${member.version}\` — ${license} (${component.sourceIds.length} notice source${component.sourceIds.length === 1 ? '' : 's'})`;
  };
  return [
    '# Third-party notices — Release JS bundle membership',
    '',
    `Machine-checked inventory of the third-party npm packages whose source files are present in the iOS Release JavaScript bundle of the shipping app (\`apps/mobile\`, entry \`${ENTRY_FILE}\`). It is generated from \`${RECEIPT}\` by \`scripts/verify-notices.mjs --write\` and re-verified by \`node scripts/verify-notices.mjs\`, which builds the Release bundle + composed Hermes source map on Linux, enumerates the packages the map references, and fails if this inventory, the receipt or the shipped \`${OUTPUT}\` disagree with the bundle.`,
    '',
    'Do not edit by hand: the verifier compares this file byte for byte with what it regenerates.',
    '',
    '## What is verified',
    '',
    '- Every source path in the composed Release source map is classified against the locked npm closure (`package-lock.json`); an unknown package fails the check.',
    '- Every npm package below has verbatim notice/license text recorded in the receipt and emitted in the shipped `' +
      OUTPUT +
      '` (`Component: npm:<path>` section).',
    '- The membership below is exactly the set observed in the fresh Release bundle: a package that stops shipping or starts shipping fails the check until this file is regenerated (and, for a new package, until its notice is captured with `generate-third-party-notices.mjs`).',
    '- The source map is a complete, flattened v3 map whose debug ID is embedded in the Hermes bundle it was produced with.',
    '',
    '## What is not verified here (Mac-plane follow-up)',
    '',
    '- Which CocoaPods/SwiftPM/xcframework components Xcode actually linked into the Mach-O, and that the archived `.app` carries the same `main.jsbundle`/map pair. Run `node scripts/generate-third-party-notices.mjs --check-app <PickleSensei.app> --source-map <main.jsbundle.map> --expected-bundle-sha256 <sha> --expected-map-sha256 <sha>` against the Release archive on the Mac runner (`scripts/mac-full-verify.sh`) for that evidence.',
    '- The Linux build uses the npm `hermes-compiler` hermesc, not the Pods `hermes-engine` one, so bytecode hashes differ from an Xcode build; JS membership is decided by Metro and is the same.',
    '- Rights, signature or App Store clearance. Dependency presence is not a rights certification.',
    '',
    `## Bundled npm packages (${members.length})`,
    '',
    'Format: `<lock path>` `<locked version>` — declared license (notice sources in the receipt).',
    '',
    ...members.map(memberLine),
    '',
    `## Native components in the receipt (${natives.length}, not verified by this script)`,
    '',
    'Candidates from `ios/Podfile.lock`, the vendored Sentry xcframework and bundled fonts; their notices are in the shipped `' +
      OUTPUT +
      '`. Linked-binary membership requires the Mac-plane check above.',
    '',
    ...natives.map(
      item =>
        `- \`${item.id}\` \`${item.version}\`${item.declaredLicense ? ` — ${item.declaredLicense}` : ''}`,
    ),
    '',
  ].join('\n');
}

function diffMembership(observed, listed) {
  const observedKeys = new Map(observed.map(member => [member.path, member]));
  const listedKeys = new Map(listed.map(member => [member.path, member]));
  return {
    bundledNotListed: observed
      .filter(member => !listedKeys.has(member.path))
      .map(({ path, version }) => ({ path, version })),
    listedNotBundled: listed.filter(member => !observedKeys.has(member.path)),
    versionDrift: observed
      .filter(
        member =>
          listedKeys.has(member.path) &&
          listedKeys.get(member.path).version !== member.version,
      )
      .map(member => ({
        path: member.path,
        bundled: member.version,
        listed: listedKeys.get(member.path).version,
      })),
  };
}

export function verify({
  receipt,
  bundleBytes,
  mapBytes,
  noticesText,
  write = false,
}) {
  const problems = [...validateReceipt(receipt)];
  const observed = inspectArtifact(
    receipt,
    mapBytes,
    bundleBytes,
    sha256(bundleBytes),
  );
  const npmMembers = observed.npmMembers.map(({ path, version }) => ({
    path,
    version,
  }));
  let artifact = null;
  try {
    artifact = makeArtifactEvidence(receipt, observed, {
      kind: 'current-build',
      label: `${PLANE}-verification`,
    });
  } catch (error) {
    problems.push(...error.message.split('; '));
  }
  if (artifact)
    problems.push(
      ...freshArtifactProblems(receipt, artifact),
      ...coverageProblems(receipt, { artifact }),
    );

  const shipped = readFileSync(join(ROOT, OUTPUT), 'utf8');
  for (const member of npmMembers) {
    if (!shipped.includes(`\nComponent: npm:${member.path}\n`))
      problems.push(
        `Bundled package has no section in ${OUTPUT}: ${memberKey(member)}`,
      );
  }

  let listed = [];
  let diff = { bundledNotListed: [], listedNotBundled: [], versionDrift: [] };
  let expectedNotices = null;
  if (write) {
    expectedNotices = renderNotices(receipt, npmMembers);
  } else if (noticesText === null) {
    problems.push(`${NOTICES} is missing; run with --write to create it`);
  } else {
    try {
      const parsed = parseNotices(noticesText);
      listed = parsed.members;
      if (parsed.declared !== listed.length)
        problems.push(
          `${NOTICES}: heading declares ${parsed.declared} packages, found ${listed.length}`,
        );
    } catch (error) {
      problems.push(error.message);
    }
    diff = diffMembership(npmMembers, listed);
    for (const member of diff.bundledNotListed)
      problems.push(
        `bundled but not listed in ${NOTICES}: ${memberKey(member)}`,
      );
    for (const member of diff.listedNotBundled)
      problems.push(
        `listed in ${NOTICES} but not bundled: ${memberKey(member)}`,
      );
    for (const drift of diff.versionDrift)
      problems.push(
        `version drift for ${drift.path}: bundled ${drift.bundled}, listed ${drift.listed}`,
      );
    try {
      if (renderNotices(receipt, npmMembers) !== noticesText)
        problems.push(
          `${NOTICES} differs from the regenerated inventory; run scripts/verify-notices.mjs --write`,
        );
    } catch (error) {
      problems.push(error.message);
    }
  }

  const unique = sorted(new Set(problems));
  return {
    schemaVersion: 1,
    plane: PLANE,
    verdict: unique.length ? 'mismatch' : 'match',
    bundle: observed.bundle,
    sourceMap: observed.sourceMap,
    sourceCount: observed.sourceCount,
    npmMembers,
    listedCount: write ? npmMembers.length : listed.length,
    diff,
    problems: unique,
    expectedNotices,
    followUp: [
      `Mac plane: node scripts/generate-third-party-notices.mjs --check-app <PickleSensei.app> --source-map <main.jsbundle.map> --expected-bundle-sha256 <sha> --expected-map-sha256 <sha> on the archived Release app (scripts/mac-full-verify.sh).`,
      'This run proves JS bundle membership only; not native linkage, rights or App Store clearance.',
    ],
  };
}

function main(argv) {
  const args = parseArgs(argv);
  const out = resolve(
    args.out ?? join(ROOT, '..', '..', 'artifacts', 'verify-notices'),
  );
  mkdirSync(out, { recursive: true });
  const noticesPath = resolve(args.notices ?? join(ROOT, NOTICES));
  const receipt = readJSON(join(ROOT, RECEIPT));

  const paths = args.bundle
    ? { bundle: resolve(args.bundle), sourceMap: resolve(args.sourceMap) }
    : buildReleaseArtifact(out);
  const bundleBytes = readFileSync(paths.bundle);
  const mapBytes = readFileSync(paths.sourceMap);
  const report = verify({
    receipt,
    bundleBytes,
    mapBytes,
    noticesText: existsSync(noticesPath)
      ? readFileSync(noticesPath, 'utf8')
      : null,
    write: args.write,
  });
  const { expectedNotices, ...persisted } = report;
  if (args.write && !report.problems.length) {
    writeFileSync(noticesPath, expectedNotices);
  }
  writeFileSync(
    join(out, 'report.json'),
    json({
      ...persisted,
      built: !args.bundle,
      artifactPaths: {
        bundle: relative(ROOT, paths.bundle),
        sourceMap: relative(ROOT, paths.sourceMap),
      },
      notices: relative(ROOT, noticesPath),
    }),
  );
  for (const problem of report.problems) console.error(`FAIL ${problem}`);
  if (report.problems.length) {
    console.error(
      `NOTICES MISMATCH: ${report.problems.length} issue(s); report ${relative(process.cwd(), join(out, 'report.json'))}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `${args.write ? `Wrote ${relative(process.cwd(), noticesPath)}; ` : ''}Release JS bundle membership matches ${NOTICES}: ${report.npmMembers.length} npm packages, ${report.sourceCount} mapped sources, bundle ${report.bundle.sha256}, map ${report.sourceMap.sha256} (${PLANE}). Native/Mac membership is a separate --check-app step; no rights or App Store clearance is claimed.`,
  );
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}
