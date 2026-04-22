## Context

The frontend is a React 19 + Vite app with no existing test suite. It uses Supabase for auth and data, Yjs + a custom broadcast provider for collaborative documents, and React Router for navigation. All components are `.jsx` files without TypeScript strict mode. Supabase calls are centralised in `src/lib/supabase.js` and the two custom hooks (`useAuth`, `useTheme`).

## Goals / Non-Goals

**Goals:**
- Add Vitest with jsdom as the test runner and environment for the `frontend/` package
- Install React Testing Library for component and hook tests
- Achieve meaningful coverage for the three core capability areas: auth, notes, and documents
- Mock the Supabase client at the module boundary so tests remain fast and offline
- Write tests that match the behavioral specs being created in `openspec/specs/`

**Non-Goals:**
- End-to-end browser tests (no Playwright or Cypress in this change)
- Backend / Supabase RLS testing (covered by SQL snippets separately)
- 100 % line coverage — focus on critical paths and regression guards
- CI/CD pipeline changes (out of scope for this change)

## Decisions

### Test framework: Vitest over Jest
Vitest is the natural choice for a Vite project. It shares the Vite config (aliases, plugins), runs tests in parallel, and requires zero additional transform setup for JSX. Jest would need `babel-jest` + extra config.

### jsdom over happy-dom
jsdom is the battle-tested environment for React Testing Library; happy-dom has edge cases with some DOM APIs used by React 19 and Supabase. Safer default.

### Mock strategy: `vi.mock('../../lib/supabase')`
All Supabase SDK calls go through `src/lib/supabase.js`. A single `vi.mock` at the module boundary returns a controlled fake client. This avoids network calls without needing msw, keeps tests synchronous, and is easy to understand.

### Test file layout: co-located `__tests__/` directories
Test files live next to the code they test (e.g., `src/components/__tests__/NotesList.test.jsx`). This is standard Vitest/CRA convention and avoids a separate top-level `tests/` tree that drifts from the source layout.

### Hook testing: `renderHook` from RTL
`useAuth` subscribes to `supabase.auth.onAuthStateChange`. We mock the subscription and fire state changes manually to test session/loading states without a real Supabase connection.

## Risks / Trade-offs

- **Yjs + SupabaseBroadcastProvider complexity** → The `DocumentEditor` component wires Yjs awareness, making isolated render tests fragile. Mitigation: test only the React layer (component renders, button states, prop handling); leave Yjs protocol correctness to the existing `test_yjs_*.cjs` scripts.
- **React 19 concurrent mode** → RTL 14+ handles concurrent mode correctly; pin `@testing-library/react` to `^14` to stay aligned.
- **Supabase auth listeners leak** → `useAuth` relies on `supabase.auth.onAuthStateChange` returning an `{ data: { subscription } }` object. Mock must replicate this shape or the hook throws on cleanup.

## Migration Plan

1. Install devDependencies in `frontend/` — no production impact.
2. Add `vitest.config.js` alongside `vite.config.js`.
3. Add `"test": "vitest"` and `"test:ui": "vitest --ui"` to `package.json` scripts.
4. Create `src/setupTests.js` that imports `@testing-library/jest-dom/vitest`.
5. Write tests incrementally — CI passes on first merge because no prior test script existed.
6. Rollback: remove the devDependencies and test files; no production code is touched.

## Open Questions

- Should `@vitest/coverage-v8` be added now to gate CI on coverage thresholds? Deferred — add in a follow-up once a baseline is established.
