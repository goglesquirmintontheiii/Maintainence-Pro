# ruff: noqa: E501  (long API calls read better on one line)
"""Owner and custom roles, Operator, view-as, job titles, profile photos, uploads, currency fields (0.4.0)."""

from __future__ import annotations

import io
from typing import Any

from tests.conftest import Api
from tests.test_work_orders import PNG_1PX, login, uid

API = "/api/v1"


def invite(owner: Api, email: str, role: str) -> dict[str, Any]:
    r = owner.post(f"{API}/users", {"email": email, "name": email.split("@")[0].title(), "role": role})
    assert r.status_code == 201, r.json
    return r.json  # type: ignore[no-any-return]


def set_password(app: Any, email: str, pw: str = "a-long-password-1") -> None:
    with app.app_context():
        from sqlalchemy import select

        from mpro.auth.models import User
        from mpro.extensions import db

        u = db.session.scalars(select(User).where(User.email == email)).one()
        u.set_password(pw)
        db.session.commit()


def member(app: Any, email: str, role: str, owner: Api, pw: str = "a-long-password-1") -> Api:
    invite(owner, email, role)
    set_password(app, email, pw)
    return login(app, email, pw)


def test_catalogue_and_builtin_roles(admin: Api) -> None:
    cat = admin.get(f"{API}/roles/catalogue").json
    assert {a["id"] for a in cat["areas"]} >= {"wo", "assets", "pm", "procedures"}
    assert any(a["id"] == "org.manage" and a["owner_only"] for a in cat["actions"])
    roles = admin.get(f"{API}/roles").json
    owner = next(r for r in roles if r["id"] == "owner")
    assert owner["members"] == 1 and "org.manage" in owner["permissions"]
    assert next(r for r in roles if r["id"] == "technician")["members"] >= 5


def test_custom_role_lifecycle_and_enforcement(app: Any, admin: Api) -> None:
    r = admin.post(f"{API}/roles", {"name": "Inspector", "base": "technician"})
    assert r.status_code == 201, r.json
    role = r.json
    perms = [p for p in role["permissions"] if p not in ("wo.create",)]
    role = admin.patch(f"{API}/roles/{role['id']}", {"permissions": perms, "description": "Walks the plant"}).json
    assert role["removed"] == ["wo.create"]
    avery = uid(admin, "avery.kim@example.com")
    assert admin.patch(f"{API}/users/{avery}", {"role": role["key"]}).json["role_label"] == "Inspector"
    tech = login(app, "avery.kim@example.com")
    s = tech.session()
    assert s["role"] == "custom" and s["role_label"] == "Inspector" and "wo.create" not in s["permissions"]
    assert tech.post(f"{API}/work-orders", {"title": "x"}).status_code == 403
    assert tech.get(f"{API}/work-orders").status_code == 200
    assert next(x for x in admin.get(f"{API}/roles").json if x["id"] == role["id"])["members"] == 1
    assert admin.get(f"{API}/users?role={role['key']}").json["total"] == 1
    # names are unique and can't shadow built-in roles
    assert admin.post(f"{API}/roles", {"name": "inspector"}).status_code == 409
    assert admin.post(f"{API}/roles", {"name": "Technician"}).status_code == 409
    dup = admin.post(f"{API}/roles/{role['id']}/duplicate").json
    assert dup["name"] == "Copy of Inspector" and dup["permissions"] == role["permissions"]
    # deleting moves people back to the base role
    assert admin.delete(f"{API}/roles/{role['id']}").json["moved"] == 1
    assert tech.session()["role"] == "technician"
    assert admin.post(f"{API}/roles/{role['id']}/restore").json["deleted"] is False
    audit = admin.get(f"{API}/audit?entity_type=role").json["items"]
    assert {"role.created", "role.updated", "role.deleted", "role.restored"} <= {e["type"] for e in audit}


