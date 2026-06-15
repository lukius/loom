import collections
import heapq

from .exception import GraphConsistencyException


class HeapItem:

    def __init__(self, weight, data):
        self._weight = weight
        self._data = data

    def data(self):
        return self._data

    def weight(self):
        return self._weight

    def __lt__(self, other):
        return self._weight < other.weight()


class NetworkGraph:

    def __init__(self):
        self._routers = list()
        self._networks = list()
        self._costs = dict()

    def add_router(self, router_name):
        if router_name in self._costs:
            return
        self._routers.append(router_name)
        self._add_node(router_name)

    def add_network(self, prefix):
        if prefix in self._costs:
            return
        self._networks.append(prefix)
        self._add_node(prefix)

    def _add_node(self, node_id):
        self._costs[node_id] = collections.defaultdict(lambda: None)

    def add_edge(self, src, dst, weight):
        if src not in self._costs or dst not in self._costs:
            raise GraphConsistencyException(
                f'add_edge: missing endpoint(s) src={src} dst={dst}'
            )

        self._costs[src][dst] = weight
        self._costs[dst][src] = weight

    def add_directed_edge(self, src, dst, weight):
        """Set the src→dst weight only; leave dst→src untouched.

        Counterpart to add_edge (symmetric). Used by LSDB.build_graph
        to encode OSPF-style asymmetric costs: a router's interface
        cost is outgoing-only, and the reverse traversal (subnet back
        onto an attached router) is a separate zero-weight edge.
        """
        if src not in self._costs or dst not in self._costs:
            raise GraphConsistencyException(
                f'add_directed_edge: missing endpoint(s) src={src} dst={dst}'
            )
        self._costs[src][dst] = weight

    def shortest_paths(self, src):
        _, previous = self._shortest_paths(src)
        paths = dict()

        for node in self._costs.keys():
            if node == src:
                paths[node] = [src]
                continue
            if node not in previous:
                # Disconnected component — distinguish from "src == node"
                # by returning None rather than a single-element list.
                paths[node] = None
                continue
            path = [node]
            current = node
            while current != src:
                current = previous[current]
                path.insert(0, current)
            paths[node] = path

        return paths

    def _shortest_paths(self, src):
        if src not in self._costs:
            raise GraphConsistencyException(f'shortest_paths: missing src {src}')

        costs = list()
        distances = {}
        previous = {}
        for node, weight in self.neighbors(src).items():
            heapq.heappush(costs, HeapItem(weight, node))
            distances[node] = weight
            previous[node] = src
        visited = {src}

        while len(costs) > 0:
            item = heapq.heappop(costs)
            current_dist = item.weight()
            current = item.data()

            if current in visited:
                continue

            visited.add(current)

            for neighbor, weight in self.neighbors(current).items():
                if neighbor in visited:
                    continue

                new_neighbor_dist = current_dist + weight

                if neighbor not in distances or new_neighbor_dist < distances[neighbor]:
                    distances[neighbor] = new_neighbor_dist
                    previous[neighbor] = current
                    heapq.heappush(costs, HeapItem(new_neighbor_dist, neighbor))

        return distances, previous

    def weight(self, src, dst):
        src_costs = self._costs.get(src, dict())
        return src_costs.get(dst, None)

    def neighbors(self, src):
        return self._costs.get(src, dict())

    def networks(self):
        return self._networks

    def __contains__(self, node):
        return node in self._costs
