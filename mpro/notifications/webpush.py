"""Web Push (MP-051): VAPID (RFC 8292) and message encryption (RFC 8291, aes128gcm), built on `cryptography`.

No extra dependency: pywebpush pulls in aiohttp and py-vapid for what is a few dozen lines here. Push endpoints come
from browsers, so only well-known push services are contacted (no requests to arbitrary or internal addresses).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import struct
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Browser push services (Chrome/Edge/Opera via FCM, Firefox, Safari, Windows). Anything else is refused.
PUSH_HOSTS = (
    "fcm.googleapis.com",
    "android.googleapis.com",
    "updates.push.services.mozilla.com",
    "push.services.mozilla.com",
    "web.push.apple.com",
    ".push.apple.com",
    ".notify.windows.com",
)


class PushError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64u(text: str) -> bytes:
    text = text.strip()
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


# ------------------------------------------------------------------------------------------- keys
def generate_keys() -> tuple[str, str]:
    """A new VAPID key pair: (public key base64url, private key PEM)."""
    key = ec.generate_private_key(ec.SECP256R1())
    pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    return b64u(pub), pem


def _load_private(pem: str) -> ec.EllipticCurvePrivateKey:
    key = serialization.load_pem_private_key(pem.encode(), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey):
        raise ValueError("VAPID key must be an EC key")
    return key


# ------------------------------------------------------------------------------------------- endpoint check
def allowed_endpoint(endpoint: str, extra_hosts: tuple[str, ...] = ()) -> bool:
    try:
        parts = urlsplit(endpoint)
    except ValueError:
        return False
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        return False
    if parts.port not in (None, 443):
        return False
    host = parts.hostname.lower()
    for h in PUSH_HOSTS + tuple(x.lower() for x in extra_hosts if x):
        if h.startswith(".") and host.endswith(h):
            return True
        if host == h:
            return True
    return False


# ------------------------------------------------------------------------------------------- VAPID
def vapid_header(endpoint: str, private_pem: str, public_b64: str, subject: str, ttl: int = 12 * 3600) -> str:
    parts = urlsplit(endpoint)
    claims = {"aud": f"{parts.scheme}://{parts.netloc}", "exp": int(time.time()) + ttl, "sub": subject}
    header = {"typ": "JWT", "alg": "ES256"}
    signing_input = (
        b64u(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + b64u(json.dumps(claims, separators=(",", ":")).encode())
    )
    der = _load_private(private_pem).sign(signing_input.encode(), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return f"vapid t={signing_input}.{b64u(sig)}, k={public_b64}"


# ------------------------------------------------------------------------------------------- RFC 8291
def _hkdf_extract(salt: bytes, ikm: bytes) -> bytes:
    return hmac.new(salt, ikm, hashlib.sha256).digest()


def _hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:length]  # one block is enough (<= 32 bytes)


def encrypt(payload: bytes, p256dh: str, auth: str, *, salt: bytes | None = None, server_key: Any = None) -> bytes:
    """Encrypt one push message for a subscription (aes128gcm content coding, single record)."""
    ua_public = unb64u(p256dh)
    auth_secret = unb64u(auth)
    if len(ua_public) != 65 or len(auth_secret) != 16:
        raise ValueError("Invalid subscription keys")
    if len(payload) > 3800:
        raise ValueError("Push payload too large")
    as_key = server_key or ec.generate_private_key(ec.SECP256R1())
    as_public = as_key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    ecdh_secret = as_key.exchange(ec.ECDH(), ua_key)
    prk_key = _hkdf_extract(auth_secret, ecdh_secret)
    ikm = _hkdf_expand(prk_key, b"WebPush: info\x00" + ua_public + as_public, 32)
    salt = salt or os.urandom(16)
    prk = _hkdf_extract(salt, ikm)
    cek = _hkdf_expand(prk, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf_expand(prk, b"Content-Encoding: nonce\x00", 12)
    ciphertext = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    header = salt + struct.pack("!I", 4096) + bytes([len(as_public)]) + as_public
    return header + ciphertext


def decrypt(body: bytes, ua_private: ec.EllipticCurvePrivateKey, auth: str) -> bytes:
    """The browser's side of `encrypt` (used by the tests)."""
    salt, idlen = body[:16], body[20]
    as_public = body[21 : 21 + idlen]
    ciphertext = body[21 + idlen :]
    ua_public = ua_private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    as_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public)
    ecdh_secret = ua_private.exchange(ec.ECDH(), as_key)
    prk_key = _hkdf_extract(unb64u(auth), ecdh_secret)
    ikm = _hkdf_expand(prk_key, b"WebPush: info\x00" + ua_public + as_public, 32)
    prk = _hkdf_extract(salt, ikm)
    cek = _hkdf_expand(prk, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf_expand(prk, b"Content-Encoding: nonce\x00", 12)
    plain = AESGCM(cek).decrypt(nonce, ciphertext, None)
    return plain.rstrip(b"\x00")[:-1]  # drop padding and the 0x02 delimiter


# ------------------------------------------------------------------------------------------- sending
@dataclass
class PushRequest:
    url: str
    headers: dict[str, str]
    body: bytes


def build_request(
    endpoint: str,
    p256dh: str,
    auth: str,
    message: dict[str, Any],
    *,
    private_pem: str,
    public_b64: str,
    subject: str,
    ttl: int = 24 * 3600,
    urgency: str = "normal",
) -> PushRequest:
    body = encrypt(json.dumps(message, separators=(",", ":")).encode(), p256dh, auth)
    return PushRequest(
        endpoint,
        {
            "Content-Type": "application/octet-stream",
            "Content-Encoding": "aes128gcm",
            "TTL": str(ttl),
            "Urgency": urgency,
            "Authorization": vapid_header(endpoint, private_pem, public_b64, subject),
        },
        body,
    )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # never follow a push service elsewhere
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def post(req: PushRequest, timeout: float = 10.0) -> int:
    """Send it. Returns the HTTP status (201 = accepted). Raises PushError on network errors."""
    r = urllib.request.Request(req.url, data=req.body, headers=req.headers, method="POST")
    try:
        with _opener.open(r, timeout=timeout) as resp:  # endpoint is allow-listed
            return int(resp.status)
    except urllib.error.HTTPError as e:
        return int(e.code)
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise PushError(0, str(e)) from e
