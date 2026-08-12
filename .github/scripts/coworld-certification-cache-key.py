#!/usr/bin/env python3

from __future__ import annotations

import os
import sys
from pathlib import Path

from coworld.certifier import load_coworld_package
from coworld.upload import (
    _certification_cache_key,
    _certified_manifest_cache_path,
    _load_string_cache,
)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: coworld-certification-cache-key.py MANIFEST")

    xdg_cache_home = os.environ.get("XDG_CACHE_HOME")
    if not xdg_cache_home:
        raise SystemExit("XDG_CACHE_HOME must identify the isolated certification cache")

    cache_root = Path(xdg_cache_home).resolve()
    cache_path = _certified_manifest_cache_path().resolve()
    try:
        cache_path.relative_to(cache_root)
    except ValueError as exc:
        raise SystemExit("Coworld certification cache escaped XDG_CACHE_HOME") from exc

    manifest_path = Path(sys.argv[1])
    package = load_coworld_package(manifest_path)
    manifest = package.manifest.model_dump(exclude_none=True)
    key = _certification_cache_key(package.manifest_path, manifest=manifest)
    cache = _load_string_cache(cache_path)
    if cache != {key: "certified"}:
        raise SystemExit("isolated Coworld certification cache is not an exact certified-manifest hit")

    sys.stdout.write(f"{key}\n")


if __name__ == "__main__":
    main()
