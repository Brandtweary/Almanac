"""Integrity properties only the host can witness: no network during detection, no page cache in scrubbing.

These run the scrub in a child process under host tools — `unshare` for a namespace
with no network, `strace` for the flags every open used, `fincore` for page-cache
residency — so they need those tools installed, and they fail rather than skip when
one is missing.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from tests.test_integrity import LEAF, damage, install, leaf_status

CONTENT = Path(__file__).resolve().parents[1]
DRIVER = """
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[3])
from oracle_content.integrity.scrub import scrub
print(scrub(Path(sys.argv[1]), Path(sys.argv[2])))
"""


def tool(name):
    path = shutil.which(name)
    assert path, f"{name} is required to witness this property on the host"
    return path


def run(argv, item):
    return subprocess.run([*argv, sys.executable, "-c", DRIVER, str(item.root), str(item.manifest), str(CONTENT)],
                          capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=120)


def evict(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
        os.posix_fadvise(descriptor, 0, 0, os.POSIX_FADV_DONTNEED)
    finally:
        os.close(descriptor)


def resident(path):
    output = subprocess.run([tool("fincore"), "--bytes", "--noheadings", "--output", "RES", str(path)],
                            capture_output=True, text=True, check=True, stdin=subprocess.DEVNULL).stdout
    return int(output.split()[0])


def test_i11_detection_runs_with_no_network(tmp_path):
    item = install(tmp_path, sources=[{"type": "http-range", "url": "https://mirror.example/fixture.zim"}])
    damage(item.path, 3 * LEAF + 5)
    isolated = run([tool("unshare"), "--user", "--map-root-user", "--net"], item)
    assert isolated.returncode == 0, isolated.stderr
    assert leaf_status(item, 3) == "damaged"
    assert {leaf_status(item, index) for index in range(10) if index != 3} == {"ok"}


def test_i12_scrub_reads_the_medium_not_the_page_cache(tmp_path):
    item = install(tmp_path, leaves=64)
    evict(item.path)
    if resident(item.path) != 0:
        pytest.fail("the fixture could not be evicted from the page cache, so residency proves nothing")
    trace = tmp_path / "trace"
    traced = run([tool("strace"), "-f", "-e", "trace=openat", "-o", str(trace)], item)
    assert traced.returncode == 0, traced.stderr
    scrubbed = (f'"{item.path}"', f'"{item.parity}"')
    opens = [line for line in trace.read_text().splitlines() if "openat(" in line and any(name in line for name in scrubbed)]
    assert {name for name in scrubbed if any(name in line for line in opens)} == set(scrubbed), \
        "the scrub never opened the artifact and its parity"
    assert all("O_DIRECT" in line for line in opens), opens
    assert resident(item.path) == 0
    assert {leaf_status(item, index) for index in range(64)} == {"ok"}
