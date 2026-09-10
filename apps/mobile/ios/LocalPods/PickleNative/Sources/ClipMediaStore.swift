import AVFoundation
import CryptoKit
import Darwin
import Foundation
import UIKit

enum ClipMediaStoreError: LocalizedError {
  case invalidMedia
  case fileAccessFailed
  case invalidEvidence
  case exportUnavailable
  case exportFailed(String)

  var errorDescription: String? {
    switch self {
    case .invalidMedia:
      return "This video could not be validated for analysis. Try recording or importing it again."
    case .fileAccessFailed:
      return "The private video file could not be accessed safely. Try recording or importing it again."
    case .invalidEvidence:
      return "The recording contains invalid native analysis evidence."
    case .exportUnavailable:
      return "A private clip could not be created from this recording."
    case .exportFailed(let message):
      return message
    }
  }

  var code: String {
    switch self {
    case .invalidMedia: return "camera.invalid_media"
    case .fileAccessFailed: return "camera.file_access_failed"
    case .invalidEvidence: return "camera.invalid_evidence"
    case .exportUnavailable: return "camera.export_unavailable"
    case .exportFailed: return "camera.export_failed"
    }
  }
}

struct ImportMediaFailure: LocalizedError {
  let code: String
  let message: String
  var errorDescription: String? { message }

  static let cancelled = ImportMediaFailure(
    code: "camera.cancelled", message: "Video import was canceled."
  )
  static let timedOut = ImportMediaFailure(
    code: "camera.import_timeout", message: "Video import took too long. Try a shorter video."
  )
  static let resourceLimit = ImportMediaFailure(
    code: "camera.import_resource_limit",
    message: "This video exceeds the app's current import budget. Try a shorter or lower-resolution video."
  )
  static let fileUnavailable = ImportMediaFailure(
    code: "camera.import_file_unavailable",
    message: "The selected video file could not be opened or copied. Select it again and retry."
  )
  static let notMovie = ImportMediaFailure(
    code: "camera.import_not_movie", message: "The selected file is not a supported movie. Choose another video."
  )
  static let protectedContent = ImportMediaFailure(
    code: "camera.import_protected_content", message: "This video is protected and cannot be analyzed. Choose an unprotected video."
  )
  static let noVideoTrack = ImportMediaFailure(
    code: "camera.import_no_video_track", message: "The selected movie does not contain a video track. Choose another video."
  )
  static let lowStorage = ImportMediaFailure(
    code: "camera.import_low_storage", message: "There is not enough free space to import and analyze this video."
  )

  static func classify(_ error: Error, fallbackCode: String) -> ImportMediaFailure {
    if let failure = error as? ImportMediaFailure { return failure }
    if let failure = error as? ClipMediaStoreError {
      return ImportMediaFailure(code: failure.code, message: failure.localizedDescription)
    }
    let failure = error as NSError
    if failure.domain == NSCocoaErrorDomain {
      switch failure.code {
      case NSFileReadNoSuchFileError, NSFileNoSuchFileError, NSFileReadNoPermissionError, NSFileWriteNoPermissionError:
        return .fileUnavailable
      case NSFileWriteOutOfSpaceError:
        return .lowStorage
      case NSUserCancelledError:
        return .cancelled
      default: break
      }
    }
    if failure.domain == NSPOSIXErrorDomain {
      if [Int(ENOENT), Int(EACCES), Int(EPERM)].contains(failure.code) { return .fileUnavailable }
      if failure.code == Int(ENOSPC) { return .lowStorage }
    }
    if failure.domain == AVFoundationErrorDomain {
      switch failure.code {
      case AVError.fileFormatNotRecognized.rawValue, AVError.fileFailedToParse.rawValue: return .notMovie
      case AVError.contentIsProtected.rawValue, AVError.contentIsNotAuthorized.rawValue: return .protectedContent
      case AVError.diskFull.rawValue: return .lowStorage
      default: break
      }
    }
    return ImportMediaFailure(
      code: fallbackCode,
      message: fallbackCode == "camera.byte_comparison_unavailable"
        ? "The saved video could not be checked. Try again."
        : "The video could not be processed. Try selecting it again."
    )
  }
}

enum ProvisionalImportBudget {
  static let maximumDurationSeconds = 60.0
  static let maximumSourceBytes: Int64 = 512 * 1024 * 1024
  static let maximumFramePixels = 4096 * 2160
  static let maximumFrameDimension = 4096
  static let maximumDecodedFrameBytes = maximumFramePixels * 4
  static let maximumFrameRate = 240.0
  static let maximumDecodedFrames = 60 * 240 + 1
  static let maximumPoseFrames = 4000
  static let maximumLandmarksPerPose = 64
  static let maximumSidecarBytes = 16 * 1024 * 1024
  static let maximumPosterBytes = 8 * 1024 * 1024
  static let diskReserveBytes: Int64 = 64 * 1024 * 1024
  static let copyChunkBytes = 1024 * 1024
  static let metadataTimeoutSeconds = 15.0
  static let copyTimeoutSeconds = 120.0
  static let extractionTimeoutSeconds = 180.0
}

/// A filesystem generation, not a filename/size identity. Never serialized as
/// athlete identity or as proof of media timing. ctime also catches same-size
/// writes whose mtime was restored. Readers pin both the descriptor and path.
struct ClipFileSnapshot {
  private let value: stat
  var byteSize: Int64 { value.st_size }
  var isDirectory: Bool { value.st_mode & S_IFMT == S_IFDIR }

  init(_ value: stat) { self.value = value }

  func isSameFile(as other: ClipFileSnapshot) -> Bool {
    value.st_dev == other.value.st_dev && value.st_ino == other.value.st_ino
      && value.st_birthtimespec.tv_sec == other.value.st_birthtimespec.tv_sec
      && value.st_birthtimespec.tv_nsec == other.value.st_birthtimespec.tv_nsec
      && value.st_mode & S_IFMT == other.value.st_mode & S_IFMT
  }

  func isUnchanged(from other: ClipFileSnapshot) -> Bool {
    isSameFile(as: other) && value.st_size == other.value.st_size
      && value.st_mtimespec.tv_sec == other.value.st_mtimespec.tv_sec
      && value.st_mtimespec.tv_nsec == other.value.st_mtimespec.tv_nsec
      && value.st_ctimespec.tv_sec == other.value.st_ctimespec.tv_sec
      && value.st_ctimespec.tv_nsec == other.value.st_ctimespec.tv_nsec
      && value.st_nlink == other.value.st_nlink
  }

  static func at(_ url: URL, directory: Bool = false) throws -> ClipFileSnapshot {
    try GuardedClipFile(url: url, directory: directory).snapshot()
  }
}

/// No URL-based FileHandle open: O_NOFOLLOW applies to EVERY path component,
/// not just the leaf. O_NONBLOCK avoids hanging on a substituted FIFO/device;
/// only single-link regular files (or explicitly requested directories) pass.
final class GuardedClipFile {
  let url: URL
  let handle: FileHandle
  private let directory: Bool

  static func withParent<T>(of url: URL, _ body: (Int32, String) throws -> T) throws -> T {
    guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost",
          !url.path.utf8.contains(0),
          !url.pathComponents.contains(".."), !url.pathComponents.contains("."),
          url.pathComponents.count > 1 else { throw ClipMediaStoreError.fileAccessFailed }
    let components = storageComponents(url.deletingLastPathComponent())
    let roots = [URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true), FileManager.default.temporaryDirectory]
    for root in roots {
      let rootComponents = storageComponents(root)
      guard rootComponents.count > 1, components.starts(with: rootComponents) else { continue }
      var descriptor = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
      guard descriptor >= 0 else { throw ClipMediaStoreError.fileAccessFailed }
      defer { Darwin.close(descriptor) }
      for component in components.dropFirst(rootComponents.count) {
        let next = Darwin.openat(descriptor, component, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard next >= 0 else { throw ClipMediaStoreError.fileAccessFailed }
        Darwin.close(descriptor)
        descriptor = next
      }
      return try body(descriptor, url.lastPathComponent)
    }
    throw ClipMediaStoreError.fileAccessFailed
  }

  private static func storageComponents(_ url: URL) -> [String] {
    var components = url.pathComponents
    // Foundation shortens /private/var and /private/tmp back to the OS aliases
    // even after resolvingSymlinksInPath(). Canonicalize ONLY those two verified
    // system-root links; never resolve a provider/user-controlled intermediate.
    if components.count > 1, components[1] == "var" || components[1] == "tmp" {
      components.insert("private", at: 1)
    }
    return components
  }

