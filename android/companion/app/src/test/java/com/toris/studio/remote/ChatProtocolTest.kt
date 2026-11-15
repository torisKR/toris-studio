package com.toris.studio.remote

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class ChatProtocolTest {
    private val request = UUID.randomUUID().toString()
    private fun keys(value: JSONObject) = value.keys().asSequence().toSet()
    private fun conversation(id: String = "thread-1", status: String = "needs_input") = JSONObject()
        .put("threadId", id).put("projectName", "낚시").put("title", "보스 기획").put("agent", "codex").put("mode", "plan")
        .put("status", status).put("lastActivity", "2026-01-02T03:04:05Z").put("preview", JSONObject.NULL)

    @Test fun buildersSendExactlyTheAllowedFields() {
        val list = Protocol.chatList(20, true)
        assertEquals(setOf("method", "offset", "needsInput"), keys(list))
        assertEquals("chat.list", list.getString("method"))
        assertTrue(list.getBoolean("needsInput"))
        assertEquals(setOf("method", "threadId"), keys(Protocol.chatDetail("abc-123")))
        val reply = Protocol.chatReply("abc-123", request, "  안녕\n하세요  ")
        assertEquals(setOf("method", "threadId", "requestId", "text"), keys(reply))
        assertEquals("chat.reply", reply.getString("method"))
        assertEquals("안녕\n하세요", reply.getString("text"))
        assertThrows(IllegalArgumentException::class.java) { Protocol.chatList(4097, false) }
        assertThrows(IllegalArgumentException::class.java) { Protocol.chatList(-1, false) }
    }

    @Test fun rejectsBadThreadIdsRequestIdsAndText() {
        listOf("", "a/b", "../x", "a b", "한글", "x".repeat(65), "a_b").forEach { bad ->
            assertThrows(bad, RemoteError::class.java) { Protocol.chatDetail(bad) }
        }
        assertEquals("x".repeat(64), Protocol.threadId("x".repeat(64)))
        assertThrows(RemoteError::class.java) { Protocol.chatReply("t", "not-a-uuid", "hi") }
        assertThrows(RemoteError::class.java) { Protocol.chatReply("t", "00000000-0000-1000-8000-000000000000", "hi") }
        assertThrows(IllegalArgumentException::class.java) { Protocol.chatReply("t", request, "   ") }
        assertThrows(IllegalArgumentException::class.java) { Protocol.chatReply("t", request, "a\u0000b") }
        assertThrows(IllegalArgumentException::class.java) { Protocol.chatReply("t", request, "a\u001bb") }
        assertEquals("a\tb\r\nc", Protocol.replyText("a\tb\r\nc"))
        assertEquals(2000, Protocol.replyText("a".repeat(2000)).length)
        assertThrows(IllegalArgumentException::class.java) { Protocol.replyText("a".repeat(2001)) }
        // 2,000 Korean syllables are 6,000 UTF-8 bytes; emoji push past the 6 KB cap before 2,000 code points.
        assertEquals(2000, Protocol.replyText("가".repeat(2000)).length)
        assertEquals("답장은 2,000자(6KB) 이하로 줄이세요.",
            assertThrows(IllegalArgumentException::class.java) { Protocol.replyText("😀".repeat(1501)) }.message)
        assertTrue(Protocol.chatReply("t", request, "가".repeat(2000)).toString().toByteArray().size <= 8192)
    }

    @Test fun parsesConversationsAndUnknownValuesAreUnknownSafe() {
        val page = Protocol.chatPage(JSONObject()
            .put("conversations", JSONArray().put(conversation()).put(conversation("thread-2", "exploded").put("agent", "gpt").put("mode", "yolo")))
            .put("nextOffset", 20).put("canReply", true)
            .put("counts", JSONObject().put("running", 3).put("needsInput", 1)), 0)
        assertEquals(20, page.nextOffset)
        assertTrue(page.canReply)
        assertEquals(3, page.running)
        assertEquals(1, page.needsInput)
        val first = page.conversations[0]
        assertEquals("needs_input", first.status)
        assertEquals("입력 필요", chatStatusLabel(first.status))
        assertEquals("Codex", agentLabel(first.agent))
        assertEquals("계획", modeLabel(first.mode))
        assertNull(first.preview)
        val odd = page.conversations[1]
        assertEquals("unknown", odd.status)
        assertEquals("상태 확인 필요", chatStatusLabel(odd.status))
        assertNull(odd.agent)
        assertNull(odd.mode)
        assertFalse(Protocol.chatPage(JSONObject().put("conversations", JSONArray()).put("canReply", "true"), 0).canReply)
        assertThrows(RemoteError::class.java) { Protocol.chatPage(JSONObject().put("conversations", JSONArray().put(conversation()).put(conversation())), 0) }
        assertThrows(RemoteError::class.java) { Protocol.chatPage(JSONObject().put("conversations", JSONArray().put(conversation("../etc"))), 0) }
        assertThrows(RemoteError::class.java) { Protocol.chatPage(JSONObject().put("conversations", JSONArray()).put("nextOffset", 20), 20) }
        assertThrows(RemoteError::class.java) { Protocol.chatPage(JSONObject(), 0) }
        val tooMany = JSONArray().apply { repeat(21) { put(conversation("t$it")) } }
        assertThrows(RemoteError::class.java) { Protocol.chatPage(JSONObject().put("conversations", tooMany), 0) }
    }

    @Test fun parsesMessagesAndPlannerCards() {
        val messages = JSONArray()
            .put(JSONObject().put("id", "1").put("kind", "user").put("text", "해줘").put("planner", JSONObject.NULL).put("at", JSONObject.NULL).put("answered", JSONObject.NULL))
            .put(JSONObject().put("id", "2").put("kind", "planner_reply").put("text", "기획안").put("planner", "Muse"))
            .put(JSONObject().put("id", "3").put("kind", "planner_request").put("text", "요청").put("planner", "OpenAI Dots"))
            .put(JSONObject().put("id", "4").put("kind", "hosted_request").put("text", "도와줘").put("planner", "Grok Bot").put("answered", false))
            .put(JSONObject().put("id", "5").put("kind", "telemetry").put("text", "?").put("answered", true))
        val detail = Protocol.chatDetail(JSONObject().put("conversation", conversation()).put("messages", messages)
            .put("truncated", true).put("canReply", false), "thread-1")
        assertTrue(detail.truncated)
        assertFalse(detail.canReply)
        assertEquals(listOf("user", "planner_reply", "planner_request", "hosted_request", "unknown"), detail.messages.map { it.kind })
        assertNull(plannerCardTitle(detail.messages[0]))
        assertEquals("Muse 기획", plannerCardTitle(detail.messages[1]))
        assertEquals("OpenAI Dots에게 보낸 요청", plannerCardTitle(detail.messages[2]))
        assertEquals("Grok Bot 기획 요청", plannerCardTitle(detail.messages[3]))
        assertEquals(false, detail.messages[3].answered)
        assertNull("answered only applies to hosted requests", detail.messages[4].answered)
        assertThrows(RemoteError::class.java) {
            Protocol.chatDetail(JSONObject().put("conversation", conversation()).put("messages", JSONArray()), "other")
        }
        val tooMany = JSONArray().apply { repeat(41) { put(JSONObject().put("id", "$it").put("kind", "user").put("text", "x")) } }
        assertThrows(RemoteError::class.java) {
            Protocol.chatDetail(JSONObject().put("conversation", conversation()).put("messages", tooMany), "thread-1")
        }
        assertThrows(RemoteError::class.java) {
            Protocol.chatDetail(JSONObject().put("conversation", conversation()).put("messages", JSONArray().put(JSONObject().put("kind", "user"))), "thread-1")
        }
    }

    @Test fun errorEnvelopesAreRejectionsAndMalformedOnesAreNot() {
        assertTrue(assertThrows(RemoteError::class.java) { Protocol.envelope("""{"ok":false,"error":"이 대화는 이미 답하는 중입니다."}""") } is RemoteRejection)
        assertFalse(assertThrows(RemoteError::class.java) { Protocol.envelope("not json") } is RemoteRejection)
    }
}
