"""Extension points other modules register into (each hook runs in its own savepoint via mpro.core.hooks.run_hooks).

LOW_STOCK_HOOKS: fn(org_id, part, stock) when a part at a location drops below its minimum
    (purchasing suggests a PO; suppliers offer Reorder with the preferred listing)
STOCK_CHANGED_HOOKS: fn(org_id, txn) after every ledger row
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

LOW_STOCK_HOOKS: list[Callable[..., Any]] = []
STOCK_CHANGED_HOOKS: list[Callable[..., Any]] = []
