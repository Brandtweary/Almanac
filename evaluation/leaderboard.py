"""One descriptive leaderboard with separate product, research and Bash categories."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import statistics
from .adjudicate import apply_review,receipt_hash


def read_runs(paths:list[Path],category:str)->list[dict]:
    selected={}
    for directory in paths:
        review_path=directory/'reviews.json'
        reviews={r['artifact']:r for r in json.loads(review_path.read_text()).get('reviews',[])} if review_path.exists() else {}
        for file in sorted(directory.glob('*--*.json')):
            receipt=json.loads(file.read_text())
            score=apply_review(receipt,receipt_hash(file),reviews.get(file.name))
            row={'category':category,'model':receipt['profile']['id'],'case':receipt['caseId'],**score,
                 'metrics':receipt['metrics'],'artifact':str(file),'caseDigest':receipt['caseDigest'],
                 'systemPromptDigest':receipt.get('systemPromptDigest'),'toolSchemaDigest':receipt.get('toolSchemaDigest'),
                 'checks':receipt.get('checks',[]),'usageIncomplete':receipt.get('usageIncomplete',False)}
            if category=='shell' and not receipt.get('rubric'):
                row['semantic_status']='not_applicable'
            key=(row['model'],row['case']);old=selected.get(key)
            if old:
                if old['caseDigest']!=row['caseDigest']:
                    raise ValueError('Cannot combine changed case identities in one category')
                if old['status'] not in {'transport_error','evaluator_error','budget_not_run'}:
                    raise ValueError('Do not silently select among repeated measured attempts; report a separate comparison')
                row['priorUnmeasuredAttempt']=old['artifact']
            selected[key]=row
    return list(selected.values())


def assemble(categories:dict[str,list[dict]],comparison_models:list[str]|None=None)->dict:
    rows=[row for group in categories.values() for row in group]
    models=sorted({r['model'] for r in rows});table=[];common={}
    for category,group in categories.items():
        members={r['model'] for r in group}
        if comparison_models:members.intersection_update(comparison_models)
        case_sets=[{r['case'] for r in group if r['model']==m and r['status'] not in {'transport_error','evaluator_error','budget_not_run'}} for m in members]
        intersection=set.intersection(*case_sets) if case_sets else set()
        common[category]={'models':sorted(members),'transportCompleteCaseIds':sorted(intersection)}
    for model in models:
        line={'model':model,'categories':{}}
        for category,group in categories.items():
            subset=[r for r in group if r['model']==model]
            if not subset:continue
            measured=[r for r in subset if r['status'] not in {'transport_error','evaluator_error','budget_not_run'}]
            reviewed=[r for r in measured if r['semantic_status'] in {'passed','failed','not_applicable'}]
            exact=lambda r:all(any(c['id']==name and c['passed'] for c in r['checks']) for name in ['actual_execution','exact_result','fixture_preserved'])
            common_ids=set(common[category]['transportCompleteCaseIds']);shared=[r for r in subset if r['case'] in common_ids]
            line['categories'][category]={'planned':len(subset),'measured':len(measured),'reviewed':len(reviewed),
                'passed':sum(r['status']=='passed' for r in measured),'supportedOutcome':sum(r.get('supportedOutcome',False) for r in measured),'recoveredToolErrors':sum(r.get('recoveredToolError',False) for r in measured),'workflowPassed':sum(r['mechanical_pass'] for r in measured),
                'artifactCorrect':sum(exact(r) for r in measured) if category=='shell' else None,
                'transportErrors':sum(r['status']=='transport_error' for r in subset),'evaluatorErrors':sum(r['status']=='evaluator_error' for r in subset),
                'medianSeconds':statistics.median(r['metrics']['seconds'] for r in measured) if measured else None,
                'commonMeasured':len(shared),'commonPassed':sum(r['status']=='passed' for r in shared),'commonSupportedOutcome':sum(r.get('supportedOutcome',False) for r in shared),
                'criticalFailures':sum(bool(r.get('criticalFailures')) for r in measured),
                'reportedUSD':sum(r['metrics']['costUSD'] for r in subset)}
        table.append(line)
    table.sort(key=lambda row:(-row['categories'].get('product',{}).get('passed',0),row['model']))
    return {'schemaVersion':1,'scope':'No weighted composite. Product/research are primary; Bash is an explicit secondary preference. Historical and current-prompt categories are separate; transport and evaluator gaps are not model failures.','models':table,'commonCases':common,'cases':rows}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['product','research','shell']:parser.add_argument('--'+name,type=Path,action='append',default=[])
    parser.add_argument('--output',type=Path,required=True);parser.add_argument('--compare',help='Comma-separated models for common-case intersection; table keeps all candidates');args=parser.parse_args()
    if args.output.exists():raise SystemExit('Use a fresh report output')
    data=assemble({name:read_runs(getattr(args,name),name) for name in ['product','research','shell']},args.compare.split(',') if args.compare else None)
    args.output.write_text(json.dumps(data,indent=2)+'\n')
    lines=['# Almanac model comparison','',data['scope'],'','| Model | Product correct outcome/reviewed (pristine) | Current research passed/reviewed | Bash correct artifacts/measured | Bash finished/measured | Product median seconds | Unmeasured transport / evaluator |','|---|---:|---:|---:|---:|---:|---:|']
    for row in data['models']:
        c=row['categories'];p=c.get('product',{});r=c.get('research',{});b=c.get('shell',{})
        ratio=lambda x:f"{x['passed']}/{x['reviewed']}" if x else '—'
        latency='—' if p.get('medianSeconds') is None else f"{p['medianSeconds']:.2f}"
        artifact=f"{b['artifactCorrect']}/{b['measured']}" if b else '—';finished=f"{b['passed']}/{b['measured']}" if b else '—'
        transport=sum(v['transportErrors'] for v in c.values());evaluator=sum(v['evaluatorErrors'] for v in c.values())
        lines.append(f"| {row['model']} | {str(p.get('supportedOutcome',0))+'/'+str(p.get('reviewed',0))+' ('+str(p.get('passed',0))+')' if p else '—'} | {ratio(r)} | {artifact} | {finished} | {latency} | {transport} / {evaluator} |")
    lines+=['','The JSON includes the exact transport-complete common-case intersection for each category. Ratios use reviewed cases; inspect the missing cases before drawing a comparison. Correct role outcomes after a rejected call and successful repair are shown separately from pristine runs; this matches production recovery without rewriting the original checks. A correct Bash artifact with an unfinished turn is shown separately.']
    args.output.with_suffix('.md').write_text('\n'.join(lines)+'\n')
if __name__=='__main__':main()
