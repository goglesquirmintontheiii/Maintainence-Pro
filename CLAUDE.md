# Maintenance Pro (MPro): notes for AI coding agents and contributors

Maintenance Pro is a self-hosted CMMS built as a drop-in replacement for MaintainX: same layout,
names and behaviour so teams can switch without retraining, plus an importer that brings their data over.

**Before starting any work, read [docs/GUIDELINES.md](docs/GUIDELINES.md) (the project rules), the current
phase goal and the checklist item's spec.** Those rules win over anything below if they ever disagree.

## Every version

1. Work only on the current phase's checklist items (see `progress.md`). Put ideas for later on the roadmap.
2. Keep `progress.md` current: tick tasks as they're finished and link screenshots stored in
   `docs/screenshots/<version>/` (capture them with `scripts/screenshots.py`).
3. When a new version starts, move `progress.md` to `progress_history/progress_<version>.md` and start a new one.
4. Bug sweep and zero known vulnerabilities before release: `uvx pip-audit`, `npm audit`, review the screenshots.
5. Release by bumping `__version__` in `mpro/__init__.py` (and `frontend/package.json`) on `main`, hotfixes
   too. On the next push the Release workflow sees a version with no release yet, builds the Windows `.exe`
   and Linux `.AppImage` test builds, creates the `vX.Y.Z` tag and publishes the release with notes from
   `progress.md`. (Pushing a `vX.Y.Z` tag yourself also works.)

## Layout

```
mpro/                  Flask (APIFlask) backend — modular monolith
  core/                ids (UUIDv7), models, events (outbox + audit), jobs (DB queue), mail,
                       permissions (role matrix), entitlements (plans), tenancy (org scoping), search,
                       settings (per-org JSON settings), files (storage, attachments, Download Center)
  auth/ orgs/          one package per module: models.py, services.py (business rules), api.py
  workorders/          services.py (rules), activity.py (comments, time, costs), queries.py (filters,
                       serialization, workload), exports.py (PDF/CSV), demo.py (sample work)
  migrations/          Alembic (Flask-Migrate); `flask --app mpro:create_app db migrate -d mpro/migrations`
  desktop.py           launcher used by the .exe / .AppImage test builds
frontend/              React + TypeScript + Vite; builds into mpro/static/app (pages/workorders/ = WO screens)
tests/                 pytest (SQLite by default; TEST_DATABASE_URL for PostgreSQL); tests/e2e = Playwright
packaging/             PyInstaller spec, AppImage script, icons
```

## Commands

```bash
./start.sh --dev                         # API on :8080 + web app with hot reload on :5173, demo data
uv run pytest                            # backend tests (add TEST_DATABASE_URL=postgresql+psycopg://… for PG)
MPRO_E2E=1 uv run pytest tests/e2e       # browser tests (build the frontend first)
uv run ruff check mpro tests && uv run ruff format mpro tests && uv run mypy
cd frontend && npm run build             # typecheck + production build
```

## Conventions that matter

- Business logic lives in `services.py`; API views stay thin.
- Every write calls `emit(...)` in the same transaction (audit log + outbox).
- Tenant data: always `scoped(Model)` / `get_scoped(Model, id)`; endpoints use `@require("action")`.
  IDs that arrive in request bodies (assignees, categories, files, parents, links) must be checked against
  the current org in the service. Work orders also respect limited visibility (`can_see`, `visibility_clause`).
- Files attach to any record through `FileLink`; a module says who may view/edit its records with
  `register_entity(...)`. Exports go through `request_export(...)` and land in the Download Center.
- Plan/feature checks: `entitlements_for(org)`; never compare plan names.
- UI: design tokens in `frontend/src/styles/tokens.css`; MaintainX names and layout for parity features.
- Licensing: the repo is source-available ([LICENSE](LICENSE)); keep the name, logos and licence notices
  intact. Contributions come in under the CLA in CONTRIBUTING.md. Cloud-only features are gated through
  `entitlements_for(org)` so they can later move to the separate MPro Cloud repository cleanly.
