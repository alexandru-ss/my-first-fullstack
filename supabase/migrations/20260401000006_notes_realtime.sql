-- Enable Realtime on the notes table.
--
-- REPLICA IDENTITY FULL ensures UPDATE and DELETE events include the full old row,
-- which is required for reliable client-side state reconciliation (DELETE payload
-- would otherwise only contain the primary key).
alter table public.notes replica identity full;

-- Add notes to the Supabase-managed publication.
-- Supabase creates this publication automatically at startup;
-- we just enrol our table here.
alter publication supabase_realtime add table public.notes;
