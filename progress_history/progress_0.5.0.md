# MPro 0.5.0 — Parts, purchasing & vendors

**Status: released 2026-10-23** · Checklist milestone 0.5.0

Inventory as a ledger, purchase orders with approvals, vendors and customers, supplier product links, and purchasing
finance (tax exemption certificates, receipts, vendor and customer invoices). Parts plug into work orders (0.2) and
assets (0.3). Also the changes requested while testing 0.4.

## Task list

### Parts & inventory
- [x] **MP-039** Parts catalogue: name, number, description, cost, photo, part types, areas/bins, linked assets,
  vendors and teams, QR/barcode, custom fields, non-stock parts, duplicate warning
- [x] **MP-040** Stock per location with minimums, Needs Restock trigger, restock/adjust/transfer with reasons,
  critical parts and escalation emails, reservations (assigned, reserved, kitted, staged, issued)
- [x] **MP-041** Transactions ledger (stock is the sum of transactions), linked to work orders and POs, moving-average
  cost (optional), valuation and slow-moving reports, cycle counts that run as work orders

### Purchase orders
- [x] **MP-042** Requested → Approved/Declined → Sent → Partially fulfilled → Completed/Canceled; part and free-text lines,
  taxes and extra costs, addresses, budgets, approval rules (amount, location, vendor, category, custom fields), partial
  receiving, re-approval when an approved PO is raised, comments, files, duplicate/cancel/undo completion
- [x] **MP-043** Branded PO PDF, emailed to the vendor's PO contacts with the PDF attached (and CC addresses)
- [x] **MP-044** Low-stock suggestions per preferred vendor, raised as POs in one click; "Order this part" from a part

### Vendors & customers
- [x] **MP-045** Vendors with types, colour, contacts, documents, linked parts, assets, locations and POs
- [x] **MP-046** Customers with billing details, contacts, locations, assets, quotes (public approval link), and work
  orders linked to a customer

### Supplier product links
- [x] **MP-084** Paste a supplier URL on a part, asset or PO line; 23 suppliers recognised, more can be added
- [x] **MP-085** Product cards fetched on the server (JSON-LD, Open Graph, title), cached, refreshed daily, images
  stored locally, "may have changed" after 24 h; fetches pinned to the checked address (no DNS rebinding)
- [x] **MP-086** Amazon Creators API and McMaster-Carr Product Information API connectors (not yet tried against live
  accounts; "Test connection" checks them once you add yours)
- [x] **MP-087** Price history, alerts on price change / out of stock / discontinued, supplier comparison, replacements
- [x] **MP-088** Reorder from cards and low-stock alerts, product to PO line, cXML/OCI PunchOut carts come back as
  requested POs, receiving updates the last paid price
- [x] **MP-089** "Purchased from" on assets and a Spare Parts tab with product cards and stock

### Purchasing & finance
- [x] **MP-090** Tax exemption certificates with expiry checks, sites and vendors, encrypted scans, an access log, and a
  watermarked exemption card for technicians at the counter; exemptions applied to POs automatically
- [x] **MP-091** Receipts from the phone camera (multi-page, crop and straighten), upload or email-in; read on the
  device, confirmed by a person; matched to work orders, POs, restocks or expenses; tax reclaim and reimbursements
- [x] **MP-092** Vendor invoices with 3-way match, tolerances, exceptions queue, approval rules, early-payment terms,
  disputes, credit notes and payments
- [x] **MP-093** Customer invoices from completed work orders (labour at billing rates, parts with markup, costs at the
  price when used), customer exemptions, PDF and email, statuses, credit notes, statements, a work order billed once.
  Online payment (Stripe) is an interface only, for MPro Cloud later
- [x] **MP-094** Documents vault with search, retention (reported, never auto-deleted) and legal hold, read-only once
  approved, monthly accountant ZIP and CSV for QuickBooks Online, Xero, NetSuite and Sage

### Requests from testing 0.4
- [x] **MP-121** Floor plan discard dialog readable, Priority control background, meter reading time field, asset
  pictures refresh in the list (each with a test)
