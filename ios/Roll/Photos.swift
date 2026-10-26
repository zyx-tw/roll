import AVFoundation
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
}

extension Client {
    func photos(after cursor: String?) async throws -> Page {
        var path = "/api/photos?limit=120"
        if let cursor { path += "&cursor=\(cursor)" }
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

// Previews by URL, kept in memory while the app runs.
actor ImageCache {
    static let shared = ImageCache()
    private let cache = NSCache<NSURL, UIImage>()
    private var loading: [URL: Task<UIImage?, Never>] = [:]

    init() { cache.totalCostLimit = 200 * 1024 * 1024 }

    func image(_ url: URL) async -> UIImage? {
        if let hit = cache.object(forKey: url as NSURL) { return hit }
        if let running = loading[url] { return await running.value }
        let task = Task<UIImage?, Never> {
            let path = url.absoluteString.replacingOccurrences(of: Client.origin.absoluteString, with: "")
            guard let data = try? await Client.shared.send(path), let image = UIImage(data: data) else { return nil }
            return image.preparingForDisplay() ?? image
        }
        loading[url] = task
        let image = await task.value
        loading[url] = nil
        if let image { cache.setObject(image, forKey: url as NSURL, cost: Int(image.size.width * image.size.height * 4)) }
        return image
    }
}

@MainActor
func makePlayer(for photo: Photo) async -> AVPlayer {
    let cookies = await Client.shared.sessionCookies()
    let asset = AVURLAsset(url: photo.url("original"), options: [AVURLAssetHTTPCookiesKey: cookies])
    return AVPlayer(playerItem: AVPlayerItem(asset: asset))
}
