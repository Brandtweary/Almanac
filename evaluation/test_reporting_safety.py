import unittest
from .leaderboard import assemble

class ReportingSafety(unittest.TestCase):
    def test_rubric_pass_is_not_clean(self):
        row = dict(model='candidate', case='one', status='passed', semantic_status='passed', mechanical_pass=True, checks=[], cleanAnswer=False, additionalFindings=['wrong arithmetic'], metrics={'seconds':1, 'costUSD':0})
        category = assemble({'product':[row]})['models'][0]['categories']['product']
        self.assertEqual(category['targetedPassed'], 1)
        self.assertEqual(category['cleanAnswers'], 0)
        self.assertEqual(category['commonCleanAnswers'], 0)
        self.assertEqual(category['additionalFindingCases'], 1)
        self.assertEqual(category['commonAdditionalFindingCases'], 1)

if __name__=='__main__':unittest.main()
