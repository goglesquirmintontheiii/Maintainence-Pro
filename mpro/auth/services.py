from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from flask import current_app
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy import func, select

from mpro.auth.models import LoginAttempt, User
from mpro.core.events import emit
from mpro.core.mail import send_email
from mpro.core.models import utcnow
from mpro.extensions import db

MIN_PASSWORD = 8
TOKEN_AGE = {"reset": 3600, "invite": 7 * 24 * 3600}


class AuthError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message, self.status = message, status


def normalize_email(email: str) -> str:
    return email.strip().lower()


def validate_password(pw: str) -> None:
    if len(pw) < MIN_PASSWORD:
        raise AuthError(f"Use at least {MIN_PASSWORD} characters for the password.", 422)
    if pw.strip() != pw or not pw.strip():
        raise AuthError("The password can't start or end with spaces.", 422)


def get_user_by_email(email: str) -> User | None:
    return db.session.scalars(
        select(User).where(User.email == normalize_email(email), User.deleted_at.is_(None))
    ).first()


def _recent_failures(email: str, ip: str) -> int:
    since = utcnow() - timedelta(minutes=current_app.config["LOGIN_WINDOW_MINUTES"])
    q = select(func.count(LoginAttempt.id)).where(
        LoginAttempt.at >= since,
        LoginAttempt.success.is_(False),
        (LoginAttempt.email == email) | (LoginAttempt.ip == ip),
    )
    return int(db.session.scalar(q) or 0)


def authenticate(email: str, password: str, ip: str) -> User:
    email = normalize_email(email)
    if _recent_failures(email, ip) >= current_app.config["LOGIN_MAX_FAILURES"]:
        raise AuthError("Too many sign-in attempts. Wait 15 minutes and try again, or reset your password.", 429)
    user = get_user_by_email(email)
    ok = bool(user and user.is_active and user.check_password(password))
    db.session.add(LoginAttempt(email=email, ip=ip, success=ok, at=utcnow()))
    if not ok or user is None:
        db.session.commit()
        raise AuthError("That email and password don't match. Check them and try again.", 401)
    user.last_login_at = utcnow()
    emit(
        "user.signed_in",
        entity_type="user",
        entity_id=user.id,
        entity_label=user.name,
        summary="Signed in",
        actor=user,
        org_id=None,
    )
    db.session.commit()
    return user


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(current_app.config["SECRET_KEY"], salt="mpro-password")


def make_token(user: User, purpose: str = "reset") -> str:
    # Tying the token to the current hash makes it single-use: it dies once the password changes.
    return _serializer().dumps({"u": str(user.id), "h": user.password_hash[-16:], "p": purpose})


def read_token(token: str) -> tuple[User, str]:
    try:
        data: dict[str, Any] = _serializer().loads(token, max_age=TOKEN_AGE["invite"])
    except SignatureExpired as e:
        raise AuthError("This link has expired. Ask for a new one.", 410) from e
    except BadSignature as e:
        raise AuthError("This link isn't valid. Ask for a new one.", 400) from e
    purpose = data.get("p", "reset")
    user = db.session.get(User, uuid.UUID(data["u"]))
    if not user or not user.is_active or user.password_hash[-16:] != data.get("h"):
        raise AuthError("This link has already been used or is no longer valid. Ask for a new one.", 410)
    try:
        _serializer().loads(token, max_age=TOKEN_AGE.get(purpose, 3600))
    except SignatureExpired as e:
        raise AuthError("This link has expired. Ask for a new one.", 410) from e
    return user, purpose


def link(path: str) -> str:
    return current_app.config["MPRO_BASE_URL"].rstrip("/") + path


def request_password_reset(email: str) -> None:
    user = get_user_by_email(email)
    if user and user.is_active:
        url = link("/reset-password/" + make_token(user, "reset"))
        send_email(
            user.email,
            "Reset your Maintenance Pro password",
            f"Hi {user.name},\n\nSomeone (hopefully you) asked to reset your Maintenance Pro password.\n\n"
            f"Set a new password here (the link works for 1 hour):\n{url}\n\n"
            "If you didn't ask for this, you can ignore this email.\n",
        )
        emit(
            "user.password_reset_requested",
            entity_type="user",
            entity_id=user.id,
            entity_label=user.name,
            summary="Asked for a password reset",
            actor=user,
            org_id=None,
        )
    db.session.commit()


def reset_password(token: str, new_password: str) -> User:
    user, purpose = read_token(token)
    validate_password(new_password)
    user.set_password(new_password)
    emit(
        "user.password_set" if purpose == "invite" else "user.password_reset",
        entity_type="user",
        entity_id=user.id,
        entity_label=user.name,
        summary="Accepted invitation and set a password" if purpose == "invite" else "Reset their password",
        actor=user,
        org_id=None,
    )
    db.session.commit()
    return user


def change_password(user: User, current: str, new: str) -> None:
    if not user.check_password(current):
        raise AuthError("Your current password isn't right.", 422)
    validate_password(new)
    user.set_password(new)
    emit(
        "user.password_changed",
        entity_type="user",
        entity_id=user.id,
        entity_label=user.name,
        summary="Changed their password",
        actor=user,
        org_id=None,
    )
    db.session.commit()
