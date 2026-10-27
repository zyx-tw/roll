import Foundation

struct APIError: Error {
    let status: Int
    var received: Int?
}

// Talks to roll.zyx.tw. Cookies are kept by hand: the server's are
// SameSite=Strict, and the session belongs in the keychain, not a cookie jar.
actor Client {
    static let shared = Client()
    nonisolated static let origin = URL(string: "https://roll.zyx.tw")!

    private let session: URLSession
    private var cookies: [String: String] = [:]

    init() {
        let config = URLSessionConfiguration.default
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.waitsForConnectivity = true
        config.timeoutIntervalForRequest = 60
        session = URLSession(configuration: config)
        if let token = Keychain.load() { cookies["roll_session"] = token }
        #if DEBUG
        // Simulator tests: `-rollSession <token>` signs in without a passkey.
        if let token = UserDefaults.standard.string(forKey: "rollSession") { cookies["roll_session"] = token }
        #endif
    }

    var signedIn: Bool { cookies["roll_session"] != nil }
    var sessionToken: String? { cookies["roll_session"] }

    func setSession(_ token: String?) {
        cookies["roll_session"] = token
        Keychain.save(token)
    }

    func send(_ path: String, method: String = "GET", json: Any? = nil, body: Data? = nil) async throws -> Data {
        guard let url = URL(string: Client.origin.absoluteString + path) else { throw APIError(status: 400) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if method != "GET" { request.setValue(Client.origin.absoluteString, forHTTPHeaderField: "Origin") }
        if !cookies.isEmpty {
            request.setValue(cookies.map { "\($0.key)=\($0.value)" }.joined(separator: "; "), forHTTPHeaderField: "Cookie")
        }
        if let json {
            request.httpBody = try JSONSerialization.data(withJSONObject: json)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else if let body {
            request.httpBody = body
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError(status: 0) }
        keepCookies(http)
        if http.statusCode == 401 { setSession(nil) }
        guard (200..<300).contains(http.statusCode) else {
            let received = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["received"] as? Int
            throw APIError(status: http.statusCode, received: received)
        }
        return data
    }

    private func keepCookies(_ response: HTTPURLResponse) {
        let fields = response.allHeaderFields.reduce(into: [String: String]()) { result, pair in
            if let key = pair.key as? String, let value = pair.value as? String { result[key] = value }
        }
        for cookie in HTTPCookie.cookies(withResponseHeaderFields: fields, for: Client.origin) {
            let gone = cookie.value.isEmpty || (cookie.expiresDate.map { $0 < Date() } ?? false)
            if cookie.name == "roll_session" {
                setSession(gone ? nil : cookie.value)
            } else {
                cookies[cookie.name] = gone ? nil : cookie.value
            }
        }
    }

    // The signed-in name; nil when the server says nobody is signed in.
    func me() async throws -> String? {
        let data = try await send("/api/auth/me")
        let user = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["user"] as? [String: Any]
        return user?["name"] as? String
    }

    func logout() async {
        _ = try? await send("/api/auth/logout", method: "POST", json: [String: String]())
        setSession(nil)
    }
}
