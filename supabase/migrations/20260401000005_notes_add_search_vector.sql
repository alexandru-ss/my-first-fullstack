-- Migration: add full-text search to notes
-- Adds a stored generated tsvector column combining title (weight A) and
-- content (weight B), then a GIN index for fast @@ queries.
--
-- - GENERATED ALWAYS AS ... STORED: Postgres recomputes on every INSERT/UPDATE
--   automatically; the column is never written directly.
-- - coalesce(..., '') prevents a NULL content from nullifying the whole vector.
-- - setweight gives title tokens label 'A' so ts_rank can score title matches
--   higher than content matches in future ranking queries.
-- - GIN is required for the @@ operator used by Supabase .textSearch().
-- - Existing RLS policies ("notes: select own") scope the index by user_id
--   at query time — no additional policy changes are needed.

alter table public.notes
  add column search_vector tsvector
    generated always as (
      setweight(to_tsvector('english', coalesce(title, '')),   'A') ||
      setweight(to_tsvector('english', coalesce(content, '')), 'B')
    ) stored;

create index notes_search_vector_idx
  on public.notes
  using gin (search_vector);
