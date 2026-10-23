"""Extension points for purchase orders (each hook runs in its own savepoint via mpro.core.hooks.run_hooks).

EXEMPTION_LOOKUPS: fn(org_id, vendor_id, shipping_address_or_None, location_id) -> TaxCertificate | None
    (finance registers this; purchasing marks the PO tax-exempt and prints the certificate number)
PO_STATUS_HOOKS: fn(org_id, po, old_status, new_status)
PO_RECEIVED_HOOKS: fn(org_id, po, receipt, receipt_lines)
    (suppliers updates the linked product's last paid price, MP-088)
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

EXEMPTION_LOOKUPS: list[Callable[..., Any]] = []
PO_STATUS_HOOKS: list[Callable[..., Any]] = []
PO_RECEIVED_HOOKS: list[Callable[..., Any]] = []
