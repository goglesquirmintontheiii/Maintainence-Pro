# ruff: noqa: E501  (long API calls read better on one line)
"""Regression tests for the 0.4.0 independent review (findings 1–16)."""

from __future__ import annotations

from typing import Any

from tests.conftest import Api
from tests.test_procedures import ans, make, wo
from tests.test_work_orders import login, uid

API = "/api/v1"
AVERY = "avery.kim@example.com"


def limited(app: Any, admin: Api, email: str = AVERY) -> Api:
    assert (
        admin.patch(f"{API}/users/{uid(admin, email)}/work-settings", {"wo_visibility": "limited"}).status_code == 200
    )
    return login(app, email)


# ---- #1 procedure history / analytics respect work-order visibility --------------------------------
def test_01_history_and_analytics_hide_invisible_work_orders(app: Any, admin: Api) -> None:
    p = make(admin, "Visibility check")
    w = wo(admin, procedures=[p["id"]], title="Secret pump job")
    run = w["procedures"][0]
    ans(admin, w, run, "temp", value=99)
    ans(admin, w, run, "oil", value="fail")
    tech = limited(app, admin)
    assert tech.get(f"{API}/work-orders/{w['id']}").status_code == 404
    h = tech.get(f"{API}/procedures/{p['id']}/history").json
    assert h["created"] == 0 and "Secret pump job" not in str(h)
    an = tech.get(f"{API}/procedures/{p['id']}/analytics").json
    assert all(s.get("fail", 0) == 0 for s in an["steps"])
    assert all(not n["points"] for n in an["numeric"])
    assert not an.get("scores")
    # the admin still sees everything
    assert admin.get(f"{API}/procedures/{p['id']}/history").json["created"] == 1


# ---- #14 one-off procedures follow their work order's visibility -----------------------------------
def test_14_one_off_procedure_follows_work_order(app: Any, admin: Api) -> None:
    w = wo(admin, title="Hidden one-off")
    r = admin.post(
        f"{API}/work-orders/{w['id']}/procedures",
        {"name": "Private list", "schema": {"items": [{"type": "checkbox", "label": "x"}]}},
    )
    pid = r.json["procedure"]["id"]
    tech = limited(app, admin)
    assert tech.get(f"{API}/procedures/{pid}").status_code == 404
    assert tech.get(f"{API}/procedures/{pid}/history").status_code == 404
    assert admin.get(f"{API}/procedures/{pid}").status_code == 200


def test_14_hidden_parent_not_named_in_list(app: Any, admin: Api) -> None:
    parent = wo(admin, title="Hidden parent title")
    avery = uid(admin, AVERY)
    sub = admin.post(
        f"{API}/work-orders",
        {"title": "Visible sub", "parent_id": parent["id"], "assignees": [{"type": "user", "id": avery}]},
    )
    assert sub.status_code == 201, sub.json
    tech = limited(app, admin)
    items = tech.get(f"{API}/work-orders").json["items"]
    row = next(i for i in items if i["id"] == sub.json["id"])
    assert row["parent"] is None
    assert "Hidden parent title" not in str(items)


# ---- #2 RRULE whitelist and bounded expansion ------------------------------------------------------
def test_02_rrule_whitelist_and_bounds(admin: Api) -> None:
    import time
    from datetime import UTC, datetime, timedelta

    from mpro.pm import schedule as sch
    from tests.test_pm import local_at

    def make_plan(rule: str) -> Any:
        return admin.post(
            f"{API}/pm/plans", {"name": "Raw rule", "tasks": [{"name": "T", "rrule": rule, "anchor": local_at(3)}]}
        )

    for bad in ("FREQ=DAILY;BYHOUR=1,2,3", "FREQ=MINUTELY", "FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30",
                "FREQ=DAILY;BYSETPOS=2", "FREQ=WEEKLY;BYDAY=2MO", "FREQ=DAILY;INTERVAL=5000", "FREQ=DAILY;BYYEARDAY=1",
                "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO;BYSETPOS=1;COUNT=1;UNTIL=20270101"):  # fmt: skip
        t = time.time()
        r = make_plan(bad)
        assert r.status_code == 422, (bad, r.json)
        assert time.time() - t < 3
    assert make_plan("RRULE:FREQ=MONTHLY;BYDAY=-1FR").status_code == 201
    # expansion is bounded in both count and time span
    anchor = datetime(2026, 1, 1, 8, tzinfo=UTC)
    tz = sch.zone("UTC")
    out = sch.expand("FREQ=DAILY", anchor, tz, anchor, anchor + timedelta(days=365 * 50))
    assert len(out) == sch.MAX_OCCURRENCES
    assert sch.next_after("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO", anchor, anchor, tz) is None


