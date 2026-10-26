"""Application factory."""

from __future__ import annotations

import logging
import uuid
from pathlib import Path
from typing import Any

from apiflask import APIFlask, abort
from flask import Response, g, request, send_from_directory, session
from flask_login import current_user

from mpro.config import load_config
from mpro.extensions import db, login_manager, migrate

PKG = Path(__file__).resolve().parent
STATIC_APP = PKG / "static" / "app"
MIGRATIONS = PKG / "migrations"


def create_app(overrides: dict[str, Any] | None = None) -> APIFlask:
    app = APIFlask(
        "mpro",
        title="Maintenance Pro API",
        static_folder=None,  # type: ignore[arg-type]
        docs_ui="redoc",
        spec_path="/api/openapi.json",
        docs_path="/api/docs",
    )
    app.config.update(load_config(overrides))
    proxies = int(app.config.get("MPRO_TRUSTED_PROXIES") or 0)
    if proxies > 0:
        # request.remote_addr becomes the client address set by the trusted proxies, and nothing else
        from werkzeug.middleware.proxy_fix import ProxyFix

        app.wsgi_app = ProxyFix(  # type: ignore[method-assign]
            app.wsgi_app, x_for=proxies, x_proto=proxies, x_host=proxies, x_port=proxies, x_prefix=0
        )
    app.json.sort_keys = False  # type: ignore[attr-defined]
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    db.init_app(app)
    migrate.init_app(app, db, directory=str(MIGRATIONS), render_as_batch=True)
    login_manager.init_app(app)

    # Import models so metadata is complete, and modules so job/search/event registries fill.
    from mpro.assets import models as _asset_models  # noqa: F401
    from mpro.assets.api import bp as assets_bp
    from mpro.auth import models as _auth_models  # noqa: F401
    from mpro.auth.api import CSRF_EXEMPT
    from mpro.auth.api import bp as auth_bp
    from mpro.auth.models import User
    from mpro.automations import models as _automation_models  # noqa: F401
    from mpro.automations.api import bp as automations_bp
    from mpro.core import files as _files  # noqa: F401
    from mpro.core import hierarchy as _hierarchy  # noqa: F401
    from mpro.core import jobs as _jobs  # noqa: F401
    from mpro.core import mail as _mail  # noqa: F401
    from mpro.core import settings as _settings  # noqa: F401
    from mpro.core.admin_api import bp as admin_bp
    from mpro.core.admin_api import health_bp
    from mpro.core.files_api import bp as files_bp
    from mpro.finance import models as _finance_models  # noqa: F401
    from mpro.finance.api import bp as finance_bp
    from mpro.messaging import models as _messaging_models  # noqa: F401
    from mpro.messaging.api import bp as messaging_bp
    from mpro.meters import models as _meter_models  # noqa: F401
    from mpro.meters.api import bp as meters_bp
    from mpro.notifications import models as _notification_models  # noqa: F401
    from mpro.notifications.api import bp as notifications_bp
    from mpro.orgs import models as _org_models  # noqa: F401
    from mpro.orgs.api import bp as orgs_bp
    from mpro.parts import models as _parts_models  # noqa: F401
    from mpro.parts.api import bp as parts_bp
    from mpro.pm import models as _pm_models  # noqa: F401
    from mpro.pm.api import bp as pm_bp
    from mpro.procedures import models as _procedure_models  # noqa: F401
    from mpro.procedures.api import bp as procedures_bp
    from mpro.purchasing import models as _purchasing_models  # noqa: F401
    from mpro.purchasing.api import bp as purchasing_bp
    from mpro.qr import models as _qr_models  # noqa: F401
    from mpro.qr.api import bp as qr_bp
    from mpro.suppliers import models as _supplier_models  # noqa: F401
    from mpro.suppliers.api import bp as suppliers_bp
    from mpro.sync import models as _sync_models  # noqa: F401
    from mpro.sync.api import bp as sync_bp
    from mpro.sysadmin import models as _sysadmin_models  # noqa: F401
    from mpro.sysadmin.api import bp as sysadmin_bp
    from mpro.vendors import models as _vendor_models  # noqa: F401
    from mpro.vendors.api import bp as vendors_bp
    from mpro.workorders import exports as _wo_exports  # noqa: F401
    from mpro.workorders import models as _wo_models  # noqa: F401
    from mpro.workorders.api import bp as wo_bp
    from mpro.workrequests import models as _request_models  # noqa: F401
    from mpro.workrequests.api import bp as requests_bp

    @login_manager.user_loader
    def load_user(uid: str) -> User | None:
        try:
            u = db.session.get(User, uuid.UUID(uid))
        except ValueError:
            return None
        return u if u and u.is_active else None

    @login_manager.unauthorized_handler
    def unauthorized() -> Any:
        abort(401, message="Please sign in.")

    @app.before_request
    def load_context() -> None:
        g.user = current_user if current_user.is_authenticated else None
        g.org = g.membership = None
        if g.user is not None:
            ms = [m for m in g.user.memberships if m.deleted_at is None and m.org.deleted_at is None]
            want = session.get("org_id")
            m = next((x for x in ms if str(x.org_id) == want), None) or (ms[0] if ms else None)
            if m is not None:
                g.membership, g.org = m, m.org
                session["org_id"] = str(m.org_id)
        # CSRF: double-submit token on every state-changing API call
        if (
            request.path.startswith("/api/")
            and request.method not in {"GET", "HEAD", "OPTIONS"}
            and request.endpoint not in CSRF_EXEMPT
        ):
            sent = request.headers.get("X-CSRF-Token", "")
            if not sent or sent != session.get("csrf"):
                abort(403, message="Your session expired. Reload the page and try again.")

    @app.errorhandler(413)
    def _too_large(_e: Any) -> tuple[dict[str, Any], int]:
        mb = int(app.config.get("MPRO_MAX_UPLOAD_MB", 150))
        return {"message": f"That file is too large. Files can be up to {mb} MB.", "status": 413}, 413

    @app.after_request
    def after(resp: Response) -> Response:
        if app.config.get("MPRO_INLINE_JOBS") and request.method not in {"GET", "HEAD"}:
            from mpro.core.jobs import run_pending

            run_pending()
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        if not request.path.startswith("/api/docs"):
            resp.headers.setdefault(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
                "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob: data:; "
                "frame-ancestors 'self'",
            )
        return resp

    for bp in (
        auth_bp,
        orgs_bp,
        wo_bp,
        assets_bp,
        meters_bp,
        qr_bp,
        procedures_bp,
        pm_bp,
        automations_bp,
        vendors_bp,
        parts_bp,
        purchasing_bp,
        suppliers_bp,
        finance_bp,
        requests_bp,
        messaging_bp,
        notifications_bp,
        sync_bp,
        sysadmin_bp,
        files_bp,
        admin_bp,
        health_bp,
    ):
        app.register_blueprint(bp)

    @app.get("/", defaults={"path": ""})
    @app.get("/<path:path>")
    @app.doc(hide=True)
    def spa(path: str) -> Any:
        if path.startswith("api/"):
            abort(404)
        if path and (STATIC_APP / path).is_file():
            resp = send_from_directory(STATIC_APP, path)
            if path.startswith("assets/"):
                resp.cache_control.max_age = 31536000
                resp.cache_control.immutable = True
            elif path in ("sw.js", "sw-push.js", "manifest.webmanifest"):  # the phone app checks these for updates
                resp.cache_control.no_cache = True
                resp.cache_control.max_age = 0
            return resp
        if (STATIC_APP / "index.html").is_file():
            resp = send_from_directory(STATIC_APP, "index.html")
            resp.cache_control.no_cache = True
            if path.startswith(("x/", "v/")):  # external work-order and vendor PO links: the token is in the URL
                resp.headers["Referrer-Policy"] = "no-referrer"
                resp.cache_control.no_store = True
            return resp
        return Response(
            "<h1>Maintenance Pro</h1><p>The web app isn't built yet. Run <code>./start.sh --dev</code> "
            "or <code>npm run build</code> in <code>frontend/</code>.</p>",
            mimetype="text/html",
        )

    from mpro.cli import register_flask_cli

    register_flask_cli(app)
    return app
