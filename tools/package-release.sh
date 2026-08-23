#!/usr/bin/env bash
#
# Build the curated source archive attached to a GitHub Release.
#
# Unlike GitHub's automatic source zip, this carries only what a user
# needs to run loom: the simulator, the SPA, the sample topologies and
# the docs. Tests, e2e, and dev tooling are left out.
#
# Usage:
#   tools/package-release.sh [version]     # defaults to the nearest git tag
#   OUT_DIR=/tmp tools/package-release.sh 1.0.0
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

version="${1:-$(git describe --tags --abbrev=0)}"
version="${version#v}"
name="loom-${version}"
outdir="${OUT_DIR:-dist}"

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

mkdir -p "$staging/$name"
cp -r src web samples docs "$staging/$name/"
cp requirements.txt README.md README.es.md LICENSE CHANGELOG.md "$staging/$name/"

find "$staging/$name" -name '__pycache__' -type d -prune -exec rm -rf {} +
find "$staging/$name" -name '*.py[co]' -delete

mkdir -p "$outdir"
outdir="$(cd "$outdir" && pwd)"
rm -f "$outdir/$name.zip"
(cd "$staging" && zip -qr "$outdir/$name.zip" "$name")

echo "$outdir/$name.zip"
