"""The two disk reservations a native build takes, and the flags naming them."""
import asyncio
import importlib.util
from pathlib import Path

import pytest

from oracle_content.native import build_native

TOOL = Path(__file__).resolve().parents[1] / "tools" / "prepare_native.py"


def tool():
    spec = importlib.util.spec_from_file_location("prepare_native_tool", TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def argv(*extra):
    """A complete invocation; every path is inspected only after argument parsing."""
    return ["--profile", "profile.json", "--data", "state", "--archive", "archive.zim",
            "--sha256", "a" * 64, "--pack-id", "pack", "--title", "Title",
            "--source-base-url", "https://example.invalid/", "--license", "CC0",
            "--selection-policy", "canonical-html", "--inspection", "inspection.json",
            "--index-storage", "index", "--embed-url", "http://embed.invalid",
            "--qdrant-url", "http://qdrant.invalid", *extra]


def run(monkeypatch, *extra):
    module = tool()
    monkeypatch.setattr("sys.argv", ["prepare_native.py", *argv(*extra)])
    with pytest.raises(SystemExit) as exit:
        asyncio.run(module.main())
    return exit.value


def test_the_superseded_single_reservation_flag_is_refused_by_name(monkeypatch, capsys):
    status = run(monkeypatch, "--reserve-bytes", "27917287424",
                 "--content-state-reserve-bytes", "1", "--index-storage-reserve-bytes", "1")
    assert status.code == 2
    message = capsys.readouterr().err
    assert "--content-state-reserve-bytes" in message and "--index-storage-reserve-bytes" in message


@pytest.mark.parametrize("supplied,missing", [
    (["--index-storage-reserve-bytes", "1"], "--content-state-reserve-bytes"),
    (["--content-state-reserve-bytes", "1"], "--index-storage-reserve-bytes"),
])
def test_each_reservation_is_required_on_its_own(monkeypatch, capsys, supplied, missing):
    assert run(monkeypatch, *supplied).code == 2
    assert missing in capsys.readouterr().err


def test_a_build_without_a_positive_content_state_reservation_is_refused():
    with pytest.raises(ValueError, match="content-state reservation"):
        asyncio.run(build_native(None, None, None, None, Path("tokenizer.json"),
            selection_policy="canonical-html", inspection="{}", content_state_reserve_bytes=0))
