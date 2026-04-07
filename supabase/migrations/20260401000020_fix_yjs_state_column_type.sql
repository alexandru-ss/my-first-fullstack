-- Fix: change yjs_state from bytea to text
--
-- PostgREST returns bytea columns in Postgres hex format (\x...), but
-- the application sends and expects base64-encoded strings.  Using text
-- avoids the encode/decode mismatch entirely while still benefiting
-- from TOAST compression for large values.
--
-- The USING clause recovers any existing data by interpreting the stored
-- bytes (which are the ASCII of the original base64 string) as UTF-8 text.

alter table public.documents
  alter column yjs_state type text
  using convert_from(yjs_state, 'UTF8');

comment on column public.documents.yjs_state is
  'Base64-encoded Yjs CRDT state (Y.encodeStateAsUpdate). Stored as text to avoid bytea hex-encoding issues with PostgREST.';
