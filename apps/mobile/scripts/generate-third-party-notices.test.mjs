import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import {
  ROOT,
  RECEIPT,
  OUTPUT,
  PRIVACY_DIR,
  PRIVACY_WRAPPER,
  SENTRY_PRIVACY,
  VENDOR_PRIVACY_SHA256,
  REFERENCE_BUNDLE_SHA256,
  REFERENCE_MAP_SHA256,
  artifactProblems,
  candidateArtifact,
  checkResources,
  coverageProblems,
  dependencyPath,
  fontProvenanceProblems,
  freshArtifactProblems,
  inspectArtifact,
  makeArtifactEvidence,
  mappingSourceIndices,
  mapMembership,
  recordArtifactEvidence,
  selectedNpmPaths,
  fontNames,
  hasLicenseText,
  licenseCommentBlocks,
  npmClosure,
  parsePodVersions,
  readmeLicenseSection,
  renderNotices,
  resourceBytes,
  sha256,
  tarFiles,
  validateReceipt,
} from './generate-third-party-notices.mjs';

const { structuredClone } = globalThis;
const receipt = JSON.parse(readFileSync(join(ROOT, RECEIPT), 'utf8'));
const byID = (data, id) => data.components.find(item => item.id === id);
const sourceByID = (data, id) => data.sources.find(source => source.id === id);
const clone = () => structuredClone(receipt);
const mit = sourceByID(receipt, 'local:node_modules/react/LICENSE').text;
const ackID =
  'local:ios/Pods/Target Support Files/Pods-PickleSensei/Pods-PickleSensei-acknowledgements.markdown';
const swiftLockPath =
  'ios/PickleSensei.xcworkspace/xcshareddata/swiftpm/Package.resolved';

function rawSection(rendered, source) {
  const prefix = Buffer.from(
    `--- BEGIN UNMODIFIED SOURCE: ${source.id}\nSHA-256: ${source.sha256}\n`,
  );
  const at = rendered.indexOf(prefix);
  assert.notEqual(at, -1, `missing rendered legal source ${source.id}`);
  return rendered.subarray(
    at + prefix.length,
    at + prefix.length + source.bytes,
  );
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pickle-notice-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the current receipt validates locked identities, source hashes and coverage classifications offline', () => {
  assert.deepEqual(validateReceipt(receipt, { installed: false }), []);
  assert.ok(receipt.components.length > 600);
  assert.ok(receipt.sources.length > 600);
  const closure = npmClosure(
    JSON.parse(readFileSync(join(ROOT, 'package-lock.json'))),
  );
  assert.deepEqual(closure.missing, []);
  assert.equal(
    receipt.components.filter(item => item.id.startsWith('npm:')).length,
    closure.paths.length,
  );
  const swiftLock = JSON.parse(readFileSync(join(ROOT, swiftLockPath)));
  assert.deepEqual(swiftLock.pins, []);
  assert.equal(swiftLock.version, 3);
  assert.equal(
    receipt.inputs.find(input => input.path === swiftLockPath).sha256,
    'c5ccefcb6a0670f9b299d9e9635d09da2df8744315f8cd5e826b0c8e491703ed',
  );
  assert.equal(
    receipt.components.filter(item => item.id.startsWith('swiftpm:')).length,
    0,
  );
});

test('rendering preserves every referenced raw LICENSE/NOTICE byte, not just IDs', () => {
  const rendered = renderNotices(receipt);
  const selected = selectedNpmPaths(receipt);
  for (const item of receipt.components) {
    if (item.id.startsWith('npm:') && selected && !selected.has(item.lockPath))
      continue;
    if (
      ['build-tool-only', 'first-party-outside-third-party-notices'].includes(
        item.role,
      )
    )
      continue;
    for (const id of item.sourceIds) {
      const source = sourceByID(receipt, id);
      if (source.kind === 'vendor-privacy-resource') continue;
      assert.ok(
        rawSection(rendered, source).equals(Buffer.from(source.text)),
        id,
      );
      assert.equal(sha256(rawSection(rendered, source)), source.sha256, id);
    }
  }
  assert.ok(
    rendered.includes(
      Buffer.from(
        'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
      ),
    ),
  );
  assert.ok(
    rendered.includes(Buffer.from('SIL OPEN FONT LICENSE Version 1.1')),
  );
  assert.ok(
    rendered.includes(
      Buffer.from('SOURCE TEXT COVERAGE COMPLETE FOR SELECTED MEMBERSHIP'),
    ),
  );
  assert.ok(
    rendered.includes(
      Buffer.from('This reference does not certify a newer binary.'),
    ),
  );
});

test('source and component ordering is deterministic, without timestamps or absolute machine paths', () => {
  const shuffled = clone();
  shuffled.sources.reverse();
  shuffled.components.reverse();
  shuffled.gaps.reverse();
  for (const item of shuffled.components) item.sourceIds.reverse();
  assert.ok(renderNotices(shuffled).equals(renderNotices(receipt)));
  assert.ok(!renderNotices(receipt).includes(Buffer.from(ROOT)));
  assert.ok(!renderNotices(receipt).includes(Buffer.from('/DerivedData/')));
});

test('raw source tampering fails hash validation even if it still looks like a license', () => {
  const changed = clone();
  sourceByID(changed, 'local:node_modules/react/LICENSE').text += '\n';
  assert.ok(
    validateReceipt(changed, { installed: false }).some(error =>
      error.includes('Raw source bytes/hash mismatch'),
    ),
  );
});

test('license IDs, boilerplate pointers and NOTICE alone do not count as a full license', () => {
  assert.equal(hasLicenseText('MIT'), false);
  assert.equal(hasLicenseText('SPDX-License-Identifier: Apache-2.0'), false);
  assert.equal(
    hasLicenseText(
      sourceByID(receipt, 'local:node_modules/walker/LICENSE').text,
    ),
    false,
  );
  assert.equal(
    hasLicenseText(sourceByID(receipt, 'swiftpm:swift-crypto/NOTICE.txt').text),
    false,
  );
  assert.equal(hasLicenseText(mit), true);
  for (const text of [
    'MIT',
    sourceByID(receipt, 'swiftpm:swift-crypto/NOTICE.txt').text,
  ]) {
    const changed = clone();
    const source = sourceByID(changed, 'local:node_modules/react/LICENSE');
    source.text = text;
    source.bytes = Buffer.byteLength(text);
    source.sha256 = sha256(Buffer.from(text));
    assert.ok(
      coverageProblems(changed).some(
        error =>
          error.includes('npm:node_modules/react@') &&
          error.includes('full source license'),
      ),
    );
  }
  const noticeOnly = clone();
  byID(noticeOnly, 'npm:node_modules/react').sourceIds = [
    'swiftpm:swift-crypto/NOTICE.txt',
  ];
  assert.ok(
    coverageProblems(noticeOnly).some(
      error =>
        error.includes('npm:node_modules/react@') &&
        error.includes('full source license'),
    ),
  );
});

