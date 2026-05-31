import cmd
import functools
import sys

from entities import EntityException, UserMessage
from parser import Parser


def requires_system(func):
    @functools.wraps(func)
    def cmd_func(self, arg):
        if self._system is None:
            print('system not initialized!')
        else:
            try:
                func(self, arg)
            except EntityException as exc:
                print(exc.message)

    return cmd_func


class Shell(cmd.Cmd):

    intro = 'loom shell v1.0'
    prompt = '# '

    def __init__(self):
        super().__init__()
        self._system = None

    @requires_system
    def do_route(self, arg):
        'Print the routing table of the given host/router'
        device = self._system.device(arg)
        routing_rules = device.routing_table().rules()
        print(f'{"Prefix": <20} {"Next hop": <15} {"Interface": <10}')
        for rule in routing_rules:
            print(f'{str(rule.prefix()): <20} {str(rule.next_hop()): <15} {rule.interface().name(): <10}')  # noqa: E501 — fixed-width table row

    @requires_system
    def do_send(self, arg):
        'Send a datagram from one host to another'
        try:
            src, dst, msg_str = arg.split()
        except ValueError:
            print('syntax: send <src host: str> <dst host: str> <message: str>')
        else:
            src_host = self._system.host(src)
            dst_host = self._system.host(dst)

            msg = UserMessage(msg_str)
            src_host.send_message_to(msg, dst_host.address())

    @requires_system
    def do_set_gateway(self, arg):
        "Set a host's default gateway. Syntax: set_gateway <host> <ip>"
        parts = arg.split()
        if len(parts) != 2:
            print('syntax: set_gateway <host> <ip>')
            return
        name, ip = parts
        from entities import Address, Host

        device = self._system.device(name)
        if not isinstance(device, Host):
            print(f'set_gateway: {name} is not a host')
            return
        try:
            addr = Address(ip)
        except Exception:
            print(f'set_gateway: invalid address: {ip}')
            return
        try:
            device.set_gateway(addr)
        except ValueError as e:
            print(f'set_gateway: {e}')
            return
        print(f'{name}: gateway set to {addr}')

    @requires_system
    def do_update_cost(self, arg):
        'Update the cost of a router interface'
        try:
            router_str, iface_str, cost_str = arg.split()
            cost = int(cost_str)
            if cost <= 0:
                raise ValueError
        except ValueError:
            print('syntax: update_cost <router: str> <interface: str> <cost: int>')
        else:
            router = self._system.router(router_str)
            router.update_interface(iface_str, cost)

    @requires_system
    def do_ifconfig(self, arg):
        'Show interfaces, or toggle one: ifconfig <device> [<iface> up|down]'
        parts = arg.split()
        if not parts:
            print('syntax: ifconfig <device> [<iface> up|down]')
            return
        name = parts[0]
        device = self._system.device(name)
        if len(parts) == 3 and parts[2] in ('up', 'down'):
            from entities import Router

            if not isinstance(device, Router):
                print('ifconfig up/down is only supported on routers')
                return
            iface_name, action = parts[1], parts[2]
            if iface_name not in device.interfaces():
                print(f'no such interface: {iface_name}')
                return
            if action == 'down':
                device.disable_interface(iface_name, graceful=True)
            else:
                device.enable_interface(iface_name)
            print(f'{name}: {iface_name} {action}')
            return
        for iname, iface in device.interfaces().items():
            print(
                f'{iname}: addr={iface.address()} '
                f'net={iface.network().name()} ({iface.network().address()}) '
                f'cost={iface.cost()} {"up" if iface.is_up() else "down"}'
            )
        from entities import Host

        if isinstance(device, Host) and device.gateway() is not None:
            print(f'  gateway: {device.gateway()}')

    @requires_system
    def do_halt(self, arg):
        'Gracefully halt a router. Syntax: halt <router>'
        name = arg.strip()
        if not name:
            print('syntax: halt <router>')
            return
        self._system.router(name).halt(graceful=True)
        print(f'{name} halted')

    @requires_system
    def do_resume(self, arg):
        'Resume a halted router. Syntax: resume <router>'
        name = arg.strip()
        if not name:
            print('syntax: resume <router>')
            return
        self._system.router(name).resume()
        print(f'{name} resumed')

    @requires_system
    def do_neighbors(self, arg):
        'List the directly-connected neighbor routers. Syntax: neighbors <router>'
        name = arg.strip()
        if not name:
            print('syntax: neighbors <router>')
            return
        router = self._system.router(name)
        graph = router.protocol()._graph  # noqa: SLF001
        my_nets = {iface.network().address() for iface in router.interfaces().values()}
        seen = set()
        for node in graph._routers:
            if node == router or node.name() in seen:
                continue
            other_nets = {
                iface.network().address() for iface in node.interfaces().values()
            }
            shared = my_nets & other_nets
            if not shared:
                continue
            for net_addr in shared:
                for iface in node.interfaces().values():
                    if iface.network().address() == net_addr:
                        print(
                            f'  {node.name():<6} via {iface.network().name():<8} '
                            f'({iface.address()})  cost={iface.cost()}'
                        )
            seen.add(node.name())
        if not seen:
            print('  no neighbors yet')

    @requires_system
    def do_ping(self, arg):
        'Ping between hosts. Syntax: ping <src> <dst> [-W <seconds>] [-c <count>]'
        parts = arg.split()
        timeout = 3.0
        count = 1
        if '-W' in parts:
            i = parts.index('-W')
            try:
                timeout = float(parts[i + 1])
            except (IndexError, ValueError):
                print('syntax: ping <src> <dst> [-W <seconds>] [-c <count>]')
                return
            parts = parts[:i] + parts[i + 2:]
        if '-c' in parts:
            i = parts.index('-c')
            try:
                count = int(parts[i + 1])
                if count <= 0:
                    raise ValueError
            except (IndexError, ValueError):
                print('syntax: ping <src> <dst> [-W <seconds>] [-c <count>]')
                return
            parts = parts[:i] + parts[i + 2:]
        if count > 100:
            print('count capped at 100')
            return
        if len(parts) != 2:
            print('syntax: ping <src> <dst> [-W <seconds>] [-c <count>]')
            return

        src_name, dst = parts
        from entities import Address

        src = self._system.host(src_name)
        try:
            dst_host = self._system.host(dst)
            dst_addr = dst_host.address()
        except Exception:
            try:
                dst_addr = Address(dst)
            except Exception:
                print(f'ping: invalid destination: {dst}')
                return
        received = 0
        for _ in range(count):
            try:
                rtt = src.ping(dst_addr, timeout=timeout)
            except ValueError as e:
                print(f'ping {src_name} -> {dst}: {e}')
                return
            if rtt is None:
                print(f'ping {src_name} -> {dst}: timeout after {timeout:.2f} s')
            else:
                received += 1
                print(f'ping {src_name} -> {dst} ({dst_addr}): '
                      f'time={rtt * 1000:.2f} ms')
        loss = 100.0 * (count - received) / count
        print(f'{count} sent, {received} received, {loss:.0f}% loss')

    def do_read(self, arg):
        'Read the given YAML file with the network description'
        try:
            system = Parser(arg).parse().single_as()
        except Exception as e:
            print(str(e))
        else:
            if self._system is not None:
                self._system.stop()

            self._system = system

    def do_exit(self, arg):
        if self._system is not None:
            self._system.stop()
        sys.exit(0)
