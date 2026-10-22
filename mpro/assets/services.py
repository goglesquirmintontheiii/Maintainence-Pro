"""Location and asset business rules (0.3.0)."""

from __future__ import annotations

import re
import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select

from mpro.assets.models import (
    ASSET_STATUS_LABELS,
    ASSET_STATUSES,
    CRITICALITY,
    DISPOSAL_METHODS,
    DOWNTIME_TYPES,
    Asset,
    AssetStatusChange,
    AssetType,
    AssetTypeLink,
    CatalogEntry,
    FloorPlan,
    FloorPlanPin,
    Location,
    TeamInCharge,
)
from mpro.core import hierarchy
from mpro.core.events import emit
from mpro.core.files import FileObject, attach
from mpro.core.ids import uuid7
from mpro.core.models import utcnow
from mpro.core.settings import get_settings, register_defaults, save_settings
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization, Team
from mpro.orgs.services import RuleError

ASSET_SETTINGS: dict[str, Any] = {
    "status_reasons": {
        "online": [],
        "offline": ["Breakdown", "Preventive maintenance", "Waiting on parts", "Changeover", "Power outage"],
        "do_not_track": ["Seasonal shutdown", "Out of service"],
    },
    "max_depth": 0,  # 0 = unlimited (MaintainX lets admins cap the hierarchy depth)
    "ask_status_on_work_orders": True,
}
register_defaults("assets", ASSET_SETTINGS)

# A starter list like MaintainX's default manufacturers; organizations add their own (r108).
DEFAULT_MANUFACTURERS = sorted(
    {
        "A.O. Smith",
        "AAON",
        "ABB",
        "Allen-Bradley",
        "APC",
        "Armstrong",
        "Atlas Copco",
        "Baldor",
        "Bell & Gossett",
        "Bobcat",
        "Bosch",
        "Brother",
        "Carrier",
        "Caterpillar",
        "Club Car",
        "Crown",
        "Cummins",
        "Daikin",
        "Danfoss",
        "Doosan",
        "E-Z-GO",
        "Eaton",
        "Emerson",
        "Fanuc",
        "Fluke",
        "Generac",
        "Genie",
        "Goodman",
        "Greenheck",
        "Grundfos",
        "Hobart",
        "Honeywell",
        "Hoshizaki",
        "Hyster",
        "Ingersoll Rand",
        "John Deere",
        "Johnson Controls",
        "JLG",
        "Kaeser",
        "Kohler",
        "KONE",
        "Kubota",
        "Lennox",
        "Liebert",
        "Lincoln Electric",
        "Lochinvar",
        "Manitowoc",
        "Marathon",
        "Miller",
        "Mitsubishi Electric",
        "Mueller",
        "Otis",
        "Parker Hannifin",
        "Quincy",
        "Raymond",
        "Rheem",
        "Rockwell Automation",
        "Schindler",
        "Schneider Electric",
        "Siemens",
        "SKF",
        "Square D",
        "Sullair",
        "Taco",
        "TK Elevator",
        "Toro",
        "Toshiba",
        "Toyota",
        "Trane",
        "True Manufacturing",
        "Viessmann",
        "Weil-McLain",
        "WEG",
        "Xylem",
        "Yale",
        "Yamaha",
        "Yaskawa",
        "York",
        "Zebra",
    }
)


# ---- helpers ---------------------------------------------------------------------------------
def asset_settings(org_id: uuid.UUID) -> dict[str, Any]:
    return get_settings(org_id, "assets")


def _uuid(v: Any, what: str) -> uuid.UUID:
    try:
        return v if isinstance(v, uuid.UUID) else uuid.UUID(str(v))
    except ValueError as e:
        raise RuleError(f"That {what} doesn't exist.", 422) from e


def _date(v: Any, field: str) -> date | None:
    if v in (None, ""):
        return None
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError as e:
        raise RuleError(f"{field} must be a date (YYYY-MM-DD).", 422) from e


def _int(v: Any, field: str, lo: int = 0, hi: int = 10**12) -> int | None:
    if v in (None, ""):
        return None
    try:
        n = int(v)
    except (TypeError, ValueError) as e:
        raise RuleError(f"{field} must be a whole number.", 422) from e
    if not lo <= n <= hi:
        raise RuleError(f"{field} must be between {lo:,} and {hi:,}.", 422)
    return n


def _str(v: Any, n: int) -> str:
    return str(v or "").strip()[:n]


def get_location(org_id: uuid.UUID, lid: Any) -> Location:
    loc = db.session.scalars(
        select(Location).where(
            Location.org_id == org_id, Location.id == _uuid(lid, "location"), Location.deleted_at.is_(None)
        )
    ).first()
    if loc is None:
        raise RuleError("That location doesn't exist.", 422)
    return loc


