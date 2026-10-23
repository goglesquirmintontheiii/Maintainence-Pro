"""Approval rules engine for purchase orders and vendor invoices (roadmap r230, MP-092).

Rules are checked in `sort` order against a dict of facts about the record. Every matching rule with action
"approvers" adds a pending `Approval` step (any one listed person, or anyone in a listed team, can decide it); a
matching "auto_approve" rule approves straight away, unless an earlier rule already asked for approvers.
No matching rule → no approval needed (the caller decides what that means: POs need po.approve, invoices are approved).

Facts the callers provide:
    total (Decimal), currency (str), has_one_off (bool), zero_cost_part (bool), location_id (str | None),
    vendor_id (str | None), category (str), custom ({field_id: value}), over_budget (bool)

Conditions (all must hold):
    {"field": "total", "op": ">=" | ">" | "<=" | "<" | "between", "value": "500" | ["100", "500"]}
    {"field": "has_one_off"} / {"field": "zero_cost_part"} / {"field": "over_budget"}
    {"field": "location" | "vendor", "op": "in", "value": ["<id>", ...]}
    {"field": "category", "op": "=", "value": "Spare parts"}
    {"field": "custom:<field id>", "op": "=", "value": "<option>"}
"""

from __future__ import annotations

import uuid
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import select

from mpro.core.events import emit
from mpro.core.models import utcnow
from mpro.extensions import db
from mpro.orgs.services import RuleError
from mpro.purchasing.models import Approval, ApprovalRule

OPS = (">=", ">", "<=", "<", "between", "in", "=")
FIELDS = ("total", "has_one_off", "zero_cost_part", "over_budget", "location", "vendor", "category")


def _num(v: Any) -> Decimal | None:
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError, TypeError):
        return None


def validate_conditions(conditions: Any) -> list[dict[str, Any]]:
    """Check a rule's conditions before saving it."""
    if not isinstance(conditions, list) or len(conditions) > 20:
        raise RuleError("Conditions must be a list (at most 20).", 422)
    out: list[dict[str, Any]] = []
    for c in conditions:
        if not isinstance(c, dict) or not isinstance(c.get("field"), str):
            raise RuleError("Each condition needs a field.", 422)
        f = c["field"]
        if f not in FIELDS and not f.startswith("custom:"):
            raise RuleError(f"Unknown condition: {f}.", 422)
        op = c.get("op")
        if f == "total":
            if op not in (">=", ">", "<=", "<", "between"):
                raise RuleError("Compare the total with >=, >, <=, < or between.", 422)
            vals = c.get("value") if op == "between" else [c.get("value")]
            if (
                not isinstance(vals, list)
                or len(vals) != (2 if op == "between" else 1)
                or any(_num(v) is None for v in vals)
            ):
                raise RuleError("The total must be compared with a number.", 422)
        elif f in ("location", "vendor"):
            if op != "in" or not isinstance(c.get("value"), list):
                raise RuleError(f"Pick one or more {f}s.", 422)
        elif f == "category" or f.startswith("custom:"):
            if op != "=" or not isinstance(c.get("value"), str):
                raise RuleError("Pick a value to compare with.", 422)
        out.append({k: c[k] for k in ("field", "op", "value") if k in c})
    return out


def _holds(c: dict[str, Any], facts: dict[str, Any]) -> bool:
    f = c.get("field", "")
    if f in ("has_one_off", "zero_cost_part", "over_budget"):
        return bool(facts.get(f))
    if f == "total":
        total = _num(facts.get("total")) or Decimal("0")
        op, v = c.get("op"), c.get("value")
        if op == "between" and isinstance(v, list) and len(v) == 2:
            lo, hi = _num(v[0]), _num(v[1])
            return lo is not None and hi is not None and lo <= total <= hi
        n = _num(v)
        if n is None:
            return False
        return {">=": total >= n, ">": total > n, "<=": total <= n, "<": total < n}.get(str(op), False)
    if f in ("location", "vendor"):
        val = facts.get(f + "_id")
        return val is not None and str(val) in {str(x) for x in (c.get("value") or [])}
    if f == "category":
        return str(facts.get("category") or "") == str(c.get("value") or "")
    if f.startswith("custom:"):
        return str((facts.get("custom") or {}).get(f[7:], "")) == str(c.get("value") or "")
    return False


