"""Asset Hub endpoints (0.5.0, r115). Admin only: everything needs `assets.packages`. Routes live on the assets
blueprint; `register()` is called from the end of `mpro/assets/api.py`."""

from __future__ import annotations

import json
from typing import Any

from apiflask import abort
from flask import g, request

from mpro.assets import asset_hub as hub
from mpro.assets.api import _asset, body, bp
from mpro.core.tenancy import require
from mpro.extensions import db
from mpro.orgs.services import RuleError


def _guard(fn: Any, *a: Any, **k: Any) -> Any:
    try:
        return fn(*a, **k)
    except RuleError as e:
        db.session.rollback()
        abort(e.status, message=e.message)


def _status() -> str | None:
    s = request.args.get("status", "suggested")
    if s not in ("suggested", "applied", "dismissed", "all"):
        abort(422, message="Status must be suggested, applied, dismissed or all.")
    return None if s == "all" else s


@bp.get("/asset-packages")
@require("assets.packages")
def list_packages() -> dict[str, Any]:
    return {"items": hub.list_packages(g.org)}


@bp.post("/asset-packages")
@require("assets.packages")
def import_package() -> tuple[dict[str, Any], int]:
    """Import a package: a JSON body, or a multipart `file` with the package JSON."""
    up = request.files.get("file")
    if up is not None:
        raw = up.read(hub.MAX_IMPORT_BYTES + 1)
        if len(raw) > hub.MAX_IMPORT_BYTES:
            abort(413, message="Package files can be up to 512 KB.")
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            abort(422, message="That file isn't valid JSON.")
    else:
        if (request.content_length or 0) > hub.MAX_IMPORT_BYTES:
            abort(413, message="Package files can be up to 512 KB.")
        data = body()
    p = _guard(hub.import_package, g.org, g.membership, data)
    return hub.package_dict(p, detail=True), 201


@bp.get("/asset-packages/<pid>")
@require("assets.packages")
def get_package(pid: str) -> dict[str, Any]:
    hub.sync_builtin(g.org)
    return hub.package_dict(_guard(hub.get_package, g.org.id, pid), detail=True)


@bp.delete("/asset-packages/<pid>")
@require("assets.packages")
def delete_package(pid: str) -> tuple[str, int]:
    p = _guard(hub.get_package, g.org.id, pid)
    _guard(hub.delete_package, g.org, g.membership, p)
    return "", 204


@bp.post("/asset-packages/<pid>/install")
@require("assets.packages")
def install_package(pid: str) -> dict[str, Any]:
    """Create or link the package's asset type, fields, parts, procedures and templates; then suggest it for
    matching assets. Running it again links what's there and creates anything missing."""
    p = _guard(hub.get_package, g.org.id, pid)
    res = _guard(hub.install, g.org, g.membership, p)
    return {"result": res, "package": hub.package_dict(p, detail=True)}


@bp.get("/asset-packages/<pid>/matches")
@require("assets.packages")
def package_matches(pid: str) -> dict[str, Any]:
    p = _guard(hub.get_package, g.org.id, pid)
    hub.match_assets(g.org, p)
    return {"items": hub.matches(g.org, package=p, status=_status())}


@bp.get("/asset-package-matches")
@require("assets.packages")
def all_matches() -> dict[str, Any]:
    return {"items": hub.matches(g.org, status=_status())}


@bp.get("/assets/<aid>/package-suggestions")
@require("assets.packages")
def asset_suggestions(aid: str) -> dict[str, Any]:
    return {"items": hub.matches(g.org, asset=_asset(aid))}


@bp.post("/asset-package-matches/<mid>/apply")
@require("assets.packages")
def apply_match(mid: str) -> dict[str, Any]:
    mt = _guard(hub.get_match, g.org.id, mid)
    _guard(hub.apply_match, g.org, g.membership, mt)
    return {"status": mt.status}


@bp.post("/asset-package-matches/<mid>/dismiss")
@require("assets.packages")
def dismiss_match(mid: str) -> dict[str, Any]:
    mt = _guard(hub.get_match, g.org.id, mid)
    _guard(hub.dismiss_match, g.org, g.membership, mt)
    return {"status": mt.status}


def register() -> None:
    """Importing this module adds the routes; nothing else to wire."""
