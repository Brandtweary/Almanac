"""Precompute article spans for native generations so searches stop segmenting at query time."""
import argparse
import json
import signal
from pathlib import Path

from oracle_content.precompute import build_spans
from oracle_content.store import Store


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--generation", action="append", default=[],
                        help="Repeatable; defaults to every active native generation")
    parser.add_argument("--workers", type=int, default=1, help="Bounded article segmentation workers")
    parser.add_argument("--chunk", type=int, default=256, help="Archive entries handed to a worker at once")
    parser.add_argument("--commit", type=int, default=8192, help="Entries between durable checkpoints")
    parser.add_argument("--min-free-bytes", type=int, default=8 * 1024 ** 3,
                        help="Stop and publish rather than take the filesystem below this")
    parser.add_argument("--integrity-rate", type=float,
                        help="Bytes per second for reading a completed artifact's integrity leaves; "
                             "defaults to the integrity scrub's recommended cap")
    args = parser.parse_args()
    if not 1 <= args.workers <= 64:
        raise SystemExit("workers must be between 1 and 64")

    def interrupted(number, frame):
        """Without this a SIGTERM ends the process before the build can publish
        what it has, throwing away hours of completed articles."""
        raise KeyboardInterrupt(f"signal {number}")

    signal.signal(signal.SIGTERM, interrupted)

    store = Store(args.data)
    generations = args.generation or [value for value in store.active_generations()
                                      if store.manifest(value).get("kind") == "native-zim-article-v1"]
    results = {}
    for generation in generations:
        print("=== " + generation, flush=True)
        results[generation] = build_spans(store, generation, workers=args.workers, chunk=args.chunk,
                                          commit=args.commit, min_free_bytes=args.min_free_bytes,
                                          integrity_rate=args.integrity_rate,
                                          log=lambda line: print(line, flush=True))
    print(json.dumps(results, indent=2), flush=True)


if __name__ == "__main__":
    main()
