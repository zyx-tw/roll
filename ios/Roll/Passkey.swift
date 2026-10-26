import AuthenticationServices
import UIKit

// Signs in with the passkey made on roll.zyx.tw (iCloud Keychain shares it).
final class Passkey: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<ASAuthorizationPlatformPublicKeyCredentialAssertion, Error>?
    // The controller must outlive performRequests(), or iOS cancels the request before showing the sheet.
    private var controller: ASAuthorizationController?

    static func signIn() async throws {
        let data = try await Client.shared.send("/api/auth/login/options", method: "POST", json: [String: String]())
        guard let options = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let challenge = (options["challenge"] as? String).flatMap(Data.init(base64URL:))
        else { throw APIError(status: 0) }
        let assertion = try await Passkey().assert(challenge: challenge)
        let response: [String: Any] = [
            "id": assertion.credentialID.base64URL,
            "rawId": assertion.credentialID.base64URL,
            "type": "public-key",
            "authenticatorAttachment": "platform",
            "clientExtensionResults": [String: String](),
            "response": [
                "clientDataJSON": assertion.rawClientDataJSON.base64URL,
                "authenticatorData": assertion.rawAuthenticatorData.base64URL,
                "signature": assertion.signature.base64URL,
                "userHandle": assertion.userID.base64URL,
            ],
        ]
        _ = try await Client.shared.send("/api/auth/login/verify", method: "POST", json: ["response": response])
    }

    private func assert(challenge: Data) async throws -> ASAuthorizationPlatformPublicKeyCredentialAssertion {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: Client.origin.host()!)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        request.userVerificationPreference = .required
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        self.controller = controller
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            controller.performRequests()
        }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        if let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            continuation?.resume(returning: assertion)
        } else {
            continuation?.resume(throwing: APIError(status: 0))
        }
        continuation = nil
        self.controller = nil
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
        self.controller = nil
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
    }
}

extension Data {
    init?(base64URL: String) {
        var text = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        text += String(repeating: "=", count: (4 - text.count % 4) % 4)
        self.init(base64Encoded: text)
    }

    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
