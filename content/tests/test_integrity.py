"""Corpus integrity invariants on plain files: admission, detection, mending and recovery.

Every test here breaks the property its name states on a fixture made for the purpose.
A detector that has only ever seen healthy bytes passes whether or not it works, so the
fixtures are damaged on purpose: bytes flipped in place with the file's mtime put back,
which is what silent media corruption looks like to everything that only stats a file.
"""
import errno
import hashlib
import json
import os
import random
import signal
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from oracle_content.integrity import admit as admission
from oracle_content.integrity import manifest as manifests
from oracle_content.integrity import mend as mending
from oracle_content.integrity import state as integrity_state
from oracle_content.integrity import zimmap
from oracle_content.integrity.medium import Medium, RateLimit
from oracle_content.integrity.mend import mend_all
from oracle_content.integrity.overlay import Overlay
from oracle_content.integrity.scrub import scrub
from oracle_content.integrity.sources import release_parts
from oracle_content.integrity.state import State
from oracle_content.integrity.tree import leaf_hash, root
from oracle_content.integrity.upstream import probe_all

LEAF = 8192
CONTENT = Path(__file__).resolve().parents[1]
REPOSITORY = CONTENT.parent


def install(tmp_path, *, leaves=10, tail=1234, group=4, sources=(), seed=1, name="state"):
    """An original under a content-state root, admitted and committed to a manifest directory."""
    data = random.Random(seed).randbytes(LEAF * (leaves - 1) + tail)
    sha = hashlib.sha256(data).hexdigest()
    store_root = tmp_path / name
    (store_root / "originals").mkdir(parents=True)
    path = store_root / "originals" / sha
    path.write_bytes(data)
    stat = path.stat()
    receipt = path.with_suffix(".receipt.json")
    receipt.write_text(json.dumps({"sha256": sha, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}))
    admission.admit(store_root, sha, kind="upstream", pack_path="sources/fixture.zim", sources=list(sources),
                    leaf_bytes=LEAF, parity_dir=tmp_path / (name + "-parity"), parity_group=group)
    manifest_dir = tmp_path / (name + "-manifest")
    manifest_dir.mkdir()
    (manifest_dir / "corpus.json").write_bytes(manifests.render(manifests.empty(LEAF)))
    admission.publish_candidate(store_root, sha, manifest_dir)
    return SimpleNamespace(root=store_root, sha=sha, path=path, manifest=manifest_dir, data=data, receipt=receipt,
                           parity=tmp_path / (name + "-parity") / (sha + ".parity"))


def damage(path, offset, payload=b"\xde\xad"):
    """Change bytes in place and restore the mtime, as silent media corruption does."""
    stat = path.stat()
    with open(path, "r+b") as stream:
        stream.seek(offset)
        stream.write(bytes(byte ^ 0xFF for byte in stream.read(len(payload))) if payload is None else payload)
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))


def fingerprint(path):
    stat = path.stat()
    return hashlib.sha256(path.read_bytes()).hexdigest(), stat.st_size, stat.st_mtime_ns


def leaf_status(item, index, artifact=None):
    state = State(item.root / "integrity")
    try:
        return state.leaf(artifact or item.sha, index)["status"]
    finally:
        state.close()


def events(item, kind):
    state = State(item.root / "integrity")
    try:
        return state.events(kind=kind)
    finally:
        state.close()


class Response:
    def __init__(self, status, headers, body):
        self.status, self.headers, self.body = status, headers, body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, limit=-1):
        return self.body if limit < 0 else self.body[:limit]


class Mirror:
    """An upstream that serves exact ranges of `payload`, optionally lying about their content."""

    def __init__(self, payload, tamper=None):
        self.payload, self.tamper, self.requests = payload, tamper, []

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        first, last = (int(value) for value in request.get_header("Range").split("=")[1].split("-"))
        body = self.payload[first:last + 1]
        if self.tamper is not None:
            body = self.tamper(first, body)
        return Response(206, {"Content-Range": f"bytes {first}-{last}/{len(self.payload)}"}, body)


class Recording(Medium):
    def __init__(self):
        self.writes = []

    def write_leaf(self, path, offset, payload):
        self.writes.append((Path(path).name, offset, len(payload)))
        return super().write_leaf(path, offset, payload)


def test_tree_matches_the_certificate_transparency_reference_roots():
    """RFC 6962 roots for the reference inputs published with Certificate Transparency."""
    inputs = [b"", b"\x00", b"\x10", b"\x20\x21", b"\x30\x31", b"\x40\x41\x42\x43", bytes(range(0x50, 0x58)),
              bytes(range(0x60, 0x70))]
    expected = ["6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
                "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
                "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
                "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
                "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
                "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
                "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
                "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328"]
    assert [root([leaf_hash(value) for value in inputs[:count]]).hex() for count in range(1, 9)] == expected


