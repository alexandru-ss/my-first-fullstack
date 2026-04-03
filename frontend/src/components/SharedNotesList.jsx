import { useEffect, useImperativeHandle, useRef, useState } from 'react'
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

  // Stable dep key: changes only when the SET of note owners changes (e.g. a new
  // share from a previously-unseen owner, or the last share from an owner is
  // revoked). It does NOT change when attachment rows are added/removed, which
  // is important — we use it as the dependency for the INSERT effect below so
  // that attaching/removing a file does not needlessly tear down and recreate
  // the INSERT channels.
  const ownerIdKey = shareRecords
    .map(r => r.note?.users?.id)
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i) // deduplicate
    .sort()
    .join(',')

  // Stable dep key for the set of shared note IDs. Used for the DELETE effect.
  // Changes only when notes are added to / removed from the shared list.
  const noteIdKey = shareRecords
    .map(r => r.note?.id)
    .filter(Boolean)
    .sort((a, b) => a - b)
    .join(',')

  // advanced-use-latest: always read the current set of shared note IDs in the
  // DELETE handler without recreating the channel on every attachment state change.
  const sharedNoteIdsRef = useRef(new Set())
  useEffect(() => {
    sharedNoteIdsRef.current = new Set(
      shareRecords.map(r => r.note?.id).filter(Boolean).map(Number)
    )
  }, [shareRecords])

  // rerender-split-combined-hooks: INSERT and DELETE use fundamentally different
  // subscription strategies because Supabase Realtime column filters do not apply
  // to DELETE events (documented Realtime limitation: "Delete events are not
  // filterable"). Only INSERT events honour server-side column filters.
  //
  // INSERT effect: one channel per unique note owner, filtered by user_id.
  //   Server-side filter `user_id=eq.<ownerId>` narrows the event stream to only
  //   the owner's attachments so we don't receive unrelated INSERT noise.
  //   Client-side check on note_id skips events for notes not shared with us.
  //
  // DELETE effect (separate): subscribes with NO column filter so that walrus
  //   delivers the event unconditionally. REPLICA IDENTITY FULL (migration 009)
  //   ensures the full old row — including note_id — is present in the payload.
  //   Client-side check (sharedNoteIdsRef) discards events for notes we don't
  //   have access to. This is safe: deleted attachment metadata (file_name,
  //   mime_type, storage_path) is not more sensitive than what is already
  //   visible to authenticated users via their session; RLS on REST API reads
  //   still enforces proper access control.
  //
  // Number() coercion: Supabase Realtime serialises bigint columns as JSON
  // strings in some versions. The initial REST fetch returns them as numbers.
  // Number() normalises both so the strict !== comparison works correctly.

  // ── INSERT subscription (per-owner filtered channels) ───────────────────
  useEffect(() => {
    if (!userId || !ownerIdKey) return

    const ownerIds = ownerIdKey.split(',')

    const channels = ownerIds.map(ownerId =>
      supabase
        .channel(`shared-attach-insert-${userId}-${ownerId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'note_attachments', filter: `user_id=eq.${ownerId}` },
          ({ new: newRow }) => {
            const noteId   = Number(newRow.note_id)
            const attachId = Number(newRow.id)
            setShareRecords(curr =>
              curr.map(r => {
                if (r.note?.id !== noteId) return r
                // Dedup: same-tab owner edits may have already applied this row
                const already = (r.note.note_attachments ?? []).some(a => Number(a.id) === attachId)
                if (already) return r
                return {
                  ...r,
                  note: {
                    ...r.note,
                    note_attachments: [
                      ...(r.note.note_attachments ?? []),
                      {
                        id:           newRow.id,
                        storage_path: newRow.storage_path,
                        file_name:    newRow.file_name,
                        mime_type:    newRow.mime_type,
                      },
                    ],
                  },
                }
              })
            )
          }
        )
        .subscribe()
    )

    return () => { channels.forEach(ch => supabase.removeChannel(ch)) }
  // ownerIdKey changes only when the set of owners changes, not on every
  // attachment update, so this effect is not re-triggered by its own state writes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, ownerIdKey])

  // ── DELETE subscription (unfiltered — filters don't work for DELETE) ────
  useEffect(() => {
    if (!userId || !noteIdKey) return

    const channel = supabase
      .channel(`shared-attach-delete-${userId}`)
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'note_attachments' },
        ({ old: oldRow }) => {
          const noteId   = Number(oldRow.note_id)
          const attachId = Number(oldRow.id)
          // Discard events for notes not in our shared set
          if (!sharedNoteIdsRef.current.has(noteId)) return
          setShareRecords(curr =>
            curr.map(r => {
              if (r.note?.id !== noteId) return r
              return {
                ...r,
                note: {
                  ...r.note,
                  note_attachments: (r.note.note_attachments ?? []).filter(
                    a => Number(a.id) !== attachId
                  ),
                },
              }
            })
          )
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  // noteIdKey changes only when the set of shared notes changes, not on every
  // attachment update, so this effect is not re-triggered by its own state writes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, noteIdKey])

  // ── notes UPDATE subscription (title / content edits by the owner) ──────
  //
  // When user A edits a shared note's title or content and saves, walrus emits
  // an UPDATE event on the notes table. SharedNotesList has no subscription to
  // that table, so user B's card never reflected the change without a refresh.
  //
  // Filter: id=in.(noteId1,noteId2,...) — the "Contained in list" Realtime
  // filter (backed by Postgres `= ANY`) limits delivery to exactly the notes
  // that are shared with this user. Supabase supports up to 100 values per in()
  // filter; SharedNotesList is bounded by a user's share count, so this is safe.
  //
  // UPDATE events carry the full new row in the payload (the row exists in the
  // table, so walrus can run RLS and serialise all columns). The "notes: select
  // own or shared" policy (extended in migration 010) permits user B to read
  // any note they have a share record for, so walrus delivers the event.
  //
  // We merge only scalar fields from the WAL payload; joined data
  // (note_attachments, users) is NOT present in the raw Realtime payload and
  // must be preserved from existing state.
  //
  // Dedup: when user B (edit permission) saves from NoteEditor, App calls
  // sharedListRef.upsert() before this event arrives. Reapplying the same
  // scalar values is idempotent and harmless.
  useEffect(() => {
    if (!userId || !noteIdKey) return

    const channel = supabase
      .channel(`shared-notes-content-${userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'notes', filter: `id=in.(${noteIdKey})` },
        ({ new: newRow }) => {
          const noteId = Number(newRow.id)
          setShareRecords(curr =>
            curr.map(r => {
              if (r.note?.id !== noteId) return r
              return {
                ...r,
                note: {
                  ...r.note,
                  title:       newRow.title,
                  content:     newRow.content,
                  updated_at:  newRow.updated_at,
                  archived_at: newRow.archived_at,
                },
              }
            })
          )
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  // noteIdKey changes only when the set of shared notes changes, not on every
  // field update — this effect is not re-triggered by its own state writes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, noteIdKey])

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
