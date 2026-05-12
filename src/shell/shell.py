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

    intro = 'netrouting shell v1.0'
    prompt = '# '

    def __init__(self):
        super().__init__()
        self._system = None

    @requires_system
    def do_route(self, arg):
        'Imprimir la tabla de ruteo del host/router dado'
        device = self._system.device(arg)
        routing_rules = device.routing_table().rules()
        print(f'{"Prefix": <20} {"Next hop": <15} {"Interface": <10}')
        for rule in routing_rules:
            print(f'{str(rule.prefix()): <20} {str(rule.next_hop()): <15} {rule.interface().name(): <10}')  # noqa: E501 — fixed-width table row

    @requires_system
    def do_send(self, arg):
        'Enviar un datagrama de un host a otro'
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
    def do_update_cost(self, arg):
        'Actualizar el costo de un enlace'
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

    def do_read(self, arg):
        'Leer el archivo YAML dado con la descripcion de la red'
        try:
            system = Parser(arg).parse()
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