# ---- #3 DOCX/XLSX zip bombs, cached previews, background rendering ---------------------------------
def _bomb_docx() -> bytes:
    import io
    import zipfile

    from tests.test_files_viewer import _docx

    buf = io.BytesIO()
    with (
        zipfile.ZipFile(io.BytesIO(_docx("<w:p><w:r><w:t>x</w:t></w:r></w:p>"))) as src,
        zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z,
    ):
        for i in src.infolist():
            z.writestr(i, src.read(i))
        z.writestr("word/media/huge.xml", b"\0" * (60 * 1024 * 1024))  # 60 MB of zeros, ~60 KB compressed
    return buf.getvalue()


def test_03_zip_bomb_refused_and_previews_cached(app: Any, admin: Api) -> None:
    import io
    import time
    import zipfile

    from mpro.core.files import FileObject
    from mpro.extensions import db
    from tests.test_assets import upload
    from tests.test_files_viewer import _docx

    bomb = _bomb_docx()
    assert len(bomb) < 1024 * 1024
    fid = upload(admin, "bomb.docx", bomb)
    t = time.time()
    r = admin.get(f"{API}/files/{fid}/preview").json
    assert r["kind"] == "none" and "too large" in r["reason"]
    assert time.time() - t < 3
    # a normal document is rendered once and kept as the file's preview
    ok = upload(admin, "ok.docx", _docx("<w:p><w:r><w:t>Hello cache</w:t></w:r></w:p>"))
    assert "Hello cache" in admin.get(f"{API}/files/{ok}/preview").json["html"]
    import uuid

    with app.app_context():
        f = db.session.get(FileObject, uuid.UUID(ok))
        assert f is not None and f.preview_id is not None
    assert "Hello cache" in admin.get(f"{API}/files/{ok}/preview").json["html"]
    # documents over 2 MB are rendered by the background job (inline in tests) at upload
    import os

    buf = io.BytesIO()
    with (
        zipfile.ZipFile(io.BytesIO(_docx("<w:p><w:r><w:t>Big one</w:t></w:r></w:p>"))) as src,
        zipfile.ZipFile(buf, "w") as z,
    ):
        for i in src.infolist():
            z.writestr(i, src.read(i))
        z.writestr("word/media/noise.bin", os.urandom(3 * 1024 * 1024))
    big = upload(admin, "big.docx", buf.getvalue())
    with app.app_context():
        f = db.session.get(FileObject, uuid.UUID(big))
        assert f is not None and f.preview_id is not None  # made by the job, not by the request
    assert "Big one" in admin.get(f"{API}/files/{big}/preview").json["html"]


def test_16_psd_pixel_limit() -> None:
    import struct

    from mpro.core import previews

    w, h = 10_000, 7_000  # 70M pixels
    head = b"8BPS" + struct.pack(">H", 1) + b"\0" * 6 + struct.pack(">HIIHH", 3, h, w, 8, 3)
    data = head + struct.pack(">I", 0) * 3 + struct.pack(">H", 0)

    class F:
        storage_key = "x"

    import pytest

    orig = previews.storage
    previews.storage = lambda: type("S", (), {"get": staticmethod(lambda k: data)})()  # type: ignore[assignment]
    try:
        with pytest.raises(ValueError, match="too large"):
            previews.make_psd_preview(F())  # type: ignore[arg-type]
    finally:
        previews.storage = orig  # type: ignore[assignment]


