# ruff: noqa: E501
"""Requests from 0.5 testing (0.6.0): floor plan label styles (MP-132)."""

from __future__ import annotations

from typing import Any

from tests.conftest import Api
from tests.test_files_viewer import _plan

API = "/api/v1"


def _put(admin: Api, url: str, shapes: list[dict[str, Any]], version: int) -> Any:
    return admin.c.put(url, json={"annotations": {"shapes": shapes}, "version": version}, headers=admin._h())


def test_floor_plan_label_font_and_outline_are_kept(admin: Api) -> None:
    plant, fp = _plan(admin)
    url = f"{API}/locations/{plant['id']}/floor-plans/{fp['id']}/annotations"
    t = {
        "id": "t1",
        "type": "text",
        "x": 0.2,
        "y": 0.2,
        "text": "Boiler room",
        "font_size": 30,
        "stroke": "#334155",
        "font": "serif",
        "bold": False,
        "italic": True,
        "outline": "#ffffff",
        "outline_width": 6,
    }
    r = _put(
        admin,
        url,
        [t, {**t, "id": "t2", "font": "mono", "bold": True, "italic": False, "outline": "none", "outline_width": 0}],
        0,
    )
    assert r.status_code == 200, r.json
    a, b = r.json["annotations"]["shapes"]
    assert (a["font"], a["bold"], a["italic"], a["outline"], a["outline_width"]) == ("serif", False, True, "#ffffff", 6)
    assert (b["font"], b["bold"], b["outline"], b["outline_width"]) == ("mono", True, "none", 0)
    for bad in ({"font": "Comic Sans"}, {"outline": "white"}, {"outline_width": 99}):
        assert _put(admin, url, [{**t, **bad}], 1).status_code == 422, bad
    # older labels without the new keys still save and keep their look
    old = {"id": "t3", "type": "text", "x": 0.1, "y": 0.1, "text": "Exit", "font_size": 18}
    r = _put(admin, url, [old], 1)
    assert r.status_code == 200 and "font" not in r.json["annotations"]["shapes"][0]


# ---- vendor PO acknowledgment (r261) ---------------------------------------------------------------
def _sent_po(app: Any, admin: Api, email: str = "pat@vendor.example") -> tuple[dict[str, Any], str]:
    import re

    from tests.test_purchasing import po
    from tests.test_vendors import last_email, vendor

    v = vendor(admin, contacts=[{"name": "Pat", "email": email, "is_po_contact": True}])
    d = po(admin, v)
    r = admin.post(f"{API}/purchase-orders/{d['id']}/send", {})
    assert r.status_code == 200, r.json
    body = last_email(app, email)["body"]
    m = re.search(r"http://mpro\.test/v/([A-Za-z0-9_-]+)", body)
    assert m, body
    return d, m.group(1)


def _anon(app: Any, ip: str) -> Any:
    c = app.test_client()
    c.environ_base["REMOTE_ADDR"] = ip
    return c


def test_vendor_sees_po_and_acknowledges_without_login(app: Any, admin: Api) -> None:
    d, token = _sent_po(app, admin)
    c = _anon(app, "10.6.0.1")
    v = c.get(f"{API}/vendor-po/{token}")
    assert v.status_code == 200, v.json
    assert v.json["number"] == d["display_number"] and v.json["organization"]
    assert v.json["lines"][0]["description"] == "Gloves" and v.json["total"]
    assert "requested_by" not in v.json and "approvals" not in v.json  # only what the vendor needs
    r = c.post(
        f"{API}/vendor-po/{token}/respond",
        json={"response": "acknowledged", "name": "Pat at Vendor", "note": "Ships Monday"},
    )
    assert r.status_code == 200, r.json
    ack = admin.get(f"{API}/purchase-orders/{d['id']}").json["vendor_ack"]
    assert (
        ack["response"] == "acknowledged" and ack["responder_name"] == "Pat at Vendor" and ack["note"] == "Ships Monday"
    )
    assert admin.get(f"{API}/purchase-orders/{d['id']}").json["vendor_ack"]["last_viewed_at"]


def test_vendor_proposes_a_date_or_declines(app: Any, admin: Api) -> None:
    d, token = _sent_po(app, admin)
    c = _anon(app, "10.6.0.2")
    assert (
        c.post(f"{API}/vendor-po/{token}/respond", json={"response": "proposed_date", "name": "Pat"}).status_code == 422
    )  # needs a date
    r = c.post(
        f"{API}/vendor-po/{token}/respond",
        json={"response": "proposed_date", "name": "Pat", "date": "2030-01-15", "note": "Backordered"},
    )
    assert r.status_code == 200, r.json
    ack = admin.get(f"{API}/purchase-orders/{d['id']}").json["vendor_ack"]
    assert ack["response"] == "proposed_date" and ack["proposed_date"] == "2030-01-15"
    assert (
        c.post(f"{API}/vendor-po/{token}/respond", json={"response": "declined", "name": "Pat"}).status_code == 422
    )  # needs a note
    r = c.post(f"{API}/vendor-po/{token}/respond", json={"response": "declined", "name": "Pat", "note": "Discontinued"})
    assert (
        r.status_code == 200
        and admin.get(f"{API}/purchase-orders/{d['id']}").json["vendor_ack"]["response"] == "declined"
    )
    assert c.post(f"{API}/vendor-po/{token}/respond", json={"response": "maybe", "name": "Pat"}).status_code == 422


def test_vendor_link_stops_when_complete_canceled_or_resent(app: Any, admin: Api) -> None:
    d, token = _sent_po(app, admin)
    c = _anon(app, "10.6.0.3")
    # sending again replaces the link
    r = admin.post(f"{API}/purchase-orders/{d['id']}/send", {})
    assert r.status_code == 200
    import re

    from tests.test_vendors import last_email

    token2 = re.search(r"/v/([A-Za-z0-9_-]+)", last_email(app, "pat@vendor.example")["body"]).group(1)  # type: ignore[union-attr]
    assert token2 != token
    assert c.get(f"{API}/vendor-po/{token}").status_code == 404
    assert c.get(f"{API}/vendor-po/{token2}").status_code == 200
    admin.post(f"{API}/purchase-orders/{d['id']}/cancel", {"reason": "Not needed"})
    assert c.get(f"{API}/vendor-po/{token2}").status_code == 404
    assert c.get(f"{API}/vendor-po/not-a-real-token").status_code == 404


def test_vendor_link_rate_limited_and_no_session_needed(app: Any, admin: Api) -> None:
    c = _anon(app, "10.6.0.9")
    codes = [c.get(f"{API}/vendor-po/wrong-{i}").status_code for i in range(25)]
    assert codes[0] == 404 and 429 in codes


def test_vendor_ack_is_per_org(app: Any, admin: Api) -> None:
    from tests.test_assets import other_org

    d, _token = _sent_po(app, admin)
    other = other_org(app)
    assert other.get(f"{API}/purchase-orders/{d['id']}").status_code == 404
