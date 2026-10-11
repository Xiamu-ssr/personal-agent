import Foundation

@MainActor
enum TaskProtocolFixtures {
    static func run() async throws {
        var sent: [[String: Any]] = []
        let chat = ChatClient(sender: { sent.append($0); return true })
        chat.handle(["t": "status", "busy": true, "reason": "task_result"])
        try check(chat.replyStatus == "豆豆正在处理子任务结果…", "task_result status copy")
        try check(chat.send("排队一") && chat.send("排队二"), "sending while busy stays available")
        try check(chat.items.count == 2 && chat.items.allSatisfy(\.queued), "busy sends have queue bubbles")
        chat.handle(["t": "user", "text": "排队一", "source": "app"])
        chat.handle(["t": "user", "text": "排队二", "source": "app"])
        try check(chat.items.count == 2 && chat.items.allSatisfy { !$0.pending && $0.queued }, "echo acknowledges send without dequeueing")
        chat.handle(["t": "delta", "text": "子任务结果回复"])
        try await Task.sleep(nanoseconds: 300_000_000)
        try check(chat.streaming == "子任务结果回复", "native turn streams without preceding user")
        chat.handle(["t": "turn_end", "text": "子任务完成，结果已整理" ])
        try check(chat.busy && chat.items.last?.kind == .assistant, "turn_end is a result, not authoritative idle")
        chat.handle(["t": "status", "busy": false])
        chat.handle(["t": "status", "busy": true, "reason": "user"])
        try check(!chat.items[0].queued && chat.items[1].queued, "user dispatch activates exactly one FIFO message")
        chat.handle(["t": "status", "busy": false])
        chat.handle(["t": "turn_end", "text": "第一条完成"])
        try check(!chat.busy && chat.items.last?.text == "第一条完成", "idle before result keeps completed reply")
        chat.handle(["t": "status", "busy": true, "reason": "user"])
        try check(!chat.items[1].queued, "second queue entry activates at its user turn")
        chat.handle(["t": "delta", "text": "旧增量"])
        chat.handle(["t": "tool", "name": "Bash", "hint": ""])
        chat.handle(["t": "status", "busy": true, "reason": "task_result"])
        try check(chat.streaming.isEmpty && chat.toolHint.isEmpty, "native follow-up resets per-turn text and tool state")
        chat.handle(["t": "turn_end", "text": "自主回合" ])
        try check(chat.items.last?.text == "自主回合", "task_result final persists without user envelope")

        let first = ChatClient(sender: { _ in true })
        try check(first.send("同一段文字") && first.send("同一段文字"), "burst sends before first status")
        try check(!first.items[0].queued && first.items[1].queued, "first idle send reserves next dispatch")
        first.handle(["t": "user", "text": "同一段文字"])
        try check(!first.items[0].pending && first.items[1].pending, "identical echoes correlate oldest pending input")
        first.handle(["t": "user", "text": "同一段文字"])
        first.handle(["t": "status", "busy": true, "reason": "user"])
        try check(first.items[1].queued, "initial user status must not activate second queued input")

        FixtureProtocol.respond = { request in
            if request.url?.path.hasSuffix("/api/history") == true {
                Thread.sleep(forTimeInterval: 0.06)
                return (200, [:], try JSONSerialization.data(withJSONObject: ["items": [["role": "user", "text": "我的 HTTP 先到", "ts": Date().timeIntervalSince1970 * 1000]]]))
            }
            return (200, [:], Data(#"{"running":[]}"#.utf8))
        }
        let ownRace = ChatClient(sender: { _ in true })
        ownRace.handle(["t": "hello", "busy": false, "tasks": [], "history": []])
        try check(ownRace.send("我的 HTTP 先到"), "send during history refresh")
        try await Task.sleep(nanoseconds: 150_000_000)
        ownRace.handle(["t": "user", "text": "我的 HTTP 先到", "source": "app"])
        try check(ownRace.items.count == 1 && !ownRace.items[0].pending, "own pending echo stays correlated when history arrives first")
        ownRace.stop()

        let race = ChatClient(sender: { _ in true })
        let inFlight = ChatItem(kind: .user, text: "HTTP 比 WebSocket 快", ts: Date())
        race.items = [inFlight]
        race.rememberSnapshotEchoes(race.items)
        race.busy = true
        race.handle(["t": "user", "text": inFlight.text, "source": "app"])
        try check(race.items.count == 1 && race.items[0].queued, "HTTP history ahead of socket event reconciles once")
        race.handle(["t": "user", "text": inFlight.text, "source": "app"])
        try check(race.items.count == 2, "a second identical message remains distinct")
        race.stop()

        let alarm = "[定时] 该出「晨报」了\n\n按今天的安排生成简报"
        chat.handle(["t": "user", "source": "schedule", "text": alarm])
        try check(chat.items.last?.kind == .schedule && chat.items.last?.scheduleTitle == "晨报时间到了", "live alarm uses centered schedule presentation")
        let history = ChatClient.item(["role": "user", "source": "schedule", "text": alarm, "ts": 1000])
        try check(history?.kind == .schedule && history?.scheduleTitle == "晨报时间到了", "history alarm uses same schedule presentation")
        chat.handle(["t": "status", "busy": true, "reason": "schedule"])
        try check(chat.replyStatus == "豆豆正在安排定时任务…", "schedule status copy")

        let a: [String: Any] = ["id": "a", "description": "查询报告", "startedAt": 1000]
        let b: [String: Any] = ["id": "b", "description": "整理数据", "startedAt": 2000]
        chat.handle(["t": "task", "phase": "snapshot", "tasks": [a, b, a]])
        try check(chat.backgroundTasks.map(\.id) == ["a", "b"], "snapshot replaces list and deduplicates IDs")
        chat.handle(["t": "task", "phase": "started", "id": "a", "description": "新的描述", "startedAt": 1000, "background": true])
        chat.handle(["t": "task", "phase": "started", "id": "a", "description": "新的描述", "startedAt": 1000, "background": true])
        try check(chat.backgroundTasks.count == 2 && chat.backgroundTasks[0].description == "新的描述", "started is idempotent")
        chat.handle(["t": "task", "phase": "updated", "id": "b", "patch": ["description": "更新描述"], "background": true])
        chat.handle(["t": "task", "phase": "progress", "id": "b", "summary": "读到第三页", "background": true])
        try check(chat.backgroundTasks[1].description == "更新描述" && chat.backgroundTasks[1].summary == "读到第三页", "patch and progress update existing task")
        chat.stopTask("a"); chat.stopTask("a")
        try check(sent.filter { $0["t"] as? String == "stop_task" }.count == 1 && chat.stoppingTasks == ["a"], "stop request disables only that task and is idempotent")
        chat.handle(["t": "task_stop", "id": "a", "ok": true])
        chat.handle(["t": "task", "phase": "snapshot", "tasks": [a, b]])
        try check(chat.stoppingTasks == ["a"] && chat.backgroundTasks.count == 2, "stop accepted / unchanged snapshot must keep stopping row")
        chat.handle(["t": "task_stop", "id": "a", "ok": false, "code": "task_stop_failed", "error": "private detail should not be echoed"])
        try check(chat.stoppingTasks.isEmpty && chat.taskError == "停止任务失败，请稍后再试", "failed stop restores button with Chinese sanitized error")
        chat.stopTask("a")
        chat.handle(["t": "task", "phase": "notification", "id": "a", "status": "stopped", "background": true])
        chat.handle(["t": "task", "phase": "started", "id": "a", "description": "迟到的事件", "background": true])
        try check(chat.backgroundTasks.map(\.id) == ["b"] && chat.stoppingTasks.isEmpty, "terminal notification removes ID and late started cannot resurrect it")
        chat.handle(["t": "task", "phase": "updated", "id": "b", "patch": ["status": "killed"], "background": true])
        try check(chat.backgroundTasks.isEmpty, "terminal patch removes ID")
        chat.applyTasks([a, b]); chat.stopTask("a")
        chat.handle(["t": "task", "phase": "snapshot", "tasks": []])
        try check(chat.backgroundTasks.isEmpty && chat.stoppingTasks.isEmpty, "empty snapshot clears active and stopping tasks")
        chat.applyTasks([a]); chat.interrupt()
        try check(sent.last?["t"] as? String == "interrupt" && chat.backgroundTasks.count == 1, "interrupt stops only current reply")
        chat.handle(["t": "hello", "busy": false, "tasks": [b], "history": []])
        try check(!chat.busy && chat.busyReason.isEmpty && chat.backgroundTasks.map(\.id) == ["b"] && chat.stoppingTasks.isEmpty,
                  "hello authoritatively replaces busy and tasks after reconnect")
        chat.handle(["t": "hello", "busy": true, "tasks": [], "history": []])
        try check(chat.busy && chat.backgroundTasks.isEmpty, "busy hello with no tasks restores current reply only")
        chat.stop(); first.stop()
        let offline = ChatClient(sender: { _ in false })
        offline.applyTasks([a]); offline.stopTask("a")
        try check(offline.stoppingTasks.isEmpty && !offline.taskError.isEmpty, "disconnected stop restores button immediately")
        try check(!offline.send("不能丢草稿") && offline.items.isEmpty, "failed send creates no phantom queue bubble")
        print("PASS: task snapshots/edges/stops/reconnect, FIFO queued bubbles, alarms, native task-result turns and status authority")
    }
}