  init(url: URL, writing: Bool = false, directory: Bool = false) throws {
    self.url = url
    self.directory = directory
    let descriptor = try Self.withParent(of: url) { parent, name in
      Darwin.openat(parent, name, (writing ? O_RDWR : O_RDONLY) | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | (directory ? O_DIRECTORY : 0))
    }
    guard descriptor >= 0 else { throw ClipMediaStoreError.fileAccessFailed }
    handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    _ = try snapshot()
  }

  deinit { try? handle.close() }

  func snapshot() throws -> ClipFileSnapshot {
    var value = stat()
    guard Darwin.fstat(handle.fileDescriptor, &value) == 0,
          directory ? value.st_mode & S_IFMT == S_IFDIR : (value.st_mode & S_IFMT == S_IFREG && value.st_nlink == 1) else {
      throw ClipMediaStoreError.fileAccessFailed
    }
    return ClipFileSnapshot(value)
  }

  func verifyUnchanged(_ expected: ClipFileSnapshot) throws {
    guard try snapshot().isUnchanged(from: expected),
          try ClipFileSnapshot.at(url, directory: directory).isUnchanged(from: expected) else {
      throw ClipMediaStoreError.fileAccessFailed
    }
  }

  /// Deliberately non-recursive. Unknown children, symlinks and replacement
  /// inodes are NOT this operation's artifacts and are left untouched.
  static func removeOwned(_ url: URL, identity: ClipFileSnapshot) {
    try? withParent(of: url) { parent, name in
      var current = stat()
      guard Darwin.fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) == 0,
            ClipFileSnapshot(current).isSameFile(as: identity) else { return }
      _ = Darwin.unlinkat(parent, name, identity.isDirectory ? AT_REMOVEDIR : 0)
    }
  }
}

enum ClipVideoOrigin: String {
  case importCopy = "import_copy"
  case nativeExport = "native_export"
}

private struct NativeClipVideoIdentity {
  let snapshot: ClipFileSnapshot
  let payload: [String: Any]
}

final class ClipMediaOperation {
  let id: String
  private let lock = NSLock()
  private var failure: ImportMediaFailure?
  private var deadline: TimeInterval?
  private var working = false
  private var workStarted = false
  private var committed = false
  private var cancellationHandlers: [UUID: () -> Void] = [:]
  private var workDrainedHandlers: [() -> Void] = []
  private var ownedOutputs: [URL: ClipFileSnapshot] = [:]
  // AVAssetExportSession requires a nonexistent output. Only its exact reserved
  // name inside a newly/exclusively created directory can be adopted on drain.
  private var exportSlots: [URL: ClipFileSnapshot] = [:]
  private var videoIdentities: [URL: NativeClipVideoIdentity] = [:]

  init(id: String = UUID().uuidString.lowercased()) {
    self.id = id
  }

  var isWorking: Bool {
    lock.lock()
    defer { lock.unlock() }
    return working
  }