def test_i1_admission_trusts_only_the_pinned_bytes(tmp_path):
    """A leaf list, parity or map comes only from a pass that reproduced the pinned identity."""
    data = random.Random(7).randbytes(LEAF * 3 + 100)
    sha = hashlib.sha256(data).hexdigest()
    store_root = tmp_path / "state"
    (store_root / "originals").mkdir(parents=True)
    path = store_root / "originals" / sha
    path.write_bytes(data)
    damage(path, LEAF + 5)
    with pytest.raises(admission.AdmissionRefused) as refused:
        admission.admit(store_root, sha, kind="upstream", pack_path="p", sources=[], leaf_bytes=LEAF,
                        parity_dir=tmp_path / "parity")
    assert refused.value.reason == "whole_file_sha256_mismatch"
    assert not (store_root / "integrity").exists() and not (tmp_path / "parity").exists()

    # The right bytes filed under another artifact's pinned identity are refused too.
    wrong = "0" * 64
    (store_root / "originals" / wrong).write_bytes(data)
    with pytest.raises(admission.AdmissionRefused, match="whole_file"):
        admission.admit(store_root, wrong, kind="upstream", pack_path="p", sources=[], leaf_bytes=LEAF,
                        parity_dir=tmp_path / "parity")
    assert not (store_root / "integrity").exists()

    # An upstream piece table that disagrees with one leaf refuses admission and names the piece.
    path.write_bytes(data)
    pieces = [hashlib.sha1(data[offset:offset + LEAF]).digest() for offset in range(0, len(data), LEAF)]
    pieces[2] = hashlib.sha1(b"another edition").digest()
    upstream = {"length": LEAF, "pieces": pieces, "metalink_sha256": "0" * 64}
    with pytest.raises(admission.AdmissionRefused) as refused:
        admission.admit(store_root, sha, kind="upstream", pack_path="p", sources=[], leaf_bytes=LEAF,
                        parity_dir=tmp_path / "parity", upstream=upstream)
    assert refused.value.reason == "upstream_piece_mismatch" and refused.value.detail["mismatched_pieces"] == [2]
    assert not (store_root / "integrity").exists()


def test_i2_each_leaf_is_bound_to_its_position(tmp_path):
    item = install(tmp_path, sources=[{"type": "http-range", "url": "https://mirror.example/fixture.zim"}])
    scrub(item.root, item.manifest)
    first, second = item.data[2 * LEAF:3 * LEAF], item.data[5 * LEAF:6 * LEAF]
    damage(item.path, 2 * LEAF, second)
    damage(item.path, 5 * LEAF, first)
    scrub(item.root, item.manifest)
    assert leaf_status(item, 2) == leaf_status(item, 5) == "damaged"

    # A mirror answering for leaf 2 with leaf 5's bytes offers a well-formed wrong candidate.
    def swap(start, body):
        return item.data[5 * LEAF:6 * LEAF] if start == 2 * LEAF else body
    damage(item.parity, 2 * LEAF)  # leaf 2's group parity is gone, so only the mirror can answer
    medium = Recording()
    mend_all(item.root, item.manifest, medium=medium, opener=Mirror(item.data, swap), artifacts={item.sha})
    rejected = [event for event in events(item, "source_rejected") if event["leaf"] == 2]
    assert rejected and rejected[0]["detail"]["source"] == "https://mirror.example/fixture.zim"
    assert leaf_status(item, 2) == "unrepairable"
    assert all(offset != 2 * LEAF for _name, offset, _length in medium.writes)
    assert item.path.read_bytes()[2 * LEAF:3 * LEAF] == second


def test_i3_a_resized_artifact_is_reported_and_never_written(tmp_path):
    short, long = install(tmp_path, name="short"), install(tmp_path, name="long", seed=2)
    scrub(short.root, short.manifest)
    scrub(long.root, long.manifest)
    with open(short.path, "r+b") as stream:
        stream.truncate(len(short.data) - 1)
    with open(long.path, "ab") as stream:
        stream.write(b"\0")
    fingerprints = {item.sha: fingerprint(item.path) for item in (short, long)}
    for item in (short, long):
        scrub(item.root, item.manifest)
        state = State(item.root / "integrity")
        assert state.artifact(item.sha)["status"] == "size_mismatch"
        state.close()
        # Withdrawn whole, before any leaf is quarantined: lexical search goes with it.
        assert Overlay(item.root).archive(item.sha).lexical_withdrawn
        damage(item.path, 2 * LEAF + 9)  # real damage, which parity alone could otherwise mend
        state = State(item.root / "integrity")
        state.set_leaf(item.sha, 2, "damaged")
        state.close()
        fingerprints[item.sha] = fingerprint(item.path)
        medium = Recording()
        mend_all(item.root, item.manifest, medium=medium)
        assert medium.writes == [] and fingerprint(item.path) == fingerprints[item.sha]
        assert Overlay(item.root).archive(item.sha).withdrawn_reason == "size_mismatch"


class LiesOnce(Medium):
    """A medium whose first direct read of one leaf returns wrong bytes, then tells the truth."""

    def __init__(self, leaf):
        self.leaf, self.lied = leaf, False

    def read_span(self, descriptor, start, stop):
        data = super().read_span(descriptor, start, stop)
        if start == self.leaf * LEAF and not self.lied:
            self.lied = True
            return b"\0" * len(data)
        return data


def test_i4_a_single_failed_read_never_causes_a_write(tmp_path):
    item = install(tmp_path)
    before = fingerprint(item.path)
    scrub(item.root, item.manifest, medium=LiesOnce(4))
    assert leaf_status(item, 4) == "transient"
    medium = Recording()
    mend_all(item.root, item.manifest, medium=medium)
    assert medium.writes == [] and fingerprint(item.path) == before

    # A stale `damaged` verdict on a leaf that reads correctly now is never acted on either:
    # the mender's own confirming read gates the write.
    state = State(item.root / "integrity")
    state.set_leaf(item.sha, 6, "damaged")
    state.close()
    mend_all(item.root, item.manifest, medium=medium)
    assert medium.writes == [] and fingerprint(item.path) == before
    assert leaf_status(item, 6) == "mended_pending_reload"


class DropsWrites(Medium):
    """A medium that acknowledges writes and keeps none of them."""

    def __init__(self):
        self.writes = 0

    def write_leaf(self, path, offset, payload):
        self.writes += 1


