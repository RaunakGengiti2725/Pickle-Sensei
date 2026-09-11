import Darwin
import Foundation

struct MediaNodeIdentity: Codable, Equatable {
  let device: Int32
  let inode: UInt64
  let generation: UInt32
  let birthSeconds: Int64
  let birthNanoseconds: Int64

  init(_ info: stat) {
    device = info.st_dev
    inode = info.st_ino
    generation = info.st_gen
    birthSeconds = Int64(info.st_birthtimespec.tv_sec)
    birthNanoseconds = Int64(info.st_birthtimespec.tv_nsec)
  }

  var isValid: Bool {
    inode != 0 && (0..<1_000_000_000).contains(birthNanoseconds)
  }
}

struct MediaFileSnapshot: Codable, Equatable {
  let node: MediaNodeIdentity
  let size: Int64
  let modifiedSeconds: Int64
  let modifiedNanoseconds: Int64
  let changedSeconds: Int64
  let changedNanoseconds: Int64
  let mode: UInt16
  let uid: UInt32

  init(_ info: stat) {
    node = MediaNodeIdentity(info)
    size = info.st_size
    modifiedSeconds = Int64(info.st_mtimespec.tv_sec)
    modifiedNanoseconds = Int64(info.st_mtimespec.tv_nsec)
    changedSeconds = Int64(info.st_ctimespec.tv_sec)
    changedNanoseconds = Int64(info.st_ctimespec.tv_nsec)
    mode = info.st_mode
    uid = info.st_uid
  }

  var isValid: Bool {
    node.isValid && size >= 0
      && (0..<1_000_000_000).contains(modifiedNanoseconds)
      && (0..<1_000_000_000).contains(changedNanoseconds)
      && mode & UInt16(S_IFMT) == UInt16(S_IFREG)
  }
}

final class MediaDescriptor {
  let raw: Int32

  init(_ raw: Int32) throws {
    guard raw >= 0 else { throw MediaPOSIX.failure() }
    self.raw = raw
  }

  deinit {
    Darwin.close(raw)
  }
}

enum MediaPOSIX {
  static func failure(_ code: Int32 = errno) -> ManagedMediaError {
    if code == ELOOP || code == ENOTDIR || code == EISDIR {
      return ManagedMediaError(.unsafeNode, errnoCode: code)
    }
    return ManagedMediaError(.ioFailure, errnoCode: code)
  }

  static func info(_ fd: MediaDescriptor) throws -> stat {
    var value = stat()
    guard fstat(fd.raw, &value) == 0 else { throw failure() }
    return value
  }

  static func info(at name: String, in directory: MediaDirectory) throws -> stat {
    var value = stat()
    guard fstatat(directory.fd.raw, name, &value, AT_SYMLINK_NOFOLLOW) == 0 else {
      throw failure()
    }
    return value
  }

  static func validateDirectory(_ info: stat, privateNode: Bool = false) throws {
    guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else {
      throw ManagedMediaError(.unsafeNode)
    }
    if privateNode {
      guard info.st_uid == geteuid(), info.st_mode & 0o077 == 0 else {
        throw ManagedMediaError(.unsafeNode)
      }
    }
  }

  static func validateFile(_ info: stat) throws {
    guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else {
      throw ManagedMediaError(.unsafeNode)
    }
    guard info.st_nlink <= 1 else { throw ManagedMediaError(.hardLinked) }
    guard info.st_nlink == 1 else { throw ManagedMediaError(.identityChanged) }
    guard info.st_uid == geteuid(), info.st_mode & 0o077 == 0 else {
      throw ManagedMediaError(.unsafeNode)
    }
  }