test('exact copyright-bearing Apache reference retains original notice plus full versioned terms', () => {
  const walker = byID(receipt, 'npm:node_modules/walker');
  assert.equal(walker.version, '1.0.8');
  assert.ok(walker.licenseReferenceEvidence);
  assert.ok(walker.sourceIds.includes('local:node_modules/walker/LICENSE'));
  assert.ok(walker.sourceIds.includes('local:ios/Pods/GoogleSignIn/LICENSE'));
  assert.ok(
    !coverageProblems(receipt).some(error =>
      error.includes('npm:node_modules/walker@'),
    ),
  );
});

test('npm resolution includes nested versions and installed peers, not every dev dependency', () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { app: '1' }, devDependencies: { unused: '1' } },
      'node_modules/app': {
        version: '1',
        dependencies: { nested: '1', shared: '2' },
        peerDependencies: { peer: '*', absentOptional: '*' },
        peerDependenciesMeta: { absentOptional: { optional: true } },
      },
      'node_modules/nested': { version: '1', dependencies: { shared: '1' } },
      'node_modules/nested/node_modules/shared': { version: '1' },
      'node_modules/shared': { version: '2' },
      'node_modules/peer': { version: '1', dev: true },
      'node_modules/unused': { version: '1', dev: true },
    },
  };
  const result = npmClosure(lock);
  assert.deepEqual(result.missing, []);
  assert.ok(result.paths.includes('node_modules/nested/node_modules/shared'));
  assert.ok(result.paths.includes('node_modules/shared'));
  assert.ok(result.paths.includes('node_modules/peer'));
  assert.ok(!result.paths.includes('node_modules/unused'));
  delete lock.packages['node_modules/shared'];
  assert.ok(
    npmClosure(lock).missing.some(edge => edge.includes('app -> shared')),
  );
});

test('changing coverage, version, provenance or evidence role fails closed', () => {
  const missing = clone();
  missing.components = missing.components.filter(
    item => item.id !== 'npm:node_modules/metro-runtime',
  );
  assert.ok(
    validateReceipt(missing, { installed: false }).includes(
      'Npm dependency closure coverage changed',
    ),
  );
  const wrongVersion = clone();
  byID(wrongVersion, 'npm:node_modules/react').version = '0.0.0';
  assert.ok(
    validateReceipt(wrongVersion, { installed: false }).some(error =>
      error.includes('Npm version/integrity mismatch'),
    ),
  );
  const reclassified = clone();
  byID(reclassified, 'npm:node_modules/react').role = 'build-tool-only';
  assert.ok(
    validateReceipt(reclassified, { installed: false }).some(error =>
      error.includes('Unsupported evidence classification'),
    ),
  );
  const wrongSource = clone();
  const remote = wrongSource.sources.find(
    source => source.provenance === 'published-npm-git-source',
  );
  remote.revision = 'main';
  assert.ok(
    validateReceipt(wrongSource, { installed: false }).some(error =>
      error.includes('Unversioned upstream legal source'),
    ),
  );
  const unsafe = clone();
  unsafe.inputs[0].path = '../outside-workspace';
  assert.deepEqual(validateReceipt(unsafe, { installed: false }), [
    'Source receipt contains an unsafe non-workspace path',
  ]);
});

test('an unrelated MIT text cannot be borrowed to hide an unresolved package, and special obligations stay gated', () => {
  const borrowed = clone();
  const unresolved = byID(borrowed, 'npm:node_modules/standard-navigation');
  unresolved.sourceIds = ['local:node_modules/react/LICENSE'];
  unresolved.issues = [];
  assert.ok(
    validateReceipt(borrowed, { installed: false }).some(error =>
      error.includes(
        'Unbound license/NOTICE source for npm:node_modules/standard-navigation',
      ),
    ),
  );
  const special = clone();
  byID(special, 'npm:node_modules/react').declaredLicense = 'GPL-3.0-only';
  assert.ok(
    coverageProblems(special).some(error =>
      error.includes('license-specific redistribution obligations'),
    ),
  );
});

test('historical SwiftPM texts remain pinned, not current candidates, and reintroduced NOTICE obligations stay gated', () => {
  const history = receipt.historicalSwiftPM;
  assert.equal(history.kind, 'historical-source-only');
  assert.equal(history.components.length, 7);
  const rendered = renderNotices(receipt).toString('utf8');
  assert.match(rendered, /Current SwiftPM pin candidates: 0\./);
  assert.match(rendered, /no past or current native delivery is inferred/);
  assert.ok(!rendered.includes('Component: swiftpm:'));
  for (const item of history.components) {
    assert.equal(item.role, 'historical-source-only');
    assert.equal(byID(receipt, item.id), undefined);
    for (const id of item.sourceIds) {
      const source = sourceByID(receipt, id);
      assert.equal(sha256(Buffer.from(source.text)), source.sha256);
      assert.ok(!rendered.includes(`--- BEGIN UNMODIFIED SOURCE: ${id}\n`));
    }
  }
  const pins = {
    'swiftpm:swift-asn1/NOTICE.txt':
      '11dd3b3b783e6ec26098dd38ebc962986ea109b85447e28e62867b83bd0f8c5b',
    'swiftpm:swift-crypto/NOTICE.txt':
      'b3ddc2ae068e76b3beb71be03c0400f90090f9469aa491bf7b1ac42320af37b8',
  };
  for (const [id, hash] of Object.entries(pins))
    assert.equal(sha256(Buffer.from(sourceByID(receipt, id).text)), hash);
  const reintroduced = clone();
  reintroduced.components.push({
    ...reintroduced.historicalSwiftPM.components[0],
    role: 'swiftpm-pin-candidate',
  });
  assert.ok(
    validateReceipt(reintroduced).includes('SwiftPM revision/coverage changed'),
  );
  const misclassified = clone();
  misclassified.historicalSwiftPM.components[0].role = 'swiftpm-pin-candidate';
  assert.ok(
    validateReceipt(misclassified).some(error =>
      error.includes('Unsupported historical evidence classification'),
    ),
  );
  const unbound = clone();
  unbound.historicalSwiftPM.components[0].revision = '0'.repeat(40);
  assert.ok(
    validateReceipt(unbound).some(error =>
      error.includes('Unbound license/NOTICE source for swiftpm:'),
    ),
  );
  for (const name of ['swift-asn1', 'swift-crypto', 'swift-http-types']) {
    const changed = clone();
    const historical = changed.historicalSwiftPM.components.find(
      item => item.id === `swiftpm:${name}`,
    );
    changed.components.push({
      ...historical,
      role: 'swiftpm-pin-candidate',
      sourceIds: historical.sourceIds.filter(id => !id.endsWith('/NOTICE.txt')),
    });
    assert.ok(
      coverageProblems(changed).some(error =>
        error.includes(
          `${name}: required original LICENSE/NOTICE missing: NOTICE.txt`,
        ),
      ),
    );
  }
});

