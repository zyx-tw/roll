import AVKit
import SwiftUI

// Newest first from the server; shown oldest at the top, newest at the bottom.
@Observable
final class Gallery {
    // Only this album's photos, when set.
    let album: String?
    var photos: [Photo] = []
    var total: Int?
    var query = ""
    private var next: String?
    private var loading = false
    // Bumped by each reload, so a page asked for before it is dropped.
    private var generation = 0

    init(album: String? = nil) {
        self.album = album
    }

    // Replaces the list only once the first page is in, so a refresh never blanks the grid.
    func reload() async {
        generation += 1
        let mine = generation
        guard let page = try? await Client.shared.photos(after: nil, query: query, album: album), mine == generation else { return }
        photos = page.items
        next = page.next
        total = page.total
    }

    func more() async {
        guard !loading, let cursor = next else { return }
        loading = true
        defer { loading = false }
        let mine = generation
        guard let page = try? await Client.shared.photos(after: cursor, query: query, album: album), mine == generation else { return }
        let have = Set(photos.map(\.id))
        photos.append(contentsOf: page.items.filter { !have.contains($0.id) })
        next = page.next
    }

    // A new title or description, from the info sheet.
    func note(_ id: String, title: String, note: String) {
        guard let index = photos.firstIndex(where: { $0.id == id }) else { return }
        photos[index].title = title
        photos[index].note = note
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
    // The picked ids while choosing items; nil when tapping opens the viewer.
    var selection: Binding<Set<String>?> = .constant(nil)
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
                        .overlay(alignment: .bottomTrailing) {
                            if let picked = selection.wrappedValue { Check(on: picked.contains(photo.id)) }
                        }
                        .onTapGesture {
                            guard var picked = selection.wrappedValue else { return open = photo }
                            if picked.remove(photo.id) == nil { picked.insert(photo.id) }
                            selection.wrappedValue = picked
                        }
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

// The tick on a picked thumbnail, as in Photos.
struct Check: View {
    let on: Bool

    var body: some View {
        ZStack {
            if on {
                Color.white.opacity(0.25)
                Image(systemName: "checkmark.circle.fill")
                    .font(.title3)
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .blue)
                    .padding(6)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            }
        }
        .allowsHitTesting(false)
    }
}

// The bar while choosing: add to an album, remove from this album, delete.
struct SelectionBar: View {
    let gallery: Gallery
    @Binding var selection: Set<String>?
    @State private var picking: PickedIds?
    @State private var confirming = false
    @State private var working = false

    private var ids: [String] { gallery.photos.map(\.id).filter { selection?.contains($0) ?? false } }