  static func protectNewNode(_ fd: MediaDescriptor) throws {
    #if os(iOS)
    let completeUntilFirstUserAuthenticationClass: Int32 = 3
    guard fcntl(fd.raw, F_SETPROTECTIONCLASS, completeUntilFirstUserAuthenticationClass) == 0 else {
      throw failure()
    }
    #endif
    let exclusion = try PropertyListSerialization.data(
      fromPropertyList: "com.apple.backupd", format: .binary, options: 0
    )
    let result = exclusion.withUnsafeBytes { bytes in
      fsetxattr(
        fd.raw, "com.apple.metadata:com_apple_backup_excludeItem",
        bytes.baseAddress, bytes.count, 0, 0
      )
    }
    guard result == 0 else { throw failure() }
  }

  static func createFile(_ name: String, in directory: MediaDirectory) throws -> MediaDescriptor {
    let raw = openat(directory.fd.raw, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
    if raw < 0, errno == EEXIST { throw ManagedMediaError(.collision) }
    let fd = try MediaDescriptor(raw)
    try validateFile(info(fd))
    try protectNewNode(fd)
    return fd
  }

  static func openFile(_ name: String, in directory: MediaDirectory) throws -> MediaDescriptor {
    let before = try info(at: name, in: directory)
    try validateFile(before)
    let fd = try MediaDescriptor(openat(directory.fd.raw, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC))
    let opened = try info(fd)
    try validateFile(opened)
    guard MediaFileSnapshot(before) == MediaFileSnapshot(opened) else {
      throw ManagedMediaError(.identityChanged)
    }
    return fd
  }

  static func recheckFile(
    _ fd: MediaDescriptor, name: String, in directory: MediaDirectory, expected: MediaFileSnapshot
  ) throws {
    let named = try info(at: name, in: directory)
    let opened = try info(fd)
    try validateFile(named)
    try validateFile(opened)
    guard MediaFileSnapshot(named) == expected, MediaFileSnapshot(opened) == expected else {
      throw ManagedMediaError(.identityChanged)
    }
  }

  static func recheckNewFile(
    _ fd: MediaDescriptor, name: String, in directory: MediaDirectory, expected: MediaNodeIdentity
  ) throws {
    try directory.recheck()
    let named = try info(at: name, in: directory)
    let opened = try info(fd)
    try validateFile(named)
    try validateFile(opened)
    guard MediaNodeIdentity(named) == expected, MediaNodeIdentity(opened) == expected else {
      throw ManagedMediaError(.identityChanged)
    }
  }

  static func writeAll(_ data: Data, to fd: MediaDescriptor) throws {
    try data.withUnsafeBytes { bytes in
      var offset = 0
      while offset < bytes.count {
        let count = Darwin.write(fd.raw, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
        if count < 0, errno == EINTR { continue }
        guard count > 0 else { throw failure(count == 0 ? EIO : errno) }
        offset += count
      }
    }
  }

  static func readFile(
    _ name: String, in directory: MediaDirectory, maximumBytes: Int
  ) throws -> (data: Data, snapshot: MediaFileSnapshot) {
    let fd = try openFile(name, in: directory)
    let snapshot = MediaFileSnapshot(try info(fd))
    guard snapshot.size <= maximumBytes else { throw ManagedMediaError(.invalidReference) }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: min(maximumBytes + 1, 4096))
    while true {
      let count = buffer.withUnsafeMutableBytes { Darwin.read(fd.raw, $0.baseAddress, $0.count) }
      if count < 0, errno == EINTR { continue }
      guard count >= 0 else { throw failure() }
      if count == 0 { break }
      guard data.count + count <= maximumBytes else { throw ManagedMediaError(.invalidReference) }
      data.append(contentsOf: buffer.prefix(count))
    }
    try recheckFile(fd, name: name, in: directory, expected: snapshot)
    return (data, snapshot)
  }

  static func sync(_ fd: MediaDescriptor) throws {
    while fsync(fd.raw) != 0 {
      if errno == EINTR { continue }
      throw failure()
    }
  }

  static func lock(_ fd: MediaDescriptor) throws {
    while flock(fd.raw, LOCK_EX) != 0 {
      if errno == EINTR { continue }
      throw failure()
    }
  }
}

final class MediaDirectory {
  let fd: MediaDescriptor
  let identity: MediaNodeIdentity
  let parent: MediaDirectory?
  let name: String
  let privateNode: Bool

