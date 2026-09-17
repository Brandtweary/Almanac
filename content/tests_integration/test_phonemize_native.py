"""Explicit native-system-package integration; no downloads or network."""
import asyncio
import shutil
from oracle_content.phonemize import NativePhonemizer,PhonemizeRequest


def test_actual_native_ipa_alignment_and_capability():
    async def run():
        binary=shutil.which('espeak-ng')
        assert binary is not None, 'This integration requires the native espeak-ng package'
        native=NativePhonemizer(binary)
        await native.initialize()
        assert native.capability()['ready']
        texts=['aged','hello world','garden','garden','123','rain barrel','jalapeño','jötnar','Café']
        result=await native.convert(PhonemizeRequest(texts=texts,language='en-us'))
        assert len(result['phonemes'])==len(texts)
        assert result['phonemes'][2]==result['phonemes'][3]
        assert all(value.strip() for value in result['phonemes'])
        assert result['engine']['name']=='espeak-ng' and result['engine']['voice']=='en-us'
        assert result['engine']['version']
        assert native.active==0
    asyncio.run(run())


def test_actual_maximum_batch_is_bounded_and_aligned():
    async def run():
        binary=shutil.which('espeak-ng')
        assert binary is not None
        native=NativePhonemizer(binary)
        await native.initialize()
        text=('garden rain barrel ' * 4)[:64]
        result=await native.convert(PhonemizeRequest(texts=[text]*256,language='en-us'))
        assert len(result['phonemes'])==256 and len(set(result['phonemes']))==1
        assert native.active==0
    asyncio.run(run())


def test_native_stdin_preserves_single_characters_and_utf8_suffixes():
    import subprocess
    async def run():
        binary=shutil.which('espeak-ng')
        assert binary is not None, 'This integration requires the native espeak-ng package'
        native=NativePhonemizer(binary)
        await native.initialize()
        single=await native.convert(PhonemizeRequest(texts=['i'],language='en-us'))
        assert 'aɪ' in single['phonemes'][0]
        texts=['i','I','a','ab','i am','Café','jalapeño']
        expected=[]
        for text in texts:
            # Synthetic fixture text uses the CLI's independent, NUL-terminated argument path.
            output=subprocess.run([binary,'-q','--ipa','-v','en-us',text],capture_output=True,check=True).stdout.decode('utf-8')
            expected.append(' '.join(output.split()))
        actual=await native.convert(PhonemizeRequest(texts=texts,language='en-us'))
        assert actual['phonemes']==expected
        assert all(expected) and native.active==0
    asyncio.run(run())


def test_native_line_batch_preserves_independent_pronunciation_context():
    import subprocess
    async def run():
        binary=shutil.which('espeak-ng')
        assert binary is not None
        texts=['read','I read this','lead','the lead pipe','hello world','the world',
               '   spaced   text   ','Café','jalapeño','jötnar','植物','𐐀'*64,
               'é'*64,'x'*64,'aged','i','a','123','rain barrel']
        expected=[]
        for text in texts:
            output=subprocess.run([binary,'-q','--ipa','-v','en-us',text],capture_output=True,check=True).stdout.decode('utf-8')
            expected.append(' '.join(output.split()))
        native=NativePhonemizer(binary)
        await native.initialize()
        for batch in [texts,list(reversed(texts))]:
            actual=await native.convert(PhonemizeRequest(texts=batch,language='en-us'))
            assert actual['phonemes']==(expected if batch is texts else list(reversed(expected)))
        assert native.active==0
    asyncio.run(run())


def test_cancelled_native_batch_is_reaped_before_admission_releases():
    import os
    async def run():
        binary=shutil.which('espeak-ng')
        assert binary is not None
        started=asyncio.Event();processes=[]
        async def spawn(*args,**kwargs):
            process=await asyncio.create_subprocess_exec(*args,**kwargs)
            processes.append(process);started.set();return process
        native=NativePhonemizer(binary)
        await native.initialize()
        native.spawn=spawn
        task=asyncio.create_task(native.convert(PhonemizeRequest(texts=['𐐀'*64]*256,language='en-us')))
        await started.wait();await asyncio.sleep(0);task.cancel()
        try:
            await task
            assert False,'Cancellation unexpectedly completed a batch'
        except asyncio.CancelledError:
            pass
        assert len(processes)==1 and processes[0].returncode is not None and native.active==0
        try:
            os.kill(processes[0].pid,0)
            assert False,'Cancelled native process remains alive'
        except ProcessLookupError:
            pass
    asyncio.run(run())
