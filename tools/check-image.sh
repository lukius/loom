#!/usr/bin/env bash
#
# Check a built loom image: it must not carry a stale CA bundle, must have
# been built against a CA store without the distrusted emSign root, and
# must still boot without packaging tools.
#
# Usage:
#   tools/check-image.sh <image>
set -euo pipefail

image="${1:?usage: tools/check-image.sh <image>}"

docker run --rm --network none --entrypoint sh "$image" -c '
  set -eu
  # find exits non-zero on unreadable directories as a non-root user.
  bundles="$(find / -xdev -name cacert.pem 2>/dev/null || true)"
  if [ -n "$bundles" ]; then
    echo "image carries a pip-vendored CA bundle: $bundles" >&2
    exit 1
  fi
  for tool in pip setuptools wheel; do
    if python -c "import $tool" 2>/dev/null; then
      echo "$tool is still installed in the image" >&2
      exit 1
    fi
  done
  if ls /etc/ssl/certs | grep -qi "emSign_ECC_Root_CA_-_G3"; then
    echo "system CA store still trusts emSign ECC Root CA - G3" >&2
    exit 1
  fi
  python -c "
import time, urllib.request, subprocess, sys
proc = subprocess.Popen([sys.executable, \"loom.py\"])
try:
    for _ in range(60):
        try:
            with urllib.request.urlopen(\"http://127.0.0.1:8000/\", timeout=1) as r:
                assert r.status == 200
                break
        except OSError:
            time.sleep(0.5)
    else:
        sys.exit(\"server did not answer within 30s\")
finally:
    proc.terminate()
"
'

echo "image OK: $image"
