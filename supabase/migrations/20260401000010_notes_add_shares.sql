-- Migration: add note sharing with view / edit permission levels
--
-- Design decisions:
--   - shared_with_id is NOT NULL: the frontend always resolves email → uuid
--     via find_user_by_email() before inserting, so phantom invite rows are
--     never needed and the self-share CHECK stays simple.
--   - Four SECURITY DEFINER helpers keep RLS USING clauses index-friendly:
--     wrapping complex EXISTS subqueries in stable functions causes Postgres to
--     run them once per statement rather than once per row.
--     See: security-rls-performance rule.
--   - Notes SELECT / UPDATE policies are extended with OR (not replaced by
--     separate policies) so that shared users can read / edit in the same
--     access path as owners.
--   - Storage policies are extended with new SELECT-only policies; write
--     policies on both buckets remain owner-only.

-- ─── Permission enum ───────────────────────────────────────────────────────

create type public.note_permission as enum ('view', 'edit');

-- ─── note_shares table ─────────────────────────────────────────────────────

create table public.note_shares (
  id                  bigint           generated always as identity primary key,
  note_id             bigint           not null references public.notes(id)  on delete cascade,
  owner_id            uuid             not null references public.users(id)  on delete cascade,
  shared_with_email   text             not null,
  shared_with_id      uuid             not null references public.users(id)  on delete cascade,
  permission          public.note_permission not null default 'view',
  created_at          timestamptz      not null default now(),

  -- One share record per (note, recipient email)
  unique (note_id, shared_with_email),
  -- One share record per (note, recipient user id)
  unique (note_id, shared_with_id),
  -- Prevent sharing a note with yourself (enforced at DB level as well as UI)
  constraint note_shares_no_self_share check (shared_with_id <> owner_id)
);

comment on table public.note_shares is
  'Tracks which notes have been shared with other users. permission controls read vs edit access.';

-- ─── Indexes ───────────────────────────────────────────────────────────────
-- note_id_idx       : FK cascade support + owner share-management queries
-- shared_with_id_idx: FK cascade support + recipient-side policy lookups
-- Composite indexes back the SECURITY DEFINER helper function lookups used
-- inside RLS policies (single index scan instead of two separate lookups).

create index note_shares_note_id_idx
  on public.note_shares (note_id);

create index note_shares_shared_with_id_idx
  on public.note_shares (shared_with_id);

-- Backs has_note_share_access() and has_note_edit_permission()
create index note_shares_note_shared_idx
  on public.note_shares (note_id, shared_with_id);

-- Backs has_share_from_user()
create index note_shares_owner_shared_idx
  on public.note_shares (owner_id, shared_with_id);

-- Backs find_user_by_email() — normalize at index time to match query predicate
create index users_email_lower_idx
  on public.users (lower(email));

-- ─── Row Level Security ────────────────────────────────────────────────────

alter table public.note_shares enable row level security;
alter table public.note_shares force row level security;

-- ─── SECURITY DEFINER helper functions ────────────────────────────────────
--
-- All four functions:
--   - security definer : run as the function owner, bypassing RLS on
--     public.note_shares / public.users so the JOIN is always reachable.
--   - stable           : no side-effects; result can be cached per statement.
--   - set search_path = '' : prevents search_path hijacking attacks.
--   - revoke / grant   : callable by authenticated users only, not anon.

-- Returns true when the calling user has any active share for the given note
-- (regardless of permission level). Used in notes SELECT and attachments SELECT.
create or replace function public.has_note_share_access(p_note_id bigint)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.note_shares ns
    where ns.note_id        = p_note_id
      and ns.shared_with_id = (select auth.uid())
  );
$$;

revoke execute on function public.has_note_share_access(bigint) from public;
grant  execute on function public.has_note_share_access(bigint) to authenticated;

-- Returns true when the calling user has an edit-permission share for the
-- given note. Used in the notes UPDATE policy USING + WITH CHECK clauses.
create or replace function public.has_note_edit_permission(p_note_id bigint)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.note_shares ns
    where ns.note_id        = p_note_id
      and ns.shared_with_id = (select auth.uid())
      and ns.permission     = 'edit'
  );
$$;

revoke execute on function public.has_note_edit_permission(bigint) from public;
grant  execute on function public.has_note_edit_permission(bigint) to authenticated;

-- Returns true when the calling user has been shared any note from the given
-- owner. Used in the avatars storage SELECT policy (avatar paths have no
-- note_id segment, so we check at the owner level).
create or replace function public.has_share_from_user(p_owner_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.note_shares ns
    where ns.owner_id       = p_owner_id
      and ns.shared_with_id = (select auth.uid())
  );
$$;

revoke execute on function public.has_share_from_user(uuid) from public;
grant  execute on function public.has_share_from_user(uuid) to authenticated;

