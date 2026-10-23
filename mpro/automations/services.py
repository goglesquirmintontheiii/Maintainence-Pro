"""Automations: when something happens (trigger) and conditions hold, do something (actions) — MP-117.

Triggers
- ``meter_reading``: is above / below / equal to a value; increases or decreases by N (recurring milestones from a
  first point); increases or decreases by N from the last reading. Targets are meters.
- ``asset_status``: an asset's status changed (optionally from/to). Targets are assets (empty = every asset).
- ``work_order_status``: a work order's status changed (optionally from/to, category, priority). Targets are
  assets (empty = any work order).
Conditions: asset status, weekday, time window (organization time zone).
Actions: create a work order (fields or a template), change the asset's status, send an email.
Sensitivity ("For", r175) for value triggers: every matching reading, once then rearm, N of the last M readings,
or true for longer than a duration (checked on later readings and by a periodic job).
A re-run interval (r201) and a duplicate guard (never a second open work order per automation and target) stop
repeats. Every evaluation that matched is recorded in AutomationRun.
"""

from __future__ import annotations

import contextvars
import re
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select

from mpro.automations.models import Automation, AutomationRun, AutomationState
from mpro.core.events import emit
from mpro.core.ids import uuid7
from mpro.core.models import iso, utcnow
from mpro.core.settings import register_defaults
from mpro.extensions import db
from mpro.orgs.models import Membership, Organization, Team, TeamMember
from mpro.orgs.services import RuleError

MAX_TARGETS = 250
register_defaults("warranty_reminders", {"sent": {}})  # asset id -> warranty end date already reminded about
METER_CONDITIONS = (
    "above",
    "below",
    "equal",
    "increases_by",
    "decreases_by",
    "increases_from_last",
    "decreases_from_last",
)
RECURRING = ("increases_by", "decreases_by")
SENSITIVITY_MODES = ("every", "once", "n_of_m", "duration")
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
WO_FIELDS = ("title", "description", "priority", "assignees", "categories", "estimated_minutes", "work_type")
PRIORITIES = ("none", "low", "medium", "high")
ASSET_STATUSES = ("online", "offline", "do_not_track")
WO_STATUSES = ("open", "on_hold", "in_progress", "done", "canceled")
COND_LABEL = {
    "above": "is above",
    "below": "is below",
    "equal": "is equal to",
    "increases_by": "increases by",
    "decreases_by": "decreases by",
    "increases_from_last": "increases from the last reading by",
    "decreases_from_last": "decreases from the last reading by",
}
STATUS_LABEL = {
    "online": "Online",
    "offline": "Offline",
    "do_not_track": "Do Not Track",
    "open": "Open",
    "on_hold": "On Hold",
    "in_progress": "In Progress",
    "done": "Done",
    "canceled": "Canceled",
}

# Automations that change asset statuses can trigger other automations; stop runaway chains.
_depth: contextvars.ContextVar[int] = contextvars.ContextVar("automation_depth", default=0)
MAX_DEPTH = 3


# ---- helpers -----------------------------------------------------------------------------------------------
def _uuid(v: Any, what: str) -> uuid.UUID:
    try:
        return v if isinstance(v, uuid.UUID) else uuid.UUID(str(v))
    except (ValueError, TypeError, AttributeError) as e:
        raise RuleError(f"That {what} doesn't exist.", 422) from e


def _dec(v: Any, field: str) -> Decimal:
    if v in (None, "") or isinstance(v, bool):
        raise RuleError(f"{field} must be a number.", 422)
    try:
        d = Decimal(str(v))
    except InvalidOperation as e:
        raise RuleError(f"{field} must be a number.", 422) from e
    if not d.is_finite() or abs(d) > Decimal("99999999999999"):
        raise RuleError(f"{field} is out of range.", 422)
    return d


def _num(d: Any) -> float | int | None:
    if d is None:
        return None
    d = Decimal(str(d))
    return int(d) if d == d.to_integral_value() else float(d)


def _int(v: Any, field: str, lo: int, hi: int) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError, OverflowError) as e:
        raise RuleError(f"{field} must be a whole number.", 422) from e
    if isinstance(v, bool) or not lo <= n <= hi:
        raise RuleError(f"{field} must be between {lo:,} and {hi:,}.", 422)
    return n


def _str_list(v: Any, allowed: tuple[str, ...], field: str) -> list[str]:
    if v in (None, ""):
        return []
    if not isinstance(v, list) or any(x not in allowed for x in v):
        raise RuleError(f"{field} must be some of: {', '.join(allowed)}.", 422)
    return list(dict.fromkeys(v))


# ---- validation --------------------------------------------------------------------------------------------
def _clean_trigger(org_id: uuid.UUID, t: Any) -> dict[str, Any]:
    if not isinstance(t, dict) or t.get("type") not in ("meter_reading", "asset_status", "work_order_status"):
        raise RuleError(
            "Pick what starts the automation: a meter reading, an asset status or a work order status.", 422
        )
    kind = t["type"]
    if kind == "meter_reading":
        cond = t.get("condition")
        if cond not in METER_CONDITIONS:
            raise RuleError("Pick a meter condition.", 422)
        out: dict[str, Any] = {"type": kind, "condition": cond, "value": str(_dec(t.get("value"), "The value"))}
        if (cond in RECURRING or cond.endswith("_from_last")) and Decimal(out["value"]) <= 0:
            raise RuleError("The amount must be more than zero.", 422)
        if cond in RECURRING and t.get("first_at") not in (None, ""):
            out["first_at"] = str(_dec(t.get("first_at"), "The first trigger point"))
        return out
    out = {
        "type": kind,
        "from": _str_list(t.get("from"), ASSET_STATUSES if kind == "asset_status" else WO_STATUSES, "From"),
        "to": _str_list(t.get("to"), ASSET_STATUSES if kind == "asset_status" else WO_STATUSES, "To"),
    }
    if kind == "work_order_status":
        out["priorities"] = _str_list(t.get("priorities"), PRIORITIES, "Priorities")
        cats = []
        from mpro.workorders.models import Category

        for c in t.get("categories") or []:
            cid = _uuid(c, "category")
            if not db.session.scalar(select(Category.id).where(Category.org_id == org_id, Category.id == cid)):
                raise RuleError("One of the categories doesn't exist.", 422)
            cats.append(str(cid))
        out["categories"] = cats
    return out


