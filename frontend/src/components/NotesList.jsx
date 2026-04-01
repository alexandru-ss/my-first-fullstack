import { useCallback, useEffect, useImperativeHandle, useState } from 'react'
import { supabase } from '../lib/supabase'

// rerender-no-inline-components: NoteItem defined at module scope, receives props
function NoteItem({ note, view, onEdit, onTogglePin, onArchive, onUnarchive, onDeletePermanently, onTagClick }) {
  const dateValue = view === 'archived' ? note.archived_at : note.updated_at
  return (
    <li className={`note-item${note.pinned && view === 'active' ? ' note-item--pinned' : ''}`}>
      <div className="note-item-body">
        <h3 className="note-title">{note.title}</h3>
        {note.content && <p className="note-content">{note.content}</p>}
        <time className="note-date" dateTime={dateValue}>
          {new Date(dateValue).toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
          })}
        </time>
        {view === 'active' && note.tags && note.tags.length > 0 && (
          <div className="tags-row">
            {note.tags.map(tag => (
              <button
                key={tag.id}
                className="tag-pill tag-pill--interactive"
                onClick={() => onTagClick(tag)}
                type="button"
              >
                {tag.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="note-item-actions">
        {view === 'active' ? (
          <>
            <button
              className={`btn-pin${note.pinned ? ' is-pinned' : ''}`}
              onClick={() => onTogglePin(note)}
              aria-label={note.pinned ? 'Unpin note' : 'Pin note'}
              title={note.pinned ? 'Unpin' : 'Pin'}
            >
              📌
            </button>
            <button className="btn-secondary" onClick={() => onEdit(note)}>Edit</button>
            <button className="btn-secondary" onClick={() => onArchive(note)}>Archive</button>
          </>
        ) : (
          <>
            <button className="btn-secondary" onClick={() => onUnarchive(note)}>Unarchive</button>
            <button className="btn-danger" onClick={() => onDeletePermanently(note.id)}>Delete</button>
          </>
        )}
      </div>
    </li>
  )
}

/**
 * Fetches and displays notes for the given user.
 * Exposes `onSaved` to let a parent push optimistic updates without re-fetching.
 *
 * @param {{
 *   userId: string,
 *   view: 'active' | 'archived',
 *   activeTagId: number | null,
 *   onEdit: (note: object) => void,
 *   onTagClick: (tag: object) => void
 * }} props
 */
export function NotesList({ userId, view, activeTagId, onEdit, onTagClick, listRef }) {
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // rerender-dependencies: depend on userId + view + activeTagId (all primitives)
  useEffect(() => {
    if (!userId) return

    let cancelled = false

    async function fetchNotes() {
      setLoading(true)
      setError(null)

      // Use inner join when filtering by tag so only notes with that tag are returned
      const tagSelect = activeTagId != null
        ? 'note_tags!inner(tag_id, tags(id, name))'
        : 'note_tags(tag_id, tags(id, name))'

      let query = supabase
        .from('notes')
        .select(`id, title, content, pinned, archived_at, created_at, updated_at, ${tagSelect}`)

      if (view === 'active') {
        query = query
          .is('archived_at', null)
          .order('pinned', { ascending: false })
          .order('updated_at', { ascending: false })
      } else {
        query = query
          .not('archived_at', 'is', null)
          .order('archived_at', { ascending: false })
      }

      if (activeTagId != null) {
        query = query.eq('note_tags.tag_id', activeTagId)
      }

      const { data, error: fetchError } = await query

      if (cancelled) return

      if (fetchError) {
        setError(fetchError.message)
      } else {
        // Flatten note_tags[].tags → note.tags[] for cleaner component access
        setNotes(data.map(n => ({
          ...n,
          tags: (n.note_tags ?? []).map(nt => nt.tags).filter(Boolean),
        })))
      }
      setLoading(false)
    }

    fetchNotes()
    return () => { cancelled = true }
  }, [userId, view, activeTagId])

  // Expose an imperative handle so App can push a saved note into the list
  // without triggering a network round-trip.
  // rerender-functional-setstate: functional form so this callback never stales
  useImperativeHandle(listRef, () => ({
    upsert: (savedNote) => {
      // rerender-functional-setstate + js-tosorted-immutable: merge then re-sort immutably.
      // Filter out notes that no longer belong to the current view
      // (e.g. a note archived from the active view disappears immediately).
      setNotes(curr => {
        const noteMatchesView = view === 'active'
          ? savedNote.archived_at == null
          : savedNote.archived_at != null
        if (!noteMatchesView) {
          return curr.filter(n => n.id !== savedNote.id)
        }
        const merged = curr.findIndex(n => n.id === savedNote.id) === -1
          ? [savedNote, ...curr]
          : curr.map(n => n.id === savedNote.id ? savedNote : n)
        return merged.toSorted((a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          new Date(b.updated_at) - new Date(a.updated_at)
        )
      })
    },
  }), [view])

  // rerender-functional-setstate: stable callback, no deps needed
  const handleTogglePin = useCallback(async (note) => {
    const newPinned = !note.pinned
    const { error: updateError } = await supabase
      .from('notes')
      .update({ pinned: newPinned })
      .eq('id', note.id)

    if (updateError) {
      alert(updateError.message)
      return
    }
    // Flip the flag then re-sort so pinned notes float to the top instantly
    // js-tosorted-immutable: toSorted() returns a new array without mutating state
    setNotes(curr =>
      curr
        .map(n => n.id === note.id ? { ...n, pinned: newPinned } : n)
        .toSorted((a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          new Date(b.updated_at) - new Date(a.updated_at)
        )
    )
  }, [])

  // rerender-functional-setstate: stable callbacks, no stale-closure risk
  const handleArchive = useCallback(async (note) => {
    const archivedAt = new Date().toISOString()
    const { error: updateError } = await supabase
      .from('notes')
      .update({ archived_at: archivedAt })
      .eq('id', note.id)

    if (updateError) { alert(updateError.message); return }
    setNotes(curr => curr.filter(n => n.id !== note.id))
  }, [])

  const handleUnarchive = useCallback(async (note) => {
    const { error: updateError } = await supabase
      .from('notes')
      .update({ archived_at: null })
      .eq('id', note.id)

    if (updateError) { alert(updateError.message); return }
    setNotes(curr => curr.filter(n => n.id !== note.id))
  }, [])

  const handleDeletePermanently = useCallback(async (noteId) => {
    const { error: deleteError } = await supabase
      .from('notes')
      .delete()
      .eq('id', noteId)

    if (deleteError) { alert(deleteError.message); return }
    setNotes(curr => curr.filter(n => n.id !== noteId))
  }, [])

  if (loading) return <p className="notes-status">Loading notes…</p>
  if (error)   return <p className="notes-status notes-error" role="alert">Error: {error}</p>

  if (notes.length === 0) {
    return (
      <p className="notes-status">
        {view === 'archived' ? 'No archived notes.' : 'No notes yet. Create your first one!'}
      </p>
    )
  }

  return (
    <ul className="notes-list">
      {notes.map(note => (
        <NoteItem
          key={note.id}
          note={note}
          view={view}
          onEdit={onEdit}
          onTogglePin={handleTogglePin}
          onArchive={handleArchive}
          onUnarchive={handleUnarchive}
          onDeletePermanently={handleDeletePermanently}
          onTagClick={onTagClick}
        />
      ))}
    </ul>
  )
}
