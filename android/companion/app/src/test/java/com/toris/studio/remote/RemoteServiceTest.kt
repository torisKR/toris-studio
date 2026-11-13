package com.toris.studio.remote

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64
import java.util.UUID

class RemoteServiceTest {
    private val publicKey = byteArrayOf(1, 2, 3, 4, 5)
    private val mac = MacAddress("192.168.1.7", 2222, HostKeyPin.fingerprint(byteArrayOf(9)))
    private val project = UUID.randomUUID().toString()
    private val request = UUID.randomUUID().toString()
    private val run = UUID.randomUUID().toString()
    private val input = FactoryInput("픽셀 낚시 게임", "game", "2d", "portrait")

    private class MemoryStore(var value: SavedState = SavedState()) : RemoteStore {
        val saves = mutableListOf<SavedState>()
        override fun read() = value
        override fun save(state: SavedState) { value = state; saves.add(state) }
    }
    private class FakeConnector(val handle: (Authentication, JSONObject) -> JSONObject) : RemoteConnector {
        val events = mutableListOf<String>()
        val requests = mutableListOf<JSONObject>()
        override fun start() = Unit
        override fun stop() = Unit
        override fun open(mac: MacAddress, authentication: Authentication): RemoteConnection {
            events.add("open:$authentication")
            return object : RemoteConnection {
                override fun request(request: JSONObject): JSONObject {
                    events.add("request:${request.getString("method")}")
                    requests.add(JSONObject(request.toString()))
                    return handle(authentication, request)
                }
                override fun close() { events.add("close:$authentication") }
            }
        }
    }
    private fun pair(now: Long = 1000): PairingData = PairingData.parse(JSONObject().apply {
        put("v", 1); put("host", mac.host); put("port", mac.port); put("fingerprint", mac.fingerprint)
        put("expires", 1120); put("token", Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { it.toByte() }))
    }.toString(), now)
    private fun snapshot(id: String = run) = JSONObject().put("runId", id).put("phase", "waiting")
        .put("sequence", 2).put("approvals", org.json.JSONArray().put("Mac에서 승인이 필요합니다."))

    @Test fun approvalClosesEnrollmentBeforeADeviceSessionAndSavesNoSecret() {
        val store = MemoryStore()
        val pairing = pair()
        var polls = 0
        val connector = FakeConnector { auth, body ->
            when (body.getString("method")) {
                "enroll.begin" -> {
                    assertEquals(Authentication.ENROLLMENT, auth)
                    assertEquals(Base64.getEncoder().withoutPadding().encodeToString(publicKey), body.getString("publicKey"))
                    JSONObject().put("state", "waiting").put("confirmationCode", pairing.confirmationCode(publicKey))
                        .put("fingerprint", HostKeyPin.fingerprint(publicKey))
                }
                "enroll.poll" -> JSONObject().put("state", if (polls++ == 0) "waiting" else "approved")
                "projects.list" -> { assertEquals(Authentication.DEVICE, auth); JSONObject().put("projects", org.json.JSONArray()) }
                else -> error("unexpected")
            }
        }
        val service = RemoteService(store, connector, { publicKey }, { 1000 })
        val enrollment = service.begin(pairing, "내 기기")
        assertEquals(pairing.confirmationCode(publicKey), enrollment.confirmationCode)
        assertFalse(enrollment.poll())
        assertNull(store.read().mac)
        assertTrue(enrollment.poll())
        assertEquals(mac, store.read().mac)
        service.projects()
        assertTrue(connector.events.indexOf("close:ENROLLMENT") < connector.events.indexOf("open:DEVICE"))
        assertFalse(store.saves.toString().contains(pairing.tokenForEnrollment()))
        assertEquals(listOf("enroll.begin", "enroll.poll", "enroll.poll", "projects.list"), connector.requests.map { it.getString("method") })
    }

    @Test fun mismatchOrExpiryNeverCreatesAnApprovedHost() {
        val store = MemoryStore()
        val connector = FakeConnector { _, _ -> JSONObject().put("state", "waiting").put("confirmationCode", "000000").put("fingerprint", "wrong") }
        val service = RemoteService(store, connector, { publicKey }, { 1000 })
        assertThrows(RemoteError::class.java) { service.begin(pair(), "phone") }
        assertEquals("close:ENROLLMENT", connector.events.last())
        assertNull(store.read().mac)
        val late = RemoteService(store, connector, { publicKey }, { 1120 })
        val before = connector.events.size
        assertThrows(IllegalArgumentException::class.java) { late.begin(pair(), "phone") }
        assertEquals(before, connector.events.size)
    }

    @Test fun expiringDuringHandshakeClosesTheChannelWithoutSendingTheToken() {
        val store = MemoryStore()
        var now = 1000L
        var sent = false
        val connector = object : RemoteConnector {
            var closed = false
            override fun start() = Unit
            override fun stop() = Unit
            override fun open(mac: MacAddress, authentication: Authentication): RemoteConnection {
                now = 1120
                return object : RemoteConnection {
                    override fun request(request: JSONObject): JSONObject { sent = true; return JSONObject() }
                    override fun close() { closed = true }
                }
            }
        }
        val service = RemoteService(store, connector, { publicKey }, { now })
        assertThrows(IllegalArgumentException::class.java) { service.begin(pair(), "phone") }
        assertTrue(connector.closed)
        assertFalse(sent)
        assertNull(store.value.mac)
    }

    @Test fun lostStartKeepsIdAndRecoveryNeverStartsAgainEvenAfterRestart() {
        val store = MemoryStore(SavedState(mac))
        var lose = true
        val connector = FakeConnector { _, body ->
            when (body.getString("method")) {
                "factory.start" -> {
                    assertEquals(request, store.read().requestId)
                    if (lose) { lose = false; throw RemoteError("연결 끊김") }
                    snapshot()
                }
                "factory.recover" -> snapshot()
                else -> error("unexpected")
            }
        }
        val service = RemoteService(store, connector, { publicKey }, newId = { request })
        assertThrows(RemoteError::class.java) { service.start(project, input, false) }
        assertEquals(request, store.read().requestId)
        assertNull(store.read().runId)
        val restarted = RemoteService(store, connector, { publicKey })
        assertEquals(run, restarted.recover().runId)
        assertEquals(run, store.read().runId)
        assertEquals(listOf("factory.start", "factory.recover"), connector.requests.map { it.getString("method") })
        assertThrows(RemoteError::class.java) { restarted.start(project, input, false) }
    }

    @Test fun retryReusesIdAndPayloadAndMismatchedRunIsRejected() {
        val store = MemoryStore(SavedState(mac))
        var call = 0
        val connector = FakeConnector { _, _ ->
            if (call++ == 0) throw RemoteError("응답 유실") else snapshot()
        }
        val service = RemoteService(store, connector, { publicKey }, newId = { request })
        assertThrows(RemoteError::class.java) { service.start(project, input, false) }
        assertEquals(run, service.start(project, input, true).runId)
        assertEquals(connector.requests[0].toString(), connector.requests[1].toString())
        val wrong = FakeConnector { _, _ -> snapshot(UUID.randomUUID().toString()) }
        assertThrows(RemoteError::class.java) { RemoteService(store, wrong, { publicKey }).recover() }
        assertEquals(run, store.read().runId)
    }

    @Test fun invalidInputOrFailedSaveCannotSendAStart() {
        val connector = FakeConnector { _, _ -> error("must not send") }
        val store = MemoryStore(SavedState(mac))
        val service = RemoteService(store, connector, { publicKey }, newId = { request })
        assertThrows(IllegalArgumentException::class.java) { service.start(project, input.copy(kind = "shell"), false) }
        assertNull(store.read().requestId)
        assertTrue(connector.events.isEmpty())
        val badStore = object : RemoteStore {
            override fun read() = SavedState(mac)
            override fun save(state: SavedState) { throw RemoteError("저장 실패") }
        }
        assertThrows(RemoteError::class.java) { RemoteService(badStore, connector, { publicKey }, newId = { request }).start(project, input, false) }
        assertTrue(connector.events.isEmpty())
    }

    @Test fun onlyTerminalRunMayBeForgottenAndUncertainRequestNeedsExplicitReset() {
        val store = MemoryStore(SavedState(mac, request, run))
        val service = RemoteService(store, FakeConnector { _, _ -> snapshot() }, { publicKey })
        assertThrows(IllegalArgumentException::class.java) { service.forgetFinished(Protocol.run(snapshot())) }
        assertEquals(request, store.value.requestId)
        service.forgetFinished(Protocol.run(snapshot().put("phase", "done")))
        assertNull(store.value.requestId)
        store.value = SavedState(mac, request, null)
        service.forgetUncertain()
        assertNull(store.value.requestId)
    }

    @Test fun olderOwnedRunsCanBeViewedAndCancelledWithoutReplacingTheLatestRequest() {
        val older = UUID.randomUUID().toString()
        val store = MemoryStore(SavedState(mac, request, run))
        val connector = FakeConnector { _, body ->
            when (body.getString("method")) {
                "factory.list" -> JSONObject().put("runs", org.json.JSONArray().put(snapshot(older)).put(snapshot(run)))
                "factory.status" -> snapshot(body.getString("runId"))
                "factory.cancel" -> snapshot(body.getString("runId")).put("phase", "cancelled")
                else -> error("unexpected")
            }
        }
        val service = RemoteService(store, connector, { publicKey })
        assertEquals(listOf(older, run), service.runs().runs.map { it.runId })
        assertEquals(older, service.status(older).runId)
        assertEquals("cancelled", service.cancel(older).phase)
        assertEquals(SavedState(mac, request, run), store.read())
        assertEquals(older, connector.requests.last().getString("runId"))
    }
}
