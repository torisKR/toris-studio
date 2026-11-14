package com.toris.studio.remote

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

private enum class RunFilter(val label: String) { ALL("전체"), ACTIVE("진행 중"), WAITING("승인 대기"), FINISHED("종료") }

@Composable
internal fun WorkHome(controller: RemoteController, onNew: () -> Unit, onOpen: (String) -> Unit, onConnect: () -> Unit) {
    var filter by remember { mutableStateOf(RunFilter.ALL) }
    val visible = controller.runs.filter { run ->
        when (filter) {
            RunFilter.ALL -> true
            RunFilter.ACTIVE -> !run.terminal && run.phase !in setOf("awaiting_approval", "unavailable")
            RunFilter.WAITING -> run.phase == "awaiting_approval"
            RunFilter.FINISHED -> run.terminal
        }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = ScreenPadding, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("내 작업", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text("Mac에 맡긴 작업을 확인하세요.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                TextButton(onClick = onNew) { Text("+ 새 작업") }
            }
        }
        item {
            Surface(onClick = onConnect, modifier = Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surface,
                shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, MaterialTheme.colorScheme.surfaceVariant)) {
                Row(Modifier.padding(14.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(Modifier.weight(1f)) {
                        Text("내 Mac", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        Text(if (controller.online) "최근 사설 네트워크 연결 확인" else "연결 상태 확인 필요",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    StatusBadge(if (controller.online) "연결 확인됨" else "연결 확인", if (controller.online) "passed" else "blocked")
                }
            }
        }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    SectionHeading("작업 목록", "불러온 작업 ${controller.runs.size} · 승인 대기 ${controller.runs.count { it.phase == "awaiting_approval" }}")
                }
                TextButton(onClick = controller::refreshList, enabled = !controller.busy) { Text("새로고침") }
            }
        }
        item {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RunFilter.entries.forEach { option ->
                    FilterChip(selected = filter == option, onClick = { filter = option }, label = { Text(option.label) })
                }
            }
        }
        if (visible.isEmpty()) item {
            StudioCard {
                Text(if (controller.busy && controller.runs.isEmpty()) "작업을 불러오는 중입니다" else "표시할 작업이 없습니다",
                    style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(if (!controller.online) "Mac 앱과 네트워크를 확인한 뒤 다시 연결하세요."
                    else if (filter != RunFilter.ALL) "다른 상태를 선택해 보세요."
                    else "새 작업을 만들면 이곳에 진행 상황과 결과가 표시됩니다.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (filter == RunFilter.ALL) TextButton(onClick = onNew) { Text("새 작업 만들기") }
            }
        }
        items(visible, key = { it.runId }) { run -> WorkCard(run) { onOpen(run.runId) } }
        if (controller.nextOffset != null) item {
            OutlinedButton(onClick = controller::loadMore, enabled = !controller.busy, modifier = Modifier.fillMaxWidth()) { Text("이전 작업 더 보기") }
        }
    }
}

@Composable
private fun WorkCard(run: RunSnapshot, onClick: () -> Unit) {
    Surface(onClick = onClick, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surface, border = BorderStroke(1.dp, MaterialTheme.colorScheme.surfaceVariant)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f).padding(end = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(runTitle(run), maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(run.projectName ?: "모바일 팩토리", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                StatusBadge(phaseLabel(run), if (run.phase == "done" && run.verdict == "incomplete") "incomplete" else run.phase)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("작업 ${run.runId.take(8)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(if (run.stale) "마지막 저장 상태" else shortDate(run.updatedAt) ?: "Mac 상태", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
