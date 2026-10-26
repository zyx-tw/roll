import MapKit
import SwiftUI

nonisolated struct Camera: Decodable, Sendable {
    let make: String?
    let model: String?
    let lens: String?
    let iso: Double?
    let fNumber: Double?
    let exposure: Double?
    let focal: Double?
    let focal35: Double?
    let ev: Double?
    let fps: Double?
    let codec: String?
    let width: Int?
    let height: Int?
}

nonisolated struct Detail: Decodable, Sendable {
    let name: String
    let size: Int
    let lat: Double?
    let lon: Double?
    let camera: Camera
}

// What Photos shows under "i": when, the file, the camera, where. Nothing to edit.
struct InfoSheet: View {
    let photo: Photo
    @State private var detail: Detail?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(formatTaken(photo.takenAt))
                    .font(.headline)
                    .padding(16)
                    .block()
                if let detail {
                    card(detail)
                    if let lat = detail.lat, let lon = detail.lon { map(lat, lon) }
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .padding(20)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task {
            if let data = try? await Client.shared.send("/api/photos/\(photo.id)") {
                detail = try? JSONDecoder().decode(Detail.self, from: data)
            }
        }
    }

    private func card(_ d: Detail) -> some View {
        let c = d.camera
        return VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(d.name).font(.subheadline.weight(.semibold))
                if let device = [c.make, c.model].compactMap({ $0 }).joined(separator: " ").nilIfEmpty {
                    Text(device).font(.subheadline)
                }
                if let lens = lensLine(c) { Text(lens).font(.subheadline).foregroundStyle(.secondary) }
                Text(sizeLine(d)).font(.subheadline).foregroundStyle(.secondary)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            let numbers = settings(c)
            if !numbers.isEmpty {
                Divider()
                HStack(spacing: 0) {
                    ForEach(Array(numbers.enumerated()), id: \.offset) { index, value in
                        if index > 0 { Divider().frame(height: 20) }
                        Text(value).font(.footnote.monospacedDigit()).frame(maxWidth: .infinity)
                    }
                }
                .padding(.vertical, 12)
            }
        }
        .block()
    }

    private func map(_ lat: Double, _ lon: Double) -> some View {
        let spot = CLLocationCoordinate2D(latitude: lat, longitude: lon)
        return Map(initialPosition: .region(MKCoordinateRegion(center: spot, latitudinalMeters: 800, longitudinalMeters: 800))) {
            Marker("", coordinate: spot)
        }
        .frame(height: 220)
        .clipShape(.rect(cornerRadius: 16))
        .allowsHitTesting(false)
    }

    // "後置相機 26 mm ƒ1.6", from "iPhone Air back camera 5.96mm f/1.6".
    private func lensLine(_ c: Camera) -> String? {
        guard let lens = c.lens else { return nil }
        let side = lens.contains("front") ? "前置相機" : lens.contains("back") ? "後置相機" : lens
        var parts = [side]
        if let mm = c.focal35 { parts.append("\(Int(mm.rounded())) mm") }
        if let f = c.fNumber { parts.append("ƒ" + trim(f)) }
        return parts.joined(separator: " ")
    }

    // "12 MP • 4032 × 3024 • 2.1 MB", or for video "4K • 3840 × 2160 • 2 GB • 60 fps • HEVC".
    private func sizeLine(_ d: Detail) -> String {
        // The original's size from the server; the stored one is the preview's.
        let width = d.camera.width ?? photo.width
        let height = d.camera.height ?? photo.height
        let long = max(width, height)
        var parts: [String] = []
        if photo.isVideo {
            parts.append(long >= 3840 ? "4K" : long >= 1920 ? "HD" : "\(min(width, height))p")
        } else {
            parts.append("\(Int((Double(width * height) / 1_000_000).rounded())) MP")
        }
        parts.append("\(width) × \(height)")
        parts.append(ByteCountFormatter.string(fromByteCount: Int64(d.size), countStyle: .file))
        if let fps = d.camera.fps { parts.append("\(Int(fps.rounded())) fps") }
        if let codec = d.camera.codec { parts.append(codec) }
        return parts.joined(separator: " • ")
    }

    // ISO 80 | 26 mm | 0 ev | ƒ1.6 | 1/60 s
    private func settings(_ c: Camera) -> [String] {
        var out: [String] = []
        if let iso = c.iso { out.append("ISO \(Int(iso))") }
        if let mm = c.focal35 { out.append("\(Int(mm.rounded())) mm") }
        if let ev = c.ev { out.append("\(trim(ev)) ev") }
        if let f = c.fNumber { out.append("ƒ" + trim(f)) }
        if let t = c.exposure { out.append(t >= 1 ? "\(trim(t)) s" : "1/\(Int((1 / t).rounded())) s") }
        return out.count >= 3 ? out : []
    }

    private func trim(_ value: Double) -> String {
        value == value.rounded() ? "\(Int(value))" : String(format: "%.1f", value)
    }
}

extension View {
    // One info block: full width, the same fill and corners for every block.
    func block() -> some View {
        frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 16))
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
