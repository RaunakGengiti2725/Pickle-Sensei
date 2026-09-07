import CryptoKit
import Darwin
import Foundation

struct MediaAuthority: Codable {
  let version: Int
  let authorityID: String
  let key: Data
  let root: MediaNodeIdentity
  let namespace: MediaNodeIdentity
  let records: MediaNodeIdentity
}

struct MediaReferencePayload: Codable {
  let version: Int
  let authorityID: String
  let owner: String
  let operationID: String
  let assetID: String
  let role: ManagedMediaRole
  let relativePath: String
  let parents: [MediaNodeIdentity]
  let file: MediaFileSnapshot
}

struct MediaReferenceEnvelope: Codable {
  let payload: MediaReferencePayload
  let authentication: Data
}

struct MediaStoreDirectories {
  let root: MediaDirectory
  let namespace: MediaDirectory
  let records: MediaDirectory
}

struct MediaStoreTestHooks {
  var makeAssetID: () -> String = { UUID().uuidString.lowercased() }
  var afterInspection: ((ManagedMediaReference) throws -> Void)?
}

public final class ManagedMediaWriter: @unchecked Sendable {
  private let lock = NSLock()
  private var descriptor: MediaDescriptor?
  private var recheck: (() throws -> Void)?

  init(descriptor: MediaDescriptor, recheck: @escaping () throws -> Void) {
    self.descriptor = descriptor
    self.recheck = recheck
  }

  public func append(_ data: Data) throws {
    lock.lock()
    defer { lock.unlock() }
    guard let descriptor, let recheck else { throw ManagedMediaError(.writerClosed) }
    try recheck()
    try MediaPOSIX.writeAll(data, to: descriptor)
    try recheck()
  }

  func invalidate() {
    lock.lock()
    descriptor = nil
    recheck = nil
    lock.unlock()
  }
}

public final class ManagedMediaStore: @unchecked Sendable {
  private static let writers = NSLock()
  private static let writerThreadKey = "PickleManagedMedia.writer-active"
  private let anchor: MediaCapturesAnchor
  private let authority: MediaAuthority
  private let authorityBytes: Data
  private let authoritySnapshot: MediaFileSnapshot
  private let signingKey: SymmetricKey
  private let hooks: MediaStoreTestHooks

  private static func beginWriter() throws {
    guard Thread.current.threadDictionary[writerThreadKey] == nil else {
      throw ManagedMediaError(.ioFailure, errnoCode: EBUSY)
    }
    writers.lock()
    Thread.current.threadDictionary[writerThreadKey] = true
  }

  private static func endWriter() {
    Thread.current.threadDictionary.removeObject(forKey: writerThreadKey)
    writers.unlock()
  }

  public convenience init(trustedCapturesRoot: URL) throws {
    try self.init(trustedCapturesRoot: trustedCapturesRoot, hooks: MediaStoreTestHooks())
  }

  init(trustedCapturesRoot: URL, hooks: MediaStoreTestHooks) throws {
    try Self.beginWriter()
    defer { Self.endWriter() }
    let anchor = try MediaCapturesAnchor(trustedCapturesRoot)
    let root = try anchor.open()
    try MediaPOSIX.lock(root.fd)
    defer { flock(root.fd.raw, LOCK_UN) }
    try root.recheck()
    let namespace = try root.create(ManagedMediaFormat.namespace, exclusive: false)
    let records: MediaDirectory
    if namespace.created {
      records = try namespace.directory.create(ManagedMediaFormat.records, exclusive: true).directory
      let key = SymmetricKey(size: .bits256)
      let authority = MediaAuthority(
        version: ManagedMediaFormat.version,
        authorityID: UUID().uuidString.lowercased(),
        key: key.withUnsafeBytes { Data($0) },
        root: root.identity, namespace: namespace.directory.identity, records: records.identity
      )
      let file = try MediaPOSIX.createFile(ManagedMediaFormat.authority, in: namespace.directory)
      try MediaPOSIX.writeAll(ManagedMediaFormat.encode(authority), to: file)
      try MediaPOSIX.sync(file)
      try MediaPOSIX.sync(namespace.directory.fd)
      try MediaPOSIX.sync(root.fd)
    } else {
      do {
        records = try namespace.directory.open(ManagedMediaFormat.records, privateNode: true)
      } catch let error as ManagedMediaError where error.errnoCode == ENOENT {
        throw ManagedMediaError(.authorityChanged)
      }
    }
    let stored: (data: Data, snapshot: MediaFileSnapshot)
    do {
      stored = try MediaPOSIX.readFile(ManagedMediaFormat.authority, in: namespace.directory, maximumBytes: 4096)
    } catch let error as ManagedMediaError where error.errnoCode == ENOENT {
      throw ManagedMediaError(.authorityChanged)
    }
    let authority = try ManagedMediaFormat.decodeCanonical(MediaAuthority.self, from: stored.data, maximumBytes: 4096)
    guard authority.version == ManagedMediaFormat.version,
          ManagedMediaFormat.isUUID(authority.authorityID), authority.key.count == 32,
          authority.root == root.identity, authority.namespace == namespace.directory.identity,
          authority.records == records.identity else {
      throw ManagedMediaError(.authorityChanged)
    }
    try records.recheck()
    self.anchor = anchor
    self.authority = authority
    authorityBytes = stored.data
    authoritySnapshot = stored.snapshot
    signingKey = SymmetricKey(data: authority.key)
    self.hooks = hooks
  }

