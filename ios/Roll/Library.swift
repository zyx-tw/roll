import Photos

// What one library item uploads: the original files, untouched. A Live Photo
// sends its photo and its video under the same name, which roll pairs up.
enum Library {
    static func authorize() async -> Bool {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        return status == .authorized || status == .limited
    }

    static func assets(_ identifiers: [String]) -> [String: PHAsset] {
        var found: [String: PHAsset] = [:]
        PHAsset.fetchAssets(withLocalIdentifiers: identifiers, options: nil).enumerateObjects { asset, _, _ in
            found[asset.localIdentifier] = asset
        }
        return found
    }

    static func originals(of asset: PHAsset) -> [PHAssetResource] {
        let resources = PHAssetResource.assetResources(for: asset)
        let wanted: [PHAssetResourceType] = asset.mediaType == .video ? [.video] : [.photo, .alternatePhoto, .pairedVideo]
        return resources.filter { wanted.contains($0.type) }
    }

    // Copies a resource to a temporary file, fetching it from iCloud if needed.
    nonisolated static func export(_ resource: PHAssetResource, progress: @Sendable @escaping (Double) -> Void) async throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appending(path: resource.originalFilename)
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        options.progressHandler = { progress($0) }
        try await PHAssetResourceManager.default().writeData(for: resource, toFile: file, options: options)
        return file
    }
}
