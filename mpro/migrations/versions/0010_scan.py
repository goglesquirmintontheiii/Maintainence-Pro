"""0.6.0: Scan actions, check-ins and scan history (F5).

Hand-written; keep render_as_batch-friendly ops (SQLite and PostgreSQL). Name constraints with op.f(...).

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-26

"""
from alembic import op  # noqa: F401
import sqlalchemy as sa  # noqa: F401


revision = '0010'
down_revision = '0009'
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
