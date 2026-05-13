from fastapi import APIRouter, Body, HTTPException, Request

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
        from server.state import InvalidStateTransition  # noqa: PLC0415

        status = (
            409
            if isinstance(e, InvalidStateTransition) and e.from_state in _SIM_STATES
            else 400
        )
        raise HTTPException(status, msg)
    _emit_sim_state(request, s.state)
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


REFRESH_MIN = 1
REFRESH_MAX = 300


@router.post("/refresh_interval")
def set_refresh_interval(request: Request, body: dict = Body(...)):
    seconds = body.get("seconds") if isinstance(body, dict) else None
    if not isinstance(seconds, (int, float)) or isinstance(seconds, bool):
        raise HTTPException(400, "seconds must be a number")
    if seconds < REFRESH_MIN or seconds > REFRESH_MAX:
        raise HTTPException(400, f"seconds must be in [{REFRESH_MIN}, {REFRESH_MAX}]")
    s = _state(request)
    if s.as_obj is None:
        raise HTTPException(409, "simulation not started")
    for r in s.as_obj.routers().values():
        r._protocol.set_keepalive_interval(seconds)
    return {"seconds": seconds}