# ---- #4 duplicate PM work orders -----------------------------------------------------------------
def test_04_occurrence_claimed_once_and_unique_index(app: Any, admin: Api) -> None:
    import uuid

    import pytest
    from sqlalchemy import select
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy.orm.attributes import set_committed_value

    from mpro.extensions import db
    from mpro.orgs.models import Organization
    from mpro.pm import services as pm
    from mpro.pm.models import MaintenancePlan, PMOccurrence
    from mpro.workorders.models import WorkOrder
    from tests.test_pm import plan, wos_of

    p = plan(admin, name="Dup guard")
    assert len(wos_of(admin, "Dup%20guard")) == 2
    with app.app_context():
        mp = db.session.get(MaintenancePlan, uuid.UUID(p["id"]))
        assert mp is not None
        org = db.session.get(Organization, mp.org_id)
        occ = db.session.scalars(
            select(PMOccurrence).where(PMOccurrence.plan_id == mp.id, PMOccurrence.status == "generated")
        ).first()
        assert occ is not None
        set_committed_value(occ, "status", "planned")  # another worker's stale view of the same occurrence
        assert pm._generate_wo(org, mp, occ, pm.tasks_of(mp)) is False  # type: ignore[arg-type]
        db.session.commit()
        n = db.session.scalar(select(db.func.count()).select_from(WorkOrder).where(WorkOrder.source_id == occ.id))
        assert n == 1
        # the database refuses a second live work order for the same occurrence
        wo = db.session.scalars(select(WorkOrder).where(WorkOrder.source_id == occ.id)).one()
        copy = WorkOrder(org_id=wo.org_id, number=999999, title="copy", source_type="pm_occurrence", source_id=occ.id)
        db.session.add(copy)
        with pytest.raises(IntegrityError):
            db.session.flush()
        db.session.rollback()
    assert len(wos_of(admin, "Dup%20guard")) == 2


# ---- #5 floating schedules ----------------------------------------------------------------------
def test_05_floating_past_anchor_and_canceled_base(admin: Api) -> None:
    from datetime import datetime, timedelta

    from tests.test_pm import TZ, local_at, plan, wos_of

    p = plan(admin, name="Floatpast", interval_mode="floating", horizon_days=60,
             tasks=[{"name": "", "spec": {"freq": "every_n_days", "interval": 10}, "anchor": local_at(-5)}])  # fmt: skip
    items = wos_of(admin, "Floatpast")
    assert len(items) == 1  # an anchor in the past is due now
    due = datetime.fromisoformat(items[0]["due_at"].replace("Z", "+00:00")).astimezone(TZ).date()
    assert due == datetime.now(TZ).date()
    # canceling the open one: the next one counts from the canceled occurrence
    admin.post(f"{API}/work-orders/{items[0]['id']}/status", {"status": "canceled"})
    assert admin.post(f"{API}/pm/plans/{p['id']}/generate").status_code == 200
    items = [i for i in wos_of(admin, "Floatpast") if i["status"] == "open"]
    assert len(items) == 1
    due = datetime.fromisoformat(items[0]["due_at"].replace("Z", "+00:00")).astimezone(TZ).date()
    assert due == datetime.now(TZ).date() + timedelta(days=10)


# ---- #6 due-day bounds -------------------------------------------------------------------------
def test_06_due_in_days_bounds(admin: Api) -> None:
    from mpro.workorders.services import due_days
    from tests.test_pm import local_at

    r = admin.post(
        f"{API}/pm/plans",
        {
            "name": "Due",
            "defaults": {"due_in_days": 10**12},
            "tasks": [{"spec": {"freq": "monthly"}, "anchor": local_at(3)}],
        },
    )
    assert r.status_code == 422
    assert due_days(10**12) == 3650 and due_days(-4) == 0 and due_days("x") == 0 and due_days(None) == 0


