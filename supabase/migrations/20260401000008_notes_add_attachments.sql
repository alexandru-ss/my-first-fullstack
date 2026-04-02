-- Migration: add note_attachments table + private attachments storage bucket
--
-- Stores only the storage *path* (e.g. "<user_id>/<note_id>/<safe_filename>") in the DB.
-- Signed URLs are generated at display time and are never persisted.
--
-- user_id is denormalised onto the table (rather than looked up through notes) so that
-- RLS policies use a direct indexed column comparison instead of a correlated subquery per row.
-- See: security-rls-performance rule — wrap auth.uid() in a sub-SELECT to evaluate once per
-- statement, not once per row.

-- ─── Schema ────────────────────────────────────────────────────────────────

create table public.note_attachments (
  id           bigint       generated always as identity primary key,
  note_id      bigint       not null references public.notes(id)  on delete cascade,
  user_id      uuid         not null references public.users(id)  on delete cascade,
  storage_path text         not null,
  file_name    text         not null,
  mime_type    text,
  size_bytes   bigint,
  created_at   timestamptz  not null default now()
);

comment on table public.note_attachments is
  'File attachment metadata linked to notes. storage_path is the path inside the attachments bucket.';

-- ─── Indexes ───────────────────────────────────────────────────────────────
-- Postgres does NOT auto-create indexes on FK columns.
-- note_id_idx: serves JOIN queries and ON DELETE CASCADE on notes.
-- user_id_idx: serves RLS policy evaluation and ON DELETE CASCADE on users.

create index note_attachments_note_id_idx on public.note_attachments (note_id);
create index note_attachments_user_id_idx on public.note_attachments (user_id);

-- ─── Row Level Security ────────────────────────────────────────────────────

alter table public.note_attachments enable row level security;
alter table public.note_attachments force row level security;

-- Owners can read their own attachment metadata rows.
create policy "note_attachments: select own"
  on public.note_attachments
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Owners can insert new attachment metadata rows.
create policy "note_attachments: insert own"
  on public.note_attachments
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- Owners can delete their own attachment metadata rows.
create policy "note_attachments: delete own"
  on public.note_attachments
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- No UPDATE policy: attachments are immutable once uploaded.

-- ─── Storage bucket ────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

-- ─── Storage RLS policies ──────────────────────────────────────────────────
-- All policies share the same ownership guard:
--   (storage.foldername(name))[1] = (select auth.uid()::text)
--
-- Path structure: <user_id>/<note_id>/<safe_filename>
-- The first path segment is always the owner's user ID, so foldername()[1]
-- is sufficient to verify ownership without any additional DB lookups.
--
-- The (select auth.uid()) sub-SELECT wrapper causes the function to be
-- evaluated once per statement rather than once per row.
-- See: security-rls-performance rule.

-- Owners can read their own files (needed to generate signed URLs).
create policy "attachments: owner select"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- Owners can upload files into their own folder.
create policy "attachments: owner insert"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- Owners can delete their own files.
create policy "attachments: owner delete"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- No UPDATE policy: storage files are write-once.
