"""Temporary features must not outlive their deadline.

The Ctrl+Shift+F feedback capture (frontend/src/devtools/feedback/, added in 0.4.2) is a testing aid for the release
checklist. It goes by REMOVE_BY: 1.9.0, which may be pushed to 2.0.0 but no later. Removal steps are in its README.
"""

from pathlib import Path

from mpro import __version__

ROOT = Path(__file__).resolve().parent.parent
FEEDBACK = ROOT / "frontend" / "src" / "devtools" / "feedback"
REMOVE_BY = "1.9.0"
LATEST = "2.0.0"


def _v(s: str) -> tuple[int, ...]:
    return tuple(int(p) for p in s.split("+")[0].split("-")[0].split("."))


def test_feedback_capture_deadline_is_at_most_2_0_0() -> None:
    assert _v(REMOVE_BY) <= _v(LATEST), "The feedback capture can't be kept past 2.0.0."


def test_feedback_capture_removed_by_deadline() -> None:
    if _v(__version__) >= _v(REMOVE_BY):
        assert not FEEDBACK.exists(), (
            f"MPro {__version__} still ships the temporary feedback capture (due by {REMOVE_BY}). "
            "Remove it: see frontend/src/devtools/feedback/README.md."
        )


def test_feedback_capture_is_isolated() -> None:
    """Only main.tsx may import it, so deleting the folder and one line removes it."""
    if not FEEDBACK.exists():
        return
    src = ROOT / "frontend" / "src"
    users = []
    for p in src.rglob("*.ts*"):
        text = p.read_text(encoding="utf-8")
        if FEEDBACK not in p.parents and ("devtools/feedback" in text or "html-to-image" in text):
            users.append(p.relative_to(src).as_posix())
    assert users == ["main.tsx"], users
