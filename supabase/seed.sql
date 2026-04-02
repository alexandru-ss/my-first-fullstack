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
  ),
  (
    'd0000000-0000-0000-0000-000000000004',
    'bob1@example.com',
    crypt('password123', gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}',
    '{"username":"bob1"}',
    'authenticated',
    'authenticated'
  );

-- ─── User profile usernames ────────────────────────────────────────────────
-- The trigger already inserted the rows; just backfill the username column.

update public.users set username = 'alice' where id = 'a0000000-0000-0000-0000-000000000001';
update public.users set username = 'bob'   where id = 'b0000000-0000-0000-0000-000000000002';
update public.users set username = 'carol' where id = 'c0000000-0000-0000-0000-000000000003';
update public.users set username = 'bob1'  where id = 'd0000000-0000-0000-0000-000000000004';

-- ─── Notes (batch insert — one round-trip per user) ───────────────────────

insert into public.notes (user_id, title, content, pinned, archived_at, created_at, updated_at) values
  -- Alice's notes (8 active + 2 archived = 10 total; more than PAGE_SIZE=10 when combined with other users)
  (
    'a0000000-0000-0000-0000-000000000001',
    'Getting started',
    'Welcome to your notes app! Create, edit, pin, archive, and tag notes from the dashboard.',
    true,
    null,
    now() - interval '20 days',
    now() - interval '20 days'
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'Shopping list',
    E'- Milk\n- Eggs\n- Bread\n- Coffee\n- Olive oil\n- Pasta',
    false,
    null,
    now() - interval '14 days',
    now() - interval '3 days'
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'Project ideas',
    'Build a habit tracker. Explore Supabase realtime subscriptions. Write a blog post about RLS and row-level security patterns.',
    false,
    null,
    now() - interval '10 days',
    now() - interval '1 day'
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'Postgres full-text search notes',
    'Use tsvector generated columns with GIN indexes for fast @@ queries. setweight() lets you rank title matches above content matches using ts_rank.',
    false,
    null,
    now() - interval '8 days',
    now() - interval '8 days'
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'Weekly goals',
    E'- Finish pagination feature\n- Review PR #42\n- Update seed data\n- Write unit tests for auth hook',
    false,
    null,
    now() - interval '6 days',
    now() - interval '2 days'
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'Keyboard shortcuts to remember',
    E'Ctrl+K — command palette\nCtrl+Shift+P — VS Code commands\nCtrl+` — toggle terminal\nAlt+Z — word wrap',
    false,
    null,
    now() - interval '5 days',
    now() - interval '5 days'
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'SQL performance tips',
    'Always index foreign keys. Use EXPLAIN ANALYZE before adding indexes. Avoid SELECT *. Prefer partial indexes for filtered queries.',
    false,
    null,
    now() - interval '4 days',
    now() - interval '4 days'
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'Book notes: Designing Data-Intensive Applications',
    'Chapter 2: data models matter. Relational vs document vs graph. Joins are expensive but schemas are valuable. Denormalization trades write complexity for read speed.',
    false,
    null,
    now() - interval '3 days',
    now() - interval '1 day'
  ),
  -- Alice's archived notes
  (
    'a0000000-0000-0000-0000-000000000001',
    'Old meeting agenda 2026-02-14',
    'Team sync. Discussed Q1 roadmap, backlog grooming, and on-call rotation.',
    false,
    now() - interval '2 days',
    now() - interval '30 days',
    now() - interval '30 days'
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'Scratch pad (archived)',
    'Temporary notes from the sprint. No longer relevant.',
    false,
    now() - interval '1 day',
    now() - interval '25 days',
    now() - interval '25 days'
  ),

  -- Bob's notes (7 active)
  (
    'b0000000-0000-0000-0000-000000000002',
    'Meeting notes 2026-03-28',
    'Discussed roadmap priorities. Next sprint focuses on auth improvements and performance. Action: Bob to draft the technical spec.',
    true,
    null,
    now() - interval '4 days',
    now() - interval '4 days'
  ),
  (
    'b0000000-0000-0000-0000-000000000002',
    'Reading list',
    E'- Designing Data-Intensive Applications — Kleppmann\n- The Pragmatic Programmer — Hunt & Thomas\n- SQL Performance Explained — Winand\n- A Philosophy of Software Design — Ousterhout',
    false,
    null,
    now() - interval '7 days',
    now() - interval '2 days'
  ),
  (
    'b0000000-0000-0000-0000-000000000002',
    'Postgres index types cheatsheet',
    E'B-tree — equality, range, sorting (default)\nGIN — arrays, JSONB, full-text search\nGiST — geometry, ranges, nearest-neighbor\nBRIN — large append-only time-series tables\nHash — equality-only, slightly faster than B-tree',
    false,
    null,
    now() - interval '3 days',
    now() - interval '3 days'
  ),
  (
    'b0000000-0000-0000-0000-000000000002',
    'React performance rules',
    'Avoid inline object/array props (new reference every render). Use functional setState. Put interaction logic in event handlers, not effects. Split hooks with independent deps.',
    false,
    null,
    now() - interval '2 days',
    now() - interval '2 days'
  ),
  (
    'b0000000-0000-0000-0000-000000000002',
    'Home network setup',
    E'Router: 192.168.1.1\nNAS: 192.168.1.20\nPi-hole: 192.168.1.25\nRemember to update firmware every quarter.',
    false,
    null,
    now() - interval '12 days',
    now() - interval '12 days'
  ),
  (
    'b0000000-0000-0000-0000-000000000002',
    'Supabase RLS patterns',
    'Always wrap auth.uid() in a sub-SELECT inside policies to avoid per-row evaluation. Force RLS even for table owners. Use SECURITY DEFINER functions sparingly.',
    false,
    null,
    now() - interval '1 day',
    now() - interval '1 day'
  ),
  (
    'b0000000-0000-0000-0000-000000000002',
    'Ideas for side project',
    'A local-first notes app with Supabase sync. Offline support via service worker. Conflict resolution with last-write-wins on updated_at.',
    false,
    null,
    now() - interval '9 hours',
    now() - interval '9 hours'
  ),

  -- Bob1's notes (15 active — enough to trigger Load More pagination)
  (
    'd0000000-0000-0000-0000-000000000004',
    'Welcome note',
    'This account has 15 notes to test the Load More pagination feature.',
    true,
    null,
    now() - interval '30 days',
    now() - interval '30 days'
  ),
  (
    'd0000000-0000-0000-0000-000000000004',
    'Git workflow',
    E'feature branch → PR → squash merge\nKeep commits small and focused. Write the commit message in imperative mood.',
    false,
    null,
    now() - interval '28 days',
    now() - interval '28 days'
  ),
  (
    'd0000000-0000-0000-0000-000000000004',
    'Docker cheatsheet',
    E'docker ps -a          list all containers\ndocker logs -f <id>   tail logs\ndocker exec -it <id> sh   shell into container\ndocker system prune   clean up everything',
    false,
    null,
    now() - interval '26 days',
    now() - interval '26 days'
  ),
  (
    'd0000000-0000-0000-0000-000000000004',
    'TypeScript utility types',
    E'Partial<T>   — all props optional\nRequired<T>  — all props required\nPick<T, K>   — keep only keys K\nOmit<T, K>   — remove keys K\nRecord<K, V> — map type',
    false,
    null,
    now() - interval '24 days',
    now() - interval '24 days'
  ),
  (
    'd0000000-0000-0000-0000-000000000004',
    'CSS variables pattern',
    'Define all design tokens in :root { --color-bg: #fff; }. Use var(--color-bg) everywhere. Override per component with local scope.',
    false,
    null,
    now() - interval '22 days',
    now() - interval '22 days'
  ),
  (
    'd0000000-0000-0000-0000-000000000004',
    'Vim essentials',
    E'i  insert mode\nEsc normal mode\n:w  save\n:q! quit without saving\ndd  delete line\nyy  yank line\np   paste',
    false,
    null,
    now() - interval '20 days',
    now() - interval '20 days'
  ),
  (
    'd0000000-0000-0000-0000-000000000004',
    'HTTP status codes to memorise',
    E'200 OK\n201 Created\n204 No Content\n400 Bad Request\n401 Unauthorized\n403 Forbidden\n404 Not Found\n409 Conflict\n422 Unprocessable Entity\n500 Internal Server Error',
    false,
    null,
    now() - interval '18 days',
    now() - interval '18 days'
  ),
  (
    'd0000000-0000-0000-0000-000000000004',
    'JavaScript array methods',
    'map, filter, reduce, find, findIndex, some, every, flat, flatMap, toSorted, toSpliced. Prefer immutable variants (toSorted over sort) to avoid accidental mutation.',
    false,
    null,
    now() - interval '16 days',
    now() - interval '16 days'
  ),
  (
    'd0000000-0000-0000-0000-000000000004',
    'REST API design notes',
    'Use nouns not verbs in URLs. GET /notes not GET /getNotes. Use plural resource names. PUT replaces, PATCH updates. Return 201 + Location header on create.',
    false,
    null,
    now() - interval '14 days',
    now() - interval '14 days'
  ),
  (
    'd0000000-0000-0000-0000-000000000004',
    'Regex quick reference',
    E'.      any char\n\\d     digit\n\\w     word char\n\\s     whitespace\n^      start\n$      end\n*      0 or more\n+      1 or more\n?      0 or 1\n(a|b)  a or b',
    false,
    null,
    now() - interval '12 days',
    now() - interval '12 days'
  ),
  (
    'd0000000-0000-0000-0000-000000000004',
    'Browser DevTools tips',
    'Use $0 in console to reference the selected element. Ctrl+Shift+P opens the command palette. Network tab throttling simulates slow connections. Performance tab records flame charts.',
    false,
    null,
    now() - interval '10 days',
    now() - interval '10 days'
  ),
  (
    'd0000000-0000-0000-0000-000000000004',
    'SQL window functions',
    E'ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at)\nLAG(col) OVER (ORDER BY col) — previous row value\nLEAD(col) OVER (ORDER BY col) — next row value\nSUM(col) OVER () — running total',
    false,
    null,
    now() - interval '8 days',
    now() - interval '8 days'
  ),
  (
    'd0000000-0000-0000-0000-000000000004',
    'OAuth2 flow reminder',
    'Authorization Code flow: redirect → code → exchange for tokens. Always use PKCE for public clients. Store refresh token securely. Access tokens should be short-lived (15 min).',
    false,
    null,
    now() - interval '6 days',
    now() - interval '6 days'
  ),
  (
    'd0000000-0000-0000-0000-000000000004',
    'Linux commands I keep forgetting',
    E'lsof -i :3000       who is using port 3000\nkill -9 $(lsof -t -i:3000)  force-kill it\ndf -h               disk usage\ndu -sh *            folder sizes\ntail -f /var/log/syslog  live logs',
    false,
    null,
    now() - interval '4 days',
    now() - interval '4 days'
  ),
  (
    'd0000000-0000-0000-0000-000000000004',
    'Next steps for this project',
    'Add real-time sync with Supabase subscriptions. Implement note sharing. Add markdown rendering. Set up CI/CD pipeline. Write integration tests.',
    false,
    null,
    now() - interval '2 days',
    now() - interval '2 hours'
  ),

  -- Carol's notes (5 active)
  (
    'c0000000-0000-0000-0000-000000000003',
    'Recipe: banana bread',
    E'3 ripe bananas\n1 cup sugar\n1/3 cup melted butter\n1 egg\n1 tsp vanilla\n1 tsp baking soda\n1.5 cups flour\n\nMix wet then dry. Bake 350°F for 55 min.',
    false,
    null,
    now() - interval '6 days',
    now() - interval '6 days'
  ),
  (
    'c0000000-0000-0000-0000-000000000003',
    'Travel checklist',
    E'- Passport (check expiry!)\n- Travel insurance docs\n- Power adapters\n- Download offline maps\n- Notify bank of travel dates',
    false,
    null,
    now() - interval '3 days',
    now()
  ),
  (
    'c0000000-0000-0000-0000-000000000003',
    'Garden planting schedule',
    E'March — start tomatoes and peppers indoors\nApril — transplant seedlings after last frost\nMay — direct sow beans and squash\nJune — first harvest of lettuce',
    false,
    null,
    now() - interval '5 days',
    now() - interval '5 days'
  ),
  (
    'c0000000-0000-0000-0000-000000000003',
    'Book club — next pick',
    'Voting between: Tomorrow, and Tomorrow, and Tomorrow (Zevin) vs Piranesi (Clarke). Meeting on the 15th.',
    false,
    null,
    now() - interval '2 days',
    now() - interval '2 days'
  ),
  (
    'c0000000-0000-0000-0000-000000000003',
    'Workout routine',
    E'Mon/Wed/Fri — strength (compound lifts)\nTue/Thu — 30 min cardio\nSat — long walk or hike\nSun — rest\n\nTrack progressive overload weekly.',
    false,
    null,
    now() - interval '1 day',
    now() - interval '6 hours'
  );

