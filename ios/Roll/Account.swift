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
            try await Passkey.signIn()
            await refresh()
        } catch {
            self.error = "登入失敗"
        }
    }

    func signOut() async {
        await Client.shared.logout()
        state = .signedOut
    }
}
