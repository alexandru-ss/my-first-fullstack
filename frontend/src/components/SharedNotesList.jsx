import { useEffect, useImperativeHandle, useState } from 'react'
import { supabase } from '../lib/supabase'
import { AttachmentThumbnail, AttachmentFileIcon } from './NotesList'

// Module-level helper: fetches a single note_shares row with all joined data
// (note + owner + attachments). Used by the Realtime INSERT handler to hydrate
// the full record before inserting it into state.
async function fetchShareRecord(shareId) {
  const { data } = await supabase
    .from('note_shares')
    .select(`
      id,
      permission,
      notes!note_id (
        id, title, content, pinned, archived_at, created_at, updated_at,
        note_attachments ( id, storage_path, file_name, mime_type ),
        users!user_id ( id, username, avatar_path )
      )
    `)
    .eq('id', shareId)
    .single()
  if (!data) return null
  return { id: data.id, permission: data.permission, note: data.notes }
}

// ─── OwnerAvatar ────────────────────────────────────────────────────────────
// Generates a signed URL for the note owner's avatar on mount and renders it.
// Falls back to initials when no avatar_path is set or the URL fails.
// Defined at module scope to avoid inline-component rerender issues.
function OwnerAvatar({ owner }) {
  const [signedUrl, setSignedUrl] = useState(null)

  // rerender-dependencies: owner.avatar_path is the relevant primitive
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

// ─── SharedNoteItem ─────────────────────────────────────────────────────────
// Renders a single shared note card with:
//   - owner avatar + "Shared by" label
//   - note title, content, date
//   - attachment thumbnails and file pills (view-only; no upload / delete)
//   - Edit button only when permission === 'edit'
// No pin / archive / delete / share buttons — those remain owner-only.
function SharedNoteItem({ shareRecord, onEdit }) {
  const { note, permission } = shareRecord
  const owner = note.users

  const images = (note.note_attachments ?? []).filter(a => a.mime_type?.startsWith('image/'))
  const files  = (note.note_attachments ?? []).filter(a => !a.mime_type?.startsWith('image/'))

  return (
    <li className="note-item">
      <div className="note-item-body">
        {/* Owner attribution */}
        <div className="shared-by-row">
          <OwnerAvatar owner={owner} />
          <span className="shared-by-label">
            Shared by {owner?.username ?? 'Unknown'}
          </span>
          <span className={`share-row-permission share-row-permission--${permission}`}>
            {permission}
          </span>
        </div>

        <h3 className="note-title">{note.title}</h3>
        {note.content && <p className="note-content">{note.content}</p>}
        <time className="note-date" dateTime={note.updated_at}>
          {new Date(note.updated_at).toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
          })}
        </time>

        {/* Attachments: thumbnails then file pills, view-only */}
        {images.length > 0 && (
          <div className="note-thumbnails-row">
            {images.map(a => (
              <AttachmentThumbnail
                key={a.id}
                storagePath={a.storage_path}
                fileName={a.file_name}
              />
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="note-files-row">
            {files.map(a => (
              <AttachmentFileIcon
                key={a.id}
                storagePath={a.storage_path}
                fileName={a.file_name}
              />
            ))}
          </div>
        )}
      </div>

      {/* Actions: edit only for 'edit' permission; never show share/pin/archive/delete */}
      {permission === 'edit' && (
        <div className="note-item-actions">
          <button
            className="btn-secondary"
            onClick={() => onEdit(note, permission)}
          >
            Edit
          </button>
        </div>
      )}
    </li>
  )
}

// ─── SharedNotesList ────────────────────────────────────────────────────────
/**
 * Fetches and displays notes shared with the current user.
 * Exposes sharedListRef.upsert() so App can push a post-edit update without
 * a network round-trip.
 *
 * @param {{
 *   userId:         string,
 *   onEdit:         (note: object, permission: string) => void,
 *   sharedListRef:  React.MutableRefObject
 * }} props
 */
export function SharedNotesList({ userId, onEdit, sharedListRef }) {
  const [shareRecords, setShareRecords] = useState([])
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState(null)

  useEffect(() => {
    if (!userId) return
    let cancelled = false

    // Fetch note_shares rows for this user, joined to notes + owner + attachments.
    // The "users: select shared note owner" policy allows reading the owner's row.
    // The "notes: select own or shared" policy allows reading the note row.
    // The "attachments: shared reader select" storage policy allows signed URLs.
    supabase
      .from('note_shares')
      .select(`
        id,
        permission,
        notes!note_id (
          id, title, content, pinned, archived_at, created_at, updated_at,
          note_attachments ( id, storage_path, file_name, mime_type ),
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
          // Flatten: each record gets { id, permission, note, owner }
          setShareRecords(
            (data ?? []).map(s => ({
              id:         s.id,
              permission: s.permission,
              note:       s.notes,
            }))
          )
        }
        setLoading(false)
      })

    return () => { cancelled = true }
  }, [userId])

  // rerender-split-combined-hooks: Realtime subscription has a different lifecycle
  // from the data-fetch effect — only recreated when the signed-in user changes.
  //
  // Subscribes to note_shares filtered by shared_with_id so the recipient
  // sees revokes (DELETE) and new shares (INSERT) without a manual refresh.
  //
  // REPLICA IDENTITY FULL (migration _012) ensures DELETE payloads include the
  // full old row — including shared_with_id — so the server-side filter matches
  // and the client receives the event. Without it, only the PK (id) is sent and
  // the filter would never fire for DELETEs.
  //
  // A single event:'*' subscription is used intentionally (same reasoning as the
  // note_attachments subscription in NotesList): registering INSERT and DELETE as
  // separate .on() calls on the same channel causes only the first to be honoured
  // by the Supabase server, so the second event type would silently be dropped.
  useEffect(() => {
    if (!userId) return

    const channel = supabase
      .channel(`shared-notes-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'note_shares',
          filter: `shared_with_id=eq.${userId}`,
        },
        ({ eventType, new: newRow, old: oldRow }) => {
          if (eventType === 'DELETE') {
            // REPLICA IDENTITY FULL puts the full old row in the payload,
            // including id, so we can locate and remove the correct record.
            setShareRecords(curr => curr.filter(r => r.id !== oldRow.id))
          } else if (eventType === 'INSERT') {
            // Raw Realtime payloads carry no joined data — fetch the full
            // record (note + owner + attachments) before inserting into state.
            ;(async () => {
              const record = await fetchShareRecord(newRow.id)
              if (!record) return
              setShareRecords(curr => {
                // Dedup: avoid adding if already present (e.g. same-tab optimistic add)
                if (curr.some(r => r.id === record.id)) return curr
                return [record, ...curr]
              })
            })()
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [userId])

  // Expose upsert so App can update a note after the shared editor saves it,
  // without triggering a network round-trip.
  useImperativeHandle(sharedListRef, () => ({
    upsert: (savedNote) => {
      setShareRecords(curr =>
        curr.map(r =>
          r.note?.id === savedNote.id
            ? { ...r, note: { ...r.note, ...savedNote } }
            : r
        )
      )
    },
  }), [])

  if (loading) return <p className="notes-status">Loading shared notes…</p>
  if (error)   return <p className="notes-status notes-error" role="alert">Error: {error}</p>
  if (shareRecords.length === 0) return (
    <p className="notes-status">No notes have been shared with you yet.</p>
  )

  return (
    <ul className="notes-list">
      {shareRecords.map(r => (
        <SharedNoteItem
          key={r.id}
          shareRecord={r}
          onEdit={onEdit}
        />
      ))}
    </ul>
  )
}
