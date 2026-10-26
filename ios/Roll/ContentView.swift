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
                    Text(error).foregroundStyle(.red)
                }
            }
        case .signedIn:
            QueueView()
        }
    }
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