  private init(fd: MediaDescriptor, parent: MediaDirectory?, name: String, privateNode: Bool) throws {
    let value = try MediaPOSIX.info(fd)
    try MediaPOSIX.validateDirectory(value, privateNode: privateNode)
    self.fd = fd
    identity = MediaNodeIdentity(value)
    self.parent = parent
    self.name = name
    self.privateNode = privateNode
  }

  static func filesystemRoot() throws -> MediaDirectory {
    try MediaDirectory(
      fd: MediaDescriptor(Darwin.open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)),
      parent: nil, name: "/", privateNode: false
    )
  }

  func open(_ name: String, privateNode: Bool = false) throws -> MediaDirectory {
    let before = try MediaPOSIX.info(at: name, in: self)
    try MediaPOSIX.validateDirectory(before, privateNode: privateNode)
    let child = try MediaDirectory(
      fd: MediaDescriptor(openat(fd.raw, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)),
      parent: self, name: name, privateNode: privateNode
    )
    guard child.identity == MediaNodeIdentity(before) else { throw ManagedMediaError(.identityChanged) }
    return child
  }

  func create(_ name: String, exclusive: Bool) throws -> (directory: MediaDirectory, created: Bool) {
    let created = mkdirat(fd.raw, name, mode_t(0o700)) == 0
    if !created {
      let code = errno
      if code == EEXIST {
        if exclusive { throw ManagedMediaError(.collision) }
      } else {
        throw MediaPOSIX.failure(code)
      }
    }
    let child = try open(name, privateNode: true)
    if created {
      try MediaPOSIX.protectNewNode(child.fd)
      try MediaPOSIX.sync(fd)
    }
    return (child, created)
  }

  func recheck() throws {
    try parent?.recheck()
    let opened = try MediaPOSIX.info(fd)
    try MediaPOSIX.validateDirectory(opened, privateNode: privateNode)
    guard MediaNodeIdentity(opened) == identity else { throw ManagedMediaError(.identityChanged) }
    if let parent {
      let named = try MediaPOSIX.info(at: name, in: parent)
      try MediaPOSIX.validateDirectory(named, privateNode: privateNode)
      guard MediaNodeIdentity(named) == identity else { throw ManagedMediaError(.identityChanged) }
    }
  }
}

struct MediaCapturesAnchor {
  let path: String
  let components: [String]
  let identities: [MediaNodeIdentity]

  init(_ url: URL) throws {
    path = try ManagedMediaFormat.localPath(url)
    components = path.dropFirst().split(separator: "/").map(String.init)
    guard components.last == "Captures" else { throw ManagedMediaError(.unsafePath) }
    var current = try MediaDirectory.filesystemRoot()
    var found = [current.identity]
    for component in components {
      current = try current.open(component)
      found.append(current.identity)
    }
    let info = try MediaPOSIX.info(current.fd)
    guard info.st_uid == geteuid(), info.st_mode & 0o022 == 0 else {
      throw ManagedMediaError(.unsafeNode)
    }
    try current.recheck()
    identities = found
  }

  var rootIdentity: MediaNodeIdentity { identities[identities.count - 1] }

  func open() throws -> MediaDirectory {
    var current = try MediaDirectory.filesystemRoot()
    guard current.identity == identities[0] else { throw ManagedMediaError(.identityChanged) }
    do {
      for (index, component) in components.enumerated() {
        current = try current.open(component)
        guard current.identity == identities[index + 1] else { throw ManagedMediaError(.identityChanged) }
      }
      let info = try MediaPOSIX.info(current.fd)
      guard info.st_uid == geteuid(), info.st_mode & 0o022 == 0 else {
        throw ManagedMediaError(.unsafeNode)
      }
      return current
    } catch let error as ManagedMediaError where error.errnoCode == ENOENT {
      throw ManagedMediaError(.identityChanged)
    }
  }
}
