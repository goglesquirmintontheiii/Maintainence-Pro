"""0.6.0: Notifications, push subscriptions, escalation rules (F3).

Hand-written; keep render_as_batch-friendly ops (SQLite and PostgreSQL). Name constraints with op.f(...).

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-26

"""
from alembic import op
import sqlalchemy as sa


revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None


def _ts(name, nullable=False):
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade():
    op.create_table('notifications',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.String(length=40), nullable=False),
    sa.Column('category', sa.String(length=20), nullable=False),
    sa.Column('title', sa.String(length=300), nullable=False),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('link', sa.String(length=500), nullable=False),
    sa.Column('entity_type', sa.String(length=40), nullable=False),
    sa.Column('entity_id', sa.String(length=64), nullable=False),
    sa.Column('actor_id', sa.Uuid(), nullable=True),
    sa.Column('actor_label', sa.String(length=300), nullable=False),
    sa.Column('event_id', sa.Uuid(), nullable=True),
    sa.Column('in_app', sa.Boolean(), nullable=False),
    sa.Column('email_state', sa.String(length=10), nullable=False),
    sa.Column('push_state', sa.String(length=10), nullable=False),
    _ts('created_at'),
    _ts('read_at', True),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_notifications_org_id_organizations')),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_notifications_user_id_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_notifications')),
    sa.UniqueConstraint('event_id', 'user_id', 'kind', name='uq_notifications_event_user_kind'),
    )
    with op.batch_alter_table('notifications', schema=None) as b:
        b.create_index(b.f('ix_notifications_org_id'), ['org_id'], unique=False)
        b.create_index(b.f('ix_notifications_user_id'), ['user_id'], unique=False)
        b.create_index(b.f('ix_notifications_event_id'), ['event_id'], unique=False)
        b.create_index(b.f('ix_notifications_email_state'), ['email_state'], unique=False)
        b.create_index(b.f('ix_notifications_created_at'), ['created_at'], unique=False)
        b.create_index('ix_notifications_user_inbox', ['user_id', 'org_id', 'created_at'], unique=False)

    op.create_table('notification_prefs',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('prefs', sa.JSON(), nullable=False),
    _ts('paused_until', True),
    _ts('last_digest_at', True),
    _ts('created_at'),
    _ts('updated_at'),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_notification_prefs_org_id_organizations')),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_notification_prefs_user_id_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_notification_prefs')),
    sa.UniqueConstraint('org_id', 'user_id', name='uq_notification_prefs_org_user'),
    )
    with op.batch_alter_table('notification_prefs', schema=None) as b:
        b.create_index(b.f('ix_notification_prefs_org_id'), ['org_id'], unique=False)
        b.create_index(b.f('ix_notification_prefs_user_id'), ['user_id'], unique=False)

    op.create_table('push_subscriptions',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('endpoint', sa.String(length=1000), nullable=False),
    sa.Column('p256dh', sa.String(length=200), nullable=False),
    sa.Column('auth', sa.String(length=100), nullable=False),
    sa.Column('label', sa.String(length=200), nullable=False),
    _ts('created_at'),
    _ts('last_used_at', True),
    sa.Column('failures', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_push_subscriptions_user_id_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_push_subscriptions')),
    sa.UniqueConstraint('endpoint', name=op.f('uq_push_subscriptions_endpoint')),
    )
    with op.batch_alter_table('push_subscriptions', schema=None) as b:
        b.create_index(b.f('ix_push_subscriptions_user_id'), ['user_id'], unique=False)

    op.create_table('push_keys',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('public_key', sa.String(length=200), nullable=False),
    sa.Column('private_key', sa.Text(), nullable=False),
    _ts('created_at'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_push_keys')),
    )

    op.create_table('escalation_rules',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('trigger', sa.String(length=16), nullable=False),
    sa.Column('after_hours', sa.Integer(), nullable=False),
    sa.Column('priorities', sa.JSON(), nullable=False),
    sa.Column('category_ids', sa.JSON(), nullable=False),
    sa.Column('notify_user_ids', sa.JSON(), nullable=False),
    sa.Column('notify_team_ids', sa.JSON(), nullable=False),
    sa.Column('notify_admins', sa.Boolean(), nullable=False),
    sa.Column('notify_assignees', sa.Boolean(), nullable=False),
    sa.Column('raise_priority', sa.Boolean(), nullable=False),
    sa.Column('created_by_id', sa.Uuid(), nullable=True),
    _ts('deleted_at', True),
    _ts('created_at'),
    _ts('updated_at'),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_escalation_rules_org_id_organizations')),
    sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name=op.f('fk_escalation_rules_created_by_id_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_escalation_rules')),
    )
    with op.batch_alter_table('escalation_rules', schema=None) as b:
        b.create_index(b.f('ix_escalation_rules_org_id'), ['org_id'], unique=False)

    op.create_table('work_order_notices',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('work_order_id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('ref', sa.String(length=80), nullable=False),
    _ts('created_at'),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_work_order_notices_org_id_organizations')),
    sa.ForeignKeyConstraint(['work_order_id'], ['work_orders.id'], name=op.f('fk_work_order_notices_work_order_id_work_orders')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_work_order_notices')),
    sa.UniqueConstraint('work_order_id', 'kind', 'ref', name='uq_work_order_notices'),
    )
    with op.batch_alter_table('work_order_notices', schema=None) as b:
        b.create_index(b.f('ix_work_order_notices_org_id'), ['org_id'], unique=False)
        b.create_index(b.f('ix_work_order_notices_work_order_id'), ['work_order_id'], unique=False)

    # HTML version of outgoing emails (email branding, r312)
    with op.batch_alter_table('outbound_emails', schema=None) as b:
        b.add_column(sa.Column('html', sa.Text(), nullable=False, server_default=''))


def downgrade():
    with op.batch_alter_table('outbound_emails', schema=None) as b:
        b.drop_column('html')
    op.drop_table('work_order_notices')
    op.drop_table('escalation_rules')
    op.drop_table('push_keys')
    op.drop_table('push_subscriptions')
    op.drop_table('notification_prefs')
    op.drop_table('notifications')
