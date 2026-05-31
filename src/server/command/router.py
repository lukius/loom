def cmd_ifconfig(router, args, as_obj=None):
    """Show interfaces, or toggle one: ifconfig [<iface> up|down]."""
    if not args:
        return "\n".join(
            f"{name}: addr={iface.address()} net={iface.network().name()} "
            f"({iface.network().address()}) cost={iface.cost()} "
            f"{'up' if iface.is_up() else 'down'}"
            for name, iface in router.interfaces().items()
        )
    if len(args) != 2 or args[1] not in ("up", "down"):
        return "syntax: ifconfig [<iface> up|down]"
    iface_name, action = args
    if iface_name not in router.interfaces():
        return f"no such interface: {iface_name}"
    if action == "down":
        router.disable_interface(iface_name, graceful=True)
        return f"{iface_name} down"
    router.enable_interface(iface_name)
    return f"{iface_name} up"


def cmd_route(router, args, as_obj=None):
    """Show the routing table."""
    rows = router.routing_table().rules()
    if not rows:
        return "(empty routing table)"
    lines = [f"{'prefix':<20} {'next_hop':<15} iface"]
    for r in rows:
        lines.append(
            f"{str(r.prefix()):<20} {str(r.next_hop()):<15} {r.interface().name()}"
        )
    return "\n".join(lines)


def cmd_update_cost(router, args, as_obj=None):
    """Update interface cost: update_cost <iface> <cost>."""
    if len(args) != 2:
        return "syntax: update_cost <iface> <cost>"
    iface, cost = args[0], int(args[1])
    if cost <= 0:
        return "cost must be positive"
    router.update_interface(iface, cost)
    return f"cost of {iface} set to {cost}"


def cmd_neighbors(router, args, as_obj=None):
    """Show directly-connected neighbor routers."""
    graph = router.protocol()._graph  # noqa: SLF001
    my_nets = {iface.network().address() for iface in router.interfaces().values()}
    lines = []
    for node in graph._routers:  # noqa: SLF001
        if node == router:
            continue
        other_nets = {iface.network().address() for iface in node.interfaces().values()}
        shared = my_nets & other_nets
        for net_addr in shared:
            for iface in node.interfaces().values():
                if iface.network().address() == net_addr:
                    lines.append(
                        f"  {node.name():<6} via {iface.network().name():<8} "
                        f"({iface.address()})  cost={iface.cost()}"
                    )
    return "\n".join(lines) if lines else "(no neighbors yet)"


def cmd_halt(router, args, as_obj=None):
    """Gracefully halt the whole router (floods a withdrawal)."""
    router.halt(graceful=True)
    return f"{router.name()} halted"


def cmd_resume(router, args, as_obj=None):
    """Resume a halted router (re-announces)."""
    router.resume()
    return f"{router.name()} resumed"


def cmd_help(router, args, as_obj=None):
    """List available router commands."""
    return (
        "available: route, update_cost <iface> <cost>, ifconfig [<iface> up|down], "
        "halt, resume, neighbors, help"
    )
