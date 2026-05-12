import shlex

from entities import Host, Router


def dispatch(device, cmd_line: str, as_obj=None) -> dict:
    """Dispatch a command string to device-specific handlers.

    Returns a dict with keys 'ok' (bool) and 'output' (str).
    """
    parts = shlex.split(cmd_line.strip()) if cmd_line.strip() else []
    if not parts:
        return {"ok": False, "output": "empty command"}
    name, args = parts[0], parts[1:]

    if isinstance(device, Host):
        from . import host as handlers
    elif isinstance(device, Router):
        from . import router as handlers
    else:
        return {"ok": False, "output": "unknown device type"}

    fn = getattr(handlers, f"cmd_{name}", None)
    if fn is None:
        return {"ok": False, "output": f"unknown command: {name}"}
    try:
        out = fn(device, args, as_obj)
        return {"ok": True, "output": out}
    except Exception as e:
        return {"ok": False, "output": str(e)}
