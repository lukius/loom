import collections

class Node(object):

    def __init__(self, obj):
        self._obj = obj

    def __eq__(self, other):
        return (self._obj.__class__ == other._obj.__class__ and
                self._obj.name() == other._obj.name())

    def __hash__(self):
        return hash(self._obj.__class__) ^ hash(self._obj.name())


class NetworkGraph(object):

    def __init__(self):
        self._costs = dict()

    def add_edge(self, src, dst, weight):
        src_node = Node(src)
        dst_node = Node(dst)
        adjacencies = self._costs.setdefault(src_node, collections.defaultdict(lambda: None))
        adjacencies[dst_node] = weight

    def weight(self, src, dst):
        src_node = Node(src)
        dst_node = Node(dst)
        return self._costs[src_node][dst_node]

    def neighbors(self, src):
        src_node = Node(src)
        return self._costs.get(src_node, dict())
