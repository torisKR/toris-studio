package com.toris.studio.remote

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

internal data class MacAddress(val host: String, val port: Int, val fingerprint: String)
internal data class Project(val id: String, val name: String)
internal data class FactoryInput(val brief: String, val kind: String, val view: String?, val orientation: String?) {
    fun json(): JSONObject {
        val clean = brief.trim()
        require(clean.codePointCount(0, clean.length) <= 2000) { "요청은 2,000자 이하여야 합니다." }
        require(clean.none { it.isISOControl() && it !in "\n\r\t" } && !clean.contains("$(") &&
            !clean.contains("sk-ant-") && !clean.contains("sk-or-")) { "요청에 명령이나 비밀값을 넣을 수 없습니다." }
        require(kind in setOf("game", "app")) { "작업 종류를 확인하세요." }
        require(view == null || view in setOf("2d", "3d", "ui")) { "화면 종류를 확인하세요." }
        require(orientation == null || orientation in setOf("landscape", "portrait")) { "화면 방향을 확인하세요." }
        return JSONObject().put("kind", kind).apply {
            if (clean.isNotEmpty()) put("brief", clean)
            if (view != null) put("view", view)
            if (orientation != null) put("orientation", orientation)
        }
    }
}

internal data class Preview(
    val template: Boolean?, val kind: String?, val view: String?, val orientation: String?,
    val genre: String?, val features: List<String>, val maxApiCostUsd: Double?,
)
internal data class Gate(val name: String, val status: String, val required: Boolean)
internal data class Job(val id: String, val status: String, val reason: String? = null)
internal data class RunActivity(val sequence: Long, val phase: String?, val at: String?, val stages: List<String>)
internal data class RunSnapshot(
    val runId: String, val phase: String?, val sequence: Long, val approvals: List<String>,
    val verdict: String?, val template: Boolean?, val gates: List<Gate>,
    val jobs: List<Job> = emptyList(), val projectName: String? = null, val kind: String? = null,
    val genre: String? = null, val view: String? = null, val orientation: String? = null,
    val costUsd: Double? = null, val createdAt: String? = null, val updatedAt: String? = null,
    val stale: Boolean = false, val activity: List<RunActivity> = emptyList(), val interrupted: Boolean = false,
    val title: String? = null,
) {
    val terminal get() = phase in setOf("done", "failed", "cancelled")
}
internal data class RunPage(val runs: List<RunSnapshot>, val nextOffset: Int?)

internal open class RemoteError(message: String) : Exception(message)
/** The Mac answered with an error envelope: the request was received and refused, not lost. */
internal class RemoteRejection(message: String) : RemoteError(message)

internal data class ChatConversation(
    val threadId: String, val projectName: String, val title: String, val agent: String?, val mode: String?,
    val status: String, val lastActivity: String?, val preview: String?,
)
internal data class ChatMessage(
    val id: String, val kind: String, val text: String, val planner: String?, val at: String?, val answered: Boolean?,
)
internal data class ChatPage(
    val conversations: List<ChatConversation>, val nextOffset: Int?, val canReply: Boolean,
    val running: Int, val needsInput: Int,
)
internal data class ChatDetail(
    val conversation: ChatConversation, val messages: List<ChatMessage>, val truncated: Boolean, val canReply: Boolean,
)
internal data class ChatReplyResult(val conversation: ChatConversation, val duplicate: Boolean)
internal data class PendingReply(val requestId: String, val threadId: String, val text: String)

