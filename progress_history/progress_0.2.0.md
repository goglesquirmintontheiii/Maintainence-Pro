# MPro 0.2.0 — Work orders

**Status: released** · Tag `v0.2.0` · Checklist milestone 0.2.0 · Started and finished 2026-10-21

The core of a CMMS: create, assign, track and complete work orders the way MaintainX does, with the To Do,
Table, Calendar, Workload and Board views, comments and photos, time and costs, sign-off, and PDF export.

## Task list

### Checklist items

- [x] **MP-012** Create, edit and delete work orders — MaintainX fields (title up to 255, description up to 4,096, priority None/Low/Medium/High, work type, start and due date/time, estimated time), people and team assignees, categories, per-organization numbering (#1042) from a locked counter, side-panel create form, delete with Undo and restore
  - Note: linking an asset, location or vendor arrives with those modules (0.3.0 and 0.5.0); the work order is ready for them.
- [x] **MP-013** Statuses: Open, On Hold, In Progress, Done — plus Canceled; every change logged with who and when; configurable required fields; reopen; sub-statuses (e.g. *Waiting on parts*) that roll up to the four core statuses; time in each status
- [x] **MP-014** Work order list with filters, sort and saved views — To Do / Done tabs with MaintainX grouping (Assigned to me, My teams, Created by me, All); filters with One of / None of / Is empty / Contains / dates / custom fields; sort; personal and organization views, pinned views
- [x] **MP-015** Calendar and workload views — month and week calendar with overdue in red, drag to reschedule, first day of week; Workload shows estimated hours per person per day against capacity, drag to reassign or reschedule
- [x] **MP-016** Comments, photos and file attachments — @mentions of people and teams, edit, delete, emoji reactions, files on comments; photos with thumbnails, PDFs, Office files and video; before / after photos; lightbox
- [x] **MP-017** Time and cost tracking — start/stop timers (several people at once), manual time with type and rate override, labor cost from personal or default hourly rates (hidden from roles that shouldn't see rates), other costs with receipts
  - Note: parts used and deducting stock arrive with Parts & Inventory in 0.5.0.
- [x] **MP-018** Sub-work orders and linked work orders — parent / child with progress, "blocks" and "related" links with a warning when blocked
- [x] **MP-019** Completion signature and sign-off — signature pad, optional completion summary, optional approval before Done (approve or send back with a reason)
- [x] **MP-020** Categories — MaintainX's default categories, add / rename / colour / delete, several per work order, filter and table column
- [x] **MP-021** Bulk edit, duplicate and print / PDF work orders — bulk status, priority, dates, assignees, categories, read state, cancel and delete with Undo; Copy to new and Duplicate; PDF with QR code, image sizes and content toggles; CSV and PDF exports to the Download Center
- [x] **MP-022** Custom fields on work orders — text, multi-line, number, single select, date, date and time, checkbox and link fields; required; reorder; in filters, the table, PDF and CSV

### Roadmap items for this phase

- [x] Domain events + transactional outbox (r017, from 0.1.0) · optimistic concurrency with `version` / `If-Match` and a 409 that returns the newer record (r018)
- [x] File storage abstraction (r019): local storage with type checks and sandboxed downloads, thumbnails in a background job. S3/MinIO plugs into the same interface for MPro Cloud.
- [x] Per-org numbering (r020) and "Next Work Order ID" setting (r034)
- [x] Work-order detail layout parity (r021) · optimistic updates, Undo, keyboard shortcuts, `?` help (r022, r098, r103)
- [x] MaintainX fields and rules: title (r023), pictures and files (r024), dates (r026), start date hides from To Do (r027), statuses (r028), categories (r030, r064), comments (r031), mention assigns (r032), templates (r033), required fields (r035), custom fields and options (r036, r037), require time/cost to complete (r038), completion summary (r039), cancel (r040), delete and show deleted (r041, r101), description (r066), multiple assignees (r070), estimated time (r071), work type (r072), priorities (r073), history (r077), copy to new (r078), comment rules for On Hold / Cancel (r081), To Do by start date only (r084), first day of week (r086), mark read / unread (r089), other costs (r091), internal link (r093)
- [x] Views: To Do (r045), grouping (r046), Table (r047), Calendar (r048), Workload (r049), filters (r050), saved filters (r051), bulk edit (r052), Board (r087)
- [x] Limited work order visibility (r053), time entries (r054), time and cost types (r055), hourly rates (r056), time in status (r057)
- [x] Export to PDF with content toggles (r061, r062), Download Center (r063)
- [x] Search work orders by number or text (r096, r097, r103); panel + table views for work orders (r099); copy links (r100)
- [x] Custom statuses as sub-statuses (r102)
- [x] Dependency audit: **0 known vulnerabilities** (pip-audit, npm audit)

### Moved to later versions

These 0.2.0 roadmap items need modules that don't exist yet, so they moved to the version that builds them
(noted on each roadmap entry):

- **0.3.0 Assets & locations:** single location and asset per WO, change asset status from the WO, "Use in New Work Order"
- **0.4.0 Procedures & PM:** procedures on WOs, auto In Progress, Fail/Flag filter, corrective-action WOs, location check-in, skip occurrence
- **0.5.0 Parts & vendors:** parts used, completion side effects, vendors on WOs, email WO to vendors, external WOs (links, field access, "shared externally" filter, completion notice)
- **0.6.0 Mobile & messages:** photo annotation, WO from a chat message, overdue escalation teams, mobile timers
- **1.2.0 AI:** LLM-translated global categories

### Quality gates

- [x] Backend: 88 tests pass on SQLite and PostgreSQL 16 (41 new for work orders: rules, permissions, tenancy, limited visibility, files, time and costs, approvals, bulk with undo, views, PDF/CSV, plus regression tests for every review finding); ruff and mypy clean
- [x] Browser tests: 7 pass, including create → comment → complete and table filters → bulk select → calendar / workload / board
- [x] Dependency audit: 0 known vulnerabilities (pip-audit, npm audit)
- [x] Bug sweep with screenshots and an independent code review. Fixed before release:
  - Activity feed exposed IP addresses to non-admins (now only in the admin audit log)
  - Limited-visibility users could see titles of hidden sub-work orders, parents and links, or attach to a hidden parent
  - Costs accepted a person from another organization
  - Deleting a custom field or select option blocked editing and duplicating old work orders
  - Custom-field filters: checkboxes on SQLite, number ranges and date before/after now compare by type
  - Reopening or canceling a Done work order kept the old signature, summary and approval state
  - Undo after a status change failed when a comment was required and didn't restore the sub-status
  - Malformed bulk input returned 500 instead of a clear error; files on deleted comments stayed downloadable
  - PDFs were sent sandboxed, which Chrome's PDF viewer won't open; first-number race on PostgreSQL; export errors no longer show internals
  - Escape in a picker closed the whole panel; links to a work order didn't open it after using another view; @mention caret jumped when typing fast; phone toolbar overflowed
- [x] Test build checked locally: the bundled server starts, generates PDFs with QR codes and makes photo thumbnails

## Screenshots

| | |
|---|---|
| ![Overview](docs/screenshots/0.2.0/01-overview.png) **Overview** with work-order tiles and My work | ![To Do](docs/screenshots/0.2.0/02-todo-detail.png) **To Do list + detail** |
| ![Time and costs](docs/screenshots/0.2.0/03-time-and-costs.png) **Timer, time and costs** | ![Mentions](docs/screenshots/0.2.0/04-comment-mention.png) **Comments with @mentions** |
| ![Create](docs/screenshots/0.2.0/05-create.png) **New work order panel** | ![Table](docs/screenshots/0.2.0/06-table.png) **Table view** |
| ![Filters and bulk](docs/screenshots/0.2.0/07-filter-and-bulk.png) **Filters and bulk edit** | ![Calendar](docs/screenshots/0.2.0/08-calendar.png) **Calendar** |
| ![Workload](docs/screenshots/0.2.0/09-workload.png) **Workload** | ![Board](docs/screenshots/0.2.0/10-board.png) **Board** |
| ![Complete](docs/screenshots/0.2.0/11-complete-with-signature.png) **Complete with signature** | ![PDF](docs/screenshots/0.2.0/12-pdf-export.png) **Export to PDF** |
| ![Search](docs/screenshots/0.2.0/13-search.png) **Search work orders** | ![Settings](docs/screenshots/0.2.0/14-settings.png) **Work order settings** |
| ![Categories](docs/screenshots/0.2.0/15-categories.png) **Categories** | ![Download Center](docs/screenshots/0.2.0/16-download-center.png) **Download Center** |
| ![Shortcuts](docs/screenshots/0.2.0/17-shortcuts.png) **Keyboard shortcuts** | ![Dark](docs/screenshots/0.2.0/18-dark-theme.png) **Dark theme** |
| ![Dark calendar](docs/screenshots/0.2.0/19-dark-calendar.png) **Dark calendar** | |

<p>
<img src="docs/screenshots/0.2.0/20-phone-list.png" width="200" alt="Phone list">
<img src="docs/screenshots/0.2.0/21-phone-detail.png" width="200" alt="Phone detail">
</p>

## Known limitations

- Notifications (email/push for assignments, mentions and due dates) arrive in 0.6.0. Until then, unread work
  orders show a blue dot and mentions are recorded for the notification system.
- Assets, locations, procedures, parts and vendors aren't on work orders yet (see "Moved to later versions").
- Phone layouts work but haven't had a dedicated mobile review yet; that's planned for 0.3.0–0.4.0.
- Uploads are stored in the data folder. S3-compatible storage is for MPro Cloud.

## Next: 0.3.0 Assets, locations and meters
