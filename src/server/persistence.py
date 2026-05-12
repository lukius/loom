import os
import shutil
import tempfile
from pathlib import Path


def prepare_session(source: Path) -> Path:
    """Ensure a session file exists for `source`. Returns the session path.

    Naming: foo.yaml -> foo.session.yaml in the same directory.
    """
    target = source.with_name(source.stem + ".session" + source.suffix)
    if not target.exists():
        shutil.copyfile(source, target)
    return target


def reset_session(source: Path) -> Path:
    """Delete the session file (if any) and re-clone from source."""
    target = source.with_name(source.stem + ".session" + source.suffix)
    if target.exists():
        target.unlink()
    return prepare_session(source)


def atomic_write(target: Path, content: str) -> None:
    """Write `content` to `target` atomically via a temp file + rename."""
    fd, tmp = tempfile.mkstemp(prefix=target.name + ".", dir=str(target.parent))
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.replace(tmp, target)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