def get_asset(org_id: uuid.UUID, aid: Any) -> Asset:
    a = db.session.scalars(
        select(Asset).where(Asset.org_id == org_id, Asset.id == _uuid(aid, "asset"), Asset.deleted_at.is_(None))
    ).first()
    if a is None:
        raise RuleError("That asset doesn't exist.", 422)
    return a


def _set_teams(org_id: uuid.UUID, entity_type: str, entity_id: uuid.UUID, ids: list[Any]) -> list[str]:
    want: list[uuid.UUID] = []
    for raw in ids or []:
        tid = _uuid(raw, "team")
        if not db.session.scalar(
            select(Team.id).where(Team.org_id == org_id, Team.id == tid, Team.deleted_at.is_(None))
        ):
            raise RuleError("One of the teams doesn't exist.", 422)
        if tid not in want:
            want.append(tid)
    have = db.session.scalars(
        select(TeamInCharge).where(TeamInCharge.entity_type == entity_type, TeamInCharge.entity_id == entity_id)
    ).all()
    for t in have:
        if t.team_id not in want:
            db.session.delete(t)
    have_ids = {t.team_id for t in have}
    for tid in want:
        if tid not in have_ids:
            db.session.add(TeamInCharge(org_id=org_id, entity_type=entity_type, entity_id=entity_id, team_id=tid))
    return sorted(str(t) for t in want)


def teams_of(entity_type: str, ids: list[uuid.UUID]) -> dict[uuid.UUID, list[dict[str, Any]]]:
    if not ids:
        return {}
    rows = db.session.scalars(
        select(TeamInCharge).where(TeamInCharge.entity_type == entity_type, TeamInCharge.entity_id.in_(ids))
    ).all()
    out: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for r in rows:
        if r.team.deleted_at is None:
            out.setdefault(r.entity_id, []).append({"id": str(r.team.id), "name": r.team.name, "color": r.team.color})
    return out


def _attach_files(
    org_id: uuid.UUID, m: Membership, entity_type: str, entity_id: uuid.UUID, file_ids: list[Any], role: str
) -> None:
    for fid in file_ids or []:
        f = db.session.get(FileObject, _uuid(fid, "file"))
        if f is None or f.org_id != org_id or f.deleted_at is not None or f.uploaded_by_id != m.user_id:
            raise RuleError("One of the files couldn't be found. Upload it again.", 422)
        attach(f, entity_type, entity_id, role)


# ---- locations -------------------------------------------------------------------------------
LOCATION_FIELDS = (
    "name",
    "description",
    "address_line1",
    "address_line2",
    "city",
    "region",
    "postal_code",
    "country",
    "latitude",
    "longitude",
)


def _apply_location(loc: Location, data: dict[str, Any]) -> None:
    if "name" in data:
        name = _str(data["name"], 300)
        if not name:
            raise RuleError("The location needs a name.", 422)
        if len(name) > 255:
            raise RuleError("Names can be up to 255 characters.", 422)
        loc.name = name
    if "description" in data:
        loc.description = str(data["description"] or "")[:4096]
    for k, n in (
        ("address_line1", 200),
        ("address_line2", 200),
        ("city", 120),
        ("region", 120),
        ("postal_code", 30),
        ("country", 80),
    ):
        if k in data:
            setattr(loc, k, _str(data[k], n))
    for k, lim in (("latitude", 90.0), ("longitude", 180.0)):
        if k in data:
            v = data[k]
            if v in (None, ""):
                setattr(loc, k, None)
                continue
            try:
                f = float(v)
            except (TypeError, ValueError) as e:
                raise RuleError(f"{k.title()} must be a number.", 422) from e
            if not -lim <= f <= lim:
                raise RuleError(f"{k.title()} must be between -{lim:g} and {lim:g}.", 422)
            setattr(loc, k, f)


def location_label(loc: Location) -> str:
    return loc.name


def create_location(org: Organization, m: Membership, data: dict[str, Any]) -> Location:
    from mpro.workorders.services import _clean_custom

    loc = Location(id=uuid7(), org_id=org.id, name="", description="", custom={}, created_by_id=m.user_id)
    for k in ("address_line1", "address_line2", "city", "region", "postal_code", "country"):
        setattr(loc, k, "")
    _apply_location(
        loc, {"name": data.get("name", ""), **{k: data[k] for k in LOCATION_FIELDS if k in data and k != "name"}}
    )
    parent = get_location(org.id, data["parent_id"]) if data.get("parent_id") else None
    loc.parent_id = parent.id if parent else None
    loc.custom = _clean_custom(org.id, data.get("custom") or {}, entity_type="location")
    db.session.add(loc)
    db.session.flush()
    hierarchy.add_node(org.id, "location", loc.id, loc.parent_id)
    _set_teams(org.id, "location", loc.id, data.get("teams") or [])
    _attach_files(org.id, m, "location", loc.id, data.get("file_ids") or [], "photo")
    emit(
        "location.created",
        entity_type="location",
        entity_id=loc.id,
        entity_label=loc.name,
        summary=f"Created location {loc.name}",
    )
    db.session.commit()
    return loc


