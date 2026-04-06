-- Migration: add document sharing with view / edit permission levels
--
-- Mirrors the note sharing pattern (migration _010 – _015) for documents.
--
-- Design decisions:
--   - Separate document_shares table (not polymorphic) — each content type has
--     its own RLS policies, indexes, and SECURITY DEFINER helpers.
--   - Reuses the existing note_permission enum ('view', 'edit') — it's a
--     database-level type, not tied to any specific table.
--   - Reuses find_user_by_email() from migration _010 — content-type-agnostic.
--   - Includes get_document_owner() from the start to avoid the RLS recursion
--     bug that was fixed in migration _011 for notes.
--   - SECURITY DEFINER helpers keep RLS USING clauses index-friendly.
--   - Documents SELECT / UPDATE policies are extended with OR (not replaced by
--     separate policies) so shared users access via the same code path as owners.
--   - Delete remains owner-only.

-- ─── document_shares table ─────────────────────────────────────────────────

create table public.document_shares (
  id                  bigint           generated always as identity primary key,
  document_id         bigint           not null references public.documents(id) on delete cascade,
  owner_id            uuid             not null references public.users(id)     on delete cascade,
  shared_with_email   text             not null,
  shared_with_id      uuid             not null references public.users(id)     on delete cascade,
  permission          public.note_permission not null default 'view',
  created_at          timestamptz      not null default now(),

  -- One share record per (document, recipient email)
  unique (document_id, shared_with_email),
  -- One share record per (document, recipient user id)
  unique (document_id, shared_with_id),
  -- Prevent sharing a document with yourself
  constraint document_shares_no_self_share check (shared_with_id <> owner_id)
);

comment on table public.document_shares is
  'Tracks which documents have been shared with other users. permission controls read vs edit access.';

-- ─── Indexes ───────────────────────────────────────────────────────────────
-- Same pattern as note_shares indexes (migration _010).

create index document_shares_document_id_idx
  on public.document_shares (document_id);

create index document_shares_shared_with_id_idx
  on public.document_shares (shared_with_id);

-- Backs has_doc_share_access() and has_doc_edit_permission()
create index document_shares_doc_shared_idx
  on public.document_shares (document_id, shared_with_id);

-- Backs has_doc_share_from_user()
create index document_shares_owner_shared_idx
  on public.document_shares (owner_id, shared_with_id);

-- ─── Row Level Security ────────────────────────────────────────────────────

alter table public.document_shares enable row level security;
alter table public.document_shares force row level security;

-- ─── SECURITY DEFINER helper functions ────────────────────────────────────
--
-- All functions: security definer, stable, set search_path = '',
-- revoke from public, grant to authenticated.

-- Returns true when the calling user has any active share for the given document.
create or replace function public.has_doc_share_access(p_document_id bigint)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.document_shares ds
    where ds.document_id    = p_document_id
      and ds.shared_with_id = (select auth.uid())
  );
$$;

revoke execute on function public.has_doc_share_access(bigint) from public;
grant  execute on function public.has_doc_share_access(bigint) to authenticated;

-- Returns true when the calling user has an edit-permission share for the document.
create or replace function public.has_doc_edit_permission(p_document_id bigint)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.document_shares ds
    where ds.document_id    = p_document_id
      and ds.shared_with_id = (select auth.uid())
      and ds.permission     = 'edit'
  );
$$;

revoke execute on function public.has_doc_edit_permission(bigint) from public;
grant  execute on function public.has_doc_edit_permission(bigint) to authenticated;

-- Returns the owner user_id for a given document. Runs as SECURITY DEFINER to
-- bypass documents RLS — avoids infinite recursion when used in the UPDATE
-- WITH CHECK clause (same pattern as get_note_owner from migration _011).
create or replace function public.get_document_owner(p_document_id bigint)
returns uuid
language sql
security definer
stable
set search_path = ''
as $$
  select d.user_id
  from public.documents d
  where d.id = p_document_id;
$$;

revoke execute on function public.get_document_owner(bigint) from public;
grant  execute on function public.get_document_owner(bigint) to authenticated;

-- Returns true when the calling user has been shared any document from the
-- given owner. Used in the avatars storage SELECT policy.
create or replace function public.has_doc_share_from_user(p_owner_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.document_shares ds
    where ds.owner_id       = p_owner_id
      and ds.shared_with_id = (select auth.uid())
  );
$$;

revoke execute on function public.has_doc_share_from_user(uuid) from public;
grant  execute on function public.has_doc_share_from_user(uuid) to authenticated;

-- ─── document_shares RLS policies ──────────────────────────────────────────

-- Owner and recipient can both read a share row.
create policy "document_shares: select own or received"
  on public.document_shares
  for select
  to authenticated
  using (
    owner_id          = (select auth.uid())
    or shared_with_id = (select auth.uid())
  );

-- Only the document owner may create a share.
create policy "document_shares: insert own document"
  on public.document_shares
  for insert
  to authenticated
  with check (
    owner_id          = (select auth.uid())
    and shared_with_id <> (select auth.uid())
    and exists (
      select 1 from public.documents d
      where d.id      = document_id
        and d.user_id = (select auth.uid())
    )
  );

-- Only the document owner may update a share (e.g. change permission level).
create policy "document_shares: update own document"
  on public.document_shares
  for update
  to authenticated
  using  (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- Only the document owner may revoke (delete) a share.
create policy "document_shares: delete own document"
  on public.document_shares
  for delete
  to authenticated
  using (owner_id = (select auth.uid()));

-- ─── Extend users SELECT policy ────────────────────────────────────────────
-- Allow reading the profile of anyone who has shared a document with the
-- calling user (for "Shared by" label and avatar display).

create policy "users: select shared document owner"
  on public.users
  for select
  to authenticated
  using (
    exists (
      select 1 from public.document_shares ds
      where ds.owner_id       = users.id
        and ds.shared_with_id = (select auth.uid())
    )
  );

-- ─── Extend documents SELECT policy ────────────────────────────────────────

drop policy "documents: select own" on public.documents;

create policy "documents: select own or shared"
  on public.documents
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    or public.has_doc_share_access(id)
  );

-- ─── Extend documents UPDATE policy ────────────────────────────────────────

drop policy "documents: update own" on public.documents;

create policy "documents: update own or shared edit"
  on public.documents
  for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    or public.has_doc_edit_permission(id)
  )
  with check (
    (select auth.uid()) = user_id
    or (
      public.has_doc_edit_permission(id)
      and user_id = public.get_document_owner(id)
    )
  );

-- documents: delete own — unchanged (owner-only)

-- ─── Extend avatars storage SELECT policy ──────────────────────────────────
-- Avatar path structure: <owner_user_id>/avatar.png
-- A shared-document user can view the document owner's avatar.

create policy "avatars: shared document reader select"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'avatars'
    and (select public.has_doc_share_from_user((storage.foldername(name))[1]::uuid))
  );

-- ─── Realtime ──────────────────────────────────────────────────────────────
-- REPLICA IDENTITY FULL ensures DELETE events include the full old row
-- (shared_with_id, document_id, etc.) so server-side Realtime filters match.

alter table public.document_shares replica identity full;
alter publication supabase_realtime add table public.document_shares;
