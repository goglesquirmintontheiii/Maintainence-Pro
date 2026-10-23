"""Email-in for receipts and vendor invoices (MP-091/MP-092): IMAP polling with plus-addresses.

Settings → Finance → Email-in names one mailbox, e.g. ap@example.com. Mail to ap+receipts@example.com becomes receipts,
mail to ap+invoices@example.com becomes vendor invoices (one per PDF/picture attachment). Only senders who are members
of the organization with the matching permission are accepted; other mail is marked read and skipped. Messages are
marked \\Seen once handled, so each one is read once.

`IMAP_FACTORY` is replaceable (tests use a fake server).
"""

from __future__ import annotations

import contextlib
import email
import email.policy
import imaplib
import logging
import uuid
from collections.abc import Callable
from email.message import EmailMessage
from email.utils import getaddresses, parseaddr
from typing import Any

from sqlalchemy import func, select

from mpro.extensions import db

log = logging.getLogger(__name__)

IMAP_FACTORY: Callable[[str, int], Any] = lambda host, port: imaplib.IMAP4_SSL(host, port, timeout=30)  # noqa: E731
MAX_MESSAGES = 50
MAX_ATTACHMENT = 25 * 1024 * 1024


def route(msg: EmailMessage, address: str) -> str | None:
    """'receipts' | 'invoices' | None from the plus-tag the message was sent to."""
    local = address.split("@", 1)[0].lower() if "@" in address else ""
    heads: list[str] = []
    for h in ("Delivered-To", "X-Original-To", "To", "Cc"):
        heads += [str(v) for v in msg.get_all(h) or []]
    for _, addr in getaddresses(heads):
        a = addr.lower()
        if "+" not in a.split("@", 1)[0]:
            continue
        base, tag = a.split("@", 1)[0].split("+", 1)
        if local and base != local:
            continue
        if tag in ("receipts", "receipt"):
            return "receipts"
        if tag in ("invoices", "invoice", "bills"):
            return "invoices"
    return None


def _member(org_id: uuid.UUID, sender: str) -> tuple[Any, Any] | None:
    from mpro.auth.models import User
    from mpro.orgs.models import Membership

    u = db.session.scalars(select(User).where(func.lower(User.email) == sender.lower())).first()
    if u is None:
        return None
    m = db.session.scalars(
        select(Membership).where(
            Membership.org_id == org_id, Membership.user_id == u.id, Membership.deleted_at.is_(None)
        )
    ).first()
    return (u, m) if m is not None else None


def _attachments(msg: EmailMessage) -> list[tuple[str, bytes]]:
    out: list[tuple[str, bytes]] = []
    for part in msg.iter_attachments():
        ctype = part.get_content_type()
        if not (ctype.startswith("image/") or ctype == "application/pdf"):
            continue
        data = part.get_payload(decode=True)
        if not isinstance(data, bytes) or not data or len(data) > MAX_ATTACHMENT:
            continue
        name = part.get_filename() or ("receipt.pdf" if ctype == "application/pdf" else "receipt.jpg")
        out.append((name[:200], data))
    return out


def handle_message(org_id: uuid.UUID, raw: bytes, address: str) -> dict[str, Any]:
    """Turn one message into receipts / invoices. Returns what happened (for logs and tests)."""
    from mpro.core.permissions import can
    from mpro.finance import invoices, receipts

    msg = email.message_from_bytes(raw, policy=email.policy.default)
    assert isinstance(msg, EmailMessage)
    kind = route(msg, address)
    if kind is None:
        return {"skipped": "no plus-tag"}
    sender = parseaddr(str(msg.get("From") or ""))[1]
    who = _member(org_id, sender) if sender else None
    if who is None:
        return {"skipped": "unknown sender"}
    user, member = who
    if not can(member, "finance.receipts" if kind == "receipts" else "finance.invoices"):
        return {"skipped": "not allowed"}
    files = _attachments(msg)
    if not files:
        return {"skipped": "no attachments"}
    created: list[str] = []
    try:
        with db.session.begin_nested():
            if kind == "receipts":
                r = receipts.create(org_id, user, files[:20], source="email")
                created.append(str(r.id))
            else:
                for f in files[:20]:
                    inv = invoices.create(org_id, user, file=f, source="email")
                    created.append(str(inv.id))
    except Exception as e:  # noqa: BLE001 — one bad message must not stop the mailbox
        log.warning("Finance email-in: message from %s failed: %s", sender, e)
        return {"skipped": f"failed: {getattr(e, 'message', e)}"}
    return {"kind": kind, "created": created}


def poll_org(org_id: uuid.UUID) -> int:
    from mpro.core.crypto import decrypt_str
    from mpro.finance.settings import finance_settings

    cfg = finance_settings(org_id)
    if not cfg.get("inbox_enabled") or not cfg.get("inbox_host") or not cfg.get("inbox_user"):
        return 0
    password = decrypt_str(cfg["inbox_password"]) if cfg.get("inbox_password") else ""
    address = str(cfg.get("inbox_address") or cfg.get("inbox_user") or "")
    n = 0
    conn = IMAP_FACTORY(str(cfg["inbox_host"]), int(cfg.get("inbox_port") or 993))
    try:
        conn.login(str(cfg["inbox_user"]), password)
        conn.select(str(cfg.get("inbox_folder") or "INBOX"))
        typ, data = conn.search(None, "UNSEEN")
        ids = (data[0] or b"").split()[:MAX_MESSAGES] if typ == "OK" and data else []
        for mid in ids:
            typ, parts = conn.fetch(mid, "(RFC822)")
            raw = next((p[1] for p in parts or [] if isinstance(p, tuple) and len(p) > 1), None)
            if typ == "OK" and isinstance(raw, bytes):
                res = handle_message(org_id, raw, address)
                n += len(res.get("created") or [])
            conn.store(mid, "+FLAGS", "\\Seen")
            db.session.commit()
    finally:
        with contextlib.suppress(Exception):
            conn.logout()
    return n


def poll_all() -> int:
    """Periodic job: every organization with email-in turned on."""
    from mpro.core.settings import OrgSetting

    n = 0
    for org_id in db.session.scalars(select(OrgSetting.org_id).where(OrgSetting.key == "finance")).all():
        try:
            n += poll_org(org_id)
        except Exception as e:  # noqa: BLE001 — a broken mailbox must not stop the others
            db.session.rollback()
            log.warning("Finance email-in for org %s failed: %s", org_id, e)
    return n
