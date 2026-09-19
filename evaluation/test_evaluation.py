import copy
import json
from pathlib import Path
import unittest
from .research import run_case
from .scoring import CRITICAL_GATES, compare_rankings, digest, evidence_coverage, score_answer, validate_suite
SUITE=json.loads(Path(__file__).with_name('fixtures.json').read_text())
CASE=SUITE['cases'][0]

class EvaluationTests(unittest.TestCase):
    def test_frozen_sources_are_disjoint(self):
        validate_suite(SUITE)
        polluted=copy.deepcopy(SUITE)
        polluted['cases'][0]['split']='heldout'
        with self.assertRaises(ValueError): validate_suite(polluted)
    def test_gold_anchors_are_available(self):
        for case in SUITE['cases']:
            self.assertTrue(evidence_coverage(case,[SUITE['contexts'][key] for key in case['gold_context']])['all_labelled_evidence'])
    def test_wrong_source_cannot_satisfy_evidence(self):
        contexts=copy.deepcopy([SUITE['contexts'][key] for key in CASE['gold_context']])
        for hit in contexts: hit['source_sha256']='0'*64
        self.assertEqual(evidence_coverage(CASE,contexts)['coverage'],0)
    def test_alternate_evidence_accepted(self):
        case=next(c for c in SUITE['cases'] if c['id']=='flood-attic')
        result=evidence_coverage(case,[SUITE['contexts']['fema-attic-alt']])
        self.assertTrue(result['requirements']['exception'])
        self.assertFalse(result['requirements']['roof'])
    def test_unknown_citation_fails_despite_positive_review(self):
        receipt={'answer':'Six drops [source:invented]','finish_reason':'stop','evidence':[],'errors':[]}
        review={'reviewer':'test-reviewer','rationale':'test','case_digest':digest(CASE),'receipt_digest':digest(receipt),
                'requirements':{r['id']:True for r in CASE['requirements']},'critical_gates':{g:False for g in CRITICAL_GATES}}
        result=score_answer(CASE,receipt,review)
        self.assertFalse(result['passed'])
        self.assertIn('unknown_citation',result['failures'])
    def test_review_bound_to_exact_answer(self):
        receipt={'answer':'x','finish_reason':'stop','evidence':[]}
        with self.assertRaises(ValueError): score_answer(CASE,receipt,{'case_digest':digest(CASE),'receipt_digest':'wrong'})
        self.assertFalse(score_answer(CASE,receipt,None)['passed'])
    def test_pool_cannot_change_between_variants(self):
        pool=[SUITE['contexts']['epa-dose'],SUITE['contexts']['epa-bleach']]
        with self.assertRaises(ValueError): compare_rankings(CASE,pool,{'bad':['epa-dose','epa-dose']},100,lambda hits:len(hits),{'bad':0.1})
    def test_budget_preserves_whole_passages(self):
        pool=[SUITE['contexts']['epa-dose'],SUITE['contexts']['epa-bleach']]
        result=compare_rankings(CASE,pool,{'base':['epa-dose','epa-bleach']},1,lambda hits:len(hits),{'base':0.1})
        self.assertEqual(result['variants']['base']['selected'],['epa-dose'])
        self.assertEqual(result['variants']['base']['omitted'],['epa-bleach'])
    def run_research(self,complete,tool):
        return run_case(CASE,complete,tool,mode='tool_research',profile={'id':'test'},max_completions=3,max_tool_calls=3)
    def call(self,key='call-1',name='corpus_search',arguments='{"query":"water"}'):
        return {'id':key,'type':'function','function':{'name':name,'arguments':arguments}}
    def test_truncated_tool_never_executes(self):
        calls=[]
        receipt=self.run_research(lambda *_:{'finish_reason':'length','message':{'role':'assistant','tool_calls':[self.call()]}},lambda *args:calls.append(args))
        self.assertEqual(calls,[])
        self.assertTrue(receipt['errors'])
    def test_entire_batch_validates_before_execution(self):
        calls=[]
        receipt=self.run_research(lambda *_:{'finish_reason':'tool_calls','message':{'role':'assistant','tool_calls':[self.call(),self.call('call-2','shell')]}},lambda *args:calls.append(args))
        self.assertEqual(calls,[])
        self.assertTrue(receipt['errors'])
    def test_tool_identity_and_reasoning_survive_roundtrip(self):
        responses=iter([{'finish_reason':'tool_calls','message':{'role':'assistant','reasoning_details':[{'text':'opaque'}],'tool_calls':[self.call()]}},
                        {'finish_reason':'stop','message':{'role':'assistant','content':'Six drops [source:passage].'}}])
        observed=[]
        def complete(messages,tools):
            observed.append(messages)
            return next(responses)
        result={'hits':[{'passage_id':'passage','source_revision':'a'*64,'extraction_revision':'v1','document_id':'doc','excerpt':'six drops'}]}
        receipt=self.run_research(complete,lambda *_:result)
        self.assertEqual(receipt['finish_reason'],'stop')
        self.assertEqual(observed[1][-1]['tool_call_id'],'call-1')
        self.assertEqual(observed[1][-2]['reasoning_details'],[{'text':'opaque'}])
        self.assertEqual(receipt['evidence'][0]['passage_id'],'passage')
    def test_repeat_identity_rejected(self):
        calls=[]
        reply={'finish_reason':'tool_calls','message':{'role':'assistant','tool_calls':[self.call()]}}
        receipt=self.run_research(lambda *_:reply,lambda *args:(calls.append(args) or {'hits':[]}))
        self.assertEqual(len(calls),1)
        self.assertTrue(receipt['errors'])

