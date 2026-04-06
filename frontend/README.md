# Notes App — Frontend

A private notes app built with **React 19 + Vite**, backed by **Supabase** for authentication and data persistence. Every user sees only their own notes, enforced at the database level with Row-Level Security.

---

## Quick start

```bash
# 1. Start the local Supabase stack (from the repo root)
npx supabase start

# 2. Install dependencies
cd frontend
npm install

# 3. Start the dev server
npm run dev
```

Open http://localhost:5173. Sign in with a seed account (`alice@example.com` / `password123`) or create a new one.

---

## Project structure

```
frontend/
├── .env                        # Local Supabase URL + anon key (gitignored)
└── src/
    ├── database.types.ts       # Auto-generated Supabase types (do not edit)
    ├── lib/
    │   └── supabase.js         # Module-level Supabase client singleton
    ├── hooks/
    │   ├── useAuth.js          # Auth state hook (session, user, loading)
    │   └── useTheme.js         # Dark/light theme with OS-detection + localStorage
    ├── components/
    │   ├── AuthForm.jsx        # Sign-in / sign-up form
    │   ├── NotesList.jsx       # Active/archived tabs, full-text search, tag filter, realtime
    │   ├── NoteEditor.jsx      # Create/edit modal with file attachment upload/preview/delete
    │   ├── FilePreview.jsx     # Full-screen image preview overlay (Escape / backdrop to close)
    │   ├── ProfileEditor.jsx   # Display name + avatar upload modal
    │   ├── SharePanel.jsx      # Share-note modal — invite by email, set permission, revoke
    │   └── SharedNotesList.jsx # Notes shared with the current user, with owner attribution
    ├── App.jsx                 # App shell — routes between auth/notes/shared UI
    ├── App.css                 # App-specific styles (reuses index.css tokens)
    └── index.css               # Global CSS variables + base styles
```

---

## Architecture decisions

### Authentication — `useAuth.js`

`supabase.auth.getSession()` is called once on mount to hydrate the initial session, then `onAuthStateChange` keeps it in sync for the rest of the session lifetime (sign-in, sign-out, token refresh). The subscription is cleaned up when the hook unmounts to avoid memory leaks.

The hook returns `{ session, user, loading }`. `App.jsx` reads these to decide which UI to render — no router needed for a two-state app.

### Supabase client — `src/lib/supabase.js`

A single `createClient` call at module level creates one shared client for the whole app. This avoids reconnecting on every render and is the pattern recommended in the Supabase docs.

The client is typed with the generated `Database` type from `database.types.ts`, giving full TypeScript/JSDoc autocomplete on `.from('notes')` queries.

**Why a direct import?** The Vercel React best-practices skill flags barrel file imports as a critical bundle issue (200–800 ms import cost). `@supabase/supabase-js` exports `createClient` cleanly so no sub-path import is needed, but the principle is the same — import only what you use.

### Component design — `rerender-no-inline-components`

All components (`Header`, `NoteItem`, `AuthForm`, `NotesList`, `NoteEditor`) are defined at **module scope**, never inside another component's render function. Defining a component inside another creates a new component *type* on every render; React treats it as a different component each time, unmounts the old instance, and remounts the new one — destroying all state and triggering all effects unnecessarily.

### Effect dependencies — `rerender-dependencies`

`NotesList` and `NoteEditor` both accept a `userId` string prop and use it as the `useEffect` dependency, **not** the full `user` object. An object reference changes on every re-render even when the underlying data is identical, causing spurious re-fetches. A primitive string only changes when the identity actually changes.

### Optimistic list update — avoiding the double-fetch waterfall

After `NoteEditor` saves a note, the server response already contains the persisted row. Instead of re-fetching the whole list, `App.jsx` holds a `listRef` that points to an imperative `upsert` function inside `NotesList`. `handleSaved` calls `listRef.current.upsert(savedNote)` to push the data directly into the list's state — zero extra network round-trips.

