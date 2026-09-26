# Corpus integrity

Installed archives are the only copy of the library most installations have, so the
content service detects damage to their bytes, names the documents it costs, keeps
serving everything else, and repairs the damage with bytes that verify against a
committed manifest. The mechanism is in `oracle_content/integrity/`; the operator tool is
`tools/integrity.py`.

## The manifest

`deploy/integrity/corpus.json` and `deploy/integrity/leaves/<sha256>.leaves` are the trust
root. Each admitted artifact is split into 4 MiB leaves, leaf *i* covering bytes
`[i·L, min((i+1)·L, size))`, aligned with the Kiwix metalink and torrent pieces. A leaf
hashes as `SHA-256(0x00 ‖ bytes)`; leaves combine into an RFC 6962 tree with interior
nodes `SHA-256(0x01 ‖ left ‖ right)`; the artifact root sits in its record beside the
artifact's SHA-256, and the corpus root is an RFC 6962 tree over the records sorted by
SHA-256, each hashed as `SHA-256(0x02 ‖ sha256 ‖ u64be(size) ‖ u32be(leaf_bytes) ‖ root)`.
A `.leaves` file is the raw concatenation of 32-byte leaf hashes.

For an upstream archive the leaf list is the publisher's own integrity data at finer
grain: admission accepts it only when the whole file matches the published SHA-256 and
every leaf matches the published SHA-1 piece, so anyone can reproduce it from the
publisher's file. An entry never changes once committed; only its `sources` (where
replacement bytes may be fetched) may. The manifest is checked before it is trusted:
every artifact root is recomputed from its leaf file and the corpus root from the
records, and a manifest that does not reproduce is reported and never acts on data.

## Operation

Every command takes `--data`, the content state directory, and reads the manifest from
the source tree unless `--manifest-dir` names another.

```sh
PYTHONPATH=. python tools/integrity.py --data "$CONTENT_STATE_DIR" admit --sha256 <sha256> \
    --pack ../deploy/packs/<pack>.json --parity-dir /other/disk/parity --rate 50000000
PYTHONPATH=. python tools/integrity.py --data "$CONTENT_STATE_DIR" --manifest-dir ../deploy/integrity \
    publish --sha256 <sha256>
PYTHONPATH=. python tools/integrity.py --data "$CONTENT_STATE_DIR" run --rate 4000000 --repeat-after 604800
PYTHONPATH=. python tools/integrity.py --data "$CONTENT_STATE_DIR" report
```

- `admit` reads the original once, directly from the medium, computing the whole-file
  SHA-256, every leaf hash, the upstream SHA-1 cross-check where the pack has a metalink,
  the parity and the structure map. It writes nothing unless the pinned identity
  reproduces. A derived archive takes `--kind derived --pack-path <path>` and a byte
  source: `--source-url` when one host serves the whole file, or, for a file over the
  2 GiB release-asset limit, `--release-part <url>` once per part in order. Parts are the
  file cut every `--leaves-per-part` leaves (511 by default, so `split --bytes=2143289344`
  at 4 MiB leaves). The result is a candidate under `integrity/candidates/`; `publish`
  merges it into the committed manifest, refusing to alter an entry already there except
  its sources, which `publish --release-part` replaces.
- `scrub` re-reads every leaf with O_DIRECT, offline, under `--rate` bytes per second, and
  resumes where it stopped. `--budget` bounds the leaves one call reads; each call takes up
  the artifact in progress, then the one scrubbed longest ago. A first mismatch makes a leaf `suspect`; a second
  independent read decides `damaged` or `transient`. Artifact sizes, the manifest, the
  structure maps, the parity files and each generation manifest's identity are checked
  in the same pass.
- `mend` recovers any interrupted repair, then repairs damaged leaves. Candidates come
  from local parity, then the upstream mirrors by exact range, then release parts, and
  one is written only if it hashes to the manifest's leaf. The write is journalled,
  confined to the one leaf, read back directly and verified. A medium that does not
  hold the write leaves the leaf `write_failed` for a person, never retried. Its reads
  are held to `--rate`, and a leaf no source could repair is retried after an hour,
  the delay doubling with each failed attempt up to a day, since an attempt from parity
  reads the leaf's whole group. `--no-artifact-writes` keeps verified candidates under
  `integrity/held/`, fetched once, and writes nothing; `--no-network` mends from parity
  alone.
- `run` is one cycle of scrub, mend and probe. With `--repeat-after`, cycle starts are that
  many seconds apart, counted from the start of the last completed cycle recorded in local
  state, so a supervisor restarting the command keeps the schedule and an interrupted cycle
  resumes at once.
- `probe` checks each byte source by size and strong validator, and reads the upstream
  listing an upstream archive's record names to report a newer edition, and whether the
  installed edition is still listed. Neither acts on the result.
- `validate-dense` scrolls each complete native generation's vector points against the
  count and checksum in its manifest; a failure withdraws dense search for that archive.
- `admit-spans` records a completed `article-spans.sqlite` for scrubbing; a completed
  precompute run does this itself at 4 MB/s, or at `tools/precompute_passages.py
  --integrity-rate`. Damaged spans are withdrawn, moved aside for
  inspection and rebuilt with `tools/precompute_passages.py`; the query path answers
  meanwhile.

Parity is interleaved XOR at one parity leaf per group of 128 by default, about 0.8% of
the originals, and best kept on a different disk. It repairs any single damaged leaf
per group, including any contiguous run of damage up to the group stride, with no
network. It is redundancy, not a copy: it cannot restore an archive whose disk is lost.

Local state lives in `integrity/` under the content state: `state.sqlite` (leaf verdicts,
passes, events, probes, reader epochs), `structure/` maps, `derived/` spans leaf lists,
`upstream/` piece tables, `journal/` and `preimages/` for repairs, and parity unless
placed elsewhere. None of it is committed.

## What the service does with damage

The service reads the integrity state as an overlay and never edits the library's
configuration. Before any text is decoded, the article's cluster is checked against the
quarantine: a document touching a damaged leaf is refused with `source_damaged` (503)
naming the archive and whether repair is pending or impossible; its hits are dropped
from searches, which carry `integrity:<pack>` in `degradation`. Damage to a search index
withdraws lexical search for that archive (`integrity:<pack>:lexical`); damage to the
tables the reader navigates by, a resized or missing file, or damage the stored map
cannot localise withdraws the archive (`integrity:<pack>:withdrawn`), which then costs
readiness nothing: the library stays ready while any archive serves. An original that is
missing or cannot be opened costs its archive the same way before any scrub has seen it,
named `archive_unavailable:<pack>`. Integrity state that cannot be read costs nothing: the
last state read stays in force, coverage carries the error in `state_error`, and a read with
no state to check against carries `integrity:<pack>:read_unverified`. Reads of a document
re-hash the leaves its text comes from once per scrub window, so damage between scrub
passes is caught on the path a person reads. A read the re-hash could not check, because
the leaf lists are absent from the manifest directory the scrub recorded or the manifest
did not verify, carries `integrity:<pack>:read_unverified`, and the coverage block's
`read_verification` names the reason.

Continuations recheck document quarantine and original receipts, and read continuations
repeat the read-verification gate; a repair epoch or index withdrawal invalidates the
cached response with `invalid_cursor`, requiring a fresh request.

A repaired leaf advances its archive's reader epoch, and a reader opened before that
refuses what the leaf touched until it is reopened, because it may hold the damaged
cluster decoded in its cache. Every coverage entry for a native archive carries an
`integrity` block; a never-scrubbed leaf counts as unverified, and an archive never
admitted says so rather than reporting healthy.
