"""Read-only endpoints that list and serve ``*.yaml`` topologies.

Lists ``*.yaml`` topologies in the configured samples directory (default
``<repo>/samples``, overridable via the ``LOOM_SAMPLES`` env var) and serves
their contents. Session clones (``*.session.yaml``) are filtered out.

Subpaths are intentionally not registered: `/samples/{name}` only accepts
a bare filename, so a request like `/samples/../etc/passwd` falls through
to a 404 rather than walking the filesystem.
"""

from fastapi import APIRouter, HTTPException, Request

router = APIRouter(tags=["files"])


def _samples_dir(request: Request):
    return request.app.state.samples_dir


@router.get("/samples")
def list_samples(request: Request):
    base = _samples_dir(request)
    if not base.is_dir():
        return {"files": []}
    files = sorted(
        p.name
        for p in base.iterdir()
        if p.is_file()
        and p.suffix in (".yaml", ".yml")
        and not p.name.endswith(".session.yaml")
    )
    return {"files": files}


@router.get("/samples/{filename}")
def read_sample(filename: str, request: Request):
    # Reject any name that isn't a plain file in the samples dir.
    if "/" in filename or "\\" in filename or filename in ("", ".", ".."):
        raise HTTPException(400, "invalid filename")
    base = _samples_dir(request)
    path = base / filename
    if not path.is_file() or path.parent.resolve() != base.resolve():
        raise HTTPException(404, "not found")
    return {"yaml": path.read_text()}
