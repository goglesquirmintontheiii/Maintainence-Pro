"""Configuration. Everything comes from environment variables (optionally a .env file).

Edition rules (see guideline G-02): the self-hosted edition runs on one machine with
PostgreSQL (or SQLite for test builds) only. MPro Cloud enables the scalable services.
"""

from __future__ import annotations

import contextlib
import os
import secrets
from datetime import timedelta
from pathlib import Path
from typing import Any

from platformdirs import user_data_dir


def default_data_dir() -> Path:
    d = os.environ.get("MPRO_DATA_DIR")
    path = Path(d) if d else Path(user_data_dir("MaintenancePro", "MPro"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def _secret_key(data_dir: Path) -> str:
    key = os.environ.get("MPRO_SECRET_KEY")
    if key:
        return key
    f = data_dir / "secret_key"
    if f.exists():
        return f.read_text().strip()
    key = secrets.token_urlsafe(48)
    f.write_text(key)
    with contextlib.suppress(OSError):  # Windows ignores POSIX modes
        f.chmod(0o600)
    return key


def _bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    return default if v is None else v.strip().lower() in {"1", "true", "yes", "on"}


def load_config(overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    data_dir = default_data_dir()
    db_url = os.environ.get("DATABASE_URL") or f"sqlite:///{(data_dir / 'mpro.db').as_posix()}"
    if db_url.startswith("postgres://"):
        db_url = "postgresql+psycopg://" + db_url[len("postgres://") :]
    elif db_url.startswith("postgresql://"):
        db_url = "postgresql+psycopg://" + db_url[len("postgresql://") :]
    cfg: dict[str, Any] = {
        "SECRET_KEY": _secret_key(data_dir),
        "MPRO_DATA_DIR": str(data_dir),
        "MPRO_EDITION": os.environ.get("MPRO_EDITION", "selfhosted"),  # selfhosted | cloud
        "MPRO_REGION": os.environ.get("MPRO_REGION", "local"),
        "MPRO_NODE_ID": os.environ.get("MPRO_NODE_ID", "node-1"),
        "MPRO_BASE_URL": os.environ.get("MPRO_BASE_URL", "http://localhost:8080"),
        "MPRO_INLINE_JOBS": _bool("MPRO_INLINE_JOBS"),
        "MPRO_TEST_BUILD": _bool("MPRO_TEST_BUILD"),
        "SQLALCHEMY_DATABASE_URI": db_url,
        "SQLALCHEMY_ENGINE_OPTIONS": {"pool_pre_ping": True},
        "SESSION_COOKIE_HTTPONLY": True,
        "SESSION_COOKIE_SAMESITE": "Lax",
        "SESSION_COOKIE_SECURE": _bool("MPRO_SECURE_COOKIES"),
        "REMEMBER_COOKIE_SAMESITE": "Lax",
        "REMEMBER_COOKIE_DURATION": timedelta(days=int(os.environ.get("MPRO_REMEMBER_DAYS", "30"))),
        "PERMANENT_SESSION_LIFETIME": timedelta(hours=int(os.environ.get("MPRO_SESSION_HOURS", "12"))),
        "MAIL_SERVER": os.environ.get("MPRO_SMTP_HOST", ""),
        "MAIL_PORT": int(os.environ.get("MPRO_SMTP_PORT", "587")),
        "MAIL_USERNAME": os.environ.get("MPRO_SMTP_USER", ""),
        "MAIL_PASSWORD": os.environ.get("MPRO_SMTP_PASSWORD", ""),
        "MAIL_USE_TLS": _bool("MPRO_SMTP_TLS", True),
        "MAIL_FROM": os.environ.get("MPRO_MAIL_FROM", "Maintenance Pro <no-reply@localhost>"),
        "LOGIN_MAX_FAILURES": int(os.environ.get("MPRO_LOGIN_MAX_FAILURES", "10")),
        # how many reverse proxies in front of MPro may set X-Forwarded-For/-Proto/-Host (0 = none: the client
        # address is the TCP peer, and forwarded headers are ignored so they can't dodge rate limits)
        "MPRO_TRUSTED_PROXIES": int(os.environ.get("MPRO_TRUSTED_PROXIES", "0")),
        "LOGIN_WINDOW_MINUTES": 15,
        "MPRO_MAX_UPLOAD_MB": int(os.environ.get("MPRO_MAX_UPLOAD_MB", "150")),
        "MAX_CONTENT_LENGTH": (int(os.environ.get("MPRO_MAX_UPLOAD_MB", "150")) + 2) * 1024 * 1024,
        # APIFlask / OpenAPI
        "TITLE": "Maintenance Pro API",
        "VALIDATION_ERROR_STATUS_CODE": 422,
        "JSON_SORT_KEYS": False,
    }
    if overrides:
        cfg.update(overrides)
    return cfg
