"""Manage only Qwen3-TTS processes started by this project and this manager."""

import argparse
from contextlib import contextmanager
import errno
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import stat
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen


class ServiceError(RuntimeError):
    pass


def inspect_process(pid):
    try:
        result = subprocess.run(
            ["ps", "-ww", "-p", str(pid), "-o", "uid=", "-o", "stat=", "-o", "lstart=", "-o", "command="],
            capture_output=True, text=True, env={**os.environ, "LC_ALL": "C"}, timeout=10,
        )
    except subprocess.TimeoutExpired as error:
        raise ServiceError(f"Process inspection timed out after 10 seconds for PID {pid}; refusing process control.") from error
    if result.returncode == 1 and not result.stdout.strip() and not result.stderr.strip():
        return None
    if result.returncode != 0:
        raise ServiceError(f"Cannot inspect PID {pid}: {result.stderr.strip()}")
    fields = result.stdout.strip().split(maxsplit=7)
    # A terminated child may retain its PID while waiting to be reaped on macOS.
    # Its command can become <defunct>; it must never be signalled or reused as live ownership.
    if len(fields) >= 2 and fields[0].isdigit() and fields[1].startswith("Z"):
        return None
    if len(fields) != 8 or not fields[0].isdigit():
        raise ServiceError(f"Cannot verify process identity for PID {pid}.")
    return {"uid": int(fields[0]), "started": " ".join(fields[2:7]), "command": fields[7]}


