## ADDED Requirements

### Requirement: List documents
The system SHALL display the authenticated user's documents ordered by `updated_at` descending. Each document item links to its editor route and shows a body preview truncated at 120 characters.

#### Scenario: Documents load on mount
- **WHEN** `DocumentsList` renders with a valid `userId`
- **THEN** the component fetches documents from Supabase and renders each as a list item

#### Scenario: Empty state
- **WHEN** the user has no documents
- **THEN** an empty-state message is displayed

#### Scenario: Body preview truncation
- **WHEN** a document's `body` is longer than 120 characters
- **THEN** the preview shows the first 120 characters followed by "…"

#### Scenario: Documents link to editor
- **WHEN** a document item is rendered
- **THEN** clicking the item body navigates to `/documents/<id>`

### Requirement: Delete a document
The system SHALL allow the user to delete a document from the list.

#### Scenario: Delete document
- **WHEN** the user clicks the "Delete" button on a document item
- **THEN** `supabase.from('documents').delete()` is called with that document's id and the item is removed from the list

### Requirement: Create a document
The system SHALL allow the user to create a new document. New documents are created in Supabase and the user is navigated to the editor for the new document.

#### Scenario: Create document
- **WHEN** the user clicks the "New document" button
- **THEN** `supabase.from('documents').insert` is called and the app navigates to `/documents/<new-id>`

### Requirement: Document editor renders
The system SHALL render the `DocumentEditor` for a given document id. The editor loads the document's current Yjs state and sets up the collaborative editing session.

#### Scenario: Editor renders title
- **WHEN** `DocumentEditor` is rendered with a valid document id
- **THEN** the document title is displayed in an editable heading

#### Scenario: Editor shows loading state
- **WHEN** the document is being loaded from Supabase
- **THEN** a loading indicator is displayed

### Requirement: Share a document
The system SHALL allow the user to share a document with another user by email using `DocumentSharePanel`.

#### Scenario: Share document with email
- **WHEN** the user enters a recipient email and submits the share form in `DocumentSharePanel`
- **THEN** `supabase.from('document_shares').insert` is called with the document id and recipient's user id

### Requirement: Shared documents list
The system SHALL display documents shared with the current user via `SharedDocumentsList`.

#### Scenario: Shared documents displayed
- **WHEN** other users have shared documents with the current user
- **THEN** `SharedDocumentsList` fetches and displays those documents

### Requirement: Realtime document list updates
The system SHALL subscribe to Supabase realtime changes on the `documents` table so the list updates without a page refresh.

#### Scenario: New document appears via realtime
- **WHEN** a `INSERT` event is received on the `documents` channel for the current user
- **THEN** the new document is prepended to the list without a full refetch
