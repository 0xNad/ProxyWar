#!/usr/bin/env python3
"""Fetch one platform-issued Coworld 0.1.42 episode bundle.

The caller supplies an isolated authenticated HOME. This helper never accepts,
reads, or forwards an API token and creates the destination exclusively.
"""

from __future__ import annotations

import os
import re
import sys
import io
import json
import stat
import zipfile

from coworld.api_client import CoworldApiClient


MAX_BUNDLE_BYTES = 512 * 1024 * 1024


def main() -> int:
    if len(sys.argv) != 3:
        raise RuntimeError("usage: fetch-commander-xp-episode-bundle.py <ereq> <new-output>")
    ereq, output = sys.argv[1:]
    if not re.fullmatch(r"ereq_[A-Za-z0-9-]+", ereq):
        raise RuntimeError("episode request id is invalid")
    if "COWORLD_API_TOKEN" in os.environ:
        raise RuntimeError("API token must not reach the bundle fetch helper")
    with CoworldApiClient.from_login(server_url="https://softmax.com/api") as client:
        body = client.get_episode_request_bundle(
            ereq,
            include=["results", "replay", "game_logs"],
        )
    if not isinstance(body, bytes) or not body or len(body) > MAX_BUNDLE_BYTES:
        raise RuntimeError("episode bundle byte length is invalid")
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        expected = ["logs/game.log", "manifest.json", "replay", "results.json"]
        if sorted(names) != expected or len(set(names)) != len(names):
            raise RuntimeError("episode bundle entry allowlist mismatch")
        for entry in entries:
            mode = entry.external_attr >> 16
            if (
                entry.is_dir()
                or entry.filename.startswith("/")
                or "\\" in entry.filename
                or ".." in entry.filename.split("/")
                or stat.S_ISLNK(mode)
                or (mode and not stat.S_ISREG(mode))
                or entry.file_size > 256 * 1024 * 1024
            ):
                raise RuntimeError("episode bundle contains an unsafe entry")
        manifest = json.loads(archive.read("manifest.json"))
        if (
            set(manifest) != {"ereq_id", "status", "include", "files"}
            or manifest["ereq_id"] != ereq
            or manifest["status"] != "success"
            or manifest["include"] != ["results", "replay", "game_logs"]
            or manifest["files"]
            != {
                "results": "results.json",
                "replay": "replay",
                "game_logs": {"combined": "logs/game.log"},
            }
        ):
            raise RuntimeError("episode bundle manifest mismatch")
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(body)
    except BaseException:
        try:
            os.unlink(output)
        except FileNotFoundError:
            pass
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
