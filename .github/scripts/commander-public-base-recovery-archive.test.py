#!/usr/bin/env python3
"""Focused bounds tests for Commander public-base recovery artifacts."""

from __future__ import annotations

import importlib.util
import io
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("commander-public-base-recovery-archive.py")
SPEC = importlib.util.spec_from_file_location(
    "commander_public_base_recovery_archive", SCRIPT
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load Commander recovery archive helper")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def archive_with(path: Path, members: list[tuple[str, bytes, int | None]]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, body, mode in members:
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            if mode is not None:
                info.create_system = 3
                info.external_attr = mode << 16
            bundle.writestr(info, body)


class RecoveryArchiveTest(unittest.TestCase):
    def test_extracts_small_regular_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "state.zip"
            destination = root / "output"
            destination.mkdir()
            archive_with(
                archive,
                [
                    ("intent.json", b"{}\n", stat.S_IFREG | 0o600),
                    ("attestations/policy.jsonl", b"receipt\n", None),
                ],
            )
            result = MODULE.extract_archive(archive, destination)
            self.assertEqual(result["memberCount"], 2)
            self.assertEqual((destination / "intent.json").read_bytes(), b"{}\n")

    def test_rejects_links_traversal_and_duplicate_case(self) -> None:
        fixtures = [
            [("link", b"target", stat.S_IFLNK | 0o777)],
            [("../escape", b"x", None)],
            [("intent.json", b"x", None), ("INTENT.JSON", b"y", None)],
        ]
        for members in fixtures:
            with self.subTest(members=[name for name, _, _ in members]):
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    archive = root / "state.zip"
                    destination = root / "output"
                    destination.mkdir()
                    archive_with(archive, members)
                    with self.assertRaises(RuntimeError):
                        MODULE.extract_archive(archive, destination)

    def test_rejects_zip_bombs_and_member_count_overflow(self) -> None:
        fixtures = [
            [("bomb.json", b"0" * (MODULE.MEMBER_MAX_BYTES + 1), None)],
            [
                (f"member-{index}.json", b"{}", None)
                for index in range(MODULE.MEMBER_MAX_COUNT + 1)
            ],
            [("ratio.json", b"0" * (1024 * 1024), None)],
        ]
        for members in fixtures:
            with self.subTest(member_count=len(members)):
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    archive = root / "state.zip"
                    destination = root / "output"
                    destination.mkdir()
                    archive_with(archive, members)
                    with self.assertRaises(RuntimeError):
                        MODULE.extract_archive(archive, destination)

    def test_stream_copy_fails_above_metadata_bound(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "metadata.json"
            stream = io.TextIOWrapper(
                io.BytesIO(b"x" * (MODULE.METADATA_MAX_BYTES + 1))
            )
            with patch.object(MODULE.sys, "stdin", stream):
                with self.assertRaisesRegex(RuntimeError, "exceeds"):
                    MODULE.bounded_copy(output, MODULE.METADATA_MAX_BYTES)
            self.assertLessEqual(output.stat().st_size, MODULE.METADATA_MAX_BYTES)


if __name__ == "__main__":
    unittest.main()
