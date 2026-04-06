-- Fix: Realtime events not delivered to shared document users
--
-- The "documents: select own or shared" policy calls has_doc_share_access() —
-- a SECURITY DEFINER function. Supabase Realtime (walrus) injects the
-- subscriber's JWT via SET LOCAL before evaluating RLS, but SECURITY DEFINER
-- switches to the function owner's security context, dropping those GUC
-- values. auth.uid() returns null inside the function, the EXISTS check
-- returns false, and walrus silently drops the UPDATE event.
--
-- This is the same bug fixed for note_attachments in migration _013.
--
-- Fix part 1: Replace SECURITY DEFINER calls in documents SELECT and UPDATE
-- USING clauses with inline EXISTS subqueries that run in the subscriber's
-- authenticated session context.
--
-- Fix part 2: The inline EXISTS on document_shares in the documents SELECT
-- policy creates a circular RLS dependency with the document_shares INSERT
-- policy (which had EXISTS on documents). Replace that INSERT policy's inline
-- EXISTS with a get_document_owner() call — SECURITY DEFINER is safe here
-- because INSERT policies are only evaluated during DML, never by walrus.
--
-- IMPORTANT: outer-table column qualified as "documents.id" (not bare "id")
-- to avoid the ambiguous-reference tautology bug from migration _014.

-- ─── Part 1: Fix documents SELECT policy ──────────────────────────────────

drop policy "documents: select own or shared" on public.documents;

create policy "documents: select own or shared"
  on public.documents
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    or exists (
      select 1
      from public.document_shares ds
      where ds.document_id    = documents.id
        and ds.shared_with_id = (select auth.uid())
    )
  );

-- ─── Part 1: Fix documents UPDATE policy ─────────────────────────────────

drop policy "documents: update own or shared edit" on public.documents;

create policy "documents: update own or shared edit"
  on public.documents
  for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    or exists (
      select 1
      from public.document_shares ds
      where ds.document_id    = documents.id
        and ds.shared_with_id = (select auth.uid())
        and ds.permission     = 'edit'
    )
  )
  with check (
    (select auth.uid()) = user_id
    or (
      exists (
        select 1
        from public.document_shares ds
        where ds.document_id    = documents.id
          and ds.shared_with_id = (select auth.uid())
          and ds.permission     = 'edit'
      )
      and user_id = public.get_document_owner(documents.id)
    )
  );

-- Note: get_document_owner() in WITH CHECK is fine — WITH CHECK is only
-- evaluated during actual DML (not by walrus), so SECURITY DEFINER works
-- correctly there.

-- ─── Part 2: Break circular RLS recursion on document_shares INSERT ──────
-- documents SELECT now has inline EXISTS on document_shares → document_shares
-- INSERT had inline EXISTS on documents → circular dependency. Replace with
-- get_document_owner() which bypasses documents RLS via SECURITY DEFINER.

drop policy "document_shares: insert own document" on public.document_shares;

create policy "document_shares: insert own document"
  on public.document_shares
  for insert
  to authenticated
  with check (
    owner_id           = (select auth.uid())
    and shared_with_id <> (select auth.uid())
    and public.get_document_owner(document_id) = (select auth.uid())
  );
