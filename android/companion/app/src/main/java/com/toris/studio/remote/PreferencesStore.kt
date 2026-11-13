package com.toris.studio.remote

import android.content.Context

/** Only the approved host and the latest request/run identifiers are durable. */
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
        return SavedState(mac, requestId, runId)
    }
    override fun save(state: SavedState) {
        val edit = prefs.edit().clear()
        state.mac?.let { edit.putString("host", it.host).putInt("port", it.port).putString("fingerprint", it.fingerprint) }
        state.requestId?.let { edit.putString("requestId", it) }
        state.runId?.let { edit.putString("runId", it) }
        if (!edit.commit()) throw RemoteError("연결 및 작업 식별자를 저장하지 못했습니다.")
    }
}