def test_no_privilege_escalation(app: Any, admin: Api) -> None:
    # owner-only permissions never go into custom roles
    assert admin.post(f"{API}/roles", {"name": "Boss", "permissions": ["org.manage"]}).status_code == 422
    assert admin.post(f"{API}/roles", {"name": "Bad", "permissions": ["nope.nope"]}).status_code == 422
    settings_role = admin.post(
        f"{API}/roles", {"name": "Asset admin", "base": "technician", "permissions": ["assets.view", "assets.settings"]}
    ).json
    # only owners manage roles
    adm = member(app, "second.admin@example.com", "admin", admin)
    assert adm.post(f"{API}/roles", {"name": "Mine"}).status_code == 403
    assert adm.patch(f"{API}/roles/{settings_role['id']}", {"name": "x"}).status_code == 403
    # a limited admin can't hand out a role with permissions they don't have
    jordan = login(app, "jordan.reyes@example.com")
    r = jordan.post(f"{API}/users", {"email": "new.tech@example.com", "role": settings_role["key"]})
    assert r.status_code == 403
    tech_only = admin.post(f"{API}/roles", {"name": "Reader", "base": "viewer"}).json
    assert jordan.post(f"{API}/users", {"email": "reader@example.com", "role": tech_only["key"]}).status_code == 201
    # admins can't make owners; only owners can
    harper = uid(admin, "harper.lewis@example.com")
    assert adm.patch(f"{API}/users/{harper}", {"role": "owner"}).status_code == 403
    assert jordan.patch(f"{API}/users/{harper}", {"role": "admin"}).status_code == 403
    # a technician can't change their own role
    tech = login(app, "avery.kim@example.com")
    assert tech.patch(f"{API}/users/{uid(admin, 'avery.kim@example.com')}", {"role": "admin"}).status_code == 403
    # the owner can't be removed or demoted by an admin
    me = admin.session()["user"]["id"]
    assert adm.delete(f"{API}/users/{me}").status_code == 403
    assert adm.patch(f"{API}/org", {"name": "Taken over"}).status_code == 403


def test_owner_rules_and_transfer(app: Any, admin: Api) -> None:
    me = admin.session()["user"]["id"]
    assert admin.patch(f"{API}/users/{me}", {"role": "admin"}).status_code == 409  # last owner
    harper = uid(admin, "harper.lewis@example.com")
    assert admin.post(f"{API}/org/transfer-ownership", {"user_id": me}).status_code == 422
    r = admin.post(f"{API}/org/transfer-ownership", {"user_id": harper})
    assert r.status_code == 200 and r.json["role"] == "owner"
    assert admin.session()["role"] == "admin"
    assert admin.patch(f"{API}/org", {"name": "Nope"}).status_code == 403
    new_owner = login(app, "harper.lewis@example.com")
    assert new_owner.patch(f"{API}/org", {"name": "Acme Renamed"}).status_code == 200
    # a second owner, then the first can step down
    assert new_owner.patch(f"{API}/users/{me}", {"role": "owner"}).json["role"] == "owner"
    assert new_owner.patch(f"{API}/users/{harper}", {"role": "technician"}).status_code == 200


def test_operator_sees_only_assigned_work(app: Any, admin: Api) -> None:
    op = member(app, "op@example.com", "operator", admin)
    op_id = op.session()["user"]["id"]
    mine = admin.post(f"{API}/work-orders", {"title": "For the operator", "assignees": [f"user:{op_id}"]}).json
    other = admin.post(f"{API}/work-orders", {"title": "Not theirs"}).json
    listed = {w["id"] for w in op.get(f"{API}/work-orders?tab=all").json["items"]}
    assert mine["id"] in listed and other["id"] not in listed
    assert op.get(f"{API}/work-orders/{other['id']}").status_code == 404
    assert op.post(f"{API}/work-orders", {"title": "x"}).status_code == 403
    assert op.patch(f"{API}/work-orders/{mine['id']}", {"title": "renamed"}).status_code == 403
    assert op.post(f"{API}/work-orders/{mine['id']}/status", {"status": "in_progress"}).status_code == 200
    assert op.post(f"{API}/work-orders/{mine['id']}/time", {"minutes": 15}).status_code == 201