def _clean_targets(org_id: uuid.UUID, kind: str, targets: Any) -> list[str]:
    from mpro.assets.models import Asset
    from mpro.meters.models import Meter

    if targets in (None, ""):
        targets = []
    if not isinstance(targets, list):
        raise RuleError("Targets must be a list.", 422)
    if len(targets) > MAX_TARGETS:
        raise RuleError(f"One automation can watch up to {MAX_TARGETS} assets or meters.", 422)
    model: Any = Meter if kind == "meter_reading" else Asset
    ids = list(dict.fromkeys(_uuid(x, "meter" if kind == "meter_reading" else "asset") for x in targets))
    if ids:
        found = set(
            db.session.scalars(
                select(model.id).where(model.org_id == org_id, model.id.in_(ids), model.deleted_at.is_(None))
            ).all()
        )
        if len(found) != len(ids):
            raise RuleError(
                "One of the " + ("meters" if kind == "meter_reading" else "assets") + " doesn't exist.", 422
            )
    if kind == "meter_reading" and not ids:
        raise RuleError("Pick at least one meter.", 422)
    return [str(i) for i in ids]


def _clean_conditions(conds: Any) -> list[dict[str, Any]]:
    if conds in (None, ""):
        return []
    if not isinstance(conds, list) or len(conds) > 10:
        raise RuleError("Conditions must be a list (up to 10).", 422)
    out: list[dict[str, Any]] = []
    for c in conds:
        if not isinstance(c, dict):
            raise RuleError("Each condition needs a type.", 422)
        if c.get("type") == "asset_status":
            vals = _str_list(c.get("in"), ASSET_STATUSES, "Asset status")
            if not vals:
                raise RuleError("Pick at least one asset status for the condition.", 422)
            out.append({"type": "asset_status", "in": vals})
        elif c.get("type") == "weekday":
            days = c.get("days")
            if not isinstance(days, list) or not days or any(not isinstance(d, int) or not 0 <= d <= 6 for d in days):
                raise RuleError("Pick the weekdays (Monday = 0).", 422)
            out.append({"type": "weekday", "days": sorted(set(days))})
        elif c.get("type") == "time_window":
            a, b = str(c.get("from") or ""), str(c.get("to") or "")
            if not (re.fullmatch(r"\d{2}:\d{2}", a) and re.fullmatch(r"\d{2}:\d{2}", b)) or a > "23:59" or b > "23:59":
                raise RuleError("Times are HH:MM.", 422)
            out.append({"type": "time_window", "from": a, "to": b})
        else:
            raise RuleError("Conditions are asset status, weekday or time window.", 422)
    return out


def _clean_recipients(org_id: uuid.UUID, items: Any) -> list[str]:
    from mpro.auth.models import User

    if not isinstance(items, list) or not items:
        raise RuleError("Pick who gets the email.", 422)
    out = []
    for it in items:
        kind, _, raw = str(it).partition(":")
        rid = _uuid(raw, "recipient")
        if kind == "user":
            ok = db.session.scalar(
                select(Membership.id)
                .join(User, User.id == Membership.user_id)
                .where(Membership.org_id == org_id, Membership.user_id == rid, Membership.deleted_at.is_(None))
            )
        elif kind == "team":
            ok = db.session.scalar(
                select(Team.id).where(Team.org_id == org_id, Team.id == rid, Team.deleted_at.is_(None))
            )
        else:
            ok = None
        if not ok:
            raise RuleError("One of the email recipients isn't in this organization.", 422)
        out.append(f"{kind}:{rid}")
    return list(dict.fromkeys(out))


def _clean_actions(org: Organization, kind: str, actions: Any) -> list[dict[str, Any]]:
    from mpro.workorders.models import Template
    from mpro.workorders.services import _apply_fields, _resolve_assignees, new_work_order

    if not isinstance(actions, list) or not actions:
        raise RuleError("Add at least one action.", 422)
    if len(actions) > 5:
        raise RuleError("An automation can have up to 5 actions.", 422)
    out: list[dict[str, Any]] = []
    for a in actions:
        if not isinstance(a, dict):
            raise RuleError("Each action needs a type.", 422)
        t = a.get("type")
        rerun = _int(a.get("rerun_minutes") or 0, "Re-run interval", 0, 525600)
        if t == "create_work_order":
            act: dict[str, Any] = {"type": t, "rerun_minutes": rerun}
            if a.get("template_id"):
                tid = _uuid(a["template_id"], "template")
                if not db.session.scalar(
                    select(Template.id).where(
                        Template.org_id == org.id, Template.id == tid, Template.deleted_at.is_(None)
                    )
                ):
                    raise RuleError("That template doesn't exist.", 422)
                act["template_id"] = str(tid)
            fields = {k: a[k] for k in WO_FIELDS if k in a and a[k] not in (None, "")}
            probe = new_work_order(org.id)
            _apply_fields(
                probe,
                {
                    "title": fields.get("title") or "x",
                    **{
                        k: fields[k]
                        for k in ("description", "priority", "estimated_minutes", "work_type")
                        if k in fields
                    },
                },
            )
            if "assignees" in fields:
                _resolve_assignees(org.id, fields["assignees"])
            if "categories" in fields:
                from mpro.workorders.models import Category

                for c in fields["categories"]:
                    if not db.session.scalar(
                        select(Category.id).where(Category.org_id == org.id, Category.id == _uuid(c, "category"))
                    ):
                        raise RuleError("One of the categories doesn't exist.", 422)
            if not act.get("template_id") and not str(fields.get("title") or "").strip():
                raise RuleError("Give the work order a title (or pick a template).", 422)
            if a.get("due_in_days") not in (None, ""):
                act["due_in_days"] = _int(a["due_in_days"], "Due in days", 0, 3650)
            act.update(fields)
            out.append(act)
        elif t == "change_asset_status":
            st = a.get("status")
            if st not in ASSET_STATUSES:
                raise RuleError("Pick the asset status to set.", 422)
            dt = a.get("downtime_type") or ("unplanned" if st == "offline" else "")
            if dt not in ("", "planned", "unplanned"):
                raise RuleError("Downtime is planned or unplanned.", 422)
            out.append(
                {
                    "type": t,
                    "status": st,
                    "downtime_type": dt if st == "offline" else "",
                    "reason": str(a.get("reason") or "")[:80],
                    "note": str(a.get("note") or "")[:500],
                    "rerun_minutes": rerun,
                }
            )
        elif t == "send_email":
            subject = str(a.get("subject") or "").strip()
            if not subject:
                raise RuleError("The email needs a subject.", 422)
            out.append(
                {
                    "type": t,
                    "recipients": _clean_recipients(org.id, a.get("recipients")),
                    "subject": subject[:200],
                    "body": str(a.get("body") or "")[:5000],
                    "rerun_minutes": rerun,
                }
            )
        else:
            raise RuleError("Actions are create work order, change asset status or send email.", 422)
    if kind == "work_order_status" and any(x["type"] == "create_work_order" for x in out):
        pass  # allowed: e.g. follow-up work when a work order is done
    return out


