## ADDED Requirements

### Requirement: Initial session load
The system SHALL resolve the current auth session on mount before rendering protected routes. The `useAuth` hook SHALL return `loading: true` until the session is resolved, then `loading: false`.

#### Scenario: No existing session
- **WHEN** the application mounts and no Supabase session exists
- **THEN** `useAuth` returns `{ session: null, user: null, loading: false }` after the async check completes

#### Scenario: Existing session
- **WHEN** the application mounts and a valid Supabase session is cached
- **THEN** `useAuth` returns the session object and the derived `user` object with `loading: false`

#### Scenario: Loading state
- **WHEN** the application mounts and `getSession()` has not yet resolved
- **THEN** `useAuth` returns `{ loading: true }` and the app renders a loading indicator instead of the auth form or main content

### Requirement: Sign-in form submission
The system SHALL allow a user to sign in with email and password using `AuthForm`. On success the auth state change listener updates the session automatically.

#### Scenario: Successful sign-in
- **WHEN** the user submits the sign-in form with valid credentials
- **THEN** `supabase.auth.signInWithPassword` is called with the provided email and password and no error is displayed

#### Scenario: Failed sign-in
- **WHEN** the user submits the sign-in form with invalid credentials and Supabase returns an error
- **THEN** the error message is displayed in a `role="alert"` element and the form is not disabled permanently

#### Scenario: Submit button disabled while loading
- **WHEN** the form submission is in progress
- **THEN** the submit button is disabled to prevent duplicate requests

### Requirement: Sign-up form submission
The system SHALL allow a user to create an account. On success a confirmation message is displayed.

#### Scenario: Successful sign-up
- **WHEN** the user switches to sign-up mode and submits valid credentials
- **THEN** `supabase.auth.signUp` is called and a success message is shown prompting the user to check their email

#### Scenario: Switch between modes
- **WHEN** the user clicks the mode toggle link
- **THEN** the form heading changes between "Sign in" and "Create account" and any existing error or success messages are cleared

### Requirement: Sign-out
The system SHALL allow an authenticated user to sign out. After sign-out the session is cleared and the auth form is shown.

#### Scenario: Sign-out clears session
- **WHEN** the authenticated user clicks "Sign out"
- **THEN** `supabase.auth.signOut` is called and the UI returns to the unauthenticated state

### Requirement: Auth state change subscription
The `useAuth` hook SHALL subscribe to `onAuthStateChange` and update the session whenever the auth state changes. The subscription SHALL be cleaned up on unmount.

#### Scenario: Auth state change updates session
- **WHEN** `onAuthStateChange` fires with a new session
- **THEN** `useAuth` updates the returned `session` and `user` values

#### Scenario: Subscription cleaned up on unmount
- **WHEN** the component using `useAuth` unmounts
- **THEN** `subscription.unsubscribe()` is called
