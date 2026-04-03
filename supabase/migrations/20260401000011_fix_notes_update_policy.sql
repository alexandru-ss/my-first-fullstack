-- Migration: fix infinite recursion in the notes UPDATE policy.
--
-- Root cause:
--   The WITH CHECK clause of "notes: update own or shared edit" contained:
--
--     user_id = (select n.user_id from public.notes n where n.id = id)
--
--   Postgres evaluates this subquery while already inside the notes RLS check.
--   That triggers the same RLS evaluation again → infinite recursion.
--   PostgreSQL does NOT guarantee short-circuit evaluation of OR in policy
--   expressions, so even when the left-hand condition (auth.uid() = user_id)
--   is true for the note owner, the right-hand subquery may still be executed.
--
-- Fix:
--   Extract the notes lookup into a SECURITY DEFINER function.
--   SECURITY DEFINER functions run as the function owner (postgres superuser).
--   Superusers bypass RLS even with FORCE ROW LEVEL SECURITY (Postgres docs:
--   "superusers and roles with the BYPASSRLS attribute always bypass the row
--   security system"). The function therefore reads notes.user_id without
--   re-entering the policy → no recursion.
--
--   This is identical to the pattern used by has_note_share_access(),
--   has_note_edit_permission(), and has_share_from_user() in migration _010.

-- ─── Helper function ───────────────────────────────────────────────────────

create or replace function public.get_note_owner(p_note_id bigint)
returns uuid
language sql
security definer   -- runs as postgres superuser, bypasses notes RLS
stable             -- no side-effects; result can be cached per statement
set search_path = ''
as $$
  select n.user_id
  from public.notes n
  where n.id = p_note_id;
$$;

-- Not a useful client-facing RPC (returns a raw uuid), but restrict to
-- authenticated anyway for defence-in-depth.
revoke execute on function public.get_note_owner(bigint) from public;
grant  execute on function public.get_note_owner(bigint) to authenticated;

-- ─── Recreate the notes UPDATE policy ─────────────────────────────────────

drop policy "notes: update own or shared edit" on public.notes;

-- USING  : evaluated against the OLD row — who is allowed to attempt an update.
-- WITH CHECK: evaluated against the NEW row — what the row is allowed to look
--             like after the update.
--
-- Owner path (both clauses):
--   (select auth.uid()) = user_id
--   In USING  : old user_id = caller  → caller is the owner.
--   In WITH CHECK: new user_id = caller → prevents the owner from transferring
--                  ownership to another user_id.
--
-- Shared-editor path (both clauses):
--   has_note_edit_permission(id) confirms an edit-permission share exists.
--   In WITH CHECK, get_note_owner(id) reads the CURRENT (old) stored user_id
--   via SECURITY DEFINER — no RLS re-entry — and asserts the proposed new
--   user_id matches it, blocking ownership transfer by a shared editor.

create policy "notes: update own or shared edit"
  on public.notes
  for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    or public.has_note_edit_permission(id)
  )
  with check (
    (select auth.uid()) = user_id
    or (
      public.has_note_edit_permission(id)
      and user_id = public.get_note_owner(id)
    )
  );