def _clean_sensitivity(kind: str, trigger: dict[str, Any], s: Any) -> dict[str, Any]:
    if kind != "meter_reading" or trigger.get("condition") in RECURRING:
        return {}
    if s in (None, ""):
        return {"mode": "once"}
    if not isinstance(s, dict) or s.get("mode") not in SENSITIVITY_MODES:
        raise RuleError(
            "Sensitivity is every reading, once then reset, N of the last M readings, or for a duration.", 422
        )
    mode = s["mode"]
    if mode == "n_of_m":
        m = _int(s.get("m"), "M", 1, 50)
        n = _int(s.get("n"), "N", 1, m)
        return {"mode": mode, "n": n, "m": m}
    if mode == "duration":
        return {"mode": mode, "minutes": _int(s.get("minutes"), "Duration (minutes)", 1, 43200)}
    return {"mode": mode}


# ---- CRUD --------------------------------------------------------------------------------------------------
def save_automation(org: Organization, m: Membership, data: dict[str, Any], a: Automation | None = None) -> Automation:
    created = a is None
    trigger = _clean_trigger(org.id, data.get("trigger", a.trigger if a else None))
    targets = _clean_targets(org.id, trigger["type"], data.get("targets", a.targets if a else []))
    actions = _clean_actions(org, trigger["type"], data.get("actions", a.actions if a else None))
    conditions = _clean_conditions(data.get("conditions", a.conditions if a else []))
    sensitivity = _clean_sensitivity(trigger["type"], trigger, data.get("sensitivity", a.sensitivity if a else None))
    name = str(data.get("name", a.name if a else "") or "").strip()
    if not name:
        raise RuleError("Give the automation a name.", 422)
    rerun = _int(data.get("rerun_minutes", a.rerun_minutes if a else 0) or 0, "Re-run interval", 0, 525600)
    if a is None:
        a = Automation(id=uuid7(), org_id=org.id, created_by_id=m.user_id, run_count=0, fail_count=0, skip_count=0)
        db.session.add(a)
    trigger_changed = not created and (a.trigger != trigger or a.targets != targets or a.sensitivity != sensitivity)
    a.name, a.description = name[:255], str(data.get("description", a.description or "") or "")[:4000]
    a.trigger, a.targets, a.actions, a.conditions, a.sensitivity, a.rerun_minutes = (
        trigger,
        targets,
        actions,
        conditions,
        sensitivity,
        rerun,
    )
    if "active" in data:
        a.active = bool(data["active"])
    elif created:
        a.active = True
    db.session.flush()
    if trigger_changed:  # start counting again
        for st in db.session.scalars(select(AutomationState).where(AutomationState.automation_id == a.id)).all():
            st.state = {k: v for k, v in (st.state or {}).items() if k in ("open_wo", "open_wos", "action_at")}
    emit(
        "automation.created" if created else "automation.updated",
        entity_type="automation",
        entity_id=a.id,
        entity_label=a.name,
        summary=("Created" if created else "Changed") + f" automation {a.name}",
    )
    db.session.commit()
    return a


def delete_automation(org: Organization, a: Automation, commit: bool = True) -> None:
    a.deleted_at, a.active = utcnow(), False
    emit(
        "automation.deleted",
        entity_type="automation",
        entity_id=a.id,
        entity_label=a.name,
        summary=f"Deleted automation {a.name}",
    )
    if commit:
        db.session.commit()


def copy_automation(org: Organization, m: Membership, a: Automation) -> Automation:
    new = Automation(
        id=uuid7(),
        org_id=org.id,
        created_by_id=m.user_id,
        name=f"Copy - {a.name}"[:255],
        description=a.description,
        active=False,
        trigger=dict(a.trigger),
        conditions=list(a.conditions),
        actions=list(a.actions),
        sensitivity=dict(a.sensitivity),
        rerun_minutes=a.rerun_minutes,
        targets=list(a.targets),
        run_count=0,
        fail_count=0,
        skip_count=0,
    )
    db.session.add(new)
    db.session.flush()
    emit(
        "automation.created",
        entity_type="automation",
        entity_id=new.id,
        entity_label=new.name,
        summary=f"Copied automation {a.name}",
    )
    db.session.commit()
    return new


def bulk(org: Organization, ids: list[Any], action: str) -> list[str]:
    if action not in ("enable", "disable", "delete"):
        raise RuleError("Action is enable, disable or delete.", 422)
    if not isinstance(ids, list) or not 1 <= len(ids) <= 500:
        raise RuleError("Pick 1 to 500 automations.", 422)
    uids = [_uuid(i, "automation") for i in ids]
    rows = db.session.scalars(
        select(Automation).where(Automation.org_id == org.id, Automation.id.in_(uids), Automation.deleted_at.is_(None))
    ).all()
    for a in rows:
        if action == "delete":
            delete_automation(org, a, commit=False)
        else:
            a.active = action == "enable"
            emit(
                "automation.updated",
                entity_type="automation",
                entity_id=a.id,
                entity_label=a.name,
                summary=("Enabled" if a.active else "Disabled") + f" automation {a.name}",
            )
    db.session.commit()
    return [str(a.id) for a in rows]


# ---- description (plain language) --------------------------------------------------------------------------
def _names(org_id: uuid.UUID, kind: str, ids: list[str]) -> list[str]:
    from mpro.assets.models import Asset
    from mpro.meters.models import Meter

    if not ids:
        return []
    model: Any = Meter if kind == "meter" else Asset
    rows: dict[uuid.UUID, str] = dict(
        db.session.execute(
            select(model.id, model.name).where(model.org_id == org_id, model.id.in_([uuid.UUID(i) for i in ids]))
        ).all()
    )
    return [rows[uuid.UUID(i)] for i in ids if uuid.UUID(i) in rows]


def _list_text(names: list[str], limit: int = 3) -> str:
    if not names:
        return ""
    if len(names) <= limit:
        return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " or " + names[-1]
    return ", ".join(names[:limit]) + f" or {len(names) - limit} more"