- [x] **MP-122** Number fields can be emptied while typing, "Website design" tab, new test-build banner with the real
  database path, meter chart 2 yr and Custom range
- [x] **MP-123** Custom colour button in every colour picker (field, hue, hex, recent colours, readable text)
- [x] **MP-124** Several assets on one work order, everywhere work orders appear; `asset_id` and `asset_ids` in the API
- [x] **MP-125** Upcoming tab: open work orders and planned PMs for 7–90 days or a custom number, grouped by day
- [x] **MP-126** MaintainX-style phone layout for Work Orders and Assets
- [x] **MP-127** Drag and drop files everywhere files can be added (one shared drop zone)
- [x] **MP-128** Floor plan Merge as a true union with holes (undoable), parts lists on plans, pinch-zoom and pan
- [x] **MP-129** Automation tree view on the automation page and in the editor
- [x] **MP-130** Own vs any permissions for custom roles (work orders, assets, procedures, POs), enforced in the API

### Also on the 0.5.0 roadmap (done)
- External work orders shared by link with hidden / view / interact fields, link controls, "Shared externally"
  filter, completion notice (r058–r060, r088, r092); vendors on work orders (r075); emailing the work order PDF to
  vendors (r094); Asset Hub packages (r115); completion side effects (r042)
- The Create menu now also creates a part, purchase order, vendor or customer

### Moved to later versions
- **0.6.0:** Message button on users and teams (r655), Guest user role (r236), customer request portal (r265),
  vendor portal / PO acknowledgment (r261)
- **0.9.0:** Part sharing between organizations (r224) and its escalation teams (r246); ABC analysis (r600),
  alternate parts (r601), vendor scorecards (r602)
- **1.2.0:** AI readers for receipts, invoices and certificates (the on-device reader ships now)

## Notes
- **Security review** before release found and fixed: a voided invoice could still be approved and overpaid; an
  approved PO could be raised without re-approval; PunchOut carts arrived approved; attaching a receipt twice restocked
  twice; credit notes could exceed the invoice; a work order could be billed twice; a paid reimbursement could be
  re-requested; DNS rebinding in the product fetcher; races in receiving and counts (row locks now); email-in trusted a
  forged From header (now a per-org secret address plus DKIM check); part costs used today's price instead of the price
  when used; requesters could set costs and budgets on new POs. Outsiders on a shared work order now see @mentions as
  names only.
- New settings: `MPRO_TRUSTED_PROXIES` (number of reverse proxies in front of MPro, for client IPs in logs and rate
  limits) and `MPRO_ALLOW_PRIVATE_MAIL_HOSTS` (lets email-in and connectors reach private addresses; off by default).
- New dependencies: `cryptography` (encrypted certificate scans and connector secrets) and `polygon-clipping` 0.15.7
  (MIT, floor plan Merge).
- Known limits: supplier API connectors are untested against real accounts; installing an asset package isn't atomic
  but can be re-run safely; floor plan parts lists don't show on the small location card picture.
- Checks: backend tests on SQLite and PostgreSQL, browser tests, ruff, mypy, TypeScript, `pip-audit` and `npm audit`
  with no known vulnerabilities.

## Screenshots