def update_location(org: Organization, m: Membership, loc: Location, data: dict[str, Any]) -> Location:
    from mpro.workorders.services import _clean_custom

    before = {k: getattr(loc, k) for k in (*LOCATION_FIELDS, "parent_id")}
    before["custom"] = dict(loc.custom or {})
    _apply_location(loc, {k: data[k] for k in LOCATION_FIELDS if k in data})
    if "parent_id" in data:
        new_parent = get_location(org.id, data["parent_id"]).id if data["parent_id"] else None
        if new_parent != loc.parent_id:
            try:
                hierarchy.move_node(org.id, "location", loc.id, new_parent)
            except hierarchy.TreeError as e:
                raise RuleError(e.message, 422) from e
            loc.parent_id = new_parent
    if "custom" in data:
        loc.custom = _clean_custom(org.id, data["custom"] or {}, loc.custom, entity_type="location")
    teams_changed = None
    if "teams" in data:
        teams_changed = _set_teams(org.id, "location", loc.id, data["teams"] or [])
    after = {k: getattr(loc, k) for k in (*LOCATION_FIELDS, "parent_id")}
    after["custom"] = dict(loc.custom or {})
    changes = {k: (before[k], after[k]) for k in after if before[k] != after[k]}
    if changes or teams_changed is not None:
        emit(
            "location.updated",
            entity_type="location",
            entity_id=loc.id,
            entity_label=loc.name,
            summary="Changed " + (", ".join(k.replace("_", " ") for k in changes) or "teams in charge"),
            changes=changes,
        )
    db.session.commit()
    return loc


def delete_location(org: Organization, m: Membership, loc: Location) -> None:
    sub = hierarchy.subtree_ids("location", loc.id)
    n_assets = db.session.scalar(
        select(func.count()).select_from(Asset).where(Asset.location_id.in_(sub), Asset.deleted_at.is_(None))
    )
    children = db.session.scalar(
        select(func.count()).select_from(Location).where(Location.parent_id == loc.id, Location.deleted_at.is_(None))
    )
    if children:
        raise RuleError("Move or delete the sub-locations first.", 409)
    if n_assets:
        raise RuleError(f"{n_assets} asset{'s are' if n_assets != 1 else ' is'} still here. Move them first.", 409)
    loc.deleted_at = utcnow()
    emit(
        "location.deleted",
        entity_type="location",
        entity_id=loc.id,
        entity_label=loc.name,
        summary=f"Deleted location {loc.name}",
    )
    db.session.commit()


def restore_location(org: Organization, loc: Location) -> None:
    if loc.parent_id:
        parent = db.session.get(Location, loc.parent_id)
        if parent is None or parent.deleted_at is not None:
            hierarchy.move_node(org.id, "location", loc.id, None)
            loc.parent_id = None
    loc.deleted_at = None
    emit(
        "location.restored",
        entity_type="location",
        entity_id=loc.id,
        entity_label=loc.name,
        summary=f"Restored location {loc.name}",
    )
    db.session.commit()


# ---- floor plans -----------------------------------------------------------------------------
def add_floor_plan(org: Organization, m: Membership, loc: Location, name: str, file_id: Any) -> FloorPlan:
    f = db.session.get(FileObject, _uuid(file_id, "file"))
    if f is None or f.org_id != org.id or f.deleted_at is not None or f.uploaded_by_id != m.user_id or not f.is_image:
        raise RuleError("Upload the floor plan as a PNG, JPG or WebP image.", 422)
    n = (
        db.session.scalar(
            select(func.count())
            .select_from(FloorPlan)
            .where(FloorPlan.location_id == loc.id, FloorPlan.deleted_at.is_(None))
        )
        or 0
    )
    fp = FloorPlan(org_id=org.id, location_id=loc.id, name=_str(name, 120) or f"Floor {n + 1}", file_id=f.id, sort=n)
    db.session.add(fp)
    attach(f, "location", loc.id, "floor_plan")
    db.session.flush()
    emit(
        "location.floor_plan_added",
        entity_type="location",
        entity_id=loc.id,
        entity_label=loc.name,
        summary=f"Added floor plan {fp.name}",
    )
    db.session.commit()
    return fp


