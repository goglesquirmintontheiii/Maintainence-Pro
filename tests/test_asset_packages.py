# ruff: noqa: E501
"""Asset Hub packages (0.5.0, r115): catalogue, install, matching, apply/dismiss, import, admin only."""

from __future__ import annotations

import io
import json
from typing import Any

from tests.conftest import Api
from tests.test_work_orders import login

API = "/api/v1"


def _pkg(admin: Api, key: str) -> dict[str, Any]:
    return next(p for p in admin.get(f"{API}/asset-packages").json["items"] if p["key"] == key)


def _asset(admin: Api, name: str, manufacturer: str, model: str) -> str:
    r = admin.post(f"{API}/assets", {"name": name, "manufacturer": manufacturer, "model": model})
    assert r.status_code == 201, r.json
    return r.json["id"]  # type: ignore[no-any-return]


def test_builtin_catalogue_is_valid() -> None:
    from mpro.assets.asset_hub import builtin_catalogue

    cat = builtin_catalogue()
    assert 3 <= len(cat) <= 5
    for c in cat:
        assert c["parts"] and c["procedures"] and c["templates"] and c["models"]
        assert all(not p["part_number"] for p in c["parts"])  # no invented OEM part numbers


def test_install_match_apply_dismiss(app: Any, admin: Api) -> None:
    ga1 = _asset(admin, "Compressor A", "Atlas Copco", "GA 37 VSD+")
    ga2 = _asset(admin, "Compressor B", "atlas copco", "ga37")  # case and spacing don't matter
    other = _asset(admin, "Compressor C", "Atlas Copco", "GA 90")
    pkg = _pkg(admin, "atlas-copco-ga-30-45@1")
    assert not pkg["installed"] and pkg["matching_assets"] == 2
    # a part with the same name already exists: it's linked, not duplicated
    pre = admin.post(f"{API}/parts", {"name": "Compressor oil filter"})
    assert pre.status_code == 201, pre.json
    r = admin.post(f"{API}/asset-packages/{pkg['id']}/install")
    assert r.status_code == 200, r.json
    res, detail = r.json["result"], r.json["package"]
    assert res["suggested"] == 2 and res["linked"] == 1
    rec = detail["created_records"]
    assert pre.json["id"] in rec["part_ids"] and len(rec["part_ids"]) == 5
    assert len(rec["procedure_ids"]) == 2 and len(rec["template_ids"]) == 2 and len(rec["field_ids"]) == 3
    # the procedures are published and the templates use them
    procs = {p["id"]: p for p in admin.get(f"{API}/procedures").json["items"]}
    assert all(procs[i]["status"] == "published" for i in rec["procedure_ids"])
    tpls = admin.get(f"{API}/work-order-templates").json
    tpls = tpls.get("items", tpls) if isinstance(tpls, dict) else tpls
    svc = next(t for t in tpls if t["name"] == "Compressor 2,000 h service")
    assert svc["data"]["procedures"] == [rec["procedure_ids"][1]]
    # installing again creates nothing new
    again = admin.post(f"{API}/asset-packages/{pkg['id']}/install").json["result"]
    assert again["created"] == 0 and again["suggested"] == 0
    # suggestions on the matching asset pages only
    s1 = admin.get(f"{API}/assets/{ga1}/package-suggestions").json["items"]
    assert len(s1) == 1 and s1[0]["package"]["id"] == pkg["id"]
    assert admin.get(f"{API}/assets/{other}/package-suggestions").json["items"] == []
    assert admin.post(f"{API}/asset-package-matches/{s1[0]['id']}/apply").json["status"] == "applied"
    a = admin.get(f"{API}/assets/{ga1}").json
    assert "Air compressor" in [t["name"] for t in a["types"]]
    with app.app_context():
        import uuid

        from sqlalchemy import select

        from mpro.extensions import db
        from mpro.parts.models import PartAsset

        linked = set(db.session.scalars(select(PartAsset.part_id).where(PartAsset.asset_id == uuid.UUID(ga1))))
        assert {str(x) for x in linked} == set(rec["part_ids"])
    s2 = admin.get(f"{API}/assets/{ga2}/package-suggestions").json["items"]
    assert admin.post(f"{API}/asset-package-matches/{s2[0]['id']}/dismiss").json["status"] == "dismissed"
    assert admin.get(f"{API}/assets/{ga2}/package-suggestions").json["items"] == []
    assert admin.get(f"{API}/asset-package-matches").json["items"] == []
    # an asset added later picks up the installed package
    ga3 = _asset(admin, "Compressor D", "Atlas Copco", "GA 45")
    assert len(admin.get(f"{API}/assets/{ga3}/package-suggestions").json["items"]) == 1
    audit = admin.get(f"{API}/audit?entity_type=asset_package").json["items"]
    assert "asset_package.installed" in {e["type"] for e in audit}