  var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return failure != nil || deadline.map { ProcessInfo.processInfo.systemUptime >= $0 } == true
  }

  func setDeadline(seconds: TimeInterval) {
    lock.lock()
    deadline = ProcessInfo.processInfo.systemUptime + seconds
    lock.unlock()
  }

  func startWork() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !workStarted, (try? checkLocked()) != nil else { return false }
    workStarted = true
    working = true
    return true
  }

  func endWork() {
    lock.lock()
    working = false
    let handlers = workDrainedHandlers
    workDrainedHandlers.removeAll()
    lock.unlock()
    handlers.forEach { $0() }
  }

  func afterWorkDrains(_ handler: @escaping () -> Void) {
    lock.lock()
    if working {
      workDrainedHandlers.append(handler)
      lock.unlock()
    } else {
      lock.unlock()
      handler()
    }
  }

  func checkActive() throws {
    lock.lock()
    defer { lock.unlock() }
    try checkLocked()
  }

  private func checkLocked() throws {
    if let failure { throw failure }
    if committed { throw ImportMediaFailure.cancelled }
    if let deadline, ProcessInfo.processInfo.systemUptime >= deadline {
      throw ImportMediaFailure.timedOut
    }
  }

  func onCancel(_ handler: @escaping () -> Void) -> UUID {
    let key = UUID()
    lock.lock()
    let inactive = (try? checkLocked()) == nil
    if !inactive { cancellationHandlers[key] = handler }
    lock.unlock()
    if inactive { handler() }
    return key
  }

  func removeCancellationHandler(_ key: UUID) {
    lock.lock()
    cancellationHandlers.removeValue(forKey: key)
    lock.unlock()
  }

  func cancel(_ reason: ImportMediaFailure = .cancelled) {
    lock.lock()
    guard failure == nil, !committed else {
      lock.unlock()
      return
    }
    failure = reason
    let handlers = Array(cancellationHandlers.values)
    cancellationHandlers.removeAll()
    lock.unlock()
    handlers.forEach { $0() }
  }

  func makeOwnedOutputURL(in directory: URL, prefix: String, pathExtension: String) throws -> URL {
    let url = directory.appendingPathComponent("\(prefix)-\(UUID().uuidString.lowercased()).\(pathExtension)")
    try createOwnedOutput(at: url)
    return url
  }

  func makeOwnedExportURL(in directory: URL, prefix: String = "stroke", pathExtension: String = "mov") throws -> URL {
    try checkActive()
    let stagingDirectory = directory.appendingPathComponent(".export-\(UUID().uuidString.lowercased())", isDirectory: true)
    guard ClipMediaStore.isPrivateCaptureURL(stagingDirectory) else { throw ClipMediaStoreError.fileAccessFailed }
    try GuardedClipFile.withParent(of: stagingDirectory) { parent, name in
      guard Darwin.mkdirat(parent, name, 0o700) == 0 else { throw ClipMediaStoreError.fileAccessFailed }
    }
    let identity = try ClipFileSnapshot.at(stagingDirectory, directory: true)
    let exportURL = stagingDirectory.appendingPathComponent("\(prefix)-\(UUID().uuidString.lowercased()).\(pathExtension)")
    lock.lock()
    ownedOutputs[stagingDirectory] = identity
    exportSlots[exportURL] = identity
    lock.unlock()
    do {
      try protectOwnedOutput(stagingDirectory)
      return exportURL
    } catch {
      discardOwnedOutput(stagingDirectory)
      throw error
    }
  }

  func finishOwnedExport(at url: URL, in directory: URL) throws -> URL {
    try checkActive()
    let stagingDirectory = url.deletingLastPathComponent()
    _ = try ownedSnapshot(for: stagingDirectory)
    lock.lock()
    let reserved = exportSlots[url] != nil
    lock.unlock()
    guard reserved, ClipMediaStore.isPrivateCaptureURL(url) else { throw ClipMediaStoreError.invalidMedia }
    let identity = try ClipFileSnapshot.at(url)
    let destination = directory.appendingPathComponent(url.lastPathComponent)
    guard ClipMediaStore.isPrivateCaptureURL(destination) else { throw ClipMediaStoreError.invalidMedia }
    lock.lock()
    ownedOutputs[url] = identity
    lock.unlock()
    try protectOwnedOutput(url)
    // moveItem refuses existing destinations. A collision is never enrolled.
    try FileManager.default.moveItem(at: url, to: destination)
    lock.lock()
    ownedOutputs.removeValue(forKey: url)
    ownedOutputs[destination] = identity
    exportSlots.removeValue(forKey: url)
    lock.unlock()
    try protectOwnedOutput(destination)
    discardOwnedOutput(stagingDirectory)
    try checkActive()
    return destination
  }

  func createOwnedOutput(at url: URL) throws {
    try checkActive()
    guard ClipMediaStore.isPrivateCaptureURL(url) else { throw ClipMediaStoreError.fileAccessFailed }
    // Open the parent without following links BEFORE creating anything. An
    // empty exclusive inode is enrolled/protected before any media bytes enter
    // it; a late cancellation can therefore clean this exact new artifact.
    let descriptor = try GuardedClipFile.withParent(of: url) { parent, name in
      Darwin.openat(parent, name, O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
    }
    guard descriptor >= 0 else { throw ClipMediaStoreError.fileAccessFailed }
    defer { Darwin.close(descriptor) }
    var value = stat()
    guard Darwin.fstat(descriptor, &value) == 0 else { throw ClipMediaStoreError.fileAccessFailed }
    let identity = ClipFileSnapshot(value)
    lock.lock()
    ownedOutputs[url] = identity
    lock.unlock()
    do {
      try protectOwnedOutput(url)
    } catch {
      discardOwnedOutput(url)
      throw error
    }
  }

  func writeOwnedChunk(_ data: Data, to handle: FileHandle) throws {
    try checkActive()
    try handle.write(contentsOf: data)
    try checkActive()
  }

  func writeOwnedData(_ data: Data, to url: URL) throws {
    try checkActive()
    _ = try ownedSnapshot(for: url)
    lock.lock()
    let sealed = videoIdentities[url] != nil
    lock.unlock()
    guard !sealed else { throw ClipMediaStoreError.invalidMedia }
    do {
      try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      // Atomic replacement is our write, so record its new inode before any
      // cancellation/protection check. Otherwise rollback would orphan it.
      let identity = try ClipFileSnapshot.at(url)
      lock.lock()
      ownedOutputs[url] = identity
      lock.unlock()
      try protectOwnedOutput(url)
    } catch {
      discardOwnedOutput(url)
      throw error
    }
  }

  private func ownedSnapshot(for url: URL) throws -> ClipFileSnapshot {
    lock.lock()
    let owned = ownedOutputs[url]
    lock.unlock()
    guard let owned, ClipMediaStore.isPrivateCaptureURL(url) else { throw ClipMediaStoreError.invalidMedia }
    let current = try ClipFileSnapshot.at(url, directory: owned.isDirectory)
    guard current.isSameFile(as: owned) else { throw ClipMediaStoreError.invalidMedia }
    return current
  }

  func protectOwnedOutput(_ url: URL) throws {
    try checkActive()
    _ = try ownedSnapshot(for: url)
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: url.path
    )
    var target = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try target.setResourceValues(values)
    try checkActive()
  }

  /// Hash only a movie created by THIS operation, after its writer is done.
  /// No API certifies a stored/relocated legacy URI. The bounded descriptor read
  /// hashes destination bytes, not source metadata or a guessed filename hash.
  func sealVideoOutput(at url: URL, origin: ClipVideoOrigin, progress: ((Int64) -> Void)? = nil) throws -> [String: Any] {
    try checkActive()
    let expected = try ownedSnapshot(for: url)
    guard !expected.isDirectory, expected.byteSize > 0,
          expected.byteSize <= ProvisionalImportBudget.maximumSourceBytes else { throw ImportMediaFailure.resourceLimit }
    lock.lock()
    let alreadySealed = videoIdentities[url] != nil
    lock.unlock()
    guard !alreadySealed else { throw ClipMediaStoreError.invalidMedia }
    let input = try GuardedClipFile(url: url)
    try input.verifyUnchanged(expected)
    var digest = SHA256()
    var byteCount: Int64 = 0
    while true {
      let count: Int = try autoreleasepool {
        try checkActive()
        try input.verifyUnchanged(expected)
        let chunk = try input.handle.read(upToCount: ProvisionalImportBudget.copyChunkBytes) ?? Data()
        byteCount += Int64(chunk.count)
        guard byteCount <= expected.byteSize, byteCount <= ProvisionalImportBudget.maximumSourceBytes else {
          throw ImportMediaFailure.resourceLimit
        }
        digest.update(data: chunk)
        if !chunk.isEmpty { progress?(byteCount) }
        try checkActive()
        return chunk.count
      }
      if count == 0 { break }
    }
    try input.verifyUnchanged(expected)
    guard byteCount == expected.byteSize else { throw ClipMediaStoreError.invalidMedia }
    let payload: [String: Any] = [
      "schemaVersion": 1,
      "format": "pickle.native-media-identity.v1",
      "receiptId": UUID().uuidString.lowercased(),
      "operationId": id,
      "videoFileName": url.lastPathComponent,
      "origin": origin.rawValue,
      "algorithm": "sha256",
      "sha256": digest.finalize().map { String(format: "%02x", $0) }.joined(),
      "byteSize": byteCount,
    ]
    lock.lock()
    defer { lock.unlock() }
    try checkLocked()
    videoIdentities[url] = NativeClipVideoIdentity(snapshot: expected, payload: payload)
    return payload
  }

  func videoIdentityPayload(for url: URL) throws -> [String: Any]? {
    try checkActive()
    lock.lock()
    let identity = videoIdentities[url]
    lock.unlock()
    guard let identity else { return nil }
    let input = try GuardedClipFile(url: url)
    try input.verifyUnchanged(identity.snapshot)
    try checkActive()
    return identity.payload
  }

  /// Copies a pinned source generation with bounded memory. A same-name,
  /// same-size edit during metadata loading/copy is not certified as that input.
  func copyVideoBytes(from source: URL, to destination: URL, expected: ClipFileSnapshot, progress: ((Int64) -> Void)? = nil) throws {
    try checkActive()
    let input = try GuardedClipFile(url: source)
    try input.verifyUnchanged(expected)
    guard expected.byteSize > 0, expected.byteSize <= ProvisionalImportBudget.maximumSourceBytes else {
      throw ImportMediaFailure.resourceLimit
    }
    let owned = try ownedSnapshot(for: destination)
    let output = try GuardedClipFile(url: destination, writing: true)
    guard try output.snapshot().isSameFile(as: owned), owned.byteSize == 0 else { throw ClipMediaStoreError.invalidMedia }
    var copied: Int64 = 0
    while true {
      let count: Int = try autoreleasepool {
        try checkActive()
        try input.verifyUnchanged(expected)
        let chunk = try input.handle.read(upToCount: ProvisionalImportBudget.copyChunkBytes) ?? Data()
        copied += Int64(chunk.count)
        guard copied <= expected.byteSize, copied <= ProvisionalImportBudget.maximumSourceBytes else {
          throw ImportMediaFailure.resourceLimit
        }
        _ = try ownedSnapshot(for: destination)
        try writeOwnedChunk(chunk, to: output.handle)
        if !chunk.isEmpty { progress?(copied) }
        try checkActive()
        return chunk.count
      }
      if count == 0 { break }
    }
    try input.verifyUnchanged(expected)
    guard copied == expected.byteSize else { throw ClipMediaStoreError.invalidMedia }
    try output.handle.synchronize()
    try protectOwnedOutput(destination)
    _ = try sealVideoOutput(at: destination, origin: .importCopy)
    try input.verifyUnchanged(expected)
    try checkActive()
  }

  /// The owner calls this on its publication queue AFTER checking its epoch.
  /// Cancellation and this final receipt validation are linearized by lock.
  func commitOwnedOutputs() throws {
    lock.lock()
    defer { lock.unlock() }
    try checkLocked()
    for (url, identity) in videoIdentities {
      try GuardedClipFile(url: url).verifyUnchanged(identity.snapshot)
    }
    for (url, identity) in ownedOutputs {
      guard try ClipFileSnapshot.at(url, directory: identity.isDirectory).isSameFile(as: identity) else {
        throw ClipMediaStoreError.invalidMedia
      }
    }
    try checkLocked()
    committed = true
    deadline = nil
    ownedOutputs.removeAll()
    exportSlots.removeAll()
    videoIdentities.removeAll()
    cancellationHandlers.removeAll()
  }

  func discardOwnedOutput(_ url: URL) {
    lock.lock()
    let owned = ownedOutputs.removeValue(forKey: url)
    videoIdentities.removeValue(forKey: url)
    lock.unlock()
    if let owned { GuardedClipFile.removeOwned(url, identity: owned) }
  }

  func cleanupOwnedOutputs() {
    lock.lock()
    guard !working else {
      lock.unlock()
      return
    }
    if !committed, failure == nil { failure = .cancelled }
    var outputs = ownedOutputs
    let slots = exportSlots
    ownedOutputs.removeAll()
    exportSlots.removeAll()
    videoIdentities.removeAll()
    cancellationHandlers.removeAll()
    lock.unlock()
    for (url, directoryIdentity) in slots {
      if let current = try? ClipFileSnapshot.at(url.deletingLastPathComponent(), directory: true),
         current.isSameFile(as: directoryIdentity), let file = try? ClipFileSnapshot.at(url) {
        outputs[url] = file
      }
    }
    // Files before directories, and only rmdir on an empty owned directory.
    for (url, identity) in outputs.sorted(by: { $0.key.pathComponents.count > $1.key.pathComponents.count }) {
      GuardedClipFile.removeOwned(url, identity: identity)
    }
  }
}

/// Strict caller-supplied expectation, not a lookup in a native receipt ledger.
/// Valid syntax does NOT establish durable original identity, ownership or rights.
struct NativeClipByteExpectation {
  let uri: String
  let operationId: String
  let receiptId: String
  let videoFileName: String
  let sha256: String
  let byteSize: Int64

  static let invalid = ImportMediaFailure(
    code: "camera.invalid_byte_comparison_request",
    message: "The supplied video byte expectation is invalid."
  )

