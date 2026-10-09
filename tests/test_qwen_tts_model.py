import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.qwen_tts_model import ModelResolutionError, main, resolve_model_dir


class QwenTtsModelTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name).resolve()
        self.legacy = self.root / "runtime home" / "qwen3-tts-mlx" / "model"
        self.lmstudio = self.root / ".lmstudio" / "models" / "mlx-community" / "custom voice"

    def model(self, path, model_type="qwen3_tts", voice_type="custom_voice"):
        path.mkdir(parents=True, exist_ok=True)
        (path / "config.json").write_text(
            json.dumps({"model_type": model_type, "tts_model_type": voice_type}),
            encoding="utf-8",
        )
        # These files only exercise completeness checks; no tensor loader is imported.
        (path / "model.safetensors").write_bytes(b"test fixture")
        tokenizer = path / "speech_tokenizer"
        tokenizer.mkdir(exist_ok=True)
        (tokenizer / "config.json").write_text("{}", encoding="utf-8")
        (tokenizer / "model.safetensors").write_bytes(b"test fixture")
        return path.resolve()

    def test_explicit_model_takes_priority(self):
        self.model(self.legacy)
        self.model(self.lmstudio)
        explicit = self.model(self.root / "explicit model")
        self.assertEqual(resolve_model_dir(self.legacy, self.lmstudio, str(explicit)), explicit)

    def test_invalid_explicit_path_does_not_fall_back(self):
        self.model(self.legacy)
        self.model(self.lmstudio)
        with self.assertRaisesRegex(ModelResolutionError, "Invalid QWEN_TTS_MODEL_DIR.*missing"):
            resolve_model_dir(self.legacy, self.lmstudio, str(self.root / "missing"))

    def test_empty_explicit_path_is_an_error(self):
        self.model(self.legacy)
        with self.assertRaisesRegex(ModelResolutionError, "set but empty"):
            resolve_model_dir(self.legacy, self.lmstudio, "")

    def test_text_qwen_and_other_tts_variants_are_rejected(self):
        self.model(self.lmstudio)
        for model_type, voice_type in (("qwen3", None), ("qwen3_tts", "base")):
            with self.subTest(model_type=model_type, voice_type=voice_type):
                invalid = self.model(self.root / "incompatible", model_type, voice_type)
                with self.assertRaisesRegex(ModelResolutionError, "Incompatible model"):
                    resolve_model_dir(self.legacy, self.lmstudio, str(invalid))

    def test_valid_legacy_model_precedes_lmstudio(self):
        legacy = self.model(self.legacy)
        self.model(self.lmstudio)
        self.assertEqual(resolve_model_dir(self.legacy, self.lmstudio), legacy)

    def test_missing_or_incompatible_legacy_uses_lmstudio(self):
        lmstudio = self.model(self.lmstudio)
        self.assertEqual(resolve_model_dir(self.legacy, self.lmstudio), lmstudio)
        self.model(self.legacy, "qwen3", None)
        self.assertEqual(resolve_model_dir(self.legacy, self.lmstudio), lmstudio)

    def test_missing_defaults_report_both_paths(self):
        with self.assertRaises(ModelResolutionError) as caught:
            resolve_model_dir(self.legacy, self.lmstudio)
        self.assertIn(str(self.legacy), str(caught.exception))
        self.assertIn(str(self.lmstudio), str(caught.exception))

    def test_invalid_json_has_actionable_error(self):
        self.model(self.legacy)
        (self.legacy / "config.json").write_text("{", encoding="utf-8")
        with self.assertRaisesRegex(ModelResolutionError, "Cannot read model config"):
            resolve_model_dir(self.legacy, self.lmstudio, str(self.legacy))

    def test_missing_decoder_or_main_weights_are_incomplete_not_incompatible(self):
        for filename in ("model.safetensors", "speech_tokenizer/config.json", "speech_tokenizer/model.safetensors"):
            with self.subTest(filename=filename):
                self.model(self.legacy)
                (self.legacy / filename).unlink()
                with self.assertRaisesRegex(ModelResolutionError, "Incomplete local model"):
                    resolve_model_dir(self.legacy, self.lmstudio, str(self.legacy))

    def test_empty_weights_are_rejected(self):
        self.model(self.legacy)
        (self.legacy / "speech_tokenizer" / "model.safetensors").write_bytes(b"")
        with self.assertRaisesRegex(ModelResolutionError, "missing or empty weights"):
            resolve_model_dir(self.legacy, self.lmstudio, str(self.legacy))

    def test_index_cannot_hide_a_missing_shard(self):
        self.model(self.legacy)
        (self.legacy / "model.safetensors.index.json").write_text(
            json.dumps({"weight_map": {"layer1": "model.safetensors", "layer2": "missing.safetensors"}}),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ModelResolutionError, "missing or empty weights.*missing.safetensors"):
            resolve_model_dir(self.legacy, self.lmstudio, str(self.legacy))

    def test_cli_honors_environment_and_emits_only_selected_path(self):
        explicit = self.model(self.root / "explicit model")
        output = io.StringIO()
        with patch.dict(os.environ, {"QWEN_TTS_MODEL_DIR": str(explicit)}):
            with contextlib.redirect_stdout(output):
                result = main([str(self.legacy), str(self.lmstudio)])
        self.assertEqual(result, 0)
        self.assertEqual(output.getvalue(), f"{explicit}\n")


if __name__ == "__main__":
    unittest.main()