def describe(org_id: uuid.UUID, doc: dict[str, Any]) -> str:
    """A plain-language sentence: "When Bearing temperature is above 180 for 3 of the last 5 readings, create…"."""
    t = doc.get("trigger") or {}
    kind = t.get("type")
    targets = [str(x) for x in doc.get("targets") or []]
    parts: list[str] = []
    if kind == "meter_reading":
        from mpro.meters.models import Meter

        names = _names(org_id, "meter", targets)
        unit = ""
        if targets:
            unit = db.session.scalar(select(Meter.unit).where(Meter.id == uuid.UUID(targets[0]))) or ""
        cond = t.get("condition", "")
        val = f"{_num(t.get('value'))} {unit}".strip() if t.get("value") not in (None, "") else "…"
        what = f"{_list_text(names) or 'a meter'} {COND_LABEL.get(cond, cond)} {val}"
        if cond in RECURRING and t.get("first_at") not in (None, ""):
            what += f" (first at {_num(t['first_at'])})"
        s = doc.get("sensitivity") or {}
        mode = s.get("mode", "once")
        if cond not in RECURRING:
            what += {
                "every": " on any reading",
                "once": "",
                "n_of_m": f" for {s.get('n')} of the last {s.get('m')} readings",
                "duration": f" for longer than {s.get('minutes')} minutes",
            }.get(mode, "")
        parts.append(f"When {what}")
    elif kind in ("asset_status", "work_order_status"):
        names = _names(org_id, "asset", targets)
        subject = (
            (_list_text(names) or "any asset")
            if kind == "asset_status"
            else ("a work order on " + _list_text(names) if names else "any work order")
        )
        frm = ", ".join(STATUS_LABEL.get(x, x) for x in t.get("from") or [])
        to = ", ".join(STATUS_LABEL.get(x, x) for x in t.get("to") or [])
        verb = "goes" if kind == "asset_status" else "moves"
        txt = f"When {subject} {verb}"
        txt += f" from {frm}" if frm else ""
        txt += f" to {to}" if to else " to another status"
        if kind == "work_order_status" and t.get("priorities"):
            txt += " (priority " + ", ".join(t["priorities"]) + ")"
        parts.append(txt)
    else:
        parts.append("When …")
    for c in doc.get("conditions") or []:
        if c.get("type") == "asset_status":
            parts.append("and the asset is " + " or ".join(STATUS_LABEL.get(x, x) for x in c.get("in", [])))
        elif c.get("type") == "weekday":
            parts.append("on " + ", ".join(WEEKDAYS[d] for d in c.get("days", [])))
        elif c.get("type") == "time_window":
            parts.append(f"between {c.get('from')} and {c.get('to')}")
    acts = []
    for a in doc.get("actions") or []:
        if a.get("type") == "create_work_order":
            title = a.get("title") or "from a template"
            prio = f"{a['priority']} priority " if a.get("priority") not in (None, "", "none") else ""
            acts.append(f"create a {prio}work order “{title}”")
        elif a.get("type") == "change_asset_status":
            acts.append(f"set the asset to {STATUS_LABEL.get(a.get('status', ''), a.get('status'))}")
        elif a.get("type") == "send_email":
            acts.append(
                f"email {len(a.get('recipients') or [])} recipient{'s' if len(a.get('recipients') or []) != 1 else ''}"
            )
    return ", ".join(parts) + ", " + (" and ".join(acts) if acts else "do …") + "."


# ---- serialization -----------------------------------------------------------------------------------------
def next_expected(a: Automation) -> list[dict[str, Any]]:
    """What would fire next, per target (r202): a meter value, or "after <time>" for duration mode."""
    t = a.trigger or {}
    if t.get("type") != "meter_reading":
        return []
    states = {
        s.target_id: s
        for s in db.session.scalars(select(AutomationState).where(AutomationState.automation_id == a.id)).all()
    }
    out = []
    for tid in a.targets:
        row = states.get(tid)
        st = (row.state if row is not None else {}) or {}
        cond = t.get("condition")
        item: dict[str, Any] = {"target_id": tid}
        if cond in RECURRING:
            nxt = st.get("next") or (t.get("first_at") or t.get("value"))
            if cond == "decreases_by" and "next" not in st:
                nxt = t.get("first_at")
            item["value"] = _num(nxt) if nxt is not None else None
        elif cond in ("above", "below", "equal"):
            item["value"] = _num(t.get("value"))
            if st.get("since") and (a.sensitivity or {}).get("mode") == "duration":
                since = datetime.fromisoformat(st["since"])
                item["at"] = iso(since + timedelta(minutes=int(a.sensitivity.get("minutes", 0))))
        out.append(item)
    return out


def automation_dict(a: Automation, detail: bool = False) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": str(a.id),
        "name": a.name,
        "description": a.description,
        "active": a.active,
        "trigger": a.trigger,
        "conditions": a.conditions,
        "actions": a.actions,
        "sensitivity": a.sensitivity,
        "rerun_minutes": a.rerun_minutes,
        "targets": a.targets,
        "summary": describe(
            a.org_id,
            {
                "trigger": a.trigger,
                "targets": a.targets,
                "conditions": a.conditions,
                "actions": a.actions,
                "sensitivity": a.sensitivity,
            },
        ),
        "run_count": a.run_count,
        "fail_count": a.fail_count,
        "skip_count": a.skip_count,
        "last_run_at": iso(a.last_run_at),
        "created_at": iso(a.created_at),
        "updated_at": iso(a.updated_at),
        "legacy": a.legacy_trigger_id is not None,
    }
    kind = "meter" if (a.trigger or {}).get("type") == "meter_reading" else "asset"
    d["target_kind"] = kind
    d["target_names"] = _names(a.org_id, kind, a.targets[:20])
    if detail:
        d["next_expected"] = next_expected(a)
    return d


def run_dict(r: AutomationRun, wo_numbers: dict[uuid.UUID, int] | None = None) -> dict[str, Any]:
    res = []
    for x in r.results or []:
        y = dict(x)
        if y.get("work_order_id") and wo_numbers is not None:
            y["work_order_number"] = wo_numbers.get(uuid.UUID(y["work_order_id"]))
        res.append(y)
    return {
        "id": str(r.id),
        "target_id": r.target_id,
        "status": r.status,
        "message": r.message,
        "results": res,
        "at": iso(r.at),
    }


# ---- evaluation --------------------------------------------------------------------------------------------
def _state(a: Automation, target_id: str) -> AutomationState:
    st = db.session.scalars(
        select(AutomationState)
        .where(AutomationState.automation_id == a.id, AutomationState.target_id == target_id)
        .with_for_update()
    ).first()
    if st is None:
        st = AutomationState(org_id=a.org_id, automation_id=a.id, target_id=target_id, state={})
        db.session.add(st)
        db.session.flush()
    return st


def _org_tz(org: Organization) -> ZoneInfo:
    try:
        return ZoneInfo(org.timezone or "UTC")
    except Exception:  # noqa: BLE001 - bad stored zone: fall back
        return ZoneInfo("UTC")


