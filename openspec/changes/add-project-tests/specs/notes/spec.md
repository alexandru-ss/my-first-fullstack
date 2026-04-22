## ADDED Requirements

### Requirement: List active notes
The system SHALL display the authenticated user's active (non-archived) notes ordered by `updated_at` descending. Notes are fetched from Supabase on mount and updated via a realtime subscription.

#### Scenario: Notes load on mount
- **WHEN** `NotesList` renders with a valid `userId`
- **THEN** a loading indicator is shown initially, then the notes are listed once the fetch resolves

#### Scenario: Empty state
- **WHEN** the user has no active notes
- **THEN** an empty-state message is displayed instead of a list

#### Scenario: Error state
- **WHEN** the Supabase fetch returns an error
- **THEN** an error message is displayed

### Requirement: Search notes
The system SHALL filter the displayed notes in real-time as the user types in the search bar. The search queries the database via Supabase full-text search.

#### Scenario: Search filters list
- **WHEN** the user types a query into the search bar
- **THEN** only notes whose title or content match the query are displayed

#### Scenario: Clear search
- **WHEN** the user clicks the clear button in the search bar
- **THEN** the search query is cleared and all notes are displayed again

#### Scenario: Clear button visibility
- **WHEN** the search input is empty
- **THEN** the clear button is not rendered

### Requirement: Pin a note
The system SHALL allow the user to pin or unpin a note. Pinned notes SHALL appear at the top of the active notes list with a visual indicator.

#### Scenario: Pin note
- **WHEN** the user clicks the pin button on an unpinned note
- **THEN** `supabase.from('notes').update({ pinned: true })` is called for that note

#### Scenario: Pinned note styling
- **WHEN** a note has `pinned: true` in the active view
- **THEN** it renders with the `note-item--pinned` CSS class

### Requirement: Archive a note
The system SHALL allow the user to archive a note. Archived notes are removed from the active view and shown in the archived view.

#### Scenario: Archive note
- **WHEN** the user clicks the archive button on an active note
- **THEN** `supabase.from('notes').update({ archived_at: <timestamp> })` is called and the note is removed from the active list

#### Scenario: Unarchive note
- **WHEN** the user clicks the unarchive button on an archived note
- **THEN** `supabase.from('notes').update({ archived_at: null })` is called

### Requirement: Tag filtering
The system SHALL allow the user to filter notes by clicking a tag pill. Clicking a tag shows only notes that have that tag.

#### Scenario: Tag click filters notes
- **WHEN** the user clicks a tag pill on a note
- **THEN** the active tag filter is set and notes are refetched with the tag filter applied

### Requirement: Create and edit a note
The system SHALL allow the user to create a new note and edit an existing note via `NoteEditor`. The editor SHALL auto-save changes with a debounce.

#### Scenario: Create note
- **WHEN** the user opens the editor in create mode and fills in a title
- **THEN** `supabase.from('notes').insert` is called with the title and content on save

#### Scenario: Edit note auto-saves
- **WHEN** the user modifies the title or content of an existing note
- **THEN** the changes are saved to Supabase after the debounce interval

### Requirement: Share a note
The system SHALL allow the user to share a note with another user by email using `SharePanel`.

#### Scenario: Share note with email
- **WHEN** the user enters a recipient email and submits the share form
- **THEN** `supabase.from('note_shares').insert` is called with the note id and recipient's user id

### Requirement: Shared notes list
The system SHALL display notes shared with the current user in a separate "Shared with me" section via `SharedNotesList`.

#### Scenario: Shared notes displayed
- **WHEN** other users have shared notes with the current user
- **THEN** `SharedNotesList` displays those notes with the sharer's name