def set_pin(org: Organization, fp: FloorPlan, data: dict[str, Any], pin: FloorPlanPin | None = None) -> FloorPlanPin:
    try:
        x, y = float(data.get("x", pin.x if pin else -1)), float(data.get("y", pin.y if pin else -1))
    except (TypeError, ValueError) as e:
        raise RuleError("Pins need x and y.", 422) from e
    if not (0 <= x <= 1 and 0 <= y <= 1):
        raise RuleError("Pins must be on the plan.", 422)
    asset_id = pin.asset_id if pin else None
    if "asset_id" in data:
        asset_id = get_asset(org.id, data["asset_id"]).id if data["asset_id"] else None
    label = _str(data.get("label", pin.label if pin else ""), 120)
    if not asset_id and not label:
        raise RuleError("Pick an asset or type a label for the pin.", 422)
    created = pin is None
    if pin is None:
        pin = FloorPlanPin(org_id=org.id, floor_plan_id=fp.id, x=x, y=y)
        db.session.add(pin)
    pin.x, pin.y, pin.asset_id, pin.label = x, y, asset_id, label
    db.session.flush()
    what = label or (db.session.get(Asset, asset_id).name if asset_id else "")  # type: ignore[union-attr]
    emit(
        "location.pin_saved",
        entity_type="location",
        entity_id=fp.location_id,
        entity_label=fp.name,
        summary=("Added" if created else "Moved") + f" pin {what} on {fp.name}",
    )
    db.session.commit()
    return pin


# ---- asset types and catalog -----------------------------------------------------------------
def _check_type_name(org_id: uuid.UUID, name: str, exclude: uuid.UUID | None = None) -> str:
    name = _str(name, 80)
    if not name:
        raise RuleError("The asset type needs a name.", 422)
    q = select(AssetType.id).where(
        AssetType.org_id == org_id, AssetType.deleted_at.is_(None), func.lower(AssetType.name) == name.lower()
    )
    if exclude:
        q = q.where(AssetType.id != exclude)
    if db.session.scalar(q):
        raise RuleError(f"There's already an asset type called {name}.", 409)
    return name


def save_asset_type(org: Organization, data: dict[str, Any], t: AssetType | None = None) -> AssetType:
    created = t is None
    if t is None:
        t = AssetType(org_id=org.id, name="", color="#5d6880")
        db.session.add(t)
    if "name" in data or created:
        t.name = _check_type_name(org.id, str(data.get("name", "")), t.id if not created else None)
    if "color" in data:
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", str(data["color"])):
            raise RuleError("Use a colour like #1b5bd4.", 422)
        t.color = str(data["color"])
    db.session.flush()
    emit(
        "asset_type.created" if created else "asset_type.updated",
        entity_type="asset_type",
        entity_id=t.id,
        entity_label=t.name,
        summary=("Created" if created else "Changed") + f" asset type {t.name}",
    )
    db.session.commit()
    return t


def delete_asset_type(org: Organization, t: AssetType) -> None:
    t.deleted_at = utcnow()
    emit(
        "asset_type.deleted",
        entity_type="asset_type",
        entity_id=t.id,
        entity_label=t.name,
        summary=f"Deleted asset type {t.name}",
    )
    db.session.commit()


def catalog(org_id: uuid.UUID, manufacturer: str | None = None) -> dict[str, Any]:
    if manufacturer is None:
        own = db.session.scalars(
            select(CatalogEntry.name).where(CatalogEntry.org_id == org_id, CatalogEntry.kind == "manufacturer")
        ).all()
        used = db.session.scalars(
            select(Asset.manufacturer).where(Asset.org_id == org_id, Asset.manufacturer != "").distinct()
        ).all()
        names = sorted({*DEFAULT_MANUFACTURERS, *own, *used}, key=str.lower)
        return {"manufacturers": names}
    own_m = db.session.scalars(
        select(CatalogEntry.name).where(
            CatalogEntry.org_id == org_id,
            CatalogEntry.kind == "model",
            func.lower(CatalogEntry.parent) == manufacturer.lower(),
        )
    ).all()
    used_m = db.session.scalars(
        select(Asset.model)
        .where(Asset.org_id == org_id, func.lower(Asset.manufacturer) == manufacturer.lower(), Asset.model != "")
        .distinct()
    ).all()
    return {"models": sorted({*own_m, *used_m}, key=str.lower)}


def add_catalog_entry(org: Organization, kind: str, name: str, parent: str = "") -> None:
    if kind not in ("manufacturer", "model"):
        raise RuleError("Add a manufacturer or a model.", 422)
    name, parent = _str(name, 120), _str(parent, 120)
    if not name or (kind == "model" and not parent):
        raise RuleError("Type a name" + (" and pick the manufacturer." if kind == "model" else "."), 422)
    exists = db.session.scalar(
        select(CatalogEntry.id).where(
            CatalogEntry.org_id == org.id,
            CatalogEntry.kind == kind,
            func.lower(CatalogEntry.parent) == parent.lower(),
            func.lower(CatalogEntry.name) == name.lower(),
        )
    )
    if not exists:
        db.session.add(CatalogEntry(org_id=org.id, kind=kind, name=name, parent=parent))
        db.session.commit()