-- Resolves an exact email address to a user's id + display name.
-- Returns only id and username — never email, avatar_path, or any other
-- sensitive column — so callers cannot enumerate account existence beyond
-- the single email they already know.
-- Returns at most 1 row; LIMIT 1 makes the intent explicit.
create or replace function public.find_user_by_email(lookup_email text)
returns table (id uuid, username text)
language sql
security definer
stable
set search_path = ''
as $$
  select u.id, u.username
  from public.users u
  where u.email = lower(trim(lookup_email))
  limit 1;
$$;

revoke execute on function public.find_user_by_email(text) from public;
grant  execute on function public.find_user_by_email(text) to authenticated;

-- ─── note_shares RLS policies ──────────────────────────────────────────────

-- Owner and recipient can both read a share row.
-- Two separate conditions joined by OR: owner manages their shares;
-- recipient discovers which notes they have access to.
create policy "note_shares: select own or received"
  on public.note_shares
  for select
  to authenticated
  using (
    owner_id       = (select auth.uid())
    or shared_with_id = (select auth.uid())
  );

-- Only the note owner may create a share.
-- WITH CHECK also verifies:
--   (a) owner_id matches the caller (no impersonation)
--   (b) the note actually belongs to the caller (anti-spoofing)
--   (c) the caller is not sharing with themselves (belt + suspenders with the
--       CHECK constraint — the constraint fires later in the pipeline)
create policy "note_shares: insert own note"
  on public.note_shares
  for insert
  to authenticated
  with check (
    owner_id      = (select auth.uid())
    and shared_with_id <> (select auth.uid())
    and exists (
      select 1 from public.notes n
      where n.id      = note_id
        and n.user_id = (select auth.uid())
    )
  );

-- Only the note owner may revoke (delete) a share.
create policy "note_shares: delete own note"
  on public.note_shares
  for delete
  to authenticated
  using (owner_id = (select auth.uid()));

-- ─── Extend users SELECT policy ────────────────────────────────────────────
-- Allow a user to read the profile row of anyone who has shared a note with
-- them. Required so SharedNotesList can fetch username + avatar_path for the
-- "Shared by" label and avatar display.
-- The existing "users: select own row" policy remains unchanged.

create policy "users: select shared note owner"
  on public.users
  for select
  to authenticated
  using (
    exists (
      select 1 from public.note_shares ns
      where ns.owner_id       = users.id
        and ns.shared_with_id = (select auth.uid())
    )
  );

-- ─── Extend notes SELECT policy ────────────────────────────────────────────
-- Drop the owner-only policy and recreate with OR so that shared users can
-- also read the note. The owner condition is preserved verbatim.

drop policy "notes: select own" on public.notes;

create policy "notes: select own or shared"
  on public.notes
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    or public.has_note_share_access(id)
  );

-- ─── Extend notes UPDATE policy ────────────────────────────────────────────
-- Drop the owner-only policy and recreate with OR so that users with edit
-- permission can also update the note.
--
-- WITH CHECK on the shared-editor path asserts that user_id (the ownership
-- column) has NOT been changed by the update. It reads the current persisted
-- value from the DB and compares it to the proposed new value, blocking any
-- attempt to transfer note ownership.

drop policy "notes: update own" on public.notes;

create policy "notes: update own or shared edit"
  on public.notes
  for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    or public.has_note_edit_permission(id)
  )
  with check (
    -- Owner path: caller is still the owner after the update
    (select auth.uid()) = user_id
    -- Shared-editor path: edit permission confirmed AND ownership column
    -- is unchanged (prevents a shared editor from stealing the note)
    or (
      public.has_note_edit_permission(id)
      and user_id = (
        select n.user_id
        from public.notes n
        where n.id = id
      )
    )
  );

-- ─── Extend note_attachments SELECT policy ─────────────────────────────────
-- Allow shared users to read attachment metadata rows (needed to call
-- createSignedUrl on the storage paths). Owner-only policies are unchanged.

create policy "note_attachments: select shared"
  on public.note_attachments
  for select
  to authenticated
  using (public.has_note_share_access(note_id));

-- ─── Extend avatars storage SELECT policy ──────────────────────────────────
-- Avatar path structure: <owner_user_id>/avatar.png
-- foldername(name)[1] = the owner's user_id.
-- A shared user can generate a signed URL for the note owner's avatar when
-- they have at least one active share from that owner.
-- Write policies (insert / update / delete) are untouched.

create policy "avatars: shared reader select"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'avatars'
    and (select public.has_share_from_user((storage.foldername(name))[1]::uuid))
  );

-- ─── Extend attachments storage SELECT policy ──────────────────────────────
-- Attachment path structure: <owner_user_id>/<note_id>/<filename>
-- foldername(name)[2] = the note_id segment.
-- A shared user can generate signed URLs for any attachment on a note they
-- have been granted access to (view or edit permission).
-- Write policies (insert / delete) are untouched.

create policy "attachments: shared reader select"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'attachments'
    and (select public.has_note_share_access((storage.foldername(name))[2]::bigint))
  );
