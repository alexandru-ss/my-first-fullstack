import { useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import { useAuth } from './hooks/useAuth'
import { AuthForm } from './components/AuthForm'
import { NotesList } from './components/NotesList'
import { NoteEditor } from './components/NoteEditor'
import './App.css'

// rerender-no-inline-components: Header defined at module scope
function Header({ email, onSignOut }) {
  return (
    <header className="app-header">
      <span className="app-logo">Notes</span>
      <div className="app-header-right">
        <span className="app-user">{email}</span>
        <button className="btn-secondary" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
  )
}

export default function App() {
  const { session, user, loading } = useAuth()
  // null = editor closed; undefined = create mode; object = edit mode
  const [editingNote, setEditingNote] = useState(null)
  const [editorOpen, setEditorOpen] = useState(false)

  // Imperative ref so NoteEditor can push a saved note into NotesList
  // without a network re-fetch (async-parallel / avoiding waterfall)
  const listRef = useRef(null)

  if (loading) {
    return <div className="app-loading">Loading…</div>
  }

  if (!session) {
    return <AuthForm />
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
  }

  function openCreate() {
    setEditingNote(undefined)
    setEditorOpen(true)
  }

  function openEdit(note) {
    setEditingNote(note)
    setEditorOpen(true)
  }

  function closeEditor() {
    setEditorOpen(false)
    setEditingNote(null)
  }

  function handleSaved(savedNote) {
    // Push into the list optimistically — no extra network round-trip
    listRef.current?.upsert(savedNote)
    closeEditor()
  }

  return (
    <div className="app-shell">
      <Header email={user.email} onSignOut={handleSignOut} />

      <main className="app-main">
        <div className="notes-toolbar">
          <h1>My Notes</h1>
          <button className="btn-primary" onClick={openCreate}>+ New note</button>
        </div>

        {/* rerender-dependencies: pass user.id (string) not user (object) */}
        <NotesList
          userId={user.id}
          onEdit={openEdit}
          listRef={listRef}
        />
      </main>

      {editorOpen && (
        <NoteEditor
          userId={user.id}
          note={editingNote ?? null}
          onSave={handleSaved}
          onCancel={closeEditor}
        />
      )}
    </div>
  )
}

