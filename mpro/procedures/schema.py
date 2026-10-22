"""Procedure schema: validation, field walking, conditions and scoring (pure functions, no database)."""

from __future__ import annotations

import re
import secrets
from decimal import Decimal, InvalidOperation
from typing import Any

from mpro.orgs.services import RuleError
from mpro.procedures.models import FIELD_TYPES, STRUCTURE_TYPES

MAX_FIELDS = 350  # MaintainX limit (r203)
MAX_LABEL = 512
ID_RE = re.compile(r"^[A-Za-z0-9_]{1,40}$")
OPTION_TYPES = {"multiple_choice", "checklist"}
SCORABLE = {"checkbox", "multiple_choice", "checklist", "inspection"}
# answers a condition can test, per source field type (conditional logic isn't offered on text fields, r182)
CONDITION_SOURCES = {"checkbox", "multiple_choice", "checklist", "inspection", "yes_no_na", "number", "amount"}
CONDITION_OPS = ("eq", "neq", "in", "not_in", "gt", "lt", "answered")
INSPECTION_RESULTS = ("pass", "flag", "fail")
YES_NO_NA = ("yes", "no", "na")


def new_id() -> str:
    return "f" + secrets.token_hex(5)


def _num(v: Any, what: str) -> Decimal | None:
    if v in (None, ""):
        return None
    if isinstance(v, bool):
        raise RuleError(f"{what} must be a number.", 422)
    try:
        d = Decimal(str(v))
    except InvalidOperation as e:
        raise RuleError(f"{what} must be a number.", 422) from e
    if not d.is_finite():
        raise RuleError(f"{what} must be a number.", 422)
    return d


def _clean_item(raw: Any, seen: set[str], depth: int, count: list[int], in_section: bool = False) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise RuleError("Each procedure item must be an object.", 422)
    t = raw.get("type")
    if t not in FIELD_TYPES and t not in STRUCTURE_TYPES:
        raise RuleError(f"Unknown field type {t!r}.", 422)
    fid = str(raw.get("id") or new_id())
    if not ID_RE.match(fid):
        raise RuleError(f"Field id {fid!r} isn't valid.", 422)
    if fid in seen:
        raise RuleError(f"Two fields share the id {fid!r}.", 422)
    seen.add(fid)
    label = str(raw.get("label") or "").strip()
    if len(label) > MAX_LABEL:
        raise RuleError(f"Field names can be up to {MAX_LABEL} characters.", 422)
    if not label and t not in ("section", "procedure"):
        raise RuleError("Every field needs a name.", 422)
    item: dict[str, Any] = {"id": fid, "type": t, "label": label}
    desc = str(raw.get("description") or "")
    if desc:
        item["description"] = desc[:4000]
    link = str(raw.get("link") or "").strip()
    if link:
        if not re.match(r"^https?://", link, re.I):
            raise RuleError(f"The link on {label or 'a field'} must start with http:// or https://.", 422)
        item["link"] = link[:2000]
    refs = raw.get("reference_file_ids") or []
    if refs:
        if not isinstance(refs, list) or len(refs) > 20:
            raise RuleError("Reference files must be a list (up to 20).", 422)
        item["reference_file_ids"] = [str(x) for x in refs]
    cond = raw.get("condition")
    if cond:
        item["condition"] = cond  # checked against earlier fields in validate()
    if t == "section":
        if in_section or depth > 2:
            raise RuleError("Sections can't be inside other sections.", 422)
        kids = raw.get("items") or []
        if not isinstance(kids, list):
            raise RuleError("A section's items must be a list.", 422)
        item["items"] = [_clean_item(k, seen, depth + 1, count, True) for k in kids]
        return item
    if t == "heading":
        return item
    if t == "procedure":
        pid = raw.get("procedure_id")
        if not pid:
            raise RuleError("Pick the procedure to include.", 422)
        item["procedure_id"] = str(pid)
        if raw.get("items"):  # snapshot taken when the parent is published
            kids = raw.get("items") or []
            item["items"] = [_clean_item(k, seen, depth + 1, count) for k in kids]
            item["version_number"] = raw.get("version_number")
        return item
    # a field
    count[0] += 1
    if count[0] > MAX_FIELDS:
        raise RuleError(f"Procedures can have up to {MAX_FIELDS} fields.", 422)
    item["required"] = bool(raw.get("required"))
    assignees = raw.get("assignees") or []
    if assignees:
        if not isinstance(assignees, list) or not all(
            re.match(r"^(user|team):[0-9a-fA-F-]{36}$", str(a)) for a in assignees
        ):
            raise RuleError("Assign fields to people or teams.", 422)
        item["assignees"] = [str(a) for a in assignees]
    if t in OPTION_TYPES:
        opts = raw.get("options") or []
        if not isinstance(opts, list) or not opts:
            raise RuleError(f"{label} needs at least one option.", 422)
        clean = []
        for o in opts:
            s = str(o).strip()[:MAX_LABEL]
            if s and s not in clean:
                clean.append(s)
        if not clean:
            raise RuleError(f"{label} needs at least one option.", 422)
        item["options"] = clean[:100]
    if t in SCORABLE:
        pts = raw.get("points")
        if isinstance(pts, dict):  # multiple choice: points per option
            item["points"] = {
                str(k): int(v) for k, v in pts.items() if str(k) in item.get("options", []) and _int_ok(v)
            }
        elif pts not in (None, ""):
            if not _int_ok(pts):
                raise RuleError(f"Points on {label} must be a whole number 0–100.", 422)
            item["points"] = int(pts)
    if t in ("number", "amount"):
        unit = str(raw.get("unit") or "").strip()[:30]
        if unit:
            item["unit"] = unit
        for k in ("min", "max"):
            v = _num(raw.get(k), f"{label} {k}")
            if v is not None:
                item[k] = float(v)
    if t == "meter_reading" and raw.get("meter_id"):
        item["meter_id"] = str(raw["meter_id"])
    if t == "location_check_in":
        buf = _num(raw.get("buffer_m"), "The check-in distance")
        item["buffer_m"] = int(buf) if buf is not None else 10
        if not 1 <= item["buffer_m"] <= 5000:
            raise RuleError("The check-in distance must be between 1 and 5,000 metres.", 422)
        item["allow_skip"] = raw.get("allow_skip", True) is not False
    if t == "date" and raw.get("with_time"):
        item["with_time"] = True
    return item


