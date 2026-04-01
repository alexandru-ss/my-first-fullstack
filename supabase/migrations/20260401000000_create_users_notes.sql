-- Migration: create users and notes tables with RLS
-- Users table extends auth.users (profiles pattern)

create table public.users (
  id         uuid        primary key references auth.users(id) on delete cascade,
  email      text        not null,
  username   text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.users is 'Public user profiles, linked to auth.users.';

-- Notes table: each note belongs to one user
create table public.notes (
  id         bigint      generated always as identity primary key,
  user_id    uuid        not null references public.users(id) on delete cascade,
  title      text        not null,
  content    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.notes is 'User-authored notes.';

-- Index the FK column on notes (not auto-created by Postgres)
-- Enables fast JOINs, cascading deletes, and RLS policy lookups
create index notes_user_id_idx on public.notes (user_id);

-- ─── Row Level Security ────────────────────────────────────────────────────

alter table public.users enable row level security;
alter table public.notes  enable row level security;

-- Force RLS even for table owners
alter table public.users force row level security;
alter table public.notes  force row level security;

-- Users: each user can read and manage their own profile row
create policy "users: select own row" on public.users
  for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "users: update own row" on public.users
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Notes: full CRUD restricted to the note owner
--   auth.uid() is wrapped in a sub-SELECT so it is evaluated once
--   per statement, not once per row (avoids a 100x+ perf regression
--   on large tables — see security-rls-performance rule).

create policy "notes: select own" on public.notes
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "notes: insert own" on public.notes
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "notes: update own" on public.notes
  for update
  to authenticated
  using  ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "notes: delete own" on public.notes
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ─── Auto-populate users on sign-up ───────────────────────────────────────
-- Trigger that mirrors a new auth.users row into public.users automatically.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
