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


# ---- MP-134: choose the address and port at startup ---------------------------------------------
def _answers(*replies: str) -> Any:
    it = iter(replies)
    asked: list[str] = []

    def ask(q: str) -> str:
        asked.append(q)
        return next(it)

    ask.asked = asked  # type: ignore[attr-defined]
    return ask


def _busy_port() -> Any:
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    s.listen(1)
    return s


def test_terminal_prompt_defaults_and_remembers(monkeypatch: Any, tmp_path: Any) -> None:
    monkeypatch.delenv("MPRO_HOST", raising=False)
    monkeypatch.delenv("MPRO_PORT", raising=False)
    said: list[str] = []
    free = desktop.next_free_port("127.0.0.1", 20000)
    ask = _answers("", str(free))  # Enter keeps 127.0.0.1
    assert desktop.choose_address(tmp_path, interactive=True, ask=ask, say=said.append) == ("127.0.0.1", free)
    assert ask.asked[0] == "  Address [127.0.0.1]: " and ask.asked[1] == "  Port [8080]: "
    # next time the last answer is the default
    ask = _answers("", "")
    assert desktop.choose_address(tmp_path, interactive=True, ask=ask, say=said.append) == ("127.0.0.1", free)
    assert ask.asked[1] == f"  Port [{free}]: "
    # bad answers are explained and asked again
    ask = _answers("not a host!", "localhost", "99999", str(free))
    assert desktop.choose_address(tmp_path, interactive=True, ask=ask, say=said.append) == ("localhost", free)
    assert any("IP address" in s for s in said) and any("1 to 65535" in s for s in said)


def test_taken_port_offers_the_next_free_one(monkeypatch: Any, tmp_path: Any) -> None:
    monkeypatch.delenv("MPRO_HOST", raising=False)
    monkeypatch.delenv("MPRO_PORT", raising=False)
    busy = _busy_port()
    try:
        taken = busy.getsockname()[1]
        said: list[str] = []
        ask = _answers("", str(taken), "")  # Enter accepts the offer
        host, port = desktop.choose_address(tmp_path, interactive=True, ask=ask, say=said.append)
        assert host == "127.0.0.1" and port != taken and port > taken
        assert f"Port {taken} is already in use. Use {port} instead?" in ask.asked[2]
        # without a terminal it moves on by itself and never asks
        said.clear()
        never = _answers()
        host, port = desktop.choose_address(tmp_path, port=taken, interactive=False, ask=never, say=said.append)
        assert port != taken and never.asked == [] and "already in use" in said[0]
    finally:
        busy.close()


def test_no_terminal_or_given_values_never_ask(monkeypatch: Any, tmp_path: Any) -> None:
    never = _answers()
    monkeypatch.delenv("MPRO_HOST", raising=False)
    monkeypatch.setenv("MPRO_PORT", str(desktop.next_free_port("127.0.0.1", 21000)))
    h, p = desktop.choose_address(tmp_path, interactive=True, ask=never, say=lambda _s: None)
    assert never.asked == [] and h == "127.0.0.1" and p >= 21001
    monkeypatch.delenv("MPRO_PORT")
    port = desktop.next_free_port("127.0.0.1", 22000)
    assert desktop.choose_address(tmp_path, port=port, interactive=True, ask=never, say=lambda _s: None)[1] == port
    assert never.asked == []
    assert not (tmp_path / "server.json").exists()  # only answers typed in are remembered


def test_everywhere_warning_and_browser_address(monkeypatch: Any, tmp_path: Any) -> None:
    monkeypatch.delenv("MPRO_HOST", raising=False)
    monkeypatch.delenv("MPRO_PORT", raising=False)
    said: list[str] = []
    free = desktop.next_free_port("0.0.0.0", 23000)
    assert desktop.choose_address(tmp_path, interactive=True, ask=_answers("0.0.0.0", str(free)), say=said.append) == (
        "0.0.0.0",
        free,
    )
    assert any("other computers and phones" in s for s in said)
    assert desktop.browse_url("0.0.0.0", 8080) == "http://127.0.0.1:8080"
    assert desktop.browse_url("::", 8080) == "http://[::1]:8080"
    assert desktop.browse_url("192.168.1.5", 9000) == "http://192.168.1.5:9000"


def test_eof_on_stdin_keeps_defaults(monkeypatch: Any, tmp_path: Any) -> None:
    monkeypatch.delenv("MPRO_HOST", raising=False)
    monkeypatch.delenv("MPRO_PORT", raising=False)

    def eof(_q: str) -> str:
        raise EOFError

    port = desktop.next_free_port("127.0.0.1", 24000)
    (tmp_path / "server.json").write_text(f'{{"port": {port}}}')
    assert desktop.choose_address(tmp_path, interactive=True, ask=eof, say=lambda _s: None) == ("127.0.0.1", port)


def test_serve_reads_host_and_port(monkeypatch: Any, tmp_path: Any) -> None:
    from mpro import cli

    monkeypatch.setenv("MPRO_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("MPRO_HOST", raising=False)
    monkeypatch.delenv("MPRO_PORT", raising=False)
    (tmp_path / "server.json").write_text('{"host": "127.0.0.1", "port": 8123}')
    seen: dict[str, Any] = {}
    import waitress

    monkeypatch.setattr(waitress, "serve", lambda app, host, port, threads: seen.update(host=host, port=port))
    monkeypatch.setattr(cli, "upgrade_db", lambda app: None)
    assert cli.main(["serve", "--no-worker"]) == 0
    assert seen == {"host": "127.0.0.1", "port": 8123}
    assert cli.main(["serve", "--no-worker", "--host", "0.0.0.0", "--port", "9001"]) == 0
    assert seen == {"host": "0.0.0.0", "port": 9001}
    monkeypatch.setenv("MPRO_PORT", "9002")
    assert cli.main(["serve", "--no-worker"]) == 0
    assert seen["port"] == 9002
    assert cli.main(["serve", "--no-worker", "--host", "bad host!"]) == 2