# ---- assets ----------------------------------------------------------------------------------
ASSET_FIELDS = (
    "name",
    "description",
    "criticality",
    "manufacturer",
    "model",
    "serial_number",
    "year",
    "barcode",
    "commissioned_on",
    "expected_life_years",
    "replacement_year",
    "replacement_cost_cents",
    "disposed_on",
    "disposal_method",
    "disposal_value_cents",
    "disposal_notes",
    "warranty_start",
    "warranty_end",
    "warranty_provider",
    "warranty_terms",
    "purchase_price_cents",
    "purchase_date",
    "useful_life_years",
    "salvage_value_cents",
    "depreciation_start",
)
FINANCIAL_FIELDS = {"purchase_price_cents", "salvage_value_cents", "replacement_cost_cents", "disposal_value_cents"}


def _apply_asset(org_id: uuid.UUID, a: Asset, data: dict[str, Any]) -> None:
    if "name" in data:
        name = _str(data["name"], 300)
        if not name:
            raise RuleError("The asset needs a name.", 422)
        if len(name) > 255:
            raise RuleError("Names can be up to 255 characters.", 422)
        a.name = name
    if "description" in data:
        a.description = str(data["description"] or "")[:20000]
    if "criticality" in data:
        if (data["criticality"] or "") not in CRITICALITY:
            raise RuleError("Criticality is Critical, Important or Normal.", 422)
        a.criticality = data["criticality"] or ""
    for k, n in (
        ("manufacturer", 120),
        ("model", 120),
        ("serial_number", 120),
        ("barcode", 200),
        ("warranty_provider", 200),
    ):
        if k in data:
            setattr(a, k, _str(data[k], n))
    for k in ("disposal_notes", "warranty_terms"):
        if k in data:
            setattr(a, k, str(data[k] or "")[:20000])
    if "year" in data:
        a.year = _int(data["year"], "Year", 1800, 2200)
    for k, label in (("expected_life_years", "Expected life"), ("useful_life_years", "Useful life")):
        if k in data:
            setattr(a, k, _int(data[k], label, 0, 200))
    if "replacement_year" in data:
        a.replacement_year = _int(data["replacement_year"], "Replacement year", 1900, 2300)
    for k in FINANCIAL_FIELDS:
        if k in data:
            setattr(a, k, _int(data[k], k.replace("_cents", "").replace("_", " ").capitalize(), 0, 10**13))
    for k in (
        "commissioned_on",
        "disposed_on",
        "warranty_start",
        "warranty_end",
        "purchase_date",
        "depreciation_start",
    ):
        if k in data:
            setattr(a, k, _date(data[k], k.replace("_", " ").capitalize()))
    if "disposal_method" in data:
        if (data["disposal_method"] or "") not in DISPOSAL_METHODS:
            raise RuleError("Disposal is sold, scrapped, recycled, donated or other.", 422)
        a.disposal_method = data["disposal_method"] or ""
    if a.warranty_start and a.warranty_end and a.warranty_start > a.warranty_end:
        raise RuleError("The warranty must start before it ends.", 422)
    if a.salvage_value_cents and a.purchase_price_cents is not None and a.salvage_value_cents > a.purchase_price_cents:
        raise RuleError("Salvage value can't be more than the purchase price.", 422)


def _check_parent(org_id: uuid.UUID, a: Asset, parent_id: Any) -> uuid.UUID | None:
    if not parent_id:
        return None
    parent = get_asset(org_id, parent_id)
    if parent.id == a.id:
        raise RuleError("An asset can't be its own parent.", 422)
    max_depth = int(asset_settings(org_id)["max_depth"] or 0)
    if max_depth:
        height = hierarchy.subtree_height("asset", a.id) if a.id and db.session.get(Asset, a.id) else 0
        if hierarchy.depth_of("asset", parent.id) + 1 + height > max_depth - 1:
            raise RuleError(f"Your organization allows asset trees {max_depth} levels deep.", 422)
    return parent.id


def _set_types(a: Asset, ids: list[Any]) -> None:
    want: list[uuid.UUID] = []
    for raw in ids or []:
        tid = _uuid(raw, "asset type")
        if not db.session.scalar(
            select(AssetType.id).where(
                AssetType.org_id == a.org_id, AssetType.id == tid, AssetType.deleted_at.is_(None)
            )
        ):
            raise RuleError("One of the asset types doesn't exist.", 422)
        if tid not in want:
            want.append(tid)
    for link in list(a.type_links):
        if link.type_id not in want:
            a.type_links.remove(link)
    have = {link.type_id for link in a.type_links}
    for tid in want:
        if tid not in have:
            a.type_links.append(AssetTypeLink(org_id=a.org_id, type_id=tid))


def _scope_custom(a: Asset) -> None:
    """Keep only custom values for fields that apply to this asset's types (type-limited fields)."""
    from mpro.workorders.models import CustomField

    if not a.custom:
        return
    scoped = dict(
        db.session.execute(
            select(CustomField.id, CustomField.scope_id).where(
                CustomField.org_id == a.org_id, CustomField.entity_type == "asset", CustomField.scope_id.is_not(None)
            )
        ).all()
    )
    mine = {link.type_id for link in a.type_links}
    a.custom = {k: v for k, v in a.custom.items() if scoped.get(uuid.UUID(k)) is None or scoped[uuid.UUID(k)] in mine}


