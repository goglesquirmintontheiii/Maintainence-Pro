# MPro 0.6.0 — Requests, messaging & notifications

**Status: released 2026-10-26** · Checklist milestone 0.6.0

Bring in the rest of the organization: work requests and request portals, real-time messaging, notifications and
the offline-capable phone app. Introduces the realtime service and the sync protocol. Also the changes requested
while testing 0.5.

## Task list

### Requests
- [x] **MP-047** Work requests: title, description, priority, location, asset, photos and team routing (with
  "Other" to every admin), fields Optional / Required / Hidden, custom fields; approve into a work order (optionally
  from a template), decline with a reason the requester sees, duplicate, cancel, comments, search by keyword or
  request / work order number, a badge for new requests; the request follows its work order's status
- [x] **MP-048** Public request portals (no login): as many as you like, each with its own link and QR code,
  limited to a location or asset if wanted, photo uploads, a status link and opt-in emails for the person who
  reported it; scanning an asset or location sticker without signing in opens the right portal

### Messaging
- [x] **MP-049** Direct, group and team chats, the All Team conversation, a thread on every work order, threads with
  their own notification level, files, @mentions, reactions, edit and delete, permalinks, search, announcements with
  "I've read this", read receipts, create a work order from a message, team assignments posted in the team chat,
  and Message buttons on people and teams. Everything updates live

### Notifications
- [x] **MP-050** In-app bell and inbox, email and phone push for assignments, status changes, comments, mentions,
  due soon, overdue, requests, purchase orders and messages; per-person channels, digests (instant, hourly, daily),
  quiet hours and pause; a weekly report email and email branding
- [x] **MP-051** Web push on phones and computers, opt in per device (signed out devices stop receiving)
- [x] **MP-052** Escalation rules for overdue or not-started work, by priority and category, to people, teams or
  admins, optionally raising the priority

### Phone app
- [x] **MP-053** Installable app (manifest, offline app shell, update prompt); work orders assigned to you and your
  teams are kept on the phone and can be completed offline (status, procedures, comments, time, parts), with a
  pending-sync badge, conflict handling and safe replays; timers with pause and resume, photo mark-up, the phone
  Overview with shortcuts, switch organization, and delete my account
- [x] **MP-097** What scanning a code does, per record type and role; check-ins and scan history as proof of visit;
  "require a scan" to start or complete a procedure's work; scan to add an asset or location to a work order;
  public scans that only ever open the request form

### Requests from testing 0.5
- [x] **MP-131** Parts on work orders are Planned, Reserved or Used (Kitted and Staged became Reserved); Done uses up
  Planned and Reserved parts and flags any shortfall without blocking; reopening returns exactly what Done took;
  part pictures