test('CocoaPods acknowledgements are unmodified but not treated as complete native coverage', () => {
  const ack = sourceByID(receipt, ackID);
  assert.equal(
    ack.sha256,
    '28367318d771f253d38b998f87d4215f5d1b675099fd6d349f9c5f4df1678aef',
  );
  if (existsSync(join(ROOT, ack.path)))
    assert.ok(Buffer.from(ack.text).equals(readFileSync(join(ROOT, ack.path))));
  assert.equal(
    byID(receipt, 'pod:boost').generatedAcknowledgementHeading,
    false,
  );
  assert.equal(byID(receipt, 'pod:boost').declaredLicense, 'MIT');
  assert.ok(
    byID(receipt, 'pod:boost').sourceIds.some(id =>
      id.endsWith('LICENSE_1_0.txt'),
    ),
  );
  const changed = clone();
  byID(changed, 'pod:RCT-Folly').sourceIds = [ackID];
  assert.ok(
    coverageProblems(changed).some(error => error.includes('pod:RCT-Folly')),
  );
  assert.deepEqual(
    parsePodVersions(
      'PODS:\n  - A/Sub (1.2.3):\n    - B\n  - A (1.2.3)\nDEPENDENCIES:\n  - A\n',
    ),
    [['A', '1.2.3']],
  );
  assert.throws(
    () => parsePodVersions('PODS:\n  - A (1.0)\n  - A/Sub (2.0)\n'),
    /Conflicting/,
  );
});

test('RN prebuilt, Hermes vendored and SentryCrash source notices are distinct from facade metadata', () => {
  const hermes = byID(receipt, 'pod:hermes-engine');
  assert.equal(hermes.version, '250829098.0.17');
  for (const name of [
    'external/llvh/LICENSE.txt',
    'include/hermes/Regex/LICENSE.TXT',
    'external/icu_decls/license.html',
  ]) {
    assert.ok(
      hermes.sourceIds.some(id => id.endsWith(name)),
      name,
    );
  }
  const cocoa = byID(receipt, 'native:Sentry');
  assert.equal(cocoa.version, '9.24.0');
  assert.ok(
    cocoa.sourceIds.some(
      id =>
        id.endsWith('/LICENSE.md') &&
        sourceByID(receipt, id).text.includes('Copyright (c) 2015 Sentry'),
    ),
  );
  assert.ok(
    cocoa.sourceIds.some(
      id =>
        id.includes('Sources/SentryCrash/') &&
        sourceByID(receipt, id).text.includes('Karl Stenerud'),
    ),
  );
  assert.equal(cocoa.upstream.inlineNoticeCapture, 'source-comment-blocks-v1');
  const omittedVendor = clone();
  byID(omittedVendor, 'native:Sentry').sourceIds = cocoa.sourceIds.filter(
    id => !id.includes('Sources/SentryCrash/'),
  );
  assert.ok(
    coverageProblems(omittedVendor).some(error =>
      error.includes('required vendored notice missing'),
    ),
  );
  const cli = byID(receipt, 'npm:node_modules/@sentry/cli');
  assert.equal(cli.version, '3.6.2');
  assert.equal(cli.role, 'build-tool-only');
  assert.equal(cli.declaredLicense, 'FSL-1.1-MIT');
  assert.ok(
    !renderNotices(receipt).includes(
      Buffer.from(
        '# Functional Source License, Version 1.1, MIT Future License',
      ),
    ),
  );
});

test('font bytes, original years, attribution and OFL/Apache texts are not rewritten', () => {
  const pins = {
    'Manrope_400Regular.ttf':
      '6383bd9f81e56d61139884d8e42cb7b2146a11dde4efde55c8bff1e4c2c0bbe8',
    'Manrope_500Medium.ttf':
      '88d3f8ef004b53483a202772d09acaab17ca99dd41905d9b4ab07ac635632378',
    'Manrope_600SemiBold.ttf':
      'abbefa1f58c7355b663c19f29ffe4cd7fc8c93a9e5f8b68f08d1e9ba2bc4ba0d',
    'Manrope_700Bold.ttf':
      '4aed5d180a4f41ed21f07e678486f889bb40eb0ddf5f473769b6302f507d1e36',
    'Roboto-Bold.ttf':
      '594d74a49e307be7cc9e1ee5f1023684e6820cf11bcc968bee590391e1ad5a5a',
  };
  for (const [name, hash] of Object.entries(pins)) {
    const item = byID(receipt, `font:${name}`);
    assert.equal(item.fontSha256, hash);
    if (existsSync(join(ROOT, item.fontPath))) {
      const bytes = readFileSync(join(ROOT, item.fontPath));
      assert.equal(sha256(bytes), hash);
      assert.deepEqual(fontNames(bytes), item.nameTable);
    }
  }
  const manrope = sourceByID(receipt, 'local:assets/fonts/Manrope-OFL.txt');
  assert.equal(
    manrope.sha256,
    'e01b637272e0cbdfb240184dd98ea5cc671556d9894dae2668d92ab2c906787c',
  );
  assert.ok(manrope.text.startsWith('Copyright 2018'));
  const rendered = renderNotices(receipt);
  assert.ok(
    rendered.includes(
      Buffer.from('Copyright 2019 The Manrope Project Authors'),
    ),
  );
  assert.ok(rendered.includes(Buffer.from('Font data copyright Google 2014')));
  assert.ok(
    !coverageProblems(receipt).some(error => error.includes('font:Manrope_')),
  );
  const publisherOfl = sourceByID(receipt, receipt.manropeProvenance.sourceId);
  assert.equal(publisherOfl.sha256, manrope.sha256);
  assert.ok(
    rawSection(rendered, publisherOfl).equals(Buffer.from(manrope.text)),
  );
  assert.equal(receipt.manropeProvenance.version, '0.4.2');
  assert.equal(receipt.manropeProvenance.googleVersion, 'v20');
  const damaged = clone();
  damaged.manropeProvenance.fonts[0].googleSha256 = '0'.repeat(64);
  assert.ok(
    fontProvenanceProblems(
      damaged,
      byID(damaged, 'font:Manrope_400Regular.ttf'),
    ).length > 0,
  );
});

