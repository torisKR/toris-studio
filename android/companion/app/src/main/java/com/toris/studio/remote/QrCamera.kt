package com.toris.studio.remote

import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@androidx.annotation.OptIn(ExperimentalGetImage::class)
@Composable
internal fun QrCamera(onCode: (String) -> Unit, onError: (String) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val cameraView = remember { PreviewView(context) }
    val currentCode = rememberUpdatedState(onCode)
    val currentError = rememberUpdatedState(onError)
    DisposableEffect(owner, cameraView) {
        val disposed = AtomicBoolean(false)
        val found = AtomicBoolean(false)
        val executor = Executors.newSingleThreadExecutor()
        val mainExecutor = ContextCompat.getMainExecutor(context)
        val scanner = BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
        val future = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        future.addListener({
            if (!disposed.get()) try {
                provider = future.get()
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(cameraView.surfaceProvider) }
                val analyzer = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                analyzer.setAnalyzer(executor) { frame ->
                    val image = frame.image
                    if (image == null || found.get() || disposed.get()) frame.close()
                    else {
                        try {
                            scanner.process(InputImage.fromMediaImage(image, frame.imageInfo.rotationDegrees))
                                .addOnSuccessListener { codes ->
                                    val value = codes.firstOrNull { it.format == Barcode.FORMAT_QR_CODE }?.rawValue
                                    if (value != null && !disposed.get() && found.compareAndSet(false, true)) currentCode.value(value)
                                }
                                .addOnCompleteListener { frame.close() }
                        } catch (_: Exception) { frame.close() }
                    }
                }
                provider?.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analyzer)
            } catch (_: Exception) { if (!disposed.get()) currentError.value("카메라를 열지 못했습니다. 권한과 카메라 사용 상태를 확인하세요.") }
        }, mainExecutor)
        onDispose {
            disposed.set(true)
            provider?.unbindAll()
            scanner.close()
            executor.shutdown()
        }
    }
    AndroidView(factory = { cameraView }, modifier = Modifier.fillMaxWidth().height(320.dp))
}
