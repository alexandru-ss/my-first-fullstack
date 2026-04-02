import { useEffect, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import { useAuth } from './hooks/useAuth'
import { useTheme } from './hooks/useTheme'
import { AuthForm } from './components/AuthForm'
import { NotesList } from './components/NotesList'
import { NoteEditor } from './components/NoteEditor'
import { ProfileEditor } from './components/ProfileEditor'
import './App.css'

// rerender-no-inline-components: Header defined at module scope
function Header({ displayName, email, avatarSignedUrl, theme, onToggleTheme, onOpenProfile, onSignOut }) {
  // rerender-derived-state-no-effect: derive initials during render, not in state
  const initials = (displayName || email || '?').slice(0, 2).toUpperCase()
  return (
    <header className="app-header">
      <span className="app-logo">Notes</span>
      <div className="app-header-right">
        <button
          className="avatar-circle avatar-circle--sm btn-unstyled"
          onClick={onOpenProfile}
          aria-label="Open profile"
          title="Profile"
        >
          {avatarSignedUrl
            ? <img src={avatarSignedUrl} alt="Avatar" />
            : <span className="avatar-initials">{initials}</span>}
        </button>
        <button
          className="btn-icon"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <button className="btn-secondary" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
  )
}

export default function App() {
  const { session, user, loading } = useAuth()
  // rerender-lazy-state-init: getInitialTheme (reference) passed to useState,
  // not getInitialTheme() (result), so it only runs once on mount.
  const { theme, toggleTheme } = useTheme()
  // null = editor closed; undefined = create mode; object = edit mode
  const [editingNote, setEditingNote] = useState(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [avatarPath, setAvatarPath] = useState(null)
  const [avatarSignedUrl, setAvatarSignedUrl] = useState(null)
  const [view, setView] = useState('active')
  const [activeTag, setActiveTag] = useState(null)
  // rerender-dependencies: pass primitive id, not the whole object
  const activeTagId = activeTag?.id ?? null

  // Imperative ref so NoteEditor can push a saved note into NotesList
  // without a network re-fetch (async-parallel / avoiding waterfall)
  const listRef = useRef(null)

  // rerender-dependencies: depend on user?.id (string primitive)
  const userId = user?.id ?? null
  useEffect(() => {
    if (!userId) return
    supabase
      .from('users')
      .select('username, avatar_path')
      .eq('id', userId)
      .single()
      .then(({ data }) => {
        if (data) {
          setDisplayName(data.username ?? '')
          setAvatarPath(data.avatar_path ?? null)
        }
      })
  }, [userId])

  // Generate a fresh signed URL whenever the stored path changes.
  // Signed URLs are never persisted — only the path lives in the DB.
  useEffect(() => {
    if (!avatarPath) { setAvatarSignedUrl(null); return }
    supabase.storage
      .from('avatars')
      .createSignedUrl(avatarPath, 3600)
      .then(({ data }) => { if (data) setAvatarSignedUrl(data.signedUrl) })
  }, [avatarPath])

  if (loading) {
    return <div className="app-loading">Loading…</div>
  }

  if (!session) {
    return <AuthForm />
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
  }

  function openProfile() {
    setProfileOpen(true)
  }

  function closeProfile() {
    setProfileOpen(false)
  }

  function handleProfileSaved(name) {
    setDisplayName(name)
    closeProfile()
  }

  function handleAvatarSaved(newPath) {
    setAvatarPath(newPath)
    // The signed-URL effect only re-runs when avatarPath changes value.
    // On a re-upload the path is identical (same userId/avatar.png), so the
    // effect never fires and the header keeps showing the old image from cache.
    // Always regenerate the signed URL here directly so the new image appears
    // immediately without a page refresh.
    supabase.storage
      .from('avatars')
      .createSignedUrl(newPath, 3600)
      .then(({ data }) => { if (data) setAvatarSignedUrl(data.signedUrl) })
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

  function handleTagClick(tag) {
    // rerender-functional-setstate: toggle — clear if same tag clicked again
    setActiveTag(prev => prev?.id === tag.id ? null : tag)
  }

  function handleSaved(savedNote) {
    // Push into the list optimistically — no extra network round-trip
    listRef.current?.upsert(savedNote)
    closeEditor()
  }

  return (
    <div className="app-shell">
      <Header
        displayName={displayName}
        email={user.email}
        avatarSignedUrl={avatarSignedUrl}
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenProfile={openProfile}
        onSignOut={handleSignOut}
      />

      <main className="app-main">
        <div className="notes-toolbar">
          <div className="notes-tabs">
            <button
              className={`tab-btn${view === 'active' ? ' tab-btn--active' : ''}`}
              onClick={() => setView('active')}
            >
              Notes
            </button>
            <button
              className={`tab-btn${view === 'archived' ? ' tab-btn--active' : ''}`}
              onClick={() => setView('archived')}
            >
              Archived
            </button>
          </div>
          {view === 'active' ? (
            <button className="btn-primary" onClick={openCreate}>+ New note</button>
          ) : null}
        </div>

        {activeTag !== null ? (
          <div className="tag-filter-bar">
            Filtered by: <span className="tag-pill">{activeTag.name}</span>
            <button className="btn-link" onClick={() => setActiveTag(null)}>Clear</button>
          </div>
        ) : null}

        {/* rerender-dependencies: pass user.id (string) not user (object) */}
        <NotesList
          userId={userId}
          view={view}
          activeTagId={activeTagId}
          onEdit={openEdit}
          onTagClick={handleTagClick}
          listRef={listRef}
        />
      </main>

      {editorOpen && (
        <NoteEditor
          userId={userId}
          note={editingNote ?? null}
          onSave={handleSaved}
          onCancel={closeEditor}
        />
      )}

      {profileOpen && (
        <ProfileEditor
          userId={userId}
          displayName={displayName}
          currentAvatarUrl={avatarSignedUrl}
          onSave={handleProfileSaved}
          onAvatarSaved={handleAvatarSaved}
          onCancel={closeProfile}
        />
      )}
    </div>
  )
}

