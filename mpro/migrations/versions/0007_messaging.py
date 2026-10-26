"""0.6.0: Messaging and realtime (F2).

Conversations (direct, group, team, All Team, work order threads), messages with threads, reactions, announcement
acknowledgements, thread follows, and the short-lived realtime fan-out table.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-26

"""
from alembic import op
import sqlalchemy as sa


revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None


def _ts():
    return [
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade():
    op.create_table('realtime_events',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=True),
    sa.Column('topic', sa.String(length=120), nullable=False),
    sa.Column('type', sa.String(length=80), nullable=False),
    sa.Column('data', sa.JSON(), nullable=False),
    sa.Column('user_ids', sa.JSON(), nullable=True),
    sa.Column('at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_realtime_events'))
    )
    with op.batch_alter_table('realtime_events', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_realtime_events_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_realtime_events_topic'), ['topic'], unique=False)
        batch_op.create_index(batch_op.f('ix_realtime_events_at'), ['at'], unique=False)

    op.create_table('conversations',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('description', sa.String(length=2000), nullable=False),
    sa.Column('picture_file_id', sa.Uuid(), nullable=True),
    sa.Column('dm_key', sa.String(length=80), nullable=True),
    sa.Column('team_id', sa.Uuid(), nullable=True),
    sa.Column('work_order_id', sa.Uuid(), nullable=True),
    sa.Column('hidden_for_all', sa.Boolean(), nullable=False),
    sa.Column('created_by_id', sa.Uuid(), nullable=True),
    sa.Column('last_message_at', sa.DateTime(timezone=True), nullable=True),
    *_ts(),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_conversations_org_id_organizations')),
    sa.ForeignKeyConstraint(['picture_file_id'], ['files.id'], name=op.f('fk_conversations_picture_file_id_files')),
    sa.ForeignKeyConstraint(['team_id'], ['teams.id'], name=op.f('fk_conversations_team_id_teams')),
    sa.ForeignKeyConstraint(['work_order_id'], ['work_orders.id'], name=op.f('fk_conversations_work_order_id_work_orders')),
    sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name=op.f('fk_conversations_created_by_id_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_conversations')),
    sa.UniqueConstraint('org_id', 'dm_key', name='uq_conversations_org_dm_key'),
    sa.UniqueConstraint('org_id', 'team_id', name='uq_conversations_org_team'),
    sa.UniqueConstraint('org_id', 'work_order_id', name='uq_conversations_org_work_order'),
    )
    with op.batch_alter_table('conversations', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_conversations_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_conversations_kind'), ['kind'], unique=False)
        batch_op.create_index(batch_op.f('ix_conversations_last_message_at'), ['last_message_at'], unique=False)

    op.create_table('conversation_members',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('conversation_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('left_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_read_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('notify', sa.String(length=12), nullable=False),
    sa.Column('muted_until', sa.DateTime(timezone=True), nullable=True),
    sa.Column('pinned', sa.Boolean(), nullable=False),
    sa.Column('hidden', sa.Boolean(), nullable=False),
    sa.Column('follow_all_threads', sa.Boolean(), nullable=False),
    *_ts(),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_conversation_members_org_id_organizations')),
    sa.ForeignKeyConstraint(['conversation_id'], ['conversations.id'], name=op.f('fk_conversation_members_conversation_id_conversations')),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_conversation_members_user_id_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_conversation_members')),
    sa.UniqueConstraint('conversation_id', 'user_id', name='uq_conversation_members_conv_user'),
    )
    with op.batch_alter_table('conversation_members', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_conversation_members_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_conversation_members_conversation_id'), ['conversation_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_conversation_members_user_id'), ['user_id'], unique=False)

    op.create_table('messages',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('conversation_id', sa.Uuid(), nullable=False),
    sa.Column('author_id', sa.Uuid(), nullable=True),
    sa.Column('parent_id', sa.Uuid(), nullable=True),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('data', sa.JSON(), nullable=False),
    sa.Column('mentions', sa.JSON(), nullable=False),
    sa.Column('requires_ack', sa.Boolean(), nullable=False),
    sa.Column('reply_count', sa.Integer(), nullable=False),
    sa.Column('last_reply_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('edited_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    *_ts(),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_messages_org_id_organizations')),
    sa.ForeignKeyConstraint(['conversation_id'], ['conversations.id'], name=op.f('fk_messages_conversation_id_conversations')),
    sa.ForeignKeyConstraint(['author_id'], ['users.id'], name=op.f('fk_messages_author_id_users')),
    sa.ForeignKeyConstraint(['parent_id'], ['messages.id'], name=op.f('fk_messages_parent_id_messages')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_messages')),
    )
    with op.batch_alter_table('messages', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_messages_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_messages_conversation_id'), ['conversation_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_messages_parent_id'), ['parent_id'], unique=False)
        batch_op.create_index('ix_messages_conversation_created', ['conversation_id', 'created_at'], unique=False)

    op.create_table('message_reactions',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('message_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('emoji', sa.String(length=16), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_message_reactions_org_id_organizations')),
    sa.ForeignKeyConstraint(['message_id'], ['messages.id'], name=op.f('fk_message_reactions_message_id_messages')),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_message_reactions_user_id_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_message_reactions')),
    sa.UniqueConstraint('message_id', 'user_id', 'emoji', name='uq_message_reactions_msg_user_emoji'),
    )
    with op.batch_alter_table('message_reactions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_message_reactions_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_message_reactions_message_id'), ['message_id'], unique=False)

    op.create_table('message_acks',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('message_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_message_acks_org_id_organizations')),
    sa.ForeignKeyConstraint(['message_id'], ['messages.id'], name=op.f('fk_message_acks_message_id_messages')),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_message_acks_user_id_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_message_acks')),
    sa.UniqueConstraint('message_id', 'user_id', name='uq_message_acks_msg_user'),
    )
    with op.batch_alter_table('message_acks', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_message_acks_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_message_acks_message_id'), ['message_id'], unique=False)

    op.create_table('thread_follows',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('message_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('level', sa.String(length=12), nullable=False),
    sa.Column('last_read_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], name=op.f('fk_thread_follows_org_id_organizations')),
    sa.ForeignKeyConstraint(['message_id'], ['messages.id'], name=op.f('fk_thread_follows_message_id_messages')),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_thread_follows_user_id_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_thread_follows')),
    sa.UniqueConstraint('message_id', 'user_id', name='uq_thread_follows_msg_user'),
    )
    with op.batch_alter_table('thread_follows', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_thread_follows_org_id'), ['org_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_thread_follows_message_id'), ['message_id'], unique=False)


def downgrade():
    for t in ('thread_follows', 'message_acks', 'message_reactions', 'messages', 'conversation_members',
              'conversations', 'realtime_events'):
        op.drop_table(t)
