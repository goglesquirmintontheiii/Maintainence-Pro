# ruff: noqa: E501  (long API calls read better on one line)
"""Procedures (0.4.0): builder schema, versions, runs on work orders, answers, scoring, corrective actions."""

from __future__ import annotations

import io
from typing import Any

from tests.conftest import Api
from tests.test_assets import asset, loc, other_org, upload
from tests.test_work_orders import PNG_1PX, login, uid

API = "/api/v1"

SCHEMA = {
    "scoring": {"enabled": True, "goal": 80},
    "items": [
        {"id": "ppe", "type": "checkbox", "label": "PPE on", "required": True},
        {
            "id": "sec",
            "type": "section",
            "label": "Checks",
            "items": [
                {"id": "oil", "type": "inspection", "label": "Oil level", "required": True, "points": 2},
                {
                    "id": "why",
                    "type": "text",
                    "label": "What's wrong?",
                    "required": True,
                    "condition": {"field": "oil", "op": "in", "value": ["flag", "fail"]},
                },
                {"id": "temp", "type": "number", "label": "Temperature", "unit": "°F", "min": 0, "max": 300},
            ],
        },
        {"id": "kind", "type": "multiple_choice", "label": "Type", "options": ["A", "B"]},
    ],
}


def make(
    api: Api, name: str = "Pump check", schema: dict[str, Any] | None = None, publish: bool = True
) -> dict[str, Any]:
    r = api.post(f"{API}/procedures", {"name": name, "schema": schema or SCHEMA, "tags": ["Weekly"]})
    assert r.status_code == 201, r.json
    if publish:
        r = api.post(f"{API}/procedures/{r.json['id']}/publish")
        assert r.status_code == 200, r.json
    return r.json  # type: ignore[no-any-return]


def wo(api: Api, **kw: Any) -> dict[str, Any]:
    r = api.post(f"{API}/work-orders", {"title": "Inspect pump", **kw})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def ans(api: Api, w: dict[str, Any], run: dict[str, Any], fid: str, **body: Any) -> Any:
    return api.c.put(f"{API}/work-orders/{w['id']}/procedures/{run['id']}/answers/{fid}", json=body, headers=api._h())


def test_schema_validation(admin: Api) -> None:
    bad = [
        {"items": [{"type": "nope", "label": "x"}]},
        {"items": [{"type": "checkbox", "label": ""}]},
        {"items": [{"type": "multiple_choice", "label": "x", "options": []}]},
        {"items": [{"id": "a", "type": "checkbox", "label": "x"}, {"id": "a", "type": "checkbox", "label": "y"}]},
        {
            "items": [
                {"id": "b", "type": "checkbox", "label": "y", "condition": {"field": "a", "op": "eq", "value": True}},
                {"id": "a", "type": "checkbox", "label": "x"},
            ]
        },
        {
            "items": [
                {"id": "a", "type": "text", "label": "x"},
                {"id": "b", "type": "checkbox", "label": "y", "condition": {"field": "a", "op": "answered"}},
            ]
        },
        {"items": [{"type": "checkbox", "label": "x" * 513}]},
        {"items": [{"type": "checkbox", "label": "x", "link": "javascript:alert(1)"}]},
        {"items": [{"type": "section", "label": "s", "items": [{"type": "section", "label": "t", "items": []}]}]},
        {"items": [{"type": "checkbox", "label": f"f{i}"} for i in range(351)]},
    ]
    for s in bad:
        assert admin.post(f"{API}/procedures", {"name": "Bad", "schema": s}).status_code == 422, s
    p = make(admin, publish=False)
    assert p["status"] == "draft" and p["draft"]["field_count"] == 5
    # drafts can't be attached (r205); publishing needs at least one field
    w = wo(admin)
    assert admin.post(f"{API}/work-orders/{w['id']}/procedures", {"procedure_id": p["id"]}).status_code == 422
    empty = admin.post(f"{API}/procedures", {"name": "Empty"}).json
    assert admin.post(f"{API}/procedures/{empty['id']}/publish").status_code == 422


