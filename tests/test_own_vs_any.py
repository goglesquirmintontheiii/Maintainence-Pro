# ruff: noqa: E501
""" "Own only" permissions (0.5.0, MP-130): wo.edit_own, wo.delete_own, assets.manage_own, procedures.manage_own,
po.manage_own. Own = created by the person, or assigned to them / their team (assets: their team is in charge)."""

from __future__ import annotations

from typing import Any

from tests.conftest import Api
from tests.test_roles import member
from tests.test_work_orders import login, team_id, uid

API = "/api/v1"
PAIRS = {
    "wo.edit": "wo.edit_own",
    "wo.delete": "wo.delete_own",
    "assets.manage": "assets.manage_own",
    "procedures.manage": "procedures.manage_own",
}


def own_only_member(app: Any, admin: Api, email: str = "own.only@example.com") -> Api:
    """A technician-based custom role where every pair is "own only"."""
    tech = next(r for r in admin.get(f"{API}/roles").json if r["id"] == "technician")["permissions"]
    perms = sorted((set(tech) - set(PAIRS)) | set(PAIRS.values()))
    r = admin.post(f"{API}/roles", {"name": "Own only", "base": "technician", "permissions": perms})
    assert r.status_code == 201, r.json
    m = member(app, email, "technician", admin)
    assert admin.patch(f"{API}/users/{uid(admin, email)}", {"role": r.json["key"]}).status_code == 200
    return m


def test_builtin_roles_unchanged(app: Any, admin: Api) -> None:
    from mpro.core.permissions import ACTIONS, OWN_ACTIONS

    for any_, own in OWN_ACTIONS.items():
        assert ACTIONS[own] == ACTIONS[any_]  # built-in roles hold both halves, so nothing changes for them
    tech = login(app, "avery.kim@example.com")
    other = admin.post(f"{API}/work-orders", {"title": "Someone else's"}).json
    assert tech.patch(f"{API}/work-orders/{other['id']}", {"title": "Edited by tech"}).status_code == 200
    s = tech.session()
    assert "wo.edit" in s["permissions"] and "wo.edit_own" in s["permissions"]


def test_work_orders_own_vs_any(app: Any, admin: Api) -> None:
    me = own_only_member(app, admin)
    my_id = me.session()["user"]["id"]
    s = me.session()
    assert "wo.edit" not in s["permissions"] and "wo.edit_own" in s["permissions"]
    mine = me.post(f"{API}/work-orders", {"title": "Created by me"}).json
    assigned = admin.post(f"{API}/work-orders", {"title": "Assigned to me", "assignees": [f"user:{my_id}"]}).json
    # assigned to my team
    tid = team_id(admin, "Mechanical")
    assert admin.post(f"{API}/teams/{tid}/members", {"user_id": my_id}).status_code in (200, 201, 204)
    team_wo = admin.post(f"{API}/work-orders", {"title": "For my team", "assignees": [f"team:{tid}"]}).json
    foreign = admin.post(f"{API}/work-orders", {"title": "Not mine"}).json
    for w in (mine, assigned, team_wo):
        r = me.patch(f"{API}/work-orders/{w['id']}", {"description": "ok"})
        assert r.status_code == 200, (w["title"], r.json)
        assert me.get(f"{API}/work-orders/{w['id']}").json["you"]["edit"] is True
    assert me.patch(f"{API}/work-orders/{foreign['id']}", {"description": "nope"}).status_code == 403
    d = me.get(f"{API}/work-orders/{foreign['id']}").json  # still visible, just not editable
    assert d["you"] == {"edit": False, "delete": False}
    assert me.delete(f"{API}/work-orders/{foreign['id']}").status_code == 403
    assert me.delete(f"{API}/work-orders/{mine['id']}").status_code in (200, 204)
    # bulk: each work order is checked on its own
    r = me.post(
        f"{API}/work-orders/bulk", {"ids": [assigned["id"], foreign["id"]], "action": "set_priority", "value": "high"}
    )
    assert r.status_code == 200, r.json
    assert assigned["id"] in r.json["updated"] and foreign["id"] in [e["id"] for e in r.json["errors"]]
    assert admin.get(f"{API}/work-orders/{foreign['id']}").json["priority"] != "high"


