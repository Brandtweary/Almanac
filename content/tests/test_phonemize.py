import asyncio
import json
from types import SimpleNamespace
import httpx
import pytest
from pydantic import ValidationError
from oracle_content.app import create_app
from oracle_content.models import ContentError
from oracle_content.phonemize import NativePhonemizer, PhonemizeRequest, MAX_OUTPUT_BYTES, MAX_REQUEST_BYTES


class Input:
    def __init__(self): self.data=b''; self.closed=False
    def write(self,data): self.data+=data
    async def drain(self): pass
    def close(self): self.closed=True


class Process:
    def __init__(self,stdout=b'phonemes\n',stderr=b'',code=0,blocked=False):
        self.stdin=Input();self.stdout=asyncio.StreamReader();self.stderr=asyncio.StreamReader()
        self.pid=123456789;self.returncode=None if blocked else code;self.waited=False
        if not blocked:
            self.stdout.feed_data(stdout);self.stdout.feed_eof();self.stderr.feed_data(stderr);self.stderr.feed_eof()
    async def wait(self):
        self.waited=True
        return self.returncode


class Spawn:
    def __init__(self,processes): self.processes=iter(processes);self.calls=[]
    async def __call__(self,*args,**kwargs):
        self.calls.append((args,kwargs));return next(self.processes)


def ready(spawn,**options):
    service=NativePhonemizer('/test/espeak-ng',spawn=spawn,**options);service.version='test';service.reason=None
    return service


def test_schema_rejects_controls_symbols_options_and_oversize():
    for text in ['','   ','hello\nworld','a\n','\u0301','💚','--voices=en','<speak>','a'*65]:
        with pytest.raises(ValidationError): PhonemizeRequest(texts=[text],language='en-us')
    with pytest.raises(ValidationError):PhonemizeRequest(texts=['a']*257,language='en-us')
    with pytest.raises(ValidationError):PhonemizeRequest(texts=['a'],language='fr')
    with pytest.raises(ValidationError):PhonemizeRequest(texts=['a'],language='en-us',user_id='private')


def test_alignment_version_and_stdin_only():
    async def run():
        version=Process(b'eSpeak NG text-to-speech: 1.52.0.1 Data at: /private/path\n')
        batch=Process('ˈeɪdʒd\nhəlˈoʊ wˈɜːld\n'.encode())
        spawn=Spawn([version,Process(b"voys"),batch]);native=NativePhonemizer('/test/espeak-ng',spawn=spawn)
        await native.initialize();result=await native.convert(PhonemizeRequest(texts=['aged','hello world'],language='en-us'))
        assert result=={'phonemes':['ˈeɪdʒd','həlˈoʊ wˈɜːld'],'engine':{'name':'espeak-ng','version':'1.52.0.1','voice':'en-us'}}
        assert batch.stdin.data==b'aged\nhello world\n'
        assert all('aged' not in args and 'hello world' not in args for args,_ in spawn.calls)
        assert spawn.calls[1][0][1:]==('-q','--ipa','-v','en-us','--stdin')
        assert spawn.calls[2][0][1:]==('-q','--ipa','-v','en-us')
        assert len(spawn.calls)==3
        assert all(kwargs.get('start_new_session') and 'shell' not in kwargs for _,kwargs in spawn.calls)
        assert all(p.waited and p.stdin.closed for p in [version,batch])
        assert '/private/path' not in json.dumps(native.capability())
    asyncio.run(run())


