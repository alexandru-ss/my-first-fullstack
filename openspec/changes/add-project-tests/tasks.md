## 1. Test Infrastructure Setup

- [ ] 1.1 Install Vitest, jsdom, @testing-library/react, @testing-library/user-event, and @testing-library/jest-dom as devDependencies in `frontend/`
- [ ] 1.2 Add `"test": "vitest"` and `"test:ui": "vitest --ui"` scripts to `frontend/package.json`
- [ ] 1.3 Create `frontend/vitest.config.js` with jsdom environment and setupFiles pointing to `src/setupTests.js`
- [ ] 1.4 Create `frontend/src/setupTests.js` that imports `@testing-library/jest-dom/vitest`
- [ ] 1.5 Create `frontend/src/__mocks__/supabase.js` — a vi.mock factory exporting a typed fake Supabase client (auth + from/select/insert/update/delete chain)

## 2. Auth Specs Tests

- [ ] 2.1 Create `frontend/src/hooks/__tests__/useAuth.test.js` — test initial loading state, resolved session, null session, auth state change updates, and subscription cleanup on unmount
- [ ] 2.2 Create `frontend/src/components/__tests__/AuthForm.test.jsx` — test sign-in submission calls `signInWithPassword`, sign-up submission calls `signUp`, error message renders in `role="alert"`, success message on sign-up, mode toggle clears messages, and submit button disabled while in-flight

## 3. Notes Specs Tests

- [ ] 3.1 Create `frontend/src/components/__tests__/NotesList.test.jsx` — test loading state, populated list render, empty state, error state, search bar render and clear-button visibility
- [ ] 3.2 Add test for tag pill click invokes `onTagClick` callback in `NotesList`
- [ ] 3.3 Add test for pinned note renders `note-item--pinned` class
- [ ] 3.4 Create `frontend/src/components/__tests__/SharePanel.test.jsx` — test email input and form submission calls `note_shares` insert

## 4. Documents Specs Tests

- [ ] 4.1 Create `frontend/src/components/__tests__/DocumentsList.test.jsx` — test loading state, document items render with title, body preview truncation at 120 chars, link to `/documents/<id>`, and delete button calls Supabase delete
- [ ] 4.2 Create `frontend/src/components/__tests__/DocumentSharePanel.test.jsx` — test email input and form submission calls `document_shares` insert
- [ ] 4.3 Create `frontend/src/components/__tests__/DocumentEditor.test.jsx` — test loading indicator renders, title is displayed after load (mock Yjs/broadcast provider)

## 5. Validation

- [ ] 5.1 Run `npm test` in `frontend/` and confirm all tests pass with no errors
- [ ] 5.2 Fix any import path or mock shape issues surfaced by the test run
- [ ] 5.3 Confirm the test count covers all scenarios listed in `specs/auth/spec.md`, `specs/notes/spec.md`, and `specs/documents/spec.md`
