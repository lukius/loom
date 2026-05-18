import unittest

from routing import NetworkGraph


class GraphTest(unittest.TestCase):

    def test_neighbors_and_weights(self):
        graph = NetworkGraph()

        graph._add_node('node1')
        graph._add_node('node2')
        graph._add_node('node3')

        graph.add_edge('node1', 'node2', weight=10)
        graph.add_edge('node1', 'node3', weight=20)

        self.assertEqual(graph.weight('node1', 'node2'), 10)
        self.assertEqual(graph.weight('node1', 'node3'), 20)
        self.assertEqual(graph.weight('node2', 'node1'), 10)
        self.assertIsNone(graph.weight('node2', 'node3'))

        node1_neighbors = graph.neighbors('node1')
        self.assertEqual(len(node1_neighbors), 2)
        self.assertIn('node2', node1_neighbors)
        self.assertIn('node3', node1_neighbors)
        self.assertEqual(node1_neighbors['node2'], 10)
        self.assertEqual(node1_neighbors['node3'], 20)

        node3_neighbors = graph.neighbors('node3')
        self.assertEqual(len(node3_neighbors), 1)
        self.assertIn('node1', node3_neighbors)
        self.assertEqual(node3_neighbors['node1'], 20)

    def test_shortest_paths(self):
        graph = NetworkGraph()

        for node in ['a','b','c','d','e','f','g']:
            graph._add_node(node)

        graph.add_edge('a', 'b', weight=2)
        graph.add_edge('a', 'c', weight=5)
        graph.add_edge('b', 'c', weight=2)
        graph.add_edge('b', 'd', weight=10)
        graph.add_edge('c', 'e', weight=3)
        graph.add_edge('c', 'g', weight=1)
        graph.add_edge('d', 'f', weight=11)
        graph.add_edge('e', 'd', weight=4)
        graph.add_edge('e', 'f', weight=14)
        graph.add_edge('e', 'g', weight=2)

        distances, prevs = graph._shortest_paths('a')
        self.assertEqual(len(distances), 6)
        self.assertEqual(distances.get('b', 0), 2)
        self.assertEqual(distances.get('c', 0), 4)
        self.assertEqual(distances.get('d', 0), 11)
        self.assertEqual(distances.get('e', 0), 7)
        self.assertEqual(distances.get('f', 0), 21)
        self.assertEqual(distances.get('g', 0), 5)

        self.assertEqual(len(prevs), 6)
        self.assertEqual(prevs.get('b', None), 'a')
        self.assertEqual(prevs.get('c', None), 'b')
        self.assertEqual(prevs.get('d', None), 'e')
        self.assertEqual(prevs.get('e', None), 'c')
        self.assertEqual(prevs.get('f', None), 'e')
        self.assertEqual(prevs.get('g', None), 'c')

        paths = graph.shortest_paths('a')
        self.assertEqual(len(paths), 7)
        self.assertEqual(paths.get('a', []), ['a'])
        self.assertEqual(paths.get('b', []), ['a', 'b'])
        self.assertEqual(paths.get('c', []), ['a', 'b', 'c'])
        self.assertEqual(paths.get('d', []), ['a', 'b', 'c', 'e', 'd'])
        self.assertEqual(paths.get('e', []), ['a', 'b', 'c', 'e'])
        self.assertEqual(paths.get('f', []), ['a', 'b', 'c', 'e', 'f'])
        self.assertEqual(paths.get('g', []), ['a', 'b', 'c', 'g'])

    def test_shortest_paths_with_repeated_relaxation(self):
        # Node 'a' is reachable directly from 's' at cost 10, then relaxed to
        # cost 2 via 's->b->a'. The lazy-deletion approach pushes 'a' onto the
        # heap twice; the stale high-cost entry must be discarded on pop.
        graph = NetworkGraph()
        for node in ['s', 'a', 'b', 't']:
            graph._add_node(node)

        graph.add_edge('s', 'a', weight=10)
        graph.add_edge('s', 'b', weight=1)
        graph.add_edge('b', 'a', weight=1)
        graph.add_edge('a', 't', weight=1)

        distances, prevs = graph._shortest_paths('s')
        self.assertEqual(distances['b'], 1)
        self.assertEqual(distances['a'], 2)
        self.assertEqual(distances['t'], 3)
        self.assertEqual(prevs['a'], 'b')
        self.assertEqual(prevs['t'], 'a')

        paths = graph.shortest_paths('s')
        self.assertEqual(paths['a'], ['s', 'b', 'a'])
        self.assertEqual(paths['t'], ['s', 'b', 'a', 't'])


class IdempotentAddTest(unittest.TestCase):

    def test_add_router_is_idempotent(self):
        """Re-adding the same router must not duplicate it in _routers or
        clobber its existing edges."""
        g = NetworkGraph()
        g.add_router('r1')
        g.add_network('n1')
        g.add_edge('r1', 'n1', weight=5)

        g.add_router('r1')

        self.assertEqual(g._routers.count('r1'), 1)
        # Existing edge must still be there.
        self.assertEqual(g.weight('r1', 'n1'), 5)

    def test_add_network_is_idempotent(self):
        g = NetworkGraph()
        g.add_router('r1')
        g.add_network('n1')
        g.add_edge('r1', 'n1', weight=5)

        g.add_network('n1')

        self.assertEqual(g._networks.count('n1'), 1)
        self.assertEqual(g.weight('r1', 'n1'), 5)


class DisconnectedGraphTest(unittest.TestCase):

    def test_shortest_paths_returns_none_for_disconnected_components(self):
        """When src and dst live in different connected components, the
        reconstructed path must not silently appear as a single-element
        list (which a careless caller could mistake for 'src == dst')."""
        g = NetworkGraph()
        g.add_router('r1')
        g.add_router('r2')
        g.add_network('n1')
        g.add_edge('r1', 'n1', weight=1)
        # r2 is isolated.

        paths = g.shortest_paths('r1')
        self.assertEqual(paths['n1'], ['r1', 'n1'])     # reachable
        self.assertIsNone(paths['r2'])                  # unreachable → None
