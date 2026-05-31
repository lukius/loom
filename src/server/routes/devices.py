from fastapi import APIRouter, Body, HTTPException, Request

from entities import Router
from server.command.dispatch import dispatch

router = APIRouter(prefix="/devices", tags=["devices"])


def _device_or_404(request: Request, name: str):
    """Fetch a device by name, raising 404 if absent or no topology is loaded."""
    s = request.app.state.sim_state
    if s.as_obj is None:
        raise HTTPException(409, "no topology loaded")
    try:
        return s.as_obj.device(name)
    except Exception:
        raise HTTPException(404, f"unknown device: {name}")


@router.post("/{name}/command")
def command(name: str, body: dict, request: Request):
    """Dispatch a command to a device and return {ok, output}."""
    device = _device_or_404(request, name)
    cmd_line = body.get("cmd", "")
    as_obj = request.app.state.sim_state.as_obj
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
        "halted": bool(getattr(device, "is_halted", lambda: False)()),
    }


@router.get("/{name}/routes")
def routes(name: str, request: Request):
    """Return routing table rules for a device (empty list for hosts)."""
    device = _device_or_404(request, name)
    table = getattr(device, "routing_table", None)
    if table is None:
        return {"rules": []}
    rules = []
    for r in table().rules():
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
    (e.g. the SPA after a page reload) has no way to recover the current
    table without this read endpoint.
    """
    device = _device_or_404(request, name)
    table = getattr(device, "nat_table", None)
    if table is None:
        return {"entries": []}
    return {"entries": table().snapshot()}


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
