-- Fix: promote note_id into the primary key of note_attachments.
--
-- BACKGROUND — WHY DELETE EVENTS ONLY CARRY PRIMARY KEY COLUMNS
-- ==============================================================
-- Supabase Realtime (walrus) enforces the following rule documented at
-- https://supabase.com/docs/guides/realtime/postgres-changes#receiving-old-records:
--
--   "When RLS is enabled and replica identity is set to full on a table,
--    the old record contains only the primary key(s)."
--
-- With the previous PK of just (id), every DELETE event delivered to a
-- subscriber contained only { id }.  note_id was absent, making it
-- impossible for shared-user subscribers to determine which note lost an
-- attachment without a full refetch.
--
-- The owner (user A) appeared to work because handleDeleteAttachment applies
-- an optimistic state update before the DELETE fires; the Realtime event
-- arrived with { id } only, the handler found no matching note_id, and was a
-- no-op — correctness came entirely from the optimistic update, not Realtime.
--
-- Shared-user subscribers (user B) have no optimistic update to fall back on,
-- so their attachment list was never updated on owner-side deletions.
--
-- THE FIX
-- =======
-- Make the primary key composite: (note_id, id).
--
-- Walrus now delivers { note_id, id } in the old record of every DELETE
-- event, regardless of whether the subscriber is the owner or a shared user.
-- The existing DELETE handlers in SharedNotesList and NoteEditor already
-- reference oldRow.note_id — they will work correctly without any JS change.
--
-- SAFETY
-- ======
-- • id is GENERATED ALWAYS AS IDENTITY — globally unique by itself.
--   Any superset {note_id, id} is also unique, so the uniqueness invariant
--   of the PK is preserved.
-- • note_id already carries a NOT NULL FK on notes(id) ON DELETE CASCADE;
--   a column can participate in both a PK and a FK simultaneously.
-- • No other table references note_attachments(id) as a foreign key, so no
--   FK dependencies are broken by this change.
-- • The composite PK index (note_id, id) covers all left-prefix scans on
--   note_id, making note_attachments_note_id_idx redundant; it is dropped
--   below to avoid double-indexing overhead.
--
-- security-rls-performance: the existing policies reference user_id and the
-- note_attachments.note_id outer-table qualifier (migration 014) — both
-- unaffected by this PK change.

alter table public.note_attachments
  drop constraint note_attachments_pkey,
  add primary key (note_id, id);

-- note_attachments_note_id_idx(note_id) is now redundant:
-- the composite PK index (note_id, id) satisfies all queries that previously
-- needed a standalone note_id index (note_id is the leftmost prefix).
drop index if exists public.note_attachments_note_id_idx;
