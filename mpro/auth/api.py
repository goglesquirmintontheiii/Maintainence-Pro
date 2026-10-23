from __future__ import annotations

import secrets
import uuid
from typing import Any

from apiflask import APIBlueprint, Schema, abort
from apiflask.fields import Boolean, Dict, String
from apiflask.validators import Length
from flask import current_app, g, request, session
from flask_login import login_user, logout_user

from mpro import __version__
from mpro.auth import services as svc
from mpro.auth.services import AuthError
from mpro.core.entitlements import entitlements_for
from mpro.core.files import max_upload_bytes
from mpro.core.permissions import permissions_for
from mpro.extensions import db
from mpro.orgs.models import Membership
from mpro.orgs.roles import role_label
from mpro.orgs.services import avatar_url, org_dict

bp = APIBlueprint("auth", __name__, url_prefix="/api/v1/auth", tag="Auth")

CSRF_EXEMPT = {"auth.login", "auth.forgot", "auth.reset", "auth.check_token"}


class LoginIn(Schema):
    email = String(required=True, validate=Length(1, 320))
    password = String(required=True, validate=Length(1, 1000))
    remember = Boolean(load_default=False)


class EmailIn(Schema):
    email = String(required=True, validate=Length(1, 320))


class ResetIn(Schema):
    token = String(required=True)
    password = String(required=True, validate=Length(1, 1000))


class TokenIn(Schema):
    token = String(required=True)


class ChangeIn(Schema):
    current = String(required=True)
    new = String(required=True, validate=Length(1, 1000))


class SwitchIn(Schema):
    org_id = String(required=True)


def csrf_token() -> str:
    tok = session.get("csrf")
    if not tok:
        tok = session["csrf"] = secrets.token_urlsafe(32)
    return str(tok)


def client_ip() -> str:
    # never a raw X-Forwarded-For: behind trusted proxies (MPRO_TRUSTED_PROXIES) ProxyFix sets remote_addr
    return (request.remote_addr or "")[:64]


def _db_location(uri: str) -> str:
    """Where the data lives, for the test-build banner: the SQLite file path, or host/database without credentials."""
    if uri.startswith("sqlite:///"):
        return uri[len("sqlite:///") :]
    from sqlalchemy.engine import make_url

    try:
        u = make_url(uri)
        return f"{u.host or 'localhost'}{':' + str(u.port) if u.port else ''}/{u.database or ''}"
    except Exception:  # noqa: BLE001
        return ""


def session_payload() -> dict[str, Any]:
    cfg = current_app.config
    base = {
        "version": __version__,
        "edition": cfg["MPRO_EDITION"],
        "region": cfg["MPRO_REGION"],
        "test_build": bool(cfg.get("MPRO_TEST_BUILD")),
        "csrf": csrf_token(),
    }
    user = getattr(g, "user", None)
    if user is None:
        demo = cfg.get("MPRO_DEMO_LOGIN")
        return {**base, "authenticated": False, "demo_login": demo if cfg.get("MPRO_TEST_BUILD") else None}
    m: Membership | None = getattr(g, "membership", None)
    orgs = [
        {"id": str(x.org.id), "name": x.org.name, "role": x.role}
        for x in user.memberships
        if x.deleted_at is None and x.org.deleted_at is None
    ]
    if cfg.get("MPRO_TEST_BUILD"):
        base["db_path"] = _db_location(str(cfg.get("SQLALCHEMY_DATABASE_URI", "")))  # test-build banner (MP-122)
    return {
        **base,
        "authenticated": True,
        "user": {
            "id": str(user.id),
            "name": user.name,
            "email": user.email,
            "initials": user.initials,
            "theme": user.theme,
            "prefs": dict(user.ui_prefs or {}),
            "avatar_url": avatar_url(user),
        },
        "org": org_dict(g.org) if getattr(g, "org", None) else None,
        "role": m.role if m else None,
        "role_id": str(m.role_id) if m and m.role_id else None,
        "role_label": role_label(m),
        "permissions": permissions_for(m) if m else [],
        "entitlements": entitlements_for(getattr(g, "org", None)).to_dict(),
        "max_upload_mb": max_upload_bytes(getattr(g, "org", None)) // (1024 * 1024),
        "orgs": orgs,
    }


def fail(e: AuthError) -> Any:
    abort(e.status, message=e.message)


@bp.get("/session")
def get_session() -> dict[str, Any]:
    """Who is signed in, their organization, role, permissions and the CSRF token."""
    return session_payload()


@bp.post("/login")
@bp.input(LoginIn, arg_name="body")
def login(body: dict[str, Any]) -> dict[str, Any]:
    try:
        user = svc.authenticate(body["email"], body["password"], client_ip())
    except AuthError as e:
        fail(e)
    session.clear()
    session.permanent = not body["remember"]
    login_user(user, remember=body["remember"])
    session["csrf"] = secrets.token_urlsafe(32)
    first = next((m for m in user.memberships if m.deleted_at is None and m.org.deleted_at is None), None)
    session["org_id"] = str(first.org_id) if first else None
    g.user, g.membership, g.org = user, first, first.org if first else None
    return session_payload()


@bp.post("/logout")
def logout() -> dict[str, Any]:
    logout_user()
    session.clear()
    g.user = g.org = g.membership = None
    return session_payload()


