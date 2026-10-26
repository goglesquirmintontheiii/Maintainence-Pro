"""Floor plan editor layer (MP-110): shapes, lines, text and location bindings stored apart from the image.

Coordinates are fractions (0–1) of the image's width and height, like pins, so edits survive a re-sized upload.
Asset pins stay in `floor_plan_pins`; shapes can point at a location (click → open it) or an asset.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from sqlalchemy import select

from mpro.assets.models import Asset, FloorPlan, Location
from mpro.core.events import emit
from mpro.extensions import db
from mpro.orgs.services import RuleError

SHAPE_TYPES = ("rect", "ellipse", "polygon", "line", "arrow", "freehand", "text", "group", "parts")
MAX_RINGS = 200  # a merged polygon (MP-128): outlines and holes
MAX_RING_POINTS = 5000
MAX_PARTS = 50  # parts listed on one pinned parts list (MP-128)
MAX_SHAPES = 2000
MAX_POINTS = 1000
MAX_BYTES = 1_500_000
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def _num(v: Any, lo: float, hi: float, what: str) -> float:
    if isinstance(v, bool) or not isinstance(v, int | float):
        raise RuleError(f"{what} must be a number.", 422)
    f = float(v)
    if not lo <= f <= hi:
        raise RuleError(f"{what} is out of range.", 422)
    return f


def _coord(v: Any) -> float:
    return _num(v, -0.5, 1.5, "A coordinate")  # a little slack so shapes can poke past the edge


def _clean_points(pts: Any, least: int) -> list[list[float]]:
    if not isinstance(pts, list) or not least <= len(pts) <= MAX_POINTS:
        raise RuleError(f"Lines and polygons need {least} to {MAX_POINTS} points.", 422)
    clean = []
    for p in pts:
        if not isinstance(p, list | tuple) or len(p) != 2:
            raise RuleError("Each point is [x, y].", 422)
        clean.append([round(_coord(p[0]), 5), round(_coord(p[1]), 5)])
    return clean


def _clean_shape(s: Any, ids: set[str]) -> dict[str, Any]:
    if not isinstance(s, dict):
        raise RuleError("Each shape must be an object.", 422)
    sid = str(s.get("id") or "")
    if not _ID.match(sid) or sid in ids:
        raise RuleError("Each shape needs a unique id.", 422)
    ids.add(sid)
    kind = s.get("type")
    if kind not in SHAPE_TYPES:
        raise RuleError(f"Unknown shape type {kind!r}.", 422)
    out: dict[str, Any] = {"id": sid, "type": kind}
    if kind in ("rect", "ellipse", "text", "parts"):
        out.update({k: _coord(s.get(k)) for k in ("x", "y")})
        out["w"] = _num(s.get("w", 0), 0, 2, "Width")
        out["h"] = _num(s.get("h", 0), 0, 2, "Height")
    if kind in ("polygon", "line", "arrow", "freehand"):
        out["points"] = _clean_points(s.get("points"), 2)
    if kind == "polygon" and s.get("rings") is not None:
        # merged shape: several outlines and holes, filled even-odd; `points` is the first outline
        rings = s["rings"]
        if not isinstance(rings, list) or not 1 <= len(rings) <= MAX_RINGS:
            raise RuleError(f"A merged shape can have up to {MAX_RINGS} outlines and holes.", 422)
        out["rings"] = [_clean_points(r, 3) for r in rings]
        if sum(len(r) for r in out["rings"]) > MAX_RING_POINTS:
            raise RuleError("This merged shape has too many corners.", 422)
        out["points"] = out["rings"][0]
    if kind == "parts":
        pids = s.get("part_ids")
        if not isinstance(pids, list) or not 1 <= len(pids) <= MAX_PARTS:
            raise RuleError(f"A parts list needs 1 to {MAX_PARTS} parts.", 422)
        try:
            out["part_ids"] = list(dict.fromkeys(str(uuid.UUID(str(x))) for x in pids))
        except ValueError as e:
            raise RuleError("One of the parts doesn't exist.", 422) from e
        out["open"] = bool(s.get("open"))
    if kind == "group":
        kids = s.get("children")
        if (
            not isinstance(kids, list)
            or not 2 <= len(kids) <= 200
            or not all(isinstance(k, str) and _ID.match(k) for k in kids)
        ):
            raise RuleError("A merged shape needs 2 to 200 parts.", 422)
        out["children"] = list(dict.fromkeys(kids))
    if "text" in s or kind == "text":
        out["text"] = str(s.get("text") or "")[:500]
    for k in ("stroke", "fill"):
        if k in s and s[k] not in (None, "", "none"):
            if not isinstance(s[k], str) or not _COLOR.match(s[k]):
                raise RuleError("Colours look like #1b5bd4.", 422)
            out[k] = s[k]
        elif k in s:
            out[k] = "none"
    if "stroke_width" in s:
        out["stroke_width"] = _num(s["stroke_width"], 0, 40, "Line width")
    if "fill_opacity" in s:
        out["fill_opacity"] = _num(s["fill_opacity"], 0, 1, "Fill opacity")
    if "font_size" in s:
        out["font_size"] = _num(s["font_size"], 4, 200, "Text size")
    if kind == "text":  # label styles (MP-132)
        if "font" in s:
            if s["font"] not in FONTS:
                raise RuleError(f"Pick a font: {', '.join(FONTS)}.", 422)
            out["font"] = s["font"]
        for k in ("bold", "italic"):
            if k in s:
                out[k] = bool(s[k])
        if "outline" in s:
            if s["outline"] in (None, "", "none"):
                out["outline"] = "none"
            elif not isinstance(s["outline"], str) or not _COLOR.match(s["outline"]):
                raise RuleError("Colours look like #1b5bd4.", 422)
            else:
                out["outline"] = s["outline"]
        if "outline_width" in s:
            out["outline_width"] = _num(s["outline_width"], 0, 20, "Outline width")
    if "label" in s:
        out["label"] = str(s.get("label") or "")[:120]
    for k in ("location_id", "asset_id"):
        if s.get(k):
            try:
                out[k] = str(uuid.UUID(str(s[k])))
            except ValueError as e:
                raise RuleError("That link doesn't exist.", 422) from e
    return out


FONTS = ("sans", "serif", "mono", "rounded")  # text label fonts (MP-132)


def clean_annotations(org_id: uuid.UUID, data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise RuleError("Send the edits as an object.", 422)
    shapes = data.get("shapes", [])
    if not isinstance(shapes, list) or len(shapes) > MAX_SHAPES:
        raise RuleError(f"A floor plan can have up to {MAX_SHAPES:,} shapes.", 422)
    ids: set[str] = set()
    clean = [_clean_shape(s, ids) for s in shapes]
    for s in clean:
        if s["type"] == "group" and any(k not in ids or k == s["id"] for k in s["children"]):
            raise RuleError("A merged shape refers to a shape that isn't there.", 422)
    # parts on pinned lists must be this organization's; parts deleted since are dropped (and lists left empty) so
    # the drawing can still be saved
    wanted_parts = {uuid.UUID(p) for s in clean for p in s.get("part_ids", [])}
    if wanted_parts:
        from mpro.parts.models import Part

        found_parts = set(
            db.session.scalars(
                select(Part.id).where(Part.org_id == org_id, Part.id.in_(wanted_parts), Part.deleted_at.is_(None))
            ).all()
        )
        for s in clean:
            if "part_ids" in s:
                s["part_ids"] = [p for p in s["part_ids"] if uuid.UUID(p) in found_parts]
        gone = {s["id"] for s in clean if s["type"] == "parts" and not s["part_ids"]}
        if gone:
            clean = [s for s in clean if s["id"] not in gone]
            for s in clean:
                if s["type"] == "group":
                    s["children"] = [k for k in s["children"] if k not in gone]
            clean = [s for s in clean if s["type"] != "group" or len(s["children"]) >= 2]
    # links must point at this organization's records
    for key, model in (("location_id", Location), ("asset_id", Asset)):
        wanted = {uuid.UUID(s[key]) for s in clean if s.get(key)}
        if wanted:
            found = set(
                db.session.scalars(
                    select(model.id).where(model.org_id == org_id, model.id.in_(wanted), model.deleted_at.is_(None))
                ).all()
            )
            if wanted - found:
                raise RuleError("One of the linked locations or assets doesn't exist.", 422)
    out = {"shapes": clean}
    if len(json.dumps(out)) > MAX_BYTES:
        raise RuleError("These edits are too large to save.", 413)
    return out


def annotations_dict(fp: FloorPlan) -> dict[str, Any]:
    return {"annotations": fp.annotations or {"shapes": []}, "version": fp.annotations_version or 0}


def save_annotations(org_id: uuid.UUID, fp: FloorPlan, data: Any, expected_version: Any) -> FloorPlan:
    if not isinstance(expected_version, int) or isinstance(expected_version, bool):
        raise RuleError("Send the version you started from.", 422)
    if expected_version != (fp.annotations_version or 0):
        raise RuleError("Someone else changed this floor plan's drawing. Reload to see their changes.", 409)
    clean = clean_annotations(org_id, data)
    before = len((fp.annotations or {}).get("shapes", []))
    fp.annotations = clean
    fp.annotations_version = (fp.annotations_version or 0) + 1
    emit(
        "location.floor_plan_edited",
        entity_type="location",
        entity_id=fp.location_id,
        entity_label=fp.name,
        summary=f"Edited the drawing on {fp.name} ({before} → {len(clean['shapes'])} shapes)",
    )
    db.session.commit()
    return fp