  public func createNewAsset(
    owner: String, operationID: String, role: ManagedMediaRole, data: Data
  ) throws -> ManagedMediaAsset {
    try createNewAsset(owner: owner, operationID: operationID, role: role) { writer in
      try writer.append(data)
    }
  }

  public func createNewAsset(
    owner: String, operationID: String, role: ManagedMediaRole,
    write: (ManagedMediaWriter) throws -> Void
  ) throws -> ManagedMediaAsset {
    try ManagedMediaFormat.validateOwner(owner)
    try ManagedMediaFormat.validateOperation(operationID)
    return try withDirectories { directories in
      let ownerDirectory = try directories.namespace.create(owner, exclusive: false).directory
      let operationDirectory = try ownerDirectory.create(operationID, exclusive: false).directory
      let assetID = hooks.makeAssetID()
      guard ManagedMediaFormat.isUUID(assetID) else { throw ManagedMediaError(.invalidReference) }
      let recordName = assetID + ".record"
      let reservation = try MediaPOSIX.createFile(recordName, in: directories.records)
      let reservationIdentity = MediaNodeIdentity(try MediaPOSIX.info(reservation))
      try MediaPOSIX.sync(reservation)
      try MediaPOSIX.sync(directories.records.fd)
      let assetDirectory = try operationDirectory.create(assetID, exclusive: true).directory
      let file = try MediaPOSIX.createFile(role.filename, in: assetDirectory)
      let identity = MediaNodeIdentity(try MediaPOSIX.info(file))
      let writer = ManagedMediaWriter(descriptor: file) {
        try MediaPOSIX.recheckNewFile(file, name: role.filename, in: assetDirectory, expected: identity)
      }
      defer { writer.invalidate() }
      try write(writer)
      writer.invalidate()
      try MediaPOSIX.sync(file)
      try MediaPOSIX.recheckNewFile(file, name: role.filename, in: assetDirectory, expected: identity)
      let snapshot = MediaFileSnapshot(try MediaPOSIX.info(file))
      let payload = MediaReferencePayload(
        version: ManagedMediaFormat.version, authorityID: authority.authorityID,
        owner: owner, operationID: operationID, assetID: assetID, role: role,
        relativePath: ManagedMediaFormat.relativePath(owner: owner, operation: operationID, asset: assetID, role: role),
        parents: [ownerDirectory.identity, operationDirectory.identity, assetDirectory.identity], file: snapshot
      )
      let authentication = HMAC<SHA256>.authenticationCode(
        for: try ManagedMediaFormat.encode(payload), using: signingKey
      )
      let reference = ManagedMediaReference(serialized: try ManagedMediaFormat.encode(
        MediaReferenceEnvelope(payload: payload, authentication: Data(authentication))
      ))
      try recheckAuthority(directories)
      try MediaPOSIX.recheckFile(file, name: role.filename, in: assetDirectory, expected: snapshot)
      try MediaPOSIX.recheckNewFile(
        reservation, name: recordName, in: directories.records, expected: reservationIdentity
      )
      try MediaPOSIX.writeAll(reference.serialized, to: reservation)
      try MediaPOSIX.sync(reservation)
      for directory in [assetDirectory, operationDirectory, ownerDirectory, directories.records, directories.namespace] {
        try MediaPOSIX.sync(directory.fd)
      }
      try recheckAuthority(directories)
      try MediaPOSIX.recheckFile(file, name: role.filename, in: assetDirectory, expected: snapshot)
      return ManagedMediaAsset(
        reference: reference, owner: owner, operationID: operationID, assetID: assetID,
        role: role, relativePath: payload.relativePath
      )
    }
  }