def _conditions_hold(org: Organization, a: Automation, asset: Any, now: datetime) -> str | None:
    """None if all conditions hold, else why not (for the skipped run)."""
    local = now.astimezone(_org_tz(org))
    for c in a.conditions or []:
        if c["type"] == "asset_status":
            if asset is None or asset.status not in c["in"]:
                return "Asset status condition not met"
        elif c["type"] == "weekday":
            if local.weekday() not in c["days"]:
                return "Not on a selected weekday"
        elif c["type"] == "time_window":
            hm = local.strftime("%H:%M")
            lo, hi = c["from"], c["to"]
            inside = lo <= hm <= hi if lo <= hi else (hm >= lo or hm <= hi)  # overnight windows
            if not inside:
                return f"Outside {lo}–{hi}"
    return None


NOT_RUN_AS_CREATOR = (
    "Not run: the person who created this automation can no longer manage automations. "
    "Someone who can should open and save it to take it over."
)


def _actor(org: Organization, a: Automation) -> Membership | None:
    """Automations act as their creator, and only while the creator may still manage automations (#16).
    Automations converted from 0.3.0 meter triggers (no real author) fall back to the first Owner/Administrator."""
    from mpro.core.permissions import can

    m = None
    if a.created_by_id:
        m = db.session.scalars(
            select(Membership).where(
                Membership.org_id == org.id, Membership.user_id == a.created_by_id, Membership.deleted_at.is_(None)
            )
        ).first()
        if m is not None and not can(m, "automations.manage"):
            m = None
        if m is None and a.legacy_trigger_id is None:
            return None
    if m is None:
        m = db.session.scalars(
            select(Membership)
            .where(
                Membership.org_id == org.id, Membership.role.in_(("owner", "admin")), Membership.deleted_at.is_(None)
            )
            .order_by(Membership.created_at)
        ).first()
    return m


def _fmt(text: str, ctx: dict[str, Any]) -> str:
    def rep(mo: re.Match[str]) -> str:
        v = ctx.get(mo.group(1))
        return "" if v is None else str(v)

    return re.sub(r"\{(\w+)\}", rep, text)


def _run_actions(
    org: Organization, a: Automation, st: AutomationState, target_asset: Any, ctx: dict[str, Any], now: datetime
) -> tuple[str, str, list[dict[str, Any]]]:
    from mpro.workorders.models import ACTIVE_STATUSES, WorkOrder

    m = _actor(org, a)
    if m is None:
        why = NOT_RUN_AS_CREATOR if a.created_by_id else "No one in the organization can run this automation."
        return "failed", why, []
    results: list[dict[str, Any]] = []
    action_at = dict(st.state.get("action_at") or {})
    failed = done_any = False
    for idx, act in enumerate(a.actions or []):
        key = str(idx)
        rerun = int(act.get("rerun_minutes") or 0)
        if rerun and action_at.get(key) and now - datetime.fromisoformat(action_at[key]) < timedelta(minutes=rerun):
            results.append(
                {"action": act["type"], "ok": False, "skipped": True, "message": "Re-run interval not reached"}
            )
            continue
        # No savepoints here: work-order numbering uses its own savepoint, and validation errors (RuleError) are
        # raised before anything is written.
        try:
            if act["type"] == "create_work_order":
                # one open work order per action (#11); "open_wo" is the pre-fix single slot (first action)
                open_wos = dict(st.state.get("open_wos") or {})
                open_id = open_wos.get(key) or (st.state.get("open_wo") if key == "0" else None)
                if open_id:
                    still = db.session.scalar(
                        select(WorkOrder.id).where(
                            WorkOrder.id == uuid.UUID(open_id),
                            WorkOrder.status.in_(ACTIVE_STATUSES),
                            WorkOrder.deleted_at.is_(None),
                        )
                    )
                    if still:
                        results.append(
                            {
                                "action": act["type"],
                                "ok": False,
                                "skipped": True,
                                "work_order_id": open_id,
                                "message": "The work order from last time is still open",
                            }
                        )
                        continue
                wo = _create_wo(org, m, a, act, target_asset, ctx)
                open_wos[key] = str(wo.id)
                st.state = {**{k: v for k, v in st.state.items() if k != "open_wo"}, "open_wos": open_wos}
                results.append(
                    {"action": act["type"], "ok": True, "work_order_id": str(wo.id), "message": f"Created #{wo.number}"}
                )
            elif act["type"] == "change_asset_status":
                if target_asset is None:
                    results.append(
                        {"action": act["type"], "ok": False, "skipped": True, "message": "No asset to change"}
                    )
                    continue
                from mpro.assets.services import set_status

                set_status(
                    org,
                    m,
                    target_asset,
                    act["status"],
                    reason=act.get("reason", ""),
                    downtime_type=act.get("downtime_type", ""),
                    note=_fmt(act.get("note") or f"Set by the automation “{a.name}”.", ctx),
                    commit=False,
                )
                results.append(
                    {
                        "action": act["type"],
                        "ok": True,
                        "message": f"Set {target_asset.name} to {STATUS_LABEL[act['status']]}",
                    }
                )
            elif act["type"] == "send_email":
                from mpro.core.mail import send_email

                emails = _recipient_emails(org.id, act.get("recipients") or [])
                body = _fmt(act.get("body") or "", ctx) or describe(org.id, _doc(a))
                body += f"\n\n— Sent by the automation “{a.name}” in Maintenance Pro."
                for e in emails:
                    send_email(e, _fmt(act["subject"], ctx), body, org_id=org.id)
                results.append({"action": act["type"], "ok": True, "message": f"Emailed {len(emails)} people"})
            action_at[key] = now.isoformat()
            done_any = True
        except RuleError as e:
            failed = True
            results.append({"action": act["type"], "ok": False, "message": e.message})
    st.state = {**st.state, "action_at": action_at}
    if failed:
        return "failed", "; ".join(r["message"] for r in results if not r["ok"] and not r.get("skipped")), results
    if not done_any:
        return "skipped", "; ".join(r["message"] for r in results), results
    return "ok", "; ".join(r["message"] for r in results), results


def _doc(a: Automation) -> dict[str, Any]:
    return {
        "trigger": a.trigger,
        "targets": a.targets,
        "conditions": a.conditions,
        "actions": a.actions,
        "sensitivity": a.sensitivity,
    }