def new_asset(org_id: uuid.UUID, **kw: Any) -> Asset:
    base: dict[str, Any] = {
        "id": uuid7(),
        "org_id": org_id,
        "name": "",
        "description": "",
        "criticality": "",
        "manufacturer": "",
        "model": "",
        "serial_number": "",
        "barcode": "",
        "custom": {},
        "status": "online",
        "status_reason": "",
        "downtime_type": "",
        "status_changed_at": utcnow(),
        "disposal_method": "",
        "disposal_notes": "",
        "warranty_provider": "",
        "warranty_terms": "",
        "version": 1,
    }
    base.update(kw)
    return Asset(**base)


def create_asset(org: Organization, m: Membership, data: dict[str, Any], commit: bool = True) -> Asset:
    from mpro.core.permissions import can
    from mpro.workorders.services import _clean_custom

    if not can(m, "assets.financials"):
        data = {k: v for k, v in data.items() if k not in FINANCIAL_FIELDS}
    a = new_asset(org.id, created_by_id=m.user_id)
    _apply_asset(
        org.id, a, {"name": data.get("name", ""), **{k: data[k] for k in ASSET_FIELDS if k in data and k != "name"}}
    )
    a.location_id = get_location(org.id, data["location_id"]).id if data.get("location_id") else None
    a.parent_id = _check_parent(org.id, a, data.get("parent_id"))
    if a.parent_id and not a.location_id:
        a.location_id = db.session.get(Asset, a.parent_id).location_id  # type: ignore[union-attr]
    a.custom = _clean_custom(org.id, data.get("custom") or {}, entity_type="asset")
    if data.get("status"):
        if data["status"] not in ASSET_STATUSES:
            raise RuleError("Status is Online, Offline or Do Not Track.", 422)
        a.status = data["status"]
    a.status_changed_by_id = m.user_id
    db.session.add(a)
    db.session.flush()
    _set_types(a, data.get("types") or [])
    _scope_custom(a)
    hierarchy.add_node(org.id, "asset", a.id, a.parent_id)
    db.session.add(
        AssetStatusChange(org_id=org.id, asset_id=a.id, from_status="", to_status=a.status, actor_id=m.user_id)
    )
    _set_teams(org.id, "asset", a.id, data.get("teams") or [])
    _attach_files(org.id, m, "asset", a.id, data.get("file_ids") or [], "photo")
    _attach_files(org.id, m, "asset", a.id, data.get("warranty_file_ids") or [], "warranty")  # MP-114
    emit("asset.created", entity_type="asset", entity_id=a.id, entity_label=a.name, summary=f"Created asset {a.name}")
    if commit:
        db.session.commit()
    return a


def _snap(a: Asset) -> dict[str, Any]:
    d = {k: getattr(a, k) for k in ASSET_FIELDS}
    d.update(
        {
            "location_id": a.location_id,
            "parent_id": a.parent_id,
            "custom": dict(a.custom or {}),
            "types": sorted(str(t.type_id) for t in a.type_links),
        }
    )
    return d


def update_asset(
    org: Organization, m: Membership, a: Asset, data: dict[str, Any], expected_version: int | None = None
) -> Asset:
    from mpro.core.permissions import can
    from mpro.workorders.services import _clean_custom

    if a.deleted_at is not None:
        raise RuleError("This asset was deleted. Restore it before editing.", 409)
    if expected_version is not None and expected_version != a.version:
        raise RuleError("Someone else changed this asset. Reload and try again.", 409)
    if not can(m, "assets.financials") and FINANCIAL_FIELDS & set(data):
        raise RuleError("You can't change asset costs and values.", 403)
    before = _snap(a)
    _apply_asset(org.id, a, {k: data[k] for k in ASSET_FIELDS if k in data})
    if "location_id" in data:
        a.location_id = get_location(org.id, data["location_id"]).id if data["location_id"] else None
    if "parent_id" in data and str(data["parent_id"] or "") != str(a.parent_id or ""):
        new_parent = _check_parent(org.id, a, data["parent_id"])
        if new_parent != a.parent_id:
            try:
                hierarchy.move_node(org.id, "asset", a.id, new_parent)
            except hierarchy.TreeError as e:
                raise RuleError(e.message, 422) from e
            a.parent_id = new_parent
    if "types" in data:
        _set_types(a, data["types"] or [])
    if "custom" in data:
        a.custom = _clean_custom(org.id, data["custom"] or {}, a.custom, entity_type="asset")
    if "custom" in data or "types" in data:
        _scope_custom(a)
    teams = None
    if "teams" in data:
        teams = _set_teams(org.id, "asset", a.id, data["teams"] or [])
    after = _snap(a)
    changes = {k: (before[k], after[k]) for k in after if before[k] != after[k]}
    if changes or teams is not None:
        a.version += 1
        emit(
            "asset.updated",
            entity_type="asset",
            entity_id=a.id,
            entity_label=a.name,
            summary="Changed "
            + (
                ", ".join(k.replace("_cents", "").replace("_id", "").replace("_", " ") for k in changes)
                or "teams in charge"
            ),
            changes=changes,
        )
    db.session.commit()
    return a


