"""Print GitHub release notes for a version, built from its progress file.

Usage: python scripts/release_notes.py 0.1.0 owner/repo
Uses progress.md if it is for that version, else progress_history/progress_<version>.md.
Relative screenshot links become absolute so they render on the release page.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


def main() -> int:
    version, repo = sys.argv[1], sys.argv[2]
    root = Path(__file__).resolve().parent.parent
    candidates = [root / "progress.md", root / "progress_history" / f"progress_{version}.md"]
    text = ""
    for c in candidates:
        if c.exists() and re.search(rf"^# .*\b{re.escape(version)}\b", c.read_text(encoding="utf-8"), re.M):
            text = c.read_text(encoding="utf-8")
            break
    if not text:
        print(f"Maintenance Pro {version}")
        return 0
    raw = f"https://raw.githubusercontent.com/{repo}/v{version}/"
    text = re.sub(r"\]\((?!https?://)(docs/[^)]+)\)", lambda m: f"]({raw}{m.group(1)})", text)
    downloads = (
        "## Test builds\n\n"
        f"- **Windows:** `MaintenancePro-{version}-windows-x64.exe` (double-click; Windows may ask you to confirm "
        "because the file isn't code-signed yet).\n"
        f"- **Linux:** `MaintenancePro-{version}-x86_64.AppImage` (`chmod +x` it, then run it).\n\n"
        "Both start a local server with a SQLite database and demo data, then open your browser. "
        "Sign in with `admin@example.com` / `mpro-demo-123`. They're for testing, not production; "
        "use Docker or `./start.sh` for a real install.\n\n"
    )
    first_h2 = text.find("\n## ")
    print(
        text[:first_h2].rstrip() + "\n\n" + downloads + text[first_h2 + 1 :]
        if first_h2 > 0
        else text + "\n\n" + downloads
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
