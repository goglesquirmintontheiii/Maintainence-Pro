"""Finance settings (Finance → Settings). Stored per organization (mpro.core.settings)."""

from __future__ import annotations

import secrets
import uuid
from typing import Any

from mpro.core.crypto import encrypt_str, is_encrypted, mask
from mpro.core.settings import get_settings, register_defaults, save_settings
from mpro.orgs.services import RuleError

DEFAULTS: dict[str, Any] = {
    # 3-way match tolerances (MP-092)
    "price_tolerance_pct": "2",  # invoice unit price may be up to this % above the PO price
    "quantity_tolerance": "0",  # units the invoice may exceed what was received
    # retention (MP-094)
    "retention_years": 7,
    # customer invoices (MP-093)
    "invoice_prefix": "INV-",
    "invoice_due_days": 30,
    "invoice_footer": "",
    "labor_rate": "",  # default billing rate per hour when the customer has none ("" = use the person's cost rate)
    "parts_markup_pct": "0",
    "default_tax_rate_pct": "0",
    "tax_rates": {},  # {"US-CA": "7.25", "US-TX": "6.25"} by country-region of the customer's location
    "reminder_days_after_due": [7, 14, 30],
    # receipts (MP-091)
    "expense_categories": ["Parts", "Tools", "Supplies", "Travel", "Meals", "Other"],
    "duplicate_window_days": 7,
    # certificate reminders (MP-090)
    "certificate_reminder_days": [60, 30, 7],
    # email-in (receipts+tag@…, invoices+tag@…): one IMAP mailbox, routed by the plus tag
    "inbox_enabled": False,
    "inbox_host": "",
    "inbox_port": 993,
    "inbox_user": "",
    "inbox_password": "",  # encrypted at rest
    "inbox_folder": "INBOX",
    "inbox_address": "",  # shown to people, e.g. maintenance@acme.com → maintenance+receipts-<secret>@acme.com
    # the secret in the plus-tag (review 0.5.0 #10); made automatically, changed with "Regenerate", never typed in
    "inbox_secret": "",
}

INBOX_HELP = (
    "Mail is accepted only at the addresses below (they include a secret; regenerate it if it leaks) and only from "
    "members of this organization. Mail servers on a private network (192.168.x.x, 10.x.x.x, localhost) are refused "
    "unless the server is started with MPRO_ALLOW_PRIVATE_MAIL_HOSTS=1."
)

register_defaults("finance", DEFAULTS)

_SECRET = {"inbox_password"}
_NOT_EDITABLE = {"inbox_secret"}


def finance_settings(org_id: uuid.UUID) -> dict[str, Any]:
    return get_settings(org_id, "finance")


def public_settings(org_id: uuid.UUID) -> dict[str, Any]:
    out = dict(finance_settings(org_id))
    out["inbox_password"] = mask("x" * 8) if out.get("inbox_password") else ""
    out["inbox_password_set"] = bool(finance_settings(org_id).get("inbox_password"))
    secret = str(out.pop("inbox_secret", "") or "")
    addr = str(out.get("inbox_address") or "")
    if "@" in addr and secret:
        local, dom = addr.split("@", 1)
        out["receipts_address"] = f"{local}+receipts-{secret}@{dom}"
        out["invoices_address"] = f"{local}+invoices-{secret}@{dom}"
    out["inbox_help"] = INBOX_HELP
    return out


def regenerate_inbox_secret(org_id: uuid.UUID) -> dict[str, Any]:
    """A new secret for the email-in addresses; mail to the old addresses is skipped from now on."""
    save_settings(org_id, "finance", {"inbox_secret": secrets.token_hex(5)})
    return public_settings(org_id)


def update_settings(org_id: uuid.UUID, data: dict[str, Any]) -> dict[str, Any]:
    from mpro.finance.common import money

    clean: dict[str, Any] = {}
    for k, v in data.items():
        if k not in DEFAULTS or k in _NOT_EDITABLE:
            continue
        if k in ("price_tolerance_pct", "quantity_tolerance", "parts_markup_pct", "default_tax_rate_pct"):
            d = money(v, k.replace("_", " "))
            if k.endswith("_pct") and d is not None and d > 1000:
                raise RuleError("Percentages must be at most 1000.", 422)
            clean[k] = str(d)
        elif k == "labor_rate":
            clean[k] = "" if v in ("", None) else str(money(v, "labor rate"))
        elif k == "retention_years":
            if not isinstance(v, int) or not 1 <= v <= 50:
                raise RuleError("Keep documents for 1 to 50 years.", 422)
            clean[k] = v
        elif k in ("invoice_due_days", "duplicate_window_days", "inbox_port"):
            if not isinstance(v, int) or not 0 <= v <= 65535:
                raise RuleError(f"{k.replace('_', ' ').capitalize()} must be a whole number.", 422)
            clean[k] = v
        elif k in ("reminder_days_after_due", "certificate_reminder_days"):
            if not isinstance(v, list) or len(v) > 6 or any(not isinstance(x, int) or not 0 < x <= 365 for x in v):
                raise RuleError("Reminder days must be a short list of numbers between 1 and 365.", 422)
            clean[k] = sorted(set(v), reverse=k == "certificate_reminder_days")
        elif k == "tax_rates":
            if not isinstance(v, dict) or len(v) > 200:
                raise RuleError("Tax rates must be a list of regions and percentages.", 422)
            clean[k] = {str(r)[:12].upper(): str(money(p, "tax rate")) for r, p in v.items()}
        elif k == "expense_categories":
            if not isinstance(v, list) or len(v) > 50:
                raise RuleError("Up to 50 expense categories.", 422)
            clean[k] = [str(x).strip()[:80] for x in v if str(x).strip()]
        elif k == "inbox_enabled":
            clean[k] = bool(v)
        elif k == "inbox_host":
            from mpro.finance.inbox import HostError, check_host

            host = str(v or "").strip()[:255]
            try:
                check_host(host)
            except HostError as e:
                raise RuleError(f"{e} Set MPRO_ALLOW_PRIVATE_MAIL_HOSTS=1 to allow it.", 422) from e
            clean[k] = host
        elif k in _SECRET:
            if v and not is_encrypted(v) and not str(v).startswith("•"):
                clean[k] = encrypt_str(str(v))
            elif v == "":
                clean[k] = ""
        else:
            clean[k] = str(v or "")[:500]
    if not finance_settings(org_id).get("inbox_secret"):
        clean["inbox_secret"] = secrets.token_hex(5)
    save_settings(org_id, "finance", clean)
    return public_settings(org_id)
