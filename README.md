# my-first-fullstack

A private notes app: users sign up, sign in, and manage their own notes. Data is stored in Postgres and protected by Row-Level Security — no note is ever accessible to another user, even via the API.

**Stack:** React 19 + Vite · Supabase (Auth, Postgres, RLS) · local-first development via Supabase CLI

---

## What it does

| Feature | How |
|---|---|
| Sign up / sign in / sign out | Supabase Auth (email + password) |
| Private notes per user | RLS policies — each user can only read/write their own rows |
| Create, edit, delete notes | Full CRUD via `@supabase/supabase-js` client |
| Typed database access | Auto-generated `database.types.ts` wired into the Supabase client |
| Pin notes | `notes.pinned` boolean; partial index keeps pinned queries fast |
| Archive notes | `notes.archived_at` timestamptz; NULL = active, non-NULL = archived; separate partial indexes for each hot path |
| Tag notes | `tags` + `note_tags` junction tables with full RLS; each user owns their own tag vocabulary |
| Full-text search | `notes.search_vector` GENERATED ALWAYS tsvector (title A · content B); GIN index; search scoped by RLS |
| File attachments | Private `attachments` storage bucket; `note_attachments` metadata table; signed-URL previews; 10 MB / allowed-type validation |
| User profiles & avatars | `users.avatar_path` + private `avatars` bucket; display-name editing; initials fallback |
| Share notes | `note_shares` table with `view` / `edit` permission enum; email-based invite via `find_user_by_email()` RPC; owners can revoke |
| Real-time sync | Supabase Realtime on `notes`, `note_attachments`, and `note_shares`; REPLICA IDENTITY FULL on all three |
| Dark / light theme | `useTheme` hook; OS-preference detection; localStorage persistence; CSS custom-property theming |

---

## Prerequisites

| Tool | Min version | Install |
|---|---|---|
| Node.js | 18 | https://nodejs.org |
| Docker Desktop | any recent | https://www.docker.com/products/docker-desktop (must be running) |
| Supabase CLI | 2.x | `npm install -g supabase` or `npx supabase` |

---

## Folder structure

```
my-first-fullstack/
├── frontend/                   # Vite + React 19 app
│   ├── .env                    # Local Supabase URL + anon key (gitignored)
│   ├── src/
│   │   ├── database.types.ts   # Auto-generated — do not edit by hand
│   │   ├── lib/supabase.js     # Supabase client singleton
│   │   ├── hooks/
│   │   │   ├── useAuth.js      # Auth state hook (session, user, loading)
│   │   │   └── useTheme.js     # Dark/light theme with localStorage persistence
│   │   ├── components/
│   │   │   ├── AuthForm.jsx        # Sign-in / sign-up form
│   │   │   ├── NotesList.jsx       # Notes list — active/archived tabs, search, tags, realtime
│   │   │   ├── NoteEditor.jsx      # Create / edit modal with file attachments
│   │   │   ├── FilePreview.jsx     # Full-screen image preview overlay
│   │   │   ├── ProfileEditor.jsx   # Display name + avatar upload modal
│   │   │   ├── SharePanel.jsx      # Share-note modal (invite, permissions, revoke)
│   │   │   └── SharedNotesList.jsx # Notes shared with the current user
│   │   ├── App.jsx             # App shell
│   │   └── index.css           # Global CSS variables + base styles
│   └── package.json
└── supabase/
    ├── config.toml             # Local Supabase project config
    ├── migrations/
    │   ├── 20260401000000_create_users_notes.sql       # Base schema: users, notes, RLS
    │   ├── 20260401000001_notes_add_pinned.sql         # notes.pinned + partial index
    │   ├── 20260401000002_notes_add_archived_at.sql    # notes.archived_at + partial indexes
    │   ├── 20260401000003_notes_add_tags.sql           # tags + note_tags tables, RLS
    │   ├── 20260401000004_backfill_users.sql           # Idempotent handle_new_user trigger
    │   ├── 20260401000005_notes_add_search_vector.sql  # Full-text search tsvector + GIN index
    │   ├── 20260401000006_notes_realtime.sql           # Realtime publication for notes
    │   ├── 20260401000007_users_add_avatar.sql         # users.avatar_path + avatars bucket
    │   ├── 20260401000008_notes_add_attachments.sql    # note_attachments table + attachments bucket
    │   ├── 20260401000009_note_attachments_realtime.sql # Realtime for note_attachments
    │   ├── 20260401000010_notes_add_shares.sql         # note_shares, note_permission enum, helper RPCs
    │   ├── 20260401000011_fix_notes_update_policy.sql  # Fix RLS recursion in UPDATE policy
    │   ├── 20260401000012_note_shares_realtime.sql     # Realtime for note_shares
    │   ├── 20260401000013_fix_shared_attachment_realtime.sql  # Fix Realtime DELETE for shared attachments
    │   ├── 20260401000014_fix_note_attachments_shared_policy.sql # Fix ambiguous column in shared policy
    │   └── 20260401000015_note_attachments_composite_pk.sql  # Composite PK (note_id, id) for Realtime
    └── seed.sql                # Sample users and notes for local dev
```

