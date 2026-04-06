import { useEffect, useRef, useState } from 'react'
import { Routes, Route, NavLink, Link, Outlet } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { useAuth } from './hooks/useAuth'
import { useTheme } from './hooks/useTheme'
import { AuthForm } from './components/AuthForm'
import { NotesList } from './components/NotesList'
import { NoteEditor } from './components/NoteEditor'
import { ProfileEditor } from './components/ProfileEditor'
import { SharePanel } from './components/SharePanel'
import { SharedNotesList } from './components/SharedNotesList'
import { DocumentsList } from './components/DocumentsList'
import { DocumentEditorRoute } from './components/DocumentEditor'
import { DocumentSharePanel } from './components/DocumentSharePanel'
import { SharedDocumentsList } from './components/SharedDocumentsList'
import './App.css'

// rerender-no-inline-components: Header defined at module scope
function Header({ displayName, email, avatarSignedUrl, theme, onToggleTheme, onOpenProfile, onSignOut }) {
  // rerender-derived-state-no-effect: derive initials during render, not in state
  const initials = (displayName || email || '?').slice(0, 2).toUpperCase()
  return (
    <header className="app-header">
      <div className="section-toggle">
        <NavLink
          to="/"
          end
          className={({ isActive }) => `section-btn${isActive ? ' section-btn--active' : ''}`}
        >
          Notes
        </NavLink>
        <NavLink
          to="/documents"
          className={({ isActive }) => `section-btn${isActive ? ' section-btn--active' : ''}`}
        >
          Documents
        </NavLink>
      </div>
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

// rerender-no-inline-components: layout wrappers at module scope
function CompactLayout() {
  return <main className="app-main"><Outlet /></main>
}

function FullLayout() {
  return <main className="app-main app-main--full"><Outlet /></main>
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
  // sharingNote: note to show in SharePanel; null = panel closed
  const [sharingNote, setSharingNote] = useState(null)
  // sharingDocument: document to show in DocumentSharePanel; null = panel closed
  const [sharingDocument, setSharingDocument] = useState(null)
  // editSharePermission: null (owner editing) | 'edit' (shared-editor editing)
  const [editSharePermission, setEditSharePermission] = useState(null)
  // docView: which tab is active on the /documents page
  const [docView, setDocView] = useState('own')

  // Imperative ref so NoteEditor can push a saved note into NotesList
  // without a network re-fetch (async-parallel / avoiding waterfall)
  const listRef = useRef(null)
  // Imperative ref for SharedNotesList — used when a shared editor saves
  const sharedListRef = useRef(null)

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
    setEditSharePermission(null)
    setEditorOpen(true)
  }

  function openEdit(note, sharePermission = null) {
    setEditingNote(note)
    setEditSharePermission(sharePermission)
    setEditorOpen(true)
  }

  function openShare(note) {
    setSharingNote(note)
  }

  function closeEditor() {
    setEditorOpen(false)
    setEditingNote(null)
    setEditSharePermission(null)
  }

  function handleTagClick(tag) {
    // rerender-functional-setstate: toggle — clear if same tag clicked again
    setActiveTag(prev => prev?.id === tag.id ? null : tag)
  }

  function handleSaved(savedNote) {
    // Route the optimistic update to the correct list depending on whether
    // the editor was opened from the shared list or the owner list.
    if (editSharePermission !== null) {
      sharedListRef.current?.upsert(savedNote)
    } else {
      listRef.current?.upsert(savedNote)
    }
    closeEditor()
  }

  function handleAttachmentsChanged(newAttachments) {
    // Update the note card immediately when an attachment is added or removed
    // in the editor, without waiting for the user to press "Save changes".
    if (!editingNote) return
    if (editSharePermission !== null) {
      sharedListRef.current?.upsert({ ...editingNote, note_attachments: newAttachments })
    } else {
      listRef.current?.upsert({ ...editingNote, note_attachments: newAttachments })
    }
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

      <Routes>
        <Route element={<CompactLayout />}>
          <Route path="/" element={
            <>
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
                  <button
                    className={`tab-btn${view === 'shared' ? ' tab-btn--active' : ''}`}
                    onClick={() => setView('shared')}
                  >
                    Shared with me
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
              {view !== 'shared' ? (
                <NotesList
                  userId={userId}
                  view={view}
                  activeTagId={activeTagId}
                  onEdit={openEdit}
                  onTagClick={handleTagClick}
                  onShare={openShare}
                  listRef={listRef}
                />
              ) : (
                <SharedNotesList
                  userId={userId}
                  onEdit={(note, perm) => openEdit(note, perm)}
                  sharedListRef={sharedListRef}
                />
              )}
            </>
          } />
          <Route path="/documents" element={
            <>
              <div className="notes-toolbar">
                <div className="notes-tabs">
                  <button
                    className={`tab-btn${docView === 'own' ? ' tab-btn--active' : ''}`}
                    onClick={() => setDocView('own')}
                  >
                    My Documents
                  </button>
                  <button
                    className={`tab-btn${docView === 'shared' ? ' tab-btn--active' : ''}`}
                    onClick={() => setDocView('shared')}
                  >
                    Shared with me
                  </button>
                </div>
                {docView === 'own' ? (
                  <Link to="/documents/new" className="btn-primary">+ New document</Link>
                ) : null}
              </div>

              {docView === 'own' ? (
                <DocumentsList userId={userId} />
              ) : (
                <SharedDocumentsList userId={userId} />
              )}
            </>
          } />
        </Route>
        <Route element={<FullLayout />}>
          <Route path="/documents/:id" element={
            <DocumentEditorRoute
              userId={userId}
              onOpenShare={doc => setSharingDocument(doc)}
            />
          } />
        </Route>
      </Routes>

      {editorOpen && (
        <NoteEditor
          userId={userId}
          note={editingNote ?? null}
          onSave={handleSaved}
          onCancel={closeEditor}
          onAttachmentsChange={handleAttachmentsChanged}
          onTagDeleted={tag => { if (activeTag?.id === tag.id) setActiveTag(null) }}
          sharePermission={editSharePermission}
        />
      )}

      {sharingNote && (
        <SharePanel
          noteId={sharingNote.id}
          noteTitle={sharingNote.title}
          userEmail={user.email}
          onClose={() => setSharingNote(null)}
        />
      )}

      {sharingDocument && (
        <DocumentSharePanel
          documentId={sharingDocument.id}
          documentTitle={sharingDocument.title}
          userEmail={user.email}
          onClose={() => setSharingDocument(null)}
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

