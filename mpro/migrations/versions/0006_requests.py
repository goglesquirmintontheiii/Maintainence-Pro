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
    op.create_table('request_portal_hits',
    sa.Column('ip', sa.String(length=64), nullable=False),
    sa.Column('portal_id', sa.Uuid(), nullable=True),
    sa.Column('ok', sa.Boolean(), nullable=False),
    sa.Column('write', sa.Boolean(), nullable=False),
    sa.Column('kind', sa.String(length=10), nullable=False, server_default=''),
    sa.Column('at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_request_portal_hits'))
    )
    with op.batch_alter_table('request_portal_hits', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_request_portal_hits_at'), ['at'], unique=False)
        batch_op.create_index(batch_op.f('ix_request_portal_hits_ip'), ['ip'], unique=False)
        batch_op.create_index(batch_op.f('ix_request_portal_hits_portal_id'), ['portal_id'], unique=False)

    op.create_table('guest_access',
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('location_ids', sa.JSON(), nullable=False),
    sa.Column('customer_id', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['customer_id'], ['customers.id'], name=op.f('fk_guest_access_customer_id_customers')),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_guest_access_org_id_organizations')),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_guest_access_user_id_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_guest_access')),
    sa.UniqueConstraint('org_id', 'user_id', name='uq_guest_access_org_user')
    )
    with op.batch_alter_table('guest_access', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_guest_access_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_guest_access_user_id'), ['user_id'], unique=False)

    op.create_table('request_portals',
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('slug', sa.String(length=80), nullable=False),
    sa.Column('intro', sa.Text(), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('fields', sa.JSON(), nullable=False),
    sa.Column('custom_field_ids', sa.JSON(), nullable=False),
    sa.Column('location_id', sa.Uuid(), nullable=True),
    sa.Column('asset_id', sa.Uuid(), nullable=True),
    sa.Column('team_id', sa.Uuid(), nullable=True),
    sa.Column('customer_id', sa.Uuid(), nullable=True),
    sa.Column('require_email', sa.Boolean(), nullable=False),
    sa.Column('created_by_id', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['asset_id'], ['assets.id'], name=op.f('fk_request_portals_asset_id_assets')),
    sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name=op.f('fk_request_portals_created_by_id_users')),
    sa.ForeignKeyConstraint(['customer_id'], ['customers.id'], name=op.f('fk_request_portals_customer_id_customers')),
    sa.ForeignKeyConstraint(['location_id'], ['locations.id'], name=op.f('fk_request_portals_location_id_locations')),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_request_portals_org_id_organizations')),
    sa.ForeignKeyConstraint(['team_id'], ['teams.id'], name=op.f('fk_request_portals_team_id_teams')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_request_portals'))
    )
    with op.batch_alter_table('request_portals', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_request_portals_customer_id'), ['customer_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_request_portals_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_request_portals_slug'), ['slug'], unique=True)

    op.create_table('work_requests',
    sa.Column('number', sa.Integer(), nullable=False),
    sa.Column('title', sa.String(length=255), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('priority', sa.String(length=10), nullable=False),
    sa.Column('status', sa.String(length=12), nullable=False),
    sa.Column('location_id', sa.Uuid(), nullable=True),
    sa.Column('asset_id', sa.Uuid(), nullable=True),
    sa.Column('asset_status', sa.String(length=16), nullable=False),
    sa.Column('team_id', sa.Uuid(), nullable=True),
    sa.Column('route_other', sa.Boolean(), nullable=False),
    sa.Column('custom', sa.JSON(), nullable=False),
    sa.Column('source', sa.String(length=10), nullable=False),
    sa.Column('created_by_id', sa.Uuid(), nullable=True),
    sa.Column('portal_id', sa.Uuid(), nullable=True),
    sa.Column('customer_id', sa.Uuid(), nullable=True),
    sa.Column('submitter_name', sa.String(length=200), nullable=False),
    sa.Column('submitter_email', sa.String(length=320), nullable=False),
    sa.Column('submitter_phone', sa.String(length=60), nullable=False),
    sa.Column('notify_email', sa.Boolean(), nullable=False),
    sa.Column('status_token_hash', sa.String(length=64), nullable=False),
    sa.Column('work_order_id', sa.Uuid(), nullable=True),
    sa.Column('decided_by_id', sa.Uuid(), nullable=True),
    sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('decline_reason', sa.Text(), nullable=False),
    sa.Column('seen_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('status_changed_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['asset_id'], ['assets.id'], name=op.f('fk_work_requests_asset_id_assets')),
    sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name=op.f('fk_work_requests_created_by_id_users')),
    sa.ForeignKeyConstraint(['customer_id'], ['customers.id'], name=op.f('fk_work_requests_customer_id_customers')),
    sa.ForeignKeyConstraint(['decided_by_id'], ['users.id'], name=op.f('fk_work_requests_decided_by_id_users')),
    sa.ForeignKeyConstraint(['location_id'], ['locations.id'], name=op.f('fk_work_requests_location_id_locations')),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_work_requests_org_id_organizations')),
    sa.ForeignKeyConstraint(['portal_id'], ['request_portals.id'], name=op.f('fk_work_requests_portal_id_request_portals')),
    sa.ForeignKeyConstraint(['team_id'], ['teams.id'], name=op.f('fk_work_requests_team_id_teams')),
    sa.ForeignKeyConstraint(['work_order_id'], ['work_orders.id'], name=op.f('fk_work_requests_work_order_id_work_orders')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_work_requests')),
    sa.UniqueConstraint('org_id', 'number', name='uq_work_requests_org_number')
    )
    with op.batch_alter_table('work_requests', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_work_requests_asset_id'), ['asset_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_work_requests_created_by_id'), ['created_by_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_work_requests_customer_id'), ['customer_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_work_requests_location_id'), ['location_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_work_requests_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_work_requests_portal_id'), ['portal_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_work_requests_status'), ['status'], unique=False)
        batch_op.create_index(batch_op.f('ix_work_requests_status_token_hash'), ['status_token_hash'], unique=False)
        batch_op.create_index(batch_op.f('ix_work_requests_team_id'), ['team_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_work_requests_work_order_id'), ['work_order_id'], unique=False)


def downgrade():
    op.drop_table('work_requests')
    op.drop_table('request_portals')
    op.drop_table('guest_access')
    op.drop_table('request_portal_hits')
