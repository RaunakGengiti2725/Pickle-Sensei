import AuthenticationServices
import Foundation
import React
import os

private let appleAuthLogger = Logger(
  subsystem: Bundle.main.bundleIdentifier ?? "com.picklesensei",
  category: "AppleAuth"
)

/// Sign in with Apple (spec p. 5: OIDC sign-in, Apple first).
/// Returns the raw Apple identity token (a JWT from appleid.apple.com), the
/// one-use authorization code, and profile fields; the app/backend exchange
/// happens immediately in JS. Neither Apple credential is persisted. Typed failures:
///   auth.canceled        — user dismissed the sheet
///   auth.not_configured  — native bridge unavailable (reported by JS)
///   auth.failed          — anything else, message attached
@objc(PickleAuth)
class PickleAuth: NSObject {
  private var authorizationController: ASAuthorizationController?
  private var controllerDelegate: AppleSignInDelegate?

  @objc static func requiresMainQueueSetup() -> Bool { true }

  @objc func signInWithApple(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    appleAuthLogger.notice("stage=bridge_entered")
    DispatchQueue.main.async {
      let bundleID = Bundle.main.bundleIdentifier ?? "missing"
      appleAuthLogger.notice("stage=request_created bundle_id=\(bundleID, privacy: .public)")
      let provider = ASAuthorizationAppleIDProvider()
      let request = provider.createRequest()
      request.requestedScopes = [.fullName, .email]

      let delegate = AppleSignInDelegate(
        onSuccess: { [weak self] payload in
          appleAuthLogger.notice("stage=bridge_resolve")
          self?.authorizationController = nil
          self?.controllerDelegate = nil
          resolve(payload)
        },
        onFailure: { [weak self] code, message, error in
          appleAuthLogger.error("stage=bridge_reject code=\(code, privacy: .public)")
          self?.authorizationController = nil
          self?.controllerDelegate = nil
          reject(code, message, error)
        }
      )
      self.controllerDelegate = delegate

      let controller = ASAuthorizationController(authorizationRequests: [request])
      self.authorizationController = controller
      controller.delegate = delegate
      controller.presentationContextProvider = delegate
      appleAuthLogger.notice("stage=controller_perform_requests")
      controller.performRequests()
    }
  }
}

private final class AppleSignInDelegate: NSObject, ASAuthorizationControllerDelegate,
  ASAuthorizationControllerPresentationContextProviding
{
  private let onSuccess: ([String: Any]) -> Void
  private let onFailure: (String, String, Error?) -> Void

  init(
    onSuccess: @escaping ([String: Any]) -> Void,
    onFailure: @escaping (String, String, Error?) -> Void
  ) {
    self.onSuccess = onSuccess
    self.onFailure = onFailure
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window =
      scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.first?.windows.first
    return window ?? ASPresentationAnchor()
  }

  func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    let credentialType = String(describing: type(of: authorization.credential))
    appleAuthLogger.notice(
      "stage=authorization_callback type=\(credentialType, privacy: .public)"
    )
    guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
      let error = NSError(
        domain: "com.picklesensei.auth",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Unexpected credential type from Apple."]
      )
      onFailure("auth.failed", error.localizedDescription, error)
      return
    }
    guard let tokenData = credential.identityToken else {
      let error = NSError(
        domain: "com.picklesensei.auth",
        code: 2,
        userInfo: [
          NSLocalizedDescriptionKey: "Apple returned a credential without an identity token."
        ]
      )
      appleAuthLogger.error("stage=credential token=false")
      onFailure("auth.failed", error.localizedDescription, error)
      return
    }
    guard let token = String(data: tokenData, encoding: .utf8), !token.isEmpty else {
      let error = NSError(
        domain: "com.picklesensei.auth",
        code: 3,
        userInfo: [
          NSLocalizedDescriptionKey: "Apple returned an identity token that is not valid UTF-8."
        ]
      )
      appleAuthLogger.error(
        "stage=credential utf8=false bytes=\(tokenData.count, privacy: .public)"
      )
      onFailure("auth.failed", error.localizedDescription, error)
      return
    }
    guard let codeData = credential.authorizationCode,
      let authorizationCode = String(data: codeData, encoding: .utf8),
      !authorizationCode.isEmpty
    else {
      let error = NSError(
        domain: "com.picklesensei.auth",
        code: 4,
        userInfo: [
          NSLocalizedDescriptionKey:
            "Apple returned a credential without a usable authorization code."
        ]
      )
      appleAuthLogger.error("stage=credential authorization_code=false")
      onFailure("auth.failed", error.localizedDescription, error)
      return
    }
    appleAuthLogger.notice(
      "stage=credential user=\(!credential.user.isEmpty, privacy: .public) token_bytes=\(tokenData.count, privacy: .public) code_bytes=\(codeData.count, privacy: .public)"
    )
    var payload: [String: Any] = [
      "user": credential.user,
      "identityToken": token,
      "authorizationCode": authorizationCode,
    ]
    if let email = credential.email { payload["email"] = email }
    if let name = credential.fullName {
      payload["givenName"] = name.givenName ?? ""
      payload["familyName"] = name.familyName ?? ""
    }
    onSuccess(payload)
  }

  func authorizationController(
    controller: ASAuthorizationController, didCompleteWithError error: Error
  ) {
    let nsError = error as NSError
    appleAuthLogger.error(
      "stage=authorization_error \(Self.errorSummary(error), privacy: .public)"
    )
    if nsError.domain == ASAuthorizationError.errorDomain,
      ASAuthorizationError.Code(rawValue: nsError.code) == .canceled
    {
      onFailure("auth.canceled", "Sign-in canceled.", error)
      return
    }
    let message =
      "Apple authorization failed (\(nsError.domain) code \(nsError.code)): \(nsError.localizedDescription)"
    onFailure("auth.failed", message, error)
  }

  private static func errorSummary(_ error: Error) -> String {
    var parts: [String] = []
    var current: NSError? = error as NSError
    var depth = 0
    while let value = current, depth < 4 {
      let keys = value.userInfo.keys
        .map { String(describing: $0) }
        .sorted()
        .joined(separator: ",")
      parts.append(
        [
          "depth=\(depth)",
          "domain=\(value.domain)",
          "code=\(value.code)",
          "description=\(value.localizedDescription)",
          "user_info_keys=\(keys)",
        ].joined(separator: " ")
      )
      current = value.userInfo[NSUnderlyingErrorKey] as? NSError
      depth += 1
    }
    return parts.joined(separator: " | ")
  }
}
