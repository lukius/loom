#!/usr/bin/env python3
"""Print one version's section of CHANGELOG.md, for use as release notes.

Usage: tools/changelog-section.py v1.0.0
"""

import pathlib
import re
import sys

# Link-reference definitions ("[1.0.0]: https://...") and horizontal rules
# are changelog scaffolding, not release notes.
_SCAFFOLDING = re.compile(r"^(\[[^\]]+\]:\s|---\s*$)")


def section_for(text: str, version: str) -> str:
    """Return the body of the ``## [version]`` section, without its heading."""
    match = re.search(
        rf"^## \[{re.escape(version)}\].*?$(.*?)(?=^## \[|\Z)",
        text,
        re.MULTILINE | re.DOTALL,
    )
    if match is None:
        raise SystemExit(f"no CHANGELOG.md section for version {version}")
    body = "\n".join(
        line for line in match.group(1).splitlines() if not _SCAFFOLDING.match(line)
    )
    return body.strip()


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    version = sys.argv[1].removeprefix("v")
    root = pathlib.Path(__file__).resolve().parent.parent
    body = section_for((root / "CHANGELOG.md").read_text(), version)
    print(body or f"Release {version}")


if __name__ == "__main__":
    main()
