alter table public.notes add column archived_at timestamptz default null;

-- Drop the full index superseded by partial indexes below
drop index if exists notes_user_id_idx;

-- Hot-path: active notes per user (matches WHERE archived_at IS NULL in fetch query)
create index notes_active_user_idx on public.notes (user_id, updated_at desc)
where archived_at is null;

-- Archived notes tab
create index notes_archived_user_idx on public.notes (user_id, archived_at desc)
where archived_at is not null;