def test_import_validation_and_permissions(app: Any, admin: Api) -> None:
    good = {
        "key": "acme-pump-x1@1",
        "name": "Acme X1 pump",
        "manufacturer": "Acme",
        "models": ["X1"],
        "asset_type": {"name": "Pump"},
        "parts": [{"name": "X1 seal kit"}],
        "procedures": [
            {"key": "chk", "name": "X1 check", "items": [{"id": "ok", "type": "checkbox", "label": "Runs quietly"}]}
        ],
        "templates": [{"name": "X1 check", "procedures": ["chk"]}],
    }
    r = admin.post(f"{API}/asset-packages", good)
    assert r.status_code == 201, r.json
    assert r.json["source"] == "imported"
    assert admin.post(f"{API}/asset-packages", good).status_code == 409
    bad_tpl = {**good, "key": "acme-pump-x1@2", "templates": [{"name": "t", "procedures": ["missing"]}]}
    assert admin.post(f"{API}/asset-packages", bad_tpl).status_code == 422
    assert admin.post(f"{API}/asset-packages", {**good, "key": "Bad Key"}).status_code == 422
    # a bad procedure schema fails on install and leaves the package uninstalled
    broken = {
        **good,
        "key": "acme-pump-x1@3",
        "templates": [],
        "procedures": [{"key": "p", "name": "Broken", "items": [{"type": "nope", "label": "x"}]}],
    }
    pid = admin.post(f"{API}/asset-packages", broken).json["id"]
    assert admin.post(f"{API}/asset-packages/{pid}/install").status_code == 422
    assert admin.get(f"{API}/asset-packages/{pid}").json["installed"] is False
    # file upload works too, and is size-limited
    data = json.dumps({**good, "key": "acme-pump-x1@4"}).encode()
    up = admin.c.post(
        f"{API}/asset-packages",
        data={"file": (io.BytesIO(data), "p.json")},
        headers=admin._h(),
        content_type="multipart/form-data",
    )
    assert up.status_code == 201, up.json
    big = admin.c.post(
        f"{API}/asset-packages",
        data={"file": (io.BytesIO(b" " * 600_000), "p.json")},
        headers=admin._h(),
        content_type="multipart/form-data",
    )
    assert big.status_code == 413
    # built-ins can't be deleted; imported ones can
    builtin = _pkg(admin, "trane-cgam@1")
    assert admin.delete(f"{API}/asset-packages/{builtin['id']}").status_code == 409
    assert admin.delete(f"{API}/asset-packages/{up.json['id']}").status_code == 204
    # admin only
    tech = login(app, "avery.kim@example.com")
    assert tech.get(f"{API}/asset-packages").status_code == 403
    assert tech.post(f"{API}/asset-packages/{builtin['id']}/install").status_code == 403
    assert tech.post(f"{API}/asset-packages", {**good, "key": "acme-pump-x1@9"}).status_code == 403


def test_packages_are_per_org(app: Any, admin: Api) -> None:
    from tests.test_assets import other_org

    other = other_org(app)
    theirs = _pkg(other, "carrier-48fc@1")
    mine = _pkg(admin, "carrier-48fc@1")
    assert theirs["id"] != mine["id"]
    _asset(other, "Their RTU", "Carrier", "48FC")
    assert other.post(f"{API}/asset-packages/{theirs['id']}/install").json["result"]["suggested"] == 1
    their_match = other.get(f"{API}/asset-package-matches").json["items"][0]["id"]
    assert admin.get(f"{API}/asset-packages/{theirs['id']}").status_code == 404
    assert admin.post(f"{API}/asset-packages/{theirs['id']}/install").status_code == 404
    assert admin.post(f"{API}/asset-package-matches/{their_match}/apply").status_code == 404
    assert admin.post(f"{API}/asset-package-matches/{their_match}/dismiss").status_code == 404
    assert admin.get(f"{API}/asset-package-matches").json["items"] == []
    assert _pkg(admin, "carrier-48fc@1")["installed"] is False


def test_demo_installs_compressor_package(app: Any) -> None:
    with app.app_context():
        from sqlalchemy import select

        from mpro.assets.models import AssetPackage
        from mpro.demo import _seed_work
        from mpro.extensions import db
        from mpro.orgs.models import Organization

        org = db.session.scalars(select(Organization)).first()
        assert org is not None
        _seed_work(org)
        p = db.session.scalars(select(AssetPackage).where(AssetPackage.key == "atlas-copco-ga-30-45@1")).one()
        assert p.installed_at is not None
