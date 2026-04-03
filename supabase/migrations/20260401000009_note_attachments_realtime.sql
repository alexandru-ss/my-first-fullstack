-- Enable Realtime on the note_attachments table.
--
-- REPLICA IDENTITY FULL ensures DELETE events include the full old row
-- (note_id, id, etc.), which is required so the client can locate the
-- parent note and remove the correct attachment from its local list.
-- Without this, DELETE payloads only contain the primary key (id), and
-- note_id would be missing — making client-side reconciliation impossible.
alter table public.note_attachments replica identity full;

-- Enrol note_attachments in the Supabase-managed publication so that
-- INSERT and DELETE changes are broadcast to subscribed clients.
alter publication supabase_realtime add table public.note_attachments;
