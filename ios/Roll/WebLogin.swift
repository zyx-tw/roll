import AuthenticationServices
import CryptoKit
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
        let data = try await Client.shared.send("/api/auth/app/token", method: "POST", json: ["code": code, "verifier": verifier])
        guard let token = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["token"] as? String else { throw APIError(status: 0) }
        await Client.shared.setSession(token)
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
            session.start()
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
