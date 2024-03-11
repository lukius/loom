import collections
import heapq


class HeapItem(object):

    def __init__(self, weight, data):
        self._weight = weight
        self._data = data

    def data(self):
        return self._data

    def weight(self):
        return self._weight

    def __lt__(self, other):
        return self._weight < other.weight()

    def __le__(self, other):
        return self._weight <= other.weight()


class NetworkGraph(object):

    def __init__(self):
        self._routers = list()
        self._networks = list()
        self._costs = dict()

    def add_router(self, router_name):
        self._routers.append(router_name)
        self._add_node(router_name)

    def add_network(self, prefix):
        self._networks.append(prefix)
        self._add_node(prefix)

    def _add_node(self, node_id):
        self._costs[node_id] = collections.defaultdict(lambda: None)

    def add_edge(self, src, dst, weight):
        if src not in self._costs or dst not in self._costs:
            # TODO
            raise Exception('missing src or dst in graph')

        self._costs[src][dst] = weight
        self._costs[dst][src] = weight

    def shortest_paths(self, src):
        distances, previous = self._shortest_paths(src)
        paths = dict()

        for node in self._costs.keys():
            path = [node]
            current = node
            while current != src:
                if current not in previous:
                    # TODO
                    raise Exception('unexpected node')
                current = previous[current]
                path.insert(0, current)
            paths[node] = path

        return paths

    def _shortest_paths(self, src):
        if src not in self._costs:
            raise Exception('missing src in graph')

        costs = list()
        distances = collections.defaultdict(lambda: 0)
        previous = collections.defaultdict(lambda: 0)
        for node, weight in self.neighbors(src).items():
            item = HeapItem(weight, node)
            heapq.heappush(costs, item)
            distances[node] = weight
            previous[node] = src
        visited = {src}

        while len(visited) != len(self._costs):
            item = heapq.heappop(costs)
            current_dist = item.weight()
            current = item.data()

            for neighbor, weight in self.neighbors(current).items():
                if neighbor in visited:
                    continue

                new_neighbor_dist = current_dist + weight

                if neighbor not in distances:
                    item = HeapItem(new_neighbor_dist, neighbor)
                    heapq.heappush(costs, item)
                    distances[neighbor] = new_neighbor_dist
                    previous[neighbor] = current
                    continue

                current_neighbor_dist = distances[neighbor]
                if new_neighbor_dist < current_neighbor_dist:
                    distances[neighbor] = new_neighbor_dist
                    previous[neighbor] = current
                    for i, item in enumerate(costs):
                        if item.data() == neighbor:
                            costs[i] = HeapItem(new_neighbor_dist, neighbor)
                            heapq.heapify(costs)
                            break

            visited.add(current)

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
