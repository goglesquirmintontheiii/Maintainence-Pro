"""Entry point for the one-file test builds (Windows .exe, Linux .AppImage)."""

import multiprocessing
import sys

from mpro.desktop import run_desktop

if __name__ == "__main__":
    multiprocessing.freeze_support()
    port = 0
    host = None
    browser = True
    prompt = True
    for a in sys.argv[1:]:
        if a.startswith("--port="):
            port = int(a.split("=", 1)[1])
        elif a.startswith("--host="):
            host = a.split("=", 1)[1]
        elif a == "--no-browser":
            browser = False
        elif a == "--no-prompt":
            prompt = False
    sys.exit(run_desktop(port=port, open_browser=browser, host=host, prompt=prompt))
