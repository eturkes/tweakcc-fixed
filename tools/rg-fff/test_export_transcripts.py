import importlib.util
from pathlib import Path
import unittest
import sys
import json
import os
import subprocess
import tempfile

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

    def test_other_repositories_are_rejected_and_local_exports_are_private(self):
        with tempfile.TemporaryDirectory(prefix='fff-export-test-') as temp:
            root = Path(temp)
            repo = root / 'repo'
            repo.mkdir()
            (repo / '.git').write_text('gitdir: synthetic')
            command = [sys.executable, str(Path(__file__).with_name('export-transcripts.py')), '--input', str(root / 'empty'), '--output']
            rejected = subprocess.run(command + [str(repo / 'private.json')], capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse((repo / 'private.json').exists())
            output = root / 'private.json'
            output.write_text('[]')
            os.chmod(output, 0o644)
            accepted = subprocess.run(command + [str(output)], capture_output=True, text=True)
            self.assertEqual(accepted.returncode, 0)
            self.assertEqual(json.loads(output.read_text()), [])
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
