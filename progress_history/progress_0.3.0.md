# MPro 0.3.0 — Assets, locations & meters (and hotfix 0.3.1)

**Status: released** · Checklist milestone 0.3.0 · Started 2026-10-22 · Released 2026-10-22

The things being maintained: asset and location hierarchies, asset status and downtime, meters and readings,
QR codes and labels, and assets and locations on work orders. Also the changes requested in the 0.2.0 review.

## 0.3.1 hotfix (2026-10-22)

- **Linux AppImage didn't open when double-clicked** (it only worked with "Run in Konsole"). Started without a
  terminal, the server ran invisibly and the browser it launched inherited the bundle's libraries, so nothing
  appeared. The launcher now re-opens itself in your terminal app (Konsole, GNOME Terminal, Xfce, kitty, …),
  always starts the browser with a clean environment, and if MPro is already running it just opens the browser
  again instead of starting a second copy. Closing the terminal window stops MPro cleanly.

## Task list

### Checklist items

- [x] **MP-023** Asset register with hierarchy (parent / child)
- [x] **MP-024** Asset status and downtime tracking
- [x] **MP-025** Asset detail: history, work orders, costs
- [x] **MP-026** QR codes and barcodes for assets
- [x] **MP-027** Asset types / custom asset fields
- [x] **MP-028** Location hierarchy (site → building → room)
- [x] **MP-029** Floor plans with asset pins
- [x] **MP-030** Meters and readings
- [x] **MP-031** Meter-based triggers
- [x] **MP-095** QR codes for every record
- [x] **MP-096** Label designer and printing
- [x] **MP-098** Carried over from 0.2.0: assets and locations on work orders
- [x] **MP-099** Asset task lists on a work order (request)
- [x] **MP-100** Interface changes from the 0.2.0 review (light sidebar, light default, clear-date buttons, In Progress blue)
- [x] **MP-101** One-tap create from work order templates (approved suggestion)
- [x] **MP-102** Asset lifecycle, warranty and condition photo timeline (approved suggestions)
- [x] **MP-103** Create an asset from a nameplate photo (approved suggestion)

### Moved to later versions

- **0.4.0:** location check-in (it's a procedure step)
- **0.5.0:** asset packages / Asset Hub (they bundle parts and procedures)
- **0.8.0:** bulk asset update by spreadsheet (uses the importer's diff-and-undo engine; CSV export ships now)
- **0.9.0:** asset transfers between organizations
- **1.2.0:** AI asset source sharing
- **1.3.0:** OEM data sharing toggle
- **1.4.0:** OT data connectors, ERBESSD vibration sensors, Smart Tag Mapping

## Notes

- In Progress is now blue, Open teal and Done green; the sidebar is light in the light theme and light is the default for everyone (existing "Match my device" settings were the old default and moved to Light).
- The Workload view now applies the search box and filters (it ignored them in 0.2.0) and shows a weekly total per person.
- Readings overdue show on Overview and in the Meters list; reminder notifications arrive with Notifications in 0.6.0.
- Nameplate reading runs on the device (tesseract.js, files served by MPro itself), adding about 14 MB to the test builds.
- Independent review fixes: PostgreSQL reading partitions (months created up front; stray rows moved out of the default partition), asset insights no longer count costs from work orders a limited-visibility user can't see, trigger and template "due in days" validated, copied every-N triggers fire, back-dated status changes can't reorder history, lowering max depth no longer blocks edits, codes left on deleted assets can be reassigned, type-limited custom fields enforced, CSV headers sanitised, missing audit events added.
- Bug sweep: independent review, `uvx pip-audit` and `npm audit` (0 vulnerabilities), backend tests on SQLite and PostgreSQL, browser tests.

## Screenshots

- [Overview in the new default light theme, with asset and meter tiles](docs/screenshots/0.3.0/01-overview-light.png)
- [Assets: tree with status, location and open work](docs/screenshots/0.3.0/02-assets-tree.png)
- [Asset detail: details, QR codes and sub-assets](docs/screenshots/0.3.0/03-asset-detail.png)
- [Insights: availability, downtime, work and costs](docs/screenshots/0.3.0/04-asset-insights.png)
- [Downtime: status history with planned/unplanned downtime](docs/screenshots/0.3.0/05-asset-downtime.png)
- [Lifecycle, warranty and straight-line depreciation](docs/screenshots/0.3.0/06-asset-lifecycle.png)
- [Assets table with filters and bulk selection](docs/screenshots/0.3.0/07-assets-table.png)
- [New asset, with “Read a nameplate photo”](docs/screenshots/0.3.0/08-asset-create.png)
- [Change status with reasons and downtime type](docs/screenshots/0.3.0/09-asset-change-status.png)
- [Location detail with address, map link and tabs](docs/screenshots/0.3.0/10-location.png)
- [Meter chart with warning and alarm bands](docs/screenshots/0.3.0/11-meter-chart.png)
- [Meters list with overdue readings](docs/screenshots/0.3.0/12-meters.png)
- [QR codes: blank batches, assign, retire](docs/screenshots/0.3.0/13-qr-codes.png)
- [Scan a code (camera, typed code, or photo)](docs/screenshots/0.3.0/14-scan.png)
- [Asset task list on a work order](docs/screenshots/0.3.0/15-wo-asset-tasks.png)
- [Work order form: asset and location, clear (×) on dates](docs/screenshots/0.3.0/16-wo-form-asset-clear-date.png)
- [Workload: filters apply, weekly totals per person](docs/screenshots/0.3.0/17-workload-totals.png)
- [Create menu: one-tap templates](docs/screenshots/0.3.0/18-create-menu-templates.png)
- [Settings → Assets and locations](docs/screenshots/0.3.0/19-asset-settings.png)
- [Dark theme](docs/screenshots/0.3.0/20-dark-asset.png)
- [Phone: assets](docs/screenshots/0.3.0/21-phone-assets.png)
- [Phone: record a meter reading](docs/screenshots/0.3.0/22-phone-meter-reading.png)
- [Phone: scan](docs/screenshots/0.3.0/23-phone-scan.png)