def test_versions_kept_by_work_orders(admin: Api) -> None:
    p = make(admin)
    w = wo(admin, procedures=[p["id"]])
    run = w["procedures"][0]
    assert run["version"] == 1 and run["progress"]["total"] == 4  # "why" is hidden until oil is flagged
    # editing makes a new draft; the WO keeps version 1
    new_schema = {**SCHEMA, "items": SCHEMA["items"] + [{"id": "extra", "type": "checkbox", "label": "Extra"}]}
    d = admin.patch(f"{API}/procedures/{p['id']}", {"schema": new_schema}).json
    assert d["has_unpublished_changes"] and d["published"]["number"] == 1
    v2 = admin.post(f"{API}/procedures/{p['id']}/publish").json["published"]
    assert v2["number"] == 2 and v2["changes"]["added"] == ["Extra"]
    assert admin.get(f"{API}/work-orders/{w['id']}").json["procedures"][0]["version"] == 1
    versions = admin.get(f"{API}/procedures/{p['id']}/versions").json["items"]
    assert [v["number"] for v in versions] == [2, 1] and versions[1]["work_order_count"] == 1
    w2 = wo(admin, procedures=[p["id"]])
    assert w2["procedures"][0]["version"] == 2


def test_answers_conditions_scoring_and_completion(admin: Api) -> None:
    p = make(admin)
    w = wo(admin, procedures=[p["id"]])
    run = w["procedures"][0]
    # auto In Progress on the first answer (r074)
    r = ans(admin, w, run, "ppe", value=True)
    assert r.status_code == 200, r.json
    assert admin.get(f"{API}/work-orders/{w['id']}").json["status"] == "in_progress"
    assert ans(admin, w, run, "why", value="leak").status_code == 409  # hidden field
    r = ans(admin, w, run, "oil", value="flag", note="low")
    assert r.json["corrective"]["prompt"]["label"] == "Oil level"
    assert r.json["run"]["progress"]["total"] == 5
    assert ans(admin, w, run, "temp", value=900).status_code == 422
    assert ans(admin, w, run, "kind", value="C").status_code == 422
    assert ans(admin, w, run, "oil", value="maybe").status_code == 422
    # required + conditional required block Done
    done = admin.post(f"{API}/work-orders/{w['id']}/status", {"status": "done"})
    assert done.status_code == 422 and "What's wrong?" in done.json["message"]
    r = ans(admin, w, run, "why", value="seal weeping").json
    assert r["run"]["score"] == 50.0  # ppe 1 + oil flag 1 of 2 + type 0 of 1 (unanswered) → 2 of 4
    assert admin.post(f"{API}/work-orders/{w['id']}/status", {"status": "done"}).status_code == 200
    d = admin.get(f"{API}/work-orders/{w['id']}").json
    assert d["procedures"][0]["status"] == "done"
    assert ans(admin, w, run, "kind", value="A").status_code == 409  # closed
    pdf = admin.get(f"{API}/work-orders/{w['id']}/pdf")
    assert pdf.status_code == 200 and pdf.data[:4] == b"%PDF"


def test_corrective_action_policies(admin: Api) -> None:
    a = asset(admin)
    p = make(admin)
    w = wo(admin, procedures=[p["id"]], asset_id=a["id"])
    run = w["procedures"][0]
    r = ans(admin, w, run, "oil", value="fail").json
    assert r["corrective"]["prompt"]["result"] == "fail"
    c = admin.post(f"{API}/work-orders/{w['id']}/procedures/{run['id']}/corrective", {"field_id": "oil"})
    assert c.status_code == 201
    new = admin.get(f"{API}/work-orders/{c.json['id']}").json
    assert new["asset"]["id"] == a["id"] and new["priority"] == "high"
    assert any(lk["work_order"]["id"] == w["id"] for lk in new["links"])
    # creating again returns the same work order
    assert (
        admin.post(f"{API}/work-orders/{w['id']}/procedures/{run['id']}/corrective", {"field_id": "oil"}).json["id"]
        == c.json["id"]
    )
    assert (
        admin.post(f"{API}/work-orders/{w['id']}/procedures/{run['id']}/corrective", {"field_id": "ppe"}).status_code
        == 409
    )
    # automatic policy
    assert admin.patch(f"{API}/procedures/settings", {"on_fail": "auto"}).status_code == 200
    w2 = wo(admin, procedures=[p["id"]])
    r = ans(admin, w2, w2["procedures"][0], "oil", value="fail").json
    assert r["corrective"]["created"]["number"] > 0
    # none: a comment instead
    admin.patch(f"{API}/procedures/settings", {"on_fail": "none"})
    w3 = wo(admin, procedures=[p["id"]])
    assert ans(admin, w3, w3["procedures"][0], "oil", value="fail").json["corrective"] is None
    acts = admin.get(f"{API}/work-orders/{w3['id']}/activity").json["items"]
    assert any("Oil level" in (x.get("body") or "") for x in acts)
    assert admin.patch(f"{API}/procedures/settings", {"on_fail": "sometimes"}).status_code == 422
    # filter work orders by procedure fails (r085)
    flt = '[{"field":"procedure_result","op":"in","value":["fail"]}]'
    assert admin.get(f"{API}/work-orders?tab=all&filters={flt}").json["total"] == 3


