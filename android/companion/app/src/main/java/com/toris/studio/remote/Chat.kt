package com.toris.studio.remote

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

internal fun chatStatusLabel(value: String): String = when (value) {
    "running" -> "실행 중"; "needs_input" -> "입력 필요"; "done" -> "완료"; "failed" -> "실패"; "idle" -> "대기"
    else -> "상태 확인 필요"
}
internal fun agentLabel(value: String?): String = when (value) { "claude" -> "Claude Code"; "codex" -> "Codex"; else -> "에이전트" }
internal fun modeLabel(value: String?): String = when (value) { "plan" -> "계획"; "edit" -> "편집"; else -> "모드 확인 필요" }

/** Card titles for planner traffic; null means the message is not a planner card. */
internal fun plannerCardTitle(message: ChatMessage): String? {
    val planner = message.planner ?: "기획자"
    return when (message.kind) {
        "planner_reply" -> "$planner 기획"
        "planner_request" -> "${planner}에게 보낸 요청"
        "hosted_request" -> "$planner 기획 요청"
        else -> null
    }
}

internal const val REPLY_DISABLED_NOTE = "답장은 Mac의 설정 → 모바일 연결에서 '대화 답장 허용'을 켠 기기에서만 보낼 수 있습니다."

@Composable
internal fun ChatHome(controller: RemoteController, onOpen: (String) -> Unit) {
    val (running, needsInput) = controller.chatCounts
    LazyColumn(Modifier.fillMaxSize(), contentPadding = ScreenPadding, verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("대화", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text("Mac의 프로젝트 대화를 확인하세요.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                TextButton(onClick = controller::refreshChats, enabled = !controller.busy) { Text("새로고침") }
            }
        }
        item {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = !controller.chatNeedsInputOnly, onClick = { controller.setNeedsInputOnly(false) },
                    enabled = !controller.busy, label = { Text("전체 · 실행 중 $running") })
                FilterChip(selected = controller.chatNeedsInputOnly, onClick = { controller.setNeedsInputOnly(true) },
                    enabled = !controller.busy, label = { Text("입력 필요 $needsInput") })
            }
        }
        val chats = controller.chats
        when {
            chats.isEmpty() && controller.chatListError != null -> item {
                StudioCard {
                    Text("대화를 불러오지 못했습니다", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    Text(controller.chatListError ?: "", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    OutlinedButton(onClick = controller::refreshChats, enabled = !controller.busy) { Text("다시 시도") }
                }
            }
            chats.isEmpty() && !controller.chatLoaded -> item {
                StudioCard { Text("대화를 불러오는 중입니다", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold) }
            }
            chats.isEmpty() -> item {
                StudioCard {
                    Text(if (controller.chatNeedsInputOnly) "입력이 필요한 대화가 없습니다" else "표시할 대화가 없습니다",
                        style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    Text(if (controller.chatNeedsInputOnly) "전체를 선택하면 다른 대화를 볼 수 있습니다."
                        else "Mac이 이 기기에 공개한 대화가 없습니다. Mac의 설정 → 모바일 연결에서 대화 프로젝트를 허용하세요.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        items(chats, key = { it.threadId }) { conversation -> ChatCard(conversation) { onOpen(conversation.threadId) } }
        if (controller.chatNextOffset != null) item {
            OutlinedButton(onClick = controller::loadMoreChats, enabled = !controller.busy, modifier = Modifier.fillMaxWidth()) { Text("이전 대화 더 보기") }
        }
    }
}

@Composable
private fun ChatCard(conversation: ChatConversation, onClick: () -> Unit) {
    Surface(onClick = onClick, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surface, border = BorderStroke(1.dp, MaterialTheme.colorScheme.surfaceVariant)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f).padding(end = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(conversation.title, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(conversation.projectName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                StatusBadge(chatStatusLabel(conversation.status), conversation.status)
            }
            conversation.preview?.let {
                Text(it, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("${agentLabel(conversation.agent)} · ${modeLabel(conversation.mode)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                shortDate(conversation.lastActivity)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
    }
}

@Composable
internal fun ChatDetailScreen(controller: RemoteController, onBack: () -> Unit) {
    val detail = controller.chat
    if (detail == null) {
        Column(Modifier.fillMaxSize().padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Text("대화", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            StudioCard {
                val error = controller.chatError
                Text(if (error != null) "대화를 불러오지 못했습니다" else "대화를 불러오는 중입니다", fontWeight = FontWeight.SemiBold)
                if (error != null) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (error != null) OutlinedButton(onClick = { controller.refreshChat() }, enabled = !controller.busy) { Text("다시 시도") }
                    OutlinedButton(onClick = onBack) { Text("대화 목록") }
                }
            }
        }
        return
    }
    val conversation = detail.conversation
    val listState = rememberLazyListState()
    val pending = controller.saved.reply?.takeIf { it.threadId == conversation.threadId }
    LaunchedEffect(conversation.threadId, detail.messages.size, detail.messages.lastOrNull()?.id) {
        if (detail.messages.isNotEmpty()) listState.scrollToItem(detail.messages.size)
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(conversation.title, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Text(conversation.projectName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                StatusBadge(chatStatusLabel(conversation.status), conversation.status)
                StatusBadge(agentLabel(conversation.agent), "idle")
                StatusBadge(modeLabel(conversation.mode), "idle")
            }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState,
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                if (detail.truncated) Text("이전 메시지는 Mac에서 확인하세요. 최근 메시지만 표시합니다.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                else if (detail.messages.isEmpty()) Text("아직 메시지가 없습니다.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            items(detail.messages, key = { it.id }) { message -> MessageRow(message, conversation.agent) }
        }
        Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                when {
                    pending != null -> {
                        Text("Mac이 이 답장을 받았는지 확인하지 못했습니다. 다시 보내도 한 번만 처리됩니다.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(pending.text, maxLines = 3, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = controller::resendReply, enabled = !controller.busy) { Text("다시 보내기") }
                            TextButton(onClick = controller::discardReply, enabled = !controller.busy) { Text("보내지 않기") }
                        }
                    }
                    controller.saved.reply != null -> Text("다른 대화에 확인되지 않은 답장이 있습니다. 그 대화에서 먼저 다시 보내거나 취소하세요.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    !detail.canReply -> Text(REPLY_DISABLED_NOTE, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else -> {
                        val running = conversation.status == "running"
                        if (running) Text("에이전트가 답하는 중입니다", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(value = controller.draft, onValueChange = controller::changeDraft,
                                placeholder = { Text("답장 입력") }, enabled = !controller.busy,
                                supportingText = { Text("${controller.draft.trim().codePointCount(0, controller.draft.trim().length)} / 2,000") },
                                modifier = Modifier.weight(1f), maxLines = 6)
                            Button(onClick = controller::sendReply, enabled = controller.canCompose && !controller.busy && controller.draft.isNotBlank()) { Text("보내기") }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageRow(message: ChatMessage, agent: String?) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    plannerCardTitle(message)?.let { title ->
        StudioCard {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(title, modifier = Modifier.weight(1f).padding(end = 8.dp), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                if (message.kind == "hosted_request") {
                    val answered = message.answered == true
                    StatusBadge(if (answered) "답장 도착" else "답장 대기", if (answered) "done" else "needs_input")
                }
            }
            Text(message.text, style = MaterialTheme.typography.bodyMedium)
            shortDate(message.at)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = muted) }
        }
        return
    }
    when (message.kind) {
        "user", "assistant" -> {
            val mine = message.kind == "user"
            Box(Modifier.fillMaxWidth(), contentAlignment = if (mine) Alignment.CenterEnd else Alignment.CenterStart) {
                Column(Modifier.widthIn(max = 320.dp), horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
                    verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(if (mine) "나" else agentLabel(agent), style = MaterialTheme.typography.labelSmall, color = muted)
                    Text(message.text, Modifier
                        .background(if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                            RoundedCornerShape(14.dp))
                        .padding(horizontal = 12.dp, vertical = 9.dp),
                        color = if (mine) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.bodyMedium)
                    shortDate(message.at)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = muted) }
                }
            }
        }
        "error" -> Text("오류: ${message.text}", Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        "result" -> Text("결과: ${message.text}", Modifier.fillMaxWidth(), color = muted, style = MaterialTheme.typography.bodySmall)
        else -> Text(message.text, Modifier.fillMaxWidth(), color = muted, style = MaterialTheme.typography.bodySmall)
    }
}
