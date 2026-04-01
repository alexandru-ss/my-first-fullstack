import { useCallback, useEffect, useImperativeHandle, useState } from 'react'
import { supabase } from '../lib/supabase'

// rerender-no-inline-components: NoteItem defined at module scope, receives props
function NoteItem({ note, onEdit, onDelete, onTogglePin }) {
  return (
    <li className={`note-item${note.pinned ? ' note-item--pinned' : ''}`}>
      <div className="note-item-body">
        <h3 className="note-title">{note.title}</h3>
        {note.content && <p className="note-content">{note.content}</p>}
        <time className="note-date" dateTime={note.updated_at}>
          {new Date(note.updated_at).toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
          })}
        </time>
      </div>
      <div className="note-item-actions">
        <button
          className={`btn-pin${note.pinned ? ' is-pinned' : ''}`}
          onClick={() => onTogglePin(note)}
          aria-label={note.pinned ? 'Unpin note' : 'Pin note'}
          title={note.pinned ? 'Unpin' : 'Pin'}
        >
          📌
        </button>
        <button className="btn-secondary" onClick={() => onEdit(note)}>Edit</button>
        <button className="btn-danger" onClick={() => onDelete(note.id)}>Delete</button>
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
 *   onEdit: (note: object) => void
 * }} props
 */
export function NotesList({ userId, onEdit, listRef }) {
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // rerender-dependencies: depend on userId (string primitive), not the user object
  useEffect(() => {
    if (!userId) return

    let cancelled = false

    async function fetchNotes() {
      setLoading(true)
      setError(null)

      const { data, error: fetchError } = await supabase
        .from('notes')
        .select('id, title, content, pinned, created_at, updated_at')
        .order('pinned', { ascending: false })
        .order('updated_at', { ascending: false })

      if (cancelled) return

      if (fetchError) {
        setError(fetchError.message)
      } else {
        setNotes(data)
      }
      setLoading(false)
    }

    fetchNotes()
    return () => { cancelled = true }
  }, [userId])

  // Expose an imperative handle so App can push a saved note into the list
  // without triggering a network round-trip.
  // rerender-functional-setstate: functional form so this callback never stales
  useImperativeHandle(listRef, () => ({
    upsert: (savedNote) => {
      // rerender-functional-setstate + js-tosorted-immutable: merge then re-sort immutably
      setNotes(curr => {
        const merged = curr.findIndex(n => n.id === savedNote.id) === -1
          ? [savedNote, ...curr]
          : curr.map(n => n.id === savedNote.id ? savedNote : n)
        return merged.toSorted((a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          new Date(b.updated_at) - new Date(a.updated_at)
        )
      })
    },
  }), [])

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

  const handleDelete = useCallback(async (noteId) => {
    const { error: deleteError } = await supabase
      .from('notes')
      .delete()
      .eq('id', noteId)

    if (deleteError) {
      alert(deleteError.message)
      return
    }
    // rerender-functional-setstate
    setNotes(curr => curr.filter(n => n.id !== noteId))
  }, [])

  if (loading) return <p className="notes-status">Loading notes…</p>
  if (error)   return <p className="notes-status notes-error" role="alert">Error: {error}</p>

  if (notes.length === 0) {
    return <p className="notes-status">No notes yet. Create your first one!</p>
  }

  return (
    <ul className="notes-list">
      {notes.map(note => (
        <NoteItem
          key={note.id}
          note={note}
          onEdit={onEdit}
          onDelete={handleDelete}
          onTogglePin={handleTogglePin}
        />
      ))}
    </ul>
  )
}