# ---- #9 plans and unpublished procedures ---------------------------------------------------------
def test_09_unpublished_procedures(admin: Api) -> None:
    from tests.test_pm import local_at, wos_of

    draft = make(admin, "Draft proc", publish=False)
    body = {"name": "Proc plan", "horizon_days": 10, "defaults": {"procedure_ids": [draft["id"]]},
            "tasks": [{"spec": {"freq": "monthly"}, "anchor": local_at(3)}]}  # fmt: skip
    r = admin.post(f"{API}/pm/plans", body)
    assert r.status_code == 422 and "Publish" in r.json["message"]
    pub = make(admin, "Published proc")
    body["defaults"] = {"procedure_ids": [pub["id"]]}
    body["tasks"] = [{"spec": {"freq": "monthly"}, "anchor": local_at(40)}]
    p = admin.post(f"{API}/pm/plans", body).json
    admin.post(f"{API}/procedures/{pub['id']}/archive")
    admin.patch(f"{API}/pm/plans/{p['id']}", {"horizon_days": 60})
    admin.post(f"{API}/pm/plans/{p['id']}/generate")
    items = wos_of(admin, "Proc%20plan")
    assert len(items) == 1  # still created
    assert admin.get(f"{API}/work-orders/{items[0]['id']}").json["procedures"] == []
    got = admin.get(f"{API}/pm/plans/{p['id']}").json
    assert "Published proc" in got["last_problem"] and "not published" in got["last_problem"]


def test_06_broken_hook_does_not_undo_the_change(app: Any, admin: Api) -> None:
    from mpro.workorders import services as wos

    calls: list[str] = []

    def broken(*a: Any) -> None:
        raise RuntimeError("boom")

    def ok(*a: Any) -> None:
        calls.append(a[-1])

    wos.STATUS_HOOKS[:0] = [broken]
    wos.STATUS_HOOKS.append(ok)
    try:
        w = wo(admin, title="Hooked")
        r = admin.post(f"{API}/work-orders/{w['id']}/status", {"status": "in_progress"})
        assert r.status_code == 200, r.json
    finally:
        wos.STATUS_HOOKS.remove(broken)
        wos.STATUS_HOOKS.remove(ok)
    assert calls == ["in_progress"]
    assert admin.get(f"{API}/work-orders/{w['id']}").json["status"] == "in_progress"


# ---- #8 events from background generation carry the organization ---------------------------------
def test_08_pm_generated_events_have_org_id(app: Any, admin: Api) -> None:
    import uuid

    from sqlalchemy import select

    from mpro.core.events import DomainEvent
    from mpro.extensions import db
    from mpro.pm import services as pm
    from mpro.pm.models import MaintenancePlan
    from mpro.workorders.models import WorkOrder
    from tests.test_pm import local_at

    p = admin.post(
        f"{API}/pm/plans",
        {"name": "Org events", "horizon_days": 5, "tasks": [{"spec": {"freq": "monthly"}, "anchor": local_at(30)}]},
    ).json
    admin.patch(f"{API}/pm/plans/{p['id']}", {"horizon_days": 60})  # request path may generate; reset below
    with app.app_context():
        mp = db.session.get(MaintenancePlan, uuid.UUID(p["id"]))
        assert mp is not None
        for w in db.session.scalars(select(WorkOrder).where(WorkOrder.source_type == "pm_occurrence")).all():
            w.deleted_at = w.created_at
        from mpro.pm.models import PMOccurrence

        for o in db.session.scalars(select(PMOccurrence).where(PMOccurrence.plan_id == mp.id)).all():
            db.session.delete(o)
        db.session.commit()
        pm.generate_all()  # what the pm.generate job runs: no request, no g.org
        db.session.commit()
        wo_ids = [
            str(w.id)
            for w in db.session.scalars(
                select(WorkOrder).where(WorkOrder.source_type == "pm_occurrence", WorkOrder.deleted_at.is_(None))
            ).all()
        ]
        assert wo_ids
        evs = db.session.scalars(select(DomainEvent).where(DomainEvent.entity_id.in_(wo_ids))).all()
        assert evs and all(e.org_id == mp.org_id for e in evs), [(e.type, e.org_id) for e in evs]


