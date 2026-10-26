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
    op.create_table(
        'idempotent_requests',
        sa.Column('org_id', sa.Uuid(), nullable=True),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('key', sa.String(length=100), nullable=False),
        sa.Column('method', sa.String(length=10), nullable=False),
        sa.Column('path', sa.String(length=500), nullable=False),
        sa.Column('status_code', sa.Integer(), nullable=False),
        sa.Column('response', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_idempotent_requests')),
        sa.UniqueConstraint('user_id', 'key', name='uq_idempotent_requests_user_key'),
    )
    with op.batch_alter_table('idempotent_requests', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_idempotent_requests_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_idempotent_requests_user_id'), ['user_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_idempotent_requests_created_at'), ['created_at'], unique=False)

    # timers can be paused and resumed (r090)
    with op.batch_alter_table('timers', schema=None) as batch_op:
        batch_op.add_column(sa.Column('paused_at', sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column('accumulated_seconds', sa.Integer(), server_default='0', nullable=False))


def downgrade():
    with op.batch_alter_table('timers', schema=None) as batch_op:
        batch_op.drop_column('accumulated_seconds')
        batch_op.drop_column('paused_at')
    with op.batch_alter_table('idempotent_requests', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_idempotent_requests_created_at'))
        batch_op.drop_index(batch_op.f('ix_idempotent_requests_user_id'))
        batch_op.drop_index(batch_op.f('ix_idempotent_requests_org_id'))
    op.drop_table('idempotent_requests')
