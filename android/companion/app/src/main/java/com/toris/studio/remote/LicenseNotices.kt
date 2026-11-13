package com.toris.studio.remote

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import org.json.JSONObject

@Composable
internal fun LicenseNotices(onDismiss: () -> Unit) {
    val assets = LocalContext.current.assets
    val index = remember(assets) {
        JSONObject(assets.open("licenses/mlkit-barcode-third-party.json").bufferedReader().use { it.readText() })
    }
    val googleNames = remember(index) { index.keys().asSequence().toList().sorted() }
    val jschFiles = mapOf("JSch" to "jsch.txt", "JSch jbcrypt" to "jsch-jbcrypt.txt", "JSch jzlib" to "jsch-jzlib.txt")
    var notice by remember { mutableStateOf<Pair<String, String>?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(notice?.first ?: "라이선스 및 개인정보") },
        text = {
            if (notice == null) LazyColumn(Modifier.heightIn(max = 450.dp)) {
                item {
                    Text("QR 이미지와 스캔 결과는 기기에서 처리됩니다. Google은 ML Kit SDK 성능·사용 통계를 수집할 수 있습니다. 약관: developers.google.com/ml-kit/terms")
                    Text("SSH 라이브러리 고지")
                }
                items(jschFiles.keys.toList()) { name ->
                    TextButton(onClick = {
                        notice = name to assets.open("licenses/${jschFiles.getValue(name)}").bufferedReader().use { it.readText() }
                    }) { Text(name) }
                }
                item { Text("ML Kit 바코드 스캔 구성요소 고지") }
                items(googleNames) { name ->
                    TextButton(onClick = {
                        val entry = index.getJSONObject(name)
                        val start = entry.getInt("start")
                        val length = entry.getInt("length")
                        val bytes = assets.open("licenses/mlkit-barcode-third-party.txt").use { it.readBytes() }
                        notice = name to bytes.copyOfRange(start, start + length).toString(Charsets.UTF_8)
                    }) { Text(name) }
                }
            } else Column(Modifier.heightIn(max = 450.dp).verticalScroll(rememberScrollState())) {
                Text(notice!!.second)
            }
        },
        confirmButton = { TextButton(onClick = { if (notice == null) onDismiss() else notice = null }) { Text(if (notice == null) "닫기" else "목록으로") } },
    )
}
