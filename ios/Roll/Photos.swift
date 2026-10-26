import AVFoundation
import CryptoKit
import Foundation
import UIKit

nonisolated struct Photo: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let kind: String
    let takenAt: Double
    let width: Int
    let height: Int
    let duration: Double?
    let live: Bool
    let place: String?
    let v: Int

    var isVideo: Bool { kind == "video" }

    func url(_ part: String) -> URL {
        URL(string: "\(Client.origin.absoluteString)/api/photos/\(id)/\(part)?v=\(v)")!
    }
}

nonisolated struct Page: Decodable, Sendable {
    let items: [Photo]
    let next: String?
    let total: Int?
}

extension Client {
    func photos(after cursor: String?, query: String = "") async throws -> Page {
        var path = "/api/photos?limit=120"
        if let cursor { path += "&cursor=\(cursor)" }
        if !query.isEmpty, let q = query.addingPercentEncoding(withAllowedCharacters: .alphanumerics) { path += "&q=\(q)" }
        return try JSONDecoder().decode(Page.self, from: try await send(path))
    }

    func pending() async -> Int {
        guard let data = try? await send("/api/photos/pending"),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return 0 }
        return (body["files"] as? Int ?? 0) + ((body["scanning"] as? Bool ?? false) ? 1 : 0)
    }

    // The session cookie, for players that fetch media themselves.
    func sessionCookies() -> [HTTPCookie] {
        guard let token = sessionToken else { return [] }
        let cookie = HTTPCookie(properties: [.name: "roll_session", .value: token, .domain: Client.origin.host()!, .path: "/", .secure: "TRUE"])
        return cookie.map { [$0] } ?? []
    }
}

// Previews by URL: in memory while the app runs, and on disk in Caches so a
// restart does not fetch them again. The URL carries the photo version, so a
// changed photo gets a new file; iOS may clear Caches when space runs low.
actor ImageCache {
    static let shared = ImageCache()
    private let memory = NSCache<NSURL, UIImage>()
    private var loading: [URL: Task<UIImage?, Never>] = [:]
    private let folder: URL

    init() {
        memory.totalCostLimit = 200 * 1024 * 1024
        folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appending(path: "previews")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    private func diskPath(_ url: URL) -> URL {
        let name = SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        return folder.appending(path: name)
    }

    // Sign-out drops every saved preview, so the next account starts empty.
    func clear() {
        memory.removeAllObjects()
        try? FileManager.default.removeItem(at: folder)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    func image(_ url: URL) async -> UIImage? {
        if let hit = memory.object(forKey: url as NSURL) { return hit }
        if let running = loading[url] { return await running.value }
        let disk = diskPath(url)
        let task = Task<UIImage?, Never> {
            let data: Data
            if let saved = try? Data(contentsOf: disk) {
                data = saved
            } else {
                let path = url.absoluteString.replacingOccurrences(of: Client.origin.absoluteString, with: "")
                guard let fetched = try? await Client.shared.send(path) else { return nil }
                try? fetched.write(to: disk, options: .atomic)
                data = fetched
            }
            guard let image = UIImage(data: data) else { return nil }
            return image.preparingForDisplay() ?? image
        }
        loading[url] = task
        let image = await task.value
        loading[url] = nil
        if let image { memory.setObject(image, forKey: url as NSURL, cost: Int(image.size.width * image.size.height * 4)) }
        return image
    }
}

@MainActor
func makePlayer(for photo: Photo) async -> AVPlayer {
    let cookies = await Client.shared.sessionCookies()
    // The server's 8 Mbps playback copy when it has one, else the original.
    let asset = AVURLAsset(url: photo.url("play"), options: [AVURLAssetHTTPCookiesKey: cookies])
    return AVPlayer(playerItem: AVPlayerItem(asset: asset))
}
