"""Trusted in-jail executor; only bounded regular-file snapshots cross its boundary."""
import base64
import ctypes
import json
import os
from pathlib import Path
import resource
import selectors
import signal
import subprocess
import sys
import time

# The child cannot ptrace this process or reopen its descriptors through procfs.
if ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) != 0:
    raise RuntimeError('Cannot protect supervisor')
request = json.load(sys.stdin)
for name, content in request['files'].items():
    target = Path('/work') / name
    if target.is_absolute() and ('..' in Path(name).parts or name.startswith('/')):
        raise ValueError('Invalid fixture path')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(base64.b64decode(content))

def limits():
    for key, value in [(resource.RLIMIT_CPU, 3), (resource.RLIMIT_AS, 128*1024*1024),
                       (resource.RLIMIT_FSIZE, 1024*1024), (resource.RLIMIT_NOFILE, 32),
                       (resource.RLIMIT_NPROC, 64), (resource.RLIMIT_CORE, 0)]:
        resource.setrlimit(key, (value, value))

started = time.monotonic()
process = subprocess.Popen(['/bin/bash', '--noprofile', '--norc', '-c', request['command']],
    cwd='/work', stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    start_new_session=True, preexec_fn=limits, env={'PATH':'/bin','HOME':'/work','LC_ALL':'C','TMPDIR':'/work'})
selector = selectors.DefaultSelector()
for stream in (process.stdout, process.stderr):
    os.set_blocking(stream.fileno(), False)
    selector.register(stream, selectors.EVENT_READ)
outputs = {process.stdout: bytearray(), process.stderr: bytearray()}
timed_out = truncated = False
# EOF can precede the leader's exit. Wait for both under the same deadline;
# poll() also reaps a normally exited leader before descendant cleanup.
while selector.get_map() or process.poll() is None:
    if time.monotonic()-started > 5:
        timed_out = True
        break
    for key, _ in selector.select(0.05):
        chunk = os.read(key.fileobj.fileno(), 4096)
        if not chunk:
            selector.unregister(key.fileobj)
            continue
        destination = outputs[key.fileobj]
        available = max(0, 32768-len(destination))
        destination.extend(chunk[:available])
        if len(chunk)>available:
            truncated = True
    if truncated:
        break
# Kill remaining group members after normal completion, or the whole group on
# timeout/output overflow. A normally completed leader already has its status.
try:
    os.killpg(process.pid, signal.SIGKILL)
except ProcessLookupError:
    pass
process.wait(timeout=2)
# Escaped sessions are killed by destruction of the PID namespace. Snapshotting
# accepts no symlink, special file or bytes beyond the receipt budget.
files = {}
total = 0
snapshot_rejected = False
for directory, dirs, names in os.walk('/work', followlinks=False):
    dirs[:] = [d for d in dirs if not Path(directory,d).is_symlink()]
    for name in names:
        path = Path(directory,name)
        if path.is_symlink() or not path.is_file():
            continue
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            import stat
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                continue
            data = os.read(fd, 131073)
        finally:
            os.close(fd)
        total += len(data)
        if len(data)>131072 or total>524288 or len(files)>=128:
            snapshot_rejected = True
            break
        files[str(path.relative_to('/work'))] = base64.b64encode(data).decode()
    if snapshot_rejected:
        files = request['files']
        break
if snapshot_rejected:
    outputs[process.stderr] = outputs[process.stderr][:32700] + b'\nFile snapshot limit exceeded; file changes discarded.'
print(json.dumps({'stdout': outputs[process.stdout].decode('utf8','replace'),
    'stderr': outputs[process.stderr].decode('utf8','replace'), 'exitCode':125 if snapshot_rejected else process.returncode,
    'timedOut':timed_out,'outputTruncated':truncated,'files':files}))
