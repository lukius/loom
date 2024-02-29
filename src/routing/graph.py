import collections
import heapq


class NetworkGraph(object):

    def __init__(self):
        self._costs = dict()

    def add_node(self, node_id):
        self._costs[node_id] = collections.defaultdict(lambda: None)

    def add_edge(self, src, dst, weight):
        if src not in self._costs or dst not in self._costs:
            # TODO
            raise Exception('missing src or dst in graph')

        self._costs[src][dst] = weight
        self._costs[dst][src] = weight

    def shortest_paths(self, src):
        if src not in self._costs:
            raise Exception('missing src in graph')

        costs = list()
        distances = collections.defaultdict(lambda: 0)
        previous = collections.defaultdict(lambda: 0)
        for node, weight in self.neighbors(src).items():
            item = (weight, node)
            heapq.heappush(costs, item)
            distances[node] = weight
            previous[node] = src
        visited = {src}

        while len(visited) != len(self._costs):
            current_dist, current = heapq.heappop(costs)

            for neighbor, weight in self.neighbors(current).items():
                if neighbor in visited:
                    continue

                new_neighbor_dist = current_dist + weight

                if neighbor not in distances:
                    item = (new_neighbor_dist, neighbor)
                    heapq.heappush(costs, item)
                    distances[neighbor] = new_neighbor_dist
                    previous[neighbor] = current
                    continue

                current_neighbor_dist = distances[neighbor]
                if new_neighbor_dist < current_neighbor_dist:
                    distances[neighbor] = new_neighbor_dist
                    previous[neighbor] = current
                    for i, item in enumerate(costs):
                        if item[1] == neighbor:
                            costs[i] = (new_neighbor_dist, neighbor)
                            heapq.heapify(costs)
                            break

            visited.add(current)

        return distances, previous


    def weight(self, src, dst):
        src_costs = self._costs.get(src, dict())
        return src_costs.get(dst, None)

    def neighbors(self, src):
        return self._costs.get(src, dict())

    def __contains__(self, node):
        return node in self._costs