@bp.post("/password/forgot")
@bp.input(EmailIn, arg_name="body")
def forgot(body: dict[str, Any]) -> tuple[dict[str, str], int]:
    """Always answers the same way, so it can't be used to discover accounts."""
    svc.request_password_reset(body["email"])
    return {"message": "If that email has an account, a reset link is on its way."}, 202


@bp.post("/password/check")
@bp.input(TokenIn, arg_name="body")
def check_token(body: dict[str, Any]) -> dict[str, Any]:
    try:
        user, purpose = svc.read_token(body["token"])
    except AuthError as e:
        fail(e)
    return {"valid": True, "purpose": purpose, "email": user.email, "name": user.name}


@bp.post("/password/reset")
@bp.input(ResetIn, arg_name="body")
def reset(body: dict[str, Any]) -> dict[str, Any]:
    try:
        user = svc.reset_password(body["token"], body["password"])
    except AuthError as e:
        fail(e)
    session.clear()
    login_user(user)
    session["csrf"] = secrets.token_urlsafe(32)
    first = next((m for m in user.memberships if m.deleted_at is None), None)
    session["org_id"] = str(first.org_id) if first else None
    g.user, g.membership, g.org = user, first, first.org if first else None
    return session_payload()


@bp.post("/password/change")
@bp.input(ChangeIn, arg_name="body")
def change(body: dict[str, Any]) -> dict[str, str]:
    if g.user is None:
        abort(401)
    try:
        svc.change_password(g.user, body["current"], body["new"])
    except AuthError as e:
        fail(e)
    return {"message": "Password changed."}


@bp.post("/switch-org")
@bp.input(SwitchIn, arg_name="body")
def switch_org(body: dict[str, Any]) -> dict[str, Any]:
    if g.user is None:
        abort(401)
    try:
        oid = uuid.UUID(body["org_id"])
    except ValueError:
        abort(404)
    m = next((x for x in g.user.memberships if x.org_id == oid and x.deleted_at is None), None)
    if m is None:
        abort(404, message="You're not a member of that organization.")
    session["org_id"] = str(oid)
    g.membership, g.org = m, m.org
    return session_payload()


class PrefsIn(Schema):
    theme = String()
    prefs = Dict()


# per-person UI choices: key → check (MP-125 upcoming window)
UI_PREFS: dict[str, Any] = {
    "upcoming_days": lambda v: isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 365,
}


@bp.patch("/preferences")
@bp.input(PrefsIn, arg_name="body")
def prefs(body: dict[str, Any]) -> dict[str, Any]:
    if g.user is None:
        abort(401)
    if "theme" in body:
        if body["theme"] not in {"system", "light", "dark"}:
            abort(422, message="Theme must be system, light or dark.")
        g.user.theme = body["theme"]
    if "prefs" in body:
        merged = dict(g.user.ui_prefs or {})
        for k, v in (body["prefs"] or {}).items():
            if k not in UI_PREFS:
                abort(422, message=f"Unknown preference: {k}.")
            if v is None:
                merged.pop(k, None)
            elif not UI_PREFS[k](v):
                abort(422, message="The upcoming window must be 1 to 365 days.")
            else:
                merged[k] = v
        g.user.ui_prefs = merged
    db.session.commit()
    return session_payload()


# ---- profile photo (MP-116) ------------------------------------------------------------------
AVATAR_MAX_BYTES = 10 * 1024 * 1024
AVATAR_SIZE = 256


@bp.post("/avatar")
def upload_avatar() -> dict[str, Any]:
    """Upload a profile photo (multipart `file`, an image up to 10 MB). It's re-encoded as a 256×256 WebP with
    no metadata; crop it in the browser first (the server centre-crops anything that isn't square)."""
    import io

    from PIL import Image, ImageOps, UnidentifiedImageError

    user = getattr(g, "user", None)
    if user is None:
        abort(401, message="Please sign in.")
    up = request.files.get("file")
    if up is None:
        abort(422, message="Choose a photo.")
    data = up.read(AVATAR_MAX_BYTES + 1)
    if len(data) > AVATAR_MAX_BYTES:
        abort(413, message="Profile photos can be up to 10 MB.")
    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.format not in ("JPEG", "PNG", "WEBP", "GIF"):
                abort(422, message="Use a JPG, PNG, WebP or GIF photo.")
            if im.width * im.height > 50_000_000:
                abort(422, message="That photo is too large.")
            square = ImageOps.fit(
                ImageOps.exif_transpose(im).convert("RGB"), (AVATAR_SIZE, AVATAR_SIZE), Image.Resampling.LANCZOS
            )
            out = io.BytesIO()
            square.save(out, "WEBP", quality=85, method=4)  # a fresh image: no EXIF or other metadata
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        abort(422, message="That doesn't look like a photo. Try a JPG or PNG.")
    from mpro.core.events import emit
    from mpro.core.models import utcnow

    user.avatar = out.getvalue()
    user.avatar_updated_at = utcnow()
    emit(
        "user.avatar_changed",
        entity_type="user",
        entity_id=user.id,
        entity_label=user.name,
        summary="Changed profile photo",
    )
    db.session.commit()
    return session_payload()


@bp.delete("/avatar")
def delete_avatar() -> dict[str, Any]:
    user = getattr(g, "user", None)
    if user is None:
        abort(401, message="Please sign in.")
    from mpro.core.events import emit

    user.avatar, user.avatar_updated_at = None, None
    emit(
        "user.avatar_removed",
        entity_type="user",
        entity_id=user.id,
        entity_label=user.name,
        summary="Removed profile photo",
    )
    db.session.commit()
    return session_payload()
