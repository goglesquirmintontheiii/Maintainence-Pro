"""Command line: `mpro serve | worker | migrate | seed-demo | create-admin | desktop`."""

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
        db.session.commit()


def main(argv: list[str] | None = None) -> Any:
    p = argparse.ArgumentParser(prog="mpro", description="Maintenance Pro")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("serve", help="Run the web server (and an in-process worker unless --no-worker)")
    s.add_argument("--host", default="0.0.0.0")
    s.add_argument("--port", type=int, default=8080)
    s.add_argument("--no-worker", action="store_true")
    s.add_argument("--threads", type=int, default=8)
    sub.add_parser("worker", help="Run background jobs")
    sub.add_parser("migrate", help="Create or upgrade the database")
    d = sub.add_parser("seed-demo", help="Create the demo organization")
    d.add_argument("--password", default=None)
    a = sub.add_parser("create-admin", help="Create an organization and its first administrator")
    a.add_argument("--email", required=True)
    a.add_argument("--name", required=True)
    a.add_argument("--org", required=True)
    dk = sub.add_parser("desktop", help="Test build: local server with demo data, opens the browser")
    dk.add_argument("--port", type=int, default=0)
    dk.add_argument("--no-browser", action="store_true")
    args = p.parse_args(argv)

    if args.cmd == "desktop":
        from mpro.desktop import run_desktop

        return run_desktop(port=args.port, open_browser=not args.no_browser)

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
    elif args.cmd == "worker":
        from mpro.core.jobs import worker_loop

        worker_loop(app)
    elif args.cmd == "serve":
        from waitress import serve

        upgrade_db(app)
        if not args.no_worker:
            from mpro.core.jobs import start_background_worker

            start_background_worker(app)
        log.info("Maintenance Pro listening on http://%s:%s", args.host, args.port)
        serve(app, host=args.host, port=args.port, threads=args.threads)
    else:
        p.print_help()
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
