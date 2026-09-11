import Darwin
import Foundation
import XCTest

@testable import PickleManagedMedia

final class TemporaryMediaFixture {
  let base: URL
  let container: URL
  let captures: URL
  private var knownPaths = Set<String>()

  init() throws {
    let temporary: URL
    if let supplied = ProcessInfo.processInfo.environment["PICKLE_MANAGED_MEDIA_TEST_TMPDIR"] {
      temporary = URL(fileURLWithPath: supplied, isDirectory: true)
    } else {
      // Foundation preserves the /var alias even after resolvingSymlinksInPath
      // on macOS. Supply the physical system temp directory to the trusted-root
      // API; its no-symlink checks must still reject caller-provided aliases.
      guard let physical = FileManager.default.temporaryDirectory.path.withCString({ realpath($0, nil) }) else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
      defer { free(physical) }
      temporary = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    base = temporary.appendingPathComponent("W08-test-" + UUID().uuidString.lowercased(), isDirectory: true)
    container = base.appendingPathComponent("Container", isDirectory: true)
    captures = container.appendingPathComponent("Captures", isDirectory: true)
    try directory(base)
    try directory(container)
    try directory(captures)
  }

  var namespace: URL { captures.appendingPathComponent(ManagedMediaFormat.namespace, isDirectory: true) }
  var records: URL { namespace.appendingPathComponent(ManagedMediaFormat.records, isDirectory: true) }
  var authority: URL { namespace.appendingPathComponent(ManagedMediaFormat.authority) }

  func store(hooks: MediaStoreTestHooks = MediaStoreTestHooks()) throws -> ManagedMediaStore {
    for url in [namespace, records, authority] { remember(url) }
    return try ManagedMediaStore(trustedCapturesRoot: captures, hooks: hooks)
  }

  func create(
    _ store: ManagedMediaStore, owner: String, operation: String,
    role: ManagedMediaRole = .movie, bytes: Data = Data("native-created".utf8)
  ) throws -> ManagedMediaAsset {
    let asset = try store.createNewAsset(owner: owner, operationID: operation, role: role, data: bytes)
    rememberAsset(owner: owner, operation: operation, assetID: asset.assetID, role: role)
    return asset
  }

  func rememberAsset(owner: String, operation: String, assetID: String, role: ManagedMediaRole) {
    let ownerDirectory = namespace.appendingPathComponent(owner, isDirectory: true)
    let operationDirectory = ownerDirectory.appendingPathComponent(operation, isDirectory: true)
    let assetDirectory = operationDirectory.appendingPathComponent(assetID, isDirectory: true)
    for url in [ownerDirectory, operationDirectory, assetDirectory, assetDirectory.appendingPathComponent(role.filename),
                record(assetID), shared(assetID)] {
      remember(url)
    }
  }

  func url(_ asset: ManagedMediaAsset) -> URL { captures.appendingPathComponent(asset.relativePath) }
  func record(_ assetID: String) -> URL { records.appendingPathComponent(assetID + ".record") }
  func shared(_ assetID: String) -> URL { records.appendingPathComponent(assetID + ".shared") }

  func remember(_ url: URL) {
    precondition(url.path == base.path || url.path.hasPrefix(base.path + "/"))
    knownPaths.insert(url.path)
  }

  func directory(_ url: URL) throws {
    remember(url)
    guard mkdir(url.path, mode_t(0o700)) == 0 else { throw error(url) }
  }

  func writeNew(_ url: URL, _ bytes: Data = Data("unrelated".utf8)) throws {
    remember(url)
    let raw = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
    guard raw >= 0 else { throw error(url) }
    defer { Darwin.close(raw) }
    try write(bytes, fd: raw)
  }

  func overwrite(_ url: URL, _ bytes: Data) throws {
    precondition(knownPaths.contains(url.path))
    let raw = Darwin.open(url.path, O_WRONLY | O_TRUNC | O_NOFOLLOW | O_CLOEXEC)
    guard raw >= 0 else { throw error(url) }
    defer { Darwin.close(raw) }
    try write(bytes, fd: raw)
  }

  private func write(_ bytes: Data, fd: Int32) throws {
    try bytes.withUnsafeBytes { buffer in
      var offset = 0
      while offset < buffer.count {
        let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
        if count < 0, errno == EINTR { continue }
        guard count > 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        offset += count
      }
    }
  }

  func move(_ source: URL, to destination: URL) throws {
    remember(destination)
    let moved = knownPaths.filter { $0 == source.path || $0.hasPrefix(source.path + "/") }
    guard rename(source.path, destination.path) == 0 else { throw error(source) }
    for path in moved { knownPaths.insert(destination.path + String(path.dropFirst(source.path.count))) }
  }

  func symlink(_ link: URL, to target: URL) throws {
    remember(link)
    precondition(knownPaths.contains(target.path))
    guard Darwin.symlink(target.path, link.path) == 0 else { throw error(link) }
  }

  func hardlink(_ link: URL, to target: URL) throws {
    remember(link)
    precondition(knownPaths.contains(target.path))
    guard Darwin.link(target.path, link.path) == 0 else { throw error(link) }
  }

  func unlink(_ url: URL) throws {
    precondition(knownPaths.contains(url.path))
    guard Darwin.unlink(url.path) == 0 else { throw error(url) }
  }

  func mode(_ url: URL, _ mode: mode_t) throws {
    precondition(knownPaths.contains(url.path))
    guard chmod(url.path, mode) == 0 else { throw error(url) }
  }

  func exists(_ url: URL) -> Bool {
    var info = stat()
    return lstat(url.path, &info) == 0
  }

  func bytes(_ url: URL) throws -> Data {
    precondition(knownPaths.contains(url.path))
    return try Data(contentsOf: url)
  }

  func cleanup() throws {
    let paths = knownPaths.sorted {
      if $0.count == $1.count { return $0 > $1 }
      return $0.count > $1.count
    }
    for path in paths.reversed() {
      var info = stat()
      if lstat(path, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) {
        guard chmod(path, mode_t(0o700)) == 0 else { throw error(URL(fileURLWithPath: path)) }
      }
    }
    for path in paths {
      var info = stat()
      if lstat(path, &info) != 0 {
        if errno == ENOENT || errno == ENOTDIR { continue }
        throw error(URL(fileURLWithPath: path))
      }
      let result = info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) ? rmdir(path) : Darwin.unlink(path)
      guard result == 0 else { throw error(URL(fileURLWithPath: path)) }
    }
    knownPaths.removeAll()
  }

  private func error(_ url: URL) -> Error {
    NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSFilePathErrorKey: url.path])
  }
}

final class LockedTestValue<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Value

  init(_ value: Value) { stored = value }

  var value: Value {
    lock.lock()
    defer { lock.unlock() }
    return stored
  }

  func set(_ value: Value) {
    lock.lock()
    stored = value
    lock.unlock()
  }
}