### Functional `setState` — `rerender-functional-setstate`

Anywhere state is updated based on its previous value (`notes.filter(...)`, `[note, ...curr]`), the functional form of `setState(curr => ...)` is used. This eliminates stale-closure bugs and means the callbacks never need `notes` in their dependency array, keeping them stable across renders.

### Theme — `useTheme.js`

`useTheme` reads `localStorage` first, then falls back to `window.matchMedia('(prefers-color-scheme: dark)')` as a lazy initializer (passed by reference, not called eagerly). `toggleTheme` uses functional `setState` with an empty dependency array so the callback reference is stable across renders. The chosen theme is written to `document.documentElement.dataset.theme`, picked up by CSS custom-property overrides in `index.css`.

### Realtime sync

All three mutable tables (`notes`, `note_attachments`, `note_shares`) have `REPLICA IDENTITY FULL` and are added to the `supabase_realtime` publication. Components subscribe using `supabase.channel()` and update local state imperatively on INSERT / UPDATE / DELETE events — no full re-fetch needed.

`note_attachments` uses a composite primary key `(note_id, id)` so DELETE events always include `note_id`, allowing both owner and shared-user subscribers to locate the correct parent note.

### File attachments

`NoteEditor` validates MIME type and file size (10 MB max) on the client before uploading to the private `attachments` bucket under `<userId>/<noteId>/<filename>`. Metadata is stored in `note_attachments`; display uses short-lived signed URLs generated on demand. `FilePreview` renders images inline in a full-screen overlay; PDFs open in a new tab.

### Note sharing

`SharePanel` resolves the invitee's email via the `find_user_by_email()` SECURITY DEFINER RPC (which returns only non-sensitive columns), then inserts a `note_shares` row with the requested `view` or `edit` permission. Shared notes appear in `SharedNotesList` with owner attribution (avatar + username). Editors open `NoteEditor` with the permission level threaded in so the UI can correctly gate destructive actions.

### User avatars

`ProfileEditor` uploads the file to `avatars/<userId>/avatar.png` (upsert), stores only the storage path in `users.avatar_path`, and generates a signed URL separately for display. This prevents signed-URL expiry from invalidating cached DB data and keeps the URL out of the database.

### Styles

`App.css` is written entirely in terms of the CSS custom properties defined in `index.css` (`--bg`, `--text`, `--accent`, `--border`, `--shadow`, etc.). Manual dark mode is applied via `document.documentElement.dataset.theme = 'dark'|'light'`, which overrides the `@media (prefers-color-scheme: dark)` defaults in `index.css` — so the toggle works even when the OS preference doesn't match the user's explicit choice.

---

## Environment variables

| Variable | Description |
|---|---|
| `VITE_SUPABASE_URL` | Your Supabase project URL (local: `http://127.0.0.1:54321`) |
| `VITE_SUPABASE_ANON_KEY` | The publishable/anon key (safe to expose in browser) |

Copy `.env` to `.env.local` when deploying to a hosted environment and replace with your production project's values from the [Supabase dashboard](https://supabase.com/dashboard/project/_/settings/api).

---

## Database

Schema and RLS policies live in `supabase/migrations/`. The seed file (`supabase/seed.sql`) inserts three users and sample notes for local development.

```
supabase db reset   # re-runs all migrations + seed
supabase db seed    # seed only (on an already-migrated DB)
```

Tables: `users`, `notes`, `tags`, `note_tags`, `note_attachments`, `note_shares`.  
Storage buckets: `avatars` (profile pictures), `attachments` (note files) — both private.

RLS ensures each user can only read, create, edit, and delete **their own** rows — or rows explicitly shared with them via `note_shares`. The policy uses `(select auth.uid()) = user_id`, wrapping `auth.uid()` in a sub-SELECT so it is evaluated once per statement rather than once per row — a critical performance pattern for large tables.

