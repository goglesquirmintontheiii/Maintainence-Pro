"""Shared helpers for per-address rate limits on public pages (0.6.0 review)."""

from __future__ import annotations

import ipaddress


def ip_key(ip: str | None) -> str:
    """The bucket a client address counts against. IPv6 hosts get a whole /64 each (one address is free to change
    within it), so limits group by /64; IPv4-mapped addresses count as their IPv4 address."""
    raw = (ip or "").strip()
    if not raw:
        return "?"
    try:
        a = ipaddress.ip_address(raw.split("%", 1)[0])
    except ValueError:
        return raw[:64]
    if isinstance(a, ipaddress.IPv6Address):
        if a.ipv4_mapped is not None:
            return str(a.ipv4_mapped)
        return str(ipaddress.IPv6Network(f"{a}/64", strict=False))
    return str(a)
