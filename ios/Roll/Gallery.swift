import AVKit
import SwiftUI

// Newest first from the server; shown oldest at the top, newest at the bottom.
@Observable
final class Gallery {
    var photos: [Photo] = []
    var total: Int?
    var query = ""
    private var next: String?
    private var loading = false

    // Replaces the list only once the first page is in, so a refresh never blanks the grid.
    func reload() async {
        guard let page = try? await Client.shared.photos(after: nil, query: query) else { return }
        photos = page.items
        next = page.next
        total = page.total
    }

    func more() async {
        guard !loading, let cursor = next else { return }
        loading = true
        defer { loading = false }
        guard let page = try? await Client.shared.photos(after: cursor, query: query) else { return }
        photos.append(contentsOf: page.items)
        next = page.next
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

struct PhotoGrid: View {
    let gallery: Gallery
    var topInset: CGFloat = 0
    var bottomInset: CGFloat = 0
    @State private var open: Photo?

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 3)

    var body: some View {
        let shown = Array(gallery.photos.reversed())
        // Blank cells at the top, so the newest row ends at the bottom right, as in Photos.
        let pad = (3 - shown.count % 3) % 3
        ScrollView {
            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(0..<pad, id: \.self) { _ in Color.clear.aspectRatio(1, contentMode: .fit) }
                ForEach(shown) { photo in
                    Thumb(photo: photo)
                        .onTapGesture { open = photo }
                        .onAppear { if photo == shown.first { Task { await gallery.more() } } }
                }
            }
            .padding(.top, topInset)
            .padding(.bottom, bottomInset)
        }
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .fullScreenCover(item: $open) { photo in
            Viewer(photos: shown, start: photo)
                .presentationBackground(.clear)
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
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(.white)
                        .shadow(radius: 2)
                        .padding(6)
                }
            }
            .clipped()
            .contentShape(.rect)
            .task(id: photo.id) { image = await ImageCache.shared.image(photo.url("thumb")) }
    }
}

// Full screen, swipe sideways for the next item, pull down to close. No buttons.
struct Viewer: View {
    let photos: [Photo]
    @State private var current: Photo?
    @State private var drag: CGSize = .zero
    @State private var chrome = true
    @Environment(\.dismiss) private var dismiss

    init(photos: [Photo], start: Photo) {
        self.photos = photos
        _current = State(initialValue: start)
    }

    private var progress: Double { min(max(drag.height / 300, 0), 1) }

    var body: some View {
        ZStack {
            Color.black.opacity(1 - progress).ignoresSafeArea()
            TabView(selection: $current) {
                ForEach(photos) { photo in
                    Page(photo: photo, active: current == photo)
                        .tag(Optional(photo))
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()
            .scaleEffect(1 - progress * 0.3)
            .offset(x: drag.width * 0.5, y: max(drag.height, 0))
        }
        .overlay(alignment: .top) {
            if chrome, let current, progress == 0 {
                VStack(spacing: 2) {
                    Text(formatTaken(current.takenAt)).font(.subheadline.weight(.semibold))
                    if let place = current.place { Text(place).font(.caption) }
                }
                .foregroundStyle(.white)
                .shadow(radius: 3)
                .padding(.top, 8)
            }
        }
        .onTapGesture { chrome.toggle() }
        .simultaneousGesture(
            DragGesture(minimumDistance: 20)
                .onChanged { value in
                    // Only a mostly downward pull closes; sideways swipes page.
                    if value.translation.height > abs(value.translation.width) || drag != .zero { drag = value.translation }
                }
                .onEnded { value in
                    if drag != .zero && (value.translation.height > 120 || value.predictedEndTranslation.height > 300) {
                        dismiss()
                    } else {
                        withAnimation(.spring(duration: 0.3)) { drag = .zero }
                    }
                }
        )
        .statusBarHidden(!chrome)
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

// Search like Photos: a field, results as you type, newest at the bottom.
struct SearchSheet: View {
    @State private var gallery = Gallery()
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        PhotoGrid(gallery: gallery, topInset: 8, bottomInset: 80)
            .overlay(alignment: .bottom) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("", text: $text)
                        .focused($focused)
                        .submitLabel(.search)
                        .autocorrectionDisabled()
                }
                .padding(.horizontal, 16)
                .frame(height: 48)
                .glassEffect(.regular.interactive(), in: .capsule)
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
            .task(id: text) {
                try? await Task.sleep(for: .milliseconds(250))
                gallery.query = text.trimmingCharacters(in: .whitespaces)
                if gallery.query.isEmpty { gallery.photos = []; return }
                await gallery.reload()
            }
            .onAppear { focused = true }
            .presentationDragIndicator(.visible)
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
