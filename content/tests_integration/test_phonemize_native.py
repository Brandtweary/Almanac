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