def matching_rules(org_id: uuid.UUID, applies_to: str, facts: dict[str, Any]) -> list[ApprovalRule]:
    rules = db.session.scalars(
        select(ApprovalRule)
        .where(
            ApprovalRule.org_id == org_id,
            ApprovalRule.applies_to == applies_to,
            ApprovalRule.active.is_(True),
            ApprovalRule.deleted_at.is_(None),
        )
        .order_by(ApprovalRule.sort, ApprovalRule.created_at)
    ).all()
    return [r for r in rules if all(_holds(c, facts) for c in (r.conditions or []))]


def start(org_id: uuid.UUID, entity_type: str, entity_id: uuid.UUID, facts: dict[str, Any]) -> str:
    """Replace any pending steps with fresh ones from the rules. Returns "auto_approved", "pending" or "none"."""
    for old in db.session.scalars(
        select(Approval).where(
            Approval.org_id == org_id,
            Approval.entity_type == entity_type,
            Approval.entity_id == entity_id,
            Approval.status == "pending",
        )
    ):
        old.status = "skipped"
    rules = matching_rules(org_id, entity_type, facts)
    steps = [r for r in rules if r.action == "approvers"]
    if not steps:
        if any(r.action == "auto_approve" for r in rules):
            return "auto_approved"
        return "none"
    for r in steps:
        db.session.add(
            Approval(
                org_id=org_id,
                entity_type=entity_type,
                entity_id=entity_id,
                rule_id=r.id,
                approver_user_ids=list(r.approver_user_ids or []),
                approver_team_ids=list(r.approver_team_ids or []),
                status="pending",
            )
        )
    db.session.flush()
    return "pending"


def pending(org_id: uuid.UUID, entity_type: str, entity_id: uuid.UUID) -> list[Approval]:
    return list(
        db.session.scalars(
            select(Approval)
            .where(
                Approval.org_id == org_id,
                Approval.entity_type == entity_type,
                Approval.entity_id == entity_id,
                Approval.status == "pending",
            )
            .order_by(Approval.created_at)
        )
    )


def can_decide(step: Approval, user_id: uuid.UUID, team_ids: set[str], is_admin: bool) -> bool:
    """Listed approvers (or members of listed teams) decide; admins with the approve permission can always decide."""
    if is_admin:
        return True
    return str(user_id) in {str(x) for x in step.approver_user_ids or []} or bool(
        team_ids & {str(x) for x in step.approver_team_ids or []}
    )


def decide(
    org_id: uuid.UUID,
    entity_type: str,
    entity_id: uuid.UUID,
    *,
    approve: bool,
    user: Any,
    team_ids: set[str],
    is_admin: bool,
    comment: str = "",
) -> str:
    """Decide the steps this person may decide. Returns "approved" (all steps done), "rejected" or "pending"."""
    steps = pending(org_id, entity_type, entity_id)
    mine = [s for s in steps if can_decide(s, user.id, team_ids, is_admin)]
    if not mine:
        raise RuleError("You aren't an approver for this.", 403)
    if not approve and not comment.strip():
        raise RuleError("Say why it's rejected.", 422)
    now = utcnow()
    for s in mine:
        s.status = "approved" if approve else "rejected"
        s.decided_by_id = user.id
        s.decided_at = now
        s.comment = comment.strip()[:2000]
    if not approve:
        for s in steps:
            if s.status == "pending":
                s.status = "skipped"
    emit(
        f"{entity_type}.approval_decided",
        entity_type=entity_type,
        entity_id=entity_id,
        summary="Approved" if approve else "Rejected",
        data={"approve": approve, "comment": comment.strip()[:500]},
        org_id=org_id,
    )
    db.session.flush()
    if not approve:
        return "rejected"
    return "approved" if not pending(org_id, entity_type, entity_id) else "pending"
