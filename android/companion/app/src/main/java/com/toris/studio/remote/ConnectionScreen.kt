package com.toris.studio.remote

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

@Composable
internal fun ConnectionScreen(controller: RemoteController, onLicenses: () -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    var cameraGranted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var denied by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        cameraGranted = granted
        denied = !granted
        if (granted) controller.scan()
    }
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) cameraGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Mac 연결", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Text("같은 사설 네트워크에서 내 Mac에 연결합니다.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        controller.saved.mac?.let { mac ->
            StudioCard {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(Modifier.weight(1f)) { SectionHeading("등록된 Mac", "Mac과 Toris Studio가 켜져 있어야 합니다.") }
                    StatusBadge(if (controller.online) "연결 확인됨" else "연결 확인", if (controller.online) "passed" else "blocked")
                }
                KeyValue("주소", "${mac.host}:${mac.port}")
                Text("Mac 호스트 지문", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(mac.fingerprint, style = MaterialTheme.typography.bodySmall)
                OutlinedButton(onClick = controller::connect, enabled = !controller.busy) { Text("연결 및 작업 새로고침") }
            }
        }
        StudioCard {
            SectionHeading(if (controller.saved.mac == null) "처음 연결하기" else "다시 등록하기",
                "Mac 설정 → 모바일 연결에서 기기 추가를 선택하세요.")
            if (controller.saved.mac != null) Text("같은 기기를 다시 등록하려면 Mac에서 기존 기기 등록을 해제한 뒤 새 QR을 발급하세요.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(controller.deviceName, { controller.deviceName = it.take(60) },
                label = { Text("이 기기의 이름") }, enabled = !controller.busy, modifier = Modifier.fillMaxWidth(), singleLine = true)
            if (!controller.scanning) {
                Button(enabled = !controller.busy, onClick = {
                    if (cameraGranted) controller.scan() else permission.launch(Manifest.permission.CAMERA)
                }) { Text("QR 스캔") }
            } else {
                Text("Mac에 표시된 QR 코드를 카메라에 맞춰 주세요.", style = MaterialTheme.typography.bodySmall)
                QrCamera(onCode = controller::scanned, onError = controller::scanError)
                OutlinedButton(onClick = controller::stopScan) { Text("스캔 취소") }
            }
            if (denied && !cameraGranted) {
                Text("카메라 권한이 거부되었습니다. 다시 요청하거나 설정에서 허용할 수 있습니다.", color = MaterialTheme.colorScheme.error)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { permission.launch(Manifest.permission.CAMERA) }) { Text("다시 요청") }
                    OutlinedButton(onClick = {
                        context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
                    }) { Text("설정 열기") }
                }
            }
            controller.code?.let { code ->
                Text("확인 코드", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(code, style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
                Text("이 기기 지문", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(controller.deviceFingerprint, style = MaterialTheme.typography.bodySmall)
                Text("Mac의 코드와 기기 지문이 모두 일치하는지 비교한 뒤 Mac에서 승인하세요.")
            }
        }
        StudioCard {
            SectionHeading("연결 안내")
            Text("Mac이 잠들었거나 앱이 꺼져 있으면 다시 연결할 수 없습니다. 네트워크 오류만으로 잠자기 여부를 단정하지 않습니다.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("기기를 분실했거나 키를 잃었다면 Mac 설정에서 기기를 등록 해제하고 필요한 경우 다시 등록하세요.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = onLicenses) { Text("오픈소스 및 QR 라이선스") }
        }
    }
}
