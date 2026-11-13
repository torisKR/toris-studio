package com.toris.studio.remote

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.util.Locale

@Composable
internal fun WorkDetail(controller: RemoteController, onBack: () -> Unit, onCancel: () -> Unit, onNew: () -> Unit) {
    val run = controller.run
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(18.dp)) {
        if (run == null) {
            Text("작업 상세", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            StudioCard {
                Text(if (controller.busy) "Mac에 요청을 보내는 중입니다." else "아직 작업 상태를 가져오지 못했습니다.")
                Text("연결 상태를 확인하거나 작업 목록으로 돌아가세요.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                OutlinedButton(onClick = onBack) { Text("작업 목록") }
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text(runTitle(run), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(run.projectName ?: "모바일 팩토리", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    StatusBadge(phaseLabel(run), if (run.phase == "done" && run.verdict == "incomplete") "incomplete" else run.phase)
                    if (!run.terminal && !run.stale && run.phase != "unavailable") {
                        OutlinedButton(onClick = onCancel, enabled = !controller.busy) { Text("작업 취소") }
                    }
                }
            }
            if (run.approvals.isNotEmpty()) StudioCard {
                SectionHeading("Mac에서 확인이 필요합니다")
                run.approvals.forEach { Text(it, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium) }
                Text("Mac의 팩토리 화면에서 내용을 보고 결정할 수 있습니다.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
            StudioCard {
                SectionHeading("작업 정보")
                Text("작업 ID", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(run.runId, style = MaterialTheme.typography.bodySmall)
                shortDate(run.createdAt)?.let { KeyValue("시작", it) }
                shortDate(run.updatedAt)?.let { KeyValue("마지막 변경", it) }
                KeyValue("상태 순번", run.sequence.toString())
                if (run.stale) Text("Mac에서 현재 상태를 확인하지 못해 마지막으로 저장한 결과를 보여줍니다.",
                    color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                if (run.phase == "unavailable") Text("Mac에 남아 있는 상태 기록이 없습니다.", style = MaterialTheme.typography.bodySmall)
                OutlinedButton(onClick = { controller.refresh() }, enabled = !controller.busy) { Text("상태 새로고침") }
            }
            if (run.phase == "failed") StudioCard {
                SectionHeading("작업이 중단됐습니다")
                Text(if (run.interrupted) "Mac 앱이 종료되어 작업이 멈췄습니다. 내용을 확인한 뒤 새 작업으로 다시 시작할 수 있습니다." else "상세 오류는 Mac에서 확인하세요.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (run.activity.isNotEmpty()) StudioCard {
                SectionHeading("최근 활동", "Mac이 전한 상태 변화만 표시합니다.")
                run.activity.forEach { event ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Column(Modifier.weight(1f).padding(end = 8.dp)) {
                            Text(event.stages.takeIf { it.isNotEmpty() }?.joinToString(" · ") { jobLabel(it) }
                                ?: phaseLabel(run.copy(phase = event.phase, verdict = null)), style = MaterialTheme.typography.bodyMedium)
                            shortDate(event.at)?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }
                        }
                        Text("#${event.sequence}", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
            StudioCard {
                SectionHeading("진행 단계", "Mac에서 전달한 단계와 상태입니다.")
                if (run.jobs.isEmpty()) Text("아직 표시할 단계 결과가 없습니다.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                run.jobs.forEach { job ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Column(Modifier.weight(1f).padding(end = 8.dp)) {
                            Text(jobLabel(job.id), style = MaterialTheme.typography.bodyMedium)
                            val reason = when (job.reason) {
                                "tool_not_run" -> "필요한 도구가 실행되지 않았습니다."
                                "dependency" -> "앞 단계가 끝나지 않아 진행하지 못했습니다."
                                "mac_approval" -> "Mac에서 승인을 기다립니다."
                                else -> if (job.status == "failed") "상세 오류는 Mac에서 확인하세요." else null
                            }
                            if (reason != null) Text(reason, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                        }
                        StatusBadge(statusLabel(job.status), job.status)
                    }
                }
            }
            StudioCard {
                SectionHeading("검증과 결과")
                KeyValue("검증 판정", statusLabel(run.verdict))
                val required = run.gates.filter { it.required }
                if (required.isNotEmpty()) KeyValue("필수 검사", "${required.count { it.status == "passed" }} / ${required.size} 통과")
                run.template?.let { KeyValue("결과 출처", if (it) "템플릿" else "모델 결과") }
                run.costUsd?.let { KeyValue("기록된 API 비용", String.format(Locale.ROOT, "%.2f USD", it)) }
                if (run.kind != null) KeyValue("종류", valueLabel(run.kind))
                if (run.genre != null) KeyValue("장르", valueLabel(run.genre))
                if (run.view != null) KeyValue("화면", valueLabel(run.view))
                if (run.orientation != null) KeyValue("방향", valueLabel(run.orientation))
                run.gates.forEach { gate ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(gateLabel(gate.name) + if (gate.required) " · 필수" else " · 선택",
                            modifier = Modifier.weight(1f).padding(end = 8.dp), style = MaterialTheme.typography.bodyMedium)
                        StatusBadge(statusLabel(gate.status), gate.status)
                    }
                }
                Text("실행하지 않은 검사는 통과로 표시하지 않습니다.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
            if (run.terminal) Button(onClick = onNew, modifier = Modifier.fillMaxWidth()) { Text("새 작업 만들기") }
        }
    }
}
