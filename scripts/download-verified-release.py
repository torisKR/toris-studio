#!/usr/bin/env python3
"""Download trusted native artifact ZIPs and fail on any digest or layout drift."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import threading
import zipfile

REPOSITORY = "torisKR/toris-studio"
LIMIT = 512 * 1024 * 1024
ARCHIVE_LIMIT = 2 * 1024 * 1024 * 1024
LAYOUT = {
    "release-darwin-aarch64": {
        "Toris-Studio-macOS-arm64.dmg", "Toris-Studio-macOS-arm64.app.tar.gz",
        "Toris-Studio-macOS-arm64.app.tar.gz.sig", "build-darwin-aarch64.json",
    },
    "release-darwin-x86_64": {
        "Toris-Studio-macOS-x64.dmg", "Toris-Studio-macOS-x64.app.tar.gz",
        "Toris-Studio-macOS-x64.app.tar.gz.sig", "build-darwin-x86_64.json",
    },
    "release-windows-x86_64": {
        "Toris-Studio-Windows-x64-setup.exe", "Toris-Studio-Windows-x64-setup.exe.sig",
        "build-windows-x86_64.json",
    },
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_manifest(manifest):
    require(isinstance(manifest, dict), "Invalid native artifact manifest")
    require(type(manifest.get("runId")) is int and manifest["runId"] > 0, "Invalid original run ID")
    require(re.fullmatch(r"[a-f0-9]{40}", manifest.get("source", "")) is not None, "Invalid original source")
    require(re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", manifest.get("version", "")) is not None, "Invalid original version")
    artifacts = manifest.get("artifacts")
    require(isinstance(artifacts, list) and len(artifacts) == len(LAYOUT), "Incomplete native artifact manifest")
    require({a.get("name") for a in artifacts if isinstance(a, dict)} == set(LAYOUT), "Unexpected native artifact names")
    require(all(isinstance(a, dict) and type(a.get("id")) is int and a["id"] > 0 for a in artifacts), "Invalid native artifact ID")
    require(len({a["id"] for a in artifacts}) == len(LAYOUT), "Duplicate native artifact ID")
    total = 0
    for artifact in artifacts:
        require(re.fullmatch(r"sha256:[a-f0-9]{64}", artifact.get("digest", "")) is not None, "Missing native artifact digest")
        require(type(artifact.get("sizeInBytes")) is int and 0 < artifact["sizeInBytes"] < ARCHIVE_LIMIT, "Invalid native artifact size")
        total += artifact["sizeInBytes"]
    require(total < ARCHIVE_LIMIT, "Native archives exceed the aggregate size limit")
    return artifacts


def verify_extract(archive, artifact, destination):
    require(archive.stat().st_size == artifact["sizeInBytes"], "Native artifact ZIP size mismatch")
    with archive.open("rb") as stream:
        digest = "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()
    require(digest == artifact["digest"], "Native artifact ZIP digest mismatch")
    expected = LAYOUT[artifact["name"]]
    with zipfile.ZipFile(archive) as package:
        entries = package.infolist()
        require(len(entries) == len(expected) and {entry.filename for entry in entries} == expected, "Native artifact ZIP layout mismatch")
        for entry in entries:
            require(not entry.is_dir() and stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG), "Native artifact ZIP contains a non-regular file")
            require(not entry.flag_bits & 1, "Encrypted native artifact ZIP is unsupported")
            maximum = 8192 if entry.filename.endswith((".json", ".sig")) else LIMIT
            require(0 < entry.file_size <= maximum, "Native artifact member exceeds its size limit")
        for entry in entries:
            # The allowlist consists only of fixed basenames. Never use extractall.
            with package.open(entry) as source, (destination / entry.filename).open("xb") as output:
                written = 0
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    written += len(chunk)
                    require(written <= entry.file_size, "Native artifact member size mismatch")
                    output.write(chunk)
                require(written == entry.file_size, "Native artifact member is truncated")
    return {"id": artifact["id"], "name": artifact["name"], "digest": digest, "sizeInBytes": archive.stat().st_size}


def fetch_archive(artifact, archive):
    process = subprocess.Popen(
        ["gh", "api", f"repos/{REPOSITORY}/actions/artifacts/{artifact['id']}/zip"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    watchdog = threading.Timer(300, process.kill)
    watchdog.start()
    try:
        with archive.open("xb") as stream:
            received = 0
            for chunk in iter(lambda: process.stdout.read(1024 * 1024), b""):
                received += len(chunk)
                require(received <= artifact["sizeInBytes"], "Native artifact download exceeds its declared size")
                stream.write(chunk)
        require(process.wait() == 0, "Could not download the validated native artifact")
    finally:
        watchdog.cancel()
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        process.stdout.close()


def download(manifest_path, destination):
    manifest = json.loads(manifest_path.read_bytes())
    artifacts = validate_manifest(manifest)
    require(not destination.exists() and not destination.is_symlink(), "Native release destination already exists")
    require(manifest["source"] == os.environ.get("RELEASE_COMMIT") and manifest["version"] == os.environ.get("RELEASE_VERSION"), "Native manifest differs from the validated release environment")
    proofs = []
    with tempfile.TemporaryDirectory(prefix="toris-release-resume-", dir=destination.parent) as owned:
        scratch = Path(owned)
        stage = scratch / "verified"
        stage.mkdir()
        for artifact in artifacts:
            archive = scratch / (str(artifact["id"]) + ".zip")
            fetch_archive(artifact, archive)
            proofs.append(verify_extract(archive, artifact, stage))
        for platform in ("darwin-aarch64", "darwin-x86_64", "windows-x86_64"):
            build = json.loads((stage / f"build-{platform}.json").read_bytes())
            require(build.get("schemaVersion") == 1 and build.get("platform") == platform and build.get("version") == manifest["version"] and build.get("commit") == manifest["source"], "Native build metadata differs from the original source")
        os.rename(stage, destination)
    receipt = {"runId": manifest["runId"], "source": manifest["source"], "version": manifest["version"], "artifactDigestsVerified": True, "artifacts": proofs}
    print(json.dumps(receipt))


if __name__ == "__main__":
    try:
        path = os.environ.get("RELEASE_RESUME_MANIFEST")
        require(bool(path), "Validated native artifact manifest is required")
        download(Path(path), Path.cwd() / "release-assets")
    except Exception:
        # Never echo a signed redirect URL, token, provider body or arbitrary ZIP path.
        raise SystemExit("Verified native artifact download failed; publication was not started.")
