import sys
import unittest

from test.base import TestSuite


def run_tests():
    test_suite = TestSuite.build_from(sys.argv)
    runner = unittest.TextTestRunner(verbosity=2)
    runner.run(test_suite)

if __name__ == '__main__':
    run_tests()