def test_batch_alignment_and_per_item_output_bounds():
    async def run():
        body=PhonemizeRequest(texts=['first','second'],language='en-us')
        for output in [b'one\n', b'one\n\ntwo\n', b'x'*MAX_OUTPUT_BYTES+b'\ntwo\n', b'x'*(MAX_OUTPUT_BYTES+1)+b'\ntwo\n']:
            process=Process(output);native=ready(Spawn([process]))
            with pytest.raises(ContentError) as error:await native.convert(body)
            assert error.value.code=='phonemizer_failed'
            assert process.waited and native.active==0
        # The whole request may exceed one record's bound while each result stays bounded.
        output=b'x'*(MAX_OUTPUT_BYTES//2)+b'\n'+b'y'*(MAX_OUTPUT_BYTES//2)+b'\n'
        spawn=Spawn([Process(output)]);native=ready(spawn)
        result=await native.convert(body)
        assert len(result['phonemes'])==2 and len(spawn.calls)==1
        empty=ready(Spawn([]))
        assert (await empty.convert(PhonemizeRequest(texts=[],language='en-us')))['phonemes']==[]
        assert empty.active==0
    asyncio.run(run())


def test_missing_and_invalid_optional_configuration(monkeypatch):
    monkeypatch.setenv('CONTENT_PHONEMIZE_MAX_ACTIVE','bad')
    native=NativePhonemizer.configured();assert native.capability()['reason']=='configuration_invalid'
    async def run():
        await native.initialize()
        with pytest.raises(ContentError) as error: await native.convert(PhonemizeRequest(texts=['word'],language='en-us'))
        assert error.value.code=='phonemizer_unavailable'
    asyncio.run(run())


def test_nonzero_invalid_utf8_and_excess_output_do_not_leak_text():
    async def run():
        for p in [Process(b'private-output',b'private-error',code=1),Process(b'\xff'),Process(b'x'*(MAX_OUTPUT_BYTES+1))]:
            native=ready(Spawn([p]))
            with pytest.raises(ContentError) as error: await native.convert(PhonemizeRequest(texts=['private'],language='en-us'))
            assert 'private' not in error.value.message
            assert native.active==0 and p.waited
    asyncio.run(run())


def test_busy_has_no_queue_and_cancel_reaps(monkeypatch):
    async def run():
        p=Process(blocked=True);spawn=Spawn([p]);native=ready(spawn,max_active=1)
        killed=[]
        def kill(pid,sig): killed.append(pid);p.returncode=-9
        monkeypatch.setattr('oracle_content.phonemize.os.killpg',kill)
        task=asyncio.create_task(native.convert(PhonemizeRequest(texts=['first'],language='en-us')))
        while not spawn.calls: await asyncio.sleep(0)
        with pytest.raises(ContentError) as error: await native.convert(PhonemizeRequest(texts=['second'],language='en-us'))
        assert error.value.code=='phonemizer_busy' and len(spawn.calls)==1
        task.cancel()
        with pytest.raises(asyncio.CancelledError):await task
        assert killed==[p.pid] and p.waited and native.active==0
    asyncio.run(run())


def test_timeout_reaps_and_releases_slot(monkeypatch):
    async def run():
        p=Process(blocked=True);native=ready(Spawn([p]),timeout=.01)
        def kill(pid,sig): p.returncode=-9
        monkeypatch.setattr('oracle_content.phonemize.os.killpg',kill)
        with pytest.raises(ContentError) as error:await native.convert(PhonemizeRequest(texts=['word'],language='en-us'))
        assert error.value.code=='phonemizer_timeout' and error.value.status==504
        assert p.waited and native.active==0
    asyncio.run(run())


def test_cancellation_during_spawn_retains_process_ownership(monkeypatch):
    async def run():
        gate=asyncio.Event();started=asyncio.Event();p=Process(blocked=True);killed=[]
        async def spawn(*args,**kwargs):started.set();await gate.wait();return p
        def kill(pid,sig):killed.append(pid);p.returncode=-9
        monkeypatch.setattr('oracle_content.phonemize.os.killpg',kill)
        native=ready(spawn);task=asyncio.create_task(native.convert(PhonemizeRequest(texts=['word'],language='en-us')))
        await started.wait();task.cancel();await asyncio.sleep(0);task.cancel();gate.set()
        with pytest.raises(asyncio.CancelledError):await task
        assert killed==[p.pid] and p.waited and native.active==0
    asyncio.run(run())


def test_http_body_limits_capability_and_optional_failure():
    corpus=SimpleNamespace(health=lambda:{'ready':True},profile=SimpleNamespace(request_timeout=1))
    async def run():
        app=create_app(corpus,phonemizer=NativePhonemizer(None))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            health=(await client.get('/capabilities')).json()
            assert health['ready'] and not health['phonemizer']['ready']
            response=await client.post('/v1/phonemize',json={'texts':['word'],'language':'en-us'})
            assert response.status_code==503 and response.json()['error']['code']=='phonemizer_unavailable'
            assert (await client.post('/v1/phonemize',json={'texts':['💚'],'language':'en-us'})).status_code==400
            async def chunks():
                yield b'x'*MAX_REQUEST_BYTES
                yield b'x'
            response=await client.post('/v1/phonemize',content=chunks(),headers={'Content-Type':'application/json'})
            assert response.status_code==413
    asyncio.run(run())


def test_unicode_nfc_validation_and_utf8_stdin():
    body=PhonemizeRequest(texts=['Cafe\u0301','jalapeño','jötnar','植物'],language='en-us')
    assert body.texts[0]=='Café'
    async def run():
        p=Process('kaˈfeɪ'.encode());native=ready(Spawn([p]))
        result=await native.convert(PhonemizeRequest(texts=['Café'],language='en-us'))
        assert p.stdin.data=='Café\n'.encode('utf-8') and result['phonemes']==['kaˈfeɪ']
    asyncio.run(run())


def test_missing_native_voice_is_not_advertised_ready():
    async def run():
        native=NativePhonemizer('/test/espeak-ng',spawn=Spawn([
            Process(b'eSpeak NG text-to-speech: 1.52.0'),Process(b'',b'missing data',code=1)]))
        await native.initialize()
        assert not native.capability()['ready']
        assert native.capability()['reason']=='engine_unavailable'
    asyncio.run(run())


def test_http_disconnect_reaps_native_process(monkeypatch):
    async def run():
        process=Process(blocked=True);started=asyncio.Event();killed=[]
        async def spawn(*args,**kwargs):started.set();return process
        def kill(pid,sig):killed.append(pid);process.returncode=-9
        monkeypatch.setattr('oracle_content.phonemize.os.killpg',kill)
        native=ready(spawn)
        corpus=SimpleNamespace(health=lambda:{'ready':True},profile=SimpleNamespace(request_timeout=1))
        app=create_app(corpus,phonemizer=native)
        body=json.dumps({'texts':['word'],'language':'en-us'}).encode();delivered=False;sent=[]
        async def receive():
            nonlocal delivered
            if not delivered:
                delivered=True;return {'type':'http.request','body':body,'more_body':False}
            await started.wait();return {'type':'http.disconnect'}
        async def send(message):sent.append(message)
        scope={'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','method':'POST','scheme':'http',
               'path':'/v1/phonemize','raw_path':b'/v1/phonemize','query_string':b'',
               'headers':[(b'content-type',b'application/json')],'server':('test',80),'client':('test',1)}
        await asyncio.wait_for(app(scope,receive,send),timeout=1)
        assert killed==[process.pid] and process.waited and native.active==0
    asyncio.run(run())
