import Photos
import PhotosUI
import SwiftUI

struct ContentView: View {
    @Environment(Account.self) private var account

    var body: some View {
        switch account.state {
        case .checking:
            ProgressView()
                .task { await account.refresh() }
        case .signedOut:
            VStack(spacing: 16) {
                Button("登入") { Task { await account.signIn() } }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                if let error = account.error {
                    Text(error).foregroundStyle(.red).font(.footnote).textSelection(.enabled).padding(.horizontal, 24)
                }
            }
        case .signedIn(full: true):
            LibraryView()
        case .signedIn(full: false):
            QueueView()
        }
    }
}

// The whole library like Photos: title and count top left, account top right,
// upload bottom left, search bottom right, newest at the bottom.
struct LibraryView: View {
    @Environment(Account.self) private var account
    @Environment(Uploader.self) private var uploader
    @State private var gallery = Gallery()
    @State private var picked: [PhotosPickerItem] = []
    @State private var scrolledTo: Photo?
    @State private var path: [Route] = []
    @State private var selection: Set<String>?

    // One path with every destination at the root: mixing isPresented and
    // value links on one stack pushed the album list again for each album.
    var body: some View {
        NavigationStack(path: $path) {
            grid
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .albums: AlbumsView()
                    case let .album(album): AlbumView(album: album)
                    }
                }
        }
    }

    private var grid: some View {
        PhotoGrid(gallery: gallery, topInset: 120, bottomInset: 96, onScrolledUp: { photo in
            if photo?.id != scrolledTo?.id { scrolledTo = photo }
        }, selection: $selection)
            .ignoresSafeArea(edges: [.top, .bottom])
            .refreshable { await gallery.reload() }
            .task { await gallery.reload() }
            .onChange(of: uploader.finished) { Task { await gallery.waitForPreviews() } }
            .overlay(alignment: .top) { header }
            .overlay(alignment: .bottom) {
                if selection != nil { SelectionBar(gallery: gallery, selection: $selection) } else { footer }
            }
            .onChange(of: picked) {
                let ids = picked.compactMap(\.itemIdentifier)
                picked = []
                Task { await uploader.add(ids) }
            }
    }

    private var header: some View {
        HStack(alignment: .top) {
            // At the bottom: the item count. Scrolled up: the date in view, as in Photos.
            VStack(alignment: .leading, spacing: 0) {
                if let photo = scrolledTo {
                    Text(formatDay(photo.takenAt)).font(.largeTitle.bold()).lineLimit(1).minimumScaleFactor(0.6)
                } else if let total = gallery.total {
                    Text("\(total.formatted()) 個項目").font(.largeTitle.bold())
                }
            }
            .animation(.easeInOut(duration: 0.2), value: scrolledTo?.id)
            Spacer()
            Button(selection == nil ? "選擇" : "取消") { selection = selection == nil ? [] : nil }
                .font(.body.weight(.semibold))
                .padding(.horizontal, 18)
                .frame(height: 44)
                .glassEffect(.regular.interactive(), in: .capsule)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 20)
        .padding(.bottom, 24)
        .background(alignment: .top) {
            LinearGradient(colors: [.black.opacity(0.55), .clear], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea(edges: .top)
                .allowsHitTesting(false)
        }
        .shadow(color: .black.opacity(0.25), radius: 4)
    }

    // Albums and the upload status on the left, the upload button on the right.
    private var footer: some View {
        HStack(alignment: .bottom) {
            Button { path = [.albums] } label: {
                Image(systemName: "rectangle.stack").font(.title2.weight(.medium)).frame(width: 56, height: 56)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .accessibilityLabel("相簿")
            if let summary = uploader.summary {
                Text(summary)
                    .font(.footnote.monospacedDigit())
                    .padding(.horizontal, 16)
                    .frame(height: 44)
                    .glassEffect(.regular, in: .capsule)
            }
            Spacer()
            PhotosPicker(selection: $picked, matching: .any(of: [.images, .videos]), preferredItemEncoding: .current, photoLibrary: .shared()) {
                Image(systemName: "plus").font(.title2.weight(.medium)).frame(width: 56, height: 56)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .accessibilityLabel("上傳")
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 20)
        .padding(.bottom, 4)
    }
}

enum Route: Hashable {
    case albums
    case album(Album)
}

struct QueueView: View {
    @Environment(Account.self) private var account
    @Environment(Uploader.self) private var uploader
    @State private var picked: [PhotosPickerItem] = []

    var body: some View {
        NavigationStack {
            List(uploader.items.reversed()) { item in
                ItemRow(item: item)
            }
            .listStyle(.plain)
            .safeAreaInset(edge: .bottom) {
                // Why this session cannot browse, until App Attest works here.
                if let reason = WebLogin.lastAttestError {
                    Text(reason).font(.footnote).foregroundStyle(.secondary).padding()
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        if uploader.items.contains(where: { if case .failed = $0.status { true } else { false } }) {
                            Button("重試失敗的項目", systemImage: "arrow.clockwise") { Task { await uploader.retry() } }
                        }
                        Button("登出", systemImage: "rectangle.portrait.and.arrow.right") { Task { await account.signOut() } }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    PhotosPicker(selection: $picked, matching: .any(of: [.images, .videos]), preferredItemEncoding: .current, photoLibrary: .shared()) {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("選擇照片")
                }
            }
            #if DEBUG
            // Simulator tests: `-rollUploadRecent <n>` sends the newest n items without the picker.
            .task {
                let count = UserDefaults.standard.integer(forKey: "rollUploadRecent")
                guard count > 0, await Library.authorize() else { return }
                let options = PHFetchOptions()
                options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
                options.fetchLimit = count
                var ids: [String] = []
                PHAsset.fetchAssets(with: options).enumerateObjects { asset, _, _ in ids.append(asset.localIdentifier) }
                await uploader.add(ids)
            }
            #endif
            .onChange(of: picked) {
                let ids = picked.compactMap(\.itemIdentifier)
                picked = []
                Task { await uploader.add(ids) }
            }
        }
    }
}

struct ItemRow: View {
    let item: Uploader.Item

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if let thumbnail = item.thumbnail {
                    Image(uiImage: thumbnail).resizable().scaledToFill()
                } else {
                    Color.secondary.opacity(0.2)
                }
            }
            .frame(width: 56, height: 56)
            .clipShape(.rect(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 6) {
                Text(label).font(.body).monospacedDigit()
                if let fraction {
                    ProgressView(value: fraction)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var label: String {
        switch item.status {
        case .waiting: "等待中"
        case let .fetching(f): "從 iCloud 下載 \(Int(f * 100))%"
        case let .uploading(f): "上傳中 \(Int(f * 100))%"
        case .done: "已上傳"
        case let .failed(reason): reason
        }
    }

    private var fraction: Double? {
        switch item.status {
        case let .fetching(f), let .uploading(f): f
        default: nil
        }
    }
}
