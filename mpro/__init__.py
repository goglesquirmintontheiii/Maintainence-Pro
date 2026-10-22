"""Maintenance Pro (MPro): self-hosted CMMS, drop-in replacement for MaintainX."""

from __future__ import annotations

__version__ = "0.4.0"

from mpro.app import create_app  # noqa: E402

__all__ = ["__version__", "create_app"]
