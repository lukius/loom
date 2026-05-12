from fastapi import APIRouter, HTTPException, Request

from server.persistence import atomic_write, reset_session

router = APIRouter(tags=["topology"])


def _state(request: Request):
    return request.app.state.sim_state


@router.post("/topology")
def load(body: dict, request: Request):
    yaml_text = body.get("yaml", "")
    if not yaml_text:
        raise HTTPException(400, "missing 'yaml'")
    s = _state(request)
    atomic_write(s.session_path, yaml_text)
    try:
        s.load_from_session()
    except Exception as e:
        raise HTTPException(400, str(e))
    return {
        "ok": True,
        "as_name": s.as_obj.name(),
        "devices": [d for d in (*s.as_obj.hosts(), *s.as_obj.routers())],
        "networks": list(s.as_obj.networks()),
    }


@router.get("/topology")
def fetch(request: Request):
    s = _state(request)
    return {"yaml": s.session_path.read_text()}


@router.post("/topology/reset")
def reset(request: Request):
    s = _state(request)
    if s.state != "idle":
        raise HTTPException(409, "stop the simulation before reset")
    reset_session(s.source)
    s._session = None  # noqa: SLF001 — deliberate private poke; refactor later
    s.load_from_session()
    return {"ok": True, "as_name": s.as_obj.name()}
