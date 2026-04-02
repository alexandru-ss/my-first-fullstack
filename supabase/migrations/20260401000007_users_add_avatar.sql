-- Migration: add avatar_path to users + create private avatars storage bucket
--
-- Stores only the storage *path* (e.g. "<user_id>/avatar.png") in the DB.
-- Signed URLs are generated at display time and are never persisted.

-- ─── Schema ────────────────────────────────────────────────────────────────

alter table public.users
  add column avatar_path text;

comment on column public.users.avatar_path is
  'Storage path inside the avatars bucket (e.g. "<user_id>/avatar.png"). Null means no avatar set.';

-- ─── Storage bucket ────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', false)
on conflict (id) do nothing;

-- ─── Storage RLS policies ──────────────────────────────────────────────────
-- All four policies share the same ownership guard:
--   (storage.foldername(name))[1] = (select auth.uid()::text)
--
-- The (select auth.uid()) sub-SELECT wrapper is intentional.
-- It causes the function to be evaluated once per statement rather than once
-- per row, avoiding a severe performance regression on large tables.
-- See: security-rls-performance rule.

-- Owners can read their own files (needed to generate signed URLs server-side;
-- the JS client uses createSignedUrl which calls this path internally).
create policy "avatars: owner select"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- Owners can upload new files into their own folder.
create policy "avatars: owner insert"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- Owners can replace (upsert) their own files.
create policy "avatars: owner update"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- Owners can delete their own files.
create policy "avatars: owner delete"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );
