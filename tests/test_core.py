from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from mpro.core.entitlements import Entitlements
from mpro.core.ids import uuid7, uuid7_time_ms
from mpro.core.permissions import ACTIONS, ROLES, can_assign_role, role_can


def test_uuid7_is_version_7_and_time_ordered() -> None:
    ids = [uuid7() for _ in range(2000)]
    assert all(u.version == 7 and u.variant == uuid.RFC_4122 for u in ids)
    assert ids == sorted(ids, key=lambda u: u.int)
    assert len(set(ids)) == len(ids)
    now_ms = int(datetime.now(UTC).timestamp() * 1000)
    assert abs(uuid7_time_ms(ids[-1]) - now_ms) < 5000


def test_every_action_uses_known_roles() -> None:
    for roles in ACTIONS.values():
        assert roles <= set(ROLES)


@pytest.mark.parametrize(
    ("role", "action", "allowed"),
    [
        ("owner", "org.manage", True),
        ("admin", "org.manage", False),
        ("operator", "wo.create", False),
        ("operator", "wo.status", True),
        ("limited_admin", "org.manage", False),
        ("limited_admin", "users.manage", True),
        ("technician", "users.manage", False),
        ("requester", "users.view", False),
        ("viewer", "users.view", True),
        ("viewer", "teams.manage", False),
        ("admin", "audit.view", True),
        ("technician", "audit.view", False),
        (None, "org.view", False),
    ],
)
def test_role_matrix(role: str | None, action: str, allowed: bool) -> None:
    assert role_can(role, action) is allowed


def test_only_admins_create_admins() -> None:
    assert can_assign_role("admin", "admin")
    assert not can_assign_role("limited_admin", "admin")
    assert can_assign_role("limited_admin", "technician")
    assert not can_assign_role("technician", "requester")
    assert not can_assign_role("admin", "superuser")


def test_entitlements_unlimited_selfhosted(app) -> None:  # type: ignore[no-untyped-def]
    from mpro.core.entitlements import entitlements_for

    with app.app_context():
        e = entitlements_for(None)
        assert e.can_use("anything") and e.limit("full_users") is None


def test_entitlements_cloud_plans() -> None:
    e = Entitlements(plan="free", features={"work_orders"}, limits={"full_users": 3})
    assert e.can_use("work_orders") and not e.can_use("parts")
    assert e.limit("full_users") == 3 and e.limit("other") is None


def test_health_and_meta(api) -> None:  # type: ignore[no-untyped-def]
    assert api.get("/healthz").json["status"] == "ok"
    m = api.get("/api/v1/meta").json
    assert m["version"] == __import__("mpro").__version__ and m["edition"] == "selfhosted"


def test_openapi_docs(api) -> None:  # type: ignore[no-untyped-def]
    spec = api.get("/api/openapi.json").json
    assert "/api/v1/users" in spec["paths"] and "/api/v1/auth/login" in spec["paths"]


def test_spa_fallback_does_not_hide_api_404(api) -> None:  # type: ignore[no-untyped-def]
    assert api.get("/api/v1/nope").status_code == 404
    assert api.get("/work-orders").status_code == 200
