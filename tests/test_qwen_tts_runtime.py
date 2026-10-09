import os
from pathlib import Path
import runpy
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI


RUNTIME = Path(__file__).resolve().parents[1] / "runtime" / "qwen3_tts_server.py"
MODEL_DIR = "/test/qwen-custom-voice"


class QwenTtsRuntimeTests(unittest.TestCase):
    def fake_model(self):
        return SimpleNamespace(
            generate_custom_voice=Mock(),
            tokenizer=object(),
            speech_tokenizer=object(),
            sample_rate=24000,
        )

    def load_runtime(self, model, app):
        # Replace the entire MLX import chain before executing the runtime module.
        utils = ModuleType("mlx_audio.tts.utils")
        utils.load_model = Mock(return_value=model)
        modules = {
            "mlx_audio": ModuleType("mlx_audio"),
            "mlx_audio.tts": ModuleType("mlx_audio.tts"),
            "mlx_audio.tts.utils": utils,
            # Startup guards and /health do not use audio synthesis libraries.
            "numpy": ModuleType("numpy"),
            "soundfile": ModuleType("soundfile"),
        }
        with patch.dict(sys.modules, modules):
            with patch.dict(os.environ, {"QWEN_TTS_MODEL_DIR": MODEL_DIR}):
                with patch("fastapi.FastAPI", return_value=app):
                    result = runpy.run_path(str(RUNTIME))
        utils.load_model.assert_called_once_with(MODEL_DIR)
        return result

    def assert_startup_rejected(self, model, message):
        app = FastAPI()
        with self.assertRaisesRegex(RuntimeError, message):
            self.load_runtime(model, app)
        self.assertNotIn("/health", [route.path for route in app.routes])

    def test_missing_custom_voice_method_prevents_healthy_startup(self):
        model = self.fake_model()
        model.generate_custom_voice = None
        self.assert_startup_rejected(model, "does not support Qwen3-TTS CustomVoice")

    def test_missing_text_tokenizer_prevents_healthy_startup(self):
        model = self.fake_model()
        model.tokenizer = None
        self.assert_startup_rejected(model, "text tokenizer failed to load")
        model.generate_custom_voice.assert_not_called()

    def test_missing_speech_tokenizer_prevents_healthy_startup(self):
        model = self.fake_model()
        model.speech_tokenizer = None
        self.assert_startup_rejected(model, "speech tokenizer failed to load")
        model.generate_custom_voice.assert_not_called()

    def test_complete_fake_model_registers_healthy_runtime_without_synthesis(self):
        model = self.fake_model()
        app = FastAPI()
        runtime = self.load_runtime(model, app)
        health = runtime["health"]()
        self.assertIn("/health", [route.path for route in app.routes])
        self.assertTrue(health["ok"])
        self.assertEqual(health["provider"], "qwen3-tts-mlx")
        self.assertEqual(health["sample_rate"], 24000)
        self.assertEqual(health["model"], "qwen-custom-voice")
        self.assertEqual(health["model_path"], os.path.realpath(MODEL_DIR))
        self.assertEqual(health["pid"], os.getpid())
        model.generate_custom_voice.assert_not_called()


if __name__ == "__main__":
    unittest.main()