internal object Protocol {
    private fun request(method: String) = JSONObject().put("method", method)
    fun begin(token: String, name: String, key: String) = request("enroll.begin")
        .put("token", token).put("name", name).put("publicKey", key)
    fun poll() = request("enroll.poll")
    fun projects() = request("projects.list")
    fun runs(offset: Int) = request("factory.list").put("offset", offset.also {
        require(it in 0..4096) { "작업 목록 위치를 확인하세요." }
    })
    fun preview(project: String, input: FactoryInput) = request("factory.preview")
        .put("projectId", uuid(project)).put("input", input.json())
    fun start(project: String, requestId: String, input: FactoryInput) = request("factory.start")
        .put("projectId", uuid(project)).put("requestId", uuidV4(requestId)).put("input", input.json())
    fun recover(requestId: String) = request("factory.recover").put("requestId", uuidV4(requestId))
    fun status(runId: String) = request("factory.status").put("runId", uuid(runId))
    fun cancel(runId: String) = request("factory.cancel").put("runId", uuid(runId))
    fun chatList(offset: Int, needsInput: Boolean) = request("chat.list").put("offset", offset.also {
        require(it in 0..4096) { "대화 목록 위치를 확인하세요." }
    }).put("needsInput", needsInput)
    fun chatDetail(threadId: String) = request("chat.detail").put("threadId", threadId(threadId))
    fun chatReply(threadId: String, requestId: String, text: String) = request("chat.reply")
        .put("threadId", threadId(threadId)).put("requestId", uuidV4(requestId)).put("text", replyText(text))

    private val threadPattern = Regex("[A-Za-z0-9-]{1,64}")
    fun threadId(value: String): String =
        value.takeIf { it.matches(threadPattern) } ?: throw RemoteError("대화 식별자를 확인하세요.")
    /** The phone sends only plain text: trimmed, 1..2,000 code points and at most 6,000 UTF-8 bytes, no control characters except line breaks and tabs. */
    fun replyText(value: String): String {
        val clean = value.trim()
        require(clean.isNotEmpty()) { "답장 내용을 입력하세요." }
        require(clean.codePointCount(0, clean.length) <= 2000 && clean.toByteArray(Charsets.UTF_8).size <= 6000) {
            "답장은 2,000자(6KB) 이하로 줄이세요."
        }
        require(clean.none { it.isISOControl() && it !in "\n\r\t" }) { "답장에 제어 문자를 넣을 수 없습니다." }
        return clean
    }

    fun uuid(value: String): String {
        val parsed = try { UUID.fromString(value) } catch (_: Exception) { throw RemoteError("서버의 식별자를 확인하세요.") }
        if (parsed.toString() != value.lowercase()) throw RemoteError("서버의 식별자를 확인하세요.")
        return parsed.toString()
    }
    fun uuidV4(value: String): String = uuid(value).also {
        if (UUID.fromString(it).version() != 4 || UUID.fromString(it).variant() != 2) throw RemoteError("작업 요청 식별자를 확인하세요.")
    }

    fun envelope(line: String): JSONObject {
        val root = try { JSONObject(line) } catch (_: Exception) { throw RemoteError("Mac의 응답 형식을 확인하세요.") }
        return when (root.opt("ok")) {
            true -> root.optJSONObject("result") ?: throw RemoteError("Mac의 응답 형식을 확인하세요.")
            false -> throw RemoteRejection((root.opt("error") as? String)?.take(1000)?.takeIf { it.isNotBlank() }
                ?: "Mac에서 요청을 거부했습니다.")
            else -> throw RemoteError("Mac의 응답 형식을 확인하세요.")
        }
    }

    fun projects(result: JSONObject): List<Project> {
        val array = result.optJSONArray("projects") ?: throw RemoteError("프로젝트 목록을 확인하세요.")
        if (array.length() > 100) throw RemoteError("프로젝트 목록이 너무 큽니다.")
        return (0 until array.length()).map { index ->
            val item = array.optJSONObject(index) ?: throw RemoteError("프로젝트 목록을 확인하세요.")
            val id = uuid(item.optString("id", ""))
            val name = item.optString("name", "").takeIf { it.isNotBlank() && it.length <= 200 }
                ?: throw RemoteError("프로젝트 목록을 확인하세요.")
            Project(id, name)
        }
    }

