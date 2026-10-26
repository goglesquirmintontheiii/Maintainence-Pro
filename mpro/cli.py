"""Command line: `mpro serve | worker | migrate | seed-demo | create-admin | sysadmin | desktop`."""

from __future__ import annotations

import argparse
import getpass
import logging
import sys
from typing import Any

import click
from flask import Flask

log = logging.getLogger("mpro")


def upgrade_db(app: Flask) -> None:
    from flask_migrate import upgrade

    with app.app_context():
        upgrade()


def register_flask_cli(app: Flask) -> None:
    @app.cli.command("seed-demo")
    def seed_demo_cmd() -> None:
        """Create the demo organization."""
        from mpro.demo import DEMO_EMAIL, DEMO_PASSWORD, seed_demo

        seed_demo()
        click.echo(f"Demo ready. Sign in as {DEMO_EMAIL} / {DEMO_PASSWORD}")

    @app.cli.command("worker")
    def worker_cmd() -> None:
        """Run background jobs."""
        from mpro.core.jobs import worker_loop

        worker_loop(app)


def _create_admin(app: Flask, email: str, name: str, org_name: str, password: str) -> None:
    from mpro.auth.models import User
    from mpro.auth.services import get_user_by_email, validate_password
    from mpro.extensions import db
    from mpro.orgs.services import create_org

    with app.app_context():
        validate_password(password)
        user = get_user_by_email(email)
        if user is None:
            user = User(email=email.strip().lower(), name=name)
            db.session.add(user)
        user.set_password(password)
        db.session.flush()
        create_org(org_name, user)
        from mpro.demo import DEMO_EMAIL
        from mpro.sysadmin.services import _active_sysadmins, make_first_sysadmin

        current = _active_sysadmins()
        if current and all(s.email == DEMO_EMAIL for s in current) and not user.is_sysadmin:
            # the only sysadmin is the demo account (public password): the real administrator takes over
            user.is_sysadmin = True
            print(
                f"Warning: the only sysadmin was the demo account {DEMO_EMAIL}, whose password is public. "
                f"{user.email} is now a sysadmin too; remove the demo one with `mpro sysadmin remove {DEMO_EMAIL}`.",
                file=sys.stderr,
            )
        elif make_first_sysadmin(user, "create-admin"):  # a new server's first administrator runs it (MP-135)
            print(f"{user.email} is this server's first sysadmin (see `mpro sysadmin --help`).")
        db.session.commit()


def _sysadmin(app: Flask, action: str, email: str | None, force: bool) -> int:
    from mpro.sysadmin import services as sa

    with app.app_context():
        try:
            if action == "list":
                people = sa.list_sysadmins()
                if not people:
                    print("This server has no sysadmins. Add one with: mpro sysadmin add EMAIL")
                for u in people:
                    state = "" if u.is_active else "  (locked)"
                    print(f"{u.email}\t{u.name}{state}")
                return 0
            if not email:
                print("Give the person's email, for example: mpro sysadmin add pat@example.com", file=sys.stderr)
                return 2
            if action == "add":
                u = sa.add_sysadmin(email)
                print(f"{u.email} is now a sysadmin. They'll see MPro Management in the organization menu.")
            else:
                u = sa.remove_sysadmin(email, force=force)
                print(f"{u.email} is no longer a sysadmin.")
                if not sa.has_sysadmin():
                    print("Warning: this server now has no sysadmins.", file=sys.stderr)
            return 0
        except sa.SysadminError as e:
            print(e.message, file=sys.stderr)
            return 1


def main(argv: list[str] | None = None) -> Any:
    p = argparse.ArgumentParser(prog="mpro", description="Maintenance Pro")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("serve", help="Run the web server (and an in-process worker unless --no-worker)")
    s.add_argument("--host", default=None, help="address to listen on (default: MPRO_HOST, server.json, 0.0.0.0)")
    s.add_argument("--port", type=int, default=None, help="port (default: MPRO_PORT, server.json, 8080)")
    s.add_argument("--no-worker", action="store_true")
    s.add_argument("--threads", type=int, default=32)
    sub.add_parser("worker", help="Run background jobs")
    sub.add_parser("migrate", help="Create or upgrade the database")
    d = sub.add_parser("seed-demo", help="Create the demo organization")
    d.add_argument("--password", default=None)
    a = sub.add_parser("create-admin", help="Create an organization and its first administrator")
    a.add_argument("--email", required=True)
    a.add_argument("--name", required=True)
    a.add_argument("--org", required=True)
    sa = sub.add_parser("sysadmin", help="Add, remove or list the people who run this MPro server")
    sa.add_argument("action", choices=["add", "remove", "list"])
    sa.add_argument("email", nargs="?")
    sa.add_argument("--force", action="store_true", help="allow removing the last sysadmin")
    dk = sub.add_parser("desktop", help="Test build: local server with demo data, opens the browser")
    dk.add_argument("--host", default=None)
    dk.add_argument("--port", type=int, default=0)
    dk.add_argument("--no-prompt", action="store_true", help="don't ask for the address and port")
    dk.add_argument("--no-browser", action="store_true")
    args = p.parse_args(argv)

    if args.cmd == "desktop":
        from mpro.desktop import run_desktop

        return run_desktop(port=args.port, open_browser=not args.no_browser, host=args.host, prompt=not args.no_prompt)

    from mpro.app import create_app

    app = create_app()
    if args.cmd == "migrate":
        upgrade_db(app)
        print("Database is up to date.")
    elif args.cmd == "seed-demo":
        from mpro.demo import DEMO_EMAIL, DEMO_PASSWORD, seed_demo

        upgrade_db(app)
        with app.app_context():
            seed_demo(args.password or DEMO_PASSWORD)
        print(f"Demo ready. Sign in as {DEMO_EMAIL} / {args.password or DEMO_PASSWORD}")
    elif args.cmd == "create-admin":
        pw = getpass.getpass("Password for the new administrator: ")
        _create_admin(app, args.email, args.name, args.org, pw)
        print("Administrator created.")
    elif args.cmd == "sysadmin":
        return _sysadmin(app, args.action, args.email, args.force)
    elif args.cmd == "worker":
        from mpro.core.jobs import worker_loop

        worker_loop(app)
    elif args.cmd == "serve":
        from waitress import serve

        from mpro.sysadmin.server_settings import SettingsError, is_everywhere, listen_address

        try:
            host, port = listen_address(app.config["MPRO_DATA_DIR"], args.host, args.port, default_host="0.0.0.0")
        except SettingsError as e:
            print(e, file=sys.stderr)
            return 2
        app.config["MPRO_LISTEN_HOST"], app.config["MPRO_LISTEN_PORT"] = host, port
        upgrade_db(app)
        if not args.no_worker:
            from mpro.core.jobs import start_background_worker

            start_background_worker(app)
        where = "every network on this computer" if is_everywhere(host) else host
        log.info("Maintenance Pro listening on port %s (%s)", port, where)
        serve(app, host=host, port=port, threads=args.threads)
    else:
        p.print_help()
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
