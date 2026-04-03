-- Fix: "note_attachments: select shared" policy uses public.has_note_share_access(),
-- a SECURITY DEFINER function. Supabase Realtime (walrus) injects the subscriber's
-- JWT claims into the Postgres session via SET LOCAL before evaluating RLS. SET LOCAL
-- values are session-scoped and ARE visible inside regular functions, but SECURITY
-- DEFINER switches execution to the function owner's security context, which drops
-- those session GUC values — so auth.uid() returns null inside the function body
-- when called from walrus. The EXISTS check returns false, and walrus silently drops
-- the DELETE event before it reaches the subscriber.
--
-- INSERT events were unaffected because walrus also runs a live SELECT against the
-- (still-present) row to authorise INSERT events; the SELECT matches the owner
-- policy directly. DELETE events have no live row to fall back to — walrus must
-- evaluate the full RLS expression against the WAL old-row data alone, hitting the
-- broken SECURITY DEFINER path every time.
--
-- Fix: replace the SECURITY DEFINER function call with an inline EXISTS subquery.
-- The subquery runs in the same security context as the policy (the subscriber's
-- authenticated session), so auth.uid() is always set and the note_shares lookup
-- succeeds for both INSERT and DELETE events. note_shares is accessed with its own
-- RLS in effect; the "note_shares: select own or shared" policy allows the shared
-- user to read their own rows (shared_with_id = auth.uid()), so the join is always
-- reachable. Index note_shares_note_shared_idx(note_id, shared_with_id) is used.

drop policy "note_attachments: select shared" on public.note_attachments;

create policy "note_attachments: select shared"
  on public.note_attachments
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.note_shares ns
      where ns.note_id        = note_id
        and ns.shared_with_id = (select auth.uid())
    )
  );