# ---- #7 numeric condition values ---------------------------------------------------------------
def test_07_numeric_conditions_must_be_finite(admin: Api) -> None:
    from mpro.procedures.schema import _cond_ok

    def sch(value: Any) -> dict[str, Any]:
        return {"items": [{"id": "n", "type": "number", "label": "N"},
                          {"id": "t", "type": "text", "label": "T", "condition": {"field": "n", "op": "gt", "value": value}}]}  # fmt: skip

    for bad in ("NaN", "sNaN", "Infinity", True, "abc", None, [1]):
        r = admin.post(f"{API}/procedures", {"name": "Cond", "schema": sch(bad)})
        assert r.status_code == 422, (bad, r.json)
    p = make(admin, "Cond ok", sch("10"))
    w = wo(admin, procedures=[p["id"]])
    run = w["procedures"][0]
    r = ans(admin, w, run, "n", value="NaN")
    assert r.status_code in (200, 422)  # never a 500
    assert _cond_ok({"field": "n", "op": "gt", "value": "sNaN"}, {"n": "5"}) is False
    assert _cond_ok({"field": "n", "op": "lt", "value": "10"}, {"n": "sNaN"}) is False
    assert _cond_ok({"field": "n", "op": "gt", "value": "1"}, {"n": 5}) is True


# ---- #10 stopping a repeat --------------------------------------------------------------------
def test_10_stop_repeat_needs_delete_and_audits(app: Any, admin: Api) -> None:
    from tests.test_pm import put, wos_of

    w = wo(admin, title="Weekly stopper")
    r = put(admin, f"{API}/work-orders/{w['id']}/repeat", {"freq": "weekly", "weekdays": [0, 3], "days_ahead": 8})
    assert r.status_code == 200, r.json
    copies = [x for x in wos_of(admin, "Weekly%20stopper") if x["id"] != w["id"]]
    assert copies
    tech = login(app, AVERY)  # technicians edit work orders but can't delete them
    assert tech.delete(f"{API}/work-orders/{w['id']}/repeat").status_code == 403
    assert admin.delete(f"{API}/work-orders/{w['id']}/repeat").status_code == 204
    log = admin.get(f"{API}/audit?entity_type=work_order&q=wo.deleted&limit=200").json["items"]
    deleted = {e["entity_id"] for e in log if e["type"] == "wo.deleted"}
    assert {c["id"] for c in copies} <= deleted


# ---- #11 duplicate guard per action ------------------------------------------------------------
def test_11_duplicate_guard_per_action(admin: Api) -> None:
    from tests.test_automations import auto, meter, meter_trigger, read, wos

    m = meter(admin, "Two actions")
    auto(admin, trigger=meter_trigger("above", 80), targets=[m["id"]],
         actions=[{"type": "create_work_order", "title": "Alpha job"}, {"type": "create_work_order", "title": "Beta job"}])  # fmt: skip
    read(admin, m, 70, 90)
    assert len(wos(admin, "Alpha%20job")) == 1
    assert len(wos(admin, "Beta%20job")) == 1  # the second action isn't blocked by the first one's work order
    read(admin, m, 60, 95)  # rearmed, both still open: neither duplicates
    assert len(wos(admin, "Alpha%20job")) == 1 and len(wos(admin, "Beta%20job")) == 1


# ---- #16 automations run as a creator who may still manage them; email subjects; holidays; PDFs ----
def test_16_automation_creator_lost_permission(app: Any, admin: Api) -> None:
    from tests.test_automations import auto, meter, meter_trigger, read, wos

    jordan_email = "jordan.reyes@example.com"
    jordan = login(app, jordan_email)
    m = meter(admin, "Creator check")
    x = auto(
        jordan,
        trigger=meter_trigger("above", 80),
        targets=[m["id"]],
        actions=[{"type": "create_work_order", "title": "Creator job"}],
    )
    r = admin.patch(f"{API}/users/{uid(admin, jordan_email)}", {"role": "technician"})
    assert r.status_code == 200, r.json
    read(admin, m, 70, 90)
    assert wos(admin, "Creator%20job") == []
    runs = admin.get(f"{API}/automations/{x['id']}/runs").json["items"]
    assert runs[0]["status"] == "failed" and "can no longer manage automations" in runs[0]["message"]


