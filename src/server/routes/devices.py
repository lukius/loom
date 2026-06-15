from fastapi import APIRouter, Body, HTTPException, Request

from entities import Router
from entities.exception import EntityException
from server.command.dispatch import dispatch
from server.state import InvalidStateTransition

router = APIRouter(prefix="/devices", tags=["devices"])


def _device_or_404(request: Request, name: str):
    """Resolve a device under the state lock, mapping errors to HTTP exceptions.

    Uses SimState.device_under_lock() so the None-check and the device()
    lookup are atomic — stop() cannot null _as between them.

    Raises:
        HTTPException(409): no topology loaded.
        HTTPException(404): unknown device name.
    """
    s = request.app.state.sim_state
    try:
        return s.device_under_lock(name)
    except InvalidStateTransition:
        raise HTTPException(409, "no topology loaded")
    except EntityException:
        raise HTTPException(404, f"unknown device: {name}")


@router.post("/{name}/command")
def command(name: str, body: dict, request: Request):
    """Dispatch a command to a device and return {ok, output}.

    The device is resolved under the state lock (atomic with the None-check).
    dispatch() is called AFTER releasing the lock because commands (ping, send)
    can block for seconds and must not stall the control plane.
    """
    device = _device_or_404(request, name)
    cmd_line = body.get("cmd", "")
    # Snapshot as_obj for dispatch (best-effort; a stop() after resolve is
    # acceptable — entity operations on a torn-down sim are idempotent).
    as_obj = request.app.state.sim_state.as_obj_under_lock()
    return dispatch(device, cmd_line, as_obj=as_obj)


@router.get("/{name}/interfaces")
def interfaces(name: str, request: Request):
    """Return all interfaces of a device, plus a router-level halted flag."""
    device = _device_or_404(request, name)
    out = []
    for iname, iface in device.interfaces().items():
        out.append(
            {
                "name": iname,
                "address": str(iface.address()),
                "network": iface.network().name(),
                "cost": iface.cost(),
                "up": iface.is_up(),
            }
        )
    return {
        "interfaces": out,
        "halted": isinstance(device, Router) and device.is_halted(),
    }


@router.get("/{name}/routes")
def routes(name: str, request: Request):
    """Return routing table rules for a device (empty list for hosts)."""
    device = _device_or_404(request, name)
    if not isinstance(device, Router):
        return {"rules": []}
    rules = []
    for r in device.routing_table().rules():
        rules.append(
            {
                "prefix": str(r.prefix()),
                "next_hop": str(r.next_hop()),
                "iface": r.interface().name(),
            }
        )
    return {"rules": rules}


@router.get("/{name}/nat-table")
def nat_table(name: str, request: Request):
    """Return the NAT-table snapshot for a router (empty list for hosts).

    Events on the bus carry incremental changes only, so a fresh subscriber
    with no prior event history has no way to recover the current table
    without this read endpoint.
    """
    device = _device_or_404(request, name)
    if not isinstance(device, Router):
        return {"entries": []}
    return {"entries": device.nat_table().snapshot()}


@router.post("/{name}/fail")
def fail(name: str, request: Request, body: dict | None = Body(default=None)):
    """Crash a router (silent failure): no withdrawal, peers detect via timers.

    No body / no ``interface`` key -> crash the whole router.
    ``{"interface": "eth0"}`` -> crash that one interface. Routers only.
    """
    device = _device_or_404(request, name)
    if not isinstance(device, Router):
        raise HTTPException(400, "fail is only supported on routers")
    iface = (body or {}).get("interface")
    if iface:
        if iface not in device.interfaces():
            raise HTTPException(404, f"unknown interface: {iface}")
        device.disable_interface(iface, graceful=False)
    else:
        device.halt(graceful=False)
    return {"ok": True}
