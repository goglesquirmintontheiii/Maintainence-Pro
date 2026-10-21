<p align="center"><img src="docs/brand/banner.png" alt="Maintenance Pro: self-hosted maintenance management" width="100%"></p>

# Maintenance Pro (MPro)

**Self-hosted maintenance management.** Work orders, assets, preventive maintenance and parts on your own
servers, in a layout your team already knows from MaintainX, plus an importer to bring your MaintainX data
across. Every core feature, no plan limits.

> **Status: early development (0.1.0).** This release is the foundation: sign-in, organizations, roles,
> Teams & Users, global search, the audit log and the MaintainX-style app shell. Work orders arrive in 0.2.0.
> See [progress.md](progress.md) for what's in this version.

![Teams & Users](docs/screenshots/0.1.0/03-teams-users.png)

## Try it

**Test builds (no setup):** download `MaintenancePro-<version>-windows-x64.exe` or
`MaintenancePro-<version>-x86_64.AppImage` from [Releases](../../releases), run it, and your browser opens
with a demo organization. Sign in as `admin@example.com` / `mpro-demo-123`. Data stays in a local SQLite file.
Test builds are for trying MPro, not for real use.

**From source (Linux / macOS):**

```bash
git clone https://github.com/goglesquirmintontheiii/Maintainence-Pro.git
cd Maintainence-Pro
./start.sh --demo        # installs Python + packages, builds the web app, opens on http://localhost:8080
```

`start.sh` needs `curl` and Node.js 20+ the first time (to build the web app). It uses SQLite by default; set
`DATABASE_URL` to use PostgreSQL. A guided first-run setup (plain-English questions, service install,
backups) arrives in 1.0.0.

**Docker (PostgreSQL included):**

```bash
docker compose up -d
docker compose exec app mpro create-admin --email you@example.com --name "Your Name" --org "Your Company"
```

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | SQLite in the data folder | PostgreSQL in production, e.g. `postgresql://user:pass@host/mpro` |
| `MPRO_DATA_DIR` | your user data folder | Where the secret key, SQLite file and uploads live |
| `MPRO_BASE_URL` | `http://localhost:8080` | Used in email links |
| `MPRO_SECRET_KEY` | generated on first run | Session signing key |
| `MPRO_SMTP_HOST`, `MPRO_SMTP_PORT`, `MPRO_SMTP_USER`, `MPRO_SMTP_PASSWORD`, `MPRO_MAIL_FROM` | not set | Send real email. Without them, emails wait in Settings → Email outbox |

The REST API is documented at `/api/docs` on any running server.

## Editions

- **Self-hosted** (this repository): one machine, PostgreSQL (or SQLite for testing), every core feature.
- **MPro Cloud** (planned, 1.1.0+): hosted, multi-region and scalable, with Free / Pro / Expert plans.
  It shares this codebase for now and moves to its own private repository later.

## Development

See [CLAUDE.md](CLAUDE.md) for the layout and commands, and [docs/GUIDELINES.md](docs/GUIDELINES.md) for
the project rules. CI runs lint, type checks, tests on SQLite and PostgreSQL, browser tests, a dependency
audit and a Docker build on every push.

## License

Maintenance Pro is **source-available** under the [Maintenance Pro Source-Available License](LICENSE).
It is not open source in the OSI sense. In short:

- **You can** read the code, run it to manage your own organization's maintenance (businesses included),
  modify it for your own use, and contribute through GitHub forks and pull requests.
- **You can't** redistribute it, rebrand it or pass it off as your own, sell it or access to it, host it for
  others, or build a competing product from it.

The names and logos are covered by [TRADEMARKS.md](TRADEMARKS.md). Contributions are accepted under the
CLA in [CONTRIBUTING.md](CONTRIBUTING.md). Some features may become MPro Cloud–only in future versions.