def test_i5_only_verified_bytes_are_written_and_a_lost_write_is_not_retried(tmp_path, monkeypatch):
    item = install(tmp_path, sources=[{"type": "http-range", "url": "https://mirror.example/fixture.zim"}])
    scrub(item.root, item.manifest)
    damage(item.path, 3 * LEAF + 40)
    damage(item.parity, 0 * LEAF + 40)  # leaf 3 is in parity group 0: parity cannot answer
    scrub(item.root, item.manifest)
    before = fingerprint(item.path)

    # A mirror serving other bytes, whose SHA-1 is written into the recorded upstream piece
    # table so that the cross-check agrees with it: the leaf hash alone still decides.
    forged = random.Random(9).randbytes(LEAF)
    sha1 = item.root / "integrity" / "upstream" / (item.sha + ".sha1")
    sha1.parent.mkdir(parents=True, exist_ok=True)
    pieces = [hashlib.sha1(item.data[offset:offset + LEAF]).digest() for offset in range(0, len(item.data), LEAF)]
    pieces[3] = hashlib.sha1(forged).digest()
    sha1.write_bytes(b"".join(pieces))
    medium = Recording()
    mend_all(item.root, item.manifest, medium=medium,
             opener=Mirror(item.data, lambda start, body: forged if start == 3 * LEAF else body))
    assert medium.writes == [] and fingerprint(item.path) == before
    rejected = events(item, "source_rejected")
    assert rejected[-1]["leaf"] == 3 and rejected[-1]["detail"]["upstream_piece_matched"] is True
    assert leaf_status(item, 3) == "unrepairable"

    # The right bytes onto a medium that drops them, once the unrepairable leaf is due a
    # retry: `write_failed`, the receipt untouched, and a second run leaves it for a
    # person instead of writing again.
    later = time.time_ns() + 2 * 24 * 3600 * 10 ** 9
    monkeypatch.setattr(integrity_state, "now_ns", lambda: later)
    receipt = item.receipt.read_text()
    dropping = DropsWrites()
    mend_all(item.root, item.manifest, medium=dropping, opener=Mirror(item.data))
    assert dropping.writes == 1 and leaf_status(item, 3) == "write_failed"
    scrub(item.root, item.manifest)
    mend_all(item.root, item.manifest, medium=dropping, opener=Mirror(item.data))
    assert dropping.writes == 1 and item.receipt.read_text() == receipt


