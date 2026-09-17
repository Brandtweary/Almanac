"""Explicit integration probe for a running speech endpoint; no model is launched."""
import argparse
import asyncio
import json
import math
import time
import msgpack
from websockets.asyncio.client import connect


async def probe(url, text):
    started=time.monotonic();first=None;samples=0;squared=0.0;frames=0
    async with connect(url,max_size=2**20) as ws:
        ready=msgpack.unpackb(await ws.recv(),raw=False)
        if ready!={"type":"Ready"}:raise RuntimeError("Missing readiness")
        await ws.send(msgpack.packb({"type":"Text","text":text},use_bin_type=True))
        await ws.send(msgpack.packb({"type":"Eos"},use_bin_type=True))
        async for raw in ws:
            message=msgpack.unpackb(raw,raw=False)
            if message["type"]=="Audio":
                if first is None:first=time.monotonic()-started
                pcm=message["pcm"]
                if not pcm or not all(isinstance(v,(int,float)) and math.isfinite(v) for v in pcm):raise RuntimeError("Invalid PCM")
                samples+=len(pcm);squared+=sum(v*v for v in pcm);frames+=1
        if ws.close_code!=1000:raise RuntimeError(f"Speech closed with {ws.close_code}")
    if not samples:raise RuntimeError("No audio")
    elapsed=time.monotonic()-started;duration=samples/24000
    return {"first_audio_seconds":first,"elapsed_seconds":elapsed,"audio_seconds":duration,"rtf":elapsed/duration,"frames":frames,"rms":math.sqrt(squared/samples)}


if __name__=="__main__":
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('url');args=p.parse_args()
    print(json.dumps(asyncio.run(probe(args.url,'The garden receives morning sunlight. Water the seedlings gently and check the soil before adding more.')),indent=2))
