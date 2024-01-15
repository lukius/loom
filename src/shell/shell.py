import cmd

class Shell(cmd.Cmd):

    intro = 'netrouting shell v1.0'
    prompt = '# '
    
    
    def do_route(self, arg):
        'Imprimir la tabla de ruteo del host/router dado'
        print(arg)
    
    def do_send(self, arg):
        'Enviar un datagrama de un host a otro'
        print(arg)
        
    
