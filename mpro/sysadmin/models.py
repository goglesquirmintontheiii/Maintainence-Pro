"""Sysadmins and MPro Management: database models.

API keys are server-wide (not organization data), so this table has no org_id: only sysadmins manage it and the
server's own services read it. Secrets are stored encrypted (G-16) and never sent back in full.
"""

from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from mpro.core.models import IdMixin, SoftDeleteMixin, TimestampMixin
from mpro.extensions import db

SERVICES: dict[str, str] = {
    "openai": "OpenAI",
    "anthropic": "Anthropic (Claude)",
    "google": "Google Gemini",
    "azure_openai": "Azure OpenAI",
    "ollama": "Ollama / local model",
    "other": "Other service",
}


class ApiKey(IdMixin, TimestampMixin, SoftDeleteMixin, db.Model):  # type: ignore[name-defined]
    """A key for an AI provider or another outside service used by this MPro server (MP-136)."""

    __tablename__ = "server_api_keys"

    name: Mapped[str] = mapped_column(String(120))
    service: Mapped[str] = mapped_column(String(40), default="other")
    secret: Mapped[str] = mapped_column(Text)  # "enc1:…" (mpro.core.crypto)
    last4: Mapped[str] = mapped_column(String(8), default="")
    note: Mapped[str] = mapped_column(String(500), default="")
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"), nullable=True)
