import AVKit
import SwiftUI

@Observable
final class Gallery {
    var photos: [Photo] = []
    private var next: String?
    private var loading = false
    private(set) var done = false

    func reload() async {
        next = nil
        done = false
        photos = []
        await more()
    }

    func more() async {
        guard !loading, !done else { return }
        loading = true
        defer { loading = false }
        guard let page = try? await Client.shared.photos(after: next) else { return }
        photos.append(contentsOf: page.items)
        next = page.next
        done = page.next == nil
    }

    // After an upload the server still makes previews: reload when they are ready.
    func waitForPreviews() async {
        for _ in 0..<120 {
            if await Client.shared.pending() == 0 { break }
            try? await Task.sleep(for: .seconds(2))
        }
        await reload()
    }
}

struct GalleryView: View {
    @Environment(Uploader.self) private var uploader
    @State private var gallery = Gallery()
    @State private var open: Photo?

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 3)

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(gallery.photos) { photo in
                    Thumb(photo: photo)
                        .onTapGesture { open = photo }
                        .onAppear { if photo == gallery.photos.last { Task { await gallery.more() } } }
                }
            }
        }
        .refreshable { await gallery.reload() }
        .task { await gallery.reload() }
        .onChange(of: uploader.finished) { Task { await gallery.waitForPreviews() } }
        .fullScreenCover(item: $open) { photo in
            Viewer(photos: gallery.photos, start: photo)
        }
    }
}

struct Thumb: View {
    let photo: Photo
    @State private var image: UIImage?

    var body: some View {
        Color.secondary.opacity(0.15)
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if let duration = photo.duration, photo.isVideo {
                    Text(formatDuration(duration))
                        .font(.caption2.monospacedDigit().weight(.semibold))
                        .foregroundStyle(.white)
                        .shadow(radius: 2)
                        .padding(4)
                }
            }
            .clipped()
            .contentShape(.rect)
            .task(id: photo.id) { image = await ImageCache.shared.image(photo.url("thumb")) }
    }
}

struct Viewer: View {
    let photos: [Photo]
    @State var current: Photo?
    @Environment(\.dismiss) private var dismiss

    init(photos: [Photo], start: Photo) {
        self.photos = photos
        _current = State(initialValue: start)
    }

    var body: some View {
        TabView(selection: $current) {
            ForEach(photos) { photo in
                Page(photo: photo, active: current == photo)
                    .tag(Optional(photo))
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .background(.black)
        .ignoresSafeArea()
        .overlay(alignment: .topLeading) {
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.title3).padding(12)
            }
            .buttonStyle(.glass)
            .padding(.leading, 16)
            .accessibilityLabel("關閉")
        }
        .overlay(alignment: .bottom) {
            if let current {
                VStack(spacing: 2) {
                    Text(formatTaken(current.takenAt))
                    if let place = current.place { Text(place) }
                }
                .font(.footnote)
                .foregroundStyle(.white)
                .shadow(radius: 3)
                .padding(.bottom, 24)
            }
        }
    }

    struct Page: View {
        let photo: Photo
        let active: Bool
        @State private var image: UIImage?
        @State private var player: AVPlayer?

        var body: some View {
            ZStack {
                if photo.isVideo, let player {
                    VideoPlayer(player: player)
                } else if let image {
                    Image(uiImage: image).resizable().scaledToFit()
                } else {
                    ProgressView().tint(.white)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .task(id: photo.id) {
                if photo.isVideo {
                    player = await makePlayer(for: photo)
                } else {
                    image = await ImageCache.shared.image(photo.url("thumb"))
                    image = await ImageCache.shared.image(photo.url("large")) ?? image
                }
            }
            .onChange(of: active, initial: true) { if active { player?.play() } else { player?.pause() } }
            .onDisappear { player?.pause() }
        }
    }
}

func formatDuration(_ seconds: Double) -> String {
    let total = Int(seconds.rounded())
    return "\(total / 60):" + String(format: "%02d", total % 60)
}

// "2026 年 4 月 16 日 週四 09:28", as on the web.
func formatTaken(_ ms: Double) -> String {
    let date = Date(timeIntervalSince1970: ms / 1000)
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Asia/Taipei")!
    let c = calendar.dateComponents([.year, .month, .day, .weekday, .hour, .minute], from: date)
    let weekday = ["日", "一", "二", "三", "四", "五", "六"][(c.weekday ?? 1) - 1]
    return "\(c.year!) 年 \(c.month!) 月 \(c.day!) 日 週\(weekday) " + String(format: "%02d:%02d", c.hour!, c.minute!)
}
