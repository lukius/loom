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
    """Ping a destination, optionally N times: ping <dst> [-W <s>] [-c <n>]."""
    timeout = 3.0
    count = 1
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
            return "syntax: ping <dst> [-W <seconds>] [-c <count>]"
        args = args[:i] + args[i + 2:]
    if count <= 0:
        return "count must be positive"
    if count > 100:
        return "count capped at 100"
    if not args:
        return "syntax: ping <dst> [-W <seconds>] [-c <count>]"
    dst = args[0]
    try:
        dst_addr = _resolve_address(dst, as_obj)
    except Exception:
        return f"ping: invalid destination: {dst}"

    lines = []
    received = 0
    for _ in range(count):
        rtt = host.ping(dst_addr, timeout=timeout)
        if rtt is None:
            lines.append(f"{dst}: timeout after {timeout:.2f} s")
        else:
            received += 1
            lines.append(f"{dst} ({dst_addr}): time={rtt * 1000:.2f} ms")
    loss = 100.0 * (count - received) / count
    lines.append(f"--- {dst} ping statistics ---")
    lines.append(f"{count} sent, {received} received, {loss:.0f}% loss")
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
        "available: ifconfig, send <dst> <msg>, ping <dst> [-W t] [-c n], "
        "route, set_gateway <ip>, help"
    )
