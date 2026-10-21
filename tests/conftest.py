from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any

import pytest
from flask.testing import FlaskClient

os.environ.setdefault("MPRO_SECRET_KEY", "test-secret")


@pytest.fixture()
def app(tmp_path: Any) -> Iterator[Any]:
    os.environ["MPRO_DATA_DIR"] = str(tmp_path)
    url = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{(tmp_path / 'test.db').as_posix()}"
    from mpro.app import create_app
    from mpro.cli import upgrade_db
    from mpro.extensions import db

    app = create_app(
        {"SQLALCHEMY_DATABASE_URI": url, "TESTING": True, "MPRO_INLINE_JOBS": True, "MPRO_BASE_URL": "http://mpro.test"}
    )
    if url.startswith("postgresql"):
        with app.app_context():
            db.drop_all()
            db.session.execute(db.text("DROP TABLE IF EXISTS alembic_version"))
            db.session.commit()
    upgrade_db(app)
    with app.app_context():
        from mpro.demo import seed_demo

        seed_demo(work_orders=os.environ.get("MPRO_TEST_DEMO_WORK") == "1")
    yield app
    with app.app_context():
        db.session.remove()
        db.engine.dispose()


class Api:
    """Small helper that keeps the CSRF token like the browser app does."""

    def __init__(self, client: FlaskClient) -> None:
        self.c = client
        self.csrf = ""

    def _h(self) -> dict[str, str]:
        return {"X-CSRF-Token": self.csrf}

    def session(self) -> dict[str, Any]:
        r = self.c.get("/api/v1/auth/session")
        self.csrf = r.json["csrf"]
        return r.json  # type: ignore[no-any-return]

    def login(self, email: str = "admin@example.com", password: str = "mpro-demo-123") -> Any:
        r = self.c.post("/api/v1/auth/login", json={"email": email, "password": password})
        if r.status_code == 200:
            self.csrf = r.json["csrf"]
        return r

    def get(self, url: str, **kw: Any) -> Any:
        return self.c.get(url, **kw)

    def post(self, url: str, json: Any = None) -> Any:
        return self.c.post(url, json=json, headers=self._h())

    def patch(self, url: str, json: Any = None) -> Any:
        return self.c.patch(url, json=json, headers=self._h())

    def delete(self, url: str) -> Any:
        return self.c.delete(url, headers=self._h())


@pytest.fixture()
def api(app: Any) -> Api:
    return Api(app.test_client())


@pytest.fixture()
def admin(api: Api) -> Api:
    assert api.login().status_code == 200
    return api
