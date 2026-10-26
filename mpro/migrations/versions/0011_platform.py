"""0.6.0: Parts changes, floor plan labels, vendor PO acknowledgment (F6).

- MP-131: work-order part lines are Planned / Reserved / Used only (kitted and staged become reserved), and remember
  what Done used so reopening can put it back (done_from, done_used, shortfall).
- r261: purchase_order_vendor_links, the vendor's no-login link to acknowledge a sent PO.
Floor plan label styles (MP-132) live in the plan's shape JSON, so they need no schema change.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-26

"""
from alembic import op
import sqlalchemy as sa


revision = '0011'
down_revision = '0010'
branch_labels = None
depends_on = None


def normalize_part_statuses(conn):
    """Kitted and Staged were removed (MP-131): those lines become Reserved. Both counted as held, so the reserved
    totals on parts and stock rows stay the same."""
    conn.execute(sa.text("UPDATE work_order_parts SET status = 'reserved' WHERE status IN ('kitted', 'staged')"))


def upgrade():
    with op.batch_alter_table('work_order_parts', schema=None) as batch_op:
        batch_op.add_column(sa.Column('done_from', sa.String(length=12), nullable=True))
        batch_op.add_column(sa.Column('done_used', sa.Numeric(precision=18, scale=4), nullable=False, server_default='0'))
        batch_op.add_column(sa.Column('shortfall', sa.Numeric(precision=18, scale=4), nullable=False, server_default='0'))
    normalize_part_statuses(op.get_bind())

    op.create_table('purchase_order_vendor_links',
    sa.Column('purchase_order_id', sa.Uuid(), nullable=False),
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('status', sa.String(length=10), nullable=False),
    sa.Column('recipients', sa.JSON(), nullable=False),
    sa.Column('response', sa.String(length=16), nullable=False),
    sa.Column('responder_name', sa.String(length=200), nullable=False),
    sa.Column('proposed_date', sa.Date(), nullable=True),
    sa.Column('note', sa.Text(), nullable=False),
    sa.Column('responded_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_viewed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_by_id', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name=op.f('fk_purchase_order_vendor_links_created_by_id_users')),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_purchase_order_vendor_links_org_id_organizations')),
    sa.ForeignKeyConstraint(['purchase_order_id'], ['purchase_orders.id'], name=op.f('fk_purchase_order_vendor_links_purchase_order_id_purchase_orders')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_purchase_order_vendor_links')),
    sa.UniqueConstraint('token_hash', name=op.f('uq_purchase_order_vendor_links_token_hash'))
    )
    with op.batch_alter_table('purchase_order_vendor_links', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_purchase_order_vendor_links_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_purchase_order_vendor_links_purchase_order_id'), ['purchase_order_id'], unique=False)


def downgrade():
    with op.batch_alter_table('purchase_order_vendor_links', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_purchase_order_vendor_links_purchase_order_id'))
        batch_op.drop_index(batch_op.f('ix_purchase_order_vendor_links_org_id'))
    op.drop_table('purchase_order_vendor_links')
    with op.batch_alter_table('work_order_parts', schema=None) as batch_op:
        batch_op.drop_column('shortfall')
        batch_op.drop_column('done_used')
        batch_op.drop_column('done_from')
