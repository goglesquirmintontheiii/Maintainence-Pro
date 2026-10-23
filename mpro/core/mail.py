"""Outgoing email. Every message is stored; sending happens in a background job.

Without SMTP configured (test builds, fresh installs) messages stay in the outbox, where
admins can read them in Settings > Email outbox (e.g. password-reset links).
"""

from __future__ import annotations

import smtplib
import uuid
from datetime import datetime
from email.message import EmailMessage
from typing import Any

from flask import current_app
from sqlalchemy import JSON, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.jobs import enqueue, job
from mpro.core.models import IdMixin, UTCDateTime, iso, utcnow
from mpro.extensions import db


class OutboundEmail(IdMixin, db.Model):  # type: ignore[name-defined]
    __tablename__ = "outbound_emails"

    org_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    to: Mapped[str] = mapped_column(String(320))
    subject: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text)
    cc: Mapped[str] = mapped_column(String(1000), default="")  # comma-separated (0.5.0)
    # [{"file_id": "...", "name": "PO-12.pdf"}] — files stored in MPro, read when the message is sent (0.5.0)
    attachments: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued | sent | not_configured | failed
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": str(self.id),
            "to": self.to,
            "subject": self.subject,
            "body": self.body,
            "cc": self.cc,
            "attachments": [{"file_id": a.get("file_id"), "name": a.get("name")} for a in self.attachments or []],
            "status": self.status,
            "error": self.error,
            "created_at": iso(self.created_at),
            "sent_at": iso(self.sent_at),
        }


def clean_subject(subject: str) -> str:
    """One line: CR/LF (header injection) and other control characters become spaces (#16)."""
    return " ".join("".join(" " if ord(c) < 32 or c == "\x7f" else c for c in subject).split())[:255]


def send_email(
    to: str,
    subject: str,
    body: str,
    org_id: uuid.UUID | None = None,
    cc: list[str] | None = None,
    attachments: list[dict[str, Any]] | None = None,
) -> OutboundEmail:
    """Queue an email. `attachments`: [{"file_id": <FileObject id>, "name": "file.pdf"}] (files of `org_id`)."""
    cc_text = ", ".join(clean_subject(c) for c in (cc or []) if c and "@" in c)[:1000]
    atts = [
        {"file_id": str(a["file_id"]), "name": clean_subject(str(a.get("name") or "attachment"))}
        for a in attachments or []
    ]
    m = OutboundEmail(to=to, subject=clean_subject(subject), body=body, org_id=org_id, cc=cc_text, attachments=atts)
    db.session.add(m)
    db.session.flush()
    enqueue("send_email", {"id": str(m.id)}, org_id=org_id)
    return m


@job("send_email")
def _send(payload: dict[str, Any]) -> None:
    m = db.session.get(OutboundEmail, uuid.UUID(payload["id"]))
    if not m:
        return
    cfg = current_app.config
    if not cfg.get("MAIL_SERVER"):
        m.status = "not_configured"
        db.session.commit()
        return
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = cfg["MAIL_FROM"], m.to, clean_subject(m.subject)
    if m.cc:
        msg["Cc"] = m.cc
    msg.set_content(m.body)
    for a in m.attachments or []:
        data, ctype = _attachment(m.org_id, a)
        if data is None:
            continue
        maintype, _, subtype = ctype.partition("/")
        msg.add_attachment(
            data, maintype=maintype or "application", subtype=subtype or "octet-stream", filename=a.get("name")
        )
    with smtplib.SMTP(cfg["MAIL_SERVER"], cfg["MAIL_PORT"], timeout=20) as s:
        if cfg.get("MAIL_USE_TLS"):
            s.starttls()
        if cfg.get("MAIL_USERNAME"):
            s.login(cfg["MAIL_USERNAME"], cfg["MAIL_PASSWORD"])
        s.send_message(msg)
    m.status, m.sent_at = "sent", utcnow()
    db.session.commit()


def _attachment(org_id: uuid.UUID | None, a: dict[str, Any]) -> tuple[bytes | None, str]:
    """Read an attachment's bytes from file storage (decrypting encrypted files). Missing files are skipped."""
    from mpro.core.files import FileObject, storage

    try:
        f = db.session.get(FileObject, uuid.UUID(str(a.get("file_id"))))
    except ValueError:
        return None, ""
    if f is None or f.org_id != org_id or f.deleted_at is not None:
        return None, ""
    try:
        data = storage().get(f.storage_key)
    except Exception:  # noqa: BLE001
        return None, ""
    if getattr(f, "encrypted", False):
        from mpro.core.crypto import decrypt_bytes

        data = decrypt_bytes(data)
    return data, f.content_type or "application/octet-stream"
