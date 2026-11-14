package com.toris.studio.remote

import android.content.Context
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private data class ControllerDependencies(val service: RemoteService, val fingerprint: String)

private fun controllerDependencies(context: Context): ControllerDependencies {
    val identity = KeystoreIdentity()
    return ControllerDependencies(
        RemoteService(PreferencesStore(context), SshConnector(identity), { identity.publicKeyBlob }),
        HostKeyPin.fingerprint(identity.publicKeyBlob),
    )
}

/** User requests take priority over background refresh; the Mac is the source of truth. */
internal class RemoteController(
    private val service: RemoteService,
    val deviceFingerprint: String,
    private val scope: CoroutineScope,
    initialDeviceName: String,
) {
    private constructor(deps: ControllerDependencies) : this(
        deps.service, deps.fingerprint, CoroutineScope(SupervisorJob() + Dispatchers.Main),
        Build.MODEL?.take(60)?.takeIf { it.isNotBlank() } ?: "Android 기기",
    )
    constructor(context: Context) : this(controllerDependencies(context))
    private var task: Job? = null
    private var pollTask: Job? = null
    private var enrollment: Enrollment? = null
    private var epoch = 0
    private var foreground = false
    private var lastAttempt: Pair<String, FactoryInput>? = null
    private var messageFromConnection = false

    var saved by mutableStateOf(service.saved()); private set
    var busy by mutableStateOf(false); private set
    var online by mutableStateOf(false); private set
    var scanning by mutableStateOf(false); private set
    var code by mutableStateOf<String?>(null); private set
    var message by mutableStateOf<String?>(null); private set
    var projects by mutableStateOf<List<Project>>(emptyList()); private set
    var selectedProject by mutableStateOf<Project?>(null); private set
    var preview by mutableStateOf<Preview?>(null); private set
    var runs by mutableStateOf<List<RunSnapshot>>(emptyList()); private set
    var nextOffset by mutableStateOf<Int?>(null); private set
    var selectedRunId by mutableStateOf<String?>(null); private set
    var run by mutableStateOf<RunSnapshot?>(null); private set
    var deviceName by mutableStateOf(initialDeviceName)
    var brief by mutableStateOf(""); private set
    var kind by mutableStateOf("game"); private set
    var view by mutableStateOf<String?>(null); private set
    var orientation by mutableStateOf<String?>(null); private set

    fun onStart() {
        foreground = true
        service.startForeground()
        saved = service.saved()
        if (saved.mac != null) connect()
    }
    fun onStop() {
        foreground = false
        epoch++
        task?.cancel(); task = null
        pollTask?.cancel(); pollTask = null
        service.stopForeground()
        enrollment = null
        if (code != null) message = "등록 연결이 종료되었습니다. Mac에서 새 QR을 발급하세요."
        code = null; busy = false; online = false; scanning = false
    }
    fun dispose() { onStop(); scope.cancel() }
    fun scan() { if (!busy && foreground) { message = null; scanning = true } }
    fun stopScan() { scanning = false }
    fun scanError(text: String) { scanning = false; message = text }
    fun clearMessage() { message = null; messageFromConnection = false }
    fun scanned(text: String) {
        if (!scanning || busy) return
        scanning = false
        val pair = try { PairingData.parse(text) } catch (error: Exception) {
            message = (error as? IllegalArgumentException)?.message ?: "QR 코드 형식을 확인하세요."
            return
        }
        action {
            val current = withContext(Dispatchers.IO) { service.begin(pair, deviceName) }
            enrollment = current
            code = current.confirmationCode
            message = "Mac에서 같은 확인 코드와 기기 지문을 비교한 뒤 승인하세요."
            try {
                while (true) {
                    delay(2000)
                    if (withContext(Dispatchers.IO) { current.poll() }) break
                }
            } finally {
                withContext(NonCancellable + Dispatchers.IO) { current.close() }
                if (enrollment === current) { enrollment = null; code = null }
            }
            saved = service.saved()
            loadProjectsAndRuns()
            message = null
        }
    }

    fun connect() = action {
        loadProjectsAndRuns()
        if (projects.isEmpty() && message == null) message = "Mac에서 이 기기에 허용한 프로젝트가 없습니다."
    }
    private suspend fun loadProjectsAndRuns() {
        projects = withContext(Dispatchers.IO) { service.projects() }
        selectedProject = projects.firstOrNull { it.id == selectedProject?.id }
        loadPage(0, reset = true)
        saved = service.saved()
        if (saved.requestId != null) {
            try {
                val latest = withContext(Dispatchers.IO) { service.recover() }
                saved = service.saved()
                updateRun(latest, select = selectedRunId == null || selectedRunId == latest.runId)
            } catch (error: RemoteError) { message = "작업 복구: ${error.message}" }
        }
        markOnline()
    }

    private suspend fun loadPage(offset: Int, reset: Boolean) {
        val page = withContext(Dispatchers.IO) { service.runs(offset) }
        runs = if (reset) page.runs else (runs + page.runs).distinctBy { it.runId }
        nextOffset = page.nextOffset
        selectedRunId?.let { id -> page.runs.firstOrNull { it.runId == id }?.let { updateRun(it, select = true) } }
    }
    fun refreshList() = action {
        loadPage(0, reset = true)
        markOnline()
    }
    fun pollDashboard() {
        if (runs.size > 12 || saved.mac == null) return
        action(silent = true) { loadPage(0, reset = true); markOnline() }
    }
    fun loadMore() {
        val offset = nextOffset ?: return
        action { loadPage(offset, reset = false); markOnline() }
    }
    fun select(project: Project) { selectedProject = project; preview = null }
    fun changeBrief(value: String) { brief = value.take(2000); preview = null }
    fun changeKind(value: String) {
        kind = value
        if (kind == "app") view = "ui" else if (view == "ui") view = null
        preview = null
    }
    fun changeView(value: String?) { view = value; preview = null }
    fun changeOrientation(value: String?) { orientation = value; preview = null }
    private fun input() = FactoryInput(brief, kind, view, orientation)
    fun makePreview() {
        val project = selectedProject ?: return
        val currentInput = input()
        action {
            preview = withContext(Dispatchers.IO) { service.preview(project.id, currentInput) }
            markOnline()
        }
    }

    /** Clear only a confirmed terminal latest request without an extra warning. */
    fun prepareNew(): Boolean {
        if (saved.requestId == null) { preview = null; lastAttempt = null; return true }
        val latest = runs.firstOrNull { it.runId == saved.runId }
            ?: run?.takeIf { it.runId == saved.runId }
        if (latest != null && latest.terminal && !latest.stale) {
            service.forgetFinished(latest)
            saved = service.saved(); preview = null; lastAttempt = null
            return true
        }
        return false
    }
    fun newAfterWarning() {
        try {
            service.forgetAfterWarning()
            saved = service.saved(); preview = null; lastAttempt = null
            message = "새 작업을 입력하세요. 이전 작업은 Mac에서 별도로 확인하세요."
        } catch (_: Exception) { message = "기존 작업 상태를 다시 확인하세요." }
    }
    fun startOrRetry() {
        val project = selectedProject ?: return
        val currentInput = input()
        val retry = saved.requestId != null
        if (saved.runId != null) { message = "먼저 기존 작업을 확인하세요."; return }
        if (retry && lastAttempt != null && lastAttempt != (project.id to currentInput)) {
            message = "같은 요청을 재전송하려면 기존 프로젝트와 입력을 유지하세요."
            return
        }
        lastAttempt = project.id to currentInput
        selectedRunId = null; run = null
        action {
            try {
                val started = withContext(Dispatchers.IO) { service.start(project.id, currentInput, retry) }
                updateRun(started, select = true)
                markOnline()
                try { loadPage(0, reset = true) } catch (_: RemoteError) { /* the started run remains visible */ }
            } finally { saved = service.saved() }
        }
    }
    fun recover() = action {
        val latest = withContext(Dispatchers.IO) { service.recover() }
        saved = service.saved(); updateRun(latest, select = true)
        markOnline()
    }
    fun openRun(id: String) {
        selectedRunId = id
        run = runs.firstOrNull { it.runId == id }
        refresh(silent = true)
    }
    fun pollSelected() = refresh(silent = true)
    fun refresh(silent: Boolean = false) {
        val id = selectedRunId ?: saved.runId ?: return
        action(silent = silent) {
            val latest = withContext(Dispatchers.IO) { service.status(id) }
            updateRun(latest, select = true)
            markOnline()
        }
    }
    fun cancelRun() {
        val id = selectedRunId ?: return
        action {
            val result = withContext(Dispatchers.IO) { service.cancel(id) }
            updateRun(result, select = true)
            markOnline()
        }
    }
    private fun updateRun(value: RunSnapshot, select: Boolean) {
        val previous = runs.firstOrNull { it.runId == value.runId }
        val merged = if (previous != null && value.sequence < previous.sequence) previous
            else value.copy(projectName = value.projectName ?: previous?.projectName)
        runs = if (previous == null) listOf(merged) + runs else runs.map { if (it.runId == value.runId) merged else it }
        if (select) { selectedRunId = value.runId; run = merged }
    }

    private fun markOnline() {
        online = true
        if (messageFromConnection) { message = null; messageFromConnection = false }
    }

    private fun action(silent: Boolean = false, block: suspend () -> Unit) {
        if (!foreground || busy || (silent && pollTask?.isActive == true)) return
        val currentEpoch = epoch
        if (!silent) {
            pollTask?.cancel(); pollTask = null
            busy = true; message = null; messageFromConnection = false
        }
        val current = scope.launch(start = CoroutineStart.LAZY) {
            try { block() }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (currentEpoch == epoch) {
                    message = when (error) {
                        is RemoteError, is IllegalArgumentException -> error.message ?: "요청을 확인하세요."
                        else -> "요청을 완료하지 못했습니다. Mac과 연결 상태를 확인하세요."
                    }
                    messageFromConnection = message?.contains("연결") == true || message?.contains("시간") == true
                    if (messageFromConnection) online = false
                }
            } finally {
                if (currentEpoch == epoch) {
                    if (silent) {
                        if (pollTask === coroutineContext[Job]) pollTask = null
                    } else { busy = false; task = null; saved = service.saved() }
                }
            }
        }
        if (silent) pollTask = current else task = current
        current.start()
    }
}
