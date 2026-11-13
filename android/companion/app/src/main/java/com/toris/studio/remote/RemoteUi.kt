package com.toris.studio.remote

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay

private enum class Screen { WORK, CREATE, CONNECTION, DETAIL }

@Composable
internal fun RemoteScreen(controller: RemoteController) {
    val owner = LocalLifecycleOwner.current
    var screen by remember { mutableStateOf(if (controller.saved.mac == null) Screen.CONNECTION else Screen.WORK) }
    var hadMac by remember { mutableStateOf(controller.saved.mac != null) }
    var showNewWarning by remember { mutableStateOf(false) }
    var showLicenses by remember { mutableStateOf(false) }
    var showCancel by remember { mutableStateOf(false) }

    fun goToCreate() {
        if (controller.prepareNew()) screen = Screen.CREATE else showNewWarning = true
    }
    BackHandler(enabled = screen == Screen.DETAIL) { screen = Screen.WORK }
    LaunchedEffect(controller.saved.mac) {
        if (controller.saved.mac != null && !hadMac) screen = Screen.WORK
        hadMac = controller.saved.mac != null
    }
    LaunchedEffect(owner, screen, controller.selectedRunId, controller.run?.terminal) {
        owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                delay(if (screen == Screen.DETAIL) 4000 else 10000)
                if (screen == Screen.DETAIL && controller.selectedRunId != null && controller.run?.terminal != true) controller.pollSelected()
                if (screen == Screen.WORK) controller.pollDashboard()
            }
        }
    }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Column(Modifier.statusBarsPadding()) {
                StudioHeader(onBack = if (screen == Screen.DETAIL) ({ screen = Screen.WORK }) else null)
                if (controller.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        bottomBar = {
            if (controller.saved.mac != null && !controller.scanning) NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                NavigationBarItem(selected = screen == Screen.WORK || screen == Screen.DETAIL,
                    onClick = { screen = Screen.WORK }, icon = { Text("▤", Modifier.clearAndSetSemantics { }, style = MaterialTheme.typography.titleLarge) }, label = { Text("작업") })
                NavigationBarItem(selected = screen == Screen.CREATE, onClick = ::goToCreate,
                    icon = { Text("+", Modifier.clearAndSetSemantics { }, style = MaterialTheme.typography.titleLarge) }, label = { Text("새 작업") })
                NavigationBarItem(selected = screen == Screen.CONNECTION, onClick = { screen = Screen.CONNECTION },
                    icon = { Text("◎", Modifier.clearAndSetSemantics { }, style = MaterialTheme.typography.titleLarge) }, label = { Text("연결") })
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding)) {
            controller.message?.let { message ->
                Surface(color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(start = 20.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(message, modifier = Modifier.weight(1f).padding(vertical = 12.dp), style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = controller::clearMessage) { Text("닫기") }
                    }
                }
            }
            when (screen) {
                Screen.WORK -> WorkHome(controller, onNew = ::goToCreate, onOpen = { id -> controller.openRun(id); screen = Screen.DETAIL }, onConnect = { screen = Screen.CONNECTION })
                Screen.CREATE -> CreateWork(controller, onStart = { controller.startOrRetry(); screen = Screen.DETAIL }, onRecover = { controller.recover(); screen = Screen.DETAIL })
                Screen.CONNECTION -> ConnectionScreen(controller, onLicenses = { showLicenses = true })
                Screen.DETAIL -> WorkDetail(controller, onBack = { screen = Screen.WORK }, onCancel = { showCancel = true }, onNew = ::goToCreate)
            }
        }
    }
    if (showNewWarning) AlertDialog(
        onDismissRequest = { showNewWarning = false },
        title = { Text("이전 요청을 확인해 주세요") },
        text = { Text("이전 작업이 Mac에서 계속 실행 중일 수 있습니다. 먼저 작업 목록이나 Mac에서 상태를 확인하세요. 새 요청을 만들면 별도 작업이 생길 수 있습니다.") },
        confirmButton = { TextButton(onClick = { showNewWarning = false; controller.newAfterWarning(); screen = Screen.CREATE }) { Text("확인 후 새 요청") } },
        dismissButton = { TextButton(onClick = { showNewWarning = false; screen = Screen.WORK }) { Text("작업 확인") } },
    )
    if (showCancel) AlertDialog(
        onDismissRequest = { showCancel = false },
        title = { Text("이 작업을 취소할까요?") },
        text = { Text("이 휴대폰에서 시작한 작업에 취소를 요청합니다. Mac에서 처리한 뒤 상태가 바뀝니다.") },
        confirmButton = { TextButton(onClick = { showCancel = false; controller.cancelRun() }) { Text("작업 취소") } },
        dismissButton = { TextButton(onClick = { showCancel = false }) { Text("돌아가기") } },
    )
    if (showLicenses) LicenseNotices { showLicenses = false }
}

@Composable
private fun StudioHeader(onBack: (() -> Unit)?) {
    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background).padding(horizontal = 20.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        if (onBack != null) TextButton(onClick = onBack) { Text("‹  작업") }
        else Box(Modifier.size(34.dp).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
            Text("T", Modifier.clearAndSetSemantics { }, color = MaterialTheme.colorScheme.onPrimaryContainer, fontWeight = FontWeight.Bold)
        }
        Column {
            Text("TORIS STUDIO", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
            Text("모바일 작업 공간", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