-- ─── Tags ─────────────────────────────────────────────────────────────────

insert into public.tags (user_id, name) values
  ('a0000000-0000-0000-0000-000000000001', 'personal'),
  ('a0000000-0000-0000-0000-000000000001', 'work'),
  ('a0000000-0000-0000-0000-000000000001', 'shopping'),
  ('a0000000-0000-0000-0000-000000000001', 'dev'),
  ('b0000000-0000-0000-0000-000000000002', 'work'),
  ('b0000000-0000-0000-0000-000000000002', 'reading'),
  ('b0000000-0000-0000-0000-000000000002', 'dev'),
  ('c0000000-0000-0000-0000-000000000003', 'personal'),
  ('c0000000-0000-0000-0000-000000000003', 'recipes'),
  ('d0000000-0000-0000-0000-000000000004', 'dev'),
  ('d0000000-0000-0000-0000-000000000004', 'reference');

-- ─── Note tags ────────────────────────────────────────────────────────────

insert into public.note_tags (note_id, tag_id)
select n.id, t.id
from public.notes n
join public.tags t on t.user_id = n.user_id
where
  -- Alice
  (n.title = 'Getting started'                        and t.name = 'personal' and n.user_id = 'a0000000-0000-0000-0000-000000000001')
  or (n.title = 'Shopping list'                       and t.name = 'shopping' and n.user_id = 'a0000000-0000-0000-0000-000000000001')
  or (n.title = 'Project ideas'                       and t.name = 'work'     and n.user_id = 'a0000000-0000-0000-0000-000000000001')
  or (n.title = 'Postgres full-text search notes'     and t.name = 'dev'      and n.user_id = 'a0000000-0000-0000-0000-000000000001')
  or (n.title = 'Weekly goals'                        and t.name = 'work'     and n.user_id = 'a0000000-0000-0000-0000-000000000001')
  or (n.title = 'SQL performance tips'                and t.name = 'dev'      and n.user_id = 'a0000000-0000-0000-0000-000000000001')
  or (n.title = 'Book notes: Designing Data-Intensive Applications' and t.name = 'personal' and n.user_id = 'a0000000-0000-0000-0000-000000000001')
  -- Bob
  or (n.title = 'Meeting notes 2026-03-28'            and t.name = 'work'     and n.user_id = 'b0000000-0000-0000-0000-000000000002')
  or (n.title = 'Reading list'                        and t.name = 'reading'  and n.user_id = 'b0000000-0000-0000-0000-000000000002')
  or (n.title = 'Postgres index types cheatsheet'     and t.name = 'dev'      and n.user_id = 'b0000000-0000-0000-0000-000000000002')
  or (n.title = 'React performance rules'             and t.name = 'dev'      and n.user_id = 'b0000000-0000-0000-0000-000000000002')
  or (n.title = 'Supabase RLS patterns'               and t.name = 'dev'      and n.user_id = 'b0000000-0000-0000-0000-000000000002')
  or (n.title = 'Ideas for side project'              and t.name = 'dev'      and n.user_id = 'b0000000-0000-0000-0000-000000000002')
  -- Carol
  or (n.title = 'Recipe: banana bread'                and t.name = 'recipes'  and n.user_id = 'c0000000-0000-0000-0000-000000000003')
  or (n.title = 'Travel checklist'                    and t.name = 'personal' and n.user_id = 'c0000000-0000-0000-0000-000000000003')
  or (n.title = 'Workout routine'                     and t.name = 'personal' and n.user_id = 'c0000000-0000-0000-0000-000000000003')
  -- Bob1
  or (n.title = 'Welcome note'                         and t.name = 'dev'        and n.user_id = 'd0000000-0000-0000-0000-000000000004')
  or (n.title = 'Git workflow'                         and t.name = 'dev'        and n.user_id = 'd0000000-0000-0000-0000-000000000004')
  or (n.title = 'Docker cheatsheet'                    and t.name = 'reference'  and n.user_id = 'd0000000-0000-0000-0000-000000000004')
  or (n.title = 'TypeScript utility types'             and t.name = 'reference'  and n.user_id = 'd0000000-0000-0000-0000-000000000004')
  or (n.title = 'HTTP status codes to memorise'        and t.name = 'reference'  and n.user_id = 'd0000000-0000-0000-0000-000000000004')
  or (n.title = 'JavaScript array methods'             and t.name = 'dev'        and n.user_id = 'd0000000-0000-0000-0000-000000000004')
  or (n.title = 'REST API design notes'                and t.name = 'dev'        and n.user_id = 'd0000000-0000-0000-0000-000000000004')
  or (n.title = 'SQL window functions'                 and t.name = 'reference'  and n.user_id = 'd0000000-0000-0000-0000-000000000004')
  or (n.title = 'OAuth2 flow reminder'                 and t.name = 'dev'        and n.user_id = 'd0000000-0000-0000-0000-000000000004');