@pytest.mark.parametrize("seed", range(6))
def test_i6_a_mend_changes_only_the_damaged_leaves(tmp_path, seed):
    """Random damage, including a contiguous burst as long as the parity stride, mended offline."""
    item = install(tmp_path, leaves=23, tail=LEAF, group=4, seed=seed)
    scrub(item.root, item.manifest)
    chooser = random.Random(seed)
    stride = -(-23 // 4)
    if seed % 2:
        start = chooser.randrange(0, 23 - stride)
        damaged = set(range(start, start + stride))
    else:
        damaged = {chooser.choice(range(slot, 23, stride)) for slot in range(stride) if chooser.random() < 0.7}
    for index in damaged:
        damage(item.path, index * LEAF + chooser.randrange(LEAF - 2))
    scrub(item.root, item.manifest)

    def leaves():
        raw = item.path.read_bytes()
        return [hashlib.sha256(raw[offset:offset + LEAF]).digest() for offset in range(0, len(raw), LEAF)]

    before = leaves()
    medium = Recording()
    mend_all(item.root, item.manifest, medium=medium, network=False)
    after = leaves()
    assert all(before[index] == after[index] for index in range(23) if index not in damaged)
    assert sorted(offset // LEAF for _name, offset, _length in medium.writes) == sorted(damaged)
    assert all(length == LEAF for _name, _offset, length in medium.writes)
    assert item.path.read_bytes() == item.data


CRASH_DRIVER = """
import os, signal, sys
from pathlib import Path
sys.path.insert(0, sys.argv[4])
from oracle_content.integrity import medium, mend
medium.WRITE_CHUNK = 1024
def crash(name):
    if name == sys.argv[1]:
        os.kill(os.getpid(), signal.SIGKILL)
medium._step = crash
mend.mend_all(Path(sys.argv[2]), Path(sys.argv[3]), network=False)
"""


def receipt_holds(item):
    receipt = json.loads(item.receipt.read_text())
    stat = item.path.stat()
    return receipt["size"] == stat.st_size and receipt["mtime_ns"] == stat.st_mtime_ns


def test_recovery_refuses_a_resized_original_before_writing(tmp_path):
    item = install(tmp_path)
    damage(item.path, LEAF + 5)
    scrub(item.root, item.manifest)
    journal = item.root / "integrity" / "journal" / item.sha
    journal.mkdir(parents=True)
    (journal / "1.json").write_text(json.dumps({"leaf": 1}))
    (journal / "1.leaf").write_bytes(item.data[LEAF:2 * LEAF])
    # The damaged leaf remains readable, but the rest of the archive changed shape
    # after the scrub and before recovery inspected the journal.
    with item.path.open("r+b") as stream:
        stream.truncate(len(item.data) - 1)
    before, receipt = fingerprint(item.path), item.receipt.read_bytes()
    medium = Recording()
    mend_all(item.root, item.manifest, medium=medium, network=False)
    assert medium.writes == []
    assert fingerprint(item.path) == before and item.receipt.read_bytes() == receipt
    assert (journal / "1.leaf").exists()
    assert Overlay(item.root).archive(item.sha).withdrawn_reason == "size_mismatch"


def test_journal_directory_entries_are_durable_before_the_original_write(tmp_path, monkeypatch):
    item = install(tmp_path)
    damage(item.path, LEAF + 5)
    scrub(item.root, item.manifest)
    synced = set()
    fsync_dir = mending._fsync_dir

    def record(path):
        fsync_dir(path)
        synced.add(Path(path))

    monkeypatch.setattr(mending, "_fsync_dir", record)

    class DurableJournal(Recording):
        def write_leaf(self, path, offset, payload):
            # Fsyncing files and the innermost directory leaves newly created
            # ancestor entries vulnerable to disappearing on a power loss.
            assert item.root / "integrity" in synced
            assert item.root / "integrity" / "journal" in synced
            return super().write_leaf(path, offset, payload)

    medium = DurableJournal()
    mend_all(item.root, item.manifest, medium=medium, network=False)
    assert len(medium.writes) == 1 and item.path.read_bytes() == item.data


@pytest.mark.parametrize("failure", [OSError(errno.EIO, "readback failed"), EOFError("short readback")])
def test_readback_failure_latches_the_mend_without_retrying(tmp_path, failure):
    item = install(tmp_path)
    damage(item.path, LEAF + 5)
    scrub(item.root, item.manifest)
    receipt = item.receipt.read_bytes()

    class UnreadableAfterWrite(Recording):
        def read_leaf_fresh(self, path, index, size, leaf_bytes):
            if self.writes and Path(path) == item.path:
                raise failure
            return super().read_leaf_fresh(path, index, size, leaf_bytes)

    medium = UnreadableAfterWrite()
    mend_all(item.root, item.manifest, medium=medium, network=False)
    assert len(medium.writes) == 1 and leaf_status(item, 1) == "write_failed"
    assert item.receipt.read_bytes() == receipt
    scrub(item.root, item.manifest)
    assert leaf_status(item, 1) == "write_failed"
    mend_all(item.root, item.manifest, medium=medium, network=False)
    assert len(medium.writes) == 1


@pytest.mark.parametrize("step", ["candidate_chosen", "journal_written", "mid_write", "before_fdatasync", "before_receipt",
                                  "before_epoch"])
def test_i7_i17_a_crash_at_any_step_converges_and_the_receipt_follows_verification(tmp_path, step):
    item = install(tmp_path, leaves=12, group=4)
    scrub(item.root, item.manifest)
    for index in (1, 6):
        damage(item.path, index * LEAF + 3000, random.Random(index).randbytes(3000))
    scrub(item.root, item.manifest)
    killed = subprocess.run([sys.executable, "-c", CRASH_DRIVER, step, str(item.root), str(item.manifest), str(CONTENT)],
                            capture_output=True, stdin=subprocess.DEVNULL, timeout=60)
    assert killed.returncode == -signal.SIGKILL, killed.stderr.decode()
    # Between the write and the receipt update the receipt still describes the old file,
    # so every reader that checks one against the other refuses the archive meanwhile.
    assert receipt_holds(item) == (step in ("candidate_chosen", "journal_written", "before_epoch"))
    raw = item.path.read_bytes()
    for index in range(12):
        if index not in (1, 6):
            assert raw[index * LEAF:(index + 1) * LEAF] == item.data[index * LEAF:(index + 1) * LEAF]
    mend_all(item.root, item.manifest, network=False)
    assert item.path.read_bytes() == item.data
    assert receipt_holds(item)
    assert not (item.root / "integrity" / "journal" / item.sha).exists() or \
        not any((item.root / "integrity" / "journal" / item.sha).iterdir())
    scrub(item.root, item.manifest)
    assert {leaf_status(item, index) for index in range(12)} <= {"ok", "mended_pending_reload"}
    assert {event["leaf"] for event in events(item, "damaged")} <= {1, 6}


def test_i7_a_torn_journal_record_never_halts_mending(tmp_path, monkeypatch):
    """A journal write that stops before it is durable leaves the previous record whole; a torn one is rebuilt."""
    record = tmp_path / "0.json"
    record.write_bytes(b'{"leaf": 0}')

    def stops(descriptor):
        raise OSError(errno.EIO, "Input/output error")

    monkeypatch.setattr(os, "fsync", stops)
    with pytest.raises(OSError):
        mending._durable(record, b'{"leaf": 0, "write_failed": "read back does not match"}')
    monkeypatch.undo()
    assert json.loads(record.read_bytes()) == {"leaf": 0} and [path.name for path in tmp_path.iterdir()] == ["0.json"]

    # Two journal entries whose records are torn: one mid-mend, one whose write the
    # medium already dropped. The first finishes from its candidate; the second stays
    # for a person, because the leaf's state still says the medium dropped a write.
    item = install(tmp_path, name="torn")
    scrub(item.root, item.manifest)
    for index in (2, 5):
        damage(item.path, index * LEAF + 5)
    scrub(item.root, item.manifest)
    state = State(item.root / "integrity")
    state.set_leaf(item.sha, 2, "mending")
    state.set_leaf(item.sha, 5, "write_failed")
    state.close()
    journal = item.root / "integrity" / "journal" / item.sha
    journal.mkdir(parents=True)
    for index in (2, 5):
        (journal / f"{index}.leaf").write_bytes(item.data[index * LEAF:(index + 1) * LEAF])
        (journal / f"{index}.json").write_bytes(b'{"artifact": "' + item.sha[:9].encode())
    damaged_five = item.path.read_bytes()[5 * LEAF:6 * LEAF]
    outcome = mend_all(item.root, item.manifest, network=False)
    recovery = dict(outcome[item.sha][0][1])
    assert recovery == {2: "mended", 5: "write_failed_kept"}
    raw = item.path.read_bytes()
    assert raw[2 * LEAF:3 * LEAF] == item.data[2 * LEAF:3 * LEAF] and raw[5 * LEAF:6 * LEAF] == damaged_five
    assert sorted(event["leaf"] for event in events(item, "journal_record_unreadable")) == [2, 5]
    assert json.loads((journal / "5.json").read_bytes())["write_failed"]
    mend_all(item.root, item.manifest, network=False)
    assert len(events(item, "journal_record_unreadable")) == 2


def second_original(item, tmp_path, *, seed=5, leaves=10):
    """Another original admitted into `item`'s content state and committed to its manifest."""
    data = random.Random(seed).randbytes(LEAF * (leaves - 1) + 999)
    sha = hashlib.sha256(data).hexdigest()
    (item.root / "originals" / sha).write_bytes(data)
    admission.admit(item.root, sha, kind="upstream", pack_path="sources/second.zim", sources=[], leaf_bytes=LEAF,
                    parity_dir=tmp_path / "second-parity", parity_group=4)
    admission.publish_candidate(item.root, sha, item.manifest)
    return sha


def test_budgeted_slices_reach_every_artifact(tmp_path):
    item = install(tmp_path)
    second_original(item, tmp_path)
    for _ in range(8):
        scrub(item.root, item.manifest, budget=5)
    state = State(item.root / "integrity")
    try:
        for row in state.artifacts():
            assert state.leaves_in(row["id"], ("unverified",)) == [], row["id"]
            assert state.last_full_pass(row["id"]) is not None, row["id"]
    finally:
        state.close()


def test_a_read_path_flag_during_a_scrub_batch_is_kept_and_reloads(tmp_path):
    """The scrub read a leaf clean; the service then flags it from memory before the batch commits."""
    item = install(tmp_path)

    class FlagsMidBatch(Medium):
        def read_leaf(self, descriptor, index, size, leaf_bytes):
            if index == 5:
                Overlay(item.root).mark_suspect(item.sha, 2, "read_path_hash_mismatch")
            return super().read_leaf(descriptor, index, size, leaf_bytes)

    scrub(item.root, item.manifest, medium=FlagsMidBatch())
    assert leaf_status(item, 2) == "suspect"
    scrub(item.root, item.manifest)
    state = State(item.root / "integrity")
    try:
        assert state.leaf(item.sha, 2)["status"] == "mended_pending_reload" and state.epoch(item.sha) == 1
    finally:
        state.close()


class Counting(Medium):
    def __init__(self):
        self.read = 0

    def read_span(self, descriptor, start, stop):
        data = super().read_span(descriptor, start, stop)
        self.read += len(data)
        return data


def unlimited():
    return RateLimit(1e15, sleep=lambda seconds: None)


def test_every_direct_read_is_held_to_the_rate(tmp_path):
    """Admission's structure pass and a mend's parity reconstruction read inside the operator's cap."""
    data = random.Random(3).randbytes(LEAF * 5 + 10)
    sha = hashlib.sha256(data).hexdigest()
    store_root = tmp_path / "state"
    (store_root / "originals").mkdir(parents=True)
    (store_root / "originals" / sha).write_bytes(data)
    medium, rate = Counting(), unlimited()
    admission.admit(store_root, sha, kind="upstream", pack_path="p", sources=[], leaf_bytes=LEAF,
                    parity_dir=tmp_path / "parity", medium=medium, rate=rate)
    assert medium.read > len(data) and rate.consumed == medium.read

    item = install(tmp_path, name="mend")
    scrub(item.root, item.manifest)
    damage(item.path, 4 * LEAF + 9)
    scrub(item.root, item.manifest)
    medium, rate = Counting(), unlimited()
    assert (4, "mended") in mend_all(item.root, item.manifest, medium=medium, rate=rate, network=False)[item.sha]
    assert medium.read > 4 * LEAF and rate.consumed == medium.read


def test_an_unrepairable_leaf_is_retried_on_a_doubling_delay(tmp_path, monkeypatch):
    item = install(tmp_path)
    scrub(item.root, item.manifest)
    damage(item.path, 7 * LEAF + 11)
    damage(item.parity, (7 % 3) * LEAF + 11)
    scrub(item.root, item.manifest)
    clock = {"now": time.time_ns()}
    monkeypatch.setattr(integrity_state, "now_ns", lambda: clock["now"])
    hour = 3600 * 10 ** 9
    for advance, expected in ((0, "unrepairable"), (0, "retry_deferred"), (hour, "unrepairable"),
                              (hour, "retry_deferred"), (hour, "unrepairable")):
        clock["now"] += advance
        medium = Counting()
        outcome = dict(mend_all(item.root, item.manifest, medium=medium, network=False)[item.sha][1:])
        assert outcome[7] == expected
        assert (medium.read == 0) == (expected == "retry_deferred")


def test_held_candidates_are_not_fetched_again(tmp_path):
    url = "https://mirror.example/fixture.zim"
    item = install(tmp_path, sources=[{"type": "http-range", "url": url}])
    scrub(item.root, item.manifest)
    damage(item.path, 3 * LEAF + 40)
    damage(item.parity, 0 * LEAF + 40)
    scrub(item.root, item.manifest)
    mirror = Mirror(item.data)
    before = fingerprint(item.path)
    assert (3, "held") in mend_all(item.root, item.manifest, opener=mirror, write=False)[item.sha]
    assert (3, "held") in mend_all(item.root, item.manifest, opener=mirror, write=False)[item.sha]
    assert len(mirror.requests) == 1 and fingerprint(item.path) == before and leaf_status(item, 3) == "damaged"


def test_release_parts_serve_each_leaf_from_its_own_part(tmp_path):
    size = LEAF * 9 + 1234
    urls = [f"https://releases.example/fixture.part{number}" for number in range(3)]
    source = release_parts(urls, size=size, leaf_bytes=LEAF, leaves_per_part=4)
    with pytest.raises(ValueError, match="make 3 parts"):
        release_parts(urls[:2], size=size, leaf_bytes=LEAF, leaves_per_part=4)
    item = install(tmp_path, sources=[source])
    scrub(item.root, item.manifest)
    for index in (5, 9):
        damage(item.path, index * LEAF + 17)
        damage(item.parity, (index % 3) * LEAF + 17)
    scrub(item.root, item.manifest)
    # Each part is the artifact cut every four leaves, as `split` would cut it.
    parts = {url: Mirror(item.data[number * 4 * LEAF:(number + 1) * 4 * LEAF]) for number, url in enumerate(urls)}
    outcome = mend_all(item.root, item.manifest, opener=lambda request, timeout=None: parts[request.full_url](request))
    assert {(5, "mended"), (9, "mended")} <= set(outcome[item.sha][1:]) and item.path.read_bytes() == item.data
    assert [len(parts[url].requests) for url in urls] == [0, 1, 1]


def test_structure_map_reads_link_target_entries_at_their_own_width():
    """libzim gives a link target or deleted entry no bytes past the common eight-byte header."""
    mime = b"text/html\0\0"
    dirent_at = zimmap.HEADER.size + len(mime) + 8
    dirent = zimmap.DIRENT_FIXED.pack(zimmap.LINKTARGET, 0, b"C", 0) + b"ab\0\0"
    trailer = b"Q" * 5 + b"\0" + b"R" * 5 + b"\0"
    checksum_at = dirent_at + len(dirent) + len(trailer)
    header = zimmap.HEADER.pack(zimmap.MAGIC, 6, 1, bytes(16), 1, 0, zimmap.HEADER.size + len(mime), zimmap.ABSENT,
                                dirent_at + len(dirent), zimmap.HEADER.size, 0, 0xFFFFFFFF, checksum_at)
    raw = header + mime + dirent_at.to_bytes(8, "little") + dirent + trailer + bytes(16)

    class Bytes:
        size = len(raw)

        def read(self, start, length):
            return raw[start:start + length]

    built = zimmap.build(Bytes())
    length = int.from_bytes(built[len(zimmap.MAP_MAGIC):len(zimmap.MAP_MAGIC) + 8], "little")
    header = json.loads(built[len(zimmap.MAP_MAGIC) + 8:len(zimmap.MAP_MAGIC) + 8 + length])
    assert {"kind": "dirents", "start": dirent_at, "end": dirent_at + len(dirent)} in header["regions"]
    assert header["unsupported_dirents"] == 1


def test_the_services_own_suspect_flag_quarantines_at_once(tmp_path):
    """The overlay that flags a leaf is the one serving; its own write must reach its own view."""
    item = install(tmp_path)
    scrub(item.root, item.manifest)
    overlay = Overlay(item.root)
    assert overlay.archive(item.sha).quarantined == {}
    overlay.mark_suspect(item.sha, 2, "read_path_hash_mismatch")
    assert overlay.archive(item.sha).quarantined == {2: "suspect"}


def test_a_missing_parity_hash_list_never_stops_data_mending(tmp_path):
    url = "https://mirror.example/fixture.zim"
    item = install(tmp_path, sources=[{"type": "http-range", "url": url}])
    scrub(item.root, item.manifest)
    damage(item.path, 4 * LEAF + 3)
    scrub(item.root, item.manifest)
    (item.parity.parent / (item.parity.name + ".leaves")).unlink()
    outcome = mend_all(item.root, item.manifest, opener=Mirror(item.data))
    assert (4, "mended") in outcome[item.sha] and item.path.read_bytes() == item.data
    assert outcome["parity-" + item.sha][0][0] == "parity_hashes_damaged"


def test_parity_mending_takes_its_lock(tmp_path):
    item = install(tmp_path)
    scrub(item.root, item.manifest)
    damage(item.parity, LEAF + 5)
    scrub(item.root, item.manifest, artifacts={"parity-" + item.sha})
    before, medium = fingerprint(item.parity), Recording()
    with mending.mend_lock(item.root, "parity-" + item.sha):
        outcome = mend_all(item.root, item.manifest, medium=medium, network=False)
    assert outcome["parity-" + item.sha][0][0] == "busy" and medium.writes == [] and fingerprint(item.parity) == before
    assert (1, "recomputed") in mend_all(item.root, item.manifest, network=False)["parity-" + item.sha]


def test_admitting_a_missing_original_is_a_refusal(tmp_path):
    missing = "0" * 64
    tool = subprocess.run([sys.executable, str(CONTENT / "tools" / "integrity.py"), "--data", str(tmp_path), "admit",
                           "--sha256", missing, "--pack-path", "sources/absent.zim", "--no-metalink"],
                          capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=60)
    assert tool.returncode == 1 and json.loads(tool.stdout)["reason"] == "artifact_missing", tool.stderr


def test_i8_a_manifest_that_does_not_reproduce_never_drives_a_write(tmp_path):
    """A local leaf list rewritten to bless other bytes, which a mirror then serves."""
    url = "https://mirror.example/fixture.zim"
    item = install(tmp_path, sources=[{"type": "http-range", "url": url}])
    scrub(item.root, item.manifest)
    forged = random.Random(4).randbytes(LEAF)
    leaves = item.manifest / "leaves" / (item.sha + ".leaves")
    committed = leaves.read_bytes()
    leaves.write_bytes(committed[:4 * 32] + leaf_hash(forged) + committed[5 * 32:])
    damage(item.path, 4 * LEAF + 7)
    damage(item.parity, (4 % 3) * LEAF + 7)
    before = fingerprint(item.path)
    summary = scrub(item.root, item.manifest)
    assert "not judged" in summary[item.sha]["skipped"]
    state = State(item.root / "integrity")
    assert state.get_meta("manifest")["ok"] is False
    state.set_leaf(item.sha, 4, "damaged")
    state.close()
    medium, mirror = Recording(), Mirror(item.data, lambda start, body: forged if start == 4 * LEAF else body)
    outcome = mend_all(item.root, item.manifest, medium=medium, opener=mirror)
    assert (4, "manifest_damaged") in outcome[item.sha]
    assert medium.writes == [] and fingerprint(item.path) == before

    # A leaf list and its record rewritten together still leave the corpus root behind.
    blessed = committed[:4 * 32] + leaf_hash(forged) + committed[5 * 32:]
    document = json.loads((item.manifest / "corpus.json").read_text())
    document["artifacts"][0]["root"] = root([blessed[offset:offset + 32] for offset in range(0, len(blessed), 32)]).hex()
    (item.manifest / "corpus.json").write_text(json.dumps(document))
    state = State(item.root / "integrity")
    state.db.execute("UPDATE artifact SET root=? WHERE id=?", (document["artifacts"][0]["root"], item.sha))
    state.close()
    outcome = mend_all(item.root, item.manifest, medium=medium, opener=mirror)
    assert (4, "manifest_damaged") in outcome[item.sha] and medium.writes == []


def test_i14_parity_is_verified_before_use_and_falls_through_to_the_network(tmp_path):
    url = "https://mirror.example/fixture.zim"
    item = install(tmp_path, sources=[{"type": "http-range", "url": url}])
    scrub(item.root, item.manifest)
    damage(item.path, 7 * LEAF + 11)
    damage(item.parity, (7 % 3) * LEAF + 11)
    scrub(item.root, item.manifest)
    mirror = Mirror(item.data)
    outcome = mend_all(item.root, item.manifest, opener=mirror)
    assert (7, "mended") in outcome[item.sha]
    failures = [event for event in events(item, "source_failed") if event["leaf"] == 7]
    assert failures and failures[0]["detail"]["source"] == "parity"
    assert "Parity leaf" in failures[0]["detail"]["error"]
    assert len(mirror.requests) == 1 and item.path.read_bytes() == item.data

    # With no other source, the failed parity route writes nothing at all.
    damage(item.path, 7 * LEAF + 11)
    damage(item.parity, (7 % 3) * LEAF + 11)
    scrub(item.root, item.manifest)
    before, medium = fingerprint(item.path), Recording()
    mend_all(item.root, item.manifest, medium=medium, network=False)
    assert medium.writes == [] and fingerprint(item.path) == before and leaf_status(item, 7) == "unrepairable"


def test_i15_a_leaf_never_verified_counts_as_unverified(tmp_path):
    item = install(tmp_path)
    coverage = Overlay(item.root).coverage(item.sha)
    assert coverage["admitted"] and coverage["verified_fraction"] == 0.0 and coverage["unverified_leaves"] == 10
    scrub(item.root, item.manifest)
    coverage = Overlay(item.root).coverage(item.sha)
    assert coverage["verified_fraction"] == 1.0 and coverage["unverified_leaves"] == 0
    assert Overlay(tmp_path / "elsewhere").coverage(item.sha)["admitted"] is False


def git(*args):
    return subprocess.run(["git", *args], cwd=REPOSITORY, capture_output=True, stdin=subprocess.DEVNULL, check=True).stdout


def test_i16_committed_entries_never_change(tmp_path):
    """The repository's manifest history, then the checker itself against histories that break the rule."""
    snapshots = []
    for commit in reversed(git("log", "--format=%H", "--", "deploy/integrity").decode().split()):
        document = json.loads(git("show", f"{commit}:deploy/integrity/corpus.json"))
        leaves = {record["sha256"]: git("show", f"{commit}:deploy/integrity/leaves/{record['sha256']}.leaves")
                  for record in document["artifacts"]}
        snapshots.append((commit[:12], document, leaves))
    tree = REPOSITORY / "deploy" / "integrity"
    document = json.loads((tree / "corpus.json").read_text())
    snapshots.append(("working tree", document, {record["sha256"]: (tree / "leaves" / (record["sha256"] + ".leaves"))
                                                 .read_bytes() for record in document["artifacts"]}))
    assert manifests.history_violations(snapshots) == []

    item = install(tmp_path)
    committed = json.loads((item.manifest / "corpus.json").read_text())
    leaves = {item.sha: (item.manifest / "leaves" / (item.sha + ".leaves")).read_bytes()}
    moved = json.loads(json.dumps(committed))
    moved["artifacts"][0]["sources"] = [{"type": "http-range", "url": "https://elsewhere.example/a.zim"}]
    edited = json.loads(json.dumps(committed))
    edited["artifacts"][0]["pack_path"] = "sources/renamed.zim"
    assert manifests.history_violations([("a", committed, leaves), ("b", moved, leaves)]) == []
    assert manifests.history_violations([("a", committed, leaves), ("b", edited, leaves)]) == [
        f"b: record for {item.sha} changed"]
    assert manifests.history_violations([("a", committed, leaves), ("b", committed, {item.sha: b"\0" * 320})]) == [
        f"b: leaf list for {item.sha} changed"]

    # The merge that produces commits refuses the same edits at the source.
    record = json.loads((item.root / "integrity" / "candidates" / (item.sha + ".json")).read_text())
    with pytest.raises(ValueError, match="already committed with different fields"):
        manifests.merge(item.manifest, {**record, "pack_path": "sources/renamed.zim"}, leaves[item.sha], leaf_bytes=LEAF)
    with pytest.raises(ValueError, match="different leaf list"):
        manifests.merge(item.manifest, record, b"\0" * len(leaves[item.sha]), leaf_bytes=LEAF)


def test_upstream_listing_reports_a_newer_edition(tmp_path):
    listing = {"type": "upstream-listing", "url": "https://mirror.example/zim/wikipedia/",
               "name": "wikipedia_en_all_nopic", "edition": "2026-06"}
    item = install(tmp_path, sources=[{"type": "http-range", "url": "https://mirror.example/zim/wikipedia/a.zim"},
                                      listing])
    page = {"body": b'<a href="wikipedia_en_all_nopic_2026-06.zim">x</a> <a href="wikipedia_en_all_maxi_2026-12.zim">z</a>'}

    def opener(request, timeout=None):
        if request.get_method() == "HEAD":
            return Response(200, {"Content-Length": str(len(item.data)), "ETag": '"abc"'}, b"")
        return Response(200, {}, page["body"])

    probe_all(item.root, item.manifest, opener=opener)
    coverage = Overlay(item.root).coverage(item.sha)
    assert coverage["upstream"] == {"reachable": True, "installed_edition_listed": True, "successor": None}
    assert coverage["network_sources_available"] == 1

    # Upstream moves on: a newer edition is listed and the installed one has been retired.
    page["body"] = b'<a href="wikipedia_en_all_nopic_2026-09.zim">y</a> <a href="wikipedia_en_all_maxi_2026-12.zim">z</a>'
    probe_all(item.root, item.manifest, opener=opener)
    assert Overlay(item.root).coverage(item.sha)["upstream"] == {
        "reachable": True, "installed_edition_listed": False,
        "successor": {"edition": "2026-09", "url": "https://mirror.example/zim/wikipedia/wikipedia_en_all_nopic_2026-09.zim"}}
    assert [event["kind"] for event in events(item, "upstream_successor_listed")] == ["upstream_successor_listed"]



def test_generation_identity_is_judged_by_the_fields_its_manifest_was_written_with(tmp_path):
    """A generation written before its manifest carried rights exclusions reproduces its name without
    them; dropping the field from a manifest written with it is still a mismatch."""
    from oracle_content.integrity.scrub import check_generations
    from oracle_content.models import digest
    from oracle_content.native import KIND
    earlier = {"kind": KIND, "source": {"sha256": "ab" * 32, "pack_id": "fixture"}, "index_fingerprint": "f",
               "selection_policy": "canonical-html", "representation": "title-lead-v1", "vector_datatype": "float16"}
    current = {**earlier, "representation": "title-lead-v2", "rights_exclusions": {"A/Held": "publisher reserves it"}}
    root_dir = tmp_path / "state"
    for manifest in (earlier, current):
        (root_dir / "generations" / digest(manifest)).mkdir(parents=True)
        (root_dir / "generations" / digest(manifest) / "manifest.json").write_text(json.dumps(manifest))
    (root_dir / "integrity").mkdir()

    def judged():
        state = State(root_dir / "integrity")
        try:
            return check_generations(state, root_dir)
        finally:
            state.close()

    assert judged() == {digest(earlier): True, digest(current): True}
    stripped = {key: value for key, value in current.items() if key != "rights_exclusions"}
    (root_dir / "generations" / digest(current) / "manifest.json").write_text(json.dumps(stripped))
    assert judged()[digest(current)] is False


def test_maintenance_cycles_start_a_period_apart_across_restarts(tmp_path, monkeypatch):
    """`run --repeat-after` spaces cycle starts, and a restarted process keeps the schedule a
    completed cycle set rather than starting a fresh pass on every launch."""
    from tools import integrity as tool
    clock = {"now": 1_000_000.0}
    started, sleeps = [], []

    class Stop(Exception):
        pass

    def cycle(*args, **kwargs):
        started.append(clock["now"])
        clock["now"] += 3600  # one cycle's scrub takes an hour
        return {}

    def sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) == 2:
            raise Stop
        clock["now"] += seconds

    monkeypatch.setattr(tool, "scrub", cycle)
    monkeypatch.setattr(tool, "mend_all", lambda *args, **kwargs: {})
    monkeypatch.setattr(tool.time, "time", lambda: clock["now"])
    monkeypatch.setattr(tool.time, "sleep", sleep)
    (tmp_path / "integrity").mkdir()
    argv = ["--data", str(tmp_path), "run", "--no-network", "--repeat-after", "86400"]
    with pytest.raises(Stop):
        tool.main(argv)
    assert started == [1_000_000.0, 1_086_400.0] and sleeps[0] == 86400 - 3600

    # A restart two hours after the last cycle began waits out the rest of the period.
    started.clear(), sleeps.clear()
    clock["now"] = 1_086_400.0 + 7200
    with pytest.raises(Stop):
        tool.main(argv)
    assert sleeps[0] == 86400 - 7200 and started == [1_172_800.0]
