"""Corpus integrity: detect damage to installed archives, localise it to documents, and mend it.

Each admitted artifact is split into fixed leaves whose hashes form an RFC 6962 Merkle
tree; the leaf lists and roots are committed to the repository as the trust root
(`deploy/integrity/`). A rate-limited scrub re-reads every leaf from the medium offline.
A leaf that fails is mapped through a structure map captured at admission to the
documents it holds; those documents leave service individually while the rest of the
library keeps serving; and the leaf is mended by writing back bytes that verify
against the manifest, from local parity, upstream mirrors or release parts. Every
source is untrusted: only the manifest decides what is correct.
"""
