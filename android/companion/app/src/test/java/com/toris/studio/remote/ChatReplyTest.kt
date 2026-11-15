package com.toris.studio.remote

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID
import java.util.concurrent.Executors

class ChatReplyTest {
    private val mac = MacAddress("192.168.1.7", 2222, HostKeyPin.fingerprint(byteArrayOf(9)))
    private class MemoryStore(var value: SavedState) : RemoteStore {
        override fun read() = value
        override fun save(state: SavedState) { value = state }
    }
    private class Connector(val handle: (JSONObject) -> JSONObject) : RemoteConnector {
        val requests = mutableListOf<JSONObject>()
        override fun start() = Unit
        override fun stop() = Unit
        override fun open(mac: MacAddress, authentication: Authentication) = object : RemoteConnection {
            override fun request(request: JSONObject): JSONObject {
                synchronized(requests) { requests.add(JSONObject(request.toString())) }
                return handle(request)
            }
            override fun close() = Unit
        }
        fun replies() = synchronized(requests) { requests.filter { it.getString("method") == "chat.reply" } }
    }
    private fun conversation(status: String = "idle") = JSONObject().put("threadId", "t-1").put("projectName", "p")
        .put("title", "대화").put("agent", "claude").put("mode", "edit").put("status", status)
    private fun ids(): () -> String { val all = ArrayDeque(List(5) { UUID.randomUUID().toString() }); return { all.removeFirst() } }

    @Test fun lostAnswerKeepsTheRequestAndResendReusesTheSameId() {
        val store = MemoryStore(SavedState(mac))
        var lose = true
        val connector = Connector { body ->
            assertEquals("pending must be durable before sending", body.getString("requestId"), store.read().reply?.requestId)
            if (lose) { lose = false; throw RemoteError("Mac 연결이 끊겼습니다.") }
            JSONObject().put("conversation", conversation("running")).put("duplicate", true)
        }
        val service = RemoteService(store, connector, { byteArrayOf() }, newId = ids())
        assertThrows(RemoteError::class.java) { service.reply("t-1", " 계속해 ") }
        val pending = store.read().reply!!
        assertEquals(PendingReply(pending.requestId, "t-1", "계속해"), pending)
        assertThrows("a second reply must not replace the unconfirmed one", RemoteError::class.java) { service.reply("t-1", "다른 답") }
        // A restarted app reads the same store and resends the identical request.
        val restarted = RemoteService(store, connector, { byteArrayOf() }, newId = ids())
        assertTrue(restarted.resendReply().duplicate)
        val sent = connector.replies()
        assertEquals(2, sent.size)
        assertEquals(sent[0].toString(), sent[1].toString())
        assertNull("cleared after success", store.read().reply)
    }

    @Test fun macRefusalClearsThePendingReply() {
        val store = MemoryStore(SavedState(mac))
        val connector = Connector { throw RemoteRejection("이 대화는 이미 답하는 중입니다.") }
        val service = RemoteService(store, connector, { byteArrayOf() }, newId = ids())
        assertEquals("이 대화는 이미 답하는 중입니다.", assertThrows(RemoteError::class.java) { service.reply("t-1", "hi") }.message)
        assertNull(store.read().reply)
        assertThrows(IllegalArgumentException::class.java) { service.reply("t-1", "  ") }
        assertNull(store.read().reply)
        assertTrue("invalid text never reaches the Mac", connector.replies().size == 1)
    }

    @Test fun controllerOffersTheComposerOnlyWhenTheMacPermitsReplies() = runBlocking {
        var canReply = false
        var status = "idle"
        var reject = false
        val store = MemoryStore(SavedState(mac))
        val connector = Connector { body ->
            when (body.getString("method")) {
                "projects.list" -> JSONObject().put("projects", JSONArray())
                "factory.list" -> JSONObject().put("runs", JSONArray())
                "chat.detail" -> JSONObject().put("conversation", conversation(status)).put("messages", JSONArray()).put("canReply", canReply)
                "chat.reply" -> if (reject) throw RemoteRejection("거부") else JSONObject().put("conversation", conversation("running"))
                else -> error("unexpected")
            }
        }
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val scope = CoroutineScope(SupervisorJob() + dispatcher)
        val controller = RemoteController(RemoteService(store, connector, { byteArrayOf() }, newId = ids()), "test", scope, "test")
        suspend fun on(block: () -> Unit) = withContext(dispatcher) { block() }
        suspend fun idle() = withTimeout(5_000) { while (!withContext(dispatcher) { !controller.busy }) delay(10) }
        try {
            on { controller.onStart() }; idle()
            on { controller.openChat("t-1") }; idle()
            on { controller.changeDraft("hello"); assertFalse(controller.canCompose); controller.sendReply() }; idle()
            assertTrue("no reply is sent without permission", connector.replies().isEmpty())

            canReply = true; status = "running"
            on { controller.refreshChat() }; idle()
            on { assertFalse("the agent is still answering", controller.canCompose); controller.sendReply() }; idle()
            assertTrue(connector.replies().isEmpty())

            status = "idle"; reject = true
            on { controller.refreshChat() }; idle()
            on { assertTrue(controller.canCompose); controller.sendReply() }; idle()
            on {
                assertEquals(1, connector.replies().size)
                assertEquals("refused text stays in the composer", "hello", controller.draft)
                assertNull(controller.saved.reply)
                assertEquals("거부", controller.message)
            }
            reject = false
            on { controller.sendReply() }; idle()
            on { assertEquals("", controller.draft); assertNull(controller.saved.reply) }
            assertEquals(2, connector.replies().size)
        } finally {
            on { controller.dispose() }
            scope.cancel(); dispatcher.close()
        }
    }
}
