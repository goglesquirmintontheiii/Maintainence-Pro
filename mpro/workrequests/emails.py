"""Emails to people outside the organization who sent a request through a portal and asked to hear back (r280).

These are event consumers (G-05): approval, decline (with the reason) and completion. Signed-in requesters are told
by the notifications module (F3), which consumes the same `request.*` events.
"""

from __future__ import annotations

import uuid

from flask import current_app

from mpro.core.events import DomainEvent, consumer
from mpro.core.mail import send_email
from mpro.extensions import db
from mpro.orgs.models import Organization
from mpro.workrequests.models import WorkRequest


def _request(ev: DomainEvent) -> WorkRequest | None:
    try:
        r = db.session.get(WorkRequest, uuid.UUID(ev.entity_id))
    except ValueError:
        return None
    if r is None or r.deleted_at is not None or r.created_by_id is not None:
        return None
    if not (r.notify_email and r.submitter_email):
        return None
    return r


def _send(r: WorkRequest, subject: str, text: str) -> None:
    org = db.session.get(Organization, r.org_id)
    name = org.name if org is not None else "Maintenance"
    body = (
        f"Hi {r.submitter_name or 'there'},\n\n{text}\n\n"
        f"Request #{r.number}: {r.title}\n\n"
        "You can follow it with the status link from your first email.\n\n"
        f"— {name}"
    )
    send_email(r.submitter_email, f"{name}: {subject}", body, org_id=r.org_id)


@consumer("request.approved")
def _approved(ev: DomainEvent) -> None:
    r = _request(ev)
    if r is not None:
        n = (ev.data or {}).get("work_order_number")
        _send(r, f"Request #{r.number} approved", f"Your request was approved and is now work order #{n}.")


@consumer("request.declined")
def _declined(ev: DomainEvent) -> None:
    r = _request(ev)
    if r is not None:
        reason = (ev.data or {}).get("reason") or r.decline_reason
        _send(r, f"Request #{r.number} declined", f"Your request was declined.\n\nReason: {reason}")


@consumer("request.status_changed")
def _status(ev: DomainEvent) -> None:
    r = _request(ev)
    if r is None:
        return
    to = (ev.data or {}).get("to")
    if to == "done":
        _send(r, f"Request #{r.number} done", "The work for your request is done.")
    elif to == "canceled":
        _send(r, f"Request #{r.number} canceled", "The work for your request was canceled.")


def confirmation(r: WorkRequest, token: str) -> None:
    """Sent once, right after a portal submission: the only email that carries the status link (r603)."""
    if not r.submitter_email:
        return
    base = str(current_app.config.get("MPRO_BASE_URL", "")).rstrip("/")
    org = db.session.get(Organization, r.org_id)
    name = org.name if org is not None else "Maintenance"
    later = (
        "We'll email you when it's approved, declined or done."
        if r.notify_email
        else "Check the link below for updates."
    )
    send_email(
        r.submitter_email,
        f"{name}: we got your request #{r.number}",
        f"Hi {r.submitter_name or 'there'},\n\nThanks, we got your request #{r.number}: {r.title}\n\n{later}\n\n"
        f"Follow it here (no account needed):\n{base}/request-status/{token}\n\n— {name}",
        org_id=r.org_id,
    )


@consumer("wo.deleted")
def _wo_deleted(ev: DomainEvent) -> None:
    from mpro.workrequests.services import on_wo_deleted

    try:
        on_wo_deleted(uuid.UUID(ev.entity_id), restored=False)
    except ValueError:
        return


@consumer("wo.restored")
def _wo_restored(ev: DomainEvent) -> None:
    from mpro.workrequests.services import on_wo_deleted

    try:
        on_wo_deleted(uuid.UUID(ev.entity_id), restored=True)
    except ValueError:
        return
