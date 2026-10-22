"""Test-build launcher: browser and terminal start outside the bundle's environment (0.3.1 AppImage fix)."""

from __future__ import annotations

import sys
from typing import Any

from mpro import desktop


def test_clean_env_restores_original_library_path(monkeypatch: Any) -> None:
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setenv("LD_LIBRARY_PATH", "/tmp/_MEI123")
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/usr/lib/custom")
    monkeypatch.setenv("QT_PLUGIN_PATH", "/tmp/_MEI123/qt")
    env = desktop.clean_env()
    assert env["LD_LIBRARY_PATH"] == "/usr/lib/custom"
    assert "QT_PLUGIN_PATH" not in env
    assert "LD_LIBRARY_PATH_ORIG" not in env


def test_relaunch_only_without_a_terminal(monkeypatch: Any, tmp_path: Any) -> None:
    calls: list[list[str]] = []

    class P:
        def __init__(self, cmd: list[str], **_: Any) -> None:
            calls.append(cmd)

        def poll(self) -> None:
            return None

    term = tmp_path / "konsole"
    term.write_text("#!/bin/sh\n")
    term.chmod(0o755)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(desktop.subprocess, "Popen", P)
    monkeypatch.setattr(desktop.time, "sleep", lambda _s: None)
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setenv("DISPLAY", ":0")
    monkeypatch.setenv("APPIMAGE", "/home/me/MaintenancePro.AppImage")
    monkeypatch.delenv("MPRO_IN_TERMINAL", raising=False)
    monkeypatch.setattr(desktop, "_has_terminal", lambda: True)
    assert desktop.relaunch_in_terminal([]) is False  # run from a terminal: stay put
    monkeypatch.setattr(desktop, "_has_terminal", lambda: False)
    assert desktop.relaunch_in_terminal(["--port=9000"]) is True
    assert calls[0][1:] == ["--hold", "-e", "/home/me/MaintenancePro.AppImage", "--port=9000"]
    monkeypatch.setenv("MPRO_IN_TERMINAL", "1")
    assert desktop.relaunch_in_terminal([]) is False  # never loops


def test_second_launch_reuses_running_instance(monkeypatch: Any, tmp_path: Any) -> None:
    opened: list[str] = []
    monkeypatch.setenv("MPRO_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(desktop, "_running_url", lambda _d: "http://127.0.0.1:8080")
    monkeypatch.setattr(desktop, "launch_browser", lambda u: opened.append(u) or True)
    assert desktop.run_desktop() == 0
    assert opened == ["http://127.0.0.1:8080"]