test('README sections and embedded comment excerpts preserve CRLF, Unicode and trailing bytes', () => {
  const raw = Buffer.from(
    `Introduction with é\r\n\r\n## License\r\n${mit.replaceAll('\n', '\r\n')}  `,
  );
  const part = readmeLicenseSection(raw);
  assert.ok(part);
  assert.equal(
    raw.subarray(part.startByte, part.endByte).toString('utf8'),
    `## License\r\n${mit.replaceAll('\n', '\r\n')}  `,
  );
  assert.equal(readmeLicenseSection(Buffer.from('# License\nMIT\n')), null);
  const header = `/*\r\n${mit.replaceAll('\n', '\r\n')}*/`;
  const source = `// é\r\n${header}\nconst notLegalMaterial = 1;\n`;
  const blocks = licenseCommentBlocks(source);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, header);
  assert.ok(
    Buffer.from(source)
      .subarray(blocks[0].startByte, blocks[0].endByte)
      .equals(Buffer.from(header)),
  );
});

test('source tar reader never extracts paths and rejects a truncated member', () => {
  const header = Buffer.alloc(512);
  header.write('source/LICENSE');
  header.write('00000000003\0', 124);
  header.write('0', 156);
  const padded = Buffer.alloc(512);
  padded.write('MIT');
  const files = tarFiles(Buffer.concat([header, padded, Buffer.alloc(1024)]));
  assert.equal(files[0].path, 'source/LICENSE');
  assert.equal(files[0].bytes.toString(), 'MIT');
  assert.throws(
    () => tarFiles(Buffer.concat([header, Buffer.from('M')])),
    /Truncated/,
  );
});

test('Sentry resource is the unmodified vendor manifest, not a fake signed SDK or app privacy overwrite', () => {
  const vendor = existsSync(join(ROOT, SENTRY_PRIVACY))
    ? readFileSync(join(ROOT, SENTRY_PRIVACY))
    : resourceBytes(receipt);
  assert.equal(sha256(vendor), VENDOR_PRIVACY_SHA256);
  assert.ok(resourceBytes(receipt).equals(vendor));
  assert.ok(
    readFileSync(join(ROOT, PRIVACY_DIR, 'PrivacyInfo.xcprivacy')).equals(
      vendor,
    ),
  );
  assert.match(PRIVACY_WRAPPER, /com\.picklesensei\.resources\.SentryPrivacy/);
  assert.ok(!PRIVACY_WRAPPER.includes('<string>io.sentry.Sentry</string>'));
  assert.match(
    receipt.privacyResource.archiveEvidence,
    /NOT independent verification/,
  );
  const changed = clone();
  const source = sourceByID(changed, changed.privacyResource.sourceId);
  source.text += '\n';
  source.bytes++;
  source.sha256 = sha256(Buffer.from(source.text));
  assert.throws(() => resourceBytes(changed), /hash mismatch/);
});

test('resource delivery checks detect absent or modified app-bundle materials independently of source coverage', t => {
  const app = fixture(t);
  assert.equal(checkResources(receipt, app, true).length, 3);
  mkdirSync(join(app, 'SentryPrivacy.bundle'));
  writeFileSync(join(app, 'ThirdPartyNotices.txt'), renderNotices(receipt));
  writeFileSync(join(app, 'SentryPrivacy.bundle/Info.plist'), PRIVACY_WRAPPER);
  writeFileSync(
    join(app, 'SentryPrivacy.bundle/PrivacyInfo.xcprivacy'),
    resourceBytes(receipt),
  );
  assert.deepEqual(checkResources(receipt, app, true), []);
  assert.deepEqual(coverageProblems(receipt), []);
  assert.ok(
    freshArtifactProblems(receipt, candidateArtifact(receipt)).some(error =>
      error.includes('Historical Release'),
    ),
  );
  writeFileSync(join(app, 'ThirdPartyNotices.txt'), 'MIT\n');
  assert.deepEqual(checkResources(receipt, app, true), [
    'Delivered resource differs: ThirdPartyNotices.txt',
  ]);
});

