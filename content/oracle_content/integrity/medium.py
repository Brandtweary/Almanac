"""Reading leaves from the storage medium itself, and the one confined write a mend makes.

Every verification read bypasses the page cache with O_DIRECT. A read through the
cache verifies RAM rather than the disk, so a cached scrub would report healthy bytes
that are damaged on the medium until eviction, and it would evict the search working
set on the way. A filesystem that refuses O_DIRECT is refused in turn: falling back to
a buffered read would produce verdicts about memory labelled as verdicts about disk.

Direct I/O needs an aligned buffer, offset and length. Leaves start on multiples of the
leaf size, which is itself a multiple of the alignment, and a short last leaf is read
at an aligned length and trimmed to the artifact's end.
"""
from __future__ import annotations

import errno
import mmap
import os
import time

from .tree import ALIGNMENT, leaf_span

WRITE_CHUNK = 1024 * 1024
# Bytes per second for a read that starts on its own, beside a serving search index,
# with no operator present to choose a cap: the scrub's recommended rate.
DEFAULT_READ_RATE = 4_000_000


class DirectIOUnsupported(OSError):
    """The filesystem holding an artifact cannot be read around the page cache."""


def _step(name: str) -> None:
    """A labelled point inside the mend transaction; crash-injection tests replace it."""


class Medium:
    """Direct leaf reads and the in-place leaf write, on real files.

    Tests substitute a subclass to inject a read that lies once, a medium that drops
    writes, or a crash between two labelled steps; the transaction logic never learns
    which it is talking to.
    """

    def open_direct(self, path) -> int:
        try:
            return os.open(path, os.O_RDONLY | os.O_DIRECT | os.O_CLOEXEC)
        except OSError as error:
            if error.errno == errno.EINVAL:
                raise DirectIOUnsupported(error.errno, "The filesystem refuses O_DIRECT; a page-cache "
                                          "read would verify memory rather than the medium", str(path)) from None
            raise

    def read_span(self, descriptor: int, start: int, stop: int) -> bytes:
        """Bytes `[start, stop)` read around the page cache; `start` must be aligned."""
        if start % ALIGNMENT:
            raise ValueError("A direct read must start on an aligned offset")
        length = stop - start
        aligned = -(-length // ALIGNMENT) * ALIGNMENT
        buffer = mmap.mmap(-1, aligned)
        try:
            got = 0
            while got < length:
                view = memoryview(buffer)[got:]
                try:
                    count = os.preadv(descriptor, [view], start + got)
                finally:
                    view.release()
                if count <= 0:
                    break
                got += count
                # A short direct read is only legitimate at end of file, where the
                # kernel returns fewer bytes than the aligned request.
                if got % ALIGNMENT:
                    break
            if got < length:
                raise EOFError(f"Medium returned {got} of {length} bytes at offset {start}")
            return bytes(buffer[:length])
        except OSError as error:
            if error.errno == errno.EINVAL:
                raise DirectIOUnsupported(error.errno, "The filesystem refused an aligned direct read") from None
            raise
        finally:
            buffer.close()

    def read_leaf(self, descriptor: int, index: int, size: int, leaf_bytes: int) -> bytes:
        start, stop = leaf_span(index, size, leaf_bytes)
        return self.read_span(descriptor, start, stop)

    def read_leaf_fresh(self, path, index: int, size: int, leaf_bytes: int) -> bytes:
        """One independent direct read of a leaf through a descriptor opened for it alone."""
        descriptor = self.open_direct(path)
        try:
            return self.read_leaf(descriptor, index, size, leaf_bytes)
        finally:
            os.close(descriptor)

    def write_leaf(self, path, offset: int, payload: bytes) -> None:
        """Write one leaf in place and make it durable.

        Opened without O_TRUNC or O_APPEND, so no byte outside `[offset, offset + len)`
        can change. The write goes in chunks so an interruption lands between two of
        them, which is the torn write crash recovery has to converge from.
        """
        descriptor = os.open(path, os.O_RDWR | os.O_CLOEXEC)
        try:
            written = 0
            while written < len(payload):
                count = os.pwrite(descriptor, payload[written:written + WRITE_CHUNK], offset + written)
                if count <= 0:
                    raise OSError(errno.EIO, "A leaf write made no progress", str(path))
                written += count
                if written < len(payload):
                    _step("mid_write")
            _step("before_fdatasync")
            os.fdatasync(descriptor)
        finally:
            os.close(descriptor)


class Throttled:
    """A medium whose every read is charged to a rate limit.

    Scrub and admission charge their own sequential reads; this wraps the medium for
    the reads made on their behalf elsewhere, the structure pass and a mend's parity
    reconstruction, so no path reads the served disk outside the cap the operator set.
    """

    def __init__(self, medium, rate):
        self.medium, self.rate = medium, rate

    def open_direct(self, path) -> int:
        return self.medium.open_direct(path)

    def read_span(self, descriptor: int, start: int, stop: int) -> bytes:
        data = self.medium.read_span(descriptor, start, stop)
        self.rate.consume(len(data))
        return data

    def read_leaf(self, descriptor: int, index: int, size: int, leaf_bytes: int) -> bytes:
        data = self.medium.read_leaf(descriptor, index, size, leaf_bytes)
        self.rate.consume(len(data))
        return data

    def read_leaf_fresh(self, path, index: int, size: int, leaf_bytes: int) -> bytes:
        data = self.medium.read_leaf_fresh(path, index, size, leaf_bytes)
        self.rate.consume(len(data))
        return data

    def write_leaf(self, path, offset: int, payload: bytes) -> None:
        self.medium.write_leaf(path, offset, payload)


class RateLimit:
    """Hold a long read to an average byte rate so it never saturates the served disk."""

    def __init__(self, bytes_per_second: float | None, clock=time.monotonic, sleep=time.sleep):
        if bytes_per_second is not None and bytes_per_second <= 0:
            raise ValueError("A read rate must be positive")
        self.rate, self.clock, self.sleep = bytes_per_second, clock, sleep
        self.started, self.consumed = None, 0

    def consume(self, count: int) -> None:
        if self.rate is None:
            return
        now = self.clock()
        if self.started is None:
            self.started = now
        self.consumed += count
        ahead = self.consumed / self.rate - (now - self.started)
        if ahead > 0:
            self.sleep(ahead)
