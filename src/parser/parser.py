import yaml


class Parser(object):

    def parse(self, filename):
        with open(filename, 'r') as f:
            content = yaml.safe_load(f)
            
        return content
