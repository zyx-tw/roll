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

    func remove(_ photo: Photo) {
        photos.removeAll { $0.id == photo.id }
        if let total { self.total = total - 1 }
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
    // The top-most visible item while scrolled up from the bottom; nil at the bottom.
    var onScrolledUp: (Photo?) -> Void = { _ in }
    @State private var open: Photo?
    @State private var visible: [String] = []
    @State private var atBottom = true

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 3)

    private func report(_ shown: [Photo]) {
        guard !atBottom else { return onScrolledUp(nil) }
        let ids = Set(visible)
        onScrolledUp(shown.first { ids.contains($0.id) })
    }

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
            .scrollTargetLayout()
            .padding(.top, topInset)
            .padding(.bottom, bottomInset)
        }
        .onScrollTargetVisibilityChange(idType: String.self, threshold: 0.3) { ids in
            visible = ids
            report(shown)
        }
        .onScrollGeometryChange(for: Bool.self) { geo in
            geo.contentOffset.y + geo.containerSize.height >= geo.contentSize.height + geo.contentInsets.bottom - 200
        } action: { _, bottom in
            atBottom = bottom
            report(shown)
        }
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .fullScreenCover(item: $open) { photo in
            Viewer(gallery: gallery, start: photo)
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

// Full screen, swipe sideways for the next item, pull down to close, tap to
// hide the bar. The bar: when it was taken on the left, delete on the right.
struct Viewer: View {
    let gallery: Gallery
    @State private var current: Photo?
    @State private var drag: CGSize = .zero
    @State private var chrome = true
    @State private var confirming = false
    @State private var info: Photo?
    @Environment(\.dismiss) private var dismiss

    init(gallery: Gallery, start: Photo) {
        self.gallery = gallery
        _current = State(initialValue: start)
    }

    private var photos: [Photo] { gallery.photos.reversed() }
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
        .overlay(alignment: .bottom) {
            if chrome, let current, progress == 0 { bar(current) }
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
        .sheet(item: $info) { InfoSheet(photo: $0) }
        .confirmationDialog("刪除這個項目？", isPresented: $confirming, titleVisibility: .visible) {
            Button("刪除", role: .destructive) { Task { await delete() } }
        }
    }

    private func bar(_ photo: Photo) -> some View {
        HStack {
            // Tap the date for the details.
            Button { info = photo } label: {
                VStack(spacing: 0) {
                    Text(relativeDay(photo.takenAt)).font(.subheadline.weight(.semibold))
                    Text(clockTime(photo.takenAt)).font(.caption.weight(.medium)).monospacedDigit()
                }
                .padding(.horizontal, 22)
                .frame(height: 52)
            }
            .glassEffect(.regular.interactive(), in: .capsule)
            Spacer()
            Button { confirming = true } label: {
                Image(systemName: "trash").font(.title3).frame(width: 52, height: 52)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .accessibilityLabel("刪除")
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 20)
        .padding(.bottom, 4)
    }

    // Moves the item to the trash on the server, then shows the next one.
    private func delete() async {
        guard let photo = current else { return }
        do {
            _ = try await Client.shared.send("/api/photos/\(photo.id)", method: "DELETE")
        } catch {
            return
        }
        let list = photos
        let index = list.firstIndex(of: photo) ?? 0
        gallery.remove(photo)
        let rest = photos
        if rest.isEmpty { return dismiss() }
        current = rest[min(index, rest.count - 1)]
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

private let taipei = TimeZone(identifier: "Asia/Taipei")!

// As Photos says it: 今天, 昨天, 星期三 within the week, else 2026 年 10 月 25 日.
func relativeDay(_ ms: Double) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = taipei
    let date = Date(timeIntervalSince1970: ms / 1000)
    let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: Date())).day ?? 99
    if days == 0 { return "今天" }
    if days == 1 { return "昨天" }
    if days > 1 && days < 7 { return "星期" + ["日", "一", "二", "三", "四", "五", "六"][calendar.component(.weekday, from: date) - 1] }
    return formatDay(ms)
}

// "上午 11:09".
func clockTime(_ ms: Double) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = taipei
    let c = calendar.dateComponents([.hour, .minute], from: Date(timeIntervalSince1970: ms / 1000))
    let hour = c.hour ?? 0
    let twelve = hour % 12 == 0 ? 12 : hour % 12
    return (hour < 12 ? "上午 " : "下午 ") + "\(twelve):" + String(format: "%02d", c.minute ?? 0)
}

// "2026 年 10 月 25 日", the day a photo was taken, in Taiwan time.
func formatDay(_ ms: Double) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Asia/Taipei")!
    let c = calendar.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: ms / 1000))
    return "\(c.year!) 年 \(c.month!) 月 \(c.day!) 日"
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
