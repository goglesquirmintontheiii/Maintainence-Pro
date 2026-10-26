"""0.6.0: Scan actions, check-ins and scan history (F5, MP-097).

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
    op.create_table('scan_events',
    sa.Column('user_id', sa.Uuid(), nullable=True),
    sa.Column('code_id', sa.Uuid(), nullable=True),
    sa.Column('entity_type', sa.String(length=20), nullable=False),
    sa.Column('entity_id', sa.Uuid(), nullable=False),
    sa.Column('entity_label', sa.String(length=300), nullable=False),
    sa.Column('action', sa.String(length=20), nullable=False),
    sa.Column('work_order_id', sa.Uuid(), nullable=True),
    sa.Column('source', sa.String(length=12), nullable=False),
    sa.Column('latitude', sa.Numeric(precision=9, scale=6), nullable=True),
    sa.Column('longitude', sa.Numeric(precision=9, scale=6), nullable=True),
    sa.Column('accuracy_m', sa.Integer(), nullable=True),
    sa.Column('scanned_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('client_id', sa.String(length=64), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_scan_events_user_id_users')),
    sa.ForeignKeyConstraint(['code_id'], ['qr_codes.id'], name=op.f('fk_scan_events_code_id_qr_codes')),
    sa.ForeignKeyConstraint(['work_order_id'], ['work_orders.id'], name=op.f('fk_scan_events_work_order_id_work_orders')),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_scan_events_org_id_organizations')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_scan_events')),
    sa.UniqueConstraint('org_id', 'user_id', 'client_id', name='uq_scan_events_org_user_client'),
    )
    with op.batch_alter_table('scan_events', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_scan_events_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_scan_events_user_id'), ['user_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_scan_events_work_order_id'), ['work_order_id'], unique=False)
        batch_op.create_index('ix_scan_events_org_entity', ['org_id', 'entity_type', 'entity_id', 'scanned_at'], unique=False)

    op.create_table('scan_requirements',
    sa.Column('procedure_id', sa.Uuid(), nullable=False),
    sa.Column('on_start', sa.Boolean(), nullable=False),
    sa.Column('on_complete', sa.Boolean(), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['procedure_id'], ['procedures.id'], name=op.f('fk_scan_requirements_procedure_id_procedures')),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_scan_requirements_org_id_organizations')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_scan_requirements')),
    sa.UniqueConstraint('org_id', 'procedure_id', name='uq_scan_requirements_procedure'),
    )
    with op.batch_alter_table('scan_requirements', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_scan_requirements_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_scan_requirements_procedure_id'), ['procedure_id'], unique=False)

    op.create_table('public_scan_hits',
    sa.Column('ip_hash', sa.String(length=64), nullable=False),
    sa.Column('ok', sa.Boolean(), nullable=False),
    sa.Column('at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_public_scan_hits')),
    )
    with op.batch_alter_table('public_scan_hits', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_public_scan_hits_ip_hash'), ['ip_hash'], unique=False)
        batch_op.create_index(batch_op.f('ix_public_scan_hits_at'), ['at'], unique=False)


def downgrade():
    with op.batch_alter_table('public_scan_hits', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_public_scan_hits_at'))
        batch_op.drop_index(batch_op.f('ix_public_scan_hits_ip_hash'))
    op.drop_table('public_scan_hits')
    with op.batch_alter_table('scan_requirements', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_scan_requirements_procedure_id'))
        batch_op.drop_index(batch_op.f('ix_scan_requirements_org_id'))
    op.drop_table('scan_requirements')
    with op.batch_alter_table('scan_events', schema=None) as batch_op:
        batch_op.drop_index('ix_scan_events_org_entity')
        batch_op.drop_index(batch_op.f('ix_scan_events_work_order_id'))
        batch_op.drop_index(batch_op.f('ix_scan_events_user_id'))
        batch_op.drop_index(batch_op.f('ix_scan_events_org_id'))
    op.drop_table('scan_events')