---

## Running locally from scratch

### 1. Clone and enter the repo

```bash
git clone <your-repo-url>
cd my-first-fullstack
```

### 2. Start the local Supabase stack

```bash
npx supabase start
```

This spins up Postgres, Auth, the REST API, and Supabase Studio in Docker. On first run it pulls images — allow a few minutes.

When it finishes, the output shows your local credentials:

```
API URL: http://127.0.0.1:54321
Publishable key: sb_publishable_...
```

### 3. Apply migrations and seed data

```bash
npx supabase db reset
```

This runs all files in `supabase/migrations/` then `supabase/seed.sql`, creating the `users` and `notes` tables, RLS policies, and three seed users.

> If you've just run `supabase start` for the first time, migrations are applied automatically. Use `db reset` any time you want to return to a clean state.

### 4. Install frontend dependencies

```bash
cd frontend
npm install
```

### 5. Configure environment variables

`frontend/.env` is already populated with local credentials when you followed steps 2–3. If you need to recreate it:

```bash
# from repo root
npx supabase status
```

Copy the `Project URL` and `Publishable` key into `frontend/.env`:

```env
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<publishable key from supabase status>
```

### 6. Start the dev server

```bash
# inside frontend/
npm run dev
```

Open http://localhost:5173.

### 7. Sign in with a seed account

| Email | Password |
|---|---|
| alice@example.com | password123 |
| bob@example.com | password123 |
| carol@example.com | password123 |

Or create a new account — it will work straight away because email confirmation is disabled in the local config.

---

## Useful commands

### Supabase CLI (run from repo root)

```bash
npx supabase start          # start local stack
npx supabase stop           # stop (keeps data)
npx supabase stop --no-backup  # stop and wipe all data
npx supabase status         # show URLs and keys
npx supabase db reset       # re-run all migrations + seed
npx supabase studio         # open Supabase Studio in browser (http://127.0.0.1:54323)
```

### Regenerate database types

Run this whenever you change the schema (add a column, new table, etc.):

```bash
# from repo root
npx supabase gen types --lang typescript --local > frontend/src/database.types.ts
```

The generated file is imported by `src/lib/supabase.js` to type all query results automatically.

### Frontend (run from `frontend/`)

```bash
npm run dev       # start dev server with HMR
npm run build     # production build → dist/
npm run lint      # ESLint
npm run preview   # serve the production build locally
```

---

## Database schema

```
auth.users                      (managed by Supabase Auth)
└── public.users                id (fk), email, username, avatar_path, created_at, updated_at
        └── public.notes        id, user_id (fk), title, content,
                                pinned, archived_at, search_vector,
                                created_at, updated_at
                ├── public.note_tags        note_id (fk), tag_id (fk)
                ├── public.note_attachments (note_id, id) PK, user_id (fk),
                │                           storage_path, file_name, mime_type,
                │                           size_bytes, created_at
                └── public.note_shares      id, note_id (fk), owner_id (fk),
                                            shared_with_email, shared_with_id (fk),
                                            permission (view|edit), created_at
public.tags                     id, user_id (fk), name  [UNIQUE(user_id, name)]
```

**Storage buckets (both private):**

| Bucket | Path structure | Purpose |
|---|---|---|
| `avatars` | `<user_id>/avatar.png` | User profile pictures |
| `attachments` | `<user_id>/<note_id>/<filename>` | Note file attachments |

**Key helper functions (SECURITY DEFINER):**

| Function | Purpose |
|---|---|
| `has_note_share_access(note_id)` | True if caller has any share (view or edit) on the note |
| `has_note_edit_permission(note_id)` | True if caller has an edit-permission share |
| `has_share_from_user(owner_id)` | True if caller has any share from that owner (used by avatar storage policy) |
| `find_user_by_email(email)` | Resolves email → (id, username) for share creation |
| `get_note_owner(note_id)` | Returns note owner uuid; bypasses RLS to prevent recursive policy evaluation |

**Realtime** is enabled (REPLICA IDENTITY FULL) on `notes`, `note_attachments`, and `note_shares`.

RLS policies on all tables enforce that users can only access their own rows — or rows explicitly shared with them via `note_shares`. The `auth.uid()` call is wrapped in a sub-SELECT so it is evaluated once per statement, not once per row.

---

## Deploying to production

1. Create a project at https://supabase.com and note its URL and anon key.
2. Push migrations: `npx supabase db push` (after linking with `npx supabase link`).
3. Deploy the frontend to any static host (Vercel, Netlify, Cloudflare Pages).
4. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as environment variables in your host's dashboard.
