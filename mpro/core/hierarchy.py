"""Trees for locations and assets as a closure table (roadmap r104).

`tree_paths` stores every (ancestor, descendant, depth) pair, including each node with itself at depth 0.
"Everything under Building 2" is one indexed query on both PostgreSQL and SQLite, with no recursion in
Python. Moving a subtree rewrites only the paths that cross the moved boundary.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import Index, Integer, String, Uuid, and_, delete, insert, select
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.models import IdMixin, OrgScopedMixin
from mpro.extensions import db


class TreePath(IdMixin, OrgScopedMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "tree_paths"
    __table_args__ = (
        Index("ix_tree_paths_kind_ancestor", "kind", "ancestor_id"),
        Index("ix_tree_paths_kind_descendant", "kind", "descendant_id"),
    )

    kind: Mapped[str] = mapped_column(String(20))  # "location" | "asset"
    ancestor_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    descendant_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    depth: Mapped[int] = mapped_column(Integer)


class TreeError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def add_node(org_id: uuid.UUID, kind: str, node_id: uuid.UUID, parent_id: uuid.UUID | None) -> None:
    rows: list[dict[str, Any]] = [
        {
            "id": uuid.uuid4(),
            "org_id": org_id,
            "kind": kind,
            "ancestor_id": node_id,
            "descendant_id": node_id,
            "depth": 0,
        }
    ]
    if parent_id is not None:
        for anc, depth in db.session.execute(
            select(TreePath.ancestor_id, TreePath.depth).where(
                TreePath.kind == kind, TreePath.descendant_id == parent_id
            )
        ).all():
            rows.append(
                {
                    "id": uuid.uuid4(),
                    "org_id": org_id,
                    "kind": kind,
                    "ancestor_id": anc,
                    "descendant_id": node_id,
                    "depth": depth + 1,
                }
            )
    db.session.execute(insert(TreePath), rows)


def subtree_ids(kind: str, node_id: uuid.UUID) -> Any:
    """Select of the node and all its descendants (use in `.in_(...)`)."""
    return select(TreePath.descendant_id).where(TreePath.kind == kind, TreePath.ancestor_id == node_id)


def ancestor_ids(kind: str, node_id: uuid.UUID) -> list[uuid.UUID]:
    """Root first, excluding the node itself."""
    rows = db.session.execute(
        select(TreePath.ancestor_id)
        .where(TreePath.kind == kind, TreePath.descendant_id == node_id, TreePath.depth > 0)
        .order_by(TreePath.depth.desc())
    ).all()
    return [r[0] for r in rows]


def depth_of(kind: str, node_id: uuid.UUID) -> int:
    return len(ancestor_ids(kind, node_id))


def subtree_height(kind: str, node_id: uuid.UUID) -> int:
    from sqlalchemy import func

    return int(
        db.session.scalar(
            select(func.max(TreePath.depth)).where(TreePath.kind == kind, TreePath.ancestor_id == node_id)
        )
        or 0
    )


def move_node(org_id: uuid.UUID, kind: str, node_id: uuid.UUID, new_parent_id: uuid.UUID | None) -> None:
    """Re-parent a node with its whole subtree."""
    if new_parent_id is not None and (
        new_parent_id == node_id
        or db.session.scalar(
            select(TreePath.id).where(
                TreePath.kind == kind, TreePath.ancestor_id == node_id, TreePath.descendant_id == new_parent_id
            )
        )
    ):
        raise TreeError("Something can't be moved inside itself.")
    sub = select(TreePath.descendant_id).where(TreePath.kind == kind, TreePath.ancestor_id == node_id)
    old_ancestors = select(TreePath.ancestor_id).where(
        TreePath.kind == kind, TreePath.descendant_id == node_id, TreePath.depth > 0
    )
    # detach: remove paths from the old ancestors into the subtree
    db.session.execute(
        delete(TreePath).where(
            and_(
                TreePath.kind == kind,
                TreePath.descendant_id.in_(sub.scalar_subquery()),
                TreePath.ancestor_id.in_(old_ancestors.scalar_subquery()),
            )
        )
    )
    if new_parent_id is None:
        return
    supers = db.session.execute(
        select(TreePath.ancestor_id, TreePath.depth).where(
            TreePath.kind == kind, TreePath.descendant_id == new_parent_id
        )
    ).all()
    subs = db.session.execute(
        select(TreePath.descendant_id, TreePath.depth).where(TreePath.kind == kind, TreePath.ancestor_id == node_id)
    ).all()
    rows = [
        {"id": uuid.uuid4(), "org_id": org_id, "kind": kind, "ancestor_id": a, "descendant_id": d, "depth": da + dd + 1}
        for a, da in supers
        for d, dd in subs
    ]
    if rows:
        db.session.execute(insert(TreePath), rows)


def remove_subtree(kind: str, node_id: uuid.UUID) -> None:
    """Hard-remove paths for a node and everything under it (used when records are purged, not soft-deleted)."""
    sub = select(TreePath.descendant_id).where(TreePath.kind == kind, TreePath.ancestor_id == node_id).scalar_subquery()
    db.session.execute(delete(TreePath).where(TreePath.kind == kind, TreePath.descendant_id.in_(sub)))
