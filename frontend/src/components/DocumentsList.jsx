import { useEffect, useImperativeHandle, useState } from 'react'
import { supabase } from '../lib/supabase'

// rerender-no-inline-components: DocumentItem defined at module scope
function DocumentItem({ doc, onEdit, onDelete }) {
  const preview = doc.body
    ? doc.body.length > 120 ? doc.body.slice(0, 120) + '…' : doc.body
    : ''

  return (
    <li className="note-item doc-item">
      <div className="note-item-body" role="button" tabIndex={0}
        onClick={() => onEdit(doc)}
        onKeyDown={e => { if (e.key === 'Enter') onEdit(doc) }}
      >
        <h3 className="note-title">{doc.title || 'Untitled'}</h3>
        {preview && <p className="note-content">{preview}</p>}
        <time className="note-date" dateTime={doc.updated_at}>
          {new Date(doc.updated_at).toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
          })}
        </time>
      </div>
      <div className="note-item-actions">
        <button className="btn-danger" onClick={() => onDelete(doc.id)}>Delete</button>
      </div>
    </li>
  )
}

/**
 * Fetches and displays documents for the given user.
 * Exposes an imperative `upsert` handle so App can push saved documents
 * into the list without a network re-fetch.
 *
 * @param {{
 *   userId: string,
 *   onEdit: (doc: object) => void,
 *   listRef: import('react').RefObject
 * }} props
 */
export function DocumentsList({ userId, onEdit, listRef }) {
  const [documents, setDocuments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // rerender-dependencies: depend on userId (primitive string)
  useEffect(() => {
    if (!userId) return

    let cancelled = false

    async function fetchDocuments() {
      setLoading(true)
      setError(null)

      const { data, error: fetchError } = await supabase
        .from('documents')
        .select('id, title, body, created_at, updated_at')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })

      if (cancelled) return

      if (fetchError) {
        setError(fetchError.message)
      } else {
        setDocuments(data)
      }
      setLoading(false)
    }

    fetchDocuments()
    return () => { cancelled = true }
  }, [userId])

  // Imperative handle for optimistic updates from the editor
  // rerender-functional-setstate: functional form so this callback never stales
  useImperativeHandle(listRef, () => ({
    upsert: (savedDoc) => {
      setDocuments(curr => {
        const merged = curr.findIndex(d => d.id === savedDoc.id) === -1
          ? [savedDoc, ...curr]
          : curr.map(d => d.id === savedDoc.id ? savedDoc : d)
        return merged.toSorted((a, b) =>
          new Date(b.updated_at) - new Date(a.updated_at)
        )
      })
    },
    remove: (docId) => {
      setDocuments(curr => curr.filter(d => d.id !== docId))
    },
  }), [])

  // rerender-split-combined-hooks: Realtime subscription has a different lifecycle
  // from the fetch effect — only recreated when the signed-in user changes.
  useEffect(() => {
    if (!userId) return

    const channel = supabase
      .channel(`documents-realtime-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'documents', filter: `user_id=eq.${userId}` },
        ({ eventType, new: newRow, old: oldRow }) => {
          if (eventType === 'INSERT') {
            // rerender-functional-setstate + js-tosorted-immutable
            setDocuments(curr => {
              if (curr.some(d => d.id === newRow.id)) return curr
              return [newRow, ...curr].toSorted((a, b) =>
                new Date(b.updated_at) - new Date(a.updated_at)
              )
            })
          } else if (eventType === 'UPDATE') {
            setDocuments(curr => {
              if (!curr.some(d => d.id === newRow.id)) return curr
              return curr.map(d => d.id === newRow.id ? newRow : d).toSorted((a, b) =>
                new Date(b.updated_at) - new Date(a.updated_at)
              )
            })
          } else if (eventType === 'DELETE') {
            setDocuments(curr => curr.filter(d => d.id !== oldRow.id))
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [userId])

  async function handleDelete(docId) {
    // Optimistic removal
    setDocuments(curr => curr.filter(d => d.id !== docId))

    const { error: deleteError } = await supabase
      .from('documents')
      .delete()
      .eq('id', docId)

    if (deleteError) {
      // Re-fetch on failure to restore correct state
      setError(deleteError.message)
    }
  }

  if (loading) return <p className="notes-status">Loading documents…</p>
  if (error) return <p className="notes-status notes-error">{error}</p>
  if (documents.length === 0) return <p className="notes-status">No documents yet.</p>

  return (
    <ul className="notes-list">
      {documents.map(doc => (
        <DocumentItem
          key={doc.id}
          doc={doc}
          onEdit={onEdit}
          onDelete={handleDelete}
        />
      ))}
    </ul>
  )
}
