import AVFoundation
import Observation

/// Records 16 kHz mono AAC (.m4a) for hold-to-talk and voice notes, with a live level meter.
@Observable
final class Recorder: NSObject {
    var recording = false
    var elapsed: TimeInterval = 0
    /// Recent input levels 0…1, newest last, for the waveform.
    var levels: [Float] = Array(repeating: 0, count: 36)

    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var file: URL?

    static let micDenied = "麦克风权限没给，去「系统设置 → 隐私与安全性 → 麦克风」打开豆豆"

    /// Ask for the microphone if needed; nil when allowed, otherwise why not.
    static func permit() async -> String? {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return nil
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio) ? nil : micDenied
        default: return micDenied
        }
    }

    func start() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("doudou-\(UUID().uuidString).m4a")
        let r = try AVAudioRecorder(url: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ])
        r.isMeteringEnabled = true
        guard r.record() else { throw CapError("录不了音，检查一下麦克风") }
        recorder = r
        file = url
        recording = true
        elapsed = 0
        levels = Array(repeating: 0, count: levels.count)
        timer = Timer.scheduledTimer(withTimeInterval: 0.06, repeats: true) { [weak self] _ in self?.tick() }
    }

    private func tick() {
        guard let r = recorder else { return }
        r.updateMeters()
        let db = r.averagePower(forChannel: 0)
        let level = max(0, min(1, (db + 50) / 50))
        levels.removeFirst()
        levels.append(level)
        elapsed = r.currentTime
    }

    /// Stop and hand back the audio (nil if nothing was recorded).
    func finish() -> (data: Data, seconds: TimeInterval)? {
        let seconds = recorder?.currentTime ?? 0
        recorder?.stop()
        defer { cleanup() }
        guard let file, let d = try? Data(contentsOf: file), !d.isEmpty else { return nil }
        return (d, seconds)
    }

    func cancel() {
        recorder?.stop()
        cleanup()
    }

    private func cleanup() {
        timer?.invalidate()
        timer = nil
        recorder = nil
        if let file { try? FileManager.default.removeItem(at: file) }
        file = nil
        recording = false
    }
}
