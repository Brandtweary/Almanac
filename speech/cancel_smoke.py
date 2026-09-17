"""Explicit live cancellation/reuse probe for a running stock speech service."""
import argparse
import asyncio
import json
import time
import urllib.request
from urllib.parse import urlsplit,urlunsplit
import msgpack
from websockets.asyncio.client import connect
from smoke import probe


async def check(url):
    async with connect(url,max_size=2**20) as ws:
        assert msgpack.unpackb(await ws.recv(),raw=False)['type']=='Ready'
        await ws.send(msgpack.packb({'type':'Text','text':'The measurements describe a careful comparison. '*20},use_bin_type=True))
        await ws.send(msgpack.packb({'type':'Eos'},use_bin_type=True))
        async for raw in ws:
            if msgpack.unpackb(raw,raw=False)['type']=='Audio':break
        started=time.monotonic();await ws.close()
    parsed=urlsplit(url);health=urlunsplit(('http',parsed.netloc,'/health','',''))
    while True:
        state=await asyncio.to_thread(lambda:json.load(urllib.request.urlopen(health,timeout=2)))
        if not state['busy']:break
        if time.monotonic()-started>5:raise RuntimeError('Cancelled generation retained admission')
        await asyncio.sleep(.02)
    idle=time.monotonic()-started
    return {'cancel_to_idle_seconds':idle,'reuse':await probe(url,'The next sentence is available after cancellation.')}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('url')
    print(json.dumps(asyncio.run(check(parser.parse_args().url)),indent=2))
