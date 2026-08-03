#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "usage: $0 /absolute/path/to/static-replay-viewer" >&2
    exit 2
fi

output_dir="$1"
if [[ "$output_dir" != /* || "$output_dir" == "/" ]]; then
    echo "output path must be an absolute, non-root directory" >&2
    exit 2
fi
if [[ "$(basename "$output_dir")" != "static-replay-viewer" ]]; then
    echo "output directory must be named static-replay-viewer" >&2
    exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
staging_dir="$repo_root/static"

if [[ -L "$output_dir" ]]; then
    echo "refusing to replace symlink output directory: $output_dir" >&2
    exit 2
fi

rm -rf -- "$output_dir"
mkdir -p -- "$output_dir"

(
    cd "$repo_root"
    npm run build-static-replay-viewer
)

cp -- "$staging_dir/index.html" "$output_dir/index.html"
cp -- "$staging_dir/asset-manifest.json" "$output_dir/asset-manifest.json"
cp -R -- "$staging_dir/assets" "$output_dir/assets"
cp -R -- "$staging_dir/_assets" "$output_dir/_assets"

test -s "$output_dir/index.html"
