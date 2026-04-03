-- Fix: "note_attachments: select shared" policy has an ambiguous column reference.
--
-- Migration 013 replaced the SECURITY DEFINER function with an inline EXISTS
-- subquery, but introduced a SQL name-resolution bug:
--
--   where ns.note_id = note_id
--
-- Inside the correlated subquery the FROM clause is "public.note_shares ns".
-- PostgreSQL resolves unqualified column names by checking the innermost FROM
-- clause first; since note_shares also has a note_id column, `note_id` on the
-- right-hand side resolves to ns.note_id, making the condition a tautology:
--
--   ns.note_id = ns.note_id   →  always TRUE (for non-null rows)
--
-- The effective policy therefore becomes:
--
--   EXISTS (SELECT 1 FROM note_shares WHERE shared_with_id = auth.uid())
--
-- which allows any authenticated user who has *any* share record to SELECT
-- *any* note_attachment row — a security over-grant.  More critically,
-- Supabase Realtime (walrus) evaluates this USING clause to decide whether to
-- deliver DELETE events to each subscriber; the tautological check can give
-- inconsistent results across walrus versions, causing DELETE events to be
-- silently dropped rather than delivered to the shared user.
--
-- Fix: explicitly qualify the outer table column with note_attachments.note_id.
-- This restores the intended semantics — the subscriber must have a share
-- record for the *specific* note that owns the attachment — and makes the
-- walrus evaluation deterministic for both INSERT and DELETE events.
--
-- The composite index note_shares_note_shared_idx(note_id, shared_with_id)
-- created in migration 010 backs this query efficiently.

drop policy "note_attachments: select shared" on public.note_attachments;

create policy "note_attachments: select shared"
  on public.note_attachments
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.note_shares ns
      where ns.note_id        = note_attachments.note_id
        and ns.shared_with_id = (select auth.uid())
    )
  );
