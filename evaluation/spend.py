"""Deduplicate provider-reported developer evaluation charges by generation ID."""
import argparse
import json
import math
from pathlib import Path


def collect_spend(directories: list[Path]) -> dict:
    charges: dict[str, float] = {}
    mismatches: list[str] = []
    def visit(value):
        if isinstance(value, dict):
            identity=value.get('id'); usage=value.get('usage')
            if isinstance(identity,str) and identity.startswith('gen-') and isinstance(usage,dict):
                cost=usage.get('cost')
                if type(cost) in (int,float) and math.isfinite(cost) and cost>=0:
                    prior=charges.get(identity)
                    if prior is not None and not math.isclose(prior,cost,rel_tol=1e-10,abs_tol=1e-12):
                        mismatches.append(identity)
                    charges[identity]=max(prior or 0,cost)
            for child in value.values():visit(child)
        elif isinstance(value,list):
            for child in value:visit(child)
    unreadable=[]
    for directory in directories:
        for file in directory.glob('*.json'):
            try:visit(json.loads(file.read_text()))
            except (ValueError,OSError) as error:unreadable.append({'file':str(file),'error':type(error).__name__})
    return {'reportedCostUSD':sum(charges.values()),'providerGenerations':len(charges),
            'inconsistentGenerationCharges':sorted(set(mismatches)),'unreadable':unreadable,
            'scope':'Provider-reported billed generations only. Missing usage and incomplete transport costs are not asserted free; inspect run reserves separately.'}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('directories',type=Path,nargs='+');args=parser.parse_args()
    print(json.dumps(collect_spend(args.directories),indent=2))
