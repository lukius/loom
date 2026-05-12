from entities import Address


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
    from entities import UserMessage

    dst_addr = _resolve_address(dst, as_obj)
    host.send_message_to(UserMessage(msg), dst_addr)
    return f"sent {len(msg)} bytes to {dst_addr}"


def cmd_ping(host, args, as_obj=None):
    """Ping a destination host (hostname or IP), with optional timeout."""
    timeout = 3.0
    if "-W" in args:
        i = args.index("-W")
        timeout = float(args[i + 1])
        args = args[:i] + args[i + 2:]
    if not args:
        return "syntax: ping <dst> [-W <seconds>]"
    dst = args[0]
    try:
        dst_addr = _resolve_address(dst, as_obj)
    except Exception:
        return f"ping: invalid destination: {dst}"
    rtt = host.ping(dst_addr, timeout=timeout)
    if rtt is None:
        return f"ping {dst}: timeout after {timeout:.2f} s"
    return f"ping {dst} ({dst_addr}): time={rtt * 1000:.2f} ms"


def cmd_route(host, args, as_obj=None):
    """Show the default gateway for this host."""
    return f"gateway: {host.gateway() or '(none)'}"


def cmd_help(host, args, as_obj=None):
    """List available host commands."""
    return "available: ifconfig, send <dst> <msg>, ping <dst> [-W t], route, help"
