"""0.6.0: Work requests, request portals, guest role (F1).

Hand-written; keep render_as_batch-friendly ops (SQLite and PostgreSQL). Name constraints with op.f(...).

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-26

"""
from alembic import op  # noqa: F401
import sqlalchemy as sa  # noqa: F401


revision = '0006'
down_revision = '0005'
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
