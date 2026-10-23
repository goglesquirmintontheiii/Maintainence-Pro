"""Asset Hub (0.5.0, roadmap r115): OEM equipment packages.

A package bundles an asset type, asset custom fields, spare parts, procedures and work order templates for one
manufacturer's model range. Installing it creates what the organization doesn't have yet and links what it does (by
name, case-insensitive), so installing twice is safe and a failed install can simply be retried. Existing assets whose
manufacturer and model match get a suggestion; applying it adds the asset type and links the spare parts.

Built-in packages are the JSON files in `mpro/assets/packages/`. Organizations can import their own in the same format.
"""

from __future__ import annotations

import json
import re
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Any

from sqlalchemy import func, select

from mpro.assets.models import Asset, AssetPackage, AssetPackageMatch, AssetType, AssetTypeLink
from mpro.core.events import emit
from mpro.core.models import iso, utcnow
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization
from mpro.orgs.services import RuleError

PACKAGE_DIR = Path(__file__).parent / "packages"
KEY_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,100}@[0-9A-Za-z.]{1,15}$")
MAX_IMPORT_BYTES = 512 * 1024
LIMITS = {"fields": 30, "parts": 100, "procedures": 20, "templates": 20, "models": 100}
FIELD_TYPES_OK = ("text", "number", "select", "date", "checkbox")


# ---------------------------------------------------------------- package format


def _s(v: Any, n: int) -> str:
    return str(v or "").strip()[:n]


def _norm(model: str) -> str:
    return re.sub(r"[^a-z0-9+]", "", model.lower())


def validate_package(raw: Any) -> dict[str, Any]:
    """Check a package (built-in or imported) and return a cleaned copy. Procedure schemas and templates are checked
    again by their own services when installed."""
    if not isinstance(raw, dict):
        raise RuleError("A package must be a JSON object.", 422)
    key = _s(raw.get("key"), 120)
    if not KEY_RE.match(key):
        raise RuleError("The package needs a key like 'maker-model@1' (lowercase letters, digits, - . _).", 422)
    name, maker = _s(raw.get("name"), 255), _s(raw.get("manufacturer"), 200)
    if not name or not maker:
        raise RuleError("The package needs a name and a manufacturer.", 422)
    models = raw.get("models") or ([raw["model"]] if raw.get("model") else [])
    if not isinstance(models, list) or not models or len(models) > LIMITS["models"]:
        raise RuleError(f"List 1 to {LIMITS['models']} models the package fits.", 422)
    models = [m for m in (_s(x, 200) for x in models) if m]
    out: dict[str, Any] = {
        "key": key,
        "name": name,
        "manufacturer": maker,
        "model": _s(raw.get("model"), 200) or models[0],
        "models": models,
        "version": _s(raw.get("version"), 40) or key.rsplit("@", 1)[1],
        "description": _s(raw.get("description"), 4000),
        "notice": _s(raw.get("notice"), 1000),
    }
    for k, n in LIMITS.items():
        v = raw.get(k) or []
        if not isinstance(v, list) or len(v) > n:
            raise RuleError(f"A package can have up to {n} {k}.", 422)
    at = raw.get("asset_type") or {}
    if not isinstance(at, dict) or not _s(at.get("name"), 80):
        raise RuleError("The package needs an asset type name.", 422)
    color = _s(at.get("color"), 7)
    out["asset_type"] = {"name": _s(at["name"], 80), "color": color if re.fullmatch(r"#[0-9a-fA-F]{6}", color) else ""}
    out["fields"] = []
    for f in raw.get("fields") or []:
        if not isinstance(f, dict) or not _s(f.get("name"), 120) or f.get("type", "text") not in FIELD_TYPES_OK:
            raise RuleError("Each field needs a name and a type (text, number, select, date or checkbox).", 422)
        opts = [_s(o, 120) for o in f.get("options") or []] if f.get("type") == "select" else []
        out["fields"].append({"name": _s(f["name"], 120), "type": f.get("type", "text"), "options": opts})
    out["parts"] = []
    for i, p in enumerate(raw.get("parts") or []):
        if not isinstance(p, dict) or not _s(p.get("name"), 255):
            raise RuleError("Each spare part needs a name.", 422)
        out["parts"].append(
            {
                "key": _s(p.get("key"), 60) or f"part{i}",
                "name": _s(p["name"], 255),
                "part_number": _s(p.get("part_number"), 120),
                "description": _s(p.get("description"), 2000),
                "unit": _s(p.get("unit"), 30) or "each",
                "unit_cost": _s(p.get("unit_cost"), 20) or "0",
            }
        )
    keys: set[str] = set()
    out["procedures"] = []
    for i, p in enumerate(raw.get("procedures") or []):
        if not isinstance(p, dict) or not _s(p.get("name"), 255) or not isinstance(p.get("items"), list):
            raise RuleError("Each procedure needs a name and a list of items.", 422)
        pk = _s(p.get("key"), 60) or f"proc{i}"
        if pk in keys:
            raise RuleError(f"Two procedures share the key {pk}.", 422)
        keys.add(pk)
        out["procedures"].append(
            {
                "key": pk,
                "name": _s(p["name"], 255),
                "description": _s(p.get("description"), 4000),
                "category": _s(p.get("category"), 80),
                "items": p["items"],
            }
        )
    out["templates"] = []
    for t in raw.get("templates") or []:
        if not isinstance(t, dict) or not _s(t.get("name"), 120):
            raise RuleError("Each work order template needs a name.", 422)
        procs = t.get("procedures") or []
        if not isinstance(procs, list) or any(str(x) not in keys for x in procs):
            raise RuleError(f"Template {_s(t['name'], 120)} uses a procedure the package doesn't have.", 422)
        out["templates"].append(
            {
                "name": _s(t["name"], 120),
                "description": _s(t.get("description"), 500),
                "title": _s(t.get("title"), 255) or _s(t["name"], 120),
                "priority": t.get("priority") or "none",
                "work_type": t.get("work_type") or "preventive",
                "estimated_minutes": t.get("estimated_minutes"),
                "procedures": [str(x) for x in procs],
            }
        )
    return out


