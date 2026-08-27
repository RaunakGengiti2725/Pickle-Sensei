import AuthenticationServices
import Foundation
import React

/// Sign in with Apple (spec p. 5: OIDC sign-in, Apple first).
/// Returns the raw Apple identity token (a JWT from appleid.apple.com) plus
/// profile fields; the app/backend exchange happens in JS. Typed failures:
///   auth.canceled        — user dismissed the sheet
///   auth.not_configured  — missing Sign in with Apple capability/signing
///   auth.failed          — anything else, message attached
@objc(PickleAuth)
class PickleAuth: NSObject {
  private var controllerDelegate: AppleSignInDelegate?

  @objc static func requiresMainQueueSetup() -> Bool { true }

  @objc func signInWithApple(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let provider = ASAuthorizationAppleIDProvider()
      let request = provider.createRequest()
      request.requestedScopes = [.fullName, .email]

      let delegate = AppleSignInDelegate(
        onSuccess: { [weak self] payload in
          self?.controllerDelegate = nil
          resolve(payload)
        },
        onFailure: { [weak self] code, message in
          self?.controllerDelegate = nil
          reject(code, message, nil)
        }
      )
      self.controllerDelegate = delegate

      let controller = ASAuthorizationController(authorizationRequests: [request])
      controller.delegate = delegate
      controller.presentationContextProvider = delegate
      controller.performRequests()
    }
  }
}

private final class AppleSignInDelegate: NSObject, ASAuthorizationControllerDelegate,
  ASAuthorizationControllerPresentationContextProviding {
  private let onSuccess: ([String: Any]) -> Void
  private let onFailure: (String, String) -> Void

  init(onSuccess: @escaping ([String: Any]) -> Void, onFailure: @escaping (String, String) -> Void) {
    self.onSuccess = onSuccess
    self.onFailure = onFailure
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.first?.windows.first
    return window ?? ASPresentationAnchor()
  }

  func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
      onFailure("auth.failed", "Unexpected credential type from Apple.")
      return
    }
    var payload: [String: Any] = ["user": credential.user]
    if let tokenData = credential.identityToken, let token = String(data: tokenData, encoding: .utf8) {
      payload["identityToken"] = token
    }
    if let codeData = credential.authorizationCode, let code = String(data: codeData, encoding: .utf8) {
      payload["authorizationCode"] = code
    }
    if let email = credential.email { payload["email"] = email }
    if let name = credential.fullName {
      payload["givenName"] = name.givenName ?? ""
      payload["familyName"] = name.familyName ?? ""
    }
    onSuccess(payload)
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    let nsError = error as NSError
    if nsError.domain == ASAuthorizationError.errorDomain {
      switch ASAuthorizationError.Code(rawValue: nsError.code) {
      case .canceled:
        onFailure("auth.canceled", "Sign-in canceled.")
        return
      case .unknown, .notHandled:
        // Most common cause in development: Sign in with Apple capability or
        // signing team not configured, or the simulator has no Apple ID.
        onFailure(
          "auth.not_configured",
          "Sign in with Apple is not available. Check the Signing & Capabilities tab (team + Sign in with Apple) and that this device/simulator is signed into an Apple ID."
        )
        return
      default:
        break
      }
    }
    onFailure("auth.failed", nsError.localizedDescription)
  }
}
