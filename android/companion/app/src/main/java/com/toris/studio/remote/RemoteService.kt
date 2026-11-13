package com.toris.studio.remote

import org.json.JSONObject
import java.io.Closeable
import java.util.Base64
import java.util.UUID

internal data class SavedState(val mac: MacAddress? = null, val requestId: String? = null, val runId: String? = null)
internal interface RemoteStore {
    fun read(): SavedState
    fun save(state: SavedState)
}
internal enum class Authentication { ENROLLMENT, DEVICE }
internal interface RemoteConnection : Closeable {
    fun request(request: JSONObject): JSONObject
}
internal interface RemoteConnector {
    fun open(mac: MacAddress, authentication: Authentication): RemoteConnection
    fun stop()
    fun start()
}

/** Enrollment is session-bound. The enrollment channel is closed before device auth. */
internal class Enrollment internal constructor(
    private val connection: RemoteConnection, private val store: RemoteStore, val mac: MacAddress,
    val confirmationCode: String,
) : Closeable {
    private var closed = false
    fun poll(): Boolean {
        check(!closed)
        return when (connection.request(Protocol.poll()).optString("state", "")) {
            "waiting" -> false
            "approved" -> {
                close()
                val previous = store.read()
                store.save(if (previous.mac == mac) previous else SavedState(mac = mac))
                true
            }
            else -> throw RemoteError("Mac의 등록 상태를 확인하세요.")
        }
    }
    override fun close() {
        if (!closed) { closed = true; connection.close() }
    }
}

internal class RemoteService(
    private val store: RemoteStore, private val connector: RemoteConnector,
    private val publicKey: () -> ByteArray,
    private val now: () -> Long = { System.currentTimeMillis() / 1000 },
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    fun saved() = store.read()
    fun startForeground() = connector.start()
    fun stopForeground() = connector.stop()

    fun begin(pairing: PairingData, name: String): Enrollment {
        val cleanName = name.trim()
        require(cleanName.isNotEmpty() && cleanName.codePointCount(0, cleanName.length) <= 60 &&
            cleanName.none { it.isISOControl() }) { "기기 이름을 확인하세요." }
        require(pairing.expiresAt > now()) { "QR이 만료되었습니다. Mac에서 다시 발급하세요." }
        val mac = MacAddress(pairing.host, pairing.port, pairing.fingerprint)
        val key = publicKey()
        val expectedCode = pairing.confirmationCode(key)
        val expectedFingerprint = HostKeyPin.fingerprint(key)
        val connection = connector.open(mac, Authentication.ENROLLMENT)
        try {
            require(pairing.expiresAt > now()) { "QR이 만료되었습니다. Mac에서 다시 발급하세요." }
            val result = connection.request(Protocol.begin(pairing.tokenForEnrollment(), cleanName,
                Base64.getEncoder().withoutPadding().encodeToString(key)))
            if (result.optString("state") != "waiting" || result.optString("confirmationCode") != expectedCode ||
                result.optString("fingerprint") != expectedFingerprint) {
                throw RemoteError("등록 확인 코드 또는 기기 지문이 일치하지 않습니다. Mac에서 새 QR을 발급하세요.")
            }
            return Enrollment(connection, store, mac, expectedCode)
        } catch (error: Throwable) {
            connection.close()
            throw error
        }
    }

    private fun call(body: JSONObject): JSONObject {
        val mac = store.read().mac ?: throw RemoteError("먼저 Mac을 연결하세요.")
        return connector.open(mac, Authentication.DEVICE).use { it.request(body) }
    }
    fun projects() = Protocol.projects(call(Protocol.projects()))
    fun runs(offset: Int = 0) = Protocol.runPage(call(Protocol.runs(offset)), offset)
    fun preview(project: String, input: FactoryInput) = Protocol.preview(call(Protocol.preview(project, input)))

    /** Commit the id before a byte can be sent, and reuse it after every uncertain failure. */
    fun start(project: String, input: FactoryInput, retry: Boolean): RunSnapshot {
        val before = store.read()
        if (before.mac == null) throw RemoteError("먼저 Mac을 연결하세요.")
        val id = if (retry) before.requestId ?: throw RemoteError("복구할 작업 요청이 없습니다.") else {
            if (before.requestId != null) throw RemoteError("기존 작업을 확인한 뒤 새 작업을 시작하세요.")
            Protocol.uuidV4(newId())
        }
        val request = Protocol.start(project, id, input)
        if (!retry) store.save(before.copy(requestId = id, runId = null))
        val result = Protocol.run(call(request))
        saveRun(id, result)
        return result
    }
    fun recover(): RunSnapshot {
        val saved = store.read()
        val id = saved.requestId ?: throw RemoteError("복구할 작업 요청이 없습니다.")
        val result = Protocol.run(call(Protocol.recover(id)))
        saveRun(id, result)
        return result
    }
    fun status(): RunSnapshot {
        val saved = store.read()
        val runId = saved.runId ?: return recover()
        return status(runId)
    }
    fun status(runId: String): RunSnapshot {
        val result = Protocol.run(call(Protocol.status(runId)))
        if (result.runId != runId) throw RemoteError("Mac이 다른 작업 식별자를 반환했습니다.")
        return result
    }
    fun cancel(): RunSnapshot {
        val runId = store.read().runId ?: throw RemoteError("취소할 작업을 먼저 복구하세요.")
        return cancel(runId)
    }
    fun cancel(runId: String): RunSnapshot {
        val result = Protocol.run(call(Protocol.cancel(runId)))
        if (result.runId != runId) throw RemoteError("Mac이 다른 작업 식별자를 반환했습니다.")
        return result
    }
    fun forgetFinished(snapshot: RunSnapshot) {
        val saved = store.read()
        require(snapshot.terminal && snapshot.runId == saved.runId) { "완료된 작업을 확인하세요." }
        store.save(saved.copy(requestId = null, runId = null))
    }
    /** Called only after an explicit warning and user confirmation. */
    fun forgetUncertain() {
        val saved = store.read()
        require(saved.requestId != null && saved.runId == null)
        store.save(saved.copy(requestId = null))
    }
    /** The user must see and accept the duplicate-work warning first. */
    fun forgetAfterWarning() {
        val saved = store.read()
        require(saved.requestId != null)
        store.save(saved.copy(requestId = null, runId = null))
    }
    private fun saveRun(requestId: String, snapshot: RunSnapshot) {
        val current = store.read()
        if (current.requestId != requestId || (current.runId != null && current.runId != snapshot.runId)) {
            throw RemoteError("Mac이 다른 작업 식별자를 반환했습니다.")
        }
        store.save(current.copy(runId = snapshot.runId))
    }
}