def _recipient_emails(org_id: uuid.UUID, recipients: list[str]) -> list[str]:
    from mpro.auth.models import User

    users: set[uuid.UUID] = set()
    for r in recipients:
        kind, _, raw = r.partition(":")
        if kind == "user":
            users.add(uuid.UUID(raw))
        elif kind == "team":
            users |= set(
                db.session.scalars(select(TeamMember.user_id).where(TeamMember.team_id == uuid.UUID(raw))).all()
            )
    if not users:
        return []
    rows = db.session.scalars(
        select(User.email)
        .join(Membership, Membership.user_id == User.id)
        .where(
            User.id.in_(users), Membership.org_id == org_id, Membership.deleted_at.is_(None), User.deleted_at.is_(None)
        )
    ).all()
    return sorted(set(rows))


def _create_wo(
    org: Organization, m: Membership, a: Automation, act: dict[str, Any], asset: Any, ctx: dict[str, Any]
) -> Any:
    from mpro.workorders.models import Template
    from mpro.workorders.services import create_work_order

    data: dict[str, Any] = {}
    due_in = act.get("due_in_days")
    if act.get("template_id"):
        tpl = db.session.get(Template, uuid.UUID(act["template_id"]))
        if tpl is None or tpl.deleted_at is not None:
            raise RuleError("The work order template was deleted.", 422)
        data = {k: v for k, v in (tpl.data or {}).items() if k not in ("due_in_days", "asset_id", "location_id")}
        data.setdefault("title", tpl.name)
        data["template_id"] = str(tpl.id)
        if due_in is None and (tpl.data or {}).get("due_in_days") not in (None, ""):
            due_in = tpl.data["due_in_days"]
    for k in WO_FIELDS:
        if act.get(k) not in (None, ""):
            data[k] = act[k]
    data["title"] = _fmt(str(data.get("title") or a.name), ctx)[:255]
    note = f"Created by the automation “{a.name}”: {ctx.get('event', '')}".strip()
    desc = _fmt(str(data.get("description") or ""), ctx)
    data["description"] = (desc + ("\n\n" if desc else "") + note)[:4096]
    if due_in not in (None, ""):
        from mpro.workorders.services import due_days

        data["due_at"] = (utcnow() + timedelta(days=due_days(due_in))).isoformat()
    if asset is not None:
        data["asset_id"] = str(asset.id)
        if asset.location_id:
            data["location_id"] = str(asset.location_id)
    if ctx.get("location_id") and "location_id" not in data:
        data["location_id"] = ctx["location_id"]
    wo = create_work_order(org, m, data, commit=False, check_required=False)
    wo.source_type, wo.source_id = "automation", a.id
    return wo


def _record(
    org: Organization,
    a: Automation,
    target_id: str,
    status: str,
    message: str,
    results: list[dict[str, Any]],
    now: datetime,
) -> None:
    db.session.add(
        AutomationRun(
            id=uuid7(),
            org_id=org.id,
            automation_id=a.id,
            target_id=target_id,
            status=status,
            message=message[:2000],
            results=results,
            at=now,
        )
    )
    a.last_run_at = now
    if status == "ok":
        a.run_count += 1
    elif status == "failed":
        a.fail_count += 1
    else:
        a.skip_count += 1
    if status != "skipped":
        emit(
            "automation.ran" if status == "ok" else "automation.failed",
            entity_type="automation",
            entity_id=a.id,
            entity_label=a.name,
            summary=f"Automation {a.name}: {message}"[:500],
            org_id=org.id,
        )


def _fire(
    org: Organization, a: Automation, st: AutomationState, asset: Any, ctx: dict[str, Any], now: datetime
) -> None:
    if _depth.get() >= MAX_DEPTH:
        _record(org, a, st.target_id, "skipped", "Stopped a chain of automations triggering each other", [], now)
        return
    if a.rerun_minutes and st.last_fired_at and now - st.last_fired_at < timedelta(minutes=a.rerun_minutes):
        _record(org, a, st.target_id, "skipped", "Re-run interval not reached", [], now)
        return
    why = _conditions_hold(org, a, asset, now)
    if why:
        _record(org, a, st.target_id, "skipped", why, [], now)
        return
    token = _depth.set(_depth.get() + 1)
    try:
        status, message, results = _run_actions(org, a, st, asset, ctx, now)
    finally:
        _depth.reset(token)
    if status == "ok":
        st.last_fired_at = now
    _record(org, a, st.target_id, status, message or status, results, now)


def _active(org_id: uuid.UUID, kind: str) -> list[Automation]:
    return [
        a
        for a in db.session.scalars(
            select(Automation).where(
                Automation.org_id == org_id, Automation.active.is_(True), Automation.deleted_at.is_(None)
            )
        ).all()
        if (a.trigger or {}).get("type") == kind
    ]


def _meets(cond: str, value: Decimal, v: Decimal) -> bool:
    return {"above": v > value, "below": v < value, "equal": v == value}.get(cond, False)


def on_meter_reading(org: Organization, mt: Any, prev: Decimal | None, v: Decimal, r: Any) -> None:
    """READING_HOOKS entry: evaluate meter automations for the latest reading of a meter."""
    from mpro.assets.models import Asset

    autos = [a for a in _active(org.id, "meter_reading") if str(mt.id) in (a.targets or [])]
    if not autos:
        return
    asset = db.session.get(Asset, mt.asset_id) if mt.asset_id else None
    now = r.recorded_at or utcnow()
    for a in autos:
        t = a.trigger
        cond, val = t["condition"], Decimal(t["value"])
        st = _state(a, str(mt.id))
        s = dict(st.state or {})
        ctx = {
            "automation": a.name,
            "meter": mt.name,
            "unit": mt.unit,
            "value": _num(v),
            "asset": asset.name if asset else "",
            "location_id": str(mt.location_id) if mt.location_id else None,
            "event": f"{mt.name} read {_num(v)} {mt.unit} on {now:%Y-%m-%d %H:%M} UTC.",
        }
        hit = False
        if cond in RECURRING:
            up = cond == "increases_by"
            first = Decimal(t["first_at"]) if t.get("first_at") not in (None, "") else (val if up else None)
            nxt = Decimal(s["next"]) if s.get("next") not in (None, "") else None
            if nxt is None:
                if first is None:  # decreases_by without a first point: count down from the first reading
                    first = (prev if prev is not None else v) - val
                nxt = first
                base = prev if prev is not None else None
                if base is not None:  # skip milestones already passed before the automation existed
                    while (up and nxt <= base) or (not up and nxt >= base):
                        nxt = nxt + val if up else nxt - val
            if (up and v >= nxt) or (not up and v <= nxt):
                hit = True
                while (up and nxt <= v) or (not up and nxt >= v):
                    nxt = nxt + val if up else nxt - val
            s["next"] = str(nxt)
        else:
            if cond == "increases_from_last":
                meets = prev is not None and v - prev >= val
            elif cond == "decreases_from_last":
                meets = prev is not None and prev - v >= val
            else:
                meets = _meets(cond, val, v)
            mode = (a.sensitivity or {}).get("mode", "once")
            if mode == "every":
                hit = meets
            elif mode == "once":
                hit = meets and not s.get("fired")
                s["fired"] = bool(meets)  # rearm after a reading that doesn't meet the condition
            elif mode == "n_of_m":
                n, mm = int(a.sensitivity["n"]), int(a.sensitivity["m"])
                window = (list(s.get("window") or []) + [bool(meets)])[-mm:]
                enough = sum(window) >= n
                hit = enough and not s.get("fired")
                s["fired"] = enough  # rearm once fewer than N of the last M readings meet the condition
                s["window"] = window
            elif mode == "duration":
                if meets:
                    since = s.get("since") or now.isoformat()
                    s["since"] = since
                    hit = not s.get("fired") and now - datetime.fromisoformat(since) >= timedelta(
                        minutes=int(a.sensitivity["minutes"])
                    )
                    s["fired"] = bool(s.get("fired")) or hit
                else:
                    s.pop("since", None)
                    s["fired"] = False
                s["last_value"] = str(v)
        st.state = s
        if hit:
            _fire(org, a, st, asset, ctx, now)


