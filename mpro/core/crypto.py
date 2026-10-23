"""Encryption at rest for stored secrets and sensitive files (guideline G-16).

Supplier API keys, PunchOut shared secrets, tax certificate scans and similar are encrypted with a key derived from the
instance's SECRET_KEY (MPRO_SECRET_KEY, or the generated `secret_key` file in the data directory). Losing that key means
losing these values, so back it up with the database.

    token = encrypt_str("s3cr3t")          # -> "enc1:…"
    decrypt_str(token)                     # -> "s3cr3t"
    blob = encrypt_bytes(data)             # file contents
    decrypt_bytes(blob)
    encrypt_json({...}) / decrypt_json(...) for credential dicts
"""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from flask import current_app

PREFIX = "enc1:"
_cache: dict[str, Fernet] = {}


class DecryptError(ValueError):
    """The value can't be decrypted (wrong instance key or damaged data)."""


def _fernet() -> Fernet:
    secret = str(current_app.config["SECRET_KEY"])
    f = _cache.get(secret)
    if f is None:
        key = hashlib.sha256(b"mpro-at-rest-v1:" + secret.encode()).digest()
        f = Fernet(base64.urlsafe_b64encode(key))
        _cache[secret] = f
    return f


def encrypt_bytes(data: bytes) -> bytes:
    return _fernet().encrypt(data)


def decrypt_bytes(token: bytes) -> bytes:
    try:
        return _fernet().decrypt(token)
    except InvalidToken as e:
        raise DecryptError("Can't decrypt this value. Was the instance's secret key changed?") from e


def encrypt_str(value: str) -> str:
    return PREFIX + encrypt_bytes(value.encode()).decode()


def decrypt_str(token: str) -> str:
    if not token.startswith(PREFIX):
        raise DecryptError("Not an encrypted value.")
    return decrypt_bytes(token[len(PREFIX) :].encode()).decode()


def is_encrypted(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)


def encrypt_json(value: Any) -> str:
    return encrypt_str(json.dumps(value, separators=(",", ":")))


def decrypt_json(token: str | None) -> Any:
    if not token:
        return None
    return json.loads(decrypt_str(token))


def mask(value: str | None, keep: int = 4) -> str:
    """For showing a stored secret: '••••••3f9a'."""
    if not value:
        return ""
    return "•" * 6 + value[-keep:] if len(value) > keep else "•" * len(value)
