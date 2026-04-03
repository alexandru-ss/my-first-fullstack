-- Enable Realtime on the note_shares table.
--
-- REPLICA IDENTITY FULL ensures DELETE events include the full old row
-- (shared_with_id, note_id, id, etc.), which is required so the client can
-- filter DELETE payloads by shared_with_id and remove the correct entry from
-- its "Shared with me" list in real time.
-- Without this, DELETE payloads only contain the primary key (id), and
-- shared_with_id would be missing — the server-side Realtime filter
-- `shared_with_id=eq.<userId>` would never match DELETE events, so revokes
-- would not propagate to the recipient until a manual refresh.
alter table public.note_shares replica identity full;

-- Enrol note_shares in the Supabase-managed publication so that
-- INSERT and DELETE changes are broadcast to subscribed clients.
alter publication supabase_realtime add table public.note_shares;