test('portable candidate generation is deterministic and still refuses network or implicit app clearance', () => {
  const protectedInputs = receipt.guards.filter(
    item =>
      item.purpose === 'preserve-font-and-splash-input-bytes' &&
      !item.path.startsWith('ios/Pods/'),
  );
  const before = protectedInputs.map(item =>
    sha256(readFileSync(join(ROOT, item.path))),
  );
  const candidate = readFileSync(join(ROOT, OUTPUT));
  const originalReceipt = readFileSync(join(ROOT, RECEIPT));
  for (const mode of ['--generate', '--check']) {
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/generate-third-party-notices.mjs'), mode],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Final \.app membership\/delivery still requires a fresh Release/,
    );
    assert.match(result.stdout, /no current-binary clearance is claimed/);
  }
  const forbiddenNetwork = spawnSync(
    process.execPath,
    [
      join(ROOT, 'scripts/generate-third-party-notices.mjs'),
      '--generate',
      '--fetch-public',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(forbiddenNetwork.status, 1);
  assert.match(forbiddenNetwork.stderr, /Network reads are allowed only/);
  assert.ok(readFileSync(join(ROOT, OUTPUT)).equals(candidate));
  assert.ok(readFileSync(join(ROOT, RECEIPT)).equals(originalReceipt));
  assert.deepEqual(
    protectedInputs.map(item => sha256(readFileSync(join(ROOT, item.path)))),
    before,
  );
});

function syntheticPair(
  extra = [],
  debugId = '11111111-1111-4111-8111-111111111111',
) {
  const sources = [
    '/agent/repo/apps/mobile/node_modules/react-native/index.js',
    '/agent/repo/apps/mobile/node_modules/react/index.js',
    '/agent/repo/apps/mobile/index.js',
    ...extra.map(path => `/agent/repo/apps/mobile/${path}`),
  ];
  const map = {
    version: 3,
    sources,
    sourcesContent: sources.map(() => 'test fixture'),
    names: [],
    mappings: ['AAAA', ...sources.slice(1).map(() => 'ACAA')].join(','),
    debugId,
    debug_id: debugId,
  };
  const mapBytes = Buffer.from(JSON.stringify(map));
  const bundleBytes = Buffer.alloc(128);
  Buffer.from('c61fbc03c103191f', 'hex').copy(bundleBytes);
  bundleBytes.writeUInt32LE(98, 8);
  bundleBytes.write(debugId, 40);
  return {
    map,
    mapBytes,
    bundleBytes,
    observed: inspectArtifact(
      receipt,
      mapBytes,
      bundleBytes,
      sha256(bundleBytes),
    ),
  };
}

function cleanClone(t) {
  const root = fixture(t);
  const paths = new Set([
    ...receipt.inputs.map(input => input.path),
    ...receipt.guards
      .filter(
        input =>
          input.purpose === 'preserve-font-and-splash-input-bytes' &&
          !input.path.startsWith('ios/Pods/'),
      )
      .map(input => input.path),
    RECEIPT,
    OUTPUT,
    'scripts/generate-third-party-notices.mjs',
    `${PRIVACY_DIR}/Info.plist`,
    `${PRIVACY_DIR}/PrivacyInfo.xcprivacy`,
  ]);
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(ROOT, path), join(root, path));
  }
  return root;
}

test('the historical reference records the real 67-package map, exact bundle/hash pair and absence graph', () => {
  const artifact = candidateArtifact(receipt);
  assert.equal(artifact.kind, 'historical-reference');
  assert.equal(artifact.bundle.sha256, REFERENCE_BUNDLE_SHA256);
  assert.equal(artifact.sourceMap.sha256, REFERENCE_MAP_SHA256);
  assert.equal(
    artifact.lockedInputsSha256,
    '3f8a332714d2cc8bdd1e85171b793ef89a0dad7b5498d9f94ce1fa1ad9c4790c',
  );
  assert.equal(
    artifact.evidenceSha256,
    'f9ff1bfba451f9cec416608e7346b5f194dc26a116bc199781c1481641b88d8e',
  );
  assert.deepEqual(
    recordArtifactEvidence(clone(), artifact, {
      kind: 'historical-reference',
      label: artifact.label,
    }),
    artifact,
  );
  assert.notEqual(
    artifact.lockedInputsSha256,
    sha256(Buffer.from(`${JSON.stringify(receipt.inputs, null, 2)}\n`)),
  );
  assert.equal(artifact.sourceCount, 1972);
  assert.equal(artifact.sourceMap.mappedSourceCount, 1972);
  assert.equal(artifact.sourceMap.sourcesContentCount, 1972);
  assert.equal(artifact.npmMembers.length, 67);
  assert.equal(
    artifact.sourceMap.debugIDs[0],
    '2699028f-7b2a-4383-aede-200d7b31b2f2',
  );
  assert.deepEqual(
    artifact.sourceMap.debugIDs,
    artifact.sourceMap.debugIDsInBundle,
  );
  assert.deepEqual(artifactProblems(receipt, artifact), []);
  assert.equal(artifact.exclusions.length, 6);
  for (const excluded of artifact.exclusions) {
    assert.equal(excluded.observed, false);
    assert.deepEqual(
      excluded.dependencyPath,
      dependencyPath(receipt, excluded.id.slice('npm:'.length)),
    );
    assert.ok(
      !artifact.npmMembers.some(
        member => member.path === excluded.id.slice('npm:'.length),
      ),
    );
    assert.match(excluded.scope, /Not an exclusion from any future artifact/);
  }
  assert.equal(
    artifact.exclusions.find(item => item.id.endsWith('/standard-navigation'))
      .classification,
    'type-only-import-in-pinned-importer',
  );
  assert.equal(
    artifact.exclusions.find(item => item.id.endsWith('/boolbase'))
      .classification,
    'separate-svg-css-feature-not-observed',
  );
  assert.ok(
    artifact.exclusions
      .find(item => item.id.endsWith('/tr46'))
      .dependencyPath.some(path => path.endsWith('/@sentry/cli')),
  );
  assert.deepEqual(coverageProblems(receipt), []);
});