# (org, member, asset, from status, to status) — registered by mpro.automations (0.4.0)
ASSET_STATUS_HOOKS: list[Callable[[Organization, Membership, Asset, str, str], None]] = []


def set_status(
    org: Organization,
    m: Membership,
    a: Asset,
    status: str,
    *,
    reason: str = "",
    downtime_type: str = "",
    note: str = "",
    apply_to_children: bool = False,
    work_order_id: uuid.UUID | None = None,
    at: datetime | None = None,
    commit: bool = True,
) -> Asset:
    if status not in ASSET_STATUSES:
        raise RuleError("Status is Online, Offline or Do Not Track.", 422)
    reasons = asset_settings(org.id)["status_reasons"].get(status, [])
    reason = _str(reason, 80)
    if reason and reasons and reason not in reasons:
        raise RuleError(f"Pick one of the reasons for {ASSET_STATUS_LABELS[status]}.", 422)
    if downtime_type not in DOWNTIME_TYPES:
        raise RuleError("Downtime is planned or unplanned.", 422)
    if status != "offline":
        downtime_type = ""
    elif not downtime_type:
        downtime_type = "unplanned"
    when = at or utcnow()
    if when > utcnow() + timedelta(minutes=5):
        raise RuleError("A status change can't be in the future.", 422)
    if at is not None:
        # history must stay in order: a back-dated change can't go before the latest recorded change
        latest = db.session.scalar(select(func.max(AssetStatusChange.at)).where(AssetStatusChange.asset_id == a.id))
        if (latest and when < latest) or when < a.created_at:
            raise RuleError("The time must be after the asset's last status change.", 422)
    targets = [a]
    if apply_to_children:
        ids = db.session.scalars(hierarchy.subtree_ids("asset", a.id)).all()
        targets = list(db.session.scalars(select(Asset).where(Asset.id.in_(ids), Asset.deleted_at.is_(None))).all())
    for t in targets:
        if t.status == status and t.status_reason == reason and t.downtime_type == downtime_type:
            continue
        db.session.add(
            AssetStatusChange(
                org_id=org.id,
                asset_id=t.id,
                from_status=t.status,
                to_status=status,
                reason=reason,
                downtime_type=downtime_type,
                note=_str(note, 2000),
                actor_id=m.user_id,
                work_order_id=work_order_id,
                at=when,
            )
        )
        prev = t.status
        t.status, t.status_reason, t.downtime_type = status, reason, downtime_type
        t.status_changed_at, t.status_changed_by_id = when, m.user_id
        t.version += 1
        emit(
            "asset.status_changed",
            entity_type="asset",
            entity_id=t.id,
            entity_label=t.name,
            summary=f"Changed status to {ASSET_STATUS_LABELS[status]}"
            + (f" ({reason})" if reason else "")
            + (f", {downtime_type} downtime" if downtime_type else ""),
            changes={"status": (prev, status)},
            data={"reason": reason, "downtime_type": downtime_type, "note": note, "work_order_id": work_order_id},
            org_id=org.id,
        )
        from mpro.core.hooks import run_hooks

        run_hooks(ASSET_STATUS_HOOKS, org, m, t, prev, status, what="Asset status hook")  # automations (0.4.0)
    if commit:
        db.session.commit()
    return a


def delete_asset(org: Organization, m: Membership, a: Asset) -> None:
    children = db.session.scalar(
        select(func.count()).select_from(Asset).where(Asset.parent_id == a.id, Asset.deleted_at.is_(None))
    )
    if children:
        raise RuleError("Move or delete the sub-assets first.", 409)
    a.deleted_at = utcnow()
    emit("asset.deleted", entity_type="asset", entity_id=a.id, entity_label=a.name, summary=f"Deleted asset {a.name}")
    db.session.commit()


def restore_asset(org: Organization, a: Asset) -> None:
    if a.parent_id:
        parent = db.session.get(Asset, a.parent_id)
        if parent is None or parent.deleted_at is not None:
            hierarchy.move_node(org.id, "asset", a.id, None)
            a.parent_id = None
    a.deleted_at = None
    emit("asset.restored", entity_type="asset", entity_id=a.id, entity_label=a.name, summary=f"Restored asset {a.name}")
    db.session.commit()


