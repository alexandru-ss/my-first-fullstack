import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// Module-level helper: fetches a single document_shares row with joined data.
async function fetchShareRecord(shareId) {
  const { data } = await supabase
    .from('document_shares')
    .select(`
      id,
      permission,
      documents!document_id (
        id, title, body, created_at, updated_at,
        users!user_id ( id, username, avatar_path )
      )
    `)
    .eq('id', shareId)
    .single()
  if (!data) return null
  return { id: data.id, permission: data.permission, document: data.documents }
}

// ─── OwnerAvatar ────────────────────────────────────────────────────────────
function OwnerAvatar({ owner }) {
  const [signedUrl, setSignedUrl] = useState(null)

  useEffect(() => {
    if (!owner?.avatar_path) return
    supabase.storage
      .from('avatars')
      .createSignedUrl(owner.avatar_path, 3600)
      .then(({ data }) => { if (data) setSignedUrl(data.signedUrl) })
  }, [owner?.avatar_path])

  const initials = (owner?.username || '?').slice(0, 2).toUpperCase()

  return (
    <span className="avatar-circle avatar-circle--xs">
      {signedUrl
        ? <img src={signedUrl} alt={owner?.username ?? 'Owner avatar'} />
        : <span className="avatar-initials">{initials}</span>}
    </span>
  )
}

// ─── SharedDocumentItem ─────────────────────────────────────────────────────
function SharedDocumentItem({ shareRecord }) {
  const { document: doc, permission } = shareRecord
  const owner = doc.users
  const preview = doc.body
    ? doc.body.length > 120 ? doc.body.slice(0, 120) + '…' : doc.body
    : ''

  return (
    <li className="note-item doc-item">
      <Link className="note-item-body" to={`/documents/${doc.id}`}>
        <div className="shared-by-row">
          <OwnerAvatar owner={owner} />
          <span className="shared-by-label">
            Shared by {owner?.username ?? 'Unknown'}
          </span>
          <span className={`share-row-permission share-row-permission--${permission}`}>
            {permission}
          </span>
        </div>
        <h3 className="note-title">{doc.title || 'Untitled'}</h3>
        {preview && <p className="note-content">{preview}</p>}
        <time className="note-date" dateTime={doc.updated_at}>
          {new Date(doc.updated_at).toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
          })}
        </time>
      </Link>
    </li>
  )
}

// ─── SharedDocumentsList ────────────────────────────────────────────────────
/**
 * Fetches and displays documents shared with the current user.
 *
 * @param {{ userId: string }} props
 */
export function SharedDocumentsList({ userId }) {
  const [shareRecords, setShareRecords] = useState([])
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState(null)

  // Fetch shared documents on mount
  useEffect(() => {
    if (!userId) return
    let cancelled = false

    supabase
      .from('document_shares')
      .select(`
        id,
        permission,
        documents!document_id (
          id, title, body, created_at, updated_at,
          users!user_id ( id, username, avatar_path )
        )
      `)
      .eq('shared_with_id', userId)
      .order('created_at', { ascending: false })
      .then(({ data, error: fetchError }) => {
        if (cancelled) return
        if (fetchError) {
          setError(fetchError.message)
        } else {
          setShareRecords(
            (data ?? []).map(s => ({
              id:         s.id,
              permission: s.permission,
              document:   s.documents,
            }))
          )
        }
        setLoading(false)
      })

    return () => { cancelled = true }
  }, [userId])

  // Realtime subscription for share INSERT/DELETE
  useEffect(() => {
    if (!userId) return

    const channel = supabase
      .channel(`shared-docs-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'document_shares',
          filter: `shared_with_id=eq.${userId}`,
        },
        ({ eventType, new: newRow, old: oldRow }) => {
          if (eventType === 'DELETE') {
            setShareRecords(curr => curr.filter(r => r.id !== oldRow.id))
          } else if (eventType === 'INSERT') {
            ;(async () => {
              const record = await fetchShareRecord(newRow.id)
              if (!record) return
              setShareRecords(curr => {
                if (curr.some(r => r.id === record.id)) return curr
                return [record, ...curr]
              })
            })()
          } else if (eventType === 'UPDATE') {
            // Permission change — update in place
            setShareRecords(curr =>
              curr.map(r => r.id === newRow.id ? { ...r, permission: newRow.permission } : r)
            )
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [userId])

  // Stable dep key for document IDs — used for content UPDATE subscription
  const docIdKey = shareRecords
    .map(r => r.document?.id)
    .filter(Boolean)
    .sort((a, b) => a - b)
    .join(',')

  // Realtime subscription for document content changes (title/body edits by owner)
  useEffect(() => {
    if (!userId || !docIdKey) return

    const channel = supabase
      .channel(`shared-docs-content-${userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'documents', filter: `id=in.(${docIdKey})` },
        ({ new: newRow }) => {
          const docId = Number(newRow.id)
          setShareRecords(curr =>
            curr.map(r => {
              if (r.document?.id !== docId) return r
              return {
                ...r,
                document: {
                  ...r.document,
                  title:      newRow.title,
                  body:       newRow.body,
                  updated_at: newRow.updated_at,
                },
              }
            })
          )
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [userId, docIdKey])

  if (loading) return <p className="notes-status">Loading shared documents…</p>
  if (error)   return <p className="notes-status notes-error" role="alert">Error: {error}</p>
  if (shareRecords.length === 0) return (
    <p className="notes-status">No documents have been shared with you yet.</p>
  )

  return (
    <ul className="notes-list">
      {shareRecords.map(r => (
        <SharedDocumentItem key={r.id} shareRecord={r} />
      ))}
    </ul>
  )
}