@lru_cache(maxsize=1)
def builtin_catalogue() -> tuple[dict[str, Any], ...]:
    out = []
    for path in sorted(PACKAGE_DIR.glob("*.json")):
        out.append(validate_package(json.loads(path.read_text("utf-8"))))
    return tuple(out)


# ---------------------------------------------------------------- organization's packages


def sync_builtin(org: Organization) -> None:
    """Make sure the organization sees every built-in package (one row each, so installs and matches can point at
    it). Uninstalled rows pick up newer built-in content."""
    have = {
        p.key: p
        for p in db.session.scalars(
            select(AssetPackage).where(AssetPackage.org_id == org.id, AssetPackage.source == "builtin")
        )
    }
    changed = False
    for c in builtin_catalogue():
        p = have.get(c["key"])
        if p is None:
            db.session.add(_row(org.id, c, "builtin"))
            changed = True
        elif p.installed_at is None and p.contents != c:
            _fill(p, c)
            changed = True
    if changed:
        db.session.commit()


def _fill(p: AssetPackage, c: dict[str, Any]) -> None:
    p.name, p.manufacturer, p.model, p.version = c["name"], c["manufacturer"], c["model"], c["version"]
    p.description, p.contents = c["description"], c


def _row(org_id: uuid.UUID, c: dict[str, Any], source: str) -> AssetPackage:
    p = AssetPackage(org_id=org_id, key=c["key"], source=source, created_records={})
    _fill(p, c)
    return p


def get_package(org_id: uuid.UUID, pid: Any) -> AssetPackage:
    try:
        u = uuid.UUID(str(pid))
    except ValueError:
        u = None
    p = db.session.get(AssetPackage, u) if u else None
    if p is None or p.org_id != org_id or p.deleted_at is not None:
        raise RuleError("That package doesn't exist.", 404)
    return p


