import hashlib
import os
import shutil
import tempfile
from pathlib import Path


def _session_dir() -> Path:
    """Where session clones live.

    Defaults to `<system-tmp>/loom`, which is wiped automatically by the
    OS on reboot on every Linux/macOS distribution that mounts /tmp as
    tmpfs. Override with `LOOM_SESSION_DIR` (e.g. for tests or for users
    who want the sessions kept across reboots in a stable directory).
    Placed outside the source tree so a read-only LOOM_TOPOLOGY still
    works and so source directories stay clean.
    """
    override = os.environ.get("LOOM_SESSION_DIR")
    if override:
        return Path(override).expanduser()
    return Path(tempfile.gettempdir()) / "loom"


def _session_path_for(source: Path) -> Path:
    # Disambiguate sources that share a basename (e.g. two `sample.yaml`
    # files in different directories) by suffixing a short hash of the
    # absolute path.
    src_hash = hashlib.sha1(str(source.resolve()).encode()).hexdigest()[:8]
    return _session_dir() / f"{source.stem}.{src_hash}.session{source.suffix}"


def prepare_session(source: Path) -> Path:
    """Ensure a session file exists for `source`. Returns the session path."""
    session_dir = _session_dir()
    session_dir.mkdir(parents=True, exist_ok=True)
    target = _session_path_for(source)
    if not target.exists():
        shutil.copyfile(source, target)
    return target


def reset_session(source: Path) -> Path:
    """Delete the session file (if any) and re-clone from source."""
    target = _session_path_for(source)
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
