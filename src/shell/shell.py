import cmd

from parser import Parser

class Shell(cmd.Cmd):

    intro = 'netrouting shell v1.0'
    prompt = '# '

    def __init__(self):
        super().__init__()
        self._system = None
    
    def do_route(self, arg):
        'Imprimir la tabla de ruteo del host/router dado'
        if self._system is None:
            print('system not initialized!')
            return

        device = self._system.device(arg)
        routing_rules = device.routing_table().rules()
        print(f'{"Prefix": <20} {"Next hop": <15} {"Interface": <10}')
        for rule in routing_rules:
            print(f'{str(rule.prefix()): <20} {str(rule.next_hop()): <15} {rule.interface().name(): <10}')

    def do_send(self, arg):
        'Enviar un datagrama de un host a otro'
        print(arg)

    def do_read(self, arg):
        'Leer el archivo YAML dado con la descripcion de la red'
        try:
            self._system = Parser(arg).parse()
        except Exception as e:
            print(str(e))
        
    