def port_is_open(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError as error:
        if error.errno == errno.ECONNREFUSED:
            return False
        raise ServiceError(f"Cannot inspect local port {port}: {error}") from error


def read_health(port):
    try:
        with urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
            payload = json.loads(response.read(65536))
            return payload if isinstance(payload, dict) else {}
    except (OSError, URLError, ValueError):
        return {}


class TtsService:
    def __init__(self, root, runtime_home, port):
        self.root = Path(root).resolve()
        self.runtime = Path(runtime_home).expanduser().resolve() / "qwen3-tts-mlx"
        self.port = int(port)
        if not 1 <= self.port <= 65535:
            raise ServiceError("QWEN_TTS_PORT must be between 1 and 65535.")
        self.directory = self.runtime / "service"
        self.state_path = self.directory / f"server-{self.port}.json"
        self.log_path = self.directory / f"server-{self.port}.log"
        self.command = [str(self.runtime / "venv/bin/python"), "-m", "uvicorn",
                        "runtime.qwen3_tts_server:app", "--app-dir", str(self.root),
                        "--host", "127.0.0.1", "--port", str(self.port)]

    def is_server_command(self, command):
        suffix = " " + " ".join(self.command[1:])
        return isinstance(command, str) and command.endswith(suffix) and os.path.isabs(command[:-len(suffix)])

    @contextmanager
    def locked(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ServiceError(f"Unsafe TTS state directory: {self.directory}")
        fd = os.open(self.directory / f"server-{self.port}.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ServiceError("Another TTS management command is active; retry after it finishes.") from error
            yield

    def read_state(self):
        try:
            info = self.state_path.lstat()
        except FileNotFoundError:
            return None
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ServiceError(f"Unsafe TTS ownership record: {self.state_path}")
        try:
            record = json.loads(self.state_path.read_text())
            valid = (
                record["version"] == 1 and record["uid"] == os.getuid()
                and record["root"] == str(self.root) and record["runtime"] == str(self.runtime)
                and record["port"] == self.port and record["launcher"] == self.command
                and (self.is_server_command(record["command"])
                     or (record["started"] == "" and record["command"] == ""))
                and ((type(record["pid"]) is int and record["pid"] > 1)
                     or (record["pid"] is None and record.get("phase") == "reserved"))
                and isinstance(record["started"], str) and isinstance(record["model_path"], str)
            )
        except (KeyError, TypeError, ValueError):
            valid = False
        if not valid:
            raise ServiceError(f"Unrecognized TTS ownership record; refusing process control: {self.state_path}")
        return record

    def write_state(self, record):
        temporary = self.state_path.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(record, output, indent=2)
            output.write("\n")
        temporary.replace(self.state_path)

    def owned_process(self, record):
        if record["pid"] is None:
            raise ServiceError(
                f"TTS startup ownership was not finalized. Refusing another launch or stop; "
                f"verify existing processes before removing {self.state_path}."
            )
        process = inspect_process(record["pid"])
        if process is None:
            return None
        if not record["started"] or any(process[key] != record[key] for key in ("uid", "started", "command")):
            raise ServiceError(f"PID {record['pid']} ownership mismatch; refusing process control.")
        return process

    def status(self):
        record = self.read_state()
        result = {"state": "stopped", "url": f"http://127.0.0.1:{self.port}", "log": str(self.log_path)}
        if record is None:
            if port_is_open(self.port):
                result["state"] = "unmanaged-running"
                result["detail"] = "This manager did not start the listener and will not stop it."
            return result
        result.update(pid=record["pid"], model_path=record["model_path"])
        if self.owned_process(record) is None:
            if port_is_open(self.port):
                return {"state": "unmanaged-running", "url": result["url"], "log": result["log"],
                        "detail": "The recorded process exited; another listener will not be controlled."}
            result["state"] = "error" if record.get("phase") == "error" else "stopped"
            return result
        if record.get("phase") == "stopping":
            result["state"] = "stopping"
            return result
        health = read_health(self.port)
        if not health:
            result["state"] = "pending"
            return result
        if (health.get("ok") is True and health.get("provider") == "qwen3-tts-mlx"
                and health.get("backend") == "mlx" and health.get("model_path") == record["model_path"]
                and health.get("pid") == record["pid"]):
            result["state"] = "running"
        else:
            result.update(state="error", detail="Health response does not match this model path and managed PID.")
        return result

    def on(self, wait_seconds=60):
        current = self.status()
        record = self.read_state()
        if record and self.owned_process(record) is not None:
            return current  # An unhealthy/starting owned process must never be duplicated.
        if current["state"] == "unmanaged-running" or port_is_open(self.port):
            raise ServiceError(f"Port {self.port} is already in use; no server was started.")
        model_path = os.environ.get("QWEN_TTS_MODEL_DIR")
        if not model_path:
            raise ServiceError("Start through pnpm tts:on so the local model is validated first.")
        manager_process = inspect_process(os.getpid())
        if manager_process is None or manager_process["uid"] != os.getuid():
            raise ServiceError("Process ownership cannot be inspected; no server was started.")
        record = {"version": 1, "uid": os.getuid(), "root": str(self.root), "runtime": str(self.runtime),
                  "port": self.port, "launcher": self.command, "command": "", "pid": None,
                  "started": "", "model_path": str(Path(model_path).resolve()), "phase": "reserved"}
        fd = os.open(self.log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "ab") as log:
            # Reserve before spawning: a later write failure must not permit duplicate loading.
            self.write_state(record)
            try:
                child = subprocess.Popen(self.command, cwd=self.root,
                                         env={**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"},
                                         stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                         start_new_session=True)
            except OSError:
                self.state_path.unlink()  # Popen did not create a running child.
                raise
        record.update(pid=child.pid, phase="starting")
        self.write_state(record)  # Keep a blocking record even if inspection is denied.
        process = inspect_process(child.pid)
        if process is None:
            record["phase"] = "error"
            self.write_state(record)
            raise ServiceError(f"TTS exited during startup. See {self.log_path}")
        if process["uid"] != os.getuid() or not self.is_server_command(process["command"]):
            raise ServiceError(f"Cannot verify the newly started TTS PID {child.pid}. See {self.log_path}")
        # macOS may report the framework Python binary instead of the venv launcher.
        record["command"] = process["command"]
        record["started"] = process["started"]
        self.write_state(record)
        self.owned_process(record)
        deadline = time.monotonic() + wait_seconds
        while True:
            current = self.status()
            if current["state"] == "running":
                record["phase"] = "running"
                self.write_state(record)
                return current
            if current["state"] in ("stopped", "error"):
                record["phase"] = "error"
                self.write_state(record)
                return {**current, "state": "error", "detail": f"TTS startup failed. See {self.log_path}"}
            if time.monotonic() >= deadline:
                return current
            time.sleep(0.5)

    def off(self, wait_seconds=10):
        record = self.read_state()
        if record is None:
            current = self.status()
            if current["state"] == "unmanaged-running":
                raise ServiceError("Refusing to stop a server not started by this manager.")
            return current
        if self.owned_process(record) is None:
            self.state_path.unlink()
            return self.status()
        record["phase"] = "stopping"
        self.write_state(record)
        if self.owned_process(record) is not None:  # Recheck just before the only allowed signal.
            try:
                os.kill(record["pid"], signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + wait_seconds
        while True:
            # After SIGTERM, macOS can discard argv before the process is reaped.
            # Only observe the original UID/start identity here; never send another signal.
            process = inspect_process(record["pid"])
            if process is None or any(process[key] != record[key] for key in ("uid", "started")):
                break
            if time.monotonic() >= deadline:
                return {"state": "stopping", "pid": record["pid"], "model_path": record["model_path"],
                        "url": f"http://127.0.0.1:{self.port}", "log": str(self.log_path)}
            time.sleep(0.25)
        self.state_path.unlink()
        return self.status()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("on", "off", "status"))
    args = parser.parse_args()
    try:
        service = TtsService(Path(__file__).resolve().parents[1],
                             os.environ.get("TORIS_RUNTIME_HOME", str(Path.home() / ".local/share/toris-studio")),
                             os.environ.get("QWEN_TTS_PORT", "50010"))
        with service.locked():
            result = getattr(service, args.action)()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if result["state"] == "error" else 0
    except (ServiceError, OSError, ValueError) as error:
        print(json.dumps({"state": "error", "detail": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
