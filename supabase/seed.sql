-- Seed data for notes app (local development only)
-- Run via: supabase db reset  (automatically applies seed.sql after migrations)
--
-- RLS is enforced at the API layer. Seeds run as the postgres superuser,
-- which bypasses RLS — no need to disable/re-enable it here.

-- ─── Auth users ───────────────────────────────────────────────────────────
-- Insert directly into auth.users so the on_auth_user_created trigger
-- automatically populates public.users for each row.

insert into auth.users (
  id,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data,
  aud,
  role
) values
  (
    'a0000000-0000-0000-0000-000000000001',
    'alice@example.com',
    crypt('password123', gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}',
    '{"username":"alice"}',
    'authenticated',
    'authenticated'
  ),
  (
    'b0000000-0000-0000-0000-000000000002',
    'bob@example.com',
    crypt('password123', gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}',
    '{"username":"bob"}',
    'authenticated',
    'authenticated'
  ),
  (
    'c0000000-0000-0000-0000-000000000003',
    'carol@example.com',
    crypt('password123', gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}',
    '{"username":"carol"}',
    'authenticated',
    'authenticated'
  );

-- ─── User profile usernames ────────────────────────────────────────────────
-- The trigger already inserted the rows; just backfill the username column.

update public.users set username = 'alice' where id = 'a0000000-0000-0000-0000-000000000001';
update public.users set username = 'bob'   where id = 'b0000000-0000-0000-0000-000000000002';
update public.users set username = 'carol' where id = 'c0000000-0000-0000-0000-000000000003';

-- ─── Notes (batch insert — one round-trip per user) ───────────────────────

insert into public.notes (user_id, title, content, created_at, updated_at) values
  -- Alice's notes
  (
    'a0000000-0000-0000-0000-000000000001',
    'Getting started',
    'Welcome to your notes app! Create, edit, and delete notes from the dashboard.',
    now() - interval '10 days',
    now() - interval '10 days'
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'Shopping list',
    E'- Milk\n- Eggs\n- Bread\n- Coffee',
    now() - interval '7 days',
    now() - interval '3 days'
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'Project ideas',
    'Build a habit tracker. Explore Supabase realtime subscriptions. Write a blog post about RLS.',
    now() - interval '4 days',
    now() - interval '1 day'
  ),

  -- Bob's notes
  (
    'b0000000-0000-0000-0000-000000000002',
    'Meeting notes 2026-03-28',
    'Discussed roadmap priorities. Next sprint focuses on auth improvements and performance.',
    now() - interval '4 days',
    now() - interval '4 days'
  ),
  (
    'b0000000-0000-0000-0000-000000000002',
    'Reading list',
    E'- Designing Data-Intensive Applications\n- The Pragmatic Programmer\n- SQL Performance Explained',
    now() - interval '2 days',
    now() - interval '2 days'
  ),

  -- Carol's notes
  (
    'c0000000-0000-0000-0000-000000000003',
    'Recipe: banana bread',
    E'3 ripe bananas\n1 cup sugar\n1/3 cup melted butter\n1 egg\n1 tsp vanilla\n1 tsp baking soda\n1.5 cups flour\n\nMix, bake 350°F for 55 min.',
    now() - interval '6 days',
    now() - interval '6 days'
  ),
  (
    'c0000000-0000-0000-0000-000000000003',
    'Travel checklist',
    E'- Passport\n- Travel insurance\n- Adapters\n- Download offline maps',
    now() - interval '1 day',
    now()
  );

-- ─── Tags ─────────────────────────────────────────────────────────────────

insert into public.tags (user_id, name) values
  ('a0000000-0000-0000-0000-000000000001', 'personal'),
  ('a0000000-0000-0000-0000-000000000001', 'work'),
  ('a0000000-0000-0000-0000-000000000001', 'shopping'),
  ('b0000000-0000-0000-0000-000000000002', 'work'),
  ('b0000000-0000-0000-0000-000000000002', 'reading');

-- ─── Note tags ────────────────────────────────────────────────────────────

insert into public.note_tags (note_id, tag_id)
select n.id, t.id
from public.notes n
join public.tags t on t.user_id = n.user_id
where
  -- Alice: "Getting started" → personal
  (n.title = 'Getting started' and t.name = 'personal' and n.user_id = 'a0000000-0000-0000-0000-000000000001')
  or
  -- Alice: "Shopping list" → shopping
  (n.title = 'Shopping list' and t.name = 'shopping' and n.user_id = 'a0000000-0000-0000-0000-000000000001')
  or
  -- Alice: "Project ideas" → work
  (n.title = 'Project ideas' and t.name = 'work' and n.user_id = 'a0000000-0000-0000-0000-000000000001')
  or
  -- Bob: "Meeting notes" → work
  (n.title = 'Meeting notes 2026-03-28' and t.name = 'work' and n.user_id = 'b0000000-0000-0000-0000-000000000002')
  or
  -- Bob: "Reading list" → reading
  (n.title = 'Reading list' and t.name = 'reading' and n.user_id = 'b0000000-0000-0000-0000-000000000002');
