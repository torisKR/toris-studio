package com.toris.studio.remote

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color

private val StudioColors = darkColorScheme(
    primary = Color(0xFFB6C9FF),
    onPrimary = Color(0xFF15213B),
    primaryContainer = Color(0xFF263B62),
    onPrimaryContainer = Color(0xFFE3EBFF),
    secondary = Color(0xFFBACBE4),
    onSecondary = Color(0xFF24354D),
    secondaryContainer = Color(0xFF2C405C),
    onSecondaryContainer = Color(0xFFE0EAFF),
    background = Color(0xFF0A1019),
    onBackground = Color(0xFFE7EDF7),
    surface = Color(0xFF101925),
    onSurface = Color(0xFFE7EDF7),
    surfaceVariant = Color(0xFF1B2735),
    onSurfaceVariant = Color(0xFFB7C4D5),
    outline = Color(0xFF68798D),
    error = Color(0xFFFFB4AB),
    errorContainer = Color(0xFF5E2527),
    onErrorContainer = Color(0xFFFFDAD6),
)

class MainActivity : ComponentActivity() {
    private lateinit var controller: RemoteController
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        controller = RemoteController(applicationContext)
        setContent {
            MaterialTheme(colorScheme = StudioColors) {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    RemoteScreen(controller)
                }
            }
        }
    }
    override fun onStart() { super.onStart(); controller.onStart() }
    override fun onStop() { controller.onStop(); super.onStop() }
    override fun onDestroy() { controller.dispose(); super.onDestroy() }
}
