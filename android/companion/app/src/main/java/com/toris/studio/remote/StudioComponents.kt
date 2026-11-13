package com.toris.studio.remote

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter

internal val ScreenPadding = PaddingValues(horizontal = 20.dp, vertical = 20.dp)

@Composable
internal fun StudioCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier = modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, MaterialTheme.colorScheme.surfaceVariant)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
    }
}

@Composable
internal fun SectionHeading(title: String, subtitle: String? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun StatusBadge(text: String, state: String?) {
    val color = when (state) {
        "done", "passed", "pass" -> Color(0xFF90D5B1)
        "awaiting_approval", "waiting_approval", "blocked", "incomplete" -> Color(0xFFFFD087)
        "failed", "fail" -> MaterialTheme.colorScheme.error
        "cancelled", "unavailable", "not_run", "interrupted" -> MaterialTheme.colorScheme.onSurfaceVariant
        else -> MaterialTheme.colorScheme.primary
    }
    Surface(color = color.copy(alpha = 0.12f), shape = RoundedCornerShape(7.dp)) {
        Text(text, Modifier.padding(horizontal = 9.dp, vertical = 5.dp), color = color,
            style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
internal fun KeyValue(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
    }
}

internal fun phaseLabel(run: RunSnapshot): String = when (run.phase) {
    "queued" -> "대기 중"
    "thinking", "reading" -> "계획 중"
    "coding" -> "제작 중"
    "testing", "reviewing" -> "검증 중"
    "awaiting_approval" -> "Mac 승인 대기"
    "waiting" -> "대기 중"
    "done" -> if (run.verdict == "incomplete") "검증 보류" else "작업 종료"
    "failed" -> if (run.interrupted) "Mac 종료로 중단" else "오류로 중단"
    "cancelled" -> "취소됨"
    "unavailable" -> "상태 없음"
    else -> "상태 확인 필요"
}

internal fun statusLabel(value: String?): String = when (value) {
    "queued" -> "대기"; "running" -> "진행 중"; "waiting_approval" -> "Mac 승인 대기"
    "passed", "pass" -> "통과"; "failed", "fail" -> "실패"; "blocked" -> "보류"
    "cancelled" -> "취소"; "interrupted" -> "중단"; "not_run" -> "실행하지 않음"
    "incomplete" -> "미완료 검사 있음"
    null -> "아직 없음"
    else -> "확인 필요"
}

internal fun valueLabel(value: String?): String = when (value) {
    "game" -> "게임"; "app" -> "앱"; "2d" -> "2D"; "3d" -> "3D"; "ui" -> "UI"
    "landscape" -> "가로"; "portrait" -> "세로"
    "action-rpg" -> "액션 RPG"; "defense" -> "디펜스"; "strategy" -> "전략"; "fishing" -> "낚시"
    "horror" -> "공포"; "utility" -> "도구"; "productivity" -> "생산성"
    "combat" -> "전투"; "dodge" -> "회피"; "xp" -> "경험치"; "game-over" -> "게임 오버"
    "npc-dialogue" -> "대화"; "quest" -> "퀘스트"; "inventory" -> "인벤토리"
    "save-load" -> "저장·불러오기"; "tutorial" -> "튜토리얼"; "settings" -> "설정"
    "list" -> "목록"; "form" -> "입력 화면"
    null -> "미제공"
    else -> "확인 필요"
}

internal fun gateLabel(value: String): String = when (value) {
    "plan" -> "계획"; "code" -> "코드"; "asset" -> "에셋"; "model3d" -> "3D 모델"
    "gameplay" -> "플레이"; "android" -> "Android"; "release" -> "배포"
    else -> "검사"
}

internal fun jobLabel(value: String): String = when (value) {
    "spec-approved" -> "명세 검사"; "scaffold-project" -> "프로젝트 준비"
    "game-design" -> "게임 기획"; "app-design" -> "앱 기획"; "character-base" -> "캐릭터 기획"
    "sprite-atlas" -> "스프라이트 제작"; "vfx-export" -> "효과 제작"; "model-export" -> "3D 모델 제작"
    "gameplay-core" -> "게임 동작"; "screen-core" -> "앱 화면"; "level-content" -> "레벨 구성"
    "asset-integration" -> "에셋 연결"; "lint-and-import" -> "가져오기 검사"; "headless-tests" -> "자동 테스트"
    "android-debug-build" -> "Android 빌드"; "adb-smoke-test" -> "기기 설치 검사"; "release-review" -> "릴리스 검토"
    else -> "작업 단계"
}

internal fun runTitle(run: RunSnapshot): String {
    run.title?.takeIf { it.isNotBlank() }?.let { return it }
    val kind = run.kind?.let(::valueLabel)
    val genre = run.genre?.let(::valueLabel)
    return when {
        kind != null && genre != null -> "$genre $kind"
        kind != null -> "$kind 제작"
        else -> run.projectName ?: "팩토리 작업"
    }
}

internal fun shortDate(value: String?): String? = try {
    value?.let { OffsetDateTime.parse(it).atZoneSameInstant(java.time.ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("M.d HH:mm")) }
} catch (_: Exception) { null }