- [x] **MP-132** Floor plan text labels: font, bold, italic, outline colour and width
- [x] **MP-133** User ID on the profile page (and on each person's page for admins)
- [x] **MP-134** Choose the server address and port at startup (`--host` / `--port`, `MPRO_HOST` / `MPRO_PORT`, and
  a prompt in the test builds that's remembered)
- [x] **MP-135** `mpro sysadmin add | remove | list`
- [x] **MP-136** MPro Management for sysadmins: Server Settings, API Keys, User Database and Management, Org
  Database and Management, audit log (Billing is MP-137 in 1.1.0)

### Also on the 0.6.0 roadmap (done)
- Guest user role (r236), customer request portals (r265) and vendor PO acknowledgment by link (r261)
- Live updates across the app (r269) and the sync protocol (r270)

### Moved to later versions
- **1.1.0:** in-app support chat (r320); MPro Management Billing (MP-137)
- **1.2.0:** AI work requests (r281), voice notes (r317), AI request triage (r606)
- **1.3.0:** SMS and WhatsApp request intake (r604)

## Notes
- **Security review** before release (two independent reviews) found and fixed, among others: an organization admin
  could read a sysadmin's password-reset link in the Email outbox (sign-in-free links are now hidden there and only
  the organization's own emails are listed); message notifications reached people who had lost access to the
  conversation; account deletion could remove the last sysadmin and left push subscriptions behind; push survived
  sign-out; a wrong sysadmin password still saved other changes; the demo admin could become a real server's
  sysadmin; two "Done" at once recorded the completion twice; pictures could be any image in the organization; a
  password change didn't end other sessions; a burst of bulk edits could stall live updates; portal photo uploads
  blocked the submission; guests could file requests against assets outside their sites; "require a scan" could be
  met without a real code.
- **Sign in again after upgrading:** changing a password now ends other sessions, so existing sessions end once.
- **Sysadmins:** on an upgraded server the owner of the oldest organization becomes the first sysadmin; on a new one,
  the first `mpro create-admin`. The test builds make the demo admin a sysadmin.
- **New settings:** `MPRO_HOST`, `MPRO_PORT`, `MPRO_REALTIME_MAX_STREAMS` (16), `MPRO_REALTIME_STREAMS_PER_USER` (6),
  `MPRO_REALTIME_STREAM_SECONDS` (300), `MPRO_PUBLIC_UPLOAD_MB` (15), `MPRO_PUSH_HOSTS`, `MPRO_PUSH_SUBJECT`.
  `mpro serve` now runs 32 threads.
- **No new dependencies.** Web push is built on `cryptography`.
- **Known limits:** real push delivery is tested against a stand-in only; offline mode can't create work orders or
  add files yet; anyone who can view a record can read its QR code value and "scan" it remotely (hiding code values
  is on the roadmap); message search uses simple matching rather than full-text search; deleted organizations are
  only soft-deleted.
- **Checks:** backend tests on SQLite and PostgreSQL, browser tests, ruff, mypy, TypeScript, `pip-audit` and
  `npm audit` with no known vulnerabilities.

## Screenshots

- [Overview with the 0.6.0 additions](docs/screenshots/0.6.0/01-overview.png)
- [Requests](docs/screenshots/0.6.0/02-requests.png)
- [Request from a portal](docs/screenshots/0.6.0/03-request-detail.png)
- [Approve: the request becomes a work order](docs/screenshots/0.6.0/04-approve.png)
- [Decline with a reason the requester sees](docs/screenshots/0.6.0/05-decline.png)
- [New request](docs/screenshots/0.6.0/06-new-request.png)
- [Settings: request form fields and routing](docs/screenshots/0.6.0/07-request-settings.png)
- [Settings: request portals and guests](docs/screenshots/0.6.0/08-request-settings-full.png)
- [The notification bell](docs/screenshots/0.6.0/09-bell.png)
- [Notifications inbox](docs/screenshots/0.6.0/10-notifications.png)
- [Notification settings: channels, quiet hours, pause](docs/screenshots/0.6.0/11-notification-settings.png)
- [Settings: due dates, escalation rules, weekly report, email branding](docs/screenshots/0.6.0/12-escalation-rules.png)
- [Messages](docs/screenshots/0.6.0/13-messages.png)
- [Direct message with read receipts](docs/screenshots/0.6.0/14-direct-message.png)
- [All Team announcement with confirmations](docs/screenshots/0.6.0/15-announcement.png)
- [Work order (live updates)](docs/screenshots/0.6.0/16-work-order-visits-parts.png)
- [Work order with visits and parts](docs/screenshots/0.6.0/17-work-order-full.png)
- [Part picture](docs/screenshots/0.6.0/18-part-picture.png)
- [Profile with the user ID](docs/screenshots/0.6.0/19-profile-user-id.png)
- [Location page](docs/screenshots/0.6.0/20-floor-plan.png)
- [Settings: what scanning does](docs/screenshots/0.6.0/21-scan-settings.png)
- [Scan history (proof of visit)](docs/screenshots/0.6.0/22-scan-history.png)
- [Purchase order sent to the vendor](docs/screenshots/0.6.0/23-po-vendor-answer.png)
- [MPro Management](docs/screenshots/0.6.0/24-management-overview.png)
- [MPro Management: Server Settings](docs/screenshots/0.6.0/25-management-server-settings.png)
- [MPro Management: API Keys](docs/screenshots/0.6.0/26-management-api-keys.png)
- [MPro Management: User Database](docs/screenshots/0.6.0/27-management-user-database.png)
- [MPro Management: Org Database](docs/screenshots/0.6.0/28-management-org-database.png)
- [MPro Management: User Management](docs/screenshots/0.6.0/29-management-user.png)
- [MPro Management: Org Management](docs/screenshots/0.6.0/30-management-org.png)
- [Public request portal (no login)](docs/screenshots/0.6.0/31-public-portal.png)
- [Request status link (no login)](docs/screenshots/0.6.0/32-request-status-link.png)
- [Vendor's purchase order page (no login)](docs/screenshots/0.6.0/33-vendor-po-link.png)
- [Phone: Overview with shortcuts and tiles](docs/screenshots/0.6.0/34-phone-overview.png)
- [Phone: Requests](docs/screenshots/0.6.0/35-phone-requests.png)
- [Phone: Messages](docs/screenshots/0.6.0/36-phone-messages.png)
- [Phone: conversation](docs/screenshots/0.6.0/37-phone-conversation.png)
- [Phone: what to do after scanning an asset](docs/screenshots/0.6.0/38-phone-scan-actions.png)
- [Phone: work order](docs/screenshots/0.6.0/39-phone-work-order.png)
- [Phone: offline, changes saved on the device](docs/screenshots/0.6.0/40-phone-offline.png)
- [Phone: notifications](docs/screenshots/0.6.0/41-phone-notifications.png)
