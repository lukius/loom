from fastapi import APIRouter, Body, HTTPException, Request

from routing import LinkStateProtocol
from server.state import InvalidStateTransition

router = APIRouter(prefix="/sim", tags=["sim"])


def _state(request: Request):
    return request.app.state.sim_state


def _emit_sim_state(request: Request, state: str) -> None:
    bus = request.app.state.event_bus
    if bus is not None:
        bus.emit({"kind": "sim_state", "state": state})


@router.post("/start")
def start(request: Request):
    s = _state(request)
    try:
        s.start()
    except Exception as e:
        raise HTTPException(409, str(e))
    _emit_sim_state(request, s.state)
    return {"state": s.state}


@router.post("/pause")
def pause(request: Request):
    s = _state(request)
    try:
        s.pause()
    except Exception as e:
        raise HTTPException(409, str(e))
    _emit_sim_state(request, s.state)
    return {"state": s.state}


_SIM_STATES = frozenset({"idle", "running", "paused"})


@router.post("/resume")
def resume(request: Request, body: dict | None = Body(default=None)):
    s = _state(request)
    try:
        s.resume(patch=(body or {}).get("patch"))
    except Exception as e:
        msg = str(e)
        # 409 only for true state-machine violations (wrong sim state for transition).
        # Patch validation errors use pseudo-state names and map to 400.
        status = (
            409
            if isinstance(e, InvalidStateTransition) and e.from_state in _SIM_STATES
            else 400
        )
        raise HTTPException(status, msg)
    _emit_sim_state(request, s.state)
    return {"state": s.state}


@router.post("/edit")
def edit(request: Request, body: dict = Body(...)):
    s = _state(request)
    try:
        s.edit(patch=(body or {}).get("patch"))
    except Exception as e:
        status = (
            409
            if isinstance(e, InvalidStateTransition) and e.from_state in _SIM_STATES
            else 400
        )
        raise HTTPException(status, str(e))
    return {"state": s.state}


@router.post("/stop")
def stop(request: Request):
    s = _state(request)
    s.stop()
    _emit_sim_state(request, s.state)
    return {"state": s.state}


@router.get("/state")
def get_state(request: Request):
    s = _state(request)
    return {"state": s.state, "as_name": s.as_obj.name() if s.as_obj else None}


@router.post("/protocol_config")
def set_protocol_config(request: Request, body: dict = Body(...)):
    hello = body.get("hello_interval")
    refresh = body.get("lsa_refresh_interval")
    if hello is None or refresh is None:
        raise HTTPException(
            status_code=400,
            detail="hello_interval and lsa_refresh_interval are required",
        )
    try:
        hello = float(hello)
        refresh = float(refresh)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid numeric value")
    if hello <= 0 or refresh <= 0:
        raise HTTPException(status_code=400, detail="timers must be positive")
    s = _state(request)
    if s.as_obj is None:
        raise HTTPException(status_code=409, detail="no system loaded")
    for r in s.as_obj.routers().values():
        for proto in r.protocols():
            if isinstance(proto, LinkStateProtocol):
                proto.set_timers(hello_interval=hello, lsa_refresh_interval=refresh)
    return {"ok": True, "hello_interval": hello, "lsa_refresh_interval": refresh}
