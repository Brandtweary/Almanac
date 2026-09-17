"""Bind explicit semantic reviews to immutable stock receipts and make a readable ranking."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import statistics

CRITICAL = {'unsupported_critical_procedure','lost_qualification','fabricated_source_claim',
            'source_identity_mismatch','personal_data_leak','false_personal_provenance',
            'orphaned_tool_execution','data_loss'}

def receipt_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def apply_review(receipt: dict, fingerprint: str, review: dict | None) -> dict:
    status=receipt['status']
    starts={event.get('toolCallId'):event for event in receipt.get('events',[]) if event.get('type')=='tool_execution_start'}
    fixture_handoff_gap=receipt.get('caseId','').startswith(('summary.','memory.')) and any(
        event.get('type')=='tool_execution_end' and event.get('isError') and event.get('toolName')=='memory_inspect'
        and starts.get(event.get('toolCallId'),{}).get('args')=={'collection':'handoffs','id':'audit'}
        and 'Unknown stage-scoped' in json.dumps(event.get('result',{})) for event in receipt.get('events',[]))
    if fixture_handoff_gap:
        status='evaluator_error'
    elif status=='evaluator_error' and any(r.get('httpStatus',0)>=400 or r.get('errorCode') is not None or r.get('bodyInterrupted') for r in receipt.get('providerReceipts',[])):
        status='transport_error'
    mechanical = bool(receipt.get('checks')) and status not in {'transport_error','evaluator_error','budget_not_run'} and all(row['passed'] is True for row in receipt.get('checks', []))
    if not review:
        return {'status':status, 'mechanical_pass':mechanical, 'semantic_status':'unadjudicated'}
    if review.get('receiptSHA256') != fingerprint:
        raise ValueError('Semantic review belongs to different receipt bytes')
    if review.get('method') not in {'human','agent'} or not review.get('reviewer') or not review.get('notes'):
        raise ValueError('Explicit reviewer, method and evidence notes required')
    judgments=review.get('requirements')
    if not isinstance(judgments,list) or len(judgments)!=len(receipt.get('rubric',[])) or any(type(j) is not bool for j in judgments):
        raise ValueError('Every frozen rubric clause requires a boolean judgment')
    critical=review.get('criticalFailures')
    if not isinstance(critical,list) or set(critical)-CRITICAL:
        raise ValueError('Unknown or missing critical failure classification')
    semantic=all(judgments) and not critical
    runnable=status not in {'transport_error','evaluator_error','budget_not_run'}
    failed_checks={row['id'] for row in receipt.get('checks',[]) if row['passed'] is not True}
    recovered_role=receipt.get('caseId','').startswith(('audit.','memory.','summary.')) and receipt.get('stopReason')=='stop' and receipt.get('windowOutcome',{}).get('kind') in {'completed','no-op'} and failed_checks=={'schema_validity'}
    supported_outcome=runnable and semantic and (mechanical or recovered_role)
    return {'status':'passed' if runnable and mechanical and semantic else status if not runnable else 'failed',
            'mechanical_pass':mechanical,'semantic_status':'passed' if semantic else 'failed',
            'supportedOutcome':supported_outcome,'recoveredToolError':bool(supported_outcome and recovered_role),
            'criticalFailures':critical,'reviewer':review['reviewer'],'reviewMethod':review['method'],'notes':review['notes']}

def build_report(run:Path,reviews:dict)->dict:
    lookup={entry['artifact']:entry for entry in reviews.get('reviews',[])}
    if len(lookup)!=len(reviews.get('reviews',[])):raise ValueError('Duplicate review artifact')
    result=[]
    for file in sorted(run.glob('*--*.json')):
        receipt=json.loads(file.read_text());review=lookup.pop(file.name,None)
        score=apply_review(receipt,receipt_hash(file),review)
        result.append({'artifact':file.name,'model':receipt['profile']['id'],'case':receipt['caseId'],
                       **score,'metrics':receipt['metrics']})
    if lookup:raise ValueError('Review references a missing receipt')
    candidates=[]
    for model in sorted({row['model'] for row in result}):
        rows=[r for r in result if r['model']==model]
        completed=[r['metrics']['seconds'] for r in rows if r['status'] not in {'transport_error','evaluator_error','budget_not_run'}]
        candidates.append({'model':model,'cases':len(rows),'mechanicalPass':sum(r['mechanical_pass'] for r in rows),
            'reviewed':sum(r['semantic_status']!='unadjudicated' for r in rows),'fullyPassed':sum(r['status']=='passed' for r in rows),
            'criticalFailures':sum(bool(r.get('criticalFailures')) for r in rows),'transportErrors':sum(r['status']=='transport_error' for r in rows),'evaluatorErrors':sum(r['status']=='evaluator_error' for r in rows),
            'medianSeconds':statistics.median(completed) if completed else None,'costUSD':sum(r['metrics']['costUSD'] for r in rows)})
    candidates.sort(key=lambda c:(-c['fullyPassed'],c['criticalFailures'],-c['mechanicalPass'],c['model']))
    return {'schemaVersion':1,'candidates':candidates,'cases':result,'scope':'Development scenario comparison. Ordering is descriptive, not release admission; unadjudicated/transport cases are not model failures or passes.'}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('run',type=Path);p.add_argument('--reviews',type=Path);p.add_argument('--output',type=Path,required=True);p.add_argument('--template',action='store_true');args=p.parse_args()
    if args.output.exists():raise SystemExit('Use a fresh output path')
    if args.template:
        data={'schemaVersion':1,'reviews':[]}
        for file in sorted(args.run.glob('*--*.json')):
            r=json.loads(file.read_text());data['reviews'].append({'artifact':file.name,'receiptSHA256':receipt_hash(file),'reviewer':'','method':'agent','requirements':[None for _ in r.get('rubric',[])],'criticalFailures':[],'notes':''})
        args.output.write_text(json.dumps(data,indent=2)+'\n');return
    data=build_report(args.run,json.loads(args.reviews.read_text()) if args.reviews else {'reviews':[]})
    args.output.write_text(json.dumps(data,indent=2)+'\n')
    lines=['# Almanac model comparison','',data['scope'],'','| Candidate | Cases | Workflow checks | Reviewed | Fully passed | Critical failures | Transport | Fixture/eval | Median seconds | USD |','|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    for c in data['candidates']:
        latency='—' if c['medianSeconds'] is None else f"{c['medianSeconds']:.2f}"
        lines.append(f"| {c['model']} | {c['cases']} | {c['mechanicalPass']} | {c['reviewed']} | {c['fullyPassed']} | {c['criticalFailures']} | {c['transportErrors']} | {c['evaluatorErrors']} | {latency} | {c['costUSD']:.5f} |")
    args.output.with_suffix('.md').write_text('\n'.join(lines)+'\n')
if __name__=='__main__':main()
