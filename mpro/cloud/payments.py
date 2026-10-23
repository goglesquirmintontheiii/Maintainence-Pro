"""Online payment links for customer invoices (MP-093), MPro Cloud only.

This is the interface only: no live calls are made. A provider is plugged in by registering a function in
`PROVIDERS` (the Stripe one needs a Stripe account and arrives with MPro Cloud). Without a provider, or when the
organization's plan doesn't include `payment_links`, `payment_link()` returns None and invoices go out without a link.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from flask import current_app

from mpro.core.entitlements import entitlements_for

FEATURE = "payment_links"

# name -> fn(org, invoice) -> url. Registered by the MPro Cloud deployment (Stripe Checkout / Payment Links).
PROVIDERS: dict[str, Callable[[Any, Any], str | None]] = {}


def status(org: Any) -> dict[str, Any]:
    """What the UI shows in Finance settings."""
    provider = str(current_app.config.get("PAYMENT_PROVIDER") or "stripe")
    if not entitlements_for(org).can_use(FEATURE) or current_app.config.get("MPRO_EDITION") != "cloud":
        return {"available": False, "provider": provider, "reason": "Online payment links are an MPro Cloud feature."}
    if provider not in PROVIDERS:
        return {
            "available": False,
            "provider": provider,
            "reason": "Needs a Stripe account (connect it in MPro Cloud).",
        }
    return {"available": True, "provider": provider, "reason": ""}


def payment_link(org: Any, invoice: Any) -> str | None:
    """A pay-online URL for the invoice, or None when the feature isn't available."""
    st = status(org)
    if not st["available"]:
        return None
    return PROVIDERS[st["provider"]](org, invoice)
