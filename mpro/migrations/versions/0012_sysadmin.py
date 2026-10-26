"""0.6.0: Sysadmins and MPro Management (F7).

Hand-written; keep render_as_batch-friendly ops (SQLite and PostgreSQL). Name constraints with op.f(...).

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-26

"""
from alembic import op  # noqa: F401
import sqlalchemy as sa  # noqa: F401


revision = '0012'
down_revision = '0011'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('phone', sa.String(length=40), nullable=False, server_default=''))
        batch_op.add_column(sa.Column('is_sysadmin', sa.Boolean(), nullable=False, server_default=sa.false()))
    with op.batch_alter_table('organizations', schema=None) as batch_op:
        batch_op.add_column(sa.Column('email', sa.String(length=320), nullable=False, server_default=''))
    op.create_table('server_api_keys',
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('service', sa.String(length=40), nullable=False),
    sa.Column('secret', sa.Text(), nullable=False),
    sa.Column('last4', sa.String(length=8), nullable=False),
    sa.Column('note', sa.String(length=500), nullable=False),
    sa.Column('created_by_id', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name=op.f('fk_server_api_keys_created_by_id_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_server_api_keys'))
    )
    # MP-135: the first person who runs this server is a sysadmin. On an existing server that's the owner of
    # the oldest organization (who set MPro up); `mpro sysadmin add` changes it.
    conn = op.get_bind()
    row = conn.execute(sa.text(
        "SELECT m.user_id FROM memberships m JOIN organizations o ON o.id = m.org_id "
        "WHERE m.role = 'owner' AND m.deleted_at IS NULL AND o.deleted_at IS NULL "
        "ORDER BY o.created_at, m.created_at LIMIT 1"
    )).first()
    if row is not None:
        conn.execute(sa.text("UPDATE users SET is_sysadmin = :t WHERE id = :u"), {"t": True, "u": row[0]})


def downgrade():
    op.drop_table('server_api_keys')
    with op.batch_alter_table('organizations', schema=None) as batch_op:
        batch_op.drop_column('email')
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('is_sysadmin')
        batch_op.drop_column('phone')