  init(request: NSDictionary) throws {
    let requestKeys: Set<String> = ["uri", "operationId", "byteSize", "nativeMediaIdentity"]
    let identityKeys: Set<String> = ["schemaVersion", "format", "receiptId", "operationId", "videoFileName", "origin", "algorithm", "sha256", "byteSize"]
    guard Set(request.allKeys.compactMap { $0 as? String }) == requestKeys, request.count == requestKeys.count,
          let uri = request["uri"] as? String,
          let operationId = request["operationId"] as? String,
          operationId.range(of: "^[A-Za-z0-9_-]{1,128}\\z", options: .regularExpression) != nil,
          let identity = request["nativeMediaIdentity"] as? NSDictionary,
          identity.count == identityKeys.count, Set(identity.allKeys.compactMap { $0 as? String }) == identityKeys,
          Self.integer(identity["schemaVersion"]) == 1,
          identity["format"] as? String == "pickle.native-media-identity.v1",
          let receiptId = identity["receiptId"] as? String, Self.isNativeUUID(receiptId),
          let creationId = identity["operationId"] as? String, Self.isNativeUUID(creationId),
          let videoFileName = identity["videoFileName"] as? String, videoFileName.utf8.count <= 240,
          videoFileName.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]*\\.(mov|mp4|m4v)\\z", options: .regularExpression) != nil,
          let origin = identity["origin"] as? String, ["import_copy", "native_export"].contains(origin),
          identity["algorithm"] as? String == "sha256",
          let sha256 = identity["sha256"] as? String,
          sha256.range(of: "^[0-9a-f]{64}\\z", options: .regularExpression) != nil,
          let byteSize = Self.integer(identity["byteSize"]), byteSize > 0,
          byteSize <= ProvisionalImportBudget.maximumSourceBytes,
          Self.integer(request["byteSize"]) == byteSize else { throw Self.invalid }
    self.uri = uri
    self.operationId = operationId
    self.receiptId = receiptId
    self.videoFileName = videoFileName
    self.sha256 = sha256
    self.byteSize = byteSize
    guard try storedURL().lastPathComponent == videoFileName else { throw Self.invalid }
  }

  private static func integer(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue >= 0,
          number.doubleValue <= Double(ProvisionalImportBudget.maximumSourceBytes),
          number.doubleValue.rounded(.towardZero) == number.doubleValue else { return nil }
    return number.int64Value
  }

  static func isNativeUUID(_ value: String) -> Bool {
    value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\z", options: .regularExpression) != nil
  }

  func storedURL() throws -> URL {
    guard uri.utf8.count <= 4096,
          uri.hasPrefix("file:///") || uri.hasPrefix("file://localhost/"),
          !uri.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }),
          !uri.contains("\\"), !uri.contains("?"), !uri.contains("#"),
          uri.range(of: "%2f|%5c", options: [.regularExpression, .caseInsensitive]) == nil,
          let parts = URLComponents(string: uri), parts.scheme == "file",
          parts.host == nil || parts.host == "" || parts.host == "localhost",
          parts.user == nil, parts.password == nil, parts.port == nil,
          parts.query == nil, parts.fragment == nil,
          let path = parts.percentEncodedPath.removingPercentEncoding,
          !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
          !path.contains("\\"), !path.contains("?"), !path.contains("#"), !path.contains("%"),
          path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
          let url = parts.url, url.isFileURL else { throw Self.invalid }
    return url
  }
}

/// Ephemeral descriptor/path generation pin retained until bridge publication.
/// The payload claims ONLY current bytes match the supplied expectation. No
/// new creation receipt is minted and nothing is enrolled for write or deletion.
final class CurrentClipByteComparison {
  private let root: GuardedClipFile
  private let rootSnapshot: ClipFileSnapshot
  private let input: GuardedClipFile
  private let snapshot: ClipFileSnapshot
  private let expectation: NativeClipByteExpectation
  fileprivate var matches = false

  init(root: GuardedClipFile, input: GuardedClipFile, expectation: NativeClipByteExpectation) throws {
    self.root = root
    rootSnapshot = try root.snapshot()
    self.input = input
    snapshot = try input.snapshot()
    self.expectation = expectation
  }

  fileprivate var byteSize: Int64 { snapshot.byteSize }

  var payload: [String: Any] {
    [
      "status": matches ? "verified-current-bytes" : "mismatch",
      "operationId": expectation.operationId,
      "receiptId": expectation.receiptId,
      "videoFileName": expectation.videoFileName,
      "expectedSha256": expectation.sha256,
      "expectedByteSize": expectation.byteSize,
    ]
  }

  func verifyUnchanged(operation: ClipMediaOperation) throws {
    try operation.checkActive()
    guard operation.id == expectation.operationId,
          try root.snapshot().isSameFile(as: rootSnapshot),
          try ClipFileSnapshot.at(root.url, directory: true).isSameFile(as: rootSnapshot) else {
      throw ClipMediaStoreError.invalidMedia
    }
    try input.verifyUnchanged(snapshot)
    try operation.checkActive()
  }
}

struct ImportedVideoMetadata {
  let asset: AVURLAsset
  let track: AVAssetTrack
  let durationSeconds: Double
  let width: Int
  let height: Int
  let fps: Double
  let byteSize: Int64
  var sourceSnapshot: ClipFileSnapshot? = nil
}

enum ClipMediaStore {
  private static let observationLock = NSLock()
  private static var observationSlots: [URL: ClipFileSnapshot] = [:]

