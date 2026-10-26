import AuthenticationServices
import CryptoKit
import DeviceCheck
import UIKit

// Signs in through roll.zyx.tw in a system browser sheet, with the site's own
// passkey. The page hands back a one-time code; only this app holds the PKCE
// verifier that turns it into a session.
final class WebLogin: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    static func signIn() async throws {
        let verifier = Data((0..<32).map { _ in UInt8.random(in: 0...255) }).base64URL
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        var parts = URLComponents(url: Client.origin, resolvingAgainstBaseURL: false)!
        parts.path = "/"
        parts.queryItems = [URLQueryItem(name: "app", value: challenge)]
        let callback = try await WebLogin().open(parts.url!)
        guard let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value else {
            throw APIError(status: 0)
        }
        var body: [String: Any] = ["code": code, "verifier": verifier]
        do {
            body["attest"] = try await attest(code: code)
        } catch {
            // Without Apple's proof the session can still upload, just not browse.
            lastAttestError = (error as NSError).localizedDescription
        }
        let data = try await Client.shared.send("/api/auth/app/token", method: "POST", json: body)
        guard let token = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["token"] as? String else { throw APIError(status: 0) }
        await Client.shared.setSession(token)
    }

    static var lastAttestError: String?

    // App Attest: Apple vouches that this is the genuine roll app on a real
    // device, so the server can give a full session. The proof covers the
    // server's challenge and this code. A new key each sign-in, which is rare.
    private static func attest(code: String) async throws -> [String: String] {
        let service = DCAppAttestService.shared
        guard service.isSupported else { throw NSError(domain: "roll", code: 1, userInfo: [NSLocalizedDescriptionKey: "App Attest unsupported"]) }
        let data = try await Client.shared.send("/api/auth/app/challenge", method: "POST", json: [String: String]())
        guard let challenge = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["challenge"] as? String else { throw APIError(status: 0) }
        let keyId = try await service.generateKey()
        let hash = Data(SHA256.hash(data: Data("\(challenge).\(code)".utf8)))
        let attestation = try await service.attestKey(keyId, clientDataHash: hash)
        return ["keyId": keyId, "attestation": attestation.base64EncodedString(), "challenge": challenge]
    }

    private func open(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callback: .customScheme("tw.zyx.roll")) { [weak self] callback, error in
                self?.session = nil
                if let callback { continuation.resume(returning: callback) } else { continuation.resume(throwing: error ?? APIError(status: 0)) }
            }
            // Share Safari's sign-in, so a browser already signed in skips the passkey.
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = self
            // Kept until the sheet answers; a released session cancels itself.
            self.session = session
            if !session.start() {
                self.session = nil
                continuation.resume(throwing: APIError(status: 0))
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
    }
}

extension Data {
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