    var body: some View {
        let count = ids.count
        HStack(spacing: 12) {
            Button { picking = PickedIds(ids: ids) } label: {
                Image(systemName: "rectangle.stack.badge.plus").font(.title3).frame(width: 52, height: 52)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .accessibilityLabel("加入相簿")
            Spacer(minLength: 0)
            Group {
                if working { ProgressView() } else { Text(count == 0 ? "選擇項目" : "已選取 \(count) 項").monospacedDigit() }
            }
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 20)
            .frame(height: 52)
            .glassEffect(.regular, in: .capsule)
            Spacer(minLength: 0)
            if let album = gallery.album {
                Button { Task { await removeFromAlbum(album) } } label: {
                    Image(systemName: "rectangle.stack.badge.minus").font(.title3).frame(width: 52, height: 52)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel("從這個相簿移除")
            }
            Button { confirming = true } label: {
                Image(systemName: "trash").font(.title3).frame(width: 52, height: 52)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .accessibilityLabel("刪除")
        }
        .disabled(count == 0 || working)
        .padding(.horizontal, 20)
        .padding(.bottom, 4)
        .sheet(item: $picking) { picked in
            AlbumPicker(photoIds: picked.ids) { selection = nil }
        }
        .confirmationDialog("刪除 \(count) 個項目？", isPresented: $confirming, titleVisibility: .visible) {
            Button("刪除", role: .destructive) { Task { await delete() } }
        }
    }

    private func removeFromAlbum(_ album: String) async {
        let picked = ids
        working = true
        defer { working = false }
        guard (try? await Client.shared.changeAlbum(album, remove: picked)) != nil else { return }
        for photo in gallery.photos where picked.contains(photo.id) { gallery.remove(photo) }
        selection = nil
    }

    // One at a time: each moves to the trash on the server.
    private func delete() async {
        working = true
        defer { working = false }
        for photo in gallery.photos where ids.contains(photo.id) {
            if (try? await Client.shared.send("/api/photos/\(photo.id)", method: "DELETE")) != nil { gallery.remove(photo) }
        }
        selection = nil
    }
}

struct PickedIds: Identifiable {
    let ids: [String]
    var id: String { ids.joined(separator: ",") }
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
// hide the controls. As in Photos: back and the album menu at the top, with
// the title or the date between them; the strip of thumbnails, share and
// delete at the bottom.
struct Viewer: View {
    let gallery: Gallery
    // By id: a new title changes the photo, not which one is shown.
    @State private var currentId: String?
    @State private var drag: CGSize = .zero
    @State private var chrome = true
    @State private var confirming = false
    @State private var info: Photo?
    @State private var sharing: SharedFile?
    @State private var picking: Photo?
    @State private var preparing = false
    @Environment(\.dismiss) private var dismiss

    init(gallery: Gallery, start: Photo) {
        self.gallery = gallery
        _currentId = State(initialValue: start.id)
    }

    private var photos: [Photo] { gallery.photos.reversed() }
    private var current: Photo? { photos.first { $0.id == currentId } }
    private var progress: Double { min(max(drag.height / 300, 0), 1) }

    var body: some View {
        ZStack {
            Color.black.opacity(1 - progress).ignoresSafeArea()
            TabView(selection: $currentId) {
                ForEach(photos) { photo in
                    Page(photo: photo, active: currentId == photo.id)
                        .tag(Optional(photo.id))
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()
            .scaleEffect(1 - progress * 0.3)
            .offset(x: drag.width * 0.5, y: max(drag.height, 0))
        }
        .overlay(alignment: .top) {
            if chrome, let current, progress == 0 { top(current) }
        }
        .overlay(alignment: .bottom) {
            if chrome, let current, progress == 0 {
                VStack(spacing: 16) {
                    Strip(photos: photos, currentId: $currentId)
                    bottom(current)
                }
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
        .sheet(item: $info) { photo in
            InfoSheet(photo: photo) { title, note in gallery.note(photo.id, title: title, note: note) }
        }
        .sheet(item: $sharing, onDismiss: { sharing.map { try? FileManager.default.removeItem(at: $0.url.deletingLastPathComponent()) } }) {
            ShareSheet(url: $0.url).ignoresSafeArea()
        }
        .sheet(item: $picking) { AlbumPicker(photoIds: [$0.id]) }
        .confirmationDialog("刪除這個項目？", isPresented: $confirming, titleVisibility: .visible) {
            Button("刪除", role: .destructive) { Task { await delete() } }
        }
    }

    private func top(_ photo: Photo) -> some View {
        HStack(spacing: 12) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left").font(.title3.weight(.semibold)).frame(width: 52, height: 52)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .accessibilityLabel("返回")
            Spacer(minLength: 0)
            // Tap for the details, where the title and description are edited.
            Button { info = photo } label: {
                VStack(spacing: 0) {
                    Text(heading(photo).0).font(.subheadline.weight(.semibold))
                    Text(heading(photo).1).font(.caption.weight(.medium)).monospacedDigit()
                }
                .lineLimit(1)
                .padding(.horizontal, 22)
                .frame(height: 52)
            }
            .glassEffect(.regular.interactive(), in: .capsule)
            Spacer(minLength: 0)
            Menu {
                Button("加入相簿", systemImage: "rectangle.stack.badge.plus") { picking = photo }
                if let album = gallery.album {
                    Button("從這個相簿移除", systemImage: "rectangle.stack.badge.minus", role: .destructive) {
                        Task {
                            if (try? await Client.shared.changeAlbum(album, remove: [photo.id])) != nil { drop(photo) }
                        }
                    }
                }
            } label: {
                Image(systemName: "ellipsis").font(.title3.weight(.semibold)).frame(width: 52, height: 52)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .accessibilityLabel("更多")
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 20)
    }

    // Title and description; title and time; the date and description; or the date and time.
    private func heading(_ photo: Photo) -> (String, String) {
        let title = photo.title ?? ""
        let note = photo.note ?? ""
        let day = relativeDay(photo.takenAt)
        let time = clockTime(photo.takenAt)
        switch (title.isEmpty, note.isEmpty) {
        case (false, false): return (title, note)
        case (false, true): return (title, "\(day) \(time)")
        case (true, false): return (day, note)
        case (true, true): return (day, time)
        }
    }

    private func bottom(_ photo: Photo) -> some View {
        HStack {
            Button { Task { await share(photo) } } label: {
                Group {
                    if preparing { ProgressView().tint(.white) } else { Image(systemName: "square.and.arrow.up").font(.title3) }
                }
                .frame(width: 52, height: 52)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .disabled(preparing)
            .accessibilityLabel("分享")
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

    // Shares the original file, fetched first.
    private func share(_ photo: Photo) async {
        preparing = true
        defer { preparing = false }
        if let url = try? await Client.shared.original(photo) { sharing = SharedFile(url: url) }
    }

    // Moves the item to the trash on the server, then shows the next one.
    private func delete() async {
        guard let photo = current else { return }
        do {
            _ = try await Client.shared.send("/api/photos/\(photo.id)", method: "DELETE")
        } catch {
            return
        }
        drop(photo)
    }

    // Takes the item off this list and shows the next one.
    private func drop(_ photo: Photo) {
        let index = photos.firstIndex { $0.id == photo.id } ?? 0
        gallery.remove(photo)
        let rest = photos
        if rest.isEmpty { return dismiss() }
        currentId = rest[min(index, rest.count - 1)].id
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

// The thumbnails under the photo, as in Photos: the current one wider and
// centred, the strip following each swipe. Tap one to show it.
struct Strip: View {
    let photos: [Photo]
    @Binding var currentId: String?
    private let height: CGFloat = 44

    var body: some View {
        GeometryReader { geo in
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 2) {
                        ForEach(photos) { photo in
                            let active = photo.id == currentId
                            StripThumb(photo: photo)
                                .frame(width: active ? min(max(height * Double(photo.width) / Double(max(photo.height, 1)), height * 0.75), height * 1.8) : height * 0.68, height: height)
                                .clipShape(.rect(cornerRadius: 2))
                                .padding(.horizontal, active ? 6 : 0)
                                .id(photo.id)
                                .onTapGesture { currentId = photo.id }
                        }
                    }
                    .padding(.horizontal, geo.size.width / 2)
                }
                .onAppear { proxy.scrollTo(currentId, anchor: .center) }
                .onChange(of: currentId) { _, id in
                    withAnimation(.snappy(duration: 0.25)) { proxy.scrollTo(id, anchor: .center) }
                }
            }
        }
        .frame(height: height)
    }
}

struct StripThumb: View {
    let photo: Photo
    @State private var image: UIImage?

    var body: some View {
        Color.white.opacity(0.1)
            .overlay {
                if let image { Image(uiImage: image).resizable().scaledToFill() }
            }
            .clipped()
            .contentShape(.rect)
            .task(id: photo.id) { image = await ImageCache.shared.image(photo.url("thumb")) }
    }
}

struct SharedFile: Identifiable {
    let url: URL
    var id: URL { url }
}

struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
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
