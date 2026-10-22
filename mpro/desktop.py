"""Test-build launcher (Windows .exe / Linux .AppImage).

Starts MPro on this computer with a local SQLite database, loads demo data on first run,
runs background jobs in-process and opens the browser. For testing, not production.

Linux desktops start an AppImage without a terminal when you double-click it. Then nobody can see the
address or stop the server, and a browser started from inside the bundle can fail to open because it
inherits the bundle's libraries. So, when there's no terminal, the launcher re-opens itself in the
desktop's terminal app (Konsole, GNOME Terminal, …) and always starts the browser with a clean
environment. If MPro is already running for this data folder, it just opens the browser again.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path
from urllib.request import urlopen

from platformdirs import user_data_dir

from mpro import __version__

BANNER = r"""
  __  __ ____
 |  \/  |  _ \   Maintenance Pro {version}  (test build)
 | |\/| | |_) |  Data folder: {data}
 | |  | |  __/   Open: {url}
 |_|  |_|_|      Sign in: {email} / {password}

 Keep this window open while you use MPro. Press Ctrl+C (or close the window) to stop.
 Source-available software: no redistribution or commercial use. See LICENSE.
"""

# Terminal apps to try, in order, and how each takes a command to run.
TERMINALS: list[tuple[str, list[str]]] = [
    ("konsole", ["--hold", "-e"]),
    ("gnome-terminal", ["--"]),
    ("kgx", ["--"]),
    ("xfce4-terminal", ["--hold", "-x"]),
    ("mate-terminal", ["-x"]),
    ("lxterminal", ["-e"]),
    ("tilix", ["-e"]),
    ("kitty", ["--hold"]),
    ("alacritty", ["--hold", "-e"]),
    ("wezterm", ["start", "--"]),
    ("foot", ["--hold"]),
    ("x-terminal-emulator", ["-e"]),
    ("xterm", ["-hold", "-e"]),
]


def clean_env() -> dict[str, str]:
    """The environment without the bundle's library paths, for programs we start (browser, terminal)."""
    env = dict(os.environ)
    for var in (
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "PYTHONPATH",
        "PYTHONHOME",
        "QT_PLUGIN_PATH",
        "GTK_PATH",
        "GDK_PIXBUF_MODULE_FILE",
    ):
        orig = env.pop(var + "_ORIG", None)  # PyInstaller keeps the original value here
        if orig:
            env[var] = orig
        elif var in env and getattr(sys, "frozen", False):
            env.pop(var)
    return env