test('the reviewed host-tool maintenance reconstructs only the pre-patch npm inputs and binds actual current source identities', () => {
  const history = receipt.historicalHostTools;
  assert.equal(history.kind, 'historical-host-tool-maintenance');
  assert.deepEqual(history.packages, [
    { lockPath: 'node_modules/qs', before: '6.15.3', after: '6.16.0' },
    { lockPath: 'node_modules/uuid', before: '7.0.3', after: '11.1.1' },
  ]);
  const originalManifest = JSON.parse(readFileSync(join(ROOT, 'package.json')));
  assert.deepEqual(originalManifest.overrides, {
    'xcode@3.0.1': { uuid: '11.1.1' },
  });
  delete originalManifest.overrides;
  assert.equal(
    sha256(Buffer.from(`${JSON.stringify(originalManifest, null, 2)}\n`)),
    history.inputs.find(input => input.path === 'package.json').sha256,
  );
  const originalLock = JSON.parse(
    readFileSync(join(ROOT, 'package-lock.json')),
  );
  Object.assign(originalLock.packages['node_modules/qs'], {
    version: '6.15.3',
    resolved: 'https://registry.npmjs.org/qs/-/qs-6.15.3.tgz',
    integrity:
      'sha512-O9gl3zCl5h5blw1KGUzQKhA5oUXSl8rwUIM5o0S3nCXMliSvy5Dzx7/DJcI+SwgICv+IneSZwhBh1oSyEHA71A==',
  });
  originalLock.packages['node_modules/uuid'] = {
    version: '7.0.3',
    resolved: 'https://registry.npmjs.org/uuid/-/uuid-7.0.3.tgz',
    integrity:
      'sha512-DPSke0pXhTZgoF/d+WSt2QaKMCFSfx7QegxEWT+JOuHF5aWrKEn0G+ztjuJg/gG8/ItK+rbPCD/yNv8yyih6Cg==',
    deprecated:
      'uuid@10 and below is no longer supported.  For ESM codebases, update to uuid@latest.  For CommonJS codebases, use uuid@11 (but be aware this version will likely be deprecated in 2028).',
    license: 'MIT',
    optional: true,
    bin: { uuid: 'dist/bin/uuid' },
  };
  assert.equal(
    sha256(Buffer.from(`${JSON.stringify(originalLock, null, 2)}\n`)),
    history.inputs.find(input => input.path === 'package-lock.json').sha256,
  );
  for (const input of history.inputs) {
    assert.equal(
      receipt.inputs.find(current => current.path === input.path).sha256,
      input.updatedInputSha256,
    );
  }
  const artifact = candidateArtifact(receipt);
  for (const patch of history.packages) {
    assert.ok(
      !artifact.npmMembers.some(member => member.path === patch.lockPath),
    );
    const item = byID(receipt, `npm:${patch.lockPath}`);
    assert.equal(item.version, patch.after);
    for (const id of item.sourceIds) {
      const source = sourceByID(receipt, id);
      assert.equal(source.version, item.version);
      assert.equal(source.integrity, item.integrity);
      assert.equal(sha256(Buffer.from(source.text)), source.sha256);
    }
  }
  assert.equal(
    sourceByID(receipt, 'local:node_modules/qs/LICENSE.md').sha256,
    'e7dc37bf662d7f786efcb46c545615e70c1daf458a38385521c63cf6607cdfe1',
  );
  assert.equal(
    sourceByID(receipt, 'local:node_modules/uuid/LICENSE.md').sha256,
    'beaa6b04fb82e41dd2ad679e19e27953afb5999b1abbb455b6564e78ebfeb332',
  );
  assert.deepEqual(artifactProblems(receipt, artifact), []);
});

test('host-tool maintenance cannot cover arbitrary lock changes, borrowed integrity or future runtime membership', () => {
  const wrongHistory = clone();
  wrongHistory.historicalHostTools.packages[0].after = 'unreviewed';
  assert.ok(
    validateReceipt(wrongHistory).includes(
      'Historical host-tool maintenance receipt is invalid',
    ),
  );
  assert.ok(
    artifactProblems(wrongHistory, candidateArtifact(wrongHistory)).includes(
      'Artifact dependency lock binding changed',
    ),
  );
  for (const path of [
    'package.json',
    'package-lock.json',
    'ios/Podfile.lock',
  ]) {
    const changed = clone();
    changed.inputs.find(input => input.path === path).sha256 = 'a'.repeat(64);
    assert.ok(
      artifactProblems(changed, candidateArtifact(changed)).includes(
        'Artifact dependency lock binding changed',
      ),
    );
  }
  const borrowed = clone();
  sourceByID(borrowed, 'local:node_modules/qs/LICENSE.md').integrity =
    'unrelated-publication';
  assert.ok(
    validateReceipt(borrowed).some(problem =>
      problem.includes(
        'Unbound license/NOTICE source for npm:node_modules/qs@6.16.0',
      ),
    ),
  );
  const { observed } = syntheticPair([
    'node_modules/qs/lib/index.js',
    'node_modules/uuid/dist/esm/index.js',
  ]);
  const fresh = makeArtifactEvidence(receipt, observed, {
    kind: 'current-build',
    label: 'synthetic-new-host-members',
  });
  assert.equal(
    fresh.lockedInputsSha256,
    sha256(Buffer.from(`${JSON.stringify(receipt.inputs, null, 2)}\n`)),
  );
  for (const { lockPath, after } of receipt.historicalHostTools.packages) {
    assert.ok(
      freshArtifactProblems(receipt, fresh).includes(
        `New bundled member requires notice regeneration: ${lockPath}@${after}`,
      ),
    );
  }
});

test('first-party pod maintenance changes only the reviewed checksum and retains historical artifact binding', () => {
  const history = receipt.historicalFirstPartyPod;
  assert.equal(history.kind, 'historical-first-party-pod-maintenance');
  const lock = readFileSync(join(ROOT, history.input.path), 'utf8');
  assert.equal(sha256(Buffer.from(lock)), history.input.updatedInputSha256);
  assert.equal(
    sha256(Buffer.from(lock.replace(history.pod.after, history.pod.before))),
    history.input.sha256,
  );
  assert.equal(byID(receipt, history.pod.id).specChecksum, history.pod.after);
  assert.deepEqual(artifactProblems(receipt, candidateArtifact(receipt)), []);
  const { observed } = syntheticPair(['node_modules/react/index.js']);
  const fresh = makeArtifactEvidence(receipt, observed, {
    kind: 'current-build',
    label: 'synthetic-after-local-pod-maintenance',
  });
  assert.equal(
    fresh.lockedInputsSha256,
    sha256(Buffer.from(`${JSON.stringify(receipt.inputs, null, 2)}\n`)),
  );
});

test('first-party maintenance cannot cover unreviewed locks, podspecs or third-party components', () => {
  for (const mutate of [
    data => {
      delete data.historicalFirstPartyPod;
    },
    data => {
      data.historicalFirstPartyPod.input.updatedInputSha256 = 'a'.repeat(64);
    },
    data => {
      data.historicalFirstPartyPod.pod.id = 'pod:GoogleSignIn';
    },
    data => {
      byID(data, 'pod:PickleNative').specChecksum = 'b'.repeat(40);
    },
    data => {
      data.guards.find(
        item => item.path === data.historicalFirstPartyPod.podspec.path,
      ).sha256 = 'c'.repeat(64);
    },
    data => {
      data.guards.find(item => item.path === 'ios/Pods/Manifest.lock').sha256 =
        'd'.repeat(64);
    },
    data => {
      data.inputs.find(item => item.path === 'ios/Podfile.lock').sha256 =
        'e'.repeat(64);
    },
  ]) {
    const changed = clone();
    mutate(changed);
    assert.ok(
      artifactProblems(changed, candidateArtifact(changed)).includes(
        'Artifact dependency lock binding changed',
      ),
    );
  }
});