- [Overview with the 0.5.0 additions and the new test-build banner](docs/screenshots/0.5.0/01-overview-test-build.png)
- [Parts & Inventory](docs/screenshots/0.5.0/02-parts.png)
- [Part: stock per location, reserved, on order and value](docs/screenshots/0.5.0/03-part-detail.png)
- [Part: details, vendors, supplier products, codes and files](docs/screenshots/0.5.0/04-part-detail-full.png)
- [Cycle counts](docs/screenshots/0.5.0/05-cycle-counts.png)
- [Part transactions log](docs/screenshots/0.5.0/06-part-transactions.png)
- [Settings: Parts and inventory](docs/screenshots/0.5.0/07-parts-settings.png)
- [Purchase Orders](docs/screenshots/0.5.0/08-purchase-orders.png)
- [Purchase order: partially fulfilled and overdue](docs/screenshots/0.5.0/09-purchase-order-detail.png)
- [Receiving items into stock](docs/screenshots/0.5.0/10-receive-items.png)
- [Settings: Purchase orders, addresses and approval rules](docs/screenshots/0.5.0/11-purchasing-settings.png)
- [Vendors](docs/screenshots/0.5.0/12-vendors.png)
- [Vendor with contacts and purchase orders](docs/screenshots/0.5.0/13-vendor-detail.png)
- [Customer with billing details, locations and quotes](docs/screenshots/0.5.0/14-customer-detail.png)
- [Supplier product cards on a part](docs/screenshots/0.5.0/15-supplier-product-cards.png)
- [Asset Spare Parts tab with product cards](docs/screenshots/0.5.0/16-asset-spare-parts.png)
- [Settings: Supplier connections and PunchOut](docs/screenshots/0.5.0/17-supplier-connections.png)
- [Finance: Receipts](docs/screenshots/0.5.0/18-finance-receipts.png)
- [Finance: Vendor invoices exceptions queue](docs/screenshots/0.5.0/19-finance-vendor-invoices.png)
- [Finance: Customer invoices](docs/screenshots/0.5.0/20-finance-customer-invoices.png)
- [Finance: Tax exemption certificates](docs/screenshots/0.5.0/21-finance-certificates.png)
- [Finance: Company cards](docs/screenshots/0.5.0/22-finance-cards.png)
- [Finance: Documents vault with legal hold](docs/screenshots/0.5.0/23-finance-documents.png)
- [Finance: Reports](docs/screenshots/0.5.0/24-finance-reports.png)
- [Vendor invoice 3-way match with exceptions](docs/screenshots/0.5.0/25-vendor-invoice-match.png)
- [Work order with parts, vendors and receipts](docs/screenshots/0.5.0/26-work-order-parts-vendors.png)
- [Work order shared outside the company by link](docs/screenshots/0.5.0/27-external-work-order.png)
- [To Do: Upcoming tab](docs/screenshots/0.5.0/28-upcoming.png)
- [New work order with several assets](docs/screenshots/0.5.0/29-work-order-form.png)
- [Asset Hub: asset packages](docs/screenshots/0.5.0/30-asset-hub.png)
- [Roles: own vs any permissions](docs/screenshots/0.5.0/31-roles-own-vs-any.png)
- [Custom colour in a colour picker](docs/screenshots/0.5.0/32-custom-colour.png)
- [Automation tree view](docs/screenshots/0.5.0/33-automation-tree.png)
- [Meter readings over 2 years](docs/screenshots/0.5.0/34-meter-two-years.png)
- [Phone: Work Orders](docs/screenshots/0.5.0/35-phone-work-orders.png)
- [Phone: Assets](docs/screenshots/0.5.0/36-phone-assets.png)
- [Phone: Parts](docs/screenshots/0.5.0/37-phone-parts.png)
- [Phone: Purchase Orders](docs/screenshots/0.5.0/38-phone-purchase-orders.png)
- [Phone: adding a receipt](docs/screenshots/0.5.0/39-phone-receipt-capture.png)
- [Phone: tax exemption card at the counter](docs/screenshots/0.5.0/40-phone-exemption-card.png)
- [Upcoming tab (MP-125)](docs/screenshots/0.5.0/mp125_upcoming.png)
- [Phone Work Orders header (MP-126)](docs/screenshots/0.5.0/mp126_wo_phone.png)
- [Phone Upcoming (MP-126)](docs/screenshots/0.5.0/mp126_wo_phone_upcoming.png)
- [Phone calendar (MP-126)](docs/screenshots/0.5.0/mp126_wo_phone_cal.png)
- [Phone Assets (MP-126)](docs/screenshots/0.5.0/mp126_assets_phone.png)
- [Phone Assets filter (MP-126)](docs/screenshots/0.5.0/mp126_assets_phone_filter.png)
- [Floor plan Merge and parts list (MP-128)](docs/screenshots/0.5.0/mp128_merge_parts.png)
- [Automation tree in the editor (MP-129)](docs/screenshots/0.5.0/mp129_automation_tree.png)