def test_custom_role_limited_visibility(app: Any, admin: Api) -> None:
    role = admin.post(
        f"{API}/roles", {"name": "Contractor", "base": "technician", "settings": {"wo_visibility": "limited"}}
    ).json
    c = member(app, "contractor@example.com", role["key"], admin)
    admin.post(f"{API}/work-orders", {"title": "Hidden from contractors"})
    assert c.get(f"{API}/work-orders?tab=all").json["total"] == 0


def test_view_as(admin: Api) -> None:
    v = admin.get(f"{API}/roles/view-as?role=operator").json
    assert v["work_orders"].startswith("Only")
    wo_area = next(a for a in v["areas"] if a["id"] == "wo")
    assert "Change work order status" in wo_area["can"] and "Create work orders" in wo_area["cannot"]
    person = admin.get(f"{API}/roles/view-as?user={uid(admin, 'quinn.foster@example.com')}").json
    assert person["person"] == "Quinn Foster" and "wo.create" not in person["permissions"]
    assert admin.get(f"{API}/roles/view-as?role=wizard").status_code == 422


def test_roles_are_per_organization(app: Any, admin: Api) -> None:
    from tests.test_assets import other_org

    role = admin.post(f"{API}/roles", {"name": "Inspector"}).json
    other = other_org(app)
    assert other.get(f"{API}/roles/{role['id']}").status_code == 404
    assert other.post(f"{API}/users", {"email": "x@example.com", "role": role["key"]}).status_code == 404
    assert all(r["id"] != role["id"] for r in other.get(f"{API}/roles").json)


def test_job_titles(app: Any, admin: Api) -> None:
    me = admin.session()["user"]["id"]
    assert admin.patch(f"{API}/users/{me}", {"job_title": "Plant Manager"}).json["job_title"] == "Plant Manager"
    tech = login(app, "avery.kim@example.com")
    avery = tech.session()["user"]["id"]
    assert tech.patch(f"{API}/users/{avery}", {"job_title": "Chief"}).status_code == 403
    assert tech.patch(f"{API}/users/{avery}", {"name": "Avery K"}).status_code == 200


def _jpeg(w: int = 400, h: int = 300) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (w, h), (30, 90, 200)).save(out, "JPEG", exif=b"Exif\x00\x00II*\x00")
    return out.getvalue()


def test_profile_photos(app: Any, admin: Api) -> None:
    r = admin.c.post(
        f"{API}/auth/avatar",
        data={"file": (io.BytesIO(_jpeg()), "me.jpg")},
        headers=admin._h(),
        content_type="multipart/form-data",
    )
    assert r.status_code == 200, r.json
    url = r.json["user"]["avatar_url"]
    assert url and url.startswith(f"{API}/users/")
    img = admin.get(url)
    assert img.status_code == 200 and img.mimetype == "image/webp"
    from PIL import Image

    im = Image.open(io.BytesIO(img.data))
    assert im.size == (256, 256) and "exif" not in im.info
    me = admin.session()["user"]["id"]
    assert admin.get(f"{API}/users/{me}").json["avatar_url"] == url
    wo = admin.post(f"{API}/work-orders", {"title": "x", "assignees": [f"user:{me}"]}).json
    assert wo["assignees"][0]["avatar_url"] == url and wo["created_by"]["avatar_url"] == url
    # members of the org can see it; other organizations can't
    tech = login(app, "avery.kim@example.com")
    assert tech.get(url).status_code == 200
    from tests.test_assets import other_org

    assert other_org(app).get(url).status_code == 404
    bad = admin.c.post(
        f"{API}/auth/avatar",
        data={"file": (io.BytesIO(b"not an image"), "x.png")},
        headers=admin._h(),
        content_type="multipart/form-data",
    )
    assert bad.status_code == 422
    assert admin.delete(f"{API}/auth/avatar").json["user"]["avatar_url"] is None
    assert admin.get(url).status_code == 404


