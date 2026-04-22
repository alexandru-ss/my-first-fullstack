## Why

The project has no test suite, leaving critical flows — authentication, note and document CRUD, sharing, and real-time collaboration — unverified. Adding specs alongside tests establishes a living contract for the existing behavior and prevents regressions as the codebase evolves.

## What Changes

- Install Vitest and React Testing Library as dev dependencies in `frontend/`
- Add `vitest.config.js` and a jsdom test environment
- Write unit tests for React hooks (`useAuth`, `useTheme`)
- Write component tests for all major UI components (`AuthForm`, `NotesList`, `NoteEditor`, `SharePanel`, `DocumentsList`, `DocumentEditor`)
- Write integration tests for the Supabase client wrapper (`lib/supabase.js`) using mocks
- Create behavioral specs (`openspec/specs/`) for auth, notes, and documents
- Add a `test` script to `frontend/package.json`

## Capabilities

### New Capabilities
- `auth`: Sign-in / sign-up / sign-out flow, session persistence, and route protection
- `notes`: Note CRUD, pinning, archiving, tagging, full-text search, file attachments, and sharing
- `documents`: Collaborative documents (Yjs), document CRUD, and sharing

### Modified Capabilities
<!-- None — no existing specs to modify -->

## Impact

- `frontend/package.json` — new devDependencies (vitest, @vitest/ui, jsdom, @testing-library/react, @testing-library/user-event, @testing-library/jest-dom)
- `frontend/vitest.config.js` — new test config file
- `frontend/src/**/__tests__/` — new test files (no existing files modified)
- `openspec/specs/` — new spec files for auth, notes, documents