def check_durations() -> int:
    """Periodic: fire duration-mode meter automations whose condition has held long enough without a new reading."""
    from mpro.assets.models import Asset
    from mpro.meters.models import Meter

    fired = 0
    now = utcnow()
    autos = db.session.scalars(
        select(Automation).where(Automation.active.is_(True), Automation.deleted_at.is_(None))
    ).all()
    for a in autos:
        if (a.trigger or {}).get("type") != "meter_reading" or (a.sensitivity or {}).get("mode") != "duration":
            continue
        org = db.session.get(Organization, a.org_id)
        if org is None:
            continue
        for st in db.session.scalars(
            select(AutomationState).where(AutomationState.automation_id == a.id).with_for_update()
        ).all():
            s = dict(st.state or {})
            if not s.get("since") or s.get("fired"):
                continue
            if now - datetime.fromisoformat(s["since"]) < timedelta(minutes=int(a.sensitivity["minutes"])):
                continue
            mt = db.session.get(Meter, uuid.UUID(st.target_id))
            if mt is None or mt.deleted_at is not None:
                continue
            asset = db.session.get(Asset, mt.asset_id) if mt.asset_id else None
            s["fired"] = True
            st.state = s
            ctx = {
                "automation": a.name,
                "meter": mt.name,
                "unit": mt.unit,
                "value": _num(Decimal(s.get("last_value") or "0")),
                "asset": asset.name if asset else "",
                "location_id": str(mt.location_id) if mt.location_id else None,
                "event": f"{mt.name} stayed past the limit for {a.sensitivity['minutes']} minutes.",
            }
            _fire(org, a, st, asset, ctx, now)
            fired += 1
    db.session.commit()
    return fired


def on_asset_status(org: Organization, m: Membership, asset: Any, from_status: str, to_status: str) -> None:
    """ASSET_STATUS_HOOKS entry."""
    now = utcnow()
    for a in _active(org.id, "asset_status"):
        if a.targets and str(asset.id) not in a.targets:
            continue
        t = a.trigger
        if (t.get("from") and from_status not in t["from"]) or (t.get("to") and to_status not in t["to"]):
            continue
        st = _state(a, str(asset.id))
        ctx = {
            "automation": a.name,
            "asset": asset.name,
            "status": STATUS_LABEL.get(to_status, to_status),
            "event": f"{asset.name} went from {STATUS_LABEL.get(from_status, from_status)} to "
            f"{STATUS_LABEL.get(to_status, to_status)}.",
        }
        _fire(org, a, st, asset, ctx, now)


def on_work_order_status(org: Organization, m: Membership, wo: Any, from_status: str, to_status: str) -> None:
    """STATUS_HOOKS entry."""
    from mpro.assets.models import Asset

    autos = _active(org.id, "work_order_status")
    if not autos:
        return
    now = utcnow()
    cats = {str(c.category_id) for c in wo.category_links}
    from mpro.workorders.wo_assets import asset_ids_of

    on_wo = [str(x) for x in asset_ids_of(wo)]  # every asset on the work order (MP-124)
    for a in autos:
        if wo.source_type == "automation" and wo.source_id == a.id:
            continue  # don't react to work orders this automation made itself
        t = a.trigger
        if a.targets and not set(on_wo) & set(a.targets):
            continue
        if (t.get("from") and from_status not in t["from"]) or (t.get("to") and to_status not in t["to"]):
            continue
        if t.get("priorities") and wo.priority not in t["priorities"]:
            continue
        if t.get("categories") and not cats & set(t["categories"]):
            continue
        asset = db.session.get(Asset, wo.asset_id) if wo.asset_id else None
        st = _state(a, str(wo.asset_id) if wo.asset_id else "*")
        ctx = {
            "automation": a.name,
            "asset": asset.name if asset else "",
            "work_order": f"#{wo.number} {wo.title}",
            "status": STATUS_LABEL.get(to_status, to_status),
            "location_id": str(wo.location_id) if wo.location_id else None,
            "event": f"Work order #{wo.number} {wo.title} moved to {STATUS_LABEL.get(to_status, to_status)}.",
        }
        _fire(org, a, st, asset, ctx, now)


# ---- legacy meter triggers (0.3.0) -------------------------------------------------------------------------
def convert_legacy_triggers(org_id: uuid.UUID | None = None) -> int:
    """Turn 0.3.0 meter triggers into automations (once each) and switch the triggers off."""
    from mpro.meters.models import Meter, MeterTrigger

    q = select(MeterTrigger).where(MeterTrigger.deleted_at.is_(None))
    if org_id is not None:
        q = q.where(MeterTrigger.org_id == org_id)
    n = 0
    for t in db.session.scalars(q).all():
        if db.session.scalar(select(Automation.id).where(Automation.legacy_trigger_id == t.id)):
            continue
        mt = db.session.get(Meter, t.meter_id)
        if mt is None:
            continue
        doc = legacy_to_doc(
            {
                "name": t.name,
                "kind": t.kind,
                "comparator": t.comparator,
                "threshold": t.threshold,
                "every_units": t.every_units,
                "next_at": t.next_at,
                "work_order": t.work_order or {},
                "active": t.active,
                "meter_id": t.meter_id,
            }
        )
        a = Automation(
            id=uuid7(),
            org_id=t.org_id,
            created_by_id=mt.created_by_id,
            legacy_trigger_id=t.id,
            run_count=t.fired_count or 0,
            fail_count=0,
            skip_count=0,
            last_run_at=t.last_fired_at,
            **doc,
        )
        db.session.add(a)
        db.session.flush()
        if t.kind == "every" and t.next_at is not None:
            db.session.add(
                AutomationState(
                    org_id=t.org_id, automation_id=a.id, target_id=str(mt.id), state={"next": str(t.next_at)}
                )
            )
        t.active = False
        n += 1
    return n


