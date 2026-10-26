"""0.6.0: Notifications, push subscriptions, escalation rules (F3).

Hand-written; keep render_as_batch-friendly ops (SQLite and PostgreSQL). Name constraints with op.f(...).

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-26

"""
from alembic import op  # noqa: F401
import sqlalchemy as sa  # noqa: F401


revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
