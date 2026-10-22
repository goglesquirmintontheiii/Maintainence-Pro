"""Running other modules' hooks safely (0.4.0 review #6).

Modules register hooks into each other's lists (work-order status and create hooks, meter reading hooks, asset
status hooks). A broken hook must not undo the user's own change, so each one runs in its own savepoint: if it
raises, its writes are rolled back, the error is logged, and the remaining hooks still run.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from typing import Any

from mpro.extensions import db

log = logging.getLogger(__name__)


def run_hooks(
    hooks: Iterable[Callable[..., Any]], *args: Any, what: str = "hook", reraise: tuple[type[BaseException], ...] = ()
) -> None:
    """Call each hook with `args` inside a savepoint. Exceptions in `reraise` (e.g. validation errors that should
    reach the user) still propagate after the savepoint is rolled back; anything else is logged and skipped."""
    for hook in list(hooks):
        try:
            with db.session.begin_nested():
                hook(*args)
        except reraise:
            raise
        except Exception:
            log.exception("%s %s failed; skipped", what, getattr(hook, "__qualname__", repr(hook)))
