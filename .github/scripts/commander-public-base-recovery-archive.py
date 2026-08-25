#!/usr/bin/env python3
"""Bound Commander public-base recovery downloads and ZIP extraction."""

from __future__ import annotations

import argparse
import os
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath

CHUNK_BYTES = 64 * 1024
METADATA_MAX_BYTES = 64 * 1024
ARCHIVE_MAX_BYTES = 32 * 1024 * 1024
MEMBER_MAX_BYTES = 4 * 1024 * 1024
EXPANDED_MAX_BYTES = 12 * 1024 * 1024
MEMBER_MAX_COUNT = 32
MEMBER_NAME_MAX_BYTES = 256
COMPRESSION_RATIO_MAX = 100


def bounded_copy(output: Path, limit: int) -> int:
    if not output.is_absolute() or output.exists() or not output.parent.is_dir():
        raise RuntimeError("Commander public-base bounded output is invalid")
    written = 0
    with output.open("xb") as target:
        while True:
            chunk = sys.stdin.buffer.read(CHUNK_BYTES)
            if not chunk:
                break
            written += len(chunk)
            if written > limit:
                raise RuntimeError("Commander public-base download exceeds its bound")
            target.write(chunk)
    if written == 0:
        raise RuntimeError("Commander public-base download is empty")
    return written


def safe_member(member: zipfile.ZipInfo) -> PurePosixPath:
    candidate = PurePosixPath(member.filename)
    mode = member.external_attr >> 16
    file_type = stat.S_IFMT(mode)
    if (
        not member.filename
        or len(member.filename.encode("utf-8")) > MEMBER_NAME_MAX_BYTES
        or candidate.is_absolute()
        or not candidate.parts
        or ".." in candidate.parts
        or member.flag_bits & 0x1
        or file_type not in {0, stat.S_IFREG, stat.S_IFDIR}
    ):
        raise RuntimeError(
            f"unsafe Commander public-base recovery member: {member.filename}"
        )
    if (
        member.file_size < 0
        or member.file_size > MEMBER_MAX_BYTES
        or member.compress_size < 0
        or (
            member.file_size > 0
            and (
                member.compress_size == 0
                or member.file_size
                > member.compress_size * COMPRESSION_RATIO_MAX
            )
        )
    ):
        raise RuntimeError(
            f"oversized Commander public-base recovery member: {member.filename}"
        )
    return candidate


def extract_archive(archive: Path, destination: Path) -> dict[str, int]:
    if (
        not archive.is_absolute()
        or not archive.is_file()
        or archive.stat().st_size <= 0
        or archive.stat().st_size > ARCHIVE_MAX_BYTES
        or not destination.is_absolute()
        or not destination.is_dir()
        or any(destination.iterdir())
    ):
        raise RuntimeError("Commander public-base recovery archive input is invalid")
    members: list[tuple[zipfile.ZipInfo, PurePosixPath]] = []
    seen: set[str] = set()
    expanded = 0
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            if len(members) >= MEMBER_MAX_COUNT:
                raise RuntimeError("Commander public-base recovery has too many members")
            candidate = safe_member(member)
            folded = member.filename.casefold()
            if folded in seen:
                raise RuntimeError(
                    f"duplicate Commander public-base recovery member: {member.filename}"
                )
            seen.add(folded)
            expanded += member.file_size
            if expanded > EXPANDED_MAX_BYTES:
                raise RuntimeError(
                    "Commander public-base recovery expanded bytes exceed their bound"
                )
            members.append((member, candidate))

        destination_real = destination.resolve()
        for member, candidate in members:
            target = (destination / Path(*candidate.parts)).resolve()
            if destination_real not in target.parents:
                raise RuntimeError(
                    f"Commander public-base recovery path escapes: {member.filename}"
                )
            if member.is_dir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
                continue
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            copied = 0
            with bundle.open(member) as source, target.open("xb") as output:
                while True:
                    chunk = source.read(CHUNK_BYTES)
                    if not chunk:
                        break
                    copied += len(chunk)
                    if copied > member.file_size or copied > MEMBER_MAX_BYTES:
                        raise RuntimeError(
                            f"Commander public-base recovery member expanded beyond declaration: {member.filename}"
                        )
                    output.write(chunk)
            if copied != member.file_size:
                raise RuntimeError(
                    f"Commander public-base recovery member size mismatch: {member.filename}"
                )
            os.chmod(target, 0o600)
    return {
        "archiveBytes": archive.stat().st_size,
        "memberCount": len(members),
        "expandedBytes": expanded,
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    commands = result.add_subparsers(dest="command", required=True)
    copy = commands.add_parser("copy")
    copy.add_argument("kind", choices=("metadata", "archive"))
    copy.add_argument("output", type=Path)
    extract = commands.add_parser("extract")
    extract.add_argument("archive", type=Path)
    extract.add_argument("destination", type=Path)
    return result


def main() -> None:
    args = parser().parse_args()
    if args.command == "copy":
        limit = (
            METADATA_MAX_BYTES if args.kind == "metadata" else ARCHIVE_MAX_BYTES
        )
        print(bounded_copy(args.output, limit))
        return
    result = extract_archive(args.archive, args.destination)
    print(
        f"archiveBytes={result['archiveBytes']} memberCount={result['memberCount']} expandedBytes={result['expandedBytes']}"
    )


if __name__ == "__main__":
    main()
