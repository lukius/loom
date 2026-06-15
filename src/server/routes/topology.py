from fastapi import APIRouter, HTTPException, Request

from server.state import InvalidStateTransition

router = APIRouter(tags=["topology"])


def _state(request: Request):
    return request.app.state.sim_state


@router.post("/topology")
def load(body: dict, request: Request):
    yaml_text = body.get("yaml", "")
    if not yaml_text:
        raise HTTPException(400, "missing 'yaml'")
    s = _state(request)
    try:
        s.load_from_text(yaml_text)
    except InvalidStateTransition:
        raise HTTPException(409, "stop the simulation before importing a topology")
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
    yaml_text = s.dump_yaml_under_lock()
    if yaml_text is not None:
        return {"yaml": yaml_text}
    return {"yaml": s.session_path.read_text()}


@router.get("/topology/source")
def source(request: Request):
    """Basename of the topology source file (LOOM_TOPOLOGY).

    Returns the basename of the topology source; consumers may use it
    as a default filename stem.
    """
    return {"name": _state(request).source.name}


@router.post("/topology/reset")
def reset(request: Request):
    s = _state(request)
    if s.state != "idle":
        raise HTTPException(409, "stop the simulation before reset")
    s.reset_session()
    return {"ok": True, "as_name": s.as_obj.name()}
