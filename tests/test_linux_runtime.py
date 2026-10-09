from contextlib import nullcontext
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np
from pydantic import ValidationError


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "runtime" / "qwen3_tts_torch_server.py"
WHISPER_SETUP = ROOT / "scripts" / "setup-whisper-linux.sh"


class LinuxTtsRuntimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        model_dir = Path(temporary.name)
        (model_dir / "config.json").write_text("{}")
        self.model = SimpleNamespace(generate_custom_voice=Mock(
            return_value=([np.array([0.0, 0.1, -0.1])], 24000)))
        torch = ModuleType("torch")
        torch.float32 = object()
        torch.bfloat16 = object()
        torch.set_num_threads = Mock()
        torch.inference_mode = nullcontext
        qwen = ModuleType("qwen_tts")
        qwen.Qwen3TTSModel = SimpleNamespace(from_pretrained=Mock(return_value=self.model))
        soundfile = ModuleType("soundfile")
        soundfile.write = Mock(side_effect=lambda buffer, *_args, **_kwargs: buffer.write(b"mock-wav"))
        with patch.dict(sys.modules, {"torch": torch, "qwen_tts": qwen, "soundfile": soundfile}):
            with patch.dict(os.environ, {"QWEN_TTS_MODEL_DIR": str(model_dir),
                                         "QWEN_TTS_DEVICE": "cpu",
                                         "QWEN_TTS_THREADS": "2",
                                         "QWEN_TTS_STYLE_CONTROL": "0"}):
                self.runtime = runpy.run_path(str(RUNTIME))
        qwen.Qwen3TTSModel.from_pretrained.assert_called_once()
        self.assertTrue(qwen.Qwen3TTSModel.from_pretrained.call_args.kwargs["local_files_only"])
        self.model.generate_custom_voice.assert_not_called()

    def test_custom_sampling_options_reach_model_generation(self):
        request = self.runtime["SynthesisRequest"](
            text="샘플링 검사", top_p=0.7, top_k=31, repetition_penalty=1.3)
        response = self.runtime["synthesize"](request)
        self.assertEqual(response.status_code, 200)
        options = self.model.generate_custom_voice.call_args.kwargs
        self.assertEqual(options["top_p"], 0.7)
        self.assertEqual(options["top_k"], 31)
        self.assertEqual(options["repetition_penalty"], 1.3)

    def test_sampling_defaults_match_existing_clients(self):
        self.runtime["synthesize"](self.runtime["SynthesisRequest"](text="기본값 검사"))
        options = self.model.generate_custom_voice.call_args.kwargs
        self.assertEqual(options["top_p"], 0.95)
        self.assertEqual(options["top_k"], 50)
        self.assertEqual(options["repetition_penalty"], 1.05)

    def test_out_of_range_sampling_is_rejected_before_generation(self):
        for field, values in {"top_p": [0.09, 1.01], "top_k": [0, 201],
                              "repetition_penalty": [0.79, 2.01]}.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    with self.assertRaises(ValidationError):
                        self.runtime["SynthesisRequest"](text="범위 검사", **{field: value})
        self.model.generate_custom_voice.assert_not_called()


class LinuxWhisperSetupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.runtime = self.root / "runtime"
        self.checkout = self.runtime / "whisper.cpp"
        self.checkout.mkdir(parents=True)
        self.trace = self.root / "commands.log"
        self.git_binary = shutil.which("git")
        self.assertIsNotNone(self.git_binary)
        self.environment = {**os.environ, "TORIS_RUNTIME_HOME": str(self.runtime),
                            "TEST_COMMAND_TRACE": str(self.trace),
                            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                            "GIT_TERMINAL_PROMPT": "0"}
        self.git("init", "-q")
        (self.checkout / "source.cpp").write_text("// pinned source\n")
        (self.checkout / ".gitignore").write_text("build/\nmodels/ggml-*.bin\n")
        models = self.checkout / "models"
        models.mkdir()
        (models / "download-ggml-model.sh").write_text(
            '#!/usr/bin/env bash\necho download >> "$TEST_COMMAND_TRACE"\n')
        self.git("add", ".")
        self.git("-c", "user.name=Runtime Test", "-c", "user.email=test@example.invalid",
                 "-c", "core.hooksPath=" + os.devnull, "commit", "-qm", "pinned source")
        self.git("tag", "v1.8.3")
        self.original_head = self.git("rev-parse", "HEAD").stdout.strip()
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for name, body in {"uname": "echo Linux", "cmake": 'echo cmake >> "$TEST_COMMAND_TRACE"',
                           "ffmpeg": 'echo ffmpeg >> "$TEST_COMMAND_TRACE"'}.items():
            executable = bin_dir / name
            executable.write_text("#!/usr/bin/env bash\n" + body + "\n")
            executable.chmod(0o700)
        self.environment["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")

    def git(self, *args):
        return subprocess.run([self.git_binary, "-C", str(self.checkout), *args],
                              env=self.environment, text=True, capture_output=True, check=True)

    def run_setup(self):
        return subprocess.run(["bash", str(WHISPER_SETUP)], env=self.environment,
                              text=True, capture_output=True, timeout=10)

    def assert_rejected_without_build_or_mutation(self, message):
        head = self.git("rev-parse", "HEAD").stdout
        status = self.git("status", "--porcelain").stdout
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)
        self.assertIn("TORIS_RUNTIME_HOME", result.stderr)
        self.assertFalse(self.trace.exists(), "No build or model download may run on rejected checkout")
        self.assertEqual(self.git("rev-parse", "HEAD").stdout, head)
        self.assertEqual(self.git("status", "--porcelain").stdout, status)

    def test_mismatched_existing_revision_is_rejected_before_cmake(self):
        (self.checkout / "source.cpp").write_text("// different revision\n")
        self.git("add", "source.cpp")
        self.git("-c", "user.name=Runtime Test", "-c", "user.email=test@example.invalid",
                 "-c", "core.hooksPath=" + os.devnull, "commit", "-qm", "different revision")
        self.assert_rejected_without_build_or_mutation("must be at v1.8.3")

    def test_missing_pinned_tag_is_rejected_before_cmake(self):
        self.git("tag", "-d", "v1.8.3")
        self.assert_rejected_without_build_or_mutation("missing v1.8.3")

    def test_modified_pinned_source_is_preserved_and_rejected(self):
        changed = "// user changes\n"
        (self.checkout / "source.cpp").write_text(changed)
        self.assert_rejected_without_build_or_mutation("local changes")
        self.assertEqual((self.checkout / "source.cpp").read_text(), changed)

    def test_untracked_pinned_source_is_preserved_and_rejected(self):
        source = self.checkout / "local.cpp"
        source.write_text("// untracked user source\n")
        self.assert_rejected_without_build_or_mutation("local changes")
        self.assertTrue(source.is_file())

    def test_clean_pinned_checkout_allows_ignored_build_and_model_outputs(self):
        build = self.checkout / "build"
        build.mkdir()
        (build / "CMakeCache.txt").write_text("// ignored build cache\n")
        (self.checkout / "models" / "ggml-base.bin").write_bytes(b"ignored-model-fixture")
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.trace.read_text().splitlines(), ["cmake", "cmake", "download"])
        self.assertEqual(self.git("rev-parse", "HEAD").stdout.strip(), self.original_head)
        self.assertEqual(self.git("status", "--porcelain").stdout, "")


if __name__ == "__main__":
    unittest.main()
