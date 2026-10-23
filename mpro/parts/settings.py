"""Parts & inventory settings (Settings → Parts and inventory). Shared by parts, purchasing and suppliers."""

from __future__ import annotations

from mpro.core.settings import register_defaults

DEFAULTS = {
    "moving_average_cost": False,  # recalculate unit cost on restock / receipt (r238)
    "restock_trigger": "in_stock",  # needs restock when "in_stock" or "available" is below minimum (r241)
    "prevent_negative_ordered": True,  # floor ordered quantity at 0 (r243)
    "allow_negative_stock": False,  # allow using more than is on hand (shows red negative, r216)
    "required_fields": [],  # e.g. ["description", "unit_cost", "area", "min_qty", "barcode", "part_types"] (r221)
    "escalation_team_ids": [],  # emailed when a Critical part runs low (r216, r240)
    "auto_reserve_days": 0,  # reserve parts on work orders due within N days; 0 = off (r219)
    "assigned_window_days": 30,  # parts on work orders due within N days count as Assigned (r219)
}

register_defaults("parts", DEFAULTS)