def _int_ok(v: Any) -> bool:
    try:
        return not isinstance(v, bool) and 0 <= int(v) <= 100
    except (TypeError, ValueError):
        return False


def validate(raw: Any) -> dict[str, Any]:
    """Clean and validate a version schema. Returns {"items": [...], "scoring": {...}}."""
    if raw in (None, ""):
        raw = {}
    if not isinstance(raw, dict):
        raise RuleError("The procedure must be an object with items.", 422)
    items_raw = raw.get("items") or []
    if not isinstance(items_raw, list):
        raise RuleError("Procedure items must be a list.", 422)
    seen: set[str] = set()
    count = [0]
    items = [_clean_item(x, seen, 0, count) for x in items_raw]
    # conditions may only look at fields that come earlier, and not at text fields
    earlier: dict[str, dict[str, Any]] = {}
    for it in walk(items, include_structure=True):
        cond = it.get("condition")
        if cond:
            it["condition"] = _clean_condition(cond, earlier, it["label"] or "a section")
        if it["type"] in FIELD_TYPES:
            earlier[it["id"]] = it
    scoring = raw.get("scoring") or {}
    goal = scoring.get("goal") if isinstance(scoring, dict) else None
    if goal not in (None, ""):
        if not _int_ok(goal):
            raise RuleError("The score goal must be between 0 and 100%.", 422)
        goal = int(goal)
    else:
        goal = None
    return {
        "items": items,
        "scoring": {"enabled": bool(isinstance(scoring, dict) and scoring.get("enabled")), "goal": goal},
    }


def _clean_condition(cond: Any, earlier: dict[str, dict[str, Any]], label: str) -> dict[str, Any]:
    if not isinstance(cond, dict):
        raise RuleError(f"The condition on {label} isn't valid.", 422)
    src = earlier.get(str(cond.get("field")))
    if src is None:
        raise RuleError(f"The condition on {label} must use a field that comes before it.", 422)
    if src["type"] not in CONDITION_SOURCES:
        raise RuleError(f"Conditions can't use {src['type'].replace('_', ' ')} fields.", 422)
    op = cond.get("op", "eq")
    if op not in CONDITION_OPS:
        raise RuleError(f"Unknown condition {op!r}.", 422)
    out: dict[str, Any] = {"field": src["id"], "op": op}
    if op != "answered":
        out["value"] = cond.get("value")
        if op in ("in", "not_in") and not isinstance(out["value"], list):
            out["value"] = [out["value"]]
    return out


