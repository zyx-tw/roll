import Foundation

nonisolated private let chunkSize = 8 * 1024 * 1024
nonisolated private let maxTries = 12

extension Client {
    // Sends a file in chunks. A dropped connection resumes from the last chunk
    // the server has; a server restart starts the file again.
    func upload(file: URL, name: String, modified: Date?, progress: @Sendable @escaping (Double) -> Void) async throws -> String {
        let size = try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int ?? 0
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }

        func begin() async throws -> String {
            var input: [String: Any] = ["name": name, "size": size]
            if let modified { input["modified"] = Int(modified.timeIntervalSince1970 * 1000) }
            let data = try await send("/api/upload", method: "POST", json: input)
            guard let id = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["id"] as? String else { throw APIError(status: 0) }
            return id
        }

        var id = try await begin()
        var received = 0
        var tries = 0
        while true {
            try Task.checkCancellation()
            do {
                try handle.seek(toOffset: UInt64(received))
                let chunk = try handle.read(upToCount: chunkSize) ?? Data()
                let data = try await send("/api/upload/\(id)?offset=\(received)", method: "PUT", body: chunk)
                let result = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                received = result?["received"] as? Int ?? received + chunk.count
                tries = 0
                progress(size > 0 ? Double(received) / Double(size) : 1)
                if let landed = result?["name"] as? String { return landed }
            } catch let error as APIError where error.status == 409 && error.received != nil {
                received = error.received!
            } catch let error as APIError where error.status == 404 {
                tries += 1
                if tries > maxTries { throw error }
                id = try await begin()
                received = 0
            } catch {
                let status = (error as? APIError)?.status ?? 0
                let retryable = error is URLError || [0, 408, 409, 429].contains(status) || status >= 500
                tries += 1
                if !retryable || tries > maxTries {
                    _ = try? await send("/api/upload/\(id)", method: "DELETE")
                    throw error
                }
                try await Task.sleep(for: .seconds(min(pow(2, Double(tries)), 30)))
                if let data = try? await send("/api/upload/\(id)"),
                   let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    received = state["received"] as? Int ?? received
                    if let landed = state["name"] as? String { return landed }
                }
            }
        }
    }
}
