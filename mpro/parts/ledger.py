"""The inventory ledger (roadmap r211): the only place that changes stock.

Every change is an immutable `InventoryTransaction` row. `PartStock.on_hand` (per location) and `Part.on_hand` (all
locations) are cached sums updated in the same database transaction. The part row and the stock row are locked
(`SELECT … FOR UPDATE` on PostgreSQL; SQLite serializes writers) in a fixed order — part, then stock — so two people
taking the last unit at the same moment can't both succeed and concurrent writers can't deadlock.

Callers (parts, purchasing receipts, cycle counts, work orders, receipts) use `record()`; they commit.

    txn = record(org_id, part_id, location_id, "use", Decimal("-2"), work_order_id=wo.id, user_id=user.id)
    transfer(org_id, part_id, from_loc, to_loc, Decimal("5"), user_id=…)
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import select

from mpro.core.events import emit
from mpro.core.ids import uuid7
from mpro.core.models import utcnow
from mpro.extensions import db
from mpro.orgs.services import RuleError
from mpro.parts.models import TXN_KINDS, InventoryTransaction, Part, PartStock

ZERO = Decimal("0")
# Kinds that may only remove stock / only add it. "adjust", "count", "initial" go either way.
_REMOVE = {"use", "transfer_out"}
_ADD = {"restock", "return", "transfer_in"}


class StockError(RuleError):
    """Not enough stock (when negative stock isn't allowed), or a bad quantity."""


def dec(value: Any, field: str = "quantity") -> Decimal:
    """Parse a quantity or amount as Decimal; never float (G-12)."""
    if isinstance(value, Decimal):
        d = value
    elif isinstance(value, int) and not isinstance(value, bool):
        d = Decimal(value)
    elif isinstance(value, str) and value.strip():
        try:
            d = Decimal(value.strip())
        except Exception as e:  # noqa: BLE001
            raise RuleError(f"{field.capitalize()} must be a number.", 422) from e
    elif isinstance(value, float):
        d = Decimal(str(value))  # JSON numbers arrive as float; str() keeps what was typed
    else:
        raise RuleError(f"{field.capitalize()} must be a number.", 422)
    if not d.is_finite():
        raise RuleError(f"{field.capitalize()} must be a number.", 422)
    return d


def lock_part(org_id: uuid.UUID, part_id: uuid.UUID) -> Part:
    part = db.session.execute(
        select(Part).where(Part.id == part_id, Part.org_id == org_id).with_for_update()
    ).scalar_one_or_none()
    if part is None or part.deleted_at is not None:
        raise RuleError("That part doesn't exist.", 404)
    return part


def lock_stock(org_id: uuid.UUID, part_id: uuid.UUID, location_id: uuid.UUID | None, create: bool = True) -> PartStock:
    q = select(PartStock).where(
        PartStock.org_id == org_id,
        PartStock.part_id == part_id,
        PartStock.location_id.is_(None) if location_id is None else PartStock.location_id == location_id,
    )
    stock = db.session.execute(q.with_for_update()).scalar_one_or_none()
    if stock is None:
        if not create:
            raise RuleError("This part isn't stocked at that location.", 404)
        stock = PartStock(org_id=org_id, part_id=part_id, location_id=location_id, on_hand=ZERO, reserved=ZERO)
        db.session.add(stock)
        db.session.flush()
    return stock


def record(
    org_id: uuid.UUID,
    part_id: uuid.UUID,
    location_id: uuid.UUID | None,
    kind: str,
    quantity: Decimal,
    *,
    unit_cost: Decimal | None = None,
    note: str = "",
    work_order_id: uuid.UUID | None = None,
    purchase_order_id: uuid.UUID | None = None,
    po_line_id: uuid.UUID | None = None,
    cycle_count_id: uuid.UUID | None = None,
    transfer_id: uuid.UUID | None = None,
    file_ids: list[str] | None = None,
    user_id: uuid.UUID | None = None,
    allow_negative: bool = True,
    update_average_cost: bool = False,
    emit_event: bool = True,
) -> InventoryTransaction:
    """Add one ledger row and update the cached on-hand quantities. Returns the row (flushed, not committed)."""
    if kind not in TXN_KINDS:
        raise RuleError(f"Unknown stock change: {kind}.", 422)
    quantity = dec(quantity)
    if quantity == ZERO and kind not in {"count", "initial"}:
        raise StockError("The quantity can't be zero.", 422)
    if kind in _REMOVE and quantity > ZERO:
        quantity = -quantity
    if kind in _ADD and quantity < ZERO:
        raise StockError("Use a positive quantity.", 422)
    if kind == "adjust" and quantity < ZERO and not note.strip():
        raise StockError("Say why stock is being removed.", 422)  # r242: removals need a note

    part = lock_part(org_id, part_id)
    if part.non_stock and kind not in {"use", "return"}:
        raise StockError(f"{part.name} is a non-stock part; it isn't counted.", 422)
    stock = lock_stock(org_id, part_id, location_id)
    before = stock.on_hand or ZERO
    after = before + quantity
    if after < ZERO and not allow_negative and not part.non_stock:
        raise StockError(f"Only {_fmt(before)} {part.unit} of {part.name} in stock here.", 409)

    if update_average_cost and quantity > ZERO and unit_cost is not None:
        total_before = part.on_hand or ZERO
        if total_before > ZERO:
            part.unit_cost = ((total_before * (part.unit_cost or ZERO)) + quantity * unit_cost) / (
                total_before + quantity
            )
            part.unit_cost = part.unit_cost.quantize(Decimal("0.0001"))
        else:
            part.unit_cost = unit_cost

    if not part.non_stock:
        stock.on_hand = after
        part.on_hand = (part.on_hand or ZERO) + quantity
    txn = InventoryTransaction(
        org_id=org_id,
        part_id=part_id,
        location_id=location_id,
        kind=kind,
        quantity=quantity,
        before=before,
        after=after if not part.non_stock else before,
        unit_cost=unit_cost if unit_cost is not None else part.unit_cost,
        note=note.strip()[:4000],
        work_order_id=work_order_id,
        purchase_order_id=purchase_order_id,
        po_line_id=po_line_id,
        cycle_count_id=cycle_count_id,
        transfer_id=transfer_id,
        file_ids=list(file_ids or []),
        user_id=user_id,
        at=utcnow(),
    )
    db.session.add(txn)
    db.session.flush()
    if emit_event:
        emit(
            "part.stock_changed",
            entity_type="part",
            entity_id=part.id,
            entity_label=part.name,
            summary=f"{_kind_label(kind)} {_fmt(quantity, signed=True)} {part.unit}",
            data={
                "kind": kind,
                "quantity": str(quantity),
                "before": str(before),
                "after": str(after),
                "location_id": location_id,
                "transaction_id": txn.id,
                "work_order_id": work_order_id,
                "purchase_order_id": purchase_order_id,
            },
            org_id=org_id,
        )
    return txn


def transfer(
    org_id: uuid.UUID,
    part_id: uuid.UUID,
    from_location_id: uuid.UUID | None,
    to_location_id: uuid.UUID | None,
    quantity: Decimal,
    *,
    note: str = "",
    user_id: uuid.UUID | None = None,
    allow_negative: bool = False,
) -> tuple[InventoryTransaction, InventoryTransaction]:
    quantity = dec(quantity)
    if quantity <= ZERO:
        raise StockError("Use a positive quantity.", 422)
    if from_location_id == to_location_id:
        raise StockError("Pick two different locations.", 422)
    tid = uuid7()
    out = record(
        org_id,
        part_id,
        from_location_id,
        "transfer_out",
        quantity,
        note=note,
        transfer_id=tid,
        user_id=user_id,
        allow_negative=allow_negative,
    )
    inn = record(org_id, part_id, to_location_id, "transfer_in", quantity, note=note, transfer_id=tid, user_id=user_id)
    return out, inn


def recompute(org_id: uuid.UUID, part_id: uuid.UUID) -> Decimal:
    """Rebuild the cached sums from the ledger (repair tool and test oracle)."""
    part = lock_part(org_id, part_id)
    rows = db.session.execute(
        select(InventoryTransaction.location_id, InventoryTransaction.quantity).where(
            InventoryTransaction.org_id == org_id, InventoryTransaction.part_id == part_id
        )
    ).all()
    per: dict[uuid.UUID | None, Decimal] = {}
    for loc, q in rows:
        per[loc] = per.get(loc, ZERO) + (q or ZERO)
    for stock in db.session.execute(
        select(PartStock).where(PartStock.org_id == org_id, PartStock.part_id == part_id).with_for_update()
    ).scalars():
        stock.on_hand = per.pop(stock.location_id, ZERO)
    for loc, q in per.items():
        db.session.add(PartStock(org_id=org_id, part_id=part_id, location_id=loc, on_hand=q, reserved=ZERO))
    part.on_hand = sum((q for _l, q in rows), ZERO) if not part.non_stock else ZERO
    db.session.flush()
    return part.on_hand


def _fmt(q: Decimal, signed: bool = False) -> str:
    s = format(q.normalize(), "f") if q != q.to_integral() else str(int(q))
    return ("+" + s) if signed and q > ZERO else s


_LABELS = {
    "restock": "Restocked",
    "use": "Used",
    "return": "Returned",
    "adjust": "Adjusted",
    "transfer_out": "Moved out",
    "transfer_in": "Moved in",
    "receive": "Received",
    "count": "Counted",
    "initial": "Opening stock",
}


def _kind_label(kind: str) -> str:
    return _LABELS.get(kind, kind)


def describe(txn: InventoryTransaction) -> dict[str, Any]:
    return {"kind": txn.kind, "label": _kind_label(txn.kind), "quantity": str(txn.quantity)}
