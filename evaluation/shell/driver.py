"""JSON-lines driver for a fail-closed, synthetic-only Bash evaluation session."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import sysconfig
import tempfile

TOOLS = ('bash','ls','sort','wc','cat','cut','head','tail','tr','uniq','cp','mv','mkdir','rm','printf','seq','sleep','env','grep','awk','stat')

def main():
    bwrap = shutil.which('bwrap')
    if not bwrap:
        raise RuntimeError('Shell sandbox unavailable: bubblewrap required')
    with tempfile.TemporaryDirectory(prefix='almanac-shell-') as temp:
        root = Path(temp)/'root'
        root.mkdir()
        copied = set()
        def copy_elf(source, destination=None):
            source = Path(source).resolve()
            destination = destination or str(source)
            key = (str(source), destination)
            if key in copied:
                return
            copied.add(key)
            target = root / destination.lstrip('/')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            target.chmod(0o555)
            data = source.read_bytes()[:4]
            if data != b'\x7fELF':
                return
            result = subprocess.run(['ldd', str(source)], capture_output=True, text=True, timeout=10)
            if result.returncode and 'not a dynamic executable' not in result.stderr+result.stdout:
                raise RuntimeError('Cannot resolve public tool dependencies')
            for dependency in re.findall(r'(?:=>\s+)?(/[^\s()]+)',result.stdout):
                copy_elf(dependency, dependency)
        for name in TOOLS:
            source = shutil.which(name)
            if not source:
                raise RuntimeError(f'Shell tool unavailable: {name}')
            copy_elf(source, '/bin/'+name)
        stdlib_origin = Path(sysconfig.get_path('stdlib'), 'os.py').resolve().parents[2]
        interpreter = stdlib_origin / 'bin' / ('python'+str(sys.version_info.major)+'.'+str(sys.version_info.minor))
        copy_elf(interpreter if interpreter.is_file() else sys.executable, '/bin/python3')
        stdlib = Path(sysconfig.get_path('stdlib'), 'os.py').resolve().parent
        destination = '/lib/python'+str(sys.version_info.major)+'.'+str(sys.version_info.minor)
        # Enumerated standard-library sources only: no site-packages or host config.
        for source in stdlib.rglob('*'):
            relative = source.relative_to(stdlib)
            if any(part in {'site-packages','__pycache__','test','tests','ensurepip','idlelib','tkinter'} for part in relative.parts):
                continue
            if source.is_file() and source.suffix in {'.py','.so'}:
                if source.suffix == '.so':
                    copy_elf(source, destination+'/'+str(relative))
                else:
                    target = root/(destination+'/'+str(relative)).lstrip('/')
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, target)
        shutil.copyfile(Path(__file__).with_name('supervisor.py'), root/'supervisor.py')
        for name in ('work','dev'):
            (root/name).mkdir()
        (root/'dev/null').touch()
        digest = hashlib.sha256()
        for source in sorted(root.rglob('*')):
            if source.is_file():
                digest.update(str(source.relative_to(root)).encode())
                digest.update(source.read_bytes())
        argv = [bwrap,'--unshare-all','--unshare-user','--disable-userns','--die-with-parent','--new-session','--clearenv',
                '--ro-bind',str(root),'/', '--size','8388608','--tmpfs','/work','--dev-bind','/dev/null','/dev/null',
                '--setenv','PYTHONHOME','/','--setenv','LC_ALL','C','--chdir','/work',
                '--','/bin/python3','-s','-S','/supervisor.py']
        def run(command, files):
            result = subprocess.run(argv, input=json.dumps({'command':command,'files':files}),
                                    text=True,capture_output=True,timeout=10,env={})
            if result.returncode:
                raise RuntimeError('Shell sandbox failed ('+str(result.returncode)+'): '+result.stderr[:1000])
            return json.loads(result.stdout)
        canary = run('test ! -e /home && test ! -e /proc && test ! -e /etc && test "$HOME" = /work && test "$(env | wc -l)" -le 8 && ! (echo x >/supervisor.py) 2>/dev/null && ! (echo x >/dev/tcp/1.1.1.1/80) 2>/dev/null && printf sandbox-ok', {})
        if canary['exitCode'] != 0 or canary['stdout'] != 'sandbox-ok':
            raise RuntimeError('Shell containment canary failed: '+json.dumps(canary))
        print(json.dumps({'ready':True,'toolchainSha256':digest.hexdigest(),'containment':{'filesystem':True,'environment':True,'network':True}}),flush=True)
        files = {}
        for line in sys.stdin:
            request = json.loads(line)
            if request['action']=='init':
                files = {key:base64.b64encode(value.encode()).decode() for key,value in request['files'].items()}
                result = {'initialized':True}
            elif request['action']=='execute':
                if len(request['command'])>8192:
                    raise ValueError('Command too long')
                result = run(request['command'],files)
                files = result.pop('files')
            elif request['action']=='inspect':
                result = {'files':{key:base64.b64decode(value).decode('utf8','replace') for key,value in files.items()}}
            else:
                raise ValueError('Unknown action')
            print(json.dumps(result),flush=True)

if __name__=='__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        main()
    except Exception as error:
        print(json.dumps({'error':str(error)}),flush=True)
        sys.exit(1)
