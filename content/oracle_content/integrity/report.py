"""The operator's account of integrity: what is verified, what is damaged, and which documents it costs."""
from __future__ import annotations

import json
from pathlib import Path

from .admit import integrity_dir
from .state import DAMAGED, MENDING, SUSPECT, UNREPAIRABLE, WRITE_FAILED, State, now_ns

ATTENTION = (SUSPECT, DAMAGED, MENDING, UNREPAIRABLE, WRITE_FAILED)
TITLES_PER_LEAF = 50


def titles(path: Path, entries):
    """Entry titles, read through libzim at report time; None where the archive cannot say."""
    try:
        from libzim.reader import Archive
        archive = Archive(str(path))
    except Exception:
        return None
    named = {}
    for entry in entries[:TITLES_PER_LEAF]:
        try:
            named[entry] = archive._get_entry_by_id(entry).title
        except Exception:
            named[entry] = None
    return named


def report(store_root: Path, *, events: int = 50) -> dict:
    directory = integrity_dir(store_root)
    if not (directory / "state.sqlite").exists():
        return {"admitted": [], "note": "no integrity state: nothing has been admitted on this installation"}
    state = State(directory)
    try:
        window = state.window_seconds()
        floor = now_ns() - window * 1_000_000_000
        artifacts = []
        for row in state.artifacts():
            counts = dict(state.db.execute("SELECT status, count(*) FROM leaf WHERE artifact=? GROUP BY status",
                                           (row["id"],)))
            fresh = state.db.execute("SELECT count(*) FROM leaf WHERE artifact=? AND status='ok' AND last_verified_ns>=?",
                                     (row["id"], floor)).fetchone()[0]
            damage = []
            for index in state.leaves_in(row["id"], ATTENTION):
                where = state.localization(row["id"], index)
                entry = {"leaf": index, "status": state.leaf(row["id"], index)["status"], "localization": where}
                navigable = where is not None and "dirents" not in where.get("structural_regions", []) \
                    and where.get("entries")
                if navigable and row["tier"] == "A":
                    entry["titles"] = titles(Path(store_root) / row["path"], where["entries"])
                damage.append(entry)
            artifacts.append({"id": row["id"], "tier": row["tier"], "status": row["status"],
                              "detail": json.loads(row["detail"]) if row["detail"] else None,
                              "leaf_count": row["leaf_count"], "verified_in_window": fresh,
                              "verified_fraction": round(fresh / row["leaf_count"], 6) if row["leaf_count"] else 0.0,
                              "statuses": counts, "last_full_pass_ns": state.last_full_pass(row["id"]),
                              "epoch": state.epoch(row["id"]), "damage": damage})
        recent = state.db.execute("SELECT ts, artifact, leaf, kind, detail FROM event ORDER BY rowid DESC LIMIT ?",
                                  (events,)).fetchall()
        return {"window_seconds": window, "manifest": state.get_meta("manifest"), "artifacts": artifacts,
                "generation_checks": [dict(zip(("generation", "kind", "ok", "checked_ns", "detail"), row)) for row in
                                      state.db.execute("SELECT * FROM generation_check ORDER BY generation, kind")],
                "probes": [dict(zip(("artifact", "source", "ok", "checked_ns", "detail"), row)) for row in
                           state.db.execute("SELECT * FROM source_probe ORDER BY artifact, source")],
                "recent_events": [{"ts": ts, "artifact": artifact, "leaf": leaf, "kind": kind,
                                   "detail": json.loads(detail) if detail else None}
                                  for ts, artifact, leaf, kind, detail in recent]}
    finally:
        state.close()