def legacy_to_doc(t: dict[str, Any]) -> dict[str, Any]:
    """Shared by the 0004 data migration (which can't import app code, so it carries a copy) and demo seeding."""
    wo = dict(t.get("work_order") or {})
    action: dict[str, Any] = {"type": "create_work_order", "rerun_minutes": 0}
    for k in ("title", "description", "priority", "assignees", "categories", "estimated_minutes"):
        if wo.get(k) not in (None, ""):
            action[k] = wo[k]
    if wo.get("due_in_days") not in (None, ""):
        from mpro.workorders.services import due_days

        action["due_in_days"] = due_days(wo["due_in_days"])
    action.setdefault("title", t.get("name") or "Meter work")
    if t["kind"] == "every":
        every = Decimal(str(t.get("every_units") or 1))
        nxt = Decimal(str(t["next_at"])) if t.get("next_at") is not None else every
        trigger = {"type": "meter_reading", "condition": "increases_by", "value": str(every), "first_at": str(nxt)}
        action["work_type"] = "preventive"
        sensitivity: dict[str, Any] = {}
    else:
        trigger = {
            "type": "meter_reading",
            "condition": "above" if t.get("comparator", "gt") == "gt" else "below",
            "value": str(Decimal(str(t.get("threshold") or 0))),
        }
        sensitivity = {"mode": "once"}  # 0.3.0 triggers fired when the value crossed the threshold
    return {
        "name": (t.get("name") or "Meter trigger")[:255],
        "description": "Converted from a 0.3.0 meter trigger.",
        "active": bool(t.get("active", True)),
        "trigger": trigger,
        "conditions": [],
        "actions": [action],
        "sensitivity": sensitivity,
        "rerun_minutes": 0,
        "targets": [str(t["meter_id"])],
    }


def meter_copied(old_meter_id: uuid.UUID, new_meter_id: uuid.UUID) -> None:
    """A copied meter joins the automations of the original (while they have room)."""
    for a in db.session.scalars(select(Automation).where(Automation.deleted_at.is_(None))).all():
        if str(old_meter_id) in (a.targets or []) and len(a.targets) < MAX_TARGETS:
            a.targets = [*a.targets, str(new_meter_id)]


# ---- warranty reminders (MP-119) ---------------------------------------------------------------------------
def warranty_reminders(today: date | None = None, days: int = 30) -> int:
    """Daily: email the teams in charge of assets whose warranty ends within `days`, once per warranty end date."""
    from mpro.assets.models import Asset, TeamInCharge
    from mpro.auth.models import User
    from mpro.core.mail import send_email
    from mpro.core.settings import get_settings, save_settings

    today = today or utcnow().date()
    sent = 0
    rows = db.session.scalars(
        select(Asset).where(
            Asset.deleted_at.is_(None),
            Asset.warranty_end.is_not(None),
            Asset.warranty_end >= today,
            Asset.warranty_end <= today + timedelta(days=days),
        )
    ).all()
    by_org: dict[uuid.UUID, list[Any]] = {}
    for a in rows:
        by_org.setdefault(a.org_id, []).append(a)
    for org_id, assets in by_org.items():
        org = db.session.get(Organization, org_id)
        if org is None or org.deleted_at is not None:
            continue
        marks = dict(get_settings(org_id, "warranty_reminders")["sent"])
        new_marks: dict[str, str] = {}
        for a in assets:
            assert a.warranty_end is not None
            if marks.get(str(a.id)) == a.warranty_end.isoformat():
                continue
            team_ids = db.session.scalars(
                select(TeamInCharge.team_id).where(TeamInCharge.entity_type == "asset", TeamInCharge.entity_id == a.id)
            ).all()
            users: set[uuid.UUID] = set()
            if team_ids:
                users = set(
                    db.session.scalars(select(TeamMember.user_id).where(TeamMember.team_id.in_(team_ids))).all()
                )
            if not users:  # nobody in charge: tell the owners and administrators
                users = set(
                    db.session.scalars(
                        select(Membership.user_id).where(
                            Membership.org_id == org_id,
                            Membership.role.in_(("owner", "admin")),
                            Membership.deleted_at.is_(None),
                        )
                    ).all()
                )
            emails = sorted(
                set(
                    db.session.scalars(
                        select(User.email)
                        .join(Membership, Membership.user_id == User.id)
                        .where(User.id.in_(users), Membership.org_id == org_id, Membership.deleted_at.is_(None))
                    ).all()
                )
            )
            left = (a.warranty_end - today).days
            body = (
                f"The warranty on {a.name} ends on {a.warranty_end:%B %d, %Y} "
                f"({left} day{'s' if left != 1 else ''} from now).\n"
                + (f"Provider: {a.warranty_provider}\n" if a.warranty_provider else "")
                + "\nIf something needs fixing under warranty, now is the time to book it.\n"
                + f"\nOpen the asset: {_base_url()}/assets/{a.id}\n\n— Maintenance Pro"
            )
            for e in emails:
                send_email(e, f"Warranty ending soon: {a.name}", body, org_id=org_id)
            emit(
                "asset.warranty_reminder",
                entity_type="asset",
                entity_id=a.id,
                entity_label=a.name,
                summary=f"Sent a warranty reminder to {len(emails)} people",
                org_id=org_id,
            )
            new_marks[str(a.id)] = a.warranty_end.isoformat()
            sent += 1
        if new_marks:
            save_settings(org_id, "warranty_reminders", {"sent": {**marks, **new_marks}})
    db.session.commit()
    return sent


def _base_url() -> str:
    from flask import current_app

    return str(current_app.config.get("MPRO_BASE_URL", "")).rstrip("/")


def counts_by_target(org_id: uuid.UUID) -> dict[str, int]:
    """How many automations watch each asset/meter (for badges on asset and meter pages)."""
    out: dict[str, int] = {}
    for a in db.session.scalars(
        select(Automation).where(Automation.org_id == org_id, Automation.deleted_at.is_(None))
    ).all():
        for t in a.targets or []:
            out[t] = out.get(t, 0) + 1
    return out


_ = func