    private fun strings(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        if (array.length() > 100) throw RemoteError("Mac의 응답이 너무 큽니다.")
        return (0 until array.length()).map { index ->
            (array.opt(index) as? String)?.take(1000) ?: throw RemoteError("Mac의 응답 형식을 확인하세요.")
        }
    }
    private fun optionalString(value: JSONObject, key: String): String? = (value.opt(key) as? String)?.take(200)
    private fun optionalBoolean(value: JSONObject, key: String): Boolean? = value.opt(key) as? Boolean
    fun preview(result: JSONObject) = Preview(
        optionalBoolean(result, "template"), optionalString(result, "kind"), optionalString(result, "view"),
        optionalString(result, "orientation"), optionalString(result, "genre"), strings(result.optJSONArray("features")),
        (result.opt("maxApiCostUsd") as? Number)?.toDouble()?.takeIf { it.isFinite() && it in 0.0..25.0 },
    )
    fun run(result: JSONObject): RunSnapshot {
        val runId = uuid(result.optString("runId", ""))
        val gateArray = result.optJSONArray("gates") ?: JSONArray()
        if (gateArray.length() > 100) throw RemoteError("검증 결과가 너무 큽니다.")
        val gates = (0 until gateArray.length()).map { index ->
            val gate = gateArray.optJSONObject(index) ?: throw RemoteError("검증 결과를 확인하세요.")
            Gate(gate.optString("name", ""), gate.optString("status", ""), gate.optBoolean("required", false))
        }
        val jobArray = result.optJSONArray("jobs") ?: JSONArray()
        if (jobArray.length() > 17) throw RemoteError("작업 단계가 너무 많습니다.")
        val jobs = (0 until jobArray.length()).map { index ->
            val item = jobArray.optJSONObject(index) ?: throw RemoteError("작업 단계를 확인하세요.")
            val id = item.optString("id", "").takeIf { it.matches(Regex("[a-z0-9-]{1,60}")) }
                ?: throw RemoteError("작업 단계를 확인하세요.")
            Job(id, item.optString("status", "").take(40), optionalString(item, "reason"))
        }
        val activityArray = result.optJSONArray("activity") ?: JSONArray()
        if (activityArray.length() > 30) throw RemoteError("활동 내역이 너무 큽니다.")
        val activity = (0 until activityArray.length()).map { index ->
            val item = activityArray.optJSONObject(index) ?: throw RemoteError("활동 내역을 확인하세요.")
            val seq = (item.opt("sequence") as? Number)?.toLong()?.takeIf { it >= 0 } ?: throw RemoteError("활동 순번을 확인하세요.")
            val stages = strings(item.optJSONArray("stages"))
            if (stages.size > 17 || stages.any { !it.matches(Regex("[a-z0-9-]{1,60}")) }) throw RemoteError("활동 단계를 확인하세요.")
            RunActivity(seq, optionalString(item, "phase"), optionalString(item, "at"), stages)
        }
        val sequence = (result.opt("sequence") as? Number)?.toLong()?.takeIf { it >= 0 } ?: 0
        return RunSnapshot(runId, optionalString(result, "phase"), sequence,
            strings(result.optJSONArray("approvals")), optionalString(result, "verdict"),
            optionalBoolean(result, "template"), gates, jobs, optionalString(result, "projectName"),
            optionalString(result, "kind"), optionalString(result, "genre"), optionalString(result, "view"),
            optionalString(result, "orientation"), (result.opt("costUsd") as? Number)?.toDouble()?.takeIf { it.isFinite() && it in 0.0..25.0 },
            optionalString(result, "createdAt"), optionalString(result, "updatedAt"), result.optBoolean("stale", false), activity,
            result.optBoolean("interrupted", false), optionalString(result, "title"))
    }

    fun runPage(result: JSONObject, offset: Int): RunPage {
        val values = result.optJSONArray("runs") ?: throw RemoteError("작업 목록을 확인하세요.")
        if (values.length() > 12) throw RemoteError("작업 목록이 너무 큽니다.")
        val runs = (0 until values.length()).map { index ->
            run(values.optJSONObject(index) ?: throw RemoteError("작업 목록을 확인하세요."))
        }
        if (runs.map { it.runId }.distinct().size != runs.size) throw RemoteError("중복된 작업을 확인하세요.")
        val nextValue = result.opt("nextOffset")
        val next = if (nextValue == null || nextValue == JSONObject.NULL) null else {
            val number = nextValue as? Number ?: throw RemoteError("작업 목록 위치를 확인하세요.")
            val value = number.toInt()
            if (number.toDouble() != value.toDouble() || value <= offset || value > 4096) throw RemoteError("작업 목록 위치를 확인하세요.")
            value
        }
        return RunPage(runs, next)
    }

