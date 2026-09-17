"""Explicit developer-only hosted screening; never imported by the application."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

from .research import run_case, SYSTEM
from .scoring import digest, validate_suite


def screen(*, suite: dict, models: list[dict], api_key: str, output: Path, system_prompt: str = SYSTEM, output_tokens: int = 2048, workers: int = 6, retry_rate_limit: bool = False) -> None:
    """Run development gold-context only, with bounded calls and token exposure."""
    validate_suite(suite)
    for profile in models:
        pin = profile.get('providerRouting', {}) if isinstance(profile, dict) else {}
        selectors = pin.get('only', pin.get('order'))
        if not isinstance(profile, dict) or not isinstance(profile.get('id'), str) or not profile['id'] or not isinstance(selectors, list) or len(selectors) != 1 or not isinstance(selectors[0], str) or not selectors[0].strip() or any(key in pin and pin[key] != selectors for key in ('only', 'order')):
            raise ValueError('Every model requires an id and exactly one consistent provider pin')
    if len({p['id'] for p in models}) != len(models):
        raise ValueError('Model identities must be unique')
    if output.exists():
        raise ValueError("Use a new output directory; receipts are immutable")
    output.mkdir(parents=True)
    cases = [case for case in suite["cases"] if case["split"] == "development"]
    output.joinpath('freeze.json').write_text(json.dumps({'suite_digest':digest(suite),'models':models,
        'case_ids':[c['id'] for c in cases], 'system_prompt':system_prompt,'max_output_tokens':output_tokens,'max_input_utf8_bytes':8192,
        'temperature':0,'mode':'gold_context','heldout_used':False},indent=2)+'\n')
    def one(pair):
        profile, case = pair
        model = profile['id']
        requests, responses = [], []
        target=output/(model.replace('/','__')+'--'+case['id']+'.json')
        record={'profile':profile,'case_id':case['id'],'requests':requests,'responses':responses,'state':'running','usageIncomplete':False}
        def persist():
            temporary=target.with_suffix('.tmp')
            temporary.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
            temporary.replace(target)
        def perform_completion(messages, tools):
            payload = {'model':model,'messages':messages,'temperature':0,'max_tokens':output_tokens,
                       'provider':{**profile['providerRouting'],'require_parameters':True,'allow_fallbacks':False},'stream':False}
            # UTF-8 bytes conservatively bound ordinary byte-tokenizer input text.
            # This is screening exposure control, not release tokenizer admission.
            if len(json.dumps(messages,ensure_ascii=False).encode()) > 8192:
                raise ValueError('Screening input exposure bound')
            requests.append(payload)
            record['usageIncomplete']=True
            persist()
            request=urllib.request.Request('https://openrouter.ai/api/v1/chat/completions',
                data=json.dumps(payload).encode(),headers={'Authorization':'Bearer '+api_key,'Content-Type':'application/json'})
            start=time.monotonic()
            try:
                with urllib.request.urlopen(request,timeout=90) as response:
                    raw=json.load(response)
            except urllib.error.HTTPError as exc:
                responses.append({'http_status':exc.code,'seconds':time.monotonic()-start,'retry_after':exc.headers.get('Retry-After'),'body':exc.read().decode(errors='replace')})
                if exc.code != 429 or not retry_rate_limit:
                    raise RuntimeError('Hosted transport error') from None
                try:
                    delay=float(exc.headers.get('Retry-After', '5'))
                except ValueError:
                    delay=5
                if not 0 <= delay <= 30:
                    raise RuntimeError('Rate limit exceeds bounded retry') from None
                time.sleep(delay)
                requests.append(payload)
                persist()
                try:
                    with urllib.request.urlopen(request,timeout=90) as response:
                        raw=json.load(response)
                except urllib.error.HTTPError as retry:
                    responses.append({'http_status':retry.code,'attempt':2})
                    raise RuntimeError('Hosted retry transport error') from None
            responses.append({'response':raw,'seconds':time.monotonic()-start})
            return raw['choices'][0]
        def complete(messages, tools):
            try:
                return perform_completion(messages, tools)
            except Exception as exc:
                record['exception']={'type':type(exc).__name__,'message':str(exc).replace(api_key,'[redacted credential]')}
                raise
        started=time.monotonic()
        try:
            receipt=run_case(case,complete,lambda *_:None,mode='gold_context',profile={'transport':'openrouter',**profile},
                max_completions=1,max_tool_calls=1,gold_evidence=[suite['contexts'][k] for k in case['gold_context']],system_prompt=system_prompt)
            record.update(receipt=receipt,state='failed' if receipt.get('errors') else 'completed')
        except Exception as exc:
            record.update(state='failed',exception={'type':type(exc).__name__,'message':str(exc).replace(api_key,'[redacted credential]')})
        finally:
            record['usageIncomplete']=len(requests)!=len(responses) or any(not isinstance(r.get('response',{}).get('usage',{}).get('cost'), (int,float)) for r in responses)
            record['unknownExposure']=record['usageIncomplete']
            record['elapsed_seconds']=time.monotonic()-started
            persist()
        receipt=record.get('receipt',{})
        return {'model':model,'case':case['id'],'state':record['state'],'errors':receipt.get('errors',[]),'exception':record.get('exception'),'finish_reason':receipt.get('finish_reason'),
                'seconds':record['elapsed_seconds'],'unknownExposure':record['unknownExposure'],'usage':[r['response'].get('usage') for r in responses if 'response' in r]}
    with ThreadPoolExecutor(max_workers=workers) as executor:
        summary=list(executor.map(one,[(model,case) for model in models for case in cases]))
    output.joinpath('summary.json').write_text(json.dumps(summary,indent=2)+'\n')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite',type=Path,default=Path(__file__).with_name('fixtures.json'))
    parser.add_argument('--models',type=Path,required=True,help='JSON list of {id, providerRouting: {only: [provider]}} identities')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    import os
    key=os.environ.get('OPENROUTER_API_KEY')
    if not key:
        raise SystemExit('OPENROUTER_API_KEY required for explicit paid screening')
    screen(suite=json.loads(args.suite.read_text()),models=json.loads(args.models.read_text()),api_key=key,output=args.output)

if __name__=='__main__':
    main()