def test_low_score_prompts(admin: Api) -> None:
    schema = {
        "scoring": {"enabled": True, "goal": 90},
        "items": [{"id": "a", "type": "inspection", "label": "A"}, {"id": "b", "type": "inspection", "label": "B"}],
    }
    p = make(admin, "Scored", schema)
    w = wo(admin, procedures=[p["id"]])
    run = w["procedures"][0]
    ans(admin, w, run, "a", value="pass")
    r = ans(admin, w, run, "b", value="flag").json
    assert r["corrective"]["prompt"]["result"] == "flag"
    admin.patch(f"{API}/procedures/settings", {"on_flag": "none"})
    w2 = wo(admin, procedures=[p["id"]])
    ans(admin, w2, w2["procedures"][0], "a", value="pass")
    r = ans(admin, w2, w2["procedures"][0], "b", value="flag").json
    assert r["run"]["score"] == 75.0 and r["corrective"]["prompt"]["result"] == "low_score"


def test_assigned_fields(app: Any, admin: Api) -> None:
    avery = uid(admin, "avery.kim@example.com")
    schema = {
        "items": [
            {"id": "sup", "type": "checkbox", "label": "Supervisor approval", "assignees": [f"user:{avery}"]},
            {"id": "x", "type": "checkbox", "label": "Other"},
        ]
    }
    p = make(admin, "Approval", schema)
    morgan = uid(admin, "morgan.diaz@example.com")
    assert admin.patch(f"{API}/users/{morgan}", {"role": "operator"}).status_code == 200
    w = wo(admin, procedures=[p["id"]], assignees=[f"user:{avery}", f"user:{morgan}"])
    run = w["procedures"][0]
    op = login(app, "morgan.diaz@example.com")  # can fill procedures, but the field is Avery's
    assert ans(op, w, run, "sup", value=True).status_code == 403
    r = admin.post(f"{API}/work-orders/{w['id']}/status", {"status": "done"})
    assert r.status_code == 422 and "Supervisor approval" in r.json["message"]
    tech = login(app, "avery.kim@example.com")
    assert ans(tech, w, run, "sup", value=True).status_code == 200
    assert admin.post(f"{API}/work-orders/{w['id']}/status", {"status": "done"}).status_code == 200


def test_location_check_in_meter_signature_files(admin: Api) -> None:
    plant = loc(admin, "Plant", latitude=39.75, longitude=-84.19)
    m = admin.post(f"{API}/meters", {"name": "Hours", "unit": "hours", "alarm_high": 100}).json
    schema = {
        "items": [
            {"id": "here", "type": "location_check_in", "label": "Check in", "buffer_m": 10, "allow_skip": False},
            {"id": "hrs", "type": "meter_reading", "label": "Hours", "meter_id": m["id"]},
            {"id": "sig", "type": "signature", "label": "Sign"},
            {"id": "pics", "type": "file", "label": "Photos"},
        ]
    }
    p = make(admin, "Visit", schema)
    w = wo(admin, procedures=[p["id"]], location_id=plant["id"])
    run = w["procedures"][0]
    far = ans(admin, w, run, "here", value={"lat": 39.76, "lng": -84.19, "accuracy": 5})
    assert far.status_code == 422 and "m from Plant" in far.json["message"]
    assert ans(admin, w, run, "here", value={"skip": True}).status_code == 422
    assert ans(admin, w, run, "here", value={"lat": 39.75003, "lng": -84.19, "accuracy": 4}).status_code == 200
    r = ans(admin, w, run, "hrs", value={"value": 150}).json
    assert r["run"]["answers"]["hrs"]["result"] == "fail"
    assert admin.get(f"{API}/meters/{m['id']}").json["last_value"] == 150
    # re-answering replaces the reading instead of adding another
    ans(admin, w, run, "hrs", value={"value": 50})
    assert len(admin.get(f"{API}/meters/{m['id']}/readings").json["items"]) == 1
    import base64

    sig = "data:image/png;base64," + base64.b64encode(PNG_1PX).decode()
    r = ans(admin, w, run, "sig", signature=sig, signed_by="Pat")
    assert r.json["run"]["answers"]["sig"]["value"]["name"] == "Pat"
    f = upload(admin)
    assert ans(admin, w, run, "pics", file_ids=[f]).json["run"]["answers"]["pics"]["files"][0]["id"] == f
    # procedure files don't show twice in the WO attachments
    assert all(
        a["role"] not in ("procedure", "procedure_signature")
        for a in admin.get(f"{API}/work-orders/{w['id']}").json["attachments"]
    )


