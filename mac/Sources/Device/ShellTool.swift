import Foundation
import Darwin

enum ShellTool {
    static let outputLimit = 20_000

    static func run(_ args: [String: Any]) async throws -> [String: Any] {
        guard let command = args["command"] as? String, !command.isEmpty, !command.contains("\0") else {
            throw CapError("command 必须是非空文字")
        }
        let timeout = (args["timeout"] as? NSNumber)?.doubleValue ?? 30
        guard timeout.isFinite, timeout > 0, timeout <= 300 else { throw CapError("timeout 必须大于 0 且不超过 300 秒") }
        let cwd = (args["cwd"] as? String).map { ($0 as NSString).expandingTildeInPath } ?? NSHomeDirectory()
        guard !cwd.contains("\0") else { throw CapError("cwd 不可包含空字符") }
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do { continuation.resume(returning: try execute(command, cwd: cwd, timeout: timeout)) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    private final class Capture {
        private(set) var bytes = Data()
        private(set) var overflow = false
        func drain(_ handle: FileHandle) {
            defer { try? handle.close() }
            // Drain both pipes even after the bound, so a noisy child never blocks on a full pipe.
            while let data = try? handle.read(upToCount: 8192), !data.isEmpty {
                let remaining = max(0, outputLimit * 4 + 4 - bytes.count)
                bytes.append(data.prefix(remaining))
                if data.count > remaining { overflow = true }
            }
        }
    }

    private final class Lifetime {
        let lock = NSLock()
        var finished = false
        var timedOut = false
    }

    private static func execute(_ command: String, cwd: String, timeout: Double) throws -> [String: Any] {
        let stdout = Pipe(), stderr = Pipe()
        var actions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw CapError("无法创建命令进程") }
        defer { posix_spawn_file_actions_destroy(&actions) }
        guard posix_spawnattr_init(&attributes) == 0 else { throw CapError("无法创建命令进程组") }
        defer { posix_spawnattr_destroy(&attributes) }
        var setup = posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP))
        if setup == 0 { setup = posix_spawnattr_setpgroup(&attributes, 0) }
        if setup == 0 { setup = posix_spawn_file_actions_addchdir_np(&actions, cwd) }
        if setup == 0 { setup = posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) }
        for (source, destination) in [(stdout.fileHandleForWriting.fileDescriptor, STDOUT_FILENO),
                                      (stderr.fileHandleForWriting.fileDescriptor, STDERR_FILENO)] {
            if setup == 0 { setup = posix_spawn_file_actions_adddup2(&actions, source, destination) }
        }
        for handle in [stdout.fileHandleForReading, stderr.fileHandleForReading, stdout.fileHandleForWriting, stderr.fileHandleForWriting] {
            if setup == 0 { setup = posix_spawn_file_actions_addclose(&actions, handle.fileDescriptor) }
        }
        guard setup == 0 else { throw CapError("无法配置命令进程：\(String(cString: strerror(setup)))") }
        let arguments: [String] = ["/bin/zsh", "-lc", command]
        let argv: [UnsafeMutablePointer<CChar>?] = arguments.map { $0.withCString { strdup($0) } } + [nil]
        defer { argv.forEach { if let pointer = $0 { free(pointer) } } }
        let environment: [UnsafeMutablePointer<CChar>?] = ProcessInfo.processInfo.environment.map {
            "\($0.key)=\($0.value)".withCString { strdup($0) }
        } + [nil]
        defer { environment.forEach { if let pointer = $0 { free(pointer) } } }
        var pid: pid_t = 0
        let error = argv.withUnsafeBufferPointer { buffer in
            environment.withUnsafeBufferPointer { env in
                posix_spawn(&pid, "/bin/zsh", &actions, &attributes,
                            UnsafeMutablePointer(mutating: buffer.baseAddress!), UnsafeMutablePointer(mutating: env.baseAddress!))
            }
        }
        try? stdout.fileHandleForWriting.close()
        try? stderr.fileHandleForWriting.close()
        guard error == 0 else { throw CapError("命令启动失败：\(String(cString: strerror(error)))") }
        let groupPID = pid
        let lifetime = Lifetime()
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
        timer.schedule(deadline: .now() + timeout)
        timer.setEventHandler {
            lifetime.lock.lock()
            defer { lifetime.lock.unlock() }
            if !lifetime.finished {
                lifetime.timedOut = true
                // The group is created atomically by posix_spawn, before zsh can launch descendants.
                _ = kill(-groupPID, SIGKILL)
            }
        }
        timer.resume()
        let out = Capture(), err = Capture(), readers = DispatchGroup()
        readers.enter()
        DispatchQueue.global().async { out.drain(stdout.fileHandleForReading); readers.leave() }
        readers.enter()
        DispatchQueue.global().async { err.drain(stderr.fileHandleForReading); readers.leave() }
        var status: Int32 = 0
        var waited: pid_t
        repeat { waited = waitpid(groupPID, &status, 0) } while waited == -1 && errno == EINTR
        // Keep the deadline alive even when zsh exits with descendants still holding a pipe.
        readers.wait()
        lifetime.lock.lock()
        lifetime.finished = true
        let timedOut = lifetime.timedOut
        lifetime.lock.unlock()
        timer.cancel()
        guard waited != -1 else { throw CapError("无法读取命令退出码") }
        let signal = status & 0x7f
        let exitCode = timedOut ? 124 : (signal == 0 ? (status >> 8) & 0xff : 128 + signal)
        let (outText, errText) = bounded(String(decoding: out.bytes, as: UTF8.self),
                                        String(decoding: err.bytes, as: UTF8.self),
                                        overflow: out.overflow || err.overflow)
        return ["stdout": outText, "stderr": errText, "exit": Int(exitCode)]
    }

    /// A combined character budget; reserve stderr space when both streams are long.
    static func bounded(_ stdout: String, _ stderr: String, overflow: Bool = false) -> (String, String) {
        guard overflow || stdout.count + stderr.count > outputLimit else { return (stdout, stderr) }
        let marker = "\n[输出已截断：最多 20000 字]"
        let budget = outputLimit - marker.count
        let stderrBudget = min(stderr.count, budget / 2)
        let stdoutBudget = min(stdout.count, budget - stderrBudget)
        let remaining = budget - stdoutBudget
        return (String(stdout.prefix(stdoutBudget)), String(stderr.prefix(remaining)) + marker)
    }
}