def package_dict(p: AssetPackage, detail: bool = False) -> dict[str, Any]:
    c = p.contents or {}
    counts = db.session.execute(
        select(AssetPackageMatch.status, func.count())
        .where(AssetPackageMatch.package_id == p.id)
        .group_by(AssetPackageMatch.status)
    ).all()
    d: dict[str, Any] = {
        "id": str(p.id),
        "key": p.key,
        "name": p.name,
        "manufacturer": p.manufacturer,
        "model": p.model,
        "models": c.get("models", []),
        "version": p.version,
        "description": p.description,
        "notice": c.get("notice", ""),
        "source": p.source,
        "installed": p.installed_at is not None,
        "installed_at": iso(p.installed_at),
        "includes": {k: len(c.get(k) or []) for k in ("fields", "parts", "procedures", "templates")},
        "asset_type": (c.get("asset_type") or {}).get("name", ""),
        "matches": {s: n for s, n in counts},
        "matching_assets": len(_matching_asset_ids(p)),
    }
    if detail:
        d["contents"] = {
            "fields": c.get("fields", []),
            "parts": [
                {k: x[k] for k in ("name", "part_number", "unit", "unit_cost", "description")}
                for x in c.get("parts", [])
            ],
            "procedures": [
                {"name": x["name"], "category": x["category"], "fields": _count_fields(x["items"])}
                for x in c.get("procedures", [])
            ],
            "templates": [
                {k: x[k] for k in ("name", "title", "priority", "work_type")} for x in c.get("templates", [])
            ],
        }
        d["created_records"] = p.created_records or {}
    return d


def _count_fields(items: list[Any]) -> int:
    n = 0
    for it in items:
        if isinstance(it, dict):
            n += _count_fields(it.get("items") or []) if it.get("type") == "section" else 1
    return n


def list_packages(org: Organization) -> list[dict[str, Any]]:
    sync_builtin(org)
    rows = db.session.scalars(
        select(AssetPackage)
        .where(AssetPackage.org_id == org.id, AssetPackage.deleted_at.is_(None))
        .order_by(AssetPackage.manufacturer, AssetPackage.name)
    ).all()
    return [package_dict(p) for p in rows]


def import_package(org: Organization, m: Membership, raw: Any) -> AssetPackage:
    c = validate_package(raw)
    dup = db.session.scalar(
        select(AssetPackage.id).where(
            AssetPackage.org_id == org.id, AssetPackage.key == c["key"], AssetPackage.deleted_at.is_(None)
        )
    )
    if dup:
        raise RuleError(f"There's already a package with the key {c['key']}. Change its key or version.", 409)
    p = _row(org.id, c, "imported")
    db.session.add(p)
    db.session.flush()
    emit(
        "asset_package.imported",
        entity_type="asset_package",
        entity_id=p.id,
        entity_label=p.name,
        summary=f"Imported asset package {p.name}",
        org_id=org.id,
    )
    db.session.commit()
    return p


def delete_package(org: Organization, m: Membership, p: AssetPackage) -> None:
    if p.source == "builtin":
        raise RuleError("Built-in packages can't be deleted.", 409)
    p.deleted_at = utcnow()
    emit(
        "asset_package.deleted",
        entity_type="asset_package",
        entity_id=p.id,
        entity_label=p.name,
        summary=f"Deleted asset package {p.name} (what it installed stays)",
        org_id=org.id,
    )
    db.session.commit()


# ---------------------------------------------------------------- install


def _find(model: Any, org_id: uuid.UUID, name: str, *extra: Any) -> Any:
    return db.session.scalars(
        select(model).where(
            model.org_id == org_id, model.deleted_at.is_(None), func.lower(model.name) == name.lower(), *extra
        )
    ).first()


