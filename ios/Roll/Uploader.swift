import Observation
import Photos
import UIKit

@Observable
final class Uploader {
    enum Status: Equatable {
        case waiting
        case fetching(Double)
        case uploading(Double)
        case done
        case failed(String)
    }

    struct Item: Identifiable {
        let id: String
        var thumbnail: UIImage?
        var status = Status.waiting
    }

    var items: [Item] = []
    private var running = false
    private let doneKey = "uploaded"

    // Items already sent, by library id, so picking one again does not send it twice.
    private var uploaded: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: doneKey) ?? []) }
        set { UserDefaults.standard.set(Array(newValue), forKey: doneKey) }
    }

    func add(_ identifiers: [String]) async {
        guard !identifiers.isEmpty else { return }
        guard await Library.authorize() else {
            items.insert(contentsOf: identifiers.map { Item(id: $0, status: .failed("沒有照片存取權")) }, at: 0)
            return
        }
        let assets = Library.assets(identifiers)
        let known = Set(items.map(\.id))
        for id in identifiers where !known.contains(id) {
            var item = Item(id: id)
            if assets[id] == nil { item.status = .failed("找不到這個項目") }
            else if uploaded.contains(id) { item.status = .done }
            items.append(item)
            if let asset = assets[id] { loadThumbnail(asset) }
        }
        await run(assets)
    }

    func retry() async {
        for index in items.indices {
            if case .failed = items[index].status { items[index].status = .waiting }
        }
        await run(Library.assets(items.map(\.id)))
    }

    private func set(_ id: String, _ status: Status) {
        if let index = items.firstIndex(where: { $0.id == id }) { items[index].status = status }
    }

    private func loadThumbnail(_ asset: PHAsset) {
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.isNetworkAccessAllowed = true
        PHImageManager.default().requestImage(for: asset, targetSize: CGSize(width: 160, height: 160), contentMode: .aspectFill, options: options) { [weak self] image, _ in
            Task { @MainActor in
                guard let self, let index = self.items.firstIndex(where: { $0.id == asset.localIdentifier }) else { return }
                self.items[index].thumbnail = image
            }
        }
    }

    // One item at a time, oldest first. The screen stays on and iOS gets asked
    // for time to finish when the app goes to the background.
    private func run(_ assets: [String: PHAsset]) async {
        guard !running else { return }
        running = true
        UIApplication.shared.isIdleTimerDisabled = true
        let background = UIApplication.shared.beginBackgroundTask(withName: "upload")
        defer {
            running = false
            UIApplication.shared.isIdleTimerDisabled = false
            UIApplication.shared.endBackgroundTask(background)
        }
        while let item = items.first(where: { $0.status == .waiting }) {
            guard let asset = assets[item.id] ?? Library.assets([item.id])[item.id] else {
                set(item.id, .failed("找不到這個項目"))
                continue
            }
            do {
                try await send(asset)
                var done = uploaded
                done.insert(item.id)
                uploaded = done
                set(item.id, .done)
            } catch {
                set(item.id, .failed("上傳失敗"))
            }
        }
    }

    private func send(_ asset: PHAsset) async throws {
        let id = asset.localIdentifier
        let resources = Library.originals(of: asset)
        guard !resources.isEmpty else { throw APIError(status: 0) }
        let count = Double(resources.count)
        for (index, resource) in resources.enumerated() {
            let base = Double(index) / count
            set(id, .fetching(0))
            let file = try await Library.export(resource) { fraction in
                Task { @MainActor in self.set(id, .fetching(fraction)) }
            }
            defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
            set(id, .uploading(base))
            _ = try await Client.shared.upload(file: file, name: resource.originalFilename, modified: asset.creationDate) { fraction in
                Task { @MainActor in self.set(id, .uploading(base + fraction / count)) }
            }
        }
    }
}