    val chatStatuses = setOf("running", "needs_input", "done", "failed", "idle")
    val chatKinds = setOf("user", "assistant", "planner_request", "planner_reply", "hosted_request", "notice", "error", "result")
    private fun text(value: JSONObject, key: String, limit: Int): String? =
        (value.opt(key) as? String)?.take(limit)?.takeIf { it.isNotBlank() }

    /** Unknown agents, modes, statuses and message kinds are kept as "unknown" rather than guessed. */
    fun conversation(value: JSONObject): ChatConversation {
        val threadId = threadId(value.opt("threadId") as? String ?: "")
        return ChatConversation(
            threadId, text(value, "projectName", 200) ?: "프로젝트", text(value, "title", 300) ?: "제목 없는 대화",
            (value.opt("agent") as? String)?.takeIf { it in setOf("claude", "codex") },
            (value.opt("mode") as? String)?.takeIf { it in setOf("plan", "edit") },
            (value.opt("status") as? String)?.takeIf { it in chatStatuses } ?: "unknown",
            text(value, "lastActivity", 64), text(value, "preview", 500),
        )
    }
    private fun canReply(result: JSONObject) = result.opt("canReply") == true
    private fun count(value: JSONObject?, key: String): Int =
        ((value?.opt(key) as? Number)?.toInt() ?: 0).coerceIn(0, 100_000)

    fun chatPage(result: JSONObject, offset: Int): ChatPage {
        val values = result.optJSONArray("conversations") ?: throw RemoteError("대화 목록을 확인하세요.")
        if (values.length() > 20) throw RemoteError("대화 목록이 너무 큽니다.")
        val conversations = (0 until values.length()).map { index ->
            conversation(values.optJSONObject(index) ?: throw RemoteError("대화 목록을 확인하세요."))
        }
        if (conversations.map { it.threadId }.distinct().size != conversations.size) throw RemoteError("중복된 대화를 확인하세요.")
        val nextValue = result.opt("nextOffset")
        val next = if (nextValue == null || nextValue == JSONObject.NULL) null else {
            val number = nextValue as? Number ?: throw RemoteError("대화 목록 위치를 확인하세요.")
            val value = number.toInt()
            if (number.toDouble() != value.toDouble() || value <= offset || value > 4096) throw RemoteError("대화 목록 위치를 확인하세요.")
            value
        }
        val counts = result.optJSONObject("counts")
        return ChatPage(conversations, next, canReply(result), count(counts, "running"), count(counts, "needsInput"))
    }

    fun chatMessage(value: JSONObject): ChatMessage {
        val id = (value.opt("id") as? String)?.takeIf { it.isNotEmpty() && it.length <= 128 }
            ?: throw RemoteError("대화 메시지를 확인하세요.")
        val kind = (value.opt("kind") as? String)?.takeIf { it in chatKinds } ?: "unknown"
        return ChatMessage(id, kind, (value.opt("text") as? String)?.take(20_000) ?: "",
            text(value, "planner", 80), text(value, "at", 64),
            if (kind == "hosted_request") value.opt("answered") as? Boolean else null)
    }

    fun chatDetail(result: JSONObject, threadId: String): ChatDetail {
        val conversation = conversation(result.optJSONObject("conversation") ?: throw RemoteError("대화를 확인하세요."))
        if (conversation.threadId != threadId) throw RemoteError("Mac이 다른 대화를 반환했습니다.")
        val values = result.optJSONArray("messages") ?: throw RemoteError("대화 메시지를 확인하세요.")
        if (values.length() > 40) throw RemoteError("대화 메시지가 너무 많습니다.")
        val messages = (0 until values.length()).map { index ->
            chatMessage(values.optJSONObject(index) ?: throw RemoteError("대화 메시지를 확인하세요."))
        }
        return ChatDetail(conversation, messages, result.opt("truncated") == true, canReply(result))
    }

    fun chatReply(result: JSONObject, threadId: String): ChatReplyResult {
        val conversation = conversation(result.optJSONObject("conversation") ?: throw RemoteError("대화를 확인하세요."))
        if (conversation.threadId != threadId) throw RemoteError("Mac이 다른 대화를 반환했습니다.")
        return ChatReplyResult(conversation, result.opt("duplicate") == true)
    }
}