def test_nested_variants_one_off_and_templates(admin: Api) -> None:
    child = make(admin, "Child", {"items": [{"id": "c1", "type": "checkbox", "label": "Child step"}]})
    parent = admin.post(
        f"{API}/procedures",
        {
            "name": "Parent",
            "schema": {
                "items": [
                    {"id": "p1", "type": "checkbox", "label": "Parent step"},
                    {"id": "inc", "type": "procedure", "procedure_id": child["id"]},
                ]
            },
        },
    ).json
    pub = admin.post(f"{API}/procedures/{parent['id']}/publish").json["published"]
    nested = pub["schema"]["items"][1]
    assert nested["items"][0]["id"] == "inc_c1" and nested["label"] == "Child"
    assert (
        admin.patch(
            f"{API}/procedures/{child['id']}",
            {"schema": {"items": [{"type": "procedure", "procedure_id": child["id"]}]}},
        ).status_code
        == 422
    )
    # seasonal variants
    summer = make(admin, "Summer", {"items": [{"type": "checkbox", "label": "S"}]})
    winter = make(admin, "Winter", {"items": [{"type": "checkbox", "label": "W"}]})
    months = list(range(1, 13))
    r = admin.patch(
        f"{API}/procedures/{summer['id']}",
        {"variants": [{"name": "Winter", "months": months, "procedure_id": winter["id"]}]},
    )
    assert r.status_code == 200
    w = wo(admin, procedures=[summer["id"]])
    assert w["procedures"][0]["procedure"]["name"] == "Winter"
    # one-off procedure built in the WO (r210), hidden from the library
    w2 = wo(admin)
    r = admin.post(
        f"{API}/work-orders/{w2['id']}/procedures",
        {"name": "Quick list", "schema": {"items": [{"type": "checkbox", "label": "Do it"}]}},
    )
    assert r.status_code == 201 and r.json["procedure"]["one_off"]
    assert "Quick list" not in [x["name"] for x in admin.get(f"{API}/procedures?status=all").json["items"]]
    # work order templates can carry procedures
    t = admin.post(
        f"{API}/work-order-templates", {"name": "With proc", "data": {"title": "T", "procedures": [child["id"]]}}
    ).json
    nw = admin.post(f"{API}/work-order-templates/{t['id']}/create", {}).json
    assert nw["procedures"][0]["procedure"]["name"] == "Child"
    draft = admin.post(
        f"{API}/procedures", {"name": "Draft", "schema": {"items": [{"type": "checkbox", "label": "x"}]}}
    ).json
    assert (
        admin.post(
            f"{API}/work-order-templates", {"name": "Bad", "data": {"title": "T", "procedures": [draft["id"]]}}
        ).status_code
        == 422
    )
    # built-in templates and copy
    tpl = admin.get(f"{API}/procedures/options").json["templates"]
    assert {x["key"] for x in tpl} >= {"chiller_quarterly", "loto"}
    made = admin.post(f"{API}/procedures", {"template": "loto"}).json
    assert made["name"] == "Lockout / tagout verification"
    cp = admin.post(f"{API}/procedures/{made['id']}/copy").json
    assert cp["name"].startswith("Copy - ")