  public func preserveAsShared(owner: String, reference: ManagedMediaReference) throws {
    try ManagedMediaFormat.validateOwner(owner)
    try withDirectories { directories in
      let payload = try authenticate(reference)
      guard payload.owner == owner else { throw ManagedMediaError(.otherOwner) }
      try validateRecord(reference, payload: payload, in: directories)
      let name = payload.assetID + ".shared"
      if try sharedMarkerExists(name, in: directories) { return }
      let marker = try MediaPOSIX.createFile(name, in: directories.records)
      try MediaPOSIX.writeAll(reference.serialized, to: marker)
      try MediaPOSIX.sync(marker)
      try MediaPOSIX.sync(directories.records.fd)
      try recheckAuthority(directories)
    }
  }

  public func delete(
    owner: String, candidates: [ManagedMediaDeletionCandidate]
  ) -> [ManagedMediaDeletionResult] {
    do {
      try ManagedMediaFormat.validateOwner(owner)
    } catch let error as ManagedMediaError {
      return candidates.map { _ in error.deletionResult }
    } catch {
      return candidates.map { _ in ManagedMediaError(.invalidOwner).deletionResult }
    }
    return candidates.map { candidate in
      do {
        return try withDirectories { directories in
          switch candidate {
          case .managed(let reference):
            return try deleteReference(reference, owner: owner, in: directories)
          case .unverified(let claimedOwner, let uri, _):
            try ManagedMediaFormat.validateOwner(claimedOwner)
            let leaf = try ManagedMediaFormat.legacyLeaf(uri: uri, rootPath: anchor.path)
            do {
              let info = try MediaPOSIX.info(at: leaf, in: directories.root)
              guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else {
                throw ManagedMediaError(.unsafeNode)
              }
            } catch let error as ManagedMediaError where error.errnoCode == ENOENT {
            }
            throw ManagedMediaError(claimedOwner == owner ? .unverifiedOwnership : .otherOwner)
          }
        }
      } catch let error as ManagedMediaError {
        return error.deletionResult
      } catch {
        return ManagedMediaError(.ioFailure).deletionResult
      }
    }
  }

  private func withDirectories<T>(_ body: (MediaStoreDirectories) throws -> T) throws -> T {
    try Self.beginWriter()
    defer { Self.endWriter() }
    let root = try anchor.open()
    try MediaPOSIX.lock(root.fd)
    defer { flock(root.fd.raw, LOCK_UN) }
    try root.recheck()
    let namespace: MediaDirectory
    let records: MediaDirectory
    do {
      namespace = try root.open(ManagedMediaFormat.namespace, privateNode: true)
      records = try namespace.open(ManagedMediaFormat.records, privateNode: true)
    } catch let error as ManagedMediaError where error.errnoCode == ENOENT {
      throw ManagedMediaError(.authorityChanged)
    }
    let directories = MediaStoreDirectories(root: root, namespace: namespace, records: records)
    try recheckAuthority(directories)
    return try body(directories)
  }

  private func recheckAuthority(_ directories: MediaStoreDirectories) throws {
    try directories.records.recheck()
    guard directories.root.identity == authority.root,
          directories.namespace.identity == authority.namespace,
          directories.records.identity == authority.records else {
      throw ManagedMediaError(.authorityChanged)
    }
    let stored: (data: Data, snapshot: MediaFileSnapshot)
    do {
      stored = try MediaPOSIX.readFile(ManagedMediaFormat.authority, in: directories.namespace, maximumBytes: 4096)
    } catch let error as ManagedMediaError where error.errnoCode == ENOENT {
      throw ManagedMediaError(.authorityChanged)
    }
    guard stored.data == authorityBytes, stored.snapshot == authoritySnapshot else {
      throw ManagedMediaError(.authorityChanged)
    }
  }

