import SwiftUI

nonisolated struct Album: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    let count: Int
    let cover: Photo?
}

extension Client {
    func albums() async throws -> [Album] {
        struct List: Decodable { let albums: [Album] }
        return try JSONDecoder().decode(List.self, from: try await send("/api/albums")).albums
    }

    func createAlbum(_ name: String) async throws -> Album {
        try JSONDecoder().decode(Album.self, from: try await send("/api/albums", method: "POST", json: ["name": name]))
    }

    func renameAlbum(_ id: String, to name: String) async throws {
        _ = try await send("/api/albums/\(id)", method: "PATCH", json: ["name": name])
    }

    func deleteAlbum(_ id: String) async throws {
        _ = try await send("/api/albums/\(id)", method: "DELETE")
    }

    func changeAlbum(_ id: String, add: [String] = [], remove: [String] = []) async throws {
        _ = try await send("/api/albums/\(id)/photos", method: "POST", json: ["add": add, "remove": remove])
    }
}

// Every album as a grid of covers, newest first, as in Photos. + makes one;
// hold an album to rename or delete it. Pushed from the library, so the edge
// swipe goes back.
struct AlbumsView: View {
    @State private var albums: [Album]?
    @State private var naming: Naming?
    @State private var deleting: Album?
    @State private var failure: String?

    private let columns = [GridItem(.flexible(), spacing: 16), GridItem(.flexible(), spacing: 16)]

    var body: some View {
            ScrollView {
                if let albums, albums.isEmpty {
                    ContentUnavailableView("沒有相簿", systemImage: "rectangle.stack")
                        .padding(.top, 120)
                } else {
                    LazyVGrid(columns: columns, spacing: 20) {
                        ForEach(albums ?? []) { album in
                            NavigationLink(value: Route.album(album)) { AlbumCell(album: album) }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button("重新命名", systemImage: "pencil") { naming = Naming(album: album, text: album.name) }
                                    Button("刪除相簿", systemImage: "trash", role: .destructive) { deleting = album }
                                }
                        }
                    }
                    .padding(20)
                }
            }
            .navigationTitle("相簿")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("新增相簿", systemImage: "plus") { naming = Naming(album: nil, text: "") }
                }
            }
            .task { await load() }
            .refreshable { await load() }
            .nameAlert($naming) { naming, text in
                do {
                    if let album = naming.album {
                        try await Client.shared.renameAlbum(album.id, to: text)
                    } else {
                        _ = try await Client.shared.createAlbum(text)
                    }
                } catch {
                    failure = albumFailure(error)
                }
                await load()
            }
            .deleteAlbumDialog($deleting, failure: $failure) { await load() }
            .failureAlert($failure)
    }

    private func load() async {
        if let list = try? await Client.shared.albums() { albums = list }
    }
}

struct AlbumCell: View {
    let album: Album

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Color.secondary.opacity(0.15)
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    if let cover = album.cover {
                        Thumb(photo: cover)
                    } else {
                        Image(systemName: "photo.on.rectangle").font(.largeTitle).foregroundStyle(.tertiary)
                    }
                }
                .clipShape(.rect(cornerRadius: 12))
            Text(album.name).font(.subheadline.weight(.semibold)).lineLimit(1)
            Text("\(album.count.formatted())").font(.subheadline).foregroundStyle(.secondary).monospacedDigit()
        }
    }
}

// One album's photos, the same grid and viewer as the library.
struct AlbumView: View {
    @State var album: Album
    @State private var gallery: Gallery
    @State private var naming: Naming?
    @State private var deleting: Album?
    @State private var selection: Set<String>?
    @State private var failure: String?
    @Environment(\.dismiss) private var dismiss

    init(album: Album) {
        _album = State(initialValue: album)
        _gallery = State(initialValue: Gallery(album: album.id))
    }

