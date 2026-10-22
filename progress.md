# MPro 0.4.0 — Preventive maintenance, procedures & automations

**Status: released** · Checklist milestone 0.4.0 · Started 2026-10-22 · Released 2026-10-22

Scheduled and meter-triggered work (repeating work orders and Maintenance Plans with nested PMs), the procedure
builder with every MaintainX field type, and automations. Also the changes requested in the 0.3.0 review.

## Task list

### Preventive maintenance
- [x] **MP-032** Repeating work orders (time-based schedules)
- [x] **MP-033** PM list and PM calendar
- [x] **MP-038** Seasonal and shift-based schedules
- [x] **MP-104** Maintenance Plans (with Nested PMs)
- [x] **MP-118** Sub-work orders: inheritance, roll-ups and repeating parents

### Procedures
- [x] **MP-034** Procedure (checklist) builder
- [x] **MP-035** Conditional logic in procedures
- [x] **MP-036** Procedure library and templates
- [x] **MP-037** Procedure results reporting

### Automations
- [x] **MP-117** Automations: triggers, conditions and actions

### Requests from the 0.3.0 review
- [x] **MP-105** Wider work-order list in To Do
- [x] **MP-106** Owner role and custom roles with permissions
- [x] **MP-107** Better file viewer: larger previews, videos, documents, AVIF
- [x] **MP-108** Currency custom fields
- [x] **MP-109** 150 MB upload limit
- [x] **MP-110** Floor plan viewer and editor
- [x] **MP-111** Administrators can edit their own job title
- [x] **MP-112** Work order cover picture on cards
- [x] **MP-113** Cleaner Calendar and Workload headers
- [x] **MP-114** Warranty documents on assets
- [x] **MP-115** Custom fields set on asset types
- [x] **MP-116** Profile photos with crop, move, zoom and rotate
- [x] **MP-119** 0.3.0 follow-ups (templates on the list and asset page, new work order from a meter, warranty reminders)

### Moved to later versions
- **0.9.0:** global procedures for multi-site organizations
- **1.1.0:** public Procedure Hub; connect your own cloud storage (planned, r653)
- **1.2.0:** AI procedure generators and recommendations

## Notes

- Meter triggers from 0.3.0 are now automations (Automations → "When a meter reading…"). Existing triggers were converted by the upgrade and the old `/meters/{id}/triggers` endpoints are gone.
- Every organization has an Owner; the person who created it was promoted. Only Owners can make other Owners, change organization settings and billing, or edit roles.
- To Do's list now starts at `min(624px, 55%)` wide and can be dragged up to 64%.
- Floor plan editor: shapes, labels, pins and measurements save with version history. Parts lists on plans come with Parts in 0.5.0; pinch-to-zoom inside the editor is not in yet.
- Large DOCX/XLSX previews (over 2 MB) are rendered in the background and cached; archives that expand too much are refused.
- Independent review fixes: procedure history and analytics respect limited visibility, schedule rules are whitelisted and bounded, PM generation is atomic (no duplicate work orders under load), floating intervals count from the last finished visit, automation conditions validated, hooks isolated so one failure can't break a save, deleting a custom role moves its members to the closest built-in role, people who left are ignored as assignees, migration fixes.
- Bug sweep: independent review, `uvx pip-audit` and `npm audit` (0 vulnerabilities), backend tests on SQLite and PostgreSQL (195 passed), browser tests (14 passed).

## Screenshots

- [Overview with the 0.4.0 additions](docs/screenshots/0.4.0/01-overview.png)
- [Preventive Maintenance: plans and repeating work](docs/screenshots/0.4.0/02-pm-plans.png)
- [Maintenance Plan with nested PMs, compliance and next due](docs/screenshots/0.4.0/03-pm-plan-detail.png)
- [PM calendar](docs/screenshots/0.4.0/04-pm-calendar.png)
- [PM compliance](docs/screenshots/0.4.0/05-pm-compliance.png)
- [Plan editor: time, usage or whichever comes first, calendar rules](docs/screenshots/0.4.0/06-pm-plan-editor.png)
- [Procedure library](docs/screenshots/0.4.0/07-procedures-library.png)
- [Procedure builder with every field type and conditional logic](docs/screenshots/0.4.0/08-procedure-builder.png)
- [Procedure results across work orders](docs/screenshots/0.4.0/09-procedure-analytics.png)
- [Filling in a procedure on a work order](docs/screenshots/0.4.0/10-procedure-runner.png)
- [Automations list](docs/screenshots/0.4.0/11-automations.png)
- [Automation builder: trigger, conditions, actions](docs/screenshots/0.4.0/12-automation-builder.png)
- [Roles and permissions, with Owner and custom roles](docs/screenshots/0.4.0/13-roles.png)
- [Wider To Do list with cover pictures](docs/screenshots/0.4.0/14-todo-wider-covers.png)
- [Cleaner Calendar header](docs/screenshots/0.4.0/15-calendar-header.png)
- [Cleaner Workload header](docs/screenshots/0.4.0/16-workload-header.png)
- [File viewer with large previews and documents](docs/screenshots/0.4.0/17-file-viewer.png)
- [Floor plan editor](docs/screenshots/0.4.0/18-floor-plan-editor.png)
- [Profile photo crop, move, zoom and rotate](docs/screenshots/0.4.0/19-profile-photo.png)
- [Custom fields set on asset types](docs/screenshots/0.4.0/20-asset-type-fields.png)
- [Repeat options on the work order form](docs/screenshots/0.4.0/21-wo-form-repeat.png)
- [Phone: procedure runner](docs/screenshots/0.4.0/22-phone-procedure-runner.png)
- [Phone: PM calendar](docs/screenshots/0.4.0/23-phone-pm-calendar.png)
- [Phone: automations](docs/screenshots/0.4.0/24-phone-automations.png)