def install(org: Organization, m: Membership, p: AssetPackage) -> dict[str, Any]:
    """Create or link everything in the package, then suggest it for matching assets. Safe to run again."""
    from mpro.assets.services import save_asset_type
    from mpro.parts.models import Part
    from mpro.parts.services import create_part
    from mpro.procedures import services as psvc
    from mpro.procedures.models import Procedure
    from mpro.workorders.models import CustomField, Template
    from mpro.workorders.services import save_custom_field, save_template

    c = p.contents or {}
    made: dict[str, int] = {"created": 0, "linked": 0}

    def note(new: bool) -> None:
        made["created" if new else "linked"] += 1

    at = c["asset_type"]
    t = _find(AssetType, org.id, at["name"])
    note(t is None)
    if t is None:
        t = save_asset_type(org, {"name": at["name"], **({"color": at["color"]} if at.get("color") else {})})
    field_ids = []
    for f in c.get("fields", []):
        cf = _find(CustomField, org.id, f["name"], CustomField.entity_type == "asset")
        note(cf is None)
        if cf is None:
            cf = save_custom_field(
                org,
                {"name": f["name"], "type": f["type"], "options": f["options"], "scope_id": str(t.id)},
                None,
                "asset",
            )
        field_ids.append(str(cf.id))
    part_ids = []
    for x in c.get("parts", []):
        part = _find(Part, org.id, x["name"])
        note(part is None)
        if part is None:
            part = create_part(org, m, {k: x[k] for k in ("name", "part_number", "description", "unit", "unit_cost")})
        part_ids.append(str(part.id))
    proc_ids: dict[str, str] = {}
    for x in c.get("procedures", []):
        pr = _find(Procedure, org.id, x["name"], Procedure.work_order_id.is_(None))
        note(pr is None)
        if pr is None:
            pr = psvc.create_procedure(
                org,
                m,
                {
                    "name": x["name"],
                    "description": x["description"] or f"From the {p.name} package.",
                    "category": x["category"],
                    "tags": [p.manufacturer[:40]],
                    "schema": {"items": x["items"]},
                },
            )
        if pr.current_version_id is None:
            psvc.publish(org, m, pr)
        proc_ids[x["key"]] = str(pr.id)
    template_ids = []
    for x in c.get("templates", []):
        tpl = _find(Template, org.id, x["name"])
        note(tpl is None)
        if tpl is None:
            data = {k: x[k] for k in ("title", "priority", "work_type", "estimated_minutes") if x.get(k) is not None}
            data["procedures"] = [proc_ids[k] for k in x["procedures"] if k in proc_ids]
            if x.get("description"):
                data["description"] = x["description"]
            tpl = save_template(org, m, {"name": x["name"], "description": x["description"], "data": data})
        template_ids.append(str(tpl.id))
    p.created_records = {
        "asset_type_id": str(t.id),
        "field_ids": field_ids,
        "part_ids": part_ids,
        "procedure_ids": list(proc_ids.values()),
        "template_ids": template_ids,
    }
    first = p.installed_at is None
    p.installed_at, p.installed_by_id = utcnow(), m.user_id
    emit(
        "asset_package.installed",
        entity_type="asset_package",
        entity_id=p.id,
        entity_label=p.name,
        summary=f"Installed asset package {p.name}: {made['created']} created, {made['linked']} already there"
        + ("" if first else " (reinstalled)"),
        data=made,
        org_id=org.id,
    )
    db.session.commit()
    suggested = match_assets(org, p)
    return {**made, "suggested": suggested}


# ---------------------------------------------------------------- matching existing assets


def _matching_asset_ids(p: AssetPackage) -> list[uuid.UUID]:
    models = {_norm(x) for x in (p.contents or {}).get("models", []) if x}
    if not p.manufacturer or not models:
        return []
    rows = db.session.execute(
        select(Asset.id, Asset.model).where(
            Asset.org_id == p.org_id,
            Asset.deleted_at.is_(None),
            func.lower(Asset.manufacturer) == p.manufacturer.lower(),
        )
    ).all()
    return [aid for aid, model in rows if _norm(model or "") in models]


def match_assets(org: Organization, p: AssetPackage) -> int:
    """Suggest an installed package for every matching asset that hasn't seen it yet. Returns how many are new."""
    if p.installed_at is None or p.deleted_at is not None:
        return 0
    have = set(db.session.scalars(select(AssetPackageMatch.asset_id).where(AssetPackageMatch.package_id == p.id)))
    n = 0
    for aid in _matching_asset_ids(p):
        if aid not in have:
            db.session.add(AssetPackageMatch(org_id=org.id, package_id=p.id, asset_id=aid, status="suggested"))
            n += 1
    if n:
        db.session.commit()
    return n


def match_dict(mt: AssetPackageMatch, p: AssetPackage, a: Asset) -> dict[str, Any]:
    c = p.contents or {}
    return {
        "id": str(mt.id),
        "status": mt.status,
        "package": {"id": str(p.id), "name": p.name, "manufacturer": p.manufacturer, "model": p.model},
        "asset": {"id": str(a.id), "name": a.name, "manufacturer": a.manufacturer, "model": a.model},
        "adds": {"asset_type": (c.get("asset_type") or {}).get("name", ""), "parts": len(c.get("parts", []))},
    }