test('historical membership cannot be promoted or reused as current-binary evidence', () => {
  const old = candidateArtifact(receipt);
  assert.ok(
    freshArtifactProblems(receipt, old).some(error =>
      error.includes('Historical Release'),
    ),
  );
  assert.throws(
    () =>
      recordArtifactEvidence(clone(), old, {
        kind: 'current-build',
        label: 'not-actually-fresh',
      }),
    /historical|Historical/,
  );
  const { observed } = syntheticPair([], old.sourceMap.debugIDs[0]);
  const disguised = makeArtifactEvidence(receipt, observed, {
    kind: 'historical-reference',
    label: 'different-bytes-same-old-debug-id',
  });
  assert.ok(
    freshArtifactProblems(receipt, disguised).some(error =>
      error.includes('Historical Release'),
    ),
  );
});

test('every previously unresolved package becomes a source failure if a fresh map includes it', () => {
  for (const excluded of candidateArtifact(receipt).exclusions) {
    const path = excluded.id.slice('npm:'.length);
    const { observed } = syntheticPair([`${path}/index.js`]);
    const current = makeArtifactEvidence(receipt, observed, {
      kind: 'current-build',
      label: 'new-import-test',
    });
    assert.ok(
      coverageProblems(receipt, { artifact: current }).some(
        error =>
          error.includes(`${excluded.id}@`) &&
          error.includes('full source license'),
      ),
    );
    assert.ok(
      freshArtifactProblems(receipt, current).some(error =>
        error.includes(
          `New bundled member requires notice regeneration: ${path}`,
        ),
      ),
    );
  }
});

test('a newly observed licensed package also requires regeneration of the actual delivered notice scope', () => {
  const { observed } = syntheticPair(['node_modules/node-fetch/lib/index.js']);
  const current = makeArtifactEvidence(receipt, observed, {
    kind: 'current-build',
    label: 'additional-licensed-member',
  });
  assert.deepEqual(coverageProblems(receipt, { artifact: current }), []);
  assert.ok(
    freshArtifactProblems(receipt, current).some(error =>
      error.includes('node_modules/node-fetch'),
    ),
  );
});

test('observed CLI code cannot hide behind the host-tool classification or inherit the SDK MIT license', () => {
  const { observed } = syntheticPair(['node_modules/@sentry/cli/js/index.js']);
  const current = makeArtifactEvidence(receipt, observed, {
    kind: 'current-build',
    label: 'host-tool-accidentally-bundled',
  });
  assert.ok(
    coverageProblems(receipt, { artifact: current }).some(error =>
      error.includes('license-specific redistribution obligations'),
    ),
  );
  assert.ok(
    renderNotices(receipt, { artifact: current }).includes(
      Buffer.from(
        '# Functional Source License, Version 1.1, MIT Future License',
      ),
    ),
  );
});

test('map parsing preserves nested package identity, normalizes machine roots and rejects incomplete mappings', () => {
  const { map } = syntheticPair([
    'node_modules/@sentry/bundler-plugins/node_modules/https-proxy-agent/dist/index.js',
  ]);
  assert.ok(
    mapMembership(receipt, map).npmMembers.some(
      member =>
        member.path ===
        'node_modules/@sentry/bundler-plugins/node_modules/https-proxy-agent',
    ),
  );
  const otherRoot = {
    ...map,
    sources: map.sources.map(path =>
      path.replace('/agent/repo/', '/different/machine/'),
    ),
  };
  assert.deepEqual(
    mapMembership(receipt, map),
    mapMembership(receipt, otherRoot),
  );
  assert.deepEqual(mappingSourceIndices(map), [0, 1, 2, 3]);
  assert.throws(
    () => mapMembership(receipt, { ...map, sections: [] }),
    /flattened/,
  );
  assert.throws(
    () => mapMembership(receipt, { ...map, sources: [] }),
    /complete/,
  );
  assert.throws(
    () =>
      mapMembership(receipt, {
        ...map,
        sources: ['node_modules/react/../other/index.js'],
      }),
    /Unsafe/,
  );
  assert.throws(
    () => mappingSourceIndices({ ...map, mappings: 'AQAA' }),
    /outside its source table/,
  );
  assert.throws(
    () => mappingSourceIndices({ ...map, mappings: 'g' }),
    /Truncated/,
  );
  assert.throws(
    () => mappingSourceIndices({ ...map, mappings: '?' }),
    /Invalid/,
  );
  assert.throws(
    () => mappingSourceIndices({ ...map, mappings: 'A' }),
    /no source-bearing/,
  );
});

