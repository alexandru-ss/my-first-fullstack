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
│   │   ├── hooks/useAuth.js    # Auth state hook
│   │   ├── components/
│   │   │   ├── AuthForm.jsx    # Sign-in / sign-up form
│   │   │   ├── NotesList.jsx   # Notes list with delete
│   │   │   └── NoteEditor.jsx  # Create / edit modal
│   │   ├── App.jsx             # App shell
│   │   └── index.css           # Global CSS variables + base styles
│   └── package.json
└── supabase/
    ├── config.toml             # Local Supabase project config
    ├── migrations/
    │   └── 20260401000000_create_users_notes.sql   # Schema + RLS policies
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
auth.users          (managed by Supabase Auth)
    └── public.users        id (fk), email, username, created_at, updated_at
            └── public.notes    id, user_id (fk), title, content, created_at, updated_at
```

RLS policies on `public.notes` enforce that every SELECT, INSERT, UPDATE, and DELETE is restricted to rows where `user_id = auth.uid()`. The `auth.uid()` call is wrapped in a sub-SELECT so it is evaluated once per statement, not once per row.

---

## Deploying to production

1. Create a project at https://supabase.com and note its URL and anon key.
2. Push migrations: `npx supabase db push` (after linking with `npx supabase link`).
3. Deploy the frontend to any static host (Vercel, Netlify, Cloudflare Pages).
4. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as environment variables in your host's dashboard.
