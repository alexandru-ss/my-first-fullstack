-- Migration: add yjs_state column for CRDT-based collaborative editing
--
-- Stores the full Yjs encoded document state (Y.encodeStateAsUpdate) as binary.
-- This column is used ALONGSIDE the existing plain-text `body` column:
--   - yjs_state: authoritative CRDT state for merge-correct collaborative editing
--   - body: plain-text extraction for full-text search, previews, and API access
--
-- Nullable: legacy documents created before this migration have NULL.
-- The frontend seeds a Y.Doc from `body` on first open and persists yjs_state
-- on the next save.
--
-- No index: binary CRDT state is never searched or sorted.
-- TOAST: Postgres automatically compresses and stores out-of-line for values > ~2 KB.
-- RLS: inherits existing row-level policies on the documents table — no changes needed.

alter table public.documents
  add column yjs_state bytea;

comment on column public.documents.yjs_state is
  'Yjs CRDT encoded state (Y.encodeStateAsUpdate). Used to initialize collaborative editing sessions. Kept alongside body (plain text) for search and previews.';
