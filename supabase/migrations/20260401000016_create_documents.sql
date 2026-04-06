-- Migration: create documents table for long-form Markdown content
--
-- documents is a standalone content type — no shared schema with notes.
-- RLS is owner-only (same pattern as initial notes policies).

-- ─── Table ─────────────────────────────────────────────────────────────────

create table public.documents (
  id         bigint      generated always as identity primary key,
  user_id    uuid        not null references public.users(id) on delete cascade,
  title      text        not null,
  body       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.documents is 'User-authored long-form Markdown documents.';

-- FK index — Postgres does not auto-create one; required for fast JOINs,
-- cascading deletes, and RLS policy lookups on user_id.
create index documents_user_id_idx on public.documents (user_id);

-- ─── Auto-update updated_at ────────────────────────────────────────────────

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_documents_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

-- ─── Row Level Security ────────────────────────────────────────────────────

alter table public.documents enable row level security;
alter table public.documents force row level security;

-- auth.uid() wrapped in a sub-SELECT so it is evaluated once per statement,
-- not once per row (security-rls-performance).

create policy "documents: select own" on public.documents
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "documents: insert own" on public.documents
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "documents: update own" on public.documents
  for update
  to authenticated
  using  ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "documents: delete own" on public.documents
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ─── Realtime ──────────────────────────────────────────────────────────────

alter table public.documents replica identity full;
alter publication supabase_realtime add table public.documents;
