import importlib.util
from pathlib import Path
import unittest
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('exporter', Path(__file__).with_name('export-transcripts.py'))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ExportTest(unittest.TestCase):
    def test_quoted_patterns_and_pipeline_filters(self):
        records = exporter.searches("rg -n 'alpha|beta' src | grep alpha; rg -c gamma test", '/tmp/repo')
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]['argv'], ['-n', 'alpha|beta', 'src'])

    def test_execution_bearing_options_are_excluded(self):
        self.assertEqual(exporter.searches("rg --pre 'touch sentinel' alpha .", '/tmp/repo'), [])
        self.assertEqual(exporter.searches("rg --hostname-bin=program alpha .", '/tmp/repo'), [])

    def test_dynamic_commands_and_multiline_statements(self):
        self.assertEqual(exporter.searches('rg "$(program)" .', '/tmp/repo'), [])
        records = exporter.searches('rg -n alpha src\nrg -c beta test', '/tmp/repo')
        self.assertEqual(len(records), 2)
        self.assertEqual(records[1]['argv'], ['-c', 'beta', 'test'])


if __name__ == '__main__':
    unittest.main()