  private static var capturesDirectory: URL {
    get throws {
      let support = try FileManager.default.url(
        for: .applicationSupportDirectory,
        in: .userDomainMask,
        appropriateFor: nil,
        create: true
      )
      let directory = support.standardizedFileURL
        .appendingPathComponent("PickleSensei/Captures", isDirectory: true)
      guard directory.resolvingSymlinksInPath().path == directory.path else {
        throw ClipMediaStoreError.fileAccessFailed
      }
      var isDirectory: ObjCBool = false
      if FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) {
        guard isDirectory.boolValue else { throw ClipMediaStoreError.fileAccessFailed }
        return directory
      }
      try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
      )
      return directory
    }
  }

  /// Stored capture payloads carry ABSOLUTE `file://` URLs, but iOS relocates
  /// the app's data container (`…/Containers/Data/Application/<UUID>/…`)
  /// between installs — on every Xcode build in practice — while keeping the
  /// files inside it. An older clip, poster or pose sidecar therefore points
  /// at a path that no longer exists even though the bytes are still here.
  /// Every native reader resolves through this: the recorded URL when it
  /// still exists; else the SAME file name inside today's Captures directory
  /// when that exists (names are UUID-based, so the match is exact); else the
  /// recorded URL unchanged so the caller fails honestly.
  static func resolveCaptureURL(fromStoredUri uri: String) -> URL? {
    guard let stored = fileURL(from: uri), stored.isFileURL,
          stored.host == nil || stored.host == "" || stored.host == "localhost",
          !stored.pathComponents.contains("..") else { return nil }
    if FileManager.default.fileExists(atPath: stored.path) { return stored }
    guard
      stored.deletingLastPathComponent().lastPathComponent == "Captures",
      let directory = try? capturesDirectory
    else { return stored }
    let relocated = directory.appendingPathComponent(stored.lastPathComponent)
    return FileManager.default.fileExists(atPath: relocated.path) ? relocated : stored
  }

  static func fileURL(from uri: String) -> URL? {
    if uri.hasPrefix("file://") { return URL(string: uri) }
    if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
    return URL(string: uri)
  }

  static func isPrivateCaptureURL(_ url: URL) -> Bool {
    guard url.isFileURL, let directory = try? capturesDirectory else { return false }
    let resolved = url.standardizedFileURL.resolvingSymlinksInPath()
    return resolved.path.hasPrefix(directory.path + "/")
  }

  /// Read-only: resolve ONLY a direct child in today's Captures root, never
  /// open a stored old-container/private path. Relocation is addressing, not
  /// byte identity. Do not use the creation getter (which creates directories).
  static func compareCapturedClipBytes(
    _ expectation: NativeClipByteExpectation,
    operation: ClipMediaOperation,
    progress: ((Int64) -> Void)? = nil
  ) throws -> CurrentClipByteComparison {
    try operation.checkActive()
    let stored = try expectation.storedURL()
    let support = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false
    )
    let directory = support.standardizedFileURL.appendingPathComponent("PickleSensei/Captures", isDirectory: true)
    let components = stored.pathComponents
    // Old app-container URIs may be relocated by basename, but unrelated private
    // paths and nested artifacts are not accepted even when the name matches.
    let suffix = Array(components.suffix(9))
    let relocatedContainer = suffix.count == 9 && Array(suffix.prefix(3)) == ["Containers", "Data", "Application"]
      && NativeClipByteExpectation.isNativeUUID(suffix[3].lowercased())
      && Array(suffix[4...7]) == ["Library", "Application Support", "PickleSensei", "Captures"]
    guard stored.lastPathComponent == expectation.videoFileName,
          stored.deletingLastPathComponent().standardizedFileURL.path == directory.path || relocatedContainer else {
      throw NativeClipByteExpectation.invalid
    }
    let root = try GuardedClipFile(url: directory, directory: true)
    let videoURL = directory.appendingPathComponent(expectation.videoFileName)
    let input = try GuardedClipFile(url: videoURL)
    let comparison = try CurrentClipByteComparison(root: root, input: input, expectation: expectation)
    try comparison.verifyUnchanged(operation: operation)
    guard comparison.byteSize > 0, comparison.byteSize <= ProvisionalImportBudget.maximumSourceBytes else {
      throw ImportMediaFailure.resourceLimit
    }
    if comparison.byteSize != expectation.byteSize {
      try comparison.verifyUnchanged(operation: operation)
      return comparison
    }
    var digest = SHA256()
    var byteCount: Int64 = 0
    while true {
      let count: Int = try autoreleasepool {
        try comparison.verifyUnchanged(operation: operation)
        let chunk = try input.handle.read(upToCount: ProvisionalImportBudget.copyChunkBytes) ?? Data()
        byteCount += Int64(chunk.count)
        guard byteCount <= comparison.byteSize, byteCount <= ProvisionalImportBudget.maximumSourceBytes else {
          throw ImportMediaFailure.resourceLimit
        }
        digest.update(data: chunk)
        if !chunk.isEmpty { progress?(byteCount) }
        try comparison.verifyUnchanged(operation: operation)
        return chunk.count
      }
      if count == 0 { break }
    }
    try comparison.verifyUnchanged(operation: operation)
    guard byteCount == comparison.byteSize else { throw ClipMediaStoreError.invalidMedia }
    let currentHash = digest.finalize().map { String(format: "%02x", $0) }.joined()
    comparison.matches = currentHash == expectation.sha256 && byteCount == expectation.byteSize
    try comparison.verifyUnchanged(operation: operation)
    return comparison
  }

  static func makeObservationURL() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("PickleSensei-Observation", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let canonicalDirectory = directory.standardizedFileURL
    let url = canonicalDirectory.appendingPathComponent("observation-\(UUID().uuidString.lowercased()).mov")
    let parent = try ClipFileSnapshot.at(canonicalDirectory, directory: true)
    try GuardedClipFile.withParent(of: url) { descriptor, name in
      var value = stat()
      guard Darwin.fstatat(descriptor, name, &value, AT_SYMLINK_NOFOLLOW) == -1, errno == ENOENT else {
        throw ClipMediaStoreError.fileAccessFailed
      }
    }
    observationLock.lock()
    observationSlots[url] = parent
    observationLock.unlock()
    return url
  }

  /// Only an absent UUID slot issued by this process for CameraEngine can be
  /// discarded. Exporting an arbitrary legacy/source URL does NOT grant delete
  /// rights. A supplied snapshot also fences substitutions during export.
  static func removeOwnedObservation(_ url: URL?, expected: ClipFileSnapshot? = nil) {
    guard let url else { return }
    observationLock.lock()
    let parent = observationSlots.removeValue(forKey: url)
    observationLock.unlock()
    guard let parent,
          let currentParent = try? ClipFileSnapshot.at(url.deletingLastPathComponent(), directory: true),
          currentParent.isSameFile(as: parent), let current = try? ClipFileSnapshot.at(url),
          expected.map({ current.isUnchanged(from: $0) }) ?? true else { return }
    GuardedClipFile.removeOwned(url, identity: current)
  }

  private static func loadImportMetadata(
    _ object: AVAsynchronousKeyValueLoading,
    keys: [String],
    operation: ClipMediaOperation
  ) throws {
    try operation.checkActive()
    let ready = DispatchSemaphore(value: 0)
    object.loadValuesAsynchronously(forKeys: keys) { ready.signal() }
    let deadline = ProcessInfo.processInfo.systemUptime + ProvisionalImportBudget.metadataTimeoutSeconds
    while ready.wait(timeout: .now() + 0.05) == .timedOut {
      try operation.checkActive()
      guard ProcessInfo.processInfo.systemUptime < deadline else { throw ImportMediaFailure.timedOut }
    }
    try operation.checkActive()
    for key in keys {
      var error: NSError?
      guard object.statusOfValue(forKey: key, error: &error) == .loaded else {
        throw ImportMediaFailure.classify(error ?? ClipMediaStoreError.invalidMedia as NSError, fallbackCode: "camera.import_failed")
      }
    }
  }

  static func requireImportDiskCapacity(additionalBytes: Int64) throws {
    let directory = try capturesDirectory
    let values = try directory.resourceValues(forKeys: [
      .volumeAvailableCapacityForImportantUsageKey, .volumeAvailableCapacityKey,
    ])
    guard let available = values.volumeAvailableCapacityForImportantUsage
      ?? values.volumeAvailableCapacity.map({ Int64($0) }) else {
      throw ImportMediaFailure(code: "camera.import_storage_unavailable", message: "Available private storage could not be checked.")
    }
    let required = additionalBytes + ProvisionalImportBudget.diskReserveBytes
      + Int64(ProvisionalImportBudget.maximumSidecarBytes + ProvisionalImportBudget.maximumPosterBytes)
    guard available >= required else { throw ImportMediaFailure.lowStorage }
  }

  private static func copyProviderVideo(from source: URL, operation: ClipMediaOperation) throws -> URL {
    do {
      try operation.checkActive()
      guard source.isFileURL, source.host == nil || source.host == "" || source.host == "localhost",
            !source.path.utf8.contains(0) else { throw ImportMediaFailure.fileUnavailable }
      let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
      guard values.isRegularFile == true, values.isSymbolicLink != true,
            let size = values.fileSize, size > 0 else { throw ImportMediaFailure.notMovie }
      let byteSize = Int64(size)
      guard byteSize <= ProvisionalImportBudget.maximumSourceBytes else { throw ImportMediaFailure.resourceLimit }
      try requireImportDiskCapacity(additionalBytes: byteSize)
      let ext = source.pathExtension.lowercased()
      let stagingURL = try operation.makeOwnedExportURL(
        in: capturesDirectory, prefix: "import", pathExtension: ["mov", "mp4", "m4v"].contains(ext) ? ext : "mov"
      )
      try operation.checkActive()
      try FileManager.default.copyItem(at: source, to: stagingURL)
      try operation.checkActive()
      let destination = try operation.finishOwnedExport(at: stagingURL, in: capturesDirectory)
      let snapshot = try ClipFileSnapshot.at(destination)
      guard snapshot.byteSize <= ProvisionalImportBudget.maximumSourceBytes else { throw ImportMediaFailure.resourceLimit }
      guard snapshot.byteSize == byteSize else { throw ClipMediaStoreError.fileAccessFailed }
      return destination
    } catch {
      throw ImportMediaFailure.classify(error, fallbackCode: "camera.import_file_unavailable")
    }
  }

  static func preflightImport(
    from source: URL,
    operation: ClipMediaOperation,
    copying: Bool = false
  ) throws -> ImportedVideoMetadata {
    try operation.checkActive()
    if copying {
      let destination = try copyProviderVideo(from: source, operation: operation)
      return try preflightImport(from: destination, operation: operation)
    }
    let sourceFile = try GuardedClipFile(url: source)
    let sourceSnapshot = try sourceFile.snapshot()
    let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true,
          let size = values.fileSize, size > 0 else {
      throw ImportMediaFailure.notMovie
    }
    let byteSize = Int64(size)
    guard byteSize <= ProvisionalImportBudget.maximumSourceBytes else { throw ImportMediaFailure.resourceLimit }
    let asset = AVURLAsset(url: source)
    let cancellation = operation.onCancel { asset.cancelLoading() }
    defer {
      asset.cancelLoading()
      operation.removeCancellationHandler(cancellation)
    }
    try loadImportMetadata(asset, keys: ["hasProtectedContent"], operation: operation)
    guard !asset.hasProtectedContent else { throw ImportMediaFailure.protectedContent }
    try loadImportMetadata(asset, keys: ["duration", "tracks", "playable"], operation: operation)
    let tracks = asset.tracks(withMediaType: .video)
    guard !tracks.isEmpty else { throw ImportMediaFailure.noVideoTrack }
    guard asset.isPlayable else { throw ClipMediaStoreError.invalidMedia }
    let durationSeconds = CMTimeGetSeconds(asset.duration)
    guard durationSeconds.isFinite, durationSeconds >= 0.001 else { throw ClipMediaStoreError.invalidMedia }
    guard durationSeconds <= ProvisionalImportBudget.maximumDurationSeconds else {
      throw ImportMediaFailure(code: "camera.import_too_long", message: "Trim this video to 60 seconds or less and import it again.")
    }
    guard tracks.count == 1, let track = tracks.first else { throw ClipMediaStoreError.invalidMedia }
    try loadImportMetadata(track, keys: ["naturalSize", "preferredTransform", "nominalFrameRate", "enabled", "timeRange", "formatDescriptions"], operation: operation)
    guard track.isEnabled else { throw ClipMediaStoreError.invalidMedia }
    let trackDuration = CMTimeGetSeconds(track.timeRange.duration)
    let trackStart = CMTimeGetSeconds(track.timeRange.start)
    guard trackDuration.isFinite, trackDuration > 0,
          trackStart.isFinite, trackStart >= 0,
          trackDuration <= ProvisionalImportBudget.maximumDurationSeconds,
          trackStart + trackDuration <= durationSeconds + 0.001 else {
      throw ClipMediaStoreError.invalidMedia
    }
    let transform = track.preferredTransform
    guard [transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty].allSatisfy({ $0.isFinite }) else {
      throw ClipMediaStoreError.invalidMedia
    }
    let naturalSize = track.naturalSize
    let transformed = naturalSize.applying(transform)
    var sizes = [naturalSize, CGSize(width: abs(transformed.width), height: abs(transformed.height))]
    guard let formats = track.formatDescriptions as? [CMFormatDescription],
          !formats.isEmpty, formats.count <= 16 else { throw ClipMediaStoreError.invalidMedia }
    for format in formats {
      guard CMFormatDescriptionGetMediaType(format) == kCMMediaType_Video else {
        throw ClipMediaStoreError.invalidMedia
      }
      let dimensions = CMVideoFormatDescriptionGetDimensions(format)
      sizes.append(CGSize(width: CGFloat(dimensions.width), height: CGFloat(dimensions.height)))
    }
    for size in sizes {
      guard size.width.isFinite, size.height.isFinite, size.width >= 1, size.height >= 1 else {
        throw ClipMediaStoreError.invalidMedia
      }
      guard size.width <= CGFloat(ProvisionalImportBudget.maximumFrameDimension),
            size.height <= CGFloat(ProvisionalImportBudget.maximumFrameDimension),
            size.width * size.height <= CGFloat(ProvisionalImportBudget.maximumFramePixels) else {
        throw ImportMediaFailure.resourceLimit
      }
    }
    let fps = Double(track.nominalFrameRate)
    guard fps.isFinite, fps > 0 else { throw ClipMediaStoreError.invalidMedia }
    guard fps <= ProvisionalImportBudget.maximumFrameRate,
          ceil(durationSeconds * fps) + 1 <= Double(ProvisionalImportBudget.maximumDecodedFrames) else {
      throw ImportMediaFailure.resourceLimit
    }
    try requireImportDiskCapacity(additionalBytes: 0)
    try sourceFile.verifyUnchanged(sourceSnapshot)
    guard sourceSnapshot.byteSize == byteSize else { throw ClipMediaStoreError.fileAccessFailed }
    try operation.checkActive()
    return ImportedVideoMetadata(
      asset: asset, track: track, durationSeconds: durationSeconds,
      width: Int(abs(transformed.width).rounded()), height: Int(abs(transformed.height).rounded()),
      fps: fps, byteSize: byteSize, sourceSnapshot: sourceSnapshot
    )
  }

  static func persistImportedVideo(
    from source: URL,
    metadata: ImportedVideoMetadata,
    operation: ClipMediaOperation
  ) throws -> URL {
    try operation.checkActive()
    guard let expected = metadata.sourceSnapshot, expected.byteSize == metadata.byteSize else {
      throw ClipMediaStoreError.fileAccessFailed
    }
    if metadata.asset.url != source {
      let destination = metadata.asset.url
      let input = try GuardedClipFile(url: destination)
      try input.verifyUnchanged(expected)
      _ = try operation.sealVideoOutput(at: destination, origin: .importCopy)
      try input.verifyUnchanged(expected)
      return destination
    }
    let ext = source.pathExtension.lowercased()
    let destination = try operation.makeOwnedOutputURL(
      in: capturesDirectory, prefix: "import", pathExtension: ["mov", "mp4", "m4v"].contains(ext) ? ext : "mov"
    )
    try operation.copyVideoBytes(from: source, to: destination, expected: expected)
    return destination
  }

  static func removeIfPresent(_ url: URL?) {
    guard let url, FileManager.default.fileExists(atPath: url.path) else { return }
    try? FileManager.default.removeItem(at: url)
  }

  /// Renders ONE JPEG poster frame beside the video (`<basename>-poster.jpg`
  /// in the same Captures directory) so the app can show a real thumbnail
  /// without decoding video. The frame is sampled at ~25% of the duration —
  /// past any blurry setup frames, well before the clip ends. Best-effort by
  /// contract: any failure returns nil and callers must OMIT the key, so a
  /// payload never carries a broken poster URI. Idempotent: an
  /// already-rendered poster is reused as-is.
  static func writePosterFrame(
    besideVideoAt videoURL: URL,
    operation: ClipMediaOperation? = nil,
    metadata: ImportedVideoMetadata? = nil
  ) -> URL? {
    guard let videoURL = resolveCaptureURL(fromStoredUri: videoURL.absoluteString),
          isPrivateCaptureURL(videoURL) else { return nil }
    if let operation, (try? operation.checkActive()) == nil { return nil }
    let posterURL = videoURL
      .deletingLastPathComponent()
      .appendingPathComponent(videoURL.deletingPathExtension().lastPathComponent + "-poster.jpg")
    guard isPrivateCaptureURL(posterURL) else { return nil }
    if FileManager.default.fileExists(atPath: posterURL.path) {
      guard let values = try? posterURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
            values.isRegularFile == true, let byteSize = values.fileSize,
            byteSize > 0, byteSize <= ProvisionalImportBudget.maximumPosterBytes else { return nil }
      return posterURL
    }

    let outputOperation = operation ?? ClipMediaOperation()
    defer {
      if operation == nil { outputOperation.cleanupOwnedOutputs() }
    }
    // Always render the destination movie, never an ephemeral provider asset
    // that happened to supply the metadata used during a copy.
    let asset = AVURLAsset(url: videoURL)
    let loadingCancellation = outputOperation.onCancel { asset.cancelLoading() }
    defer { outputOperation.removeCancellationHandler(loadingCancellation) }
    do { try loadImportMetadata(asset, keys: ["duration"], operation: outputOperation) } catch { return nil }
    let durationSeconds = CMTimeGetSeconds(asset.duration)
    guard durationSeconds.isFinite, durationSeconds > 0 else { return nil }

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    // Caps the LONG side at ~1280px; aspect ratio is preserved by the
    // generator. Default time tolerances are intentional (nearest keyframe is
    // fine for a poster and much cheaper than exact decode).
    generator.maximumSize = CGSize(width: 1280, height: 1280)
    let cancellation = outputOperation.onCancel { generator.cancelAllCGImageGeneration() }
    defer {
      outputOperation.removeCancellationHandler(cancellation)
    }
    do {
      try outputOperation.checkActive()
      let cgImage = try generator.copyCGImage(
        at: CMTime(seconds: durationSeconds * 0.25, preferredTimescale: 600),
        actualTime: nil
      )
      guard let jpeg = UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.8) else { return nil }
      guard jpeg.count <= ProvisionalImportBudget.maximumPosterBytes else { return nil }
      try outputOperation.createOwnedOutput(at: posterURL)
      try outputOperation.writeOwnedData(jpeg, to: posterURL)
      if operation == nil { try outputOperation.commitOwnedOutputs() }
      return posterURL
    } catch {
      outputOperation.discardOwnedOutput(posterURL)
      return nil
    }
  }

  static func exportStrokeWindow(
    artifact: CameraEngine.RecordingArtifact,
    event: StrokeEvent,
    detectionModelVersion: String,
    captureEvidence: [String: Any],
    completionTelemetry: StrokeCompletionMonitor.Telemetry? = nil,
    poseHistory: [PoseFrame],
    poseModelVersion: String,
    preRollMs: Int,
    postRollMs: Int,
    /// Guided capture owns its finished recording and discards it after the
    /// trim; session capture exports from a STILL-ROLLING recording that must
    /// survive for later events.
    removeSourceRecording: Bool = true,
    // Guided capture MUST pass its bridge-owned operation. The nil convenience
    // remains for the dormant session exporter; only that caller auto-commits.
    operation owningOperation: ClipMediaOperation? = nil,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    let operation = owningOperation ?? ClipMediaOperation()
    do { try operation.checkActive() } catch { completion(.failure(error)); return }
    guard [artifact.firstFrameTimestampMs, artifact.lastFrameTimestampMs,
           event.startMs, event.endMs, preRollMs, postRollMs].allSatisfy(isValidTimestampMs),
          artifact.lastFrameTimestampMs > artifact.firstFrameTimestampMs,
          event.endMs > event.startMs,
          isUnitInterval(event.confidence),
          event.recognition.confidence.map(isUnitInterval) ?? true,
          event.peakMotionMs.map({ isValidTimestampMs($0) && $0 >= event.startMs && $0 <= event.endMs }) ?? true else {
      completion(.failure(ClipMediaStoreError.invalidEvidence))
      return
    }
    if let telemetry = completionTelemetry {
      let timestamps = [telemetry.movementCompleteMs, telemetry.anchorMs, telemetry.finalizeMs, telemetry.observedUntilMs]
        + [telemetry.settleDetectedMs, telemetry.valleyDetectedMs].compactMap { $0 }
      guard timestamps.allSatisfy(isValidTimestampMs),
            telemetry.peakMotionValue.isFinite, telemetry.peakMotionValue >= 0,
            telemetry.observedSampleCount >= 0,
            telemetry.samples.allSatisfy({ isValidTimestampMs($0.timestampMs) && $0.value.isFinite && $0.value >= 0 }) else {
        completion(.failure(ClipMediaStoreError.invalidEvidence))
        return
      }
    }
    let asset = AVURLAsset(url: artifact.url)
    guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
      completion(.failure(ClipMediaStoreError.exportUnavailable))
      return
    }

    let requestedStartTimestamp = event.startMs - preRollMs
    let requestedEndTimestamp = event.endMs + postRollMs
    let selectedStartTimestamp = max(artifact.firstFrameTimestampMs, requestedStartTimestamp)
    let selectedEndTimestamp = min(artifact.lastFrameTimestampMs, requestedEndTimestamp)
    guard selectedEndTimestamp > selectedStartTimestamp else {
      completion(.failure(ClipMediaStoreError.invalidMedia))
      return
    }

    let startSeconds = Double(selectedStartTimestamp - artifact.firstFrameTimestampMs) / 1000
    let durationSeconds = Double(selectedEndTimestamp - selectedStartTimestamp) / 1000
    guard operation.startWork() else {
      completion(.failure(VisionFailure.cancelled))
      return
    }
    operation.setDeadline(seconds: ProvisionalImportBudget.copyTimeoutSeconds)
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + ProvisionalImportBudget.copyTimeoutSeconds) { [weak operation] in
      operation?.cancel(.timedOut)
    }
    let exportURL: URL
    let sourceFile: GuardedClipFile
    let sourceSnapshot: ClipFileSnapshot
    do {
      sourceFile = try GuardedClipFile(url: artifact.url)
      sourceSnapshot = try sourceFile.snapshot()
      exportURL = try operation.makeOwnedExportURL(in: capturesDirectory)
    } catch {
      operation.endWork()
      operation.cleanupOwnedOutputs()
      completion(.failure(error))
      return
    }

    export.outputURL = exportURL
    export.outputFileType = .mov
    export.shouldOptimizeForNetworkUse = false
    export.timeRange = CMTimeRange(
      start: CMTime(seconds: startSeconds, preferredTimescale: 600),
      duration: CMTime(seconds: durationSeconds, preferredTimescale: 600)
    )
    let exportCancellation = operation.onCancel {
      export.cancelExport()
      asset.cancelLoading()
    }
    export.exportAsynchronously {
      var result: Result<[String: Any], Error>
      switch export.status {
      case .completed:
        do {
          try operation.checkActive()
          if owningOperation != nil || removeSourceRecording { try sourceFile.verifyUnchanged(sourceSnapshot) }
          let destination = try operation.finishOwnedExport(at: exportURL, in: capturesDirectory)
          _ = try operation.sealVideoOutput(at: destination, origin: .nativeExport)
          let actualPreRoll = max(0, event.startMs - selectedStartTimestamp)
          let actualPostRoll = max(0, selectedEndTimestamp - event.endMs)
          var trigger: [String: Any] = [
            "startMs": max(0, event.startMs - selectedStartTimestamp),
            "endMs": max(0, event.endMs - selectedStartTimestamp),
            "confidence": event.confidence,
            "source": "temporal_pose_motion",
            "modelVersion": detectionModelVersion,
          ]
          if let peakMotionMs = event.peakMotionMs {
            trigger["peakMotionMs"] = max(0, peakMotionMs - selectedStartTimestamp)
          }
          var additional: [String: Any] = [
            "preRollMs": actualPreRoll,
            "postRollMs": actualPostRoll,
            "trigger": trigger,
            "captureEvidence": captureEvidence,
            "ballSpeed": [
              "status": "unavailable",
              "reason": "calibrated_ball_tracker_unavailable",
            ],
            "recognition": recognitionPayload(event.recognition),
          ]
          if let completionTelemetry {
            // D-029 movement-completion instrumentation: recorded for BOTH
            // strategies (fixed default and flagged adaptive) with the same
            // clip-relative rebase as the trigger block, so offline replay
            // can compare FIXED vs ADAPTIVE decisions on real live captures.
            additional["completion"] = StrokeCompletionMonitor.payload(
              for: completionTelemetry,
              rebasedTo: selectedStartTimestamp
            )
          }
          if let poseSequenceRef = try writePoseSequenceSidecar(
            besideClipAt: destination,
            poseHistory: poseHistory,
            poseModelVersion: poseModelVersion,
            windowStartTimestampMs: selectedStartTimestamp,
            windowEndTimestampMs: selectedEndTimestamp,
            operation: operation
          ) {
            additional["poseSequence"] = poseSequenceRef
          }
          let payload = try measuredPayload(
            for: destination,
            captureMode: "automatic_pose_trigger",
            operation: operation,
            additional: additional
          )
          if owningOperation == nil {
            try operation.commitOwnedOutputs()
            if removeSourceRecording { removeOwnedObservation(artifact.url, expected: sourceSnapshot) }
          } else {
            // Prepared, not yet published: retain rollback ownership through
            // controller handoff/dismissal and the bridge's final epoch check.
            try operation.checkActive()
          }
          result = .success(payload)
        } catch {
          result = .failure(error)
        }
      case .cancelled:
        result = .failure(VisionFailure.cancelled)
      case .failed:
        result = .failure(
          ClipMediaStoreError.exportFailed(
            export.error?.localizedDescription ?? "The captured stroke could not be prepared."
          )
        )
      default:
        result = .failure(ClipMediaStoreError.exportUnavailable)
      }
      operation.removeCancellationHandler(exportCancellation)
      operation.endWork()
      if owningOperation != nil {
        do { try operation.checkActive() } catch { result = .failure(error) }
      }
      if case .failure = result { operation.cleanupOwnedOutputs() }
      completion(result)
    }
    // cancelExport called while status == .unknown need not cancel a later
    // start. Close that registration/start race with a second check.
    if operation.isCancelled { export.cancelExport() }
  }

  static func importedPayload(
    for url: URL,
    metadata: ImportedVideoMetadata,
    operation: ClipMediaOperation
  ) throws -> [String: Any] {
    try operation.checkActive()
    return try measuredPayload(
      for: url,
      captureMode: "imported_video",
      metadata: metadata,
      operation: operation,
      additional: [
        "ballSpeed": [
          "status": "unavailable",
          "reason": "analysis_not_run",
        ],
        "recognition": recognitionPayload(
          .unknown(reason: "analysis_not_run")
        ),
      ]
    )
  }

  private static func measuredPayload(
    for url: URL,
    captureMode: String,
    metadata: ImportedVideoMetadata? = nil,
    operation: ClipMediaOperation? = nil,
    additional: [String: Any]
  ) throws -> [String: Any] {
    try operation?.checkActive()
    let durationSeconds: Double
    let width: Int
    let height: Int
    let fps: Double
    if let metadata {
      durationSeconds = metadata.durationSeconds
      width = metadata.width
      height = metadata.height
      fps = metadata.fps
    } else {
      let asset = AVURLAsset(url: url)
      let cancellation = operation?.onCancel { asset.cancelLoading() }
      defer { if let cancellation { operation?.removeCancellationHandler(cancellation) } }
      if let operation { try loadImportMetadata(asset, keys: ["duration", "tracks"], operation: operation) }
      guard let track = asset.tracks(withMediaType: .video).first else {
        throw ClipMediaStoreError.invalidMedia
      }
      if let operation {
        try loadImportMetadata(track, keys: ["naturalSize", "preferredTransform", "nominalFrameRate"], operation: operation)
      }
      durationSeconds = CMTimeGetSeconds(asset.duration)
      let transformed = track.naturalSize.applying(track.preferredTransform)
      guard transformed.width.isFinite, transformed.height.isFinite,
            let measuredWidth = Int(exactly: abs(transformed.width).rounded()),
            let measuredHeight = Int(exactly: abs(transformed.height).rounded()) else {
        throw ClipMediaStoreError.invalidMedia
      }
      width = measuredWidth
      height = measuredHeight
      fps = Double(track.nominalFrameRate)
    }
    guard durationSeconds.isFinite, durationSeconds > 0,
          let durationMs = Int(exactly: (durationSeconds * 1000).rounded()),
          isValidTimestampMs(durationMs), durationMs > 0,
          width > 0, height > 0, fps.isFinite, fps > 0 else {
      throw ClipMediaStoreError.invalidMedia
    }

    var payload: [String: Any] = [
      "uri": url.absoluteString,
      "durationMs": durationMs,
      "width": width,
      "height": height,
      "fps": fps,
      "capturedAtIso": ISO8601DateFormatter().string(from: Date()),
      "captureMode": captureMode,
    ]
    if let size = try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber {
      payload["byteSize"] = size.int64Value
    }
    // Poster covers BOTH guided-capture and imported payloads (they all
    // assemble here). Best-effort: a thumbnail failure must never block a
    // real capture, so the key is simply omitted when rendering fails.
    if let posterURL = writePosterFrame(besideVideoAt: url, operation: operation, metadata: metadata) {
      payload["posterUri"] = posterURL.absoluteString
    }
    additional.forEach { payload[$0.key] = $0.value }
    if let identity = try operation?.videoIdentityPayload(for: url) {
      payload["nativeMediaIdentity"] = identity
      payload["byteSize"] = identity["byteSize"]
    }
    guard JSONSerialization.isValidJSONObject(payload) else { throw ClipMediaStoreError.invalidEvidence }
    try operation?.checkActive()
    return payload
  }

  /// Imported-video entry point to the SAME sidecar writer guided captures
  /// use: identical `pickle.pose-sequence.v1` JSON schema, identical bytes
  /// (sha256 is computed over the exact data written to disk), identical
  /// directory conventions (`<basename>.pose.json` beside the clip). Imported
  /// pose timestamps are already video-relative (first frame = 0), so the
  /// window starts at 0 and the rebase is a no-op.
  static func writeImportedPoseSequenceSidecar(
    besideVideoAt videoURL: URL,
    poseHistory: [PoseFrame],
    poseModelVersion: String,
    windowEndTimestampMs: Int,
    metadata: ImportedVideoMetadata,
    operation: ClipMediaOperation
  ) throws -> [String: Any]? {
    try operation.checkActive()
    guard isPrivateCaptureURL(videoURL) else { throw ClipMediaStoreError.invalidMedia }
    let sidecarURL = try operation.makeOwnedOutputURL(
      in: capturesDirectory, prefix: videoURL.deletingPathExtension().lastPathComponent + "-pose", pathExtension: "pose.json"
    )
    do {
      let result = try writePoseSequenceSidecar(
        besideClipAt: videoURL,
        poseHistory: poseHistory,
        poseModelVersion: poseModelVersion,
        windowStartTimestampMs: 0,
        windowEndTimestampMs: windowEndTimestampMs,
        metadata: metadata,
        operation: operation,
        sidecarURL: sidecarURL
      )
      if result == nil { operation.discardOwnedOutput(sidecarURL) }
      return result
    } catch {
      operation.discardOwnedOutput(sidecarURL)
      throw error
    }
  }

  /// Writes the measured pose sequence beside the clip in the canonical
  /// framework-neutral wire format (`pickle.pose-sequence.v1`) so any future
  /// model can reprocess this capture. Timestamps become clip-relative. When
  /// no frames landed inside the window, no sidecar is written — an honest
  /// absence, never an empty fabrication.
  private static func writePoseSequenceSidecar(
    besideClipAt clipURL: URL,
    poseHistory: [PoseFrame],
    poseModelVersion: String,
    windowStartTimestampMs: Int,
    windowEndTimestampMs: Int,
    metadata: ImportedVideoMetadata? = nil,
    operation: ClipMediaOperation,
    sidecarURL: URL? = nil
  ) throws -> [String: Any]? {
    try operation.checkActive()
    guard isValidTimestampMs(windowStartTimestampMs), isValidTimestampMs(windowEndTimestampMs),
          windowEndTimestampMs >= windowStartTimestampMs else { throw ClipMediaStoreError.invalidEvidence }
    if metadata != nil {
      guard poseHistory.count <= ProvisionalImportBudget.maximumPoseFrames,
            poseModelVersion.utf8.count <= 128,
            poseHistory.allSatisfy({ pose in
              pose.landmarks.count <= ProvisionalImportBudget.maximumLandmarksPerPose
                && pose.landmarks.allSatisfy { $0.name.utf8.count <= 64 }
            }) else { throw ImportMediaFailure.resourceLimit }
    }
    let width: Int
    let height: Int
    let fps: Double
    if let metadata {
      width = metadata.width
      height = metadata.height
      fps = metadata.fps
    } else {
      let clipAsset = AVURLAsset(url: clipURL)
      let cancellation = operation.onCancel { clipAsset.cancelLoading() }
      defer { operation.removeCancellationHandler(cancellation) }
      try loadImportMetadata(clipAsset, keys: ["tracks"], operation: operation)
      guard let track = clipAsset.tracks(withMediaType: .video).first else { return nil }
      try loadImportMetadata(track, keys: ["naturalSize", "preferredTransform", "nominalFrameRate"], operation: operation)
      let transformed = track.naturalSize.applying(track.preferredTransform)
      guard transformed.width.isFinite, transformed.height.isFinite,
            let measuredWidth = Int(exactly: abs(transformed.width).rounded()),
            let measuredHeight = Int(exactly: abs(transformed.height).rounded()) else {
        throw ClipMediaStoreError.invalidMedia
      }
      width = measuredWidth
      height = measuredHeight
      fps = Double(track.nominalFrameRate)
    }

    guard width > 0, height > 0, fps.isFinite, fps > 0 else { throw ClipMediaStoreError.invalidMedia }
    var frames: [[String: Any]] = []
    var frameIndex = 0
    var previousTimestampMs: Int?
    for pose in poseHistory {
      try operation.checkActive()
      guard isValidTimestampMs(pose.timestampMs),
            previousTimestampMs.map({ pose.timestampMs >= $0 }) ?? true,
            isUnitInterval(pose.confidence),
            pose.landmarks.allSatisfy({ isUnitInterval($0.x) && isUnitInterval($0.y) && isUnitInterval($0.visibility) }) else {
        throw ClipMediaStoreError.invalidEvidence
      }
      previousTimestampMs = pose.timestampMs
      guard pose.timestampMs >= windowStartTimestampMs,
            pose.timestampMs <= windowEndTimestampMs else { continue }
      let landmarks: [[String: Any]] = pose.landmarks.map { mark in
        ["n": mark.name, "x": mark.x, "y": mark.y, "v": mark.visibility]
      }
      frames.append([
        "i": frameIndex,
        "t": pose.timestampMs - windowStartTimestampMs,
        "c": pose.confidence,
        "l": landmarks,
      ])
      frameIndex += 1
    }
    guard !frames.isEmpty else { return nil }

    let document: [String: Any] = [
      "schemaVersion": 1,
      "format": "pickle.pose-sequence.v1",
      "coordinateSystem": "normalized_image_top_left",
      "poseModelVersion": poseModelVersion,
      "video": [
        "w": width,
        "h": height,
        "fps": fps,
      ],
      "frames": frames,
    ]
    try operation.checkActive()
    guard JSONSerialization.isValidJSONObject(document) else { throw ClipMediaStoreError.invalidEvidence }
    let data = try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys])
    let destination = sidecarURL ?? clipURL.deletingPathExtension().appendingPathExtension("pose.json")
    if metadata != nil {
      guard data.count <= ProvisionalImportBudget.maximumSidecarBytes else { throw ImportMediaFailure.resourceLimit }
    }
    if sidecarURL == nil { try operation.createOwnedOutput(at: destination) }
    try operation.writeOwnedData(data, to: destination)
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    try operation.checkActive()

    return [
      "schemaVersion": 1,
      "format": "pickle.pose-sequence.v1",
      "uri": destination.absoluteString,
      "frameCount": frames.count,
      "sha256": digest,
      "coordinateSystem": "normalized_image_top_left",
      "poseModelVersion": poseModelVersion,
    ]
  }

  private static func isValidTimestampMs(_ value: Int) -> Bool {
    value >= 0 && value <= 9_007_199_254_740_991
  }

  private static func isUnitInterval(_ value: Double) -> Bool {
    value.isFinite && (0...1).contains(value)
  }

  private static func recognitionPayload(_ recognition: StrokeRecognition) -> [String: Any] {
    var payload: [String: Any] = ["status": recognition.status.rawValue]
    if let shotType = recognition.shotType { payload["shotType"] = shotType }
    if let confidence = recognition.confidence { payload["confidence"] = confidence }
    if let reason = recognition.reason { payload["reason"] = reason }
    if let modelVersion = recognition.modelVersion { payload["modelVersion"] = modelVersion }
    return payload
  }
}