test('bundle hash mismatch, missing debug-ID correspondence, unknown packages and evidence tampering fail closed', () => {
  const pair = syntheticPair();
  assert.throws(
    () =>
      inspectArtifact(receipt, pair.mapBytes, pair.bundleBytes, '0'.repeat(64)),
    /bundle SHA-256/,
  );
  const mismatchedMap = Buffer.from(
    JSON.stringify({
      ...pair.map,
      debugId: '22222222-2222-4222-8222-222222222222',
      debug_id: '22222222-2222-4222-8222-222222222222',
    }),
  );
  const mismatch = inspectArtifact(
    receipt,
    mismatchedMap,
    pair.bundleBytes,
    sha256(pair.bundleBytes),
  );
  assert.throws(
    () =>
      makeArtifactEvidence(receipt, mismatch, {
        kind: 'current-build',
        label: 'bad-map',
      }),
    /debug ID/,
  );
  const unknown = syntheticPair(['node_modules/not-in-lock/index.js']).observed;
  assert.throws(
    () =>
      makeArtifactEvidence(receipt, unknown, {
        kind: 'current-build',
        label: 'unknown-package',
      }),
    /unclassified/,
  );
  const damaged = structuredClone(candidateArtifact(receipt));
  damaged.npmMembers.pop();
  assert.ok(
    artifactProblems(receipt, damaged).some(
      error =>
        error.includes('digest mismatch') ||
        error.includes('membership was changed'),
    ),
  );
  const current = makeArtifactEvidence(receipt, pair.observed, {
    kind: 'current-build',
    label: 'fresh-lock-binding',
  });
  for (const input of receipt.inputs) {
    const staleLock = clone();
    staleLock.inputs.find(item => item.path === input.path).sha256 = '0'.repeat(
      64,
    );
    for (const artifact of [candidateArtifact(receipt), current]) {
      assert.ok(
        artifactProblems(staleLock, artifact).some(error =>
          error.includes('lock binding'),
        ),
        `${artifact.kind}: ${input.path}`,
      );
    }
  }
  const missingHistory = clone();
  delete missingHistory.historicalSwiftPM;
  assert.ok(
    artifactProblems(missingHistory, candidateArtifact(receipt)).some(error =>
      error.includes('lock binding'),
    ),
  );
  const alteredUnlink = clone();
  alteredUnlink.historicalSwiftPM.unlinkedInputSha256 = '0'.repeat(64);
  alteredUnlink.inputs.find(item => item.path === swiftLockPath).sha256 =
    '0'.repeat(64);
  assert.ok(
    validateReceipt(alteredUnlink).includes(
      'Historical SwiftPM unlink receipt is invalid',
    ),
  );
  assert.ok(
    artifactProblems(alteredUnlink, candidateArtifact(receipt)).some(error =>
      error.includes('lock binding'),
    ),
  );
  const alteredHistory = clone();
  alteredHistory.historicalSwiftPM.lockInput.sha256 = '0'.repeat(64);
  assert.ok(
    artifactProblems(alteredHistory, candidateArtifact(receipt)).some(error =>
      error.includes('lock binding'),
    ),
  );
});

test('generation/check work in a clone with no node_modules, Pods, DerivedData or home SDK cache', t => {
  const root = cleanClone(t);
  assert.equal(existsSync(join(root, 'node_modules')), false);
  assert.equal(existsSync(join(root, 'ios/Pods')), false);
  assert.deepEqual(validateReceipt(receipt, { root }), []);
  for (const mode of ['--generate', '--check']) {
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/generate-third-party-notices.mjs'), mode],
      { encoding: 'utf8', env: { ...process.env, HOME: root } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no current-binary clearance/);
  }
  assert.ok(
    readFileSync(join(root, OUTPUT)).equals(readFileSync(join(ROOT, OUTPUT))),
  );
  const optIn = spawnSync(
    process.execPath,
    [
      join(root, 'scripts/generate-third-party-notices.mjs'),
      '--check',
      '--check-installed',
    ],
    { encoding: 'utf8', env: { ...process.env, HOME: root } },
  );
  assert.equal(optIn.status, 1);
  assert.match(optIn.stderr, /Pinned input missing/);
  const originalSwiftLock = readFileSync(join(root, swiftLockPath));
  const changedSwiftLock = JSON.parse(originalSwiftLock);
  const historical = receipt.historicalSwiftPM.components[0];
  changedSwiftLock.pins.push({
    identity: historical.name,
    kind: 'remoteSourceControl',
    location: historical.repository,
    state: { revision: historical.revision, version: historical.version },
  });
  writeFileSync(join(root, swiftLockPath), JSON.stringify(changedSwiftLock));
  const originalNotice = readFileSync(join(root, OUTPUT));
  for (const mode of ['--generate', '--check']) {
    const reintroduced = spawnSync(
      process.execPath,
      [join(root, 'scripts/generate-third-party-notices.mjs'), mode],
      { encoding: 'utf8', env: { ...process.env, HOME: root } },
    );
    assert.equal(reintroduced.status, 1);
    assert.match(reintroduced.stderr, /SwiftPM revision\/coverage changed/);
    assert.ok(readFileSync(join(root, OUTPUT)).equals(originalNotice));
  }
  writeFileSync(join(root, swiftLockPath), originalSwiftLock);
  const altered = JSON.parse(readFileSync(join(root, RECEIPT), 'utf8'));
  delete altered.manropeProvenance;
  writeFileSync(join(root, RECEIPT), JSON.stringify(altered));
  const before = readFileSync(join(root, OUTPUT));
  const refused = spawnSync(
    process.execPath,
    [join(root, 'scripts/generate-third-party-notices.mjs'), '--generate'],
    { encoding: 'utf8' },
  );
  assert.equal(refused.status, 1);
  assert.ok(readFileSync(join(root, OUTPUT)).equals(before));
});

test('final app validation requires explicitly hashed fresh map and app-owned bundle, independent of candidate validity', t => {
  const dir = fixture(t);
  const app = join(dir, 'PickleSensei.app');
  mkdirSync(join(app, 'SentryPrivacy.bundle'), { recursive: true });
  const pair = syntheticPair();
  const mapPath = join(dir, 'main.jsbundle.map');
  writeFileSync(mapPath, pair.mapBytes);
  writeFileSync(join(app, 'main.jsbundle'), pair.bundleBytes);
  writeFileSync(join(app, 'ThirdPartyNotices.txt'), renderNotices(receipt));
  writeFileSync(join(app, 'SentryPrivacy.bundle/Info.plist'), PRIVACY_WRAPPER);
  writeFileSync(
    join(app, 'SentryPrivacy.bundle/PrivacyInfo.xcprivacy'),
    resourceBytes(receipt),
  );
  const script = join(ROOT, 'scripts/generate-third-party-notices.mjs');
  const missing = spawnSync(process.execPath, [script, '--check-app', app], {
    encoding: 'utf8',
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires --source-map/);
  const args = [
    script,
    '--check-app',
    app,
    '--source-map',
    mapPath,
    '--expected-bundle-sha256',
    sha256(pair.bundleBytes),
    '--expected-map-sha256',
    sha256(pair.mapBytes),
  ];
  const passed = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, new RegExp(sha256(pair.bundleBytes)));
  assert.match(passed.stdout, /verified only for bundle/);
  const changedBundle = Buffer.concat([
    pair.bundleBytes,
    Buffer.from('changed'),
  ]);
  writeFileSync(join(app, 'main.jsbundle'), changedBundle);
  const rejected = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /bundle SHA-256/);
});
