export {};

declare const require: (id: string) => unknown;
declare const __dirname: string;
const { readFileSync } = require('node:fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { resolve } = require('node:path') as {
  resolve: (...parts: string[]) => string;
};

const sources = resolve(__dirname, '../ios/LocalPods/PickleNative/Sources');
const bridge = readFileSync(
  resolve(sources, 'PickleVideoCapture.swift'),
  'utf8',
);
const store = readFileSync(resolve(sources, 'ClipMediaStore.swift'), 'utf8');
const guidedController = readFileSync(
  resolve(sources, 'GuidedCaptureViewController.swift'),
  'utf8',
);
const selectors = readFileSync(
  resolve(sources, 'PickleVideoCaptureBridge.m'),
  'utf8',
);
const camera = readFileSync(
  resolve(__dirname, '../src/camera/capture.ts'),
  'utf8',
);

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('native import safety source contracts (not device execution)', () => {
  it('exports the real read-only byte comparison selector and enrolls it in cancellable media work', () => {
    expect(selectors).toContain(
      'RCT_EXTERN_METHOD(compareCapturedClipBytes:(NSDictionary *)request',
    );
    expect(camera).toContain('compareCapturedClipBytes?(');
    const comparison = section(
      bridge,
      '@objc func compareCapturedClipBytes(',
      '/// Imported clips arrive',
    );
    expect(comparison).toContain('NativeClipByteExpectation(request: request)');
    expect(comparison).toContain('self.begin(operation: .comparing(');
    expect(comparison).toContain('self.mediaOperation = mediaOperation');
    expect(comparison).toContain('mediaOperation.startWork()');
    expect(comparison).toContain('mediaOperation.endWork()');
    expect(comparison).toContain('self.importMediaQueue.async');
    expect(comparison).toContain('ClipMediaStore.compareCapturedClipBytes(');
    expect(comparison).toContain('self.mediaOperation === mediaOperation');
    expect(comparison).toContain('currentId == mediaOperation.id');
    expect(comparison).toContain('finishMediaOperation(');
    const finish = section(
      bridge,
      'private func finishMediaOperationIfReady(',
      'private func emitMedia(',
    );
    expect(
      finish.indexOf('comparison.verifyUnchanged(operation: mediaOperation)'),
    ).toBeGreaterThan(finish.indexOf('guard !mediaOperation.isWorking'));
    expect(
      finish.indexOf('comparison.verifyUnchanged(operation: mediaOperation)'),
    ).toBeLessThan(finish.indexOf('callback?(payload)'));
    expect(finish).toContain('currentId == mediaOperation.id');
  });

  it('compares supplied hash and size through bounded guarded reads, never sealing or adopting existing files', () => {
    const comparison = section(
      store,
      'static func compareCapturedClipBytes(',
      'static func makeObservationURL(',
    );
    expect(comparison).toContain('create: false');
    expect(comparison).toContain(
      'GuardedClipFile(url: directory, directory: true)',
    );
    expect(comparison).toContain('GuardedClipFile(url: videoURL)');
    expect(comparison).toContain('ProvisionalImportBudget.maximumSourceBytes');
    expect(comparison).toContain(
      'read(upToCount: ProvisionalImportBudget.copyChunkBytes)',
    );
    expect(comparison).toContain('digest.update(data: chunk)');
    expect(comparison).toContain('currentHash == expectation.sha256');
    expect(comparison).toContain('byteCount == expectation.byteSize');
    expect(
      comparison.match(/verifyUnchanged\(operation: operation\)/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(comparison).not.toMatch(
      /sealVideoOutput|videoIdentityPayload|createOwned|writeOwned|removeItem|unlink|setAttributes|createDirectory|resolvingSymlinksInPath|resolveCaptureURL/,
    );
    const proof = section(
      store,
      'final class CurrentClipByteComparison',
      'struct ImportedVideoMetadata',
    );
    expect(proof).toContain('isSameFile(as: rootSnapshot)');
    expect(proof).toContain('input.verifyUnchanged(snapshot)');
    expect(proof).toContain('operation.checkActive()');
  });

  it('keeps JS, Swift and exported Objective-C selectors aligned without inventing a cancellation method', () => {
    expect(selectors).toContain(
      'RCT_EXTERN_METHOD(importVideo:(RCTPromiseResolveBlock)resolve',
    );
    expect(selectors).toContain('RCT_EXTERN_METHOD(cancel)');
    expect(selectors).toContain(
      'RCT_EXTERN_METHOD(extractImportedPoseSequence:(NSDictionary *)request',
    );
    expect(camera).toContain('importVideo(): Promise<unknown>');
    expect(camera).toContain('cancel(): void');
    expect(bridge).toContain('@objc func cancel()');
    expect(bridge).toContain('request["operationId"]');
    expect(bridge).toContain('ClipMediaOperation(id: operationId)');
    expect(bridge).toContain('payload["operationId"] = mediaOperation.id');
    expect(bridge).toMatch(
      /@objc func importVideo\(\s*_ resolve: @escaping RCTPromiseResolveBlock/,
    );
  });

  it('anchors guarded traversal inside OS-provided home or temp storage, never at the filesystem root', () => {
    const guarded = section(
      store,
      'final class GuardedClipFile',
      'enum ClipVideoOrigin',
    );
    expect(guarded).toContain('NSHomeDirectory()');
    expect(guarded).toContain('FileManager.default.temporaryDirectory');
    expect(guarded).not.toMatch(/Darwin\.open\("\/"\s*,/);
    expect(guarded).toContain('Darwin.open(root.path,');
    expect(guarded).toContain('components.starts(with: rootComponents)');
    expect(guarded).toContain('components.dropFirst(rootComponents.count)');
    expect(guarded).toContain('O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW');
    expect(guarded).toContain('O_NOFOLLOW | O_NONBLOCK');
    expect(guarded).toContain('value.st_nlink == 1');
    expect(guarded).toContain('AT_SYMLINK_NOFOLLOW');
    expect(guarded).not.toContain('throw ClipMediaStoreError.invalidMedia');
  });

  it('copies the provider representation into owned private storage before guarded media validation', () => {
    const preflight = section(
      store,
      'static func preflightImport(',
      'static func persistImportedVideo(',
    );
    const copy = preflight.indexOf('copyProviderVideo(');
    const guardPrivateCopy = preflight.indexOf('GuardedClipFile(url: source)');
    expect(copy).toBeGreaterThan(0);
    expect(copy).toBeLessThan(guardPrivateCopy);
    expect(preflight).toContain(
      'preflightImport(from: destination, operation: operation)',
    );
    const providerCopy = section(
      store,
      'private static func copyProviderVideo(',
      'static func preflightImport(',
    );
    expect(providerCopy).toContain(
      'FileManager.default.copyItem(at: source, to: stagingURL)',
    );
    expect(providerCopy).not.toContain('GuardedClipFile(url: source)');
    expect(providerCopy.indexOf('requireImportDiskCapacity(')).toBeLessThan(
      providerCopy.indexOf('FileManager.default.copyItem('),
    );
    expect(providerCopy).toContain(
      'ProvisionalImportBudget.maximumSourceBytes',
    );
    expect(providerCopy).toContain('operation.makeOwnedExportURL(');
    expect(providerCopy).toContain('operation.finishOwnedExport(');
    expect(providerCopy).toContain('operation.checkActive()');
  });

  it('reports file access, unsupported movies, protected content and missing tracks as distinct failures', () => {
    for (const code of [
      'camera.file_access_failed',
      'camera.import_file_unavailable',
      'camera.import_not_movie',
      'camera.import_protected_content',
      'camera.import_no_video_track',
      'camera.import_too_long',
    ]) {
      expect(store).toContain(code);
    }
    const invalidMedia = section(
      store,
      'case .invalidMedia:',
      'case .invalidEvidence:',
    );
    expect(invalidMedia).not.toContain('does not contain a valid video track');
    const finish = section(
      bridge,
      'private func finishMediaOperationIfReady(',
      'private func emitMedia(',
    );
    expect(finish).toContain(
      'ImportMediaFailure.classify(error, fallbackCode: fallbackCode)',
    );
  });

  it('prepares the private import within the ephemeral callback and guards it by operation', () => {
    const picker = section(bridge, 'func picker(', 'private func begin(');
    const preflight = picker.indexOf('ClipMediaStore.preflightImport(');
    const copy = picker.indexOf('ClipMediaStore.persistImportedVideo(');
    expect(preflight).toBeGreaterThan(0);
    expect(copy).toBeGreaterThan(preflight);
    expect(picker).toContain('mediaOperation.startWork()');
    expect(picker).toContain('progress.cancel()');
    expect(picker).toContain('finishMediaOperation(');
  });

  it('retains the sixty-second cap with explicit provisional byte, pixel, frame and disk budgets', () => {
    expect(store).toContain('enum ProvisionalImportBudget');
    expect(store).toContain('maximumDurationSeconds = 60.0');
    expect(store).toContain('maximumSourceBytes: Int64 = 512 * 1024 * 1024');
    expect(store).toContain('maximumFramePixels = 4096 * 2160');
    expect(store).toContain('maximumDecodedFrames = 60 * 240 + 1');
    expect(store).toContain('maximumPoseFrames = 4000');
    expect(store).toContain('maximumSidecarBytes = 16 * 1024 * 1024');
    const preflight = section(
      store,
      'static func preflightImport(',
      'static func persistImportedVideo(',
    );
    expect(preflight).toContain(
      'durationSeconds <= ProvisionalImportBudget.maximumDurationSeconds',
    );
    expect(preflight).toContain(
      'byteSize <= ProvisionalImportBudget.maximumSourceBytes',
    );
    expect(preflight).toContain('ProvisionalImportBudget.maximumFramePixels');
    expect(preflight).toContain('ProvisionalImportBudget.maximumDecodedFrames');
    expect(preflight).toContain('requireImportDiskCapacity(');
    expect(preflight).toContain('track.isEnabled');
    expect(preflight).toContain('asset.hasProtectedContent');
    expect(preflight).toContain('asset.cancelLoading()');
  });

  it('checks coded dimensions as well as display metadata before a reader can allocate decoded frames', () => {
    const preflight = section(
      store,
      'static func preflightImport(',
      'static func persistImportedVideo(',
    );
    expect(preflight).toContain('"formatDescriptions"');
    expect(preflight).toContain(
      'CMVideoFormatDescriptionGetDimensions(format)',
    );
    expect(preflight).toContain('tracks.count == 1');
    expect(preflight).toContain(
      'trackStart + trackDuration <= durationSeconds + 0.001',
    );
    const extraction = section(
      bridge,
      'private func performImportedPoseExtraction(',
      '/// D-029 instrumentation switch',
    );
    expect(extraction.indexOf('ClipMediaStore.preflightImport(')).toBeLessThan(
      extraction.indexOf('AVAssetReader(asset:'),
    );
    expect(extraction).toContain(
      'CVPixelBufferGetDataSize(pixelBuffer) <= ProvisionalImportBudget.maximumDecodedFrameBytes',
    );
    expect(
      extraction.indexOf(
        'framesProcessed <= ProvisionalImportBudget.maximumPoseFrames',
      ),
    ).toBeLessThan(extraction.indexOf('poseProvider.extractPose('));
    expect(extraction).toContain('try mediaOperation.checkActive()');
    expect(camera).toContain('MAX_IMPORTED_POSE_FRAMES = 4000');
  });

  it('copies in bounded chunks with cancellation and cleans only registered outputs', () => {
    const copy = section(
      store,
      'static func persistImportedVideo(',
      'static func removeIfPresent(',
    );
    expect(copy).not.toContain('copyItem(');
    expect(copy).toContain('checkActive()');
    expect(copy).toContain('metadata.sourceSnapshot');
    expect(copy).toContain(
      'operation.copyVideoBytes(from: source, to: destination, expected: expected)',
    );
    const bytes = section(
      store,
      'func copyVideoBytes(',
      'func commitOwnedOutputs()',
    );
    expect(bytes).toContain(
      'read(upToCount: ProvisionalImportBudget.copyChunkBytes)',
    );
    expect(bytes).toContain('try input.verifyUnchanged(expected)');
    expect(bytes).toContain('copied == expected.byteSize');
    expect(bytes).toContain(
      'sealVideoOutput(at: destination, origin: .importCopy)',
    );
    expect(store).toContain('func cleanupOwnedOutputs()');
    expect(store).toContain('ownedOutputs');
    expect(store).not.toMatch(
      /removeItem\(at: (capturesDirectory|capturesRoot|directory|source|videoURL)\)/,
    );
  });

  it('resolves relocated extraction URLs before the Captures and symlink guards', () => {
    const extraction = section(
      bridge,
      'private func performImportedPoseExtraction(',
      '/// D-029 instrumentation switch',
    );
    const resolved = extraction.indexOf(
      'ClipMediaStore.resolveCaptureURL(fromStoredUri: uri)',
    );
    const symlinks = extraction.indexOf('resolvingSymlinksInPath()');
    const guarded = extraction.indexOf(
      'videoURL.path.hasPrefix(capturesRoot.path + "/")',
    );
    expect(resolved).toBeGreaterThan(0);
    expect(symlinks).toBeGreaterThan(resolved);
    expect(guarded).toBeGreaterThan(symlinks);
  });

  it('serializes extraction, cancels the real reader, and checks budgets before publishing sidecars', () => {
    expect(bridge).toContain(
      'DispatchQueue(label: "com.picklesensei.import-media"',
    );
    expect(bridge).toContain('self.mediaOperation == nil');
    const extraction = section(
      bridge,
      'private func performImportedPoseExtraction(',
      '/// D-029 instrumentation switch',
    );
    expect(extraction).toContain('reader.cancelReading()');
    expect(extraction).toContain('mediaOperation.checkActive()');
    expect(extraction).toContain(
      'ProvisionalImportBudget.maximumDecodedFrames',
    );
    expect(extraction).toContain('ProvisionalImportBudget.maximumPoseFrames');
    expect(extraction).toContain('reader.status == .completed');
    expect(extraction).toContain('operation: mediaOperation');
    const finish = section(
      bridge,
      'private func finishMediaOperation(',
      'private func begin(',
    );
    expect(finish).toContain('self.mediaOperation === mediaOperation');
    expect(finish).toContain('mediaOperation.commitOwnedOutputs()');
    expect(finish).toContain('mediaOperation.cleanupOwnedOutputs()');
    expect(bridge).toContain('isWorking');
  });

  it('keeps the busy barrier through cancellation and modal dismissal until the actual worker drains', () => {
    const cancel = section(
      bridge,
      'private func cancelMediaOperation(',
      'private func finishMediaOperation(',
    );
    expect(cancel).toContain('self.mediaOperation === mediaOperation');
    expect(cancel).toContain('mediaOperation.cancel(reason)');
    expect(cancel).not.toContain('clearOperation()');
    const finish = section(
      bridge,
      'private func finishMediaOperationIfReady(',
      'private func emitMedia(',
    );
    const drained = finish.indexOf('guard !mediaOperation.isWorking');
    expect(drained).toBeGreaterThan(
      finish.indexOf('picker.dismiss(animated: true)'),
    );
    expect(drained).toBeLessThan(
      finish.indexOf('mediaOperation.commitOwnedOutputs()'),
    );
    expect(finish.indexOf('try mediaOperation.checkActive()')).toBeLessThan(
      finish.indexOf('mediaOperation.commitOwnedOutputs()'),
    );
    expect(finish).toContain('guard !importPickerDismissing');
    const emit = section(
      bridge,
      'private func emitMedia(',
      'private func begin(',
    );
    expect(emit).toContain(
      'self.mediaOperation === mediaOperation, !mediaOperation.isCancelled',
    );
    const start = section(store, 'func startWork()', 'func endWork()');
    expect(start).toContain('guard !workStarted');
    expect(start).toContain('workStarted = true');
  });

  it('does not let an old permission or modal callback clear a newer operation', () => {
    const capture = section(
      bridge,
      '@objc func capture(',
      '@objc func importVideo(',
    );
    expect(capture.match(/currentId == guidedId/g)).toHaveLength(3);
    const guided = section(
      bridge,
      'private func presentGuidedCapture(',
      'private func emit(',
    );
    expect(guided.match(/currentId == guidedId/g)).toHaveLength(3);
    const picker = section(
      bridge,
      'func picker(',
      'private func armMediaDeadline(',
    );
    expect(picker).toContain(
      'importPicker === picker, !importSelectionReceived',
    );
  });

  it('retains root and symlink guards and bounds text and existing-poster reads', () => {
    const resolver = section(
      store,
      'static func resolveCaptureURL(',
      'static func makeObservationURL(',
    );
    expect(resolver).toContain('stored.isFileURL');
    expect(resolver).toContain('!stored.pathComponents.contains("..")');
    expect(resolver).toContain('resolved.path.hasPrefix(directory.path + "/")');
    expect(store).toContain(
      'directory.resolvingSymlinksInPath().path == directory.path',
    );
    const text = section(
      bridge,
      '@objc func readTextFile(',
      'private static let importedPoseMaxDurationSeconds',
    );
    expect(text).toContain(
      'byteSize <= ProvisionalImportBudget.maximumSidecarBytes',
    );
    expect(text).toContain(
      'handle.read(upToCount: ProvisionalImportBudget.maximumSidecarBytes + 1)',
    );
    expect(text).not.toContain('String(contentsOf:');
    const poster = section(
      store,
      'static func writePosterFrame(',
      'static func exportStrokeWindow(',
    );
    expect(poster).toContain(
      'byteSize <= ProvisionalImportBudget.maximumPosterBytes',
    );
    expect(poster).toContain('outputOperation.discardOwnedOutput(posterURL)');
  });

  it('keeps failed retry sidecars separate from existing captures and checks serialized byte size', () => {
    expect(store).toContain('operation.makeOwnedOutputURL(');
    expect(store).toContain(
      'data.count <= ProvisionalImportBudget.maximumSidecarBytes',
    );
    expect(store).toContain('operation.writeOwnedData(');
    expect(store).toContain('sidecarURL: sidecarURL');
    const poster = section(
      store,
      'static func writePosterFrame(',
      'static func exportStrokeWindow(',
    );
    expect(poster).toContain(
      'resolveCaptureURL(fromStoredUri: videoURL.absoluteString)',
    );
    expect(poster).toContain('generator.cancelAllCGImageGeneration()');
  });

  it('routes new files through owned protection after creation and atomic replacement', () => {
    const protection = section(
      store,
      'func protectOwnedOutput(',
      'func commitOwnedOutputs()',
    );
    expect(protection).toContain('try ownedSnapshot(for: url)');
    const ownership = section(
      store,
      'private func ownedSnapshot(',
      'func protectOwnedOutput(',
    );
    expect(ownership).toContain('ownedOutputs[url]');
    expect(ownership).toContain('ClipMediaStore.isPrivateCaptureURL(url)');
    expect(ownership).toContain('current.isSameFile(as: owned)');
    expect(protection).toContain(
      '.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication',
    );
    expect(protection).toContain('values.isExcludedFromBackup = true');
    expect(protection).toContain('try target.setResourceValues(values)');
    const create = section(
      store,
      'func createOwnedOutput(',
      'func writeOwnedChunk(',
    );
    expect(create).toContain(
      'O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC | O_NOFOLLOW',
    );
    expect(create.indexOf('Darwin.openat(')).toBeLessThan(
      create.indexOf('ownedOutputs[url] = identity'),
    );
    expect(create.indexOf('ownedOutputs[url] = identity')).toBeLessThan(
      create.indexOf('try protectOwnedOutput(url)'),
    );
    expect(create).toContain('try protectOwnedOutput(url)');
    expect(create).toContain('discardOwnedOutput(url)');
    const write = section(
      store,
      'func writeOwnedData(',
      'func protectOwnedOutput(',
    );
    expect(write.indexOf('try protectOwnedOutput(url)')).toBeGreaterThan(
      write.indexOf('try data.write(to: url'),
    );
    expect(write).toContain('discardOwnedOutput(url)');
    expect(write.indexOf('try ownedSnapshot(for: url)')).toBeLessThan(
      write.indexOf('try data.write(to: url'),
    );
    expect(write.indexOf('try data.write(to: url')).toBeLessThan(
      write.indexOf('ownedOutputs[url] = identity'),
    );
    expect(write.indexOf('ownedOutputs[url] = identity')).toBeLessThan(
      write.indexOf('try protectOwnedOutput(url)'),
    );
    expect(write).toContain('guard !sealed');
  });

  it('owns an exclusive export staging directory and protects the movie before its final reference', () => {
    const staging = section(
      store,
      'func makeOwnedExportURL(',
      'func finishOwnedExport(',
    );
    expect(staging).toContain('Darwin.mkdirat(parent, name, 0o700) == 0');
    expect(staging).toContain(
      'GuardedClipFile.withParent(of: stagingDirectory)',
    );
    expect(staging).toContain('ownedOutputs[stagingDirectory] = identity');
    expect(staging.indexOf('Darwin.mkdirat(')).toBeLessThan(
      staging.indexOf('ownedOutputs[stagingDirectory] = identity'),
    );
    expect(staging).toContain('exportSlots[exportURL] = identity');
    expect(staging).toContain('try protectOwnedOutput(stagingDirectory)');
    const finish = section(
      store,
      'func finishOwnedExport(',
      'func createOwnedOutput(',
    );
    expect(finish).toContain('try ownedSnapshot(for: stagingDirectory)');
    expect(finish).toContain('exportSlots[url] != nil');
    expect(finish).toContain('try ClipFileSnapshot.at(url)');
    expect(finish).toContain('try FileManager.default.moveItem(');
    expect(finish).not.toContain('removeIfPresent(destination)');
    expect(finish).toContain('ownedOutputs[destination] = identity');
    expect(finish.indexOf('ownedOutputs[destination] = identity')).toBeLessThan(
      finish.indexOf('try protectOwnedOutput(destination)'),
    );
    expect(finish.indexOf('try protectOwnedOutput(destination)')).toBeLessThan(
      finish.indexOf('return destination'),
    );
    expect(finish).toContain('discardOwnedOutput(stagingDirectory)');
  });

  it('commits the guided movie, pose and poster together and rolls back before a failure callback', () => {
    const guided = section(
      store,
      'static func exportStrokeWindow(',
      'static func importedPayload(',
    );
    expect(guided).toContain(
      'operation owningOperation: ClipMediaOperation? = nil',
    );
    expect(guided).toContain(
      'let operation = owningOperation ?? ClipMediaOperation()',
    );
    expect(guided).toContain('operation.startWork()');
    expect(guided).toContain('operation.makeOwnedExportURL(');
    expect(guided).toContain('export.outputURL = exportURL');
    expect(guided).toContain('operation.finishOwnedExport(');
    expect(guided).toContain(
      'sealVideoOutput(at: destination, origin: .nativeExport)',
    );
    expect(guided).toContain('operation.onCancel {');
    expect(guided).toContain('export.cancelExport()');
    expect(guided).toContain('asset.cancelLoading()');
    expect(guided).toContain(
      'if operation.isCancelled { export.cancelExport() }',
    );
    const prepared = section(
      guided,
      'let payload = try measuredPayload(',
      'result = .success(payload)',
    );
    expect(prepared).toContain('operation: operation');
    expect(prepared).toMatch(
      /if owningOperation == nil\s*\{\s*try operation\.commitOwnedOutputs\(\)/,
    );
    expect(prepared).toMatch(/else\s*\{[\s\S]*try operation\.checkActive\(\)/);
    expect(guidedController).toContain('operation: captureOperation');
    const cancelled = section(
      guidedController,
      'func cancelFromBridge()',
      'func didPublishClip(',
    );
    expect(cancelled).toContain('captureOperation.cancel()');
    expect(cancelled).not.toContain('processingClip');
    expect(
      guided.indexOf(
        'operation.cleanupOwnedOutputs()',
        guided.indexOf('export.exportAsynchronously'),
      ),
    ).toBeLessThan(guided.indexOf('completion(result)'));
    expect(guided).toContain('case .cancelled:');
    expect(guided).toContain('case .failed:');
    expect(guided).toContain(
      'if removeSourceRecording { removeOwnedObservation(artifact.url, expected: sourceSnapshot) }',
    );
    const publication = section(
      bridge,
      'controller.onComplete =',
      'presenter.present(controller',
    );
    expect(publication).toContain(
      'self.guidedMediaOperation === guidedOperation',
    );
    expect(publication).toContain('currentId == guidedId');
    expect(publication).toContain('guidedOperation.cleanupOwnedOutputs()');
    expect(
      publication.indexOf('controller.dismiss(animated: true)'),
    ).toBeLessThan(
      publication.indexOf('try guidedOperation.commitOwnedOutputs()'),
    );
    expect(
      publication.indexOf('try guidedOperation.checkActive()'),
    ).toBeLessThan(
      publication.indexOf('try guidedOperation.commitOwnedOutputs()'),
    );
    expect(
      publication.indexOf('try guidedOperation.commitOwnedOutputs()'),
    ).toBeLessThan(publication.indexOf('self.finishWithSuccess(payload)'));
    expect(guided).not.toContain('removeIfPresent(destination)');
  });

  it('seals actual movie bytes and rechecks the owned generation before publication', () => {
    const seal = section(
      store,
      'func sealVideoOutput(',
      'func videoIdentityPayload(',
    );
    expect(seal).toContain('try ownedSnapshot(for: url)');
    expect(seal).toContain('GuardedClipFile(url: url)');
    expect(seal).toContain(
      'read(upToCount: ProvisionalImportBudget.copyChunkBytes)',
    );
    expect(seal).toContain('digest.update(data: chunk)');
    expect(seal).toContain('byteCount == expected.byteSize');
    expect(seal).toContain('"format": "pickle.native-media-identity.v1"');
    expect(seal).toContain('"sha256": digest.finalize()');
    expect(seal).toContain('try input.verifyUnchanged(expected)');
    const commit = section(
      store,
      'func commitOwnedOutputs()',
      'func discardOwnedOutput(',
    );
    expect(commit).toContain(
      'try GuardedClipFile(url: url).verifyUnchanged(identity.snapshot)',
    );
    expect(commit).toContain('isSameFile(as: identity)');
    expect(commit.indexOf('verifyUnchanged(identity.snapshot)')).toBeLessThan(
      commit.indexOf('committed = true'),
    );
  });

  it('waits for workers to drain before identity-checked native cleanup', () => {
    const cleanup = section(
      store,
      'func cleanupOwnedOutputs()',
      'struct ImportedVideoMetadata',
    );
    expect(cleanup).toContain('guard !working else');
    expect(cleanup).toContain('current.isSameFile(as: directoryIdentity)');
    expect(cleanup).toContain(
      'GuardedClipFile.removeOwned(url, identity: identity)',
    );
    expect(cleanup).not.toContain('FileManager.default.removeItem');
    expect(bridge).toContain('guidedOperation.afterWorkDrains');
    expect(bridge).toContain(
      'guard let self, self.guidedMediaOperation === guidedOperation else',
    );
  });

  it('uses local ownership for standalone posters without adopting or changing an existing poster', () => {
    const poster = section(
      store,
      'static func writePosterFrame(',
      'static func exportStrokeWindow(',
    );
    const existing = section(
      poster,
      'if FileManager.default.fileExists(atPath: posterURL.path)',
      'let outputOperation = operation ?? ClipMediaOperation()',
    );
    expect(existing).toContain('return posterURL');
    expect(existing).not.toMatch(
      /setResourceValues|setAttributes|createOwnedOutput|writeOwnedData|discardOwnedOutput/,
    );
    expect(poster).toContain(
      'outputOperation.createOwnedOutput(at: posterURL)',
    );
    expect(poster).toContain(
      'outputOperation.writeOwnedData(jpeg, to: posterURL)',
    );
    expect(poster).toContain(
      'if operation == nil { try outputOperation.commitOwnedOutputs() }',
    );
    expect(poster).toContain(
      'if operation == nil { outputOperation.cleanupOwnedOutputs() }',
    );
    expect(poster).not.toContain('try jpeg.write(');
  });

  it('exclusively creates guided sidecars while retaining imported retry ownership, schema and hashing', () => {
    const sidecar = section(
      store,
      'private static func writePoseSequenceSidecar(',
      'private static func recognitionPayload(',
    );
    expect(sidecar).toContain('operation: ClipMediaOperation,');
    expect(sidecar).toContain(
      'if sidecarURL == nil { try operation.createOwnedOutput(at: destination) }',
    );
    expect(sidecar).toContain(
      'try operation.writeOwnedData(data, to: destination)',
    );
    expect(sidecar).not.toContain('try data.write(');
    expect(sidecar).toContain('options: [.sortedKeys]');
    expect(sidecar).toContain('SHA256.hash(data: data)');
    expect(sidecar).toContain('"t": pose.timestampMs - windowStartTimestampMs');
    expect(sidecar).toContain('if metadata != nil {');
  });

  it('rejects invalid native numbers before JSON serialization and payload publication', () => {
    const sidecar = section(
      store,
      'private static func writePoseSequenceSidecar(',
      'private static func isValidTimestampMs(',
    );
    const validation = sidecar.indexOf(
      'guard JSONSerialization.isValidJSONObject(document)',
    );
    expect(validation).toBeGreaterThan(0);
    expect(validation).toBeLessThan(
      sidecar.indexOf('JSONSerialization.data(withJSONObject: document'),
    );
    expect(validation).toBeLessThan(
      sidecar.indexOf('operation.createOwnedOutput(at: destination)'),
    );
    expect(sidecar).toContain('throw ClipMediaStoreError.invalidEvidence');
    const measured = section(
      store,
      'private static func measuredPayload(',
      'static func writeImportedPoseSequenceSidecar(',
    );
    expect(measured).toContain('fps.isFinite, fps > 0');
    expect(measured).toContain(
      'Int(exactly: (durationSeconds * 1000).rounded())',
    );
    expect(
      measured.indexOf('JSONSerialization.isValidJSONObject(payload)'),
    ).toBeGreaterThan(measured.indexOf('additional.forEach'));
    expect(
      measured.indexOf('JSONSerialization.isValidJSONObject(payload)'),
    ).toBeLessThan(measured.indexOf('return payload'));
  });

  it('validates every pose before window filtering without coercing NaN or discarding invalid evidence', () => {
    const sidecar = section(
      store,
      'private static func writePoseSequenceSidecar(',
      'private static func isValidTimestampMs(',
    );
    const poseValidation = sidecar.indexOf('isUnitInterval(pose.confidence)');
    expect(poseValidation).toBeGreaterThan(0);
    expect(poseValidation).toBeLessThan(sidecar.indexOf('else { continue }'));
    expect(sidecar).toContain('isUnitInterval($0.x)');
    expect(sidecar).toContain('isUnitInterval($0.y)');
    expect(sidecar).toContain('isUnitInterval($0.visibility)');
    expect(sidecar).toContain('isValidTimestampMs(pose.timestampMs)');
    expect(sidecar).toContain('pose.timestampMs >= $0');
    expect(sidecar).toContain('windowEndTimestampMs >= windowStartTimestampMs');
    expect(sidecar).not.toMatch(/\.sorted\(|\.filter\(|\.compactMap\(/);
    expect(store).toContain('value.isFinite && (0...1).contains(value)');
  });

  it('bounds native timestamps before arithmetic while retaining grouped rollback after validation failure', () => {
    const guided = section(
      store,
      'static func exportStrokeWindow(',
      'static func importedPayload(',
    );
    expect(guided.indexOf('.allSatisfy(isValidTimestampMs)')).toBeLessThan(
      guided.indexOf('event.startMs - preRollMs'),
    );
    expect(guided).toContain(
      'event.recognition.confidence.map(isUnitInterval)',
    );
    expect(guided).toContain('telemetry.peakMotionValue.isFinite');
    expect(guided).toContain('$0.value.isFinite');
    expect(store).toContain('value >= 0 && value <= 9_007_199_254_740_991');
    expect(guided.indexOf('operation.commitOwnedOutputs()')).toBeGreaterThan(
      guided.indexOf('let payload = try measuredPayload('),
    );
    expect(
      guided.indexOf(
        'operation.endWork()',
        guided.indexOf('export.exportAsynchronously'),
      ),
    ).toBeLessThan(guided.indexOf('completion(result)'));
    expect(
      guided.indexOf(
        'operation.cleanupOwnedOutputs()',
        guided.indexOf('export.exportAsynchronously'),
      ),
    ).toBeLessThan(guided.indexOf('completion(result)'));
  });

  it('does not migrate or exclude the existing captures directory or its legacy children', () => {
    const directory = section(
      store,
      'private static var capturesDirectory:',
      'static func resolveCaptureURL(',
    );
    const exists = directory.indexOf('if FileManager.default.fileExists(');
    const create = directory.indexOf(
      'try FileManager.default.createDirectory(',
    );
    expect(exists).toBeGreaterThan(0);
    expect(exists).toBeLessThan(create);
    expect(directory.slice(exists, create)).toContain('return directory');
    expect(directory).not.toMatch(
      /isExcludedFromBackup|setResourceValues|setAttributes|removeItem/,
    );
    expect(store).not.toMatch(/contentsOfDirectory|enumerator\(at:/);
  });

  it('bounds provider, metadata and extraction stalls using cancellable operation deadlines', () => {
    expect(store).toContain('ProcessInfo.processInfo.systemUptime');
    expect(store).toContain('metadataTimeoutSeconds');
    expect(bridge).toContain('copyTimeoutSeconds');
    expect(bridge).toContain('extractionTimeoutSeconds');
    expect(bridge).toContain('cancelMediaOperation(');
    expect(store).toContain('camera.import_timeout');
  });
});