def test_upload_limit_and_streaming(app: Any, admin: Api) -> None:
    assert app.config["MPRO_MAX_UPLOAD_MB"] == 150
    app.config["MPRO_MAX_UPLOAD_MB"] = 1
    big = b"%PDF-1.4\n" + b"x" * (1024 * 1024 + 10)
    r = admin.c.post(
        f"{API}/files",
        data={"file": (io.BytesIO(big), "manual.pdf")},
        headers=admin._h(),
        content_type="multipart/form-data",
    )
    assert r.status_code == 413 and "1 MB" in r.json["message"]
    app.config["MPRO_MAX_UPLOAD_MB"] = 150
    data = b"%PDF-1.4\n" + b"y" * (3 * 1024 * 1024)
    r = admin.c.post(
        f"{API}/files",
        data={"file": (io.BytesIO(data), "manual.pdf")},
        headers=admin._h(),
        content_type="multipart/form-data",
    )
    assert r.status_code == 201 and r.json["size"] == len(data)
    assert admin.get(f"{API}/files/{r.json['id']}").data == data
    with app.app_context():
        import hashlib
        import uuid as _uuid

        from mpro.core.files import FileObject
        from mpro.extensions import db

        assert db.session.get(FileObject, _uuid.UUID(r.json["id"])).sha256 == hashlib.sha256(data).hexdigest()
    png = admin.c.post(
        f"{API}/files",
        data={"file": (io.BytesIO(PNG_1PX), "a.png")},
        headers=admin._h(),
        content_type="multipart/form-data",
    )
    assert png.status_code == 201 and png.json["content_type"] == "image/png"


def test_currency_custom_fields(admin: Api) -> None:
    f = admin.post(f"{API}/custom-fields", {"name": "Quote", "type": "currency"}).json
    a = admin.post(f"{API}/work-orders", {"title": "A", "custom": {f["id"]: "1,250.5"}}).json
    assert a["custom"][f["id"]] == "1250.50"
    admin.post(f"{API}/work-orders", {"title": "B", "custom": {f["id"]: 99.999}})
    assert admin.post(f"{API}/work-orders", {"title": "C", "custom": {f["id"]: "lots"}}).status_code == 422
    flt = '[{"field":"custom.' + f["id"] + '","op":"between","value":["500","2000"]}]'
    items = admin.get(f"{API}/work-orders?tab=all&filters={flt}").json["items"]
    assert [w["title"] for w in items] == ["A"]
    af = admin.post(
        f"{API}/custom-fields", {"entity_type": "asset", "name": "Replacement quote", "type": "currency"}
    ).json
    asset = admin.post(f"{API}/assets", {"name": "Pump", "custom": {af["id"]: "-12.5"}}).json
    assert asset["custom"][af["id"]] == "-12.50"


def test_warranty_documents(admin: Api) -> None:
    up = admin.c.post(
        f"{API}/files",
        data={"file": (io.BytesIO(b"%PDF-1.4\nwarranty"), "warranty.pdf")},
        headers=admin._h(),
        content_type="multipart/form-data",
    ).json
    a = admin.post(f"{API}/assets", {"name": "Chiller", "warranty_file_ids": [up["id"]]}).json
    assert [x["name"] for x in a["warranty"]["files"]] == ["warranty.pdf"]
    later = admin.c.post(
        f"{API}/files",
        data={
            "file": (io.BytesIO(b"%PDF-1.4\nterms"), "terms.pdf"),
            "entity_type": "asset",
            "entity_id": a["id"],
            "role": "warranty",
        },
        headers=admin._h(),
        content_type="multipart/form-data",
    )
    assert later.status_code == 201
    assert len(admin.get(f"{API}/assets/{a['id']}").json["warranty"]["files"]) == 2
