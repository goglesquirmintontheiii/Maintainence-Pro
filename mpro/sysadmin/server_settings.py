"""Server-wide settings kept in `server.json` in the data folder (MP-134, MP-136).

One file holds what the server needs before it can reach its database: the address and port it listens on, its
public address, email (SMTP) and a few limits. `mpro serve`, the test-build launcher and MPro Management's Server
Settings all read and write this same file. The SMTP password is stored encrypted with the instance key (G-16).

Which value wins, highest first: a command-line flag (`--host`, `--port`), an environment variable, this file,
then the built-in default. A setting that comes from the environment shows as locked in MPro Management.
"""

from __future__ import annotations

import contextlib
import ipaddress
import json
import os
import re
import tempfile
from datetime import timedelta
from pathlib import Path
from typing import Any

FILE_NAME = "server.json"

# key -> (type, environment variable, config key or None, applies: "now" | "restart", label)
FIELDS: dict[str, tuple[type, str, str | None, str, str]] = {
    "host": (str, "MPRO_HOST", None, "restart", "Address to listen on"),
    "port": (int, "MPRO_PORT", None, "restart", "Port"),
    "base_url": (str, "MPRO_BASE_URL", "MPRO_BASE_URL", "now", "Public address (base URL)"),
    "smtp_host": (str, "MPRO_SMTP_HOST", "MAIL_SERVER", "now", "SMTP server"),
    "smtp_port": (int, "MPRO_SMTP_PORT", "MAIL_PORT", "now", "SMTP port"),
    "smtp_user": (str, "MPRO_SMTP_USER", "MAIL_USERNAME", "now", "SMTP user name"),
    "smtp_password": (str, "MPRO_SMTP_PASSWORD", "MAIL_PASSWORD", "now", "SMTP password"),
    "smtp_tls": (bool, "MPRO_SMTP_TLS", "MAIL_USE_TLS", "now", "Use STARTTLS"),
    "mail_from": (str, "MPRO_MAIL_FROM", "MAIL_FROM", "now", "Send email as"),
    "max_upload_mb": (int, "MPRO_MAX_UPLOAD_MB", "MPRO_MAX_UPLOAD_MB", "now", "Largest upload (MB)"),
    "session_hours": (int, "MPRO_SESSION_HOURS", None, "restart", "Sign-in lasts (hours)"),
    "trusted_proxies": (int, "MPRO_TRUSTED_PROXIES", "MPRO_TRUSTED_PROXIES", "restart", "Reverse proxies in front"),
}
SECRET_FIELDS = {"smtp_password"}


class SettingsError(ValueError):
    pass


def path_for(data_dir: str | Path) -> Path:
    return Path(data_dir) / FILE_NAME


