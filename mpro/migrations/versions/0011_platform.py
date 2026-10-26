"""0.6.0: Parts changes, floor plan labels, vendor PO acknowledgment (F6).

Hand-written; keep render_as_batch-friendly ops (SQLite and PostgreSQL). Name constraints with op.f(...).

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-26

"""
from alembic import op  # noqa: F401
import sqlalchemy as sa  # noqa: F401


revision = '0011'
down_revision = '0010'
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
