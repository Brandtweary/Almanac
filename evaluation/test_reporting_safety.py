import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from .leaderboard import assemble
from .screen import screen

class ReportingSafety(unittest.TestCase):
    def test_rubric_pass_is_not_clean(self):
        row = dict(model='candidate', case='one', status='passed', semantic_status='passed', mechanical_pass=True, checks=[], cleanAnswer=False, additionalFindings=['wrong arithmetic'], metrics={'seconds':1, 'costUSD':0})
        category = assemble({'product':[row]})['models'][0]['categories']['product']
        self.assertEqual(category['targetedPassed'], 1)
        self.assertEqual(category['cleanAnswers'], 0)
        self.assertEqual(category['commonCleanAnswers'], 0)
        self.assertEqual(category['additionalFindingCases'], 1)
        self.assertEqual(category['commonAdditionalFindingCases'], 1)

    def test_failure_receipts_and_pinned_provider(self):
        suite = json.loads(Path(__file__).with_name('fixtures.json').read_text())
        profile = {'id':'test/model','providerRouting':{'only':['fixture-provider']}}
        failures = [HTTPError('https://example.invalid',500,'failed',{},io.BytesIO(b'upstream failed')), ConnectionError('disconnect'), ValueError('malformed response')]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as tmp:
                output=Path(tmp)/'run'
                with patch('evaluation.screen.urllib.request.urlopen',side_effect=failure):
                    screen(suite=suite,models=[profile],api_key='fake-test-key',output=output,workers=1)
                self.assertTrue(json.loads((output/'summary.json').read_text()))
                for artifact in output.glob('*--*.json'):
                    record=json.loads(artifact.read_text())
                    self.assertEqual(record['state'],'failed')
                    self.assertTrue(record['unknownExposure'])
                    self.assertEqual(record['requests'][0]['provider']['only'],['fixture-provider'])
                    self.assertIn('exception',record)

    def test_worker_exception_is_preserved(self):
        suite=json.loads(Path(__file__).with_name('fixtures.json').read_text())
        with tempfile.TemporaryDirectory() as tmp, patch('evaluation.screen.run_case',side_effect=RuntimeError('fixture failure')):
            output=Path(tmp)/'run'
            screen(suite=suite,models=[{'id':'test/model','providerRouting':{'only':['fixture']}}],api_key='fake',output=output,workers=1)
            for artifact in output.glob('*--*.json'):
                row=json.loads(artifact.read_text());self.assertEqual(row['state'],'failed');self.assertFalse(row['unknownExposure'])

    def test_unpinned_profile_rejected_before_output(self):
        suite=json.loads(Path(__file__).with_name('fixtures.json').read_text())
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):screen(suite=suite,models=['test/model'],api_key='fake',output=Path(tmp)/'run')
            self.assertFalse((Path(tmp)/'run').exists())

if __name__=='__main__':unittest.main()
