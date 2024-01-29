import os
import unittest


class TestSuite(object):
    SOURCE_FILES = os.listdir('test')

    @classmethod
    def build_from(cls, args):
        test_files = cls.get_test_files_from(args)
        return cls.get_test_suite_from(test_files)

    @classmethod
    def get_test_suite_from(cls, test_files):
        test_loader = unittest.defaultTestLoader
        test_modules = map(lambda filename: f'test.{filename[:-3]}', test_files)
        suites = map(test_loader.loadTestsFromName, test_modules)
        test_suite = unittest.TestSuite(suites)
        return test_suite

    @classmethod
    def get_test_files_from(cls, args):
        if len(args) == 1:
            return cls.get_all_test_files()
        tests = list()
        args = args[1:]
        for arg in args:
            if not arg.startswith('--'):
                continue
            arg = arg.lower()
            if not arg.startswith('--test'):
                test = f'test_{arg[2:]}.py'
            else:
                test = f'{arg[2:]}.py'
            test = test.replace('-', '_')
            if cls.test_is_valid(test):
                tests.append(test)
        return tests

    @classmethod
    def get_all_test_files(cls):
        return filter(lambda filename: filename.startswith('test') and
                                       filename.endswith('.py'), cls.SOURCE_FILES)

    @classmethod
    def test_is_valid(cls, test):
        return test in cls.SOURCE_FILES
