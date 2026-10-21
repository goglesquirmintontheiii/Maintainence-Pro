"""Test-build launcher (Windows .exe / Linux .AppImage).

Starts MPro on this computer with a local SQLite database, loads demo data on first run,
runs background jobs in-process and opens the browser. For testing, not production.
"""

from __future__ import annotations

import logging
import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

from platformdirs import user_data_dir

from mpro import __version__

BANNER = r"""
  __  __ ____
 |  \/  |  _ \   Maintenance Pro {version}  (test build)
 | |\/| | |_) |  Data folder: {data}
 | |  | |  __/   Open: {url}
 |_|  |_|_|      Sign in: {email} / {password}

 Keep this window open while you use MPro. Press Ctrl+C (or close the window) to stop.
"""


def _free_port(preferred: int) -> int:
    for port in ([preferred] if preferred else []) + [8080, 8081, 8090, 0]:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return int(s.getsockname()[1])
            except OSError:
                continue
    raise RuntimeError("No free port found")


def run_desktop(port: int = 0, open_browser: bool = True) -> int:
    data_dir = Path(os.environ.get("MPRO_DATA_DIR") or user_data_dir("MaintenancePro-Test", "MPro"))
    data_dir.mkdir(parents=True, exist_ok=True)
    port = _free_port(port)
    url = f"http://127.0.0.1:{port}"
    os.environ.setdefault("MPRO_DATA_DIR", str(data_dir))
    os.environ.setdefault("DATABASE_URL", f"sqlite:///{(data_dir / 'mpro-test.db').as_posix()}")
    os.environ["MPRO_BASE_URL"] = url
    os.environ["MPRO_TEST_BUILD"] = "1"
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.StreamHandler(sys.stdout), logging.FileHandler(data_dir / "mpro.log", encoding="utf-8")],
    )
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
    print(
        BANNER.format(version=__version__, data=data_dir, url=url, email=DEMO_EMAIL, password=DEMO_PASSWORD), flush=True
    )
    if open_browser:

        def _open() -> None:
            time.sleep(1.2)
            webbrowser.open(url)

        threading.Thread(target=_open, daemon=True).start()
    try:
        server.run()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        print("Maintenance Pro stopped.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(run_desktop())