  private func authenticate(_ reference: ManagedMediaReference) throws -> MediaReferencePayload {
    let envelope = try ManagedMediaFormat.decodeCanonical(
      MediaReferenceEnvelope.self, from: reference.serialized, maximumBytes: ManagedMediaFormat.maximumReferenceBytes
    )
    let payload = envelope.payload
    try ManagedMediaFormat.validateOwner(payload.owner)
    try ManagedMediaFormat.validateOperation(payload.operationID)
    guard payload.version == ManagedMediaFormat.version,
          payload.authorityID == authority.authorityID,
          ManagedMediaFormat.isUUID(payload.assetID),
          payload.parents.count == 3, payload.parents.allSatisfy(\.isValid), payload.file.isValid,
          payload.relativePath == ManagedMediaFormat.relativePath(
            owner: payload.owner, operation: payload.operationID, asset: payload.assetID, role: payload.role
          ),
          envelope.authentication.count == 32,
          HMAC<SHA256>.isValidAuthenticationCode(
            envelope.authentication, authenticating: try ManagedMediaFormat.encode(payload), using: signingKey
          ) else {
      throw ManagedMediaError(.invalidReference)
    }
    return payload
  }

  private func validateRecord(
    _ reference: ManagedMediaReference, payload: MediaReferencePayload, in directories: MediaStoreDirectories
  ) throws {
    let stored: Data
    do {
      stored = try MediaPOSIX.readFile(
        payload.assetID + ".record", in: directories.records, maximumBytes: ManagedMediaFormat.maximumReferenceBytes
      ).data
    } catch let error as ManagedMediaError where error.errnoCode == ENOENT {
      throw ManagedMediaError(.unverifiedOwnership)
    }
    guard stored == reference.serialized else { throw ManagedMediaError(.unverifiedOwnership) }
  }

  private func sharedMarkerExists(_ name: String, in directories: MediaStoreDirectories) throws -> Bool {
    do {
      let info = try MediaPOSIX.info(at: name, in: directories.records)
      try MediaPOSIX.validateFile(info)
      return true
    } catch let error as ManagedMediaError where error.errnoCode == ENOENT {
      return false
    }
  }

  private func deleteReference(
    _ reference: ManagedMediaReference, owner: String, in directories: MediaStoreDirectories
  ) throws -> ManagedMediaDeletionResult {
    let payload = try authenticate(reference)
    guard payload.owner == owner else { throw ManagedMediaError(.otherOwner) }
    try validateRecord(reference, payload: payload, in: directories)
    if try sharedMarkerExists(payload.assetID + ".shared", in: directories) {
      throw ManagedMediaError(.shared)
    }
    var parent = directories.namespace
    let file: MediaDescriptor
    do {
      for (index, name) in [payload.owner, payload.operationID, payload.assetID].enumerated() {
        parent = try parent.open(name, privateNode: true)
        guard parent.identity == payload.parents[index] else { throw ManagedMediaError(.identityChanged) }
      }
      file = try MediaPOSIX.openFile(payload.role.filename, in: parent)
      try MediaPOSIX.recheckFile(file, name: payload.role.filename, in: parent, expected: payload.file)
    } catch let error as ManagedMediaError where error.errnoCode == ENOENT {
      try recheckAuthority(directories)
      try parent.recheck()
      return ManagedMediaDeletionResult(status: .alreadyMissing)
    }
    try hooks.afterInspection?(reference)
    try recheckAuthority(directories)
    try validateRecord(reference, payload: payload, in: directories)
    if try sharedMarkerExists(payload.assetID + ".shared", in: directories) {
      throw ManagedMediaError(.shared)
    }
    try parent.recheck()
    do {
      try MediaPOSIX.recheckFile(file, name: payload.role.filename, in: parent, expected: payload.file)
    } catch let error as ManagedMediaError where error.errnoCode == ENOENT {
      return ManagedMediaDeletionResult(status: .alreadyMissing)
    }
    guard unlinkat(parent.fd.raw, payload.role.filename, 0) == 0 else {
      if errno == ENOENT { return ManagedMediaDeletionResult(status: .alreadyMissing) }
      throw MediaPOSIX.failure()
    }
    try MediaPOSIX.sync(parent.fd)
    return ManagedMediaDeletionResult(status: .deleted)
  }
}
