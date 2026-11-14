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

internal class RemoteError(message: String) : Exception(message)

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
            false -> throw RemoteError((root.opt("error") as? String)?.take(1000)?.takeIf { it.isNotBlank() }
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
}