class RankingTests(unittest.TestCase):
    def test_malformed_cross_encoder_is_rejected(self):
        from .ranking import cross_encoder_order
        pool=[{'passage_id':'a'},{'passage_id':'b'}]
        for scores in [[('a',1)], [('a',1),('a',2)], [('a',1),('b',float('nan'))]]:
            with self.assertRaises(ValueError): cross_encoder_order(pool,scores)
        self.assertEqual(cross_encoder_order(pool,[('b',2),('a',2)]),['a','b'])
    def test_mmr_weight_one_retains_relevance(self):
        from .ranking import mmr_order
        self.assertEqual(mmr_order(['a','b','c'],{'a':[1,0],'b':[1,0],'c':[0,1]},relevance_weight=1),['a','b','c'])
    def test_mmr_can_suppress_adjacent_exception(self):
        from .ranking import mmr_order
        self.assertEqual(mmr_order(['procedure','exception','unrelated'],{'procedure':[1,0],'exception':[1,0],'unrelated':[-1,0]},relevance_weight=.2),['procedure','unrelated','exception'])

class MmrOptimizationTests(unittest.TestCase):
    def test_incremental_redundancy_matches_preserved_reference_outputs(self):
        from .ranking import mmr_order
        vectors={'a':[1,0,0],'b':[.95,.05,0],'c':[0,1,0],'d':[-1,0,0],'e':[0,0,1],'f':[.4,.4,.2]}
        expected={0:['a','d','c','e','f','b'],.2:['a','d','c','e','b','f'],.5:['a','d','c','b','e','f'],.9:list(vectors),1:list(vectors)}
        for weight,order in expected.items():
            self.assertEqual(mmr_order(list(vectors),vectors,relevance_weight=weight),order)


class StockReviewTests(unittest.TestCase):
    def test_semantic_review_never_overrides_transport_error(self):
        from .adjudicate import apply_review
        receipt={'status':'transport_error','checks':[{'passed':True}],'rubric':['Preserve original statement.']}
        review={'receiptSHA256':'exact','method':'agent','reviewer':'test','notes':'Bound evidence','requirements':[True],'criticalFailures':[]}
        self.assertEqual(apply_review(receipt,'exact',review)['status'],'transport_error')
    def test_targeted_pass_retains_additional_accuracy_failure(self):
        from .adjudicate import apply_review
        receipt={'status':'unadjudicated','checks':[{'id':'completion','passed':True}],'rubric':['Correct endpoint conversion.']}
        review={'receiptSHA256':'exact','method':'agent','reviewer':'test','notes':'Endpoint correct; extra gap wrong.','requirements':[True],'criticalFailures':[], 'additionalFindings':[{'kind':'arithmetic_error','evidence':'Wrong difference between correct endpoints.'}]}
        result=apply_review(receipt,'exact',review)
        self.assertEqual(result['status'],'passed')
        self.assertFalse(result['cleanAnswer'])
        self.assertEqual(result['additionalFindings'],review['additionalFindings'])

    def test_semantic_review_binds_raw_bytes(self):
        from .adjudicate import apply_review
        with self.assertRaises(ValueError):apply_review({'status':'unadjudicated'},'new',{'receiptSHA256':'old'})


class SpendCollection(unittest.TestCase):
    """A receipt's nesting depth is the provider's choice, not a budget limit."""

    def _receipt(self,depth,identity='gen-deep',cost=1.5):
        leaf={'id':identity,'usage':{'cost':cost}}
        node=leaf
        for _ in range(depth):node={'wrapper':[node]}
        return node

    def test_deep_but_decodable_receipt_keeps_its_charge(self):
        import tempfile
        from .spend import collect_spend
        directory=Path(tempfile.mkdtemp())
        (directory/'deep.json').write_text(json.dumps(self._receipt(2000)))
        report=collect_spend([directory])
        self.assertEqual(report['unreadable'],[])
        self.assertEqual(report['providerGenerations'],1)
        self.assertEqual(report['reportedCostUSD'],1.5)

    def test_input_past_the_decoder_limit_is_one_unreadable_row(self):
        import tempfile
        from .spend import collect_spend
        directory=Path(tempfile.mkdtemp())
        (directory/'over.json').write_text('['*200000+']'*200000)
        (directory/'ordinary.json').write_text(json.dumps(self._receipt(1,identity='gen-ordinary',cost=2.0)))
        report=collect_spend([directory])
        self.assertEqual([row['file'] for row in report['unreadable']],[str(directory/'over.json')])
        self.assertEqual(report['providerGenerations'],1)
        self.assertEqual(report['reportedCostUSD'],2.0)

if __name__=='__main__': unittest.main()
