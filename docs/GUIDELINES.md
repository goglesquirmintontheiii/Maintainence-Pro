# Maintenance Pro: development guidelines

These apply to every phase of MPro development. **MUST** rules are required. **SHOULD** rules are the default unless the pull request explains why not. **NICE TO HAVE** rules are preferences.

> Source of truth: the **Guidelines** tab of the MPro release checklist. This file is exported from it; update both together.


## Product & scope

### G-01 MaintainX parity first (MUST)

Use MaintainX's names, layout and behaviour for every parity feature unless a written reason says otherwise. Switching teams must not need retraining.

### G-02 Self-hosted stays simple (MUST)

The self-hosted edition runs on one machine with PostgreSQL only. Anything that needs Redis, NATS or several machines belongs to MPro Cloud.

### G-03 Customers can always get their data out (MUST)

Every feature's data must be included in the full export and, where MaintainX supports it, the export back to MaintainX. Exports are never paywalled.

## Architecture

### G-04 Business logic lives in services (MUST)

Rules go in each module's `services.py`; API views, jobs and the importer call services. No business logic in views or templates.

### G-05 Every write emits a domain event (MUST)

Changes write an event to the outbox in the same transaction. Notifications, webhooks, audit, search and sync consume events; they are never called directly from services.

### G-06 Scale-ready data rules (MUST)

UUIDv7 primary keys, `org_id` on every table and query, UTC timestamps, no local state on app servers, idempotency keys on create endpoints.

### G-07 Plan and feature checks go through entitlements (MUST)

Never compare plan names in code. Ask the entitlements service (`org.can_use()`, `org.limit()`).

## Code

### G-08 Typed, formatted Python (MUST)

Python 3.12+, type hints everywhere, mypy strict on new modules, ruff for lint and format. CI fails otherwise.

## Data & migrations

### G-12 Money and quantities use Decimal (MUST)

Never floats for costs, prices, tax or stock. Currency stored with every amount.

## Testing

### G-13 Tests for every service; bugs start with a failing test (MUST)

Service functions have unit tests against real PostgreSQL. Every bug fix adds a test that failed before the fix.

### G-14 End-to-end tests for main flows (SHOULD)

Playwright covers create/complete WO, PM generation, request → WO, import, and scan flows on desktop and phone sizes.

## Security & privacy

### G-15 Scope every query and check permissions (MUST)

All queries filter by `org_id`, and every endpoint calls the central `can(user, action, record)` check. Add a test for cross-org access on every new endpoint.

### G-16 No secrets in the repo (MUST)

Credentials come from the environment; stored credentials (API keys, SMTP, AI keys, tax IDs) are encrypted at rest.

### G-29 General security (SHOULD)

Every build, especially after 1.0.0, will need to have zero vulnerabilities or security issues, and every version should have a quick bug sweep done to check for bugs. Bug sweeps can utilize screenshots to look for visual bugs.

## Design & UX

### G-17 Use design tokens (MUST)

No hard-coded colours, spacing or font sizes; everything comes from the token set and works in light and dark themes.

### G-18 Phone-first for technicians (SHOULD)

Every technician screen works at 375 px wide, with 44 px tap targets usable with gloves, and offline where the phase supports it.

### G-19 Plain-language copy (SHOULD)

Name things the way technicians and planners do. Errors say what went wrong and how to fix it.

## Performance & scale

### G-20 Fast lists on large data (SHOULD)

List endpoints use cursor pagination and stay under 300 ms on the 100k-work-order fixture; no N+1 queries.

## Process & GitHub

### G-21 Link work to the plan (SHOULD)

Conventional commit messages; each PR references its MP-number or roadmap entry and updates the checklist status.

### G-22 Done means tested on a fresh install (SHOULD)

Mark a checklist item Done only after it works on a clean `./start.sh` install with demo data.

### G-25 Publish a GitHub release for every version, including hotfixes (MUST)

Every version (0.1.0, 0.1.1 hotfix, 0.2.0 …) gets a git tag `vX.Y.Z` and a GitHub release with notes taken from that version's `progress.md`. Hotfixes are patch versions (x.y.Z) and get their own release and `progress.md` too.

### G-26 Attach a Windows .exe and a Linux .AppImage to every release (MUST)

Each release includes one-file test builds that start the MPro server with no setup: `MaintenancePro-X.Y.Z-windows-x64.exe` and `MaintenancePro-X.Y.Z-x86_64.AppImage`. They use a local SQLite database, open the browser automatically and load demo data on first run. They are for testing, not production.

### G-27 Keep progress.md current; archive it when a version ships (MUST)

- `progress.md` at the repo root holds the current version's task list, ticked off as tasks finish, with screenshots stored in `docs/screenshots/<version>/` and linked inline.
- When a new phase/version starts, move the old file to `progress_history/progress_<version>.md` and start a fresh `progress.md`.

## AI coding agents

### G-23 Read the guidelines and the phase goal first (MUST)

Before starting work, read these guidelines, the current phase goal and the item's spec and acceptance checks.

### G-24 Stay inside the current phase (SHOULD)

Don't add features from later phases or outside the spec without asking; note ideas on the roadmap instead.

## General

### G-28 Screenshots (MUST)

With each phase that works on the frontend, there should be screenshots showing changes made and the new versions of pages.