def test_16_email_subject_is_one_line(app: Any) -> None:
    from mpro.core.mail import send_email
    from mpro.extensions import db

    with app.app_context():
        m = send_email("a@example.com", "Hot\r\nBcc: evil@example.com\n", "body")
        db.session.commit()
        assert m.subject == "Hot Bcc: evil@example.com"


# ---- #13 assigned procedure fields -------------------------------------------------------------
def test_13_assigned_fields_ignore_removed_people_and_managers_answer(app: Any, admin: Api) -> None:
    avery = uid(admin, AVERY)
    schema = {"items": [{"id": "sup", "type": "checkbox", "label": "Sign-off", "assignees": [f"user:{avery}"]},
                        {"id": "x", "type": "checkbox", "label": "Other"}]}  # fmt: skip
    p = make(admin, "Assigned review", schema)
    w = wo(admin, procedures=[p["id"]])
    run = w["procedures"][0]
    assert ans(admin, w, run, "sup", value=True).status_code == 200  # procedures.manage may answer
    w2 = wo(admin, procedures=[p["id"]])
    assert admin.delete(f"{API}/users/{avery}").status_code == 204  # Avery leaves the organization
    r = admin.post(f"{API}/work-orders/{w2['id']}/status", {"status": "done"})
    assert r.status_code == 200, r.json  # the removed assignee no longer blocks completion


# ---- #12 deleting a custom role ------------------------------------------------------------------
def test_12_deleted_role_moves_people_to_least_privileged_cover(app: Any, admin: Api) -> None:
    r = admin.post(f"{API}/roles", {"name": "Reader plus", "base": "admin", "permissions": ["wo.view", "assets.view"]})
    assert r.status_code == 201, r.json
    role = r.json
    assert role["fallback"] == "viewer" and role["fallback_label"] == "View-only"
    avery = uid(admin, AVERY)
    admin.patch(f"{API}/users/{avery}", {"role": role["key"]})
    out = admin.delete(f"{API}/roles/{role['id']}").json
    assert out["moved"] == 1 and out["moved_to"] == "viewer"
    assert login(app, AVERY).session()["role"] == "viewer"  # not the admin role it was "based on"


# ---- #16 administrators are managed only with users.manage_admins -------------------------------
def test_16_manage_admins_permission(app: Any, admin: Api) -> None:
    role = admin.post(f"{API}/roles", {"name": "People lead", "base": "limited_admin"}).json
    jordan_email = "jordan.reyes@example.com"
    admin.patch(f"{API}/users/{uid(admin, jordan_email)}", {"role": role["key"]})
    jordan = login(app, jordan_email)
    me = admin.session()["user"]["id"]
    assert jordan.patch(f"{API}/users/{me}", {"name": "Renamed owner"}).status_code == 403
    assert (
        jordan.c.patch(
            f"{API}/users/{me}/work-settings", json={"wo_visibility": "limited"}, headers=jordan._h()
        ).status_code
        == 403
    )
    assert jordan.post(f"{API}/users", {"email": "na@example.com", "role": "admin"}).status_code == 403
    assert jordan.patch(f"{API}/users/{uid(admin, AVERY)}", {"job_title": "Lead tech"}).status_code == 200


def test_16_holiday_delete_is_audited_and_bad_pdf_is_422(admin: Api) -> None:
    import io

    h = admin.post(f"{API}/pm/holidays", {"day": "2026-12-25", "name": "Christmas"}).json
    assert admin.delete(f"{API}/pm/holidays/{h['id']}").status_code == 204
    log = admin.get(f"{API}/audit?q=holiday_deleted").json["items"]
    assert log and log[0]["type"] == "pm.holiday_deleted"
    bad = b"%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 99999999999 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF"
    for data in (bad, b"%PDF-" + b"\xff" * 500):
        r = admin.c.post(
            f"{API}/procedures/import",
            data={"file": (io.BytesIO(data), "x.pdf")},
            headers=admin._h(),
            content_type="multipart/form-data",
        )
        assert r.status_code == 422, r.json


