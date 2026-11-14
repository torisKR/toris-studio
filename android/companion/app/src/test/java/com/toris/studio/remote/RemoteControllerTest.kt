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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class RemoteControllerTest {
    @Test fun cancelRemainsAvailableDuringAnOutstandingStatusRefresh() = runBlocking {
        val runId = UUID.randomUUID().toString()
        val statusStarted = CountDownLatch(1)
        val releaseStatus = CountDownLatch(1)
        val store = object : RemoteStore {
            private var value = SavedState(MacAddress("192.168.1.7", 2222, "test"))
            override fun read() = value
            override fun save(state: SavedState) { value = state }
        }
        fun snapshot(phase: String, sequence: Int) = JSONObject()
            .put("runId", runId).put("phase", phase).put("sequence", sequence)
        val connector = object : RemoteConnector {
            override fun start() = Unit
            override fun stop() = Unit
            override fun open(mac: MacAddress, authentication: Authentication) = object : RemoteConnection {
                override fun request(request: JSONObject): JSONObject = when (request.getString("method")) {
                    "projects.list" -> JSONObject().put("projects", JSONArray())
                    "factory.list" -> JSONObject().put("runs", JSONArray().put(snapshot("waiting", 2)))
                    "factory.status" -> {
                        statusStarted.countDown()
                        check(releaseStatus.await(10, TimeUnit.SECONDS))
                        snapshot("waiting", 2)
                    }
                    "factory.cancel" -> snapshot("cancelled", 3)
                    else -> error("unexpected request")
                }
                override fun close() = Unit
            }
        }
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val scope = CoroutineScope(SupervisorJob() + dispatcher)
        val controller = RemoteController(RemoteService(store, connector, { byteArrayOf() }), "test", scope, "test")
        suspend fun awaitState(predicate: () -> Boolean) = withTimeout(5_000) {
            while (!withContext(dispatcher) { predicate() }) delay(10)
        }
        try {
            withContext(dispatcher) { controller.onStart() }
            awaitState { controller.online && !controller.busy }
            withContext(dispatcher) { controller.openRun(runId) }
            assertTrue("status refresh did not start", statusStarted.await(5, TimeUnit.SECONDS))
            withContext(dispatcher) {
                assertFalse("background refresh must not disable user actions", controller.busy)
                controller.cancelRun()
            }
            awaitState { controller.run?.phase == "cancelled" && !controller.busy }
            releaseStatus.countDown()
            delay(100)
            withContext(dispatcher) {
                assertEquals("cancelled", controller.run?.phase)
                assertEquals(3L, controller.run?.sequence)
            }
        } finally {
            releaseStatus.countDown()
            withContext(dispatcher) { controller.dispose() }
            scope.cancel()
            dispatcher.close()
        }
    }
}
