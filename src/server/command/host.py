import time

from entities import Address, UserMessage


def _interprobe_wait(interval: float, gate) -> bool:
    """Wait `interval` seconds between ping probes.

    When the AS exposes a PauseGate, the wait goes through it so it pauses with
    the simulation and aborts immediately on Stop. Returns True to keep going,
    False if the simulation was stopped mid-wait.
    """
    if interval <= 0:
        return True
    if gate is None:
        time.sleep(interval)
        return True
    _ticked, stopped = gate.sleep(interval)
    if stopped:
        return False
    _running, stopped = gate.wait_or_stop()   # block here while paused
    return not stopped


def cmd_ifconfig(host, args, as_obj=None):
    """Show interface configuration for a host."""
    iface = host.interface()
    lines = [
        f"{iface.name()}: addr={iface.address()} net={iface.network().name()} "
        f"({iface.network().address()}) cost={iface.cost()}"
    ]
    if host.gateway():
        lines.append(f"  gateway: {host.gateway()}")
    return "\n".join(lines)


def _resolve_address(dst, as_obj):
    """Resolve a hostname or IP string to an Address.

    Tries the AS host table first; falls back to treating it as a literal IP.
    """
    if as_obj is not None:
        try:
            return as_obj.host(dst).address()
        except Exception:
            pass
    return Address(dst)


def cmd_send(host, args, as_obj=None):
    """Send a user message to a destination (hostname or IP)."""
    if len(args) < 2:
        return "syntax: send <dst> <message>"
    dst, msg = args[0], " ".join(args[1:])
    dst_addr = _resolve_address(dst, as_obj)
    host.send_message_to(UserMessage(msg), dst_addr)
    return f"sent {len(msg)} bytes to {dst_addr}"


def cmd_ping(host, args, as_obj=None):
    """Ping a destination, optionally N times, optionally spaced.

    Syntax: ping <dst> [-W <seconds>] [-c <count>] [-i <seconds>].
    """
    syntax = "syntax: ping <dst> [-W <seconds>] [-c <count>] [-i <seconds>]"
    timeout = 3.0
    count = 1
    interval = 1.0   # like real ping: probes are 1 s apart unless -i overrides
    args = list(args)
    if "-W" in args:
        i = args.index("-W")
        timeout = float(args[i + 1])
        args = args[:i] + args[i + 2:]
    if "-c" in args:
        i = args.index("-c")
        try:
            count = int(args[i + 1])
        except (IndexError, ValueError):
            return syntax
        args = args[:i] + args[i + 2:]
    if "-i" in args:
        i = args.index("-i")
        try:
            interval = float(args[i + 1])
        except (IndexError, ValueError):
            return syntax
        args = args[:i] + args[i + 2:]
    if count <= 0:
        return "count must be positive"
    if count > 100:
        return "count capped at 100"
    if interval < 0:
        return "interval must be non-negative"
    if interval > 60:
        return "interval capped at 60 s"
    if not args:
        return syntax
    dst = args[0]
    try:
        dst_addr = _resolve_address(dst, as_obj)
    except Exception:
        return f"ping: invalid destination: {dst}"

    gate = as_obj.gate() if as_obj is not None and hasattr(as_obj, "gate") else None
    received = 0
    for i in range(count):
        rtt = host.ping(dst_addr, timeout=timeout)
        if rtt is not None:
            received += 1
        if i < count - 1 and not _interprobe_wait(interval, gate):
            break
    loss = 100.0 * (count - received) / count
    lines = [
        f"--- {dst} ping statistics ---",
        f"{count} sent, {received} received, {loss:.0f}% loss",
    ]
    return "\n".join(lines)


def cmd_route(host, args, as_obj=None):
    """Show the default gateway for this host."""
    return f"gateway: {host.gateway() or '(none)'}"


def cmd_set_gateway(host, args, as_obj=None):
    """Set the host's default gateway: set_gateway <ip>."""
    if len(args) != 1:
        return "syntax: set_gateway <ip>"
    try:
        addr = Address(args[0])
    except Exception:
        return f"set_gateway: invalid address: {args[0]}"
    host.set_gateway(addr)
    return f"gateway set to {addr}"


def cmd_help(host, args, as_obj=None):
    """List available host commands."""
    return (
        "available: ifconfig, send <dst> <msg>, ping <dst> [-W t] [-c n] [-i s], "
        "route, set_gateway <ip>, help"
    )