def load(data_dir: str | Path) -> dict[str, Any]:
    """The saved values (secrets still encrypted). A missing or damaged file is treated as empty."""
    try:
        raw = json.loads(path_for(data_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in raw.items() if k in FIELDS} if isinstance(raw, dict) else {}


def save(data_dir: str | Path, values: dict[str, Any]) -> dict[str, Any]:
    """Merge `values` (already validated; None removes a key) into the file, atomically. Returns the new file."""
    current = load(data_dir)
    for k, v in values.items():
        if k not in FIELDS:
            continue
        if v is None:
            current.pop(k, None)
        else:
            current[k] = v
    p = path_for(data_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".server-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(current, f, indent=2, sort_keys=True)
        with contextlib.suppress(OSError):  # Windows ignores POSIX modes
            os.chmod(tmp, 0o600)
        os.replace(tmp, p)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
    return current


def env_overrides() -> dict[str, str]:
    """Settings fixed by environment variables: key -> variable name."""
    return {k: env for k, (_t, env, _c, _a, _l) in FIELDS.items() if os.environ.get(env) not in (None, "")}


# ---- validation ------------------------------------------------------------------------------
_HOSTNAME = re.compile(
    r"^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$"
)


def check_host(value: Any) -> str:
    host = str(value or "").strip()
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    if _HOSTNAME.match(host):
        return host.lower()
    raise SettingsError("Enter an IP address such as 127.0.0.1 or 0.0.0.0, or a host name.")


def check_port(value: Any) -> int:
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        raise SettingsError("The port must be a number from 1 to 65535.") from None
    if not 1 <= port <= 65535:
        raise SettingsError("The port must be a number from 1 to 65535.")
    return port


def is_everywhere(host: str) -> bool:
    return host in {"0.0.0.0", "::"}


EVERYWHERE_WARNING = (
    "0.0.0.0 means MPro listens on every network this computer is connected to, so other computers and phones on "
    "the same network (and the internet, if this computer is reachable from it) can open it. Use 127.0.0.1 to keep "
    "it to this computer only."
)


def validate(updates: dict[str, Any]) -> dict[str, Any]:
    """Check values coming from MPro Management; returns clean values (secrets in plain text, None = clear)."""
    out: dict[str, Any] = {}
    for k, v in updates.items():
        if k not in FIELDS:
            raise SettingsError(f"Unknown setting: {k}.")
        typ = FIELDS[k][0]
        if v is None or (typ is not bool and str(v).strip() == ""):
            out[k] = None
            continue
        if k == "host":
            out[k] = check_host(v)
        elif k in {"port", "smtp_port"}:
            out[k] = check_port(v)
        elif k == "base_url":
            url = str(v).strip().rstrip("/")
            if not re.match(r"^https?://[^\s/]+(/[^\s]*)?$", url):
                raise SettingsError("The public address must start with http:// or https://.")
            out[k] = url
        elif typ is bool:
            out[k] = bool(v)
        elif typ is int:
            try:
                n = int(v)
            except (TypeError, ValueError):
                raise SettingsError(f"{FIELDS[k][4]} must be a whole number.") from None
            limits = {"max_upload_mb": (1, 10_000), "session_hours": (1, 24 * 90), "trusted_proxies": (0, 5)}
            lo, hi = limits.get(k, (0, 1_000_000))
            if not lo <= n <= hi:
                raise SettingsError(f"{FIELDS[k][4]} must be between {lo} and {hi}.")
            out[k] = n
        else:
            text = str(v).strip()
            if len(text) > 500 or any(c in text for c in "\r\n"):
                raise SettingsError(f"{FIELDS[k][4]} is too long or has line breaks.")
            out[k] = text
    return out


# ---- startup --------------------------------------------------------------------------------
def _plain(key: str, value: Any, secret_key: str) -> Any:
    if key in SECRET_FIELDS and isinstance(value, str) and value:
        from mpro.core.crypto import DecryptError, decrypt_str_with

        try:
            return decrypt_str_with(secret_key, value)
        except DecryptError:
            return ""
    return value


def apply_to_config(cfg: dict[str, Any], data_dir: str | Path) -> None:
    """load_config(): fill in values saved in server.json unless an environment variable sets them."""
    saved = load(data_dir)
    if not saved:
        return
    fixed = env_overrides()
    for key, value in saved.items():
        if key in fixed:
            continue
        conf_key = FIELDS[key][2]
        plain = _plain(key, value, str(cfg.get("SECRET_KEY", "")))
        if key == "session_hours":
            cfg["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=int(plain))
        elif conf_key:
            cfg[conf_key] = plain
            if key == "max_upload_mb":
                cfg["MAX_CONTENT_LENGTH"] = (int(plain) + 2) * 1024 * 1024
    cfg["MPRO_SERVER_SETTINGS"] = {k: v for k, v in saved.items() if k not in SECRET_FIELDS}


def listen_address(
    data_dir: str | Path, host: str | None, port: int | None, default_host: str, default_port: int = 8080
) -> tuple[str, int]:
    """Where `mpro serve` / the test build listens: flag > environment > server.json > default."""
    saved = load(data_dir)
    h = host or os.environ.get("MPRO_HOST") or saved.get("host") or default_host
    p = port or os.environ.get("MPRO_PORT") or saved.get("port") or default_port
    return check_host(h), check_port(p)
