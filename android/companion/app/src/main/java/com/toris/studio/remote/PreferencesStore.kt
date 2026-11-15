package com.toris.studio.remote

import android.content.Context

/** Only the approved host, the latest request/run identifiers and one unconfirmed chat reply are durable. */
internal class PreferencesStore(context: Context) : RemoteStore {
    private val prefs = context.getSharedPreferences("remote_v1", Context.MODE_PRIVATE)
    override fun read(): SavedState {
        val host = prefs.getString("host", null)
        val port = prefs.getInt("port", 0)
        val fingerprint = prefs.getString("fingerprint", null)
        val mac = if (host != null && PairingData.isPrivateIpv4(host) && port in 1..65535 && fingerprint != null &&
            runCatching { HostKeyPin.parseFingerprint(fingerprint) }.isSuccess) MacAddress(host, port, fingerprint) else null
        val requestId = prefs.getString("requestId", null)?.takeIf { runCatching { Protocol.uuidV4(it) }.isSuccess }
        val runId = prefs.getString("runId", null)?.takeIf { runCatching { Protocol.uuid(it) }.isSuccess }
        val reply = prefs.getString("replyRequestId", null)?.let { id ->
            val thread = prefs.getString("replyThreadId", null) ?: return@let null
            val text = prefs.getString("replyText", null) ?: return@let null
            runCatching {
                PendingReply(Protocol.uuidV4(id), Protocol.threadId(thread), text.takeIf { Protocol.replyText(it) == it }!!)
            }.getOrNull()
        }
        return SavedState(mac, requestId, runId, reply)
    }
    override fun save(state: SavedState) {
        val edit = prefs.edit().clear()
        state.mac?.let { edit.putString("host", it.host).putInt("port", it.port).putString("fingerprint", it.fingerprint) }
        state.requestId?.let { edit.putString("requestId", it) }
        state.runId?.let { edit.putString("runId", it) }
        state.reply?.let {
            edit.putString("replyRequestId", it.requestId).putString("replyThreadId", it.threadId).putString("replyText", it.text)
        }
        if (!edit.commit()) throw RemoteError("연결 및 작업 식별자를 저장하지 못했습니다.")
    }
}