def duplicate_asset(org: Organization, m: Membership, a: Asset) -> Asset:
    data: dict[str, Any] = {k: getattr(a, k) for k in ASSET_FIELDS}
    data.update(
        {
            "name": f"Copy - {a.name}"[:255],
            "serial_number": "",
            "barcode": "",
            "location_id": a.location_id,
            "parent_id": a.parent_id,
            "custom": dict(a.custom or {}),
            "types": [str(t.type_id) for t in a.type_links],
            "teams": [t["id"] for t in teams_of("asset", [a.id]).get(a.id, [])],
        }
    )
    return create_asset(org, m, data)


def update_settings(org: Organization, data: dict[str, Any]) -> dict[str, Any]:
    current = asset_settings(org.id)
    clean: dict[str, Any] = {}
    for k, v in data.items():
        if k not in ASSET_SETTINGS:
            raise RuleError(f"Unknown setting {k!r}.", 422)
        if k == "max_depth":
            clean[k] = _int(v, "Maximum depth", 0, 50) or 0
        elif k == "ask_status_on_work_orders":
            clean[k] = bool(v)
        elif k == "status_reasons":
            if not isinstance(v, dict) or set(v) - set(ASSET_STATUSES):
                raise RuleError("Reasons belong to Online, Offline or Do Not Track.", 422)
            out = {}
            for st in ASSET_STATUSES:
                items = v.get(st, current["status_reasons"].get(st, []))
                if not isinstance(items, list):
                    raise RuleError("Reasons must be a list.", 422)
                seen: list[str] = []
                for x in items:
                    x = _str(x, 80)
                    if x and x not in seen:
                        seen.append(x)
                out[st] = seen[:30]
            clean[k] = out
    changes = {k: (current[k], v) for k, v in clean.items() if current[k] != v}
    result = save_settings(org.id, "assets", clean)
    if changes:
        emit(
            "asset.settings_changed",
            entity_type="org",
            entity_id=org.id,
            entity_label=org.name,
            summary="Changed asset settings: " + ", ".join(k.replace("_", " ") for k in changes),
            changes=changes,
            org_id=org.id,
        )
    db.session.commit()
    return result


# ---- downtime, availability, depreciation ----------------------------------------------------
def downtime(asset_id: uuid.UUID, start: datetime, end: datetime) -> dict[str, Any]:
    """Offline time and availability between start and end, from the status history (MP-024)."""
    changes = db.session.scalars(
        select(AssetStatusChange)
        .where(AssetStatusChange.asset_id == asset_id)
        .order_by(AssetStatusChange.at, AssetStatusChange.id)
    ).all()
    offline = planned = dnt = 0.0
    periods: list[dict[str, Any]] = []
    for i, c in enumerate(changes):
        lo = max(c.at, start)
        hi = min(changes[i + 1].at if i + 1 < len(changes) else end, end)
        if hi <= lo:
            continue
        secs = (hi - lo).total_seconds()
        if c.to_status == "offline":
            offline += secs
            if c.downtime_type == "planned":
                planned += secs
            periods.append(
                {
                    "from": lo.isoformat(),
                    "to": hi.isoformat(),
                    "reason": c.reason,
                    "type": c.downtime_type,
                    "seconds": int(secs),
                }
            )
        elif c.to_status == "do_not_track":
            dnt += secs
    tracked = max(0.0, (end - start).total_seconds() - dnt)
    first = changes[0].at if changes else end
    tracked = max(0.0, min(tracked, (end - max(start, first)).total_seconds() - dnt))
    return {
        "offline_seconds": int(offline),
        "planned_seconds": int(planned),
        "unplanned_seconds": int(offline - planned),
        "tracked_seconds": int(tracked),
        "availability": round(100 * (1 - offline / tracked), 2) if tracked > 0 else None,
        "periods": periods[-50:],
    }


def depreciation(a: Asset, today: date | None = None) -> dict[str, Any] | None:
    """Straight-line depreciation (r113)."""
    if a.purchase_price_cents is None or not a.useful_life_years:
        return None
    start = a.depreciation_start or a.purchase_date
    if start is None:
        return None
    today = today or datetime.now(UTC).date()
    basis = a.purchase_price_cents - (a.salvage_value_cents or 0)
    annual = basis / a.useful_life_years
    years = max(0.0, (today - start).days / 365.25)
    accumulated = min(basis, round(annual * years))
    schedule = []
    for y in range(a.useful_life_years):
        yr_start = (
            start.replace(year=start.year + y)
            if y == 0 or not (start.month == 2 and start.day == 29)
            else date(start.year + y, 3, 1)
        )
        acc = round(annual * (y + 1))
        schedule.append(
            {
                "year": y + 1,
                "starts": yr_start.isoformat(),
                "depreciation_cents": round(annual),
                "book_value_cents": a.purchase_price_cents - acc,
            }
        )
    return {
        "annual_cents": round(annual),
        "accumulated_cents": int(accumulated),
        "book_value_cents": int(a.purchase_price_cents - accumulated),
        "fully_depreciated": accumulated >= basis,
        "schedule": schedule,
    }