def test_assets_and_procedures_own_vs_any(app: Any, admin: Api) -> None:
    me = own_only_member(app, admin)
    mine = me.post(f"{API}/assets", {"name": "My pump"})
    assert mine.status_code == 201, mine.json
    theirs = admin.post(f"{API}/assets", {"name": "Their pump"}).json
    tid = team_id(admin, "Mechanical")
    my_id = me.session()["user"]["id"]
    admin.post(f"{API}/teams/{tid}/members", {"user_id": my_id})
    in_charge = admin.post(f"{API}/assets", {"name": "Team pump", "teams": [tid]}).json
    assert me.patch(f"{API}/assets/{mine.json['id']}", {"description": "x"}).status_code == 200
    assert me.patch(f"{API}/assets/{in_charge['id']}", {"description": "x"}).status_code == 200
    assert me.patch(f"{API}/assets/{theirs['id']}", {"description": "x"}).status_code == 403
    assert me.get(f"{API}/assets/{theirs['id']}").json["you"]["edit"] is False
    r = me.post(
        f"{API}/assets/bulk",
        {"ids": [mine.json["id"], theirs["id"]], "action": "edit", "patch": {"criticality": "critical"}},
    )
    assert r.json["done"] == [mine.json["id"]] and r.json["failed"][0]["id"] == theirs["id"]
    # procedures
    schema = {"items": [{"id": "a", "type": "checkbox", "label": "Done"}]}
    p_mine = me.post(f"{API}/procedures", {"name": "My checklist", "schema": schema})
    assert p_mine.status_code == 201, p_mine.json
    p_theirs = admin.post(f"{API}/procedures", {"name": "Their checklist", "schema": schema}).json
    assert me.patch(f"{API}/procedures/{p_mine.json['id']}", {"description": "x"}).status_code == 200
    assert me.patch(f"{API}/procedures/{p_theirs['id']}", {"description": "x"}).status_code == 403


def test_role_catalogue_and_granting(app: Any, admin: Api) -> None:
    cat = admin.get(f"{API}/roles/catalogue").json["actions"]
    by = {a["id"]: a for a in cat}
    for any_, own in {**PAIRS, "po.manage": "po.manage_own"}.items():
        if any_ in by:
            assert by[any_]["own"] == own and by[own]["own_of"] == any_
    # "any" covers "own": a role saved with just wo.edit edits every work order
    r = admin.post(
        f"{API}/roles", {"name": "Editors", "base": "technician", "permissions": ["wo.view", "wo.edit"]}
    ).json
    assert "wo.edit" in r["permissions"]
    # someone who can't edit at all can't grant either half
    viewer = member(app, "lim.admin@example.com", "limited_admin", admin)
    if "wo.edit" not in viewer.session()["permissions"]:
        assert viewer.post(f"{API}/roles", {"name": "X", "permissions": ["wo.edit_own"]}).status_code == 403


def test_permission_helpers() -> None:
    from types import SimpleNamespace

    from mpro.core.permissions import can_on, can_some, is_own

    class Rec:
        __tablename__ = "purchase_orders"

        def __init__(self, org: str, created: str | None = None, requested: str | None = None) -> None:
            self.org_id, self.created_by_id, self.requested_by_id = org, created, requested

    m = SimpleNamespace(org_id="o1", user_id="u1", role="technician", custom_role=None, permissions=None)
    assert is_own(m, Rec("o1", created="u1")) and is_own(m, Rec("o1", requested="u1"))
    assert not is_own(m, Rec("o1", created="u2")) and not is_own(m, Rec("o2", created="u1"))
    assert can_some(m, "wo.edit") and can_on(m, "wo.edit", Rec("o1", created="u2"))