def walk(items: list[dict[str, Any]], include_structure: bool = False) -> list[dict[str, Any]]:
    """Depth-first list of items (sections and nested procedures are expanded)."""
    out: list[dict[str, Any]] = []
    for it in items:
        if it["type"] in ("section", "procedure"):
            if include_structure:
                out.append(it)
            out.extend(walk(it.get("items") or [], include_structure))
        else:
            if include_structure or it["type"] != "heading":
                out.append(it)
    return out


def fields(schema: dict[str, Any]) -> list[dict[str, Any]]:
    """Answerable fields in order."""
    return [f for f in walk(schema.get("items") or []) if f["type"] in FIELD_TYPES]


def _cond_ok(cond: dict[str, Any] | None, answers: dict[str, Any]) -> bool:
    if not cond:
        return True
    v = answers.get(cond["field"])
    op, want = cond["op"], cond.get("value")
    if op == "answered":
        return v not in (None, "", [])
    if v in (None, "", []):
        return op in ("neq", "not_in")
    if op in ("gt", "lt"):
        try:
            a, b = Decimal(str(v)), Decimal(str(want))
        except (InvalidOperation, ValueError):
            return False
        return a > b if op == "gt" else a < b
    vals = want if isinstance(want, list) else [want]
    if isinstance(v, list):
        hit = any(str(x) in [str(w) for w in vals] for x in v)
    elif isinstance(v, bool):
        hit = any(w is v or str(w).lower() == str(v).lower() for w in vals)
    else:
        hit = str(v) in [str(w) for w in vals]
    if op in ("eq", "in"):
        return hit
    return not hit


def visible_ids(schema: dict[str, Any], answers: dict[str, Any]) -> set[str]:
    """Ids of fields shown given the answers so far (a hidden section hides everything in it)."""
    out: set[str] = set()

    def rec(items: list[dict[str, Any]], shown: bool) -> None:
        for it in items:
            ok = shown and _cond_ok(it.get("condition"), answers)
            if it["type"] in ("section", "procedure"):
                rec(it.get("items") or [], ok)
            elif ok:
                out.add(it["id"])

    rec(schema.get("items") or [], True)
    return out


def answered(field: dict[str, Any], value: Any, skipped: bool = False) -> bool:
    if skipped:
        return True
    if field["type"] == "checkbox":
        return value is True
    return value not in (None, "", [], {})


def score(schema: dict[str, Any], answers: dict[str, Any]) -> Decimal | None:
    """Percent of available points earned on visible scorable fields (r184). None if nothing is scored."""
    if not (schema.get("scoring") or {}).get("enabled"):
        return None
    vis = visible_ids(schema, answers)
    earned = possible = Decimal(0)
    for f in fields(schema):
        if f["id"] not in vis or f["type"] not in SCORABLE:
            continue
        pts = f.get("points", 1)
        v = answers.get(f["id"])
        if f["type"] == "multiple_choice":
            table = (
                pts if isinstance(pts, dict) else {o: (1 if i == 0 else 0) for i, o in enumerate(f.get("options", []))}
            )
            best = max(table.values()) if table else 0
            possible += best
            earned += Decimal(table.get(str(v), 0)) if v else 0
        elif f["type"] == "checklist":
            per = pts if isinstance(pts, int) else 1
            possible += per * len(f.get("options", []))
            earned += per * len(v or [])
        elif f["type"] == "inspection":
            per = pts if isinstance(pts, int) else 1
            possible += per
            earned += per if v == "pass" else (Decimal(per) / 2 if v == "flag" else 0)
        else:  # checkbox
            per = pts if isinstance(pts, int) else 1
            possible += per
            earned += per if v is True else 0
    if possible == 0:
        return None
    return (earned * 100 / possible).quantize(Decimal("0.01"))


def diff(old: dict[str, Any] | None, new: dict[str, Any]) -> dict[str, list[str]]:
    """Added / edited / removed field labels between two versions (r206)."""
    a = {f["id"]: f for f in walk((old or {}).get("items") or [], include_structure=True)}
    b = {f["id"]: f for f in walk(new.get("items") or [], include_structure=True)}

    def name(f: dict[str, Any]) -> str:
        return f.get("label") or f["type"].replace("_", " ").capitalize()

    return {
        "added": [name(b[k]) for k in b if k not in a],
        "removed": [name(a[k]) for k in a if k not in b],
        "edited": [name(b[k]) for k in b if k in a and _strip(a[k]) != _strip(b[k])],
    }


def _strip(f: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in f.items() if k != "items"}
