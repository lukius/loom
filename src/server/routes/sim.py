from fastapi import APIRouter, Body, HTTPException, Request

router = APIRouter(prefix="/sim", tags=["sim"])


def _state(request: Request):
    return request.app.state.sim_state


@router.post("/start")
def start(request: Request):
    s = _state(request)
    try:
        s.start()
    except Exception as e:
        raise HTTPException(409, str(e))
    return {"state": s.state}


@router.post("/pause")
def pause(request: Request):
    s = _state(request)
    try:
        s.pause()
    except Exception as e:
        raise HTTPException(409, str(e))
    return {"state": s.state}


@router.post("/resume")
def resume(request: Request, body: dict | None = Body(default=None)):
    s = _state(request)
    try:
        s.resume()
        # patch application is Task 15
    except Exception as e:
        raise HTTPException(409, str(e))
    return {"state": s.state}


@router.post("/stop")
def stop(request: Request):
    s = _state(request)
    s.stop()
    return {"state": s.state}


@router.get("/state")
def get_state(request: Request):
    s = _state(request)
    return {"state": s.state, "as_name": s.as_obj.name() if s.as_obj else None}