def matches(org: Organization, package: AssetPackage | None = None, asset: Asset | None = None,
            status: str | None = "suggested") -> list[dict[str, Any]]:  # fmt: skip
    if asset is not None:  # pick up packages installed before this asset was added or changed
        for p in db.session.scalars(
            select(AssetPackage).where(
                AssetPackage.org_id == org.id, AssetPackage.deleted_at.is_(None), AssetPackage.installed_at.is_not(None)
            )
        ):
            match_assets(org, p)
    q = (
        select(AssetPackageMatch, AssetPackage, Asset)
        .join(AssetPackage, AssetPackage.id == AssetPackageMatch.package_id)
        .join(Asset, Asset.id == AssetPackageMatch.asset_id)
        .where(AssetPackageMatch.org_id == org.id, AssetPackage.deleted_at.is_(None), Asset.deleted_at.is_(None))
        .order_by(Asset.name)
    )
    if package is not None:
        q = q.where(AssetPackageMatch.package_id == package.id)
    if asset is not None:
        q = q.where(AssetPackageMatch.asset_id == asset.id)
    if status:
        q = q.where(AssetPackageMatch.status == status)
    return [match_dict(mt, p, a) for mt, p, a in db.session.execute(q).all()]


def get_match(org_id: uuid.UUID, mid: Any) -> AssetPackageMatch:
    try:
        u = uuid.UUID(str(mid))
    except ValueError:
        u = None
    mt = db.session.get(AssetPackageMatch, u) if u else None
    if mt is None or mt.org_id != org_id:
        raise RuleError("That suggestion doesn't exist.", 404)
    return mt


def apply_match(org: Organization, m: Membership, mt: AssetPackageMatch) -> None:
    """Give the asset the package's asset type and link its spare parts."""
    from mpro.parts.models import Part, PartAsset

    p = get_package(org.id, mt.package_id)
    a = db.session.get(Asset, mt.asset_id)
    if a is None or a.deleted_at is not None or a.org_id != org.id:
        raise RuleError("That asset doesn't exist.", 404)
    rec = p.created_records or {}
    tid = rec.get("asset_type_id")
    t = db.session.get(AssetType, uuid.UUID(tid)) if tid else None
    if t is not None and t.org_id == org.id and t.deleted_at is None and all(x.type_id != t.id for x in a.type_links):
        a.type_links.append(AssetTypeLink(org_id=org.id, type_id=t.id))
    linked = set(db.session.scalars(select(PartAsset.part_id).where(PartAsset.asset_id == a.id)))
    for raw in rec.get("part_ids", []):
        part = db.session.get(Part, uuid.UUID(raw))
        if part is not None and part.org_id == org.id and part.deleted_at is None and part.id not in linked:
            db.session.add(PartAsset(org_id=org.id, part_id=part.id, asset_id=a.id))
    mt.status = "applied"
    emit(
        "asset.package_applied",
        entity_type="asset",
        entity_id=a.id,
        entity_label=a.name,
        summary=f"Applied asset package {p.name}",
        data={"package_id": str(p.id)},
        org_id=org.id,
    )
    db.session.commit()


def dismiss_match(org: Organization, m: Membership, mt: AssetPackageMatch) -> None:
    mt.status = "dismissed"
    db.session.commit()


# ---------------------------------------------------------------- demo


def seed_demo(org: Organization, m: Membership) -> None:
    """Install the compressor package in the demo and apply it to Air Compressor 1 (Air Compressor 2 keeps its
    suggestion, to show the flow)."""
    sync_builtin(org)
    p = db.session.scalars(
        select(AssetPackage).where(AssetPackage.org_id == org.id, AssetPackage.key == "atlas-copco-ga-30-45@1")
    ).first()
    if p is None or p.installed_at is not None:
        return
    install(org, m, p)
    for mt in db.session.scalars(select(AssetPackageMatch).where(AssetPackageMatch.package_id == p.id)).all():
        a = db.session.get(Asset, mt.asset_id)
        if a is not None and a.name == "Air Compressor 1":
            apply_match(org, m, mt)