# ---- #15 migration 0004 data steps -----------------------------------------------------------------
def _fill(conn: Any, table: str, **values: Any) -> None:
    """Insert a row, filling NOT NULL columns without defaults with harmless values (SQLite)."""
    import uuid
    from datetime import UTC, datetime

    from sqlalchemy import text

    cols = conn.execute(text(f"PRAGMA table_info({table})")).all()
    row: dict[str, Any] = {}
    for _cid, name, typ, notnull, default, _pk in cols:
        if name in values:
            row[name] = values[name]
        elif notnull and default is None:
            t = (typ or "").upper()
            row[name] = (uuid.uuid4().hex if t.startswith("CHAR(32)") else 0 if any(x in t for x in ("INT", "NUMERIC", "BOOL"))
                         else datetime.now(UTC).isoformat(sep=" ") if "DATETIME" in t else "{}" if "JSON" in t else "x")  # fmt: skip
    conn.execute(text(f"INSERT INTO {table} ({', '.join(row)}) VALUES ({', '.join(':' + k for k in row)})"), row)


def test_15_migration_owner_custom_uuid7_and_disarmed_triggers(tmp_path: Any) -> None:
    import uuid

    from flask_migrate import downgrade, upgrade
    from sqlalchemy import text

    from mpro.app import create_app
    from mpro.extensions import db

    app = create_app({"SQLALCHEMY_DATABASE_URI": f"sqlite:///{(tmp_path / 'm.db').as_posix()}", "TESTING": True})
    with app.app_context():
        upgrade(revision="0003")
        org, u_old, u_new = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        meter = uuid.uuid4()
        with db.engine.begin() as c:
            _fill(c, "organizations", id=org.hex, name="Acme")
            _fill(c, "users", id=u_old.hex, email="old@example.com", name="Old", active=0)
            _fill(c, "users", id=u_new.hex, email="new@example.com", name="New", active=1)
            _fill(
                c,
                "memberships",
                id=uuid.uuid4().hex,
                org_id=org.hex,
                user_id=u_old.hex,
                role="admin",
                created_at="2020-01-01 00:00:00",
            )
            _fill(
                c,
                "memberships",
                id=uuid.uuid4().hex,
                org_id=org.hex,
                user_id=u_new.hex,
                role="admin",
                created_at="2021-01-01 00:00:00",
            )
            _fill(c, "meters", id=meter.hex, org_id=org.hex, name="Temp", last_value=95, created_by_id=u_new.hex)
            _fill(c, "meter_triggers", id=uuid.uuid4().hex, org_id=org.hex, meter_id=meter.hex, name="Hot", kind="threshold",
                  comparator="gt", threshold=80, work_order="{}", active=1, deleted_at=None)  # fmt: skip
        upgrade(revision="0004")
        with db.engine.begin() as c:
            owners = c.execute(text("SELECT user_id FROM memberships WHERE role = 'owner'")).scalars().all()
            assert [uuid.UUID(str(x)) for x in owners] == [u_new]  # the earliest *active* admin
            aid = c.execute(text("SELECT id FROM automations")).scalar_one()
            assert uuid.UUID(str(aid)).version == 7
            state = c.execute(
                text("SELECT state FROM automation_states WHERE automation_id = :a"), {"a": aid}
            ).scalar_one()
            assert '"fired": true' in state  # already above the threshold: starts disarmed
            c.execute(text("UPDATE memberships SET role = 'custom' WHERE user_id = :u"), {"u": u_old.hex})
        downgrade(revision="0003")
        with db.engine.begin() as c:
            roles = set(c.execute(text("SELECT role FROM memberships")).scalars().all())
            assert roles == {"admin", "technician"}
        db.engine.dispose()
