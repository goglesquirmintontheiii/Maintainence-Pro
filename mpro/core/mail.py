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
from sqlalchemy import String, Text, Uuid
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
            "status": self.status,
            "error": self.error,
            "created_at": iso(self.created_at),
            "sent_at": iso(self.sent_at),
        }


def send_email(to: str, subject: str, body: str, org_id: uuid.UUID | None = None) -> OutboundEmail:
    m = OutboundEmail(to=to, subject=subject, body=body, org_id=org_id)
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
    msg["From"], msg["To"], msg["Subject"] = cfg["MAIL_FROM"], m.to, m.subject
    msg.set_content(m.body)
    with smtplib.SMTP(cfg["MAIL_SERVER"], cfg["MAIL_PORT"], timeout=20) as s:
        if cfg.get("MAIL_USE_TLS"):
            s.starttls()
        if cfg.get("MAIL_USERNAME"):
            s.login(cfg["MAIL_USERNAME"], cfg["MAIL_PASSWORD"])
        s.send_message(msg)
    m.status, m.sent_at = "sent", utcnow()
    db.session.commit()