def test_library_archive_delete_history_analytics_export(app: Any, admin: Api) -> None:
    p = make(admin, "Library item")
    lib = admin.get(f"{API}/procedures?q=library").json
    assert lib["items"][0]["field_count"] == 5 and "Weekly" in lib["tags"]
    admin.post(f"{API}/procedures/{p['id']}/archive")
    assert admin.get(f"{API}/procedures?q=library").json["items"] == []
    assert admin.get(f"{API}/procedures?status=archived").json["items"][0]["id"] == p["id"]
    w = wo(admin)
    assert admin.post(f"{API}/work-orders/{w['id']}/procedures", {"procedure_id": p["id"]}).status_code == 422
    admin.post(f"{API}/procedures/{p['id']}/archive", {"archived": False})
    for v in (70, 72, 75):
        w = wo(admin, procedures=[p["id"]])
        run = w["procedures"][0]
        ans(admin, w, run, "temp", value=v)
        ans(admin, w, run, "oil", value="fail" if v == 75 else "pass")
    an = admin.get(f"{API}/procedures/{p['id']}/analytics").json
    assert an["steps"][0]["label"] == "Oil level" and an["steps"][0]["fail"] == 1
    assert [x["value"] for x in an["numeric"][0]["points"]] == [70, 72, 75]
    assert admin.get(f"{API}/procedures/{p['id']}/history").json["created"] == 3
    ex = admin.post(f"{API}/procedures/export", {"procedure_id": p["id"]})
    assert ex.status_code == 202
    exp = next(e for e in admin.get(f"{API}/exports").json["items"] if e["kind"] == "procedures.csv")
    assert exp["status"] == "ready", exp
    csv_text = admin.get(f"{API}/files/{exp['file']['id']}").data.decode("utf-8-sig")
    assert "Oil level" in csv_text and "Fail" in csv_text and csv_text.count("\n") == 4
    assert admin.get(f"{API}/search?q=library").json["groups"][0]["type"] == "procedures"
    assert admin.delete(f"{API}/procedures/{p['id']}").status_code == 204
    tech = login(app, "avery.kim@example.com")
    assert tech.delete(f"{API}/procedures/{p['id']}").status_code == 403


def test_import_csv_and_pdf(admin: Api) -> None:
    csv_data = b"type,label,options,required\nsection,Electrical,,\ninspection,Check breaker,,yes\nmultiple choice,Panel,A|B|C,\nbogus,X,,\n"
    r = admin.c.post(
        f"{API}/procedures/import",
        data={"file": (io.BytesIO(csv_data), "p.csv")},
        headers=admin._h(),
        content_type="multipart/form-data",
    )
    assert r.status_code == 422 and "unknown type" in r.json["message"]
    csv_data = b"type,label,options,required\nsection,Electrical,,\ninspection,Check breaker,,yes\nmultiple choice,Panel,A|B|C,\n"
    r = admin.c.post(
        f"{API}/procedures/import",
        data={"file": (io.BytesIO(csv_data), "p.csv")},
        headers=admin._h(),
        content_type="multipart/form-data",
    )
    assert r.status_code == 200
    sec = r.json["schema"]["items"][0]
    assert sec["type"] == "section" and sec["items"][0]["required"] and sec["items"][1]["options"] == ["A", "B", "C"]
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for i, line in enumerate(
        [
            "MONTHLY CHECKS:",
            "1. Inspect belts for wear",
            "2. Grease bearings",
            "- Verify guards are in place",
            "Some paragraph text here.",
        ]
    ):
        c.drawString(72, 750 - i * 20, line)
    c.save()
    r = admin.c.post(
        f"{API}/procedures/import",
        data={"file": (io.BytesIO(buf.getvalue()), "p.pdf")},
        headers=admin._h(),
        content_type="multipart/form-data",
    )
    assert r.status_code == 200, r.json
    items = r.json["schema"]["items"]
    assert [i["type"] for i in items] == ["heading", "inspection", "checkbox", "inspection"]
    assert items[1]["label"] == "Inspect belts for wear"


def test_permissions_and_tenancy(app: Any, admin: Api) -> None:
    p = make(admin)
    w = wo(admin, procedures=[p["id"]])
    run = w["procedures"][0]
    viewer = login(app, "quinn.foster@example.com")
    assert viewer.get(f"{API}/procedures").status_code == 200
    assert viewer.post(f"{API}/procedures", {"name": "x"}).status_code == 403
    assert ans(viewer, w, run, "ppe", value=True).status_code == 403
    other = other_org(app)
    assert other.get(f"{API}/procedures/{p['id']}").status_code == 404
    assert other.get(f"{API}/procedures").json["items"] == []
    ow = other.post(f"{API}/work-orders", {"title": "x"}).json
    assert other.post(f"{API}/work-orders/{ow['id']}/procedures", {"procedure_id": p["id"]}).status_code == 404
    assert ans(other, w, run, "ppe", value=True).status_code == 404
    mine = make(other, "Theirs")
    assert admin.post(f"{API}/work-orders/{w['id']}/procedures", {"procedure_id": mine["id"]}).status_code == 404
    # files from another org can't be referenced
    f = upload(other)
    bad = {"items": [{"type": "checkbox", "label": "x", "reference_file_ids": [f]}]}
    assert admin.post(f"{API}/procedures", {"name": "Refs", "schema": bad}).status_code == 422
