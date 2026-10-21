"""Global search: modules register providers; one endpoint searches them all.

0.1.0 searches people and teams. Work orders, assets, parts, locations and procedures
register providers as their modules land. PostgreSQL full-text indexes come with those
larger tables; for now providers use case-insensitive matching.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from flask import g

from mpro.core.permissions import can


@dataclass
class Provider:
    type: str
    label: str
    action: str  # permission needed to see results
    fn: Callable[[str, int], list[dict[str, Any]]]


_providers: dict[str, Provider] = {}


def provider(type: str, label: str, action: str) -> Callable[[Callable[[str, int], list[dict[str, Any]]]], Any]:
    def deco(fn: Callable[[str, int], list[dict[str, Any]]]) -> Callable[[str, int], list[dict[str, Any]]]:
        _providers[type] = Provider(type, label, action, fn)
        return fn

    return deco


def search(q: str, types: list[str] | None = None, limit: int = 8) -> list[dict[str, Any]]:
    q = q.strip()
    if len(q) < 1:
        return []
    groups = []
    for p in _providers.values():
        if types and p.type not in types:
            continue
        if not can(g.membership, p.action):
            continue
        results = p.fn(q, limit)
        if results:
            groups.append({"type": p.type, "label": p.label, "results": results})
    return groups


def like(q: str) -> str:
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_").lower() + "%"
