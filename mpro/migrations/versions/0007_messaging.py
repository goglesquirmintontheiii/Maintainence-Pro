"""0.6.0: Messaging and realtime (F2).

Hand-written; keep render_as_batch-friendly ops (SQLite and PostgreSQL). Name constraints with op.f(...).

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-26

"""
from alembic import op  # noqa: F401
import sqlalchemy as sa  # noqa: F401


revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
