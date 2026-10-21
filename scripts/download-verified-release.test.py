import hashlib
import importlib.util
import io
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("verified_release", Path(__file__).with_name("download-verified-release.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ArtifactTests(unittest.TestCase):
    def manifest(self):
        return {"runId": 39615374493, "source": "c" * 40, "version": "0.3.1", "artifacts": [
            {"id": i + 1, "name": name, "digest": "sha256:" + "a" * 64, "sizeInBytes": 100}
            for i, name in enumerate(module.LAYOUT)
        ]}

    def package(self, directory, entries=None):
        name = "release-darwin-aarch64"
        archive = directory / "owned.zip"
        with zipfile.ZipFile(archive, "w") as package:
            for entry in entries if entries is not None else sorted(module.LAYOUT[name]):
                package.writestr(entry, b"owned fixture")
        digest = "sha256:" + hashlib.sha256(archive.read_bytes()).hexdigest()
        return archive, {"id": 1, "name": name, "sizeInBytes": archive.stat().st_size, "digest": digest}

    def test_manifest_requires_all_unique_hashed_bounded_native_artifacts(self):
        self.assertEqual(len(module.validate_manifest(self.manifest())), 3)
        changes = [lambda m: m.update(source="wrong"), lambda m: m.update(version="0.3.1-rc"),
                   lambda m: m.update(runId=True), lambda m: m["artifacts"].pop(),
                   lambda m: m["artifacts"][0].update(digest=""),
                   lambda m: m["artifacts"][0].update(sizeInBytes=module.ARCHIVE_LIMIT),
                   lambda m: m["artifacts"][0].update(id=2),
                   lambda m: m["artifacts"][0].update(name="foreign-artifact")]
        for change in changes:
            candidate = self.manifest()
            change(candidate)
            with self.assertRaises(ValueError): module.validate_manifest(candidate)

    def test_digest_verified_before_any_file_is_extracted(self):
        with tempfile.TemporaryDirectory() as owned:
            root = Path(owned); output = root / "output"; output.mkdir()
            archive, artifact = self.package(root)
            artifact["digest"] = "sha256:" + "0" * 64
            with self.assertRaisesRegex(ValueError, "digest mismatch"): module.verify_extract(archive, artifact, output)
            self.assertEqual(list(output.iterdir()), [])

    def test_valid_archive_extracts_only_expected_regular_files(self):
        with tempfile.TemporaryDirectory() as owned:
            root = Path(owned); output = root / "output"; output.mkdir()
            archive, artifact = self.package(root)
            module.verify_extract(archive, artifact, output)
            self.assertEqual({p.name for p in output.iterdir()}, module.LAYOUT[artifact["name"]])

    def test_zip_rejects_traversal_duplicate_unexpected_and_symlink_members(self):
        for kind in ("traversal", "duplicate", "unexpected", "symlink"):
            with tempfile.TemporaryDirectory() as owned:
                root = Path(owned); output = root / "output"; output.mkdir()
                entries = sorted(module.LAYOUT["release-darwin-aarch64"])
                if kind == "traversal": entries[0] = "../outside"
                if kind == "duplicate": entries[-1] = entries[0]
                if kind == "unexpected": entries[0] = "unexpected.exe"
                if kind == "symlink":
                    link = zipfile.ZipInfo(entries[0]); link.create_system = 3
                    link.external_attr = (stat.S_IFLNK | 0o777) << 16
                    entries[0] = link
                archive, artifact = self.package(root, entries)
                with self.assertRaises(ValueError): module.verify_extract(archive, artifact, output)
                self.assertEqual(list(output.iterdir()), [])
                self.assertFalse((root / "outside").exists())

    def test_member_limit_and_size_mismatch_are_rejected(self):
        with tempfile.TemporaryDirectory() as owned:
            root = Path(owned); output = root / "output"; output.mkdir()
            archive, artifact = self.package(root)
            wrong = {**artifact, "sizeInBytes": artifact["sizeInBytes"] + 1}
            with self.assertRaisesRegex(ValueError, "ZIP size mismatch"): module.verify_extract(archive, wrong, output)
            previous = module.LIMIT
            try:
                module.LIMIT = 4
                with self.assertRaisesRegex(ValueError, "size limit"): module.verify_extract(archive, artifact, output)
            finally: module.LIMIT = previous
            self.assertEqual(list(output.iterdir()), [])

    def test_oversize_download_kills_only_its_owned_child_before_writing_extra_bytes(self):
        class Child:
            stdout = io.BytesIO(b"too many bytes")
            killed = False
            def poll(self): return -9 if self.killed else None
            def kill(self): self.killed = True
            def wait(self, timeout=None): return -9
        child = Child()
        with tempfile.TemporaryDirectory() as owned, patch.object(module.subprocess, "Popen", return_value=child):
            path = Path(owned) / "owned.zip"
            with self.assertRaisesRegex(ValueError, "exceeds its declared size"):
                module.fetch_archive({"id": 1, "sizeInBytes": 1}, path)
            self.assertTrue(child.killed)
            self.assertEqual(path.stat().st_size, 0)


if __name__ == "__main__": unittest.main()