    var body: some View {
        PhotoGrid(gallery: gallery, bottomInset: selection == nil ? 0 : 72, selection: $selection)
            .overlay(alignment: .bottom) {
                if selection != nil { SelectionBar(gallery: gallery, selection: $selection) }
            }
            .overlay {
                if gallery.total == 0 { ContentUnavailableView("沒有照片", systemImage: "photo", description: Text("在照片的「…」選單加入這個相簿")) }
            }
            .navigationTitle(album.name)
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(selection != nil)
            .task { await gallery.reload() }
            .refreshable { await gallery.reload() }
            .toolbar {
                if selection == nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("選擇") { selection = [] }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button("重新命名", systemImage: "pencil") { naming = Naming(album: album, text: album.name) }
                            Button("刪除相簿", systemImage: "trash", role: .destructive) { deleting = album }
                        } label: {
                            Image(systemName: "ellipsis")
                        }
                    }
                } else {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("取消") { selection = nil }
                    }
                }
            }
            .nameAlert($naming) { _, text in
                do {
                    try await Client.shared.renameAlbum(album.id, to: text)
                    album.name = text
                } catch {
                    failure = albumFailure(error)
                }
            }
            .deleteAlbumDialog($deleting, failure: $failure) { dismiss() }
            .failureAlert($failure)
    }
}

// Picks an album for the photos, or makes a new one with them.
struct AlbumPicker: View {
    let photoIds: [String]
    var onAdded: () -> Void = {}
    @State private var albums: [Album]?
    @State private var naming: Naming?
    @State private var failure: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Button { naming = Naming(album: nil, text: "") } label: {
                    Label("新增相簿", systemImage: "plus")
                }
                ForEach(albums ?? []) { album in
                    Button { Task { await add(to: album.id) } } label: {
                        HStack(spacing: 12) {
                            Color.secondary.opacity(0.15)
                                .frame(width: 52, height: 52)
                                .overlay { if let cover = album.cover { Thumb(photo: cover) } }
                                .clipShape(.rect(cornerRadius: 8))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(album.name).foregroundStyle(.primary)
                                Text("\(album.count.formatted())").font(.subheadline).foregroundStyle(.secondary).monospacedDigit()
                            }
                        }
                    }
                }
            }
            .navigationTitle("加入相簿")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("取消") { dismiss() } }
            }
            .task { albums = try? await Client.shared.albums() }
            .nameAlert($naming) { _, text in
                do {
                    await add(to: try await Client.shared.createAlbum(text).id)
                } catch {
                    failure = albumFailure(error)
                }
            }
            .failureAlert($failure)
        }
    }

    private func add(to id: String) async {
        do {
            try await Client.shared.changeAlbum(id, add: photoIds)
            onAdded()
            dismiss()
        } catch {
            failure = albumFailure(error)
        }
    }
}

// The album being named: nil for a new one.
struct Naming: Identifiable {
    let album: Album?
    var text: String
    var id: String { album?.id ?? "new" }
}

extension View {
    // One text field for a new album or a new name.
    func nameAlert(_ naming: Binding<Naming?>, save: @escaping (Naming, String) async -> Void) -> some View {
        alert(naming.wrappedValue?.album == nil ? "新增相簿" : "重新命名", isPresented: Binding(get: { naming.wrappedValue != nil }, set: { if !$0 { naming.wrappedValue = nil } })) {
            TextField("名稱", text: Binding(get: { naming.wrappedValue?.text ?? "" }, set: { naming.wrappedValue?.text = $0 }))
            Button("取消", role: .cancel) {}
            Button("儲存") {
                guard let current = naming.wrappedValue else { return }
                let text = current.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return }
                Task { await save(current, String(text.prefix(100))) }
            }
        }
    }

    // Deleting an album keeps its photos.
    func deleteAlbumDialog(_ album: Binding<Album?>, failure: Binding<String?>, done: @escaping () async -> Void) -> some View {
        confirmationDialog("刪除「\(album.wrappedValue?.name ?? "")」？", isPresented: Binding(get: { album.wrappedValue != nil }, set: { if !$0 { album.wrappedValue = nil } }), titleVisibility: .visible, presenting: album.wrappedValue) { target in
            Button("刪除相簿", role: .destructive) {
                Task {
                    do {
                        try await Client.shared.deleteAlbum(target.id)
                        await done()
                    } catch {
                        failure.wrappedValue = albumFailure(error)
                    }
                }
            }
        } message: { _ in
            Text("照片會留在圖庫。")
        }
    }

    // Says why an album change did not go through.
    func failureAlert(_ failure: Binding<String?>) -> some View {
        alert(failure.wrappedValue ?? "", isPresented: Binding(get: { failure.wrappedValue != nil }, set: { if !$0 { failure.wrappedValue = nil } })) {
            Button("好", role: .cancel) {}
        }
    }
}

// 409 is the one the user can fix: the name is in use.
func albumFailure(_ error: Error) -> String {
    (error as? APIError)?.status == 409 ? "已經有同名的相簿" : "沒有成功，請再試一次"
}
