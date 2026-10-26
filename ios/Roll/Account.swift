import AuthenticationServices
import Foundation
import Observation

@Observable
final class Account {
    enum State: Equatable {
        case checking
        case signedOut
        // full: the session may browse photos. A web sign-in only uploads.
        case signedIn(full: Bool)
    }

    var state = State.checking
    var error: String?

    func refresh() async {
        guard await Client.shared.me() != nil else {
            state = .signedOut
            return
        }
        let browse = try? await Client.shared.send("/api/photos?limit=1")
        state = .signedIn(full: browse != nil)
    }

    // The passkey gives a full session but needs iOS to trust the domain
    // association; when that fails, the web sign-in still allows uploads.
    func signIn() async {
        error = nil
        do {
            do {
                try await Passkey.signIn()
            } catch let error as ASAuthorizationError where error.code == .canceled {
                return
            } catch is APIError {
                throw APIError(status: 0)
            } catch {
                try await WebLogin.signIn()
            }
            await refresh()
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            return
        } catch let error as APIError {
            self.error = "登入失敗（伺服器 \(error.status)）"
        } catch {
            let ns = error as NSError
            self.error = "登入失敗：\(ns.code) \(ns.localizedDescription)"
        }
    }

    func signOut() async {
        await Client.shared.logout()
        await ImageCache.shared.clear()
        state = .signedOut
    }
}
