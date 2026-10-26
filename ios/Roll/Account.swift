import AuthenticationServices
import Foundation
import Observation

@Observable
final class Account {
    enum State { case checking, signedOut, signedIn(String) }
    var state = State.checking
    var error: String?

    func refresh() async {
        if let name = await Client.shared.me() {
            state = .signedIn(name)
        } else {
            state = .signedOut
        }
    }

    func signIn() async {
        error = nil
        do {
            try await WebLogin.signIn()
            await refresh()
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            return
        } catch let error as APIError {
            self.error = "登入失敗（伺服器 \(error.status)）"
        } catch {
            let ns = error as NSError
            var parts = ["\(ns.code)", ns.localizedDescription]
            if let reason = ns.localizedFailureReason { parts.append(reason) }
            if let under = ns.userInfo[NSUnderlyingErrorKey] as? NSError { parts.append("\(under.domain) \(under.code) \(under.localizedDescription)") }
            self.error = "登入失敗：" + parts.joined(separator: "\n")
        }
    }

    func signOut() async {
        await Client.shared.logout()
        state = .signedOut
    }
}
