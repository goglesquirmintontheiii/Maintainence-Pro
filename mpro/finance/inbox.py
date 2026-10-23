"""Email-in for receipts and vendor invoices (MP-091/MP-092): IMAP polling with plus-addresses.

Settings → Finance → Email-in names one mailbox, e.g. ap@example.com. Each organization has a secret (Settings shows
the full addresses and can make a new one): mail to ap+receipts-<secret>@example.com becomes receipts, mail to
ap+invoices-<secret>@example.com becomes vendor invoices (one per PDF/picture attachment). Mail without the secret is
skipped, so knowing the mailbox and a member's address isn't enough (review 0.5.0 #10). Only senders who are members of
the organization with the matching permission are accepted; other mail is marked read and skipped. A From address is
easy to fake, so documents are marked "sender not verified" unless the receiving server's Authentication-Results
header says dkim=pass for the From domain. Messages are marked \\Seen once handled, so each one is read once.

The mailbox host must not be a private, loopback or link-local address unless MPRO_ALLOW_PRIVATE_MAIL_HOSTS=1 (for
self-hosted installs whose mail server is on the LAN).

`IMAP_FACTORY` is replaceable (tests use a fake server).
"""

from __future__ import annotations

import contextlib
import email
import email.policy
import hmac
import imaplib
import ipaddress
import logging
import os
import re
import socket
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


class HostError(Exception):
    """The mailbox host is on a private network (and that isn't allowed here)."""


def private_hosts_allowed() -> bool:
    return os.environ.get("MPRO_ALLOW_PRIVATE_MAIL_HOSTS", "").strip().lower() in ("1", "true", "yes")


def _private(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped is not None:
        a = a.ipv4_mapped
    return a.is_private or a.is_loopback or a.is_link_local or a.is_reserved or a.is_unspecified or a.is_multicast


def check_host(host: str) -> None:
    """Refuse mailbox hosts on private, loopback or link-local addresses (the server would connect anywhere it's
    told to). Names that don't resolve are left to fail when connecting."""
    host = host.strip().strip("[]")
    if not host or private_hosts_allowed():
        return
    if host.lower() in ("localhost", "localhost.localdomain") or host.lower().endswith(".localhost"):
        raise HostError("That mail server is on this computer or a private network.")
    if _private(host):
        raise HostError("That mail server is on this computer or a private network.")
    try:
        infos = socket.getaddrinfo(host, None)
    except (OSError, UnicodeError):
        return
    if any(_private(str(i[4][0])) for i in infos):
        raise HostError("That mail server is on this computer or a private network.")


def route(msg: EmailMessage, address: str, secret: str = "") -> str | None:
    """'receipts' | 'invoices' | None from the plus-tag the message was sent to (`receipts-<secret>`)."""
    if not secret:
        return None
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
        kind, _, given = tag.partition("-")
        if not hmac.compare_digest(given.encode(), secret.lower().encode()):
            continue
        if kind in ("receipts", "receipt"):
            return "receipts"
        if kind in ("invoices", "invoice", "bills"):
            return "invoices"
    return None


_DKIM = re.compile(r"\bdkim\s*=\s*pass\b[^;]*?\bheader\.(?:d|i)\s*=\s*@?([A-Za-z0-9.-]+)", re.IGNORECASE)


def sender_verified(msg: EmailMessage, sender: str) -> bool:
    """True when the receiving server's Authentication-Results (the topmost one: the one it added itself; headers
    further down come from the sender and can say anything) has dkim=pass for the From domain or a parent of it."""
    if "@" not in sender:
        return False
    dom = sender.rsplit("@", 1)[1].lower().rstrip(".")
    results = msg.get_all("Authentication-Results") or []
    if not results:
        return False
    for signed in _DKIM.findall(str(results[0])):
        d = signed.lower().rstrip(".")
        if dom == d or dom.endswith("." + d):
            return True
    return False


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


def handle_message(org_id: uuid.UUID, raw: bytes, address: str, secret: str = "") -> dict[str, Any]:
    """Turn one message into receipts / invoices. Returns what happened (for logs and tests)."""
    from mpro.core.permissions import can
    from mpro.finance import invoices, receipts

    msg = email.message_from_bytes(raw, policy=email.policy.default)
    assert isinstance(msg, EmailMessage)
    kind = route(msg, address, secret)
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
    verified = sender_verified(msg, sender)
    stamp = {"email_from": sender[:255], "sender_verified": verified}
    created: list[str] = []
    try:
        with db.session.begin_nested():
            if kind == "receipts":
                r = receipts.create(org_id, user, files[:20], source="email")
                r.extracted = {**(r.extracted or {}), **stamp}
                created.append(str(r.id))
            else:
                for f in files[:20]:
                    inv = invoices.create(org_id, user, file=f, source="email")
                    inv.extracted = {**(inv.extracted or {}), **stamp}
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
    secret = str(cfg.get("inbox_secret") or "")
    if not secret:
        return 0  # no secret yet: nothing would be accepted
    check_host(str(cfg["inbox_host"]))
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
                res = handle_message(org_id, raw, address, secret)
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
