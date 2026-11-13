package com.toris.studio.remote

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable
internal fun CreateWork(controller: RemoteController, onStart: () -> Unit, onRecover: () -> Unit) {
    Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("새 작업", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Text("요청을 입력하면 Mac의 팩토리가 실행합니다.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (controller.saved.requestId != null) StudioCard {
            SectionHeading("이전 요청 확인", "연결이 끊겨도 Mac에서 작업이 진행됐을 수 있습니다.")
            Text("요청 ID: ${controller.saved.requestId}", style = MaterialTheme.typography.bodySmall)
            OutlinedButton(onClick = onRecover, enabled = !controller.busy) { Text("이전 요청 복구") }
            if (controller.saved.runId == null) Text("같은 프로젝트와 입력으로 다시 보내면 같은 요청 ID를 사용합니다.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        StudioCard {
            SectionHeading("1. 프로젝트", "Mac에서 이 기기에 허용한 항목만 표시합니다.")
            if (controller.projects.isEmpty()) {
                Text("허용된 프로젝트가 없습니다. Mac의 모바일 연결 권한을 확인하세요.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedButton(onClick = controller::connect, enabled = !controller.busy) { Text("프로젝트 불러오기") }
            }
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                controller.projects.forEach { project ->
                    FilterChip(selected = controller.selectedProject?.id == project.id, enabled = !controller.busy,
                        onClick = { controller.select(project) }, label = { Text(project.name) })
                }
            }
            if (controller.projects.size > 2) Text("옆으로 넘겨 더 많은 항목을 볼 수 있습니다.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        StudioCard {
            SectionHeading("2. 요청", "만들고 싶은 앱이나 게임을 설명해 주세요.")
            OutlinedTextField(value = controller.brief, onValueChange = controller::changeBrief,
                label = { Text("제작 요청") }, placeholder = { Text("예: 픽셀 낚시 게임을 만들어줘") },
                supportingText = { Text("${controller.brief.length} / 2,000") },
                enabled = !controller.busy, modifier = Modifier.fillMaxWidth(), minLines = 4)
            Text("종류", style = MaterialTheme.typography.labelLarge)
            ChoiceChips(listOf("game" to "게임", "app" to "앱"), controller.kind) { if (it != null) controller.changeKind(it) }
            Text("화면", style = MaterialTheme.typography.labelLarge)
            if (controller.kind == "app") Text("UI · 앱은 화면 중심으로 만듭니다.", style = MaterialTheme.typography.bodyMedium)
            else ChoiceChips(listOf("2d" to "2D", "3d" to "3D", "ui" to "UI"), controller.view, controller::changeView)
            Text("방향", style = MaterialTheme.typography.labelLarge)
            ChoiceChips(listOf("portrait" to "세로", "landscape" to "가로"), controller.orientation, controller::changeOrientation)
            Text("선택하지 않은 화면과 방향은 Mac에서 결정합니다.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (controller.preview != null) itemPreview(controller.preview!!)
        OutlinedButton(onClick = controller::makePreview, enabled = !controller.busy && controller.selectedProject != null && controller.brief.isNotBlank(),
            modifier = Modifier.fillMaxWidth()) { Text("명세 미리보기") }
        Button(onClick = onStart, enabled = !controller.busy && controller.selectedProject != null && controller.brief.isNotBlank() && controller.saved.runId == null,
            modifier = Modifier.fillMaxWidth()) {
            Text(if (controller.saved.requestId == null) "Mac에서 작업 시작" else "같은 요청 다시 보내기")
        }
        Text("유료 API, 기기 설치 등 승인이 필요한 일은 Mac에서 결정합니다.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ChoiceChips(options: List<Pair<String, String>>, selected: String?, onChange: (String?) -> Unit) {
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { (value, label) ->
            FilterChip(selected = selected == value, onClick = { onChange(if (selected == value) null else value) }, label = { Text(label) })
        }
    }
}

@Composable
private fun itemPreview(value: Preview) {
    StudioCard {
        SectionHeading("Mac 미리보기", "규칙으로 만든 명세이며 실제 실행 결과가 아닙니다.")
        KeyValue("출처", if (value.template == true) "템플릿" else "확인 필요")
        KeyValue("종류", valueLabel(value.kind))
        KeyValue("장르", valueLabel(value.genre))
        KeyValue("화면", valueLabel(value.view))
        KeyValue("방향", valueLabel(value.orientation))
        Text("기능: ${value.features.joinToString { valueLabel(it) }.ifEmpty { "미제공" }}", style = MaterialTheme.typography.bodyMedium)
        KeyValue("API 비용 상한", value.maxApiCostUsd?.let { "$it USD" } ?: "미제공")
    }
}
