import Foundation

public enum ManagedMediaRole: String, Codable, CaseIterable, Sendable {
  case movie
  case poster
  case pose

  var filename: String {
    switch self {
    case .movie: return "movie.mov"
    case .poster: return "poster.jpg"
    case .pose: return "pose.json"
    }
  }
}

public struct ManagedMediaReference: Equatable, Sendable {
  public let serialized: Data

  public init(serialized: Data) {
    self.serialized = serialized
  }
}

public struct ManagedMediaAsset: Equatable, Sendable {
  public let reference: ManagedMediaReference
  public let owner: String
  public let operationID: String
  public let assetID: String
  public let role: ManagedMediaRole
  public let relativePath: String
}

public enum ManagedMediaDeletionCandidate: Equatable, Sendable {
  case managed(ManagedMediaReference)
  case unverified(owner: String, uri: String, exclusive: Bool)
}

public enum ManagedMediaDeletionStatus: String, Codable, Sendable {
  case deleted
  case alreadyMissing
  case preservedAmbiguous
  case preservedOtherOwner
  case rejectedUnsafe
  case retryable
}

public enum ManagedMediaIssue: String, Codable, Sendable {
  case invalidOwner
  case invalidOperation
  case invalidReference
  case unsafePath
  case unsafeNode
  case identityChanged
  case authorityChanged
  case unverifiedOwnership
  case otherOwner
  case shared
  case hardLinked
  case collision
  case writerClosed
  case ioFailure
}

public struct ManagedMediaError: Error, Equatable, Sendable {
  public let issue: ManagedMediaIssue
  public let errnoCode: Int32?

  init(_ issue: ManagedMediaIssue, errnoCode: Int32? = nil) {
    self.issue = issue
    self.errnoCode = errnoCode
  }

  var deletionResult: ManagedMediaDeletionResult {
    let status: ManagedMediaDeletionStatus
    switch issue {
    case .unverifiedOwnership, .shared, .hardLinked:
      status = .preservedAmbiguous
    case .otherOwner:
      status = .preservedOtherOwner
    case .ioFailure:
      status = .retryable
    default:
      status = .rejectedUnsafe
    }
    return ManagedMediaDeletionResult(status: status, issue: issue, errnoCode: errnoCode)
  }
}

public struct ManagedMediaDeletionResult: Equatable, Sendable {
  public let status: ManagedMediaDeletionStatus
  public let issue: ManagedMediaIssue?
  public let errnoCode: Int32?

  init(status: ManagedMediaDeletionStatus, issue: ManagedMediaIssue? = nil, errnoCode: Int32? = nil) {
    self.status = status
    self.issue = issue
    self.errnoCode = errnoCode
  }
}

enum ManagedMediaFormat {
  static let version = 1
  static let namespace = "managed-v1"
  static let records = ".records"
  static let authority = ".authority"
  static let maximumReferenceBytes = 16_384

  static func isUUID(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard bytes.count == 36 else { return false }
    for index in bytes.indices {
      if [8, 13, 18, 23].contains(index) {
        guard bytes[index] == 45 else { return false }
      } else {
        guard (48...57).contains(bytes[index]) || (97...102).contains(bytes[index]) else {
          return false
        }
      }
    }
    return (49...56).contains(bytes[14]) && [56, 57, 97, 98].contains(bytes[19])
  }

  static func validateOwner(_ owner: String) throws {
    guard owner == "device-guest" || isUUID(owner) else {
      throw ManagedMediaError(.invalidOwner)
    }
  }

  static func validateOperation(_ operation: String) throws {
    guard isUUID(operation) else { throw ManagedMediaError(.invalidOperation) }
  }

  static func relativePath(owner: String, operation: String, asset: String, role: ManagedMediaRole) -> String {
    [namespace, owner, operation, asset, role.filename].joined(separator: "/")
  }

  static func localPath(_ url: URL) throws -> String {
    guard url.baseURL == nil,
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          components.scheme == "file",
          components.host == nil || components.host == "",
          components.user == nil, components.password == nil, components.port == nil,
          components.query == nil, components.fragment == nil else {
      throw ManagedMediaError(.unsafePath)
    }
    let encoded = components.percentEncodedPath.lowercased()
    guard !["%2f", "%5c", "%00"].contains(where: { encoded.contains($0) }),
          var path = components.percentEncodedPath.removingPercentEncoding else {
      throw ManagedMediaError(.unsafePath)
    }
    if path.hasSuffix("/") { path.removeLast() }
    guard path.hasPrefix("/"), !path.contains("\\"), !path.contains("%"),
          !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
      throw ManagedMediaError(.unsafePath)
    }
    let parts = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
    guard !parts.isEmpty, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
      throw ManagedMediaError(.unsafePath)
    }
    return path
  }

  static func legacyLeaf(uri: String, rootPath: String) throws -> String {
    guard !uri.contains("\0"), !uri.contains("\\"), !uri.contains("%") else {
      throw ManagedMediaError(.unsafePath)
    }
    let path: String
    if uri.hasPrefix("/") {
      guard !uri.contains("//"), !uri.hasSuffix("/") else { throw ManagedMediaError(.unsafePath) }
      path = try localPath(URL(fileURLWithPath: uri))
    } else {
      guard let url = URL(string: uri), !uri.hasSuffix("/") else { throw ManagedMediaError(.unsafePath) }
      path = try localPath(url)
    }
    let prefix = rootPath + "/"
    guard path.hasPrefix(prefix) else { throw ManagedMediaError(.unsafePath) }
    let leaf = String(path.dropFirst(prefix.count))
    guard !leaf.isEmpty, leaf != ".", leaf != "..", !leaf.contains("/"),
          leaf.utf8.allSatisfy({
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
              || [45, 46, 95].contains($0)
          }),
          ["mov", "jpg", "json"].contains((leaf as NSString).pathExtension) else {
      throw ManagedMediaError(.unsafePath)
    }
    return leaf
  }

  static func encode<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value)
  }

  static func decodeCanonical<T: Codable>(_ type: T.Type, from data: Data, maximumBytes: Int) throws -> T {
    guard !data.isEmpty, data.count <= maximumBytes else { throw ManagedMediaError(.invalidReference) }
    do {
      let value = try JSONDecoder().decode(type, from: data)
      guard try encode(value) == data else { throw ManagedMediaError(.invalidReference) }
      return value
    } catch {
      throw ManagedMediaError(.invalidReference)
    }
  }
}
