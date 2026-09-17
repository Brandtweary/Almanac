"""Acquire and verify public stock speech assets for subsequent offline startup."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request


def verify(destination: Path):
    for row in json.loads(Path(__file__).with_name('assets.json').read_text(encoding='utf-8')):
        path=destination/row['file']
        if path.name!=row['file']:raise ValueError('Asset path must be a basename')
        with path.open('rb') as source:digest=hashlib.file_digest(source,'sha256').hexdigest()
        if path.stat().st_size!=row['bytes'] or digest!=row['sha256']:raise ValueError(f'Asset verification failed: {path.name}')


def prepare(destination: Path):
    destination.mkdir(parents=True, exist_ok=True)
    for row in json.loads(Path(__file__).with_name('assets.json').read_text(encoding='utf-8')):
        path=destination/row['file']
        if path.name!=row['file']:raise ValueError('Asset path must be a basename')
        if not path.exists():
            partial=path.with_suffix(path.suffix+'.partial')
            with urllib.request.urlopen(row['url'],timeout=60) as source,partial.open('wb') as target:
                while chunk:=source.read(1024*1024):target.write(chunk)
            partial.rename(path)
    verify(destination)
    print('Public speech assets verified')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('destination',type=Path)
    prepare(parser.parse_args().destination)
