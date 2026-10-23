"""Inventory ledger (0.5.0, r211): every stock change is a ledger row; cached sums agree with the ledger,
negative stock is refused unless allowed, and concurrent changes never lose an update (PostgreSQL row locks)."""

from __future__ import annotations

import os
import threading
import uuid
from decimal import Decimal
from typing import Any

import pytest

from tests.conftest import Api
from tests.test_parts import stocked


def _ids(app: Any, pid: str, lid: str) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    with app.app_context():
        from mpro.extensions import db
        from mpro.parts.models import Part

        p = db.session.get(Part, uuid.UUID(pid))
        assert p is not None
        return p.org_id, p.id, uuid.UUID(lid)


def test_record_rules_and_recompute(app: Any, admin: Api) -> None:
    p, wh = stocked(admin, "5")
    org_id, part_id, loc = _ids(app, p["id"], wh)
    with app.app_context():
        from mpro.extensions import db
        from mpro.parts import ledger
        from mpro.parts.models import Part, PartStock

        with pytest.raises(ledger.StockError):
            ledger.record(org_id, part_id, loc, "use", Decimal("6"), allow_negative=False)
        db.session.rollback()
        with pytest.raises(ledger.StockError):
            ledger.record(org_id, part_id, loc, "restock", Decimal("-1"))
        with pytest.raises(ledger.StockError):
            ledger.record(org_id, part_id, loc, "adjust", Decimal("-1"))  # removals need a note
        with pytest.raises(ledger.StockError):
            ledger.record(org_id, part_id, loc, "use", Decimal("0"))
        db.session.rollback()
        t = ledger.record(org_id, part_id, loc, "use", Decimal("2"))  # sign is applied for removals
        assert t.quantity == Decimal("-2") and t.before == 5 and t.after == 3
        ledger.record(org_id, part_id, loc, "use", Decimal("4.5"))  # allowed by default at ledger level
        db.session.commit()
        part = db.session.get(Part, part_id)
        assert part is not None and part.on_hand == Decimal("-1.5")
        # corrupt the cache; recompute rebuilds it from the ledger
        st = db.session.query(PartStock).filter_by(part_id=part_id, location_id=loc).one()
        st.on_hand = Decimal("99")
        part.on_hand = Decimal("99")
        db.session.flush()
        assert ledger.recompute(org_id, part_id) == Decimal("-1.5")
        assert st.on_hand == Decimal("-1.5")
        assert ledger.dec("2.10") == Decimal("2.10") and ledger.dec(1.1) == Decimal("1.1")
        with pytest.raises(ledger.RuleError):
            ledger.dec("NaN")


def test_transfer_moves_between_locations(app: Any, admin: Api) -> None:
    from tests.test_assets import loc as mkloc

    p, wh = stocked(admin, "4")
    van = mkloc(admin, "Van 2")
    org_id, part_id, loc = _ids(app, p["id"], wh)
    with app.app_context():
        from mpro.extensions import db
        from mpro.parts import ledger
        from mpro.parts.models import Part

        out, inn = ledger.transfer(org_id, part_id, loc, uuid.UUID(van["id"]), Decimal("3"))
        assert out.transfer_id == inn.transfer_id and out.quantity == -3 and inn.quantity == 3
        with pytest.raises(ledger.StockError):
            ledger.transfer(
                org_id, part_id, loc, uuid.UUID(van["id"]), Decimal("2")
            )  # only 1 left, negative not allowed
        db.session.rollback()
        part = db.session.get(Part, part_id)
        assert part is not None and part.on_hand == 4


@pytest.mark.skipif(
    not (os.environ.get("TEST_DATABASE_URL") or "").startswith("postgresql"), reason="row locks need PostgreSQL"
)
def test_concurrent_use_never_oversells(app: Any, admin: Api) -> None:
    p, wh = stocked(admin, "5")
    org_id, part_id, loc = _ids(app, p["id"], wh)
    ok: list[int] = []
    refused: list[int] = []
    start = threading.Barrier(10)

    def worker(i: int) -> None:
        with app.app_context():
            from mpro.extensions import db
            from mpro.parts import ledger

            start.wait()
            try:
                ledger.record(org_id, part_id, loc, "use", Decimal("1"), allow_negative=False, emit_event=False)
                db.session.commit()
                ok.append(i)
            except ledger.StockError:
                db.session.rollback()
                refused.append(i)
            finally:
                db.session.remove()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert len(ok) == 5 and len(refused) == 5
    with app.app_context():
        from mpro.extensions import db
        from mpro.parts import ledger
        from mpro.parts.models import Part

        part = db.session.get(Part, part_id)
        assert part is not None and part.on_hand == 0
        assert ledger.recompute(org_id, part_id) == 0
