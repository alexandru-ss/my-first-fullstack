alter table public.notes add column pinned boolean not null default false;

create index notes_pinned_user_idx on public.notes (user_id, updated_at desc) where pinned = true;
