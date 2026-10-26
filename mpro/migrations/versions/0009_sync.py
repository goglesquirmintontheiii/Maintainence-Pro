"""0.6.0: Offline sync: mutation log, timers (F4).

Hand-written; keep render_as_batch-friendly ops (SQLite and PostgreSQL). Name constraints with op.f(...).

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-26

"""
from alembic import op  # noqa: F401
import sqlalchemy as sa  # noqa: F401


revision = '0009'
down_revision = '0008'
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