def launch_browser(url: str) -> bool:
    """Open the default browser outside the bundle's environment."""
    if sys.platform.startswith("linux"):
        for cmd in (["xdg-open", url], ["gio", "open", url], ["kde-open", url], ["kde-open5", url]):
            if shutil.which(cmd[0]):
                try:
                    subprocess.Popen(
                        cmd, env=clean_env(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL, start_new_session=True,
                    )  # fmt: skip
                    return True
                except OSError:
                    continue
    try:
        return webbrowser.open(url)
    except Exception:  # pragma: no cover - no browser at all
        return False


def _notify(title: str, body: str) -> None:
    if sys.platform.startswith("linux") and shutil.which("notify-send"):
        with contextlib.suppress(OSError):
            subprocess.Popen(
                ["notify-send", "-a", "Maintenance Pro", title, body],
                env=clean_env(),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )


def _has_terminal() -> bool:
    try:
        return sys.stdin.isatty() or sys.stdout.isatty()
    except (AttributeError, ValueError):
        return False


def relaunch_in_terminal(argv: list[str]) -> bool:
    """Linux: started by double-click (no terminal)? Open ourselves in the desktop's terminal app."""
    if not sys.platform.startswith("linux") or _has_terminal() or os.environ.get("MPRO_IN_TERMINAL"):
        return False
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return False
    me = os.environ.get("APPIMAGE") or sys.executable
    cmd = (
        [me, *argv]
        if os.environ.get("APPIMAGE") or getattr(sys, "frozen", False)
        else [sys.executable, "-m", "mpro", "desktop", *argv]
    )
    env = clean_env()
    env["MPRO_IN_TERMINAL"] = "1"
    preferred = os.environ.get("TERMINAL")
    order = ([(preferred, ["-e"])] if preferred else []) + TERMINALS
    for name, flags in order:
        path = shutil.which(name)
        if not path:
            continue
        try:
            proc = subprocess.Popen([path, *flags, *cmd], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, start_new_session=True)  # fmt: skip
        except OSError:
            continue
        time.sleep(1.5)
        if proc.poll() not in (None, 0):  # the terminal refused these flags: try the next one
            continue
        return True
    return False


def _instance_file(data_dir: Path) -> Path:
    return data_dir / "running.json"


def _running_url(data_dir: Path) -> str | None:
    """The address of an MPro already running on this data folder, if it answers."""
    try:
        url = json.loads(_instance_file(data_dir).read_text(encoding="utf-8"))["url"]
        with urlopen(url + "/healthz", timeout=1.5) as r:
            return str(url) if r.status == 200 else None
    except (OSError, ValueError, KeyError):
        return None


def _free_port(preferred: int) -> int:
    for port in ([preferred] if preferred else []) + [8080, 8081, 8090, 0]:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return int(s.getsockname()[1])
            except OSError:
                continue
    raise RuntimeError("No free port found")


def run_desktop(port: int = 0, open_browser: bool = True, argv: list[str] | None = None) -> int:
    data_dir = Path(os.environ.get("MPRO_DATA_DIR") or user_data_dir("MaintenancePro-Test", "MPro"))
    data_dir.mkdir(parents=True, exist_ok=True)
    running = _running_url(data_dir)
    if running:  # double-clicked again: show the one that's already running
        launch_browser(running)
        print(f"Maintenance Pro is already running at {running}", flush=True)
        return 0
    if relaunch_in_terminal(argv if argv is not None else sys.argv[1:]):
        return 0
    port = _free_port(port)
    url = f"http://127.0.0.1:{port}"
    os.environ.setdefault("MPRO_DATA_DIR", str(data_dir))
    os.environ.setdefault("DATABASE_URL", f"sqlite:///{(data_dir / 'mpro-test.db').as_posix()}")
    os.environ["MPRO_BASE_URL"] = url
    os.environ["MPRO_TEST_BUILD"] = "1"
    handlers: list[logging.Handler] = [logging.FileHandler(data_dir / "mpro.log", encoding="utf-8")]
    if sys.stdout is not None:
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)
    logging.getLogger("waitress.queue").setLevel(logging.ERROR)

    from waitress import create_server

    from mpro.app import create_app
    from mpro.cli import upgrade_db
    from mpro.core.jobs import start_background_worker
    from mpro.demo import DEMO_EMAIL, DEMO_PASSWORD, seed_demo

    app = create_app({"MPRO_DEMO_LOGIN": {"email": DEMO_EMAIL, "password": DEMO_PASSWORD}})
    upgrade_db(app)
    with app.app_context():
        seed_demo()
    stop = start_background_worker(app)
    server = create_server(app, host="127.0.0.1", port=port, threads=8)
    with contextlib.suppress(OSError):
        _instance_file(data_dir).write_text(json.dumps({"url": url, "pid": os.getpid()}), encoding="utf-8")
    banner = BANNER.format(version=__version__, data=data_dir, url=url, email=DEMO_EMAIL, password=DEMO_PASSWORD)
    if sys.stdout is not None:
        print(banner, flush=True)
    if not _has_terminal() and not os.environ.get("MPRO_IN_TERMINAL"):
        _notify(
            "Maintenance Pro is running", f"Open {url} — sign in as {DEMO_EMAIL}. It keeps running in the background."
        )
    if open_browser:

        def _open() -> None:
            time.sleep(1.2)
            if not launch_browser(url):
                logging.warning("Couldn't open a browser. Open %s yourself.", url)

        threading.Thread(target=_open, daemon=True).start()

    def _stop(*_: object) -> None:
        raise KeyboardInterrupt

    for sig in ("SIGTERM", "SIGHUP"):  # closing the terminal window or logging out stops MPro cleanly
        if hasattr(signal, sig):
            with contextlib.suppress(ValueError, OSError):
                signal.signal(getattr(signal, sig), _stop)
    try:
        server.run()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        with contextlib.suppress(OSError):
            _instance_file(data_dir).unlink()
        if sys.stdout is not None:
            print("Maintenance Pro stopped.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(run_desktop())
