package com.toris.studio.remote

import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.util.UUID

class ProtocolTest {
    @Test fun closedFactoryInputAndExactWireMethods() {
        val id = UUID.randomUUID().toString()
        val input = FactoryInput("게임", "game", "2d", "landscape")
        val body = Protocol.start(id, id, input)
        assertEquals(setOf("method", "projectId", "requestId", "input"), body.keys().asSequence().toSet())
        assertEquals(setOf("brief", "kind", "view", "orientation"), body.getJSONObject("input").keys().asSequence().toSet())
        assertEquals("factory.start", body.getString("method"))
        assertEquals("factory.recover", Protocol.recover(id).getString("method"))
        assertEquals(setOf("method", "offset"), Protocol.runs(0).keys().asSequence().toSet())
        assertEquals("factory.status", Protocol.status(id).getString("method"))
        assertEquals("factory.cancel", Protocol.cancel(id).getString("method"))
        assertThrows(IllegalArgumentException::class.java) { input.copy(brief = "$(whoami)").json() }
        assertThrows(IllegalArgumentException::class.java) { input.copy(view = "shell").json() }
        assertThrows(RemoteError::class.java) { Protocol.start(id, "00000000-0000-1000-8000-000000000000", input) }
    }

    @Test fun envelopesPreserveErrorsAndRejectMalformedSuccess() {
        assertEquals("승인 대기", assertThrows(RemoteError::class.java) {
            Protocol.envelope("""{"ok":false,"error":"승인 대기"}""")
        }.message)
        assertThrows(RemoteError::class.java) { Protocol.envelope("""{"ok":true}""") }
        assertThrows(RemoteError::class.java) { Protocol.envelope("""{"ok":"true","result":{}}""") }
        assertThrows(RemoteError::class.java) { Protocol.envelope("not json") }
        assertEquals("waiting", Protocol.envelope("""{"ok":true,"result":{"state":"waiting"}}""").getString("state"))
    }

    @Test fun readsOneBoundedUtf8JsonLine() {
        val stream = ByteArrayInputStream("첫째\n둘째\n".toByteArray())
        assertEquals("첫째", readLine(stream))
        assertEquals("둘째", readLine(stream))
        assertThrows(RemoteError::class.java) { readLine(ByteArrayInputStream(ByteArray(65_537) { 65 })) }
        assertThrows(RemoteError::class.java) { readLine(ByteArrayInputStream(byteArrayOf(0xc3.toByte(), 10))) }
        assertThrows(RemoteError::class.java) { readLine(ByteArrayInputStream("partial".toByteArray())) }
    }

    @Test fun rejectsInvalidProjectAndRunIdentifiers() {
        assertThrows(RemoteError::class.java) { Protocol.projects(JSONObject("""{"projects":[{"id":"bad","name":"x"}]}""")) }
        assertThrows(RemoteError::class.java) { Protocol.run(JSONObject("""{"runId":null,"phase":"done"}""")) }
    }

    @Test fun runPagesAreBoundedAndNeverRepeatIdsOrMoveBackwards() {
        val id = UUID.randomUUID().toString()
        val item = JSONObject().put("runId", id).put("phase", "done").put("stale", true).put("title", "픽셀 낚시 게임")
            .put("jobs", JSONArray().put(JSONObject().put("id", "sprite-atlas").put("status", "blocked").put("reason", "tool_not_run")))
            .put("activity", JSONArray().put(JSONObject().put("sequence", 3).put("phase", "coding").put("stages", JSONArray().put("sprite-atlas"))))
        val page = Protocol.runPage(JSONObject().put("runs", JSONArray().put(item)).put("nextOffset", 12), 0)
        assertEquals(12, page.nextOffset)
        assertEquals("픽셀 낚시 게임", runTitle(page.runs.single()))
        assertTrue(page.runs.single().stale)
        assertEquals("sprite-atlas", page.runs.single().jobs.single().id)
        assertEquals("tool_not_run", page.runs.single().jobs.single().reason)
        assertEquals(3L, page.runs.single().activity.single().sequence)
        assertThrows(RemoteError::class.java) { Protocol.runPage(JSONObject().put("runs", JSONArray().put(item).put(item)), 0) }
        assertThrows(RemoteError::class.java) { Protocol.runPage(JSONObject().put("runs", JSONArray()).put("nextOffset", 12), 12) }
        assertThrows(RemoteError::class.java) { Protocol.runPage(JSONObject().put("runs", JSONArray()).put("nextOffset", 12.5), 0) }
    }

    @Test fun aFinishedRunWithIncompleteChecksIsShownAsBlocked() {
        val id = UUID.randomUUID().toString()
        val result = Protocol.run(JSONObject().put("runId", id).put("phase", "done").put("verdict", "incomplete"))
        assertEquals("검증 보류", phaseLabel(result))
        assertEquals("작업 종료", phaseLabel(result.copy(verdict = "pass")))
        assertEquals("Mac 종료로 중단", phaseLabel(result.copy(phase = "failed", interrupted = true)))
    }
}
