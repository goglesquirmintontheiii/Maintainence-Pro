from __future__ import annotations

from typing import Any

from mpro.core.events import DomainEvent
from mpro.core.jobs import Job, enqueue, job, run_pending
from mpro.extensions import db

calls: list[dict[str, Any]] = []


@job("test_flaky")
def _flaky(payload: dict[str, Any]) -> None:
    calls.append(payload)
    if payload.get("fail"):
        raise RuntimeError("boom")


def test_search_people_and_teams(admin: Any) -> None:
    groups = admin.get("/api/v1/search?q=hv").json["groups"]
    types = {g["type"]: g for g in groups}
    assert "teams" in types and types["teams"]["results"][0]["title"] == "HVAC"
    people = admin.get("/api/v1/search?q=riley").json["groups"]
    assert people[0]["results"][0]["url"].startswith("/people/users/")
    assert admin.get("/api/v1/search?q=").json["groups"] == []


def test_search_respects_permissions(api: Any) -> None:
    api.login("jamie.ortiz@example.com")  # requester: no access to the people list
    types = {g["type"] for g in api.get("/api/v1/search?q=a").json["groups"]}
    assert "people" not in types and "teams" in types


def test_audit_log_filter_page_and_csv(admin: Any) -> None:
    admin.post("/api/v1/teams", json={"name": "Audit Team"})
    r = admin.get("/api/v1/audit?limit=5").json
    assert len(r["items"]) == 5 and r["next_cursor"]
    nxt = admin.get(f"/api/v1/audit?limit=5&cursor={r['next_cursor']}").json
    assert {e["id"] for e in nxt["items"]}.isdisjoint({e["id"] for e in r["items"]})
    hits = admin.get("/api/v1/audit?q=audit team").json["items"]
    assert hits and hits[0]["actor_label"] == "Alex Morgan"
    assert "team" in admin.get("/api/v1/audit").json["entity_types"]
    csv = admin.get("/api/v1/audit/export.csv")
    assert csv.status_code == 200 and csv.data.decode().startswith("when_utc,who,action")
    assert admin.get("/api/v1/audit?from=not-a-date").status_code == 422


def test_outbox_processed(app: Any, admin: Any) -> None:
    admin.post("/api/v1/teams", json={"name": "Outbox Team"})
    with app.app_context():
        from mpro.core.events import process_outbox

        process_outbox()
        assert db.session.query(DomainEvent).filter(DomainEvent.processed_at.is_(None)).count() == 0


def test_jobs_retry_then_fail(app: Any, admin: Any) -> None:
    with app.app_context():
        j = enqueue("test_flaky", {"fail": True}, max_attempts=2)
        db.session.commit()
        jid = j.id
        run_pending()
        j = db.session.get(Job, jid)
        assert j is not None and j.status == "queued" and j.attempts == 1  # backing off
        j.run_at = j.created_at
        db.session.commit()
        run_pending()
        j = db.session.get(Job, jid)
        assert j is not None and j.status == "failed" and "boom" in j.last_error
    r = admin.get("/api/v1/jobs?status=failed").json
    assert any(x["id"] == str(jid) for x in r["items"])
    assert admin.post(f"/api/v1/jobs/{jid}/retry").json["status"] == "queued"


def test_jobs_success(app: Any) -> None:
    with app.app_context():
        enqueue("test_flaky", {"n": 1})
        db.session.commit()
        assert run_pending() >= 1
        assert db.session.query(Job).filter_by(kind="test_flaky", status="done").count() == 1
