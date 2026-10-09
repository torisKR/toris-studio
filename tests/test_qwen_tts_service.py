from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import signal
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from scripts import qwen_tts_service as service_module
from scripts.qwen_tts_service import ServiceError, TtsService, inspect_process as real_inspect_process


class TtsServiceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.service = TtsService(self.root / "project", self.root / "runtime", 50010)
        self.service.directory.mkdir(parents=True, mode=0o700)
        self.identity = {"uid": os.getuid(), "started": "Sat Oct 3 12:34:56 2026",
                         "command": " ".join(self.service.command)}
        self.record = {"version": 1, "uid": os.getuid(), "root": str(self.service.root),
                       "runtime": str(self.service.runtime), "port": 50010,
                       "launcher": self.service.command,
                       "command": self.identity["command"], "started": self.identity["started"],
                       "pid": 12345, "model_path": str(self.root / "model"), "phase": "running"}
        self.health_payload = {"ok": True, "provider": "qwen3-tts-mlx", "backend": "mlx",
                               "model_path": self.record["model_path"], "pid": 12345}
        self.inspect = self.mock("inspect_process", return_value=self.identity.copy())
        self.port = self.mock("port_is_open", return_value=False)
        self.health = self.mock("read_health", return_value=self.health_payload.copy())
        self.kill = self.mock("os.kill")
        self.spawn = self.mock("subprocess.Popen", return_value=SimpleNamespace(pid=12345))
        self.mock("time.sleep")
        environment = patch.dict(os.environ, {"QWEN_TTS_MODEL_DIR": self.record["model_path"]})
        environment.start()
        self.addCleanup(environment.stop)

    def mock(self, name, **kwargs):
        replacement = patch(f"scripts.qwen_tts_service.{name}", **kwargs)
        mock = replacement.start()
        self.addCleanup(replacement.stop)
        return mock

    def own(self):
        self.service.write_state(self.record)

    def test_unmanaged_listener_is_never_adopted_started_over_or_stopped(self):
        self.port.return_value = True
        self.assertEqual(self.service.status()["state"], "unmanaged-running")
        with self.assertRaises(ServiceError):
            self.service.on(wait_seconds=0)
        with self.assertRaises(ServiceError):
            self.service.off(wait_seconds=0)
        self.assertFalse(self.service.state_path.exists())
        self.spawn.assert_not_called()
        self.kill.assert_not_called()

    def test_start_records_owned_process_and_checks_health_identity(self):
        result = self.service.on(wait_seconds=0)
        self.assertEqual(result["state"], "running")
        self.assertEqual(self.service.read_state()["started"], self.identity["started"])
        self.spawn.assert_called_once()
        self.assertEqual(self.spawn.call_args.args[0], self.service.command)
        self.kill.assert_not_called()

    def test_macos_framework_python_command_is_recorded_then_matched_exactly(self):
        self.inspect.return_value = {**self.identity,
            "command": "/opt/homebrew/Frameworks/Python.app/Contents/MacOS/Python " + " ".join(self.service.command[1:])}
        self.assertEqual(self.service.on(wait_seconds=0)["state"], "running")
        self.assertEqual(self.service.read_state()["command"], self.inspect.return_value["command"])
        self.inspect.return_value = self.identity
        with self.assertRaisesRegex(ServiceError, "ownership mismatch"):
            self.service.off(wait_seconds=0)
        self.kill.assert_not_called()

    def test_running_pending_and_unhealthy_owned_process_are_not_duplicated(self):
        self.own()
        for health, expected in ((self.health_payload, "running"), ({}, "pending"),
                                 ({**self.health_payload, "model_path": "/wrong"}, "error"),
                                 ({**self.health_payload, "pid": 54321}, "error")):
            with self.subTest(expected=expected, health=health):
                self.health.return_value = health
                self.assertEqual(self.service.on(wait_seconds=0)["state"], expected)
        self.spawn.assert_not_called()

    def test_bounded_startup_preserves_pending_record(self):
        self.health.return_value = {}
        self.assertEqual(self.service.on(wait_seconds=0)["state"], "pending")
        self.assertTrue(self.service.state_path.exists())
        self.kill.assert_not_called()

    def test_stop_sends_only_sigterm_after_rechecking_identity(self):
        self.own()
        self.inspect.side_effect = [self.identity, self.identity, None]
        self.assertEqual(self.service.off(wait_seconds=0)["state"], "stopped")
        self.kill.assert_called_once_with(12345, signal.SIGTERM)
        self.assertFalse(self.service.state_path.exists())

    def test_stop_timeout_keeps_ownership_without_force_kill(self):
        self.own()
        self.assertEqual(self.service.off(wait_seconds=0)["state"], "stopping")
        self.kill.assert_called_once_with(12345, signal.SIGTERM)
        self.assertTrue(self.service.state_path.exists())

    def test_pid_identity_mismatch_or_inspection_failure_never_signals(self):
        self.own()
        for field, wrong in (("uid", os.getuid() + 1), ("started", "different"), ("command", "another service")):
            with self.subTest(field=field):
                self.inspect.return_value = {**self.identity, field: wrong}
                with self.assertRaises(ServiceError):
                    self.service.off(wait_seconds=0)
        self.inspect.side_effect = PermissionError("inspection denied")
        with self.assertRaises(PermissionError):
            self.service.off(wait_seconds=0)
        self.kill.assert_not_called()

    def test_process_disappearing_before_signal_is_not_killed(self):
        self.own()
        self.inspect.side_effect = [self.identity, None, None]
        self.service.off(wait_seconds=0)
        self.kill.assert_not_called()

    def test_legacy_or_malformed_records_and_symlinks_never_signal(self):
        for record in ({"pid": 12345}, {**self.record, "version": 2}, {**self.record, "root": "/other"}):
            self.service.state_path.write_text(json.dumps(record))
            with self.assertRaises(ServiceError):
                self.service.off(wait_seconds=0)
        self.service.state_path.unlink()
        self.service.state_path.symlink_to(self.root / "elsewhere")
        with self.assertRaises(ServiceError):
            self.service.off(wait_seconds=0)
        self.kill.assert_not_called()

    def test_stale_pid_record_does_not_hide_an_unmanaged_listener(self):
        self.own()
        self.inspect.return_value = None
        self.port.return_value = True
        self.assertEqual(self.service.status()["state"], "unmanaged-running")
        with self.assertRaises(ServiceError):
            self.service.on(wait_seconds=0)
        self.spawn.assert_not_called()
        self.kill.assert_not_called()

    def test_start_fails_before_spawn_when_process_inspection_is_denied(self):
        self.inspect.side_effect = PermissionError("inspection denied")
        with self.assertRaises(PermissionError):
            self.service.on(wait_seconds=0)
        self.spawn.assert_not_called()

    def test_reservation_write_failure_prevents_spawn(self):
        with patch.object(self.service, "write_state", side_effect=PermissionError("write denied")):
            with self.assertRaises(PermissionError):
                self.service.on(wait_seconds=0)
        self.spawn.assert_not_called()

    def test_post_spawn_write_failure_keeps_reservation_and_blocks_retry(self):
        write_state = self.service.write_state
        writes = 0

        def fail_second_write(record):
            nonlocal writes
            writes += 1
            if writes == 2:
                raise OSError("disk full")
            write_state(record)

        with patch.object(self.service, "write_state", side_effect=fail_second_write):
            with self.assertRaises(OSError):
                self.service.on(wait_seconds=0)
        self.assertEqual(self.service.read_state()["phase"], "reserved")
        with self.assertRaisesRegex(ServiceError, "ownership was not finalized"):
            self.service.on(wait_seconds=0)
        self.spawn.assert_called_once()
        self.kill.assert_not_called()

    def test_serialized_concurrent_starts_spawn_only_one_process(self):
        def start():
            try:
                with self.service.locked():
                    return self.service.on(wait_seconds=0)
            except ServiceError as error:
                self.assertIn("Another TTS management command is active", str(error))
                return {"state": "busy"}
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: start(), range(2)))
        self.assertTrue(any(result["state"] == "running" for result in results))
        self.assertTrue(all(result["state"] in ("running", "busy") for result in results))
        self.spawn.assert_called_once()

    def test_lock_contention_fails_without_waiting_or_process_control(self):
        with patch.object(service_module.fcntl, "flock", side_effect=BlockingIOError("busy")) as lock:
            with self.assertRaisesRegex(ServiceError, "Another TTS management command is active"):
                with self.service.locked():
                    self.fail("A contended lock must not enter process management.")
        self.assertEqual(lock.call_args.args[1], service_module.fcntl.LOCK_EX | service_module.fcntl.LOCK_NB)
        self.spawn.assert_not_called()
        self.kill.assert_not_called()

    def test_ps_timeout_is_bounded_and_never_signals(self):
        timeout = service_module.subprocess.TimeoutExpired("ps", 10)
        with patch.object(service_module.subprocess, "run", side_effect=timeout) as run:
            self.inspect.side_effect = real_inspect_process
            self.own()
            with self.assertRaisesRegex(ServiceError, "inspection timed out after 10 seconds"):
                self.service.off(wait_seconds=0)
        self.assertEqual(run.call_args.kwargs["timeout"], 10)
        self.kill.assert_not_called()
        self.spawn.assert_not_called()

    def test_ps_parser_preserves_start_identity_and_full_command(self):
        result = SimpleNamespace(returncode=0, stderr="", stdout=f" {os.getuid()} S+ Sat Oct  3 12:34:56 2026 /a path/python -m uvicorn app\n")
        with patch.object(service_module.subprocess, "run", return_value=result):
            process = real_inspect_process(12345)
        self.assertEqual(process["uid"], os.getuid())
        self.assertEqual(process["started"], "Sat Oct 3 12:34:56 2026")
        self.assertEqual(process["command"], "/a path/python -m uvicorn app")

    def test_zombie_process_is_stopped_without_sending_a_signal(self):
        self.inspect.side_effect = real_inspect_process
        for state in ("Z", "Z+"):
            with self.subTest(state=state):
                self.own()
                zombie = SimpleNamespace(returncode=0, stderr="",
                    stdout=f" {os.getuid()} {state} Sat Oct 3 12:34:56 2026 <defunct>\n")
                with patch.object(service_module.subprocess, "run", return_value=zombie):
                    self.assertEqual(self.service.off(wait_seconds=0)["state"], "stopped")
                self.assertFalse(self.service.state_path.exists())
        self.kill.assert_not_called()
        self.spawn.assert_not_called()

    def test_sigterm_followed_by_zombie_completes_without_ownership_error(self):
        self.own()
        self.inspect.side_effect = real_inspect_process
        alive = SimpleNamespace(returncode=0, stderr="",
            stdout=f" {os.getuid()} S Sat Oct 3 12:34:56 2026 {self.record['command']}\n")
        zombie = SimpleNamespace(returncode=0, stderr="",
            stdout=f" {os.getuid()} Z Sat Oct 3 12:34:56 2026 <defunct>\n")
        with patch.object(service_module.subprocess, "run", side_effect=[alive, alive, zombie]):
            self.assertEqual(self.service.off(wait_seconds=0)["state"], "stopped")
        self.kill.assert_called_once_with(12345, signal.SIGTERM)
        self.assertFalse(self.service.state_path.exists())

    def test_macos_argv_disappearing_after_sigterm_is_only_observed_until_exit(self):
        self.own()
        self.inspect.side_effect = real_inspect_process
        alive = SimpleNamespace(returncode=0, stderr="",
            stdout=f" {os.getuid()} S Sat Oct 3 12:34:56 2026 {self.record['command']}\n")
        terminating = SimpleNamespace(returncode=0, stderr="",
            stdout=f" {os.getuid()} S Sat Oct 3 12:34:56 2026 (Python)\n")
        exited = SimpleNamespace(returncode=1, stderr="", stdout="")
        with patch.object(service_module.subprocess, "run", side_effect=[alive, alive, terminating, exited]):
            self.assertEqual(self.service.off(wait_seconds=1)["state"], "stopped")
        self.kill.assert_called_once_with(12345, signal.SIGTERM)
        self.assertFalse(self.service.state_path.exists())

    def test_pid_reuse_during_shutdown_wait_never_signals_replacement(self):
        for changed in ({"uid": os.getuid() + 1}, {"started": "later process start"}):
            with self.subTest(changed=changed):
                self.own()
                replacement = {**self.identity, **changed, "command": "another service"}
                self.inspect.side_effect = [self.identity, self.identity, replacement]
                self.kill.reset_mock()
                self.assertEqual(self.service.off(wait_seconds=0)["state"], "stopped")
                self.kill.assert_called_once_with(12345, signal.SIGTERM)
                self.assertFalse(self.service.state_path.exists())

    def test_argv_change_at_shutdown_timeout_returns_stopping_without_strict_recheck(self):
        self.own()
        terminating = {**self.identity, "command": "(Python)"}
        self.inspect.side_effect = [self.identity, self.identity, terminating]
        self.assertEqual(self.service.off(wait_seconds=0)["state"], "stopping")
        self.kill.assert_called_once_with(12345, signal.SIGTERM)
        self.assertTrue(self.service.state_path.exists())


if __name__ == "__main__":
    unittest.main()
