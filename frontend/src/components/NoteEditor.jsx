import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { FilePreviewOverlay } from './FilePreview'

const ALLOWED_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf',
])
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB

function validateFile(file) {
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return `"${file.type}" is not supported. Upload an image (PNG, JPEG, GIF, WebP) or PDF.`
  }
  if (file.size > MAX_FILE_BYTES) {
    return `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — maximum is 10 MB.`
  }
  return null
}

// rerender-no-inline-components: defined at module scope
function AttachmentItem({ attachment, onDelete }) {
  const [previewUrl, setPreviewUrl] = useState(null)
  const [fetchingPreview, setFetchingPreview] = useState(false)

  async function handleOpenPreview() {
    if (fetchingPreview) return
    setFetchingPreview(true)
    const { data } = await supabase.storage
      .from('attachments')
      .createSignedUrl(attachment.storage_path, 3600)
    setFetchingPreview(false)
    if (!data?.signedUrl) return
    if (attachment.mime_type === 'application/pdf') {
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
    } else {
      setPreviewUrl(data.signedUrl)
    }
  }

  return (
    <>
      {previewUrl && (
        <FilePreviewOverlay
          url={previewUrl}
          fileName={attachment.file_name}
          onClose={() => setPreviewUrl(null)}
        />
      )}
      <li className="attachment-item">
        <button
          type="button"
          className="attachment-preview-btn"
          onClick={handleOpenPreview}
          disabled={fetchingPreview}
          aria-label={`Preview ${attachment.file_name}`}
        >
          {attachment.mime_type?.startsWith('image/') ? '🖼' : '📄'}
        </button>
        <button
          type="button"
          className="attachment-preview-btn attachment-name"
          onClick={handleOpenPreview}
          disabled={fetchingPreview}
          title={attachment.file_name}
        >
          {fetchingPreview ? 'Loading…' : attachment.file_name}
        </button>
        {attachment.size_bytes != null && (
          <span className="attachment-size">
            {(attachment.size_bytes / 1024).toFixed(0)} KB
          </span>
        )}
        {onDelete && (
          <button
            type="button"
            className="attachment-delete"
            onClick={() => onDelete(attachment)}
            aria-label={`Remove ${attachment.file_name}`}
          >
            ×
          </button>
        )}
      </li>
    </>
  )
}

// rerender-no-inline-components: defined at module scope
function AttachmentUploader({ uploading, error, onFileSelected }) {
  const inputRef = useRef(null)

  function handleChange(e) {
    const file = e.target.files?.[0]
    if (file) onFileSelected(file)
    // Reset so the same file can be re-selected after an error
    e.target.value = ''
  }

  return (
    <div className="attachment-uploader">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
        onChange={handleChange}
        style={{ display: 'none' }}
        aria-hidden="true"
      />
      <button
        type="button"
        className="btn-secondary"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
      >
        {uploading ? 'Uploading…' : 'Attach file'}
      </button>
      {error && (
        <p className="attachment-error" role="alert">{error}</p>
      )}
    </div>
  )
}

// rerender-no-inline-components: TagInput defined at module scope
function TagInput({ selectedTags, allTags, userId, onChange, onTagCreated, onTagDeleted, onError }) {
  const [input, setInput] = useState('')
  const [open, setOpen] = useState(false)

  const lowerInput = input.toLowerCase().trim()
  const selectedIds = new Set(selectedTags.map(t => t.id))

  // js-combine-iterations: single pass to filter + match suggestions
  const suggestions = allTags.reduce((acc, tag) => {
    if (!selectedIds.has(tag.id) && tag.name.toLowerCase().includes(lowerInput)) {
      acc.push(tag)
    }
    return acc
  }, [])

  const exactMatch = allTags.some(t => t.name.toLowerCase() === lowerInput)
  const showCreate = lowerInput.length > 0 && !exactMatch

  async function handleDelete(tag) {
    const { error } = await supabase.from('tags').delete().eq('id', tag.id)
    if (error) {
      onError?.(error.message)
    } else {
      onTagDeleted?.(tag)
    }
  }

  async function handleCreate() {
    const name = lowerInput
    const { data, error } = await supabase
      .from('tags')
      .insert({ user_id: userId, name })
      .select('id, name')
      .single()

    if (error) {
      if (error.code === '23505') {
        // Unique conflict — tag already exists, just add it to selection
        const existing = allTags.find(t => t.name.toLowerCase() === name)
        if (existing && !selectedIds.has(existing.id)) {
          onChange([...selectedTags, existing])
        }
      } else {
        onError?.(error.message)
      }
    } else {
      onTagCreated(data)
      onChange([...selectedTags, data])
    }
    setInput('')
    setOpen(false)
  }

  function handleSelect(tag) {
    onChange([...selectedTags, tag])
    setInput('')
    setOpen(false)
  }

  function handleRemove(tagId) {
    onChange(selectedTags.filter(t => t.id !== tagId))
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (suggestions.length > 0 && !showCreate) handleSelect(suggestions[0])
      else if (showCreate) handleCreate()
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div>
      <div className="tags-row" style={{ marginBottom: selectedTags.length ? '6px' : 0 }}>
        {selectedTags.map(tag => (
          <span key={tag.id} className="tag-pill">
            {tag.name}
            <button
              type="button"
              className="tag-pill-remove"
              onClick={() => handleRemove(tag.id)}
              aria-label={`Remove tag ${tag.name}`}
            >×</button>
          </span>
        ))}
      </div>
      <div className="tag-input-wrapper">
        <input
          className="field-input"
          type="text"
          placeholder="Add tag…"
          value={input}
          onChange={e => { setInput(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={handleKeyDown}
        />
        {open && (suggestions.length > 0 || showCreate) && (
          <ul className="tag-dropdown" role="listbox">
            {suggestions.map(tag => (
              <li key={tag.id} className="tag-dropdown-item" role="option">
                <span
                  className="tag-dropdown-label"
                  onMouseDown={() => handleSelect(tag)}
                >
                  {tag.name}
                </span>
                <button
                  type="button"
                  className="tag-dropdown-delete"
                  onMouseDown={e => { e.preventDefault(); handleDelete(tag) }}
                  aria-label={`Delete tag ${tag.name}`}
                >×</button>
              </li>
            ))}
            {showCreate && (
              <li
                className="tag-dropdown-item tag-dropdown-create"
                onMouseDown={handleCreate}
                role="option"
              >
                Create "{lowerInput}"
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * Create or edit a note.
 *
 * @param {{
 *   userId: string,
 *   note: object | null,        // null = create mode, object = edit mode
 *   onSave: (saved: object) => void,
 *   onCancel: () => void
 * }} props
 */
export function NoteEditor({ userId, note, onSave, onCancel, onAttachmentsChange, onTagDeleted, sharePermission }) {
  // sharePermission: null (owner) | 'edit' (shared editor)
  // When 'edit': restrict to title + content only; hide pin, tags, attachment management.
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [pinned, setPinned] = useState(false)
  const [selectedTags, setSelectedTags] = useState([])
  const [allTags, setAllTags] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // ─── Attachment state ────────────────────────────────────────────────────
  const [attachments, setAttachments] = useState([])
  const [uploading, setUploading] = useState(false)
  const [attachError, setAttachError] = useState(null)

  // advanced-use-latest: always read the current onAttachmentsChange without
  // adding it to callback deps (which would destabilise handleAttach/handleDeleteAttachment).
  const onAttachmentsChangeRef = useRef(onAttachmentsChange)
  useEffect(() => { onAttachmentsChangeRef.current = onAttachmentsChange })

  // advanced-use-latest: always read the current attachments list from stable
  // callbacks without capturing a stale closure.
  const attachmentsRef = useRef([])
  useEffect(() => { attachmentsRef.current = attachments }, [attachments])

  // rerender-split-combined-hooks: separate effect for allTags (userId dep)
  // from note-field reset effect (note?.id dep)
  // rerender-dependencies: userId is a string primitive
  useEffect(() => {
    if (!userId) return
    supabase
      .from('tags')
      .select('id, name')
      .eq('user_id', userId)
      .order('name')
      .then(({ data }) => {
        if (data) setAllTags(data)
      })
  }, [userId])

  // Populate fields when switching into edit mode.
  // rerender-dependencies: intentionally depend only on note?.id (primitive).
  // We want to reset fields when a *different* note is opened, not on every
  // keystroke — so note.title / note.content are deliberately excluded.
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    setTitle(note?.title ?? '')
    setContent(note?.content ?? '')
    setPinned(note?.pinned ?? false)
    setSelectedTags(note?.tags ?? [])
    setError(null)
  }, [note?.id])
  /* eslint-enable react-hooks/exhaustive-deps */

  // rerender-split-combined-hooks: fetch attachments separately — only when
  // editing an existing note (note?.id is truthy).
  // After the fetch we also call onAttachmentsChangeRef to sync the note card
  // with the DB truth. This corrects any stale list state on the card caused
  // by Realtime events that were missed or arrived out of order (e.g. a delete
  // that happened in another tab before the event:* subscription was in place).
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!note?.id) { setAttachments([]); return }
    supabase
      .from('note_attachments')
      .select('id, storage_path, file_name, mime_type, size_bytes, created_at')
      .eq('note_id', note.id)
      .order('created_at')
      .then(({ data }) => {
        if (data) {
          setAttachments(data)
          // Reconcile the note card: if local state has a ghost attachment (or
          // is missing a newly-added one), replace it with the DB truth now.
          onAttachmentsChangeRef.current?.(data)
        }
      })
  }, [note?.id])
  /* eslint-enable react-hooks/exhaustive-deps */

  // rerender-split-combined-hooks: Realtime subscription for attachment changes
  // made by the note owner while a shared editor has the editor open.
  //
  // When sharePermission is set the current user is NOT the owner:
  //   · They cannot upload or delete attachments (UI buttons are hidden).
  //   · The owner may still add / remove attachments concurrently.
  // Without this effect, user B's editor shows a stale attachment list until
  // the editor is closed or the page is refreshed.
  //
  // Supabase Realtime does not apply column filters to DELETE events (documented
  // limitation: "Delete events are not filterable"). If we used event:'*' with a
  // note_id filter, the INSERT behaviour would work but the DELETE event would
  // never be delivered to a non-owner subscriber.
  //
  // Solution: two separate .on() registrations on the same channel:
  //   INSERT — filtered by note_id so we only get inserts for this note.
  //   DELETE — no filter; walrus delivers all DELETE events unconditionally
  //             because it cannot evaluate RLS on a row that no longer exists.
  //             Client-side check (note?.id) discards events for other notes.
  //             REPLICA IDENTITY FULL (migration 009) ensures the full old row —
  //             including id — is present in the payload so we can locate the
  //             correct attachment to remove.
  //
  // Note: contrary to the previous implementation concern, Supabase Realtime
  // DOES honour multiple .on() calls when they register *different* event types
  // (INSERT vs DELETE). The dedup issue only affects registering the same event
  // type twice on the same channel (e.g. two separate event:'INSERT' handlers).
  useEffect(() => {
    if (!note?.id || sharePermission === null) return

    const channel = supabase
      .channel(`note-editor-attachments-${note.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'note_attachments', filter: `note_id=eq.${note.id}` },
        ({ new: newRow }) => {
          const insertId = Number(newRow.id)
          // Dedup: same-tab optimistic adds (unlikely for shared editors, but safe)
          if (attachmentsRef.current.some(a => Number(a.id) === insertId)) return
          const next = [
            ...attachmentsRef.current,
            {
              id:           newRow.id,
              storage_path: newRow.storage_path,
              file_name:    newRow.file_name,
              mime_type:    newRow.mime_type,
              size_bytes:   newRow.size_bytes,
              created_at:   newRow.created_at,
            },
          ]
          setAttachments(next)
          onAttachmentsChangeRef.current?.(next)
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'note_attachments' },
        ({ old: oldRow }) => {
          // Client-side guard: discard events for attachments that belong to
          // other notes (no server-side filter is possible for DELETE events).
          if (Number(oldRow.note_id) !== Number(note.id)) return
          // Number() normalises bigint columns that Realtime may serialise as
          // strings in some versions (same pattern as SharedNotesList).
          const attachId = Number(oldRow.id)
          const next = attachmentsRef.current.filter(a => Number(a.id) !== attachId)
          setAttachments(next)
          onAttachmentsChangeRef.current?.(next)
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [note?.id, sharePermission])

  // rerender-functional-setstate: stable callback, no stale-closure risk
  const handleAttach = useCallback(async (file) => {
    setAttachError(null)
    const validationError = validateFile(file)
    if (validationError) { setAttachError(validationError); return }

    const safeName = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${file.name}`
    const storagePath = `${userId}/${note.id}/${safeName}`

    setUploading(true)
    const { error: uploadError } = await supabase.storage
      .from('attachments')
      .upload(storagePath, file)

    if (uploadError) {
      setAttachError(uploadError.message)
      setUploading(false)
      return
    }

    const { data: newRow, error: insertError } = await supabase
      .from('note_attachments')
      .insert({
        note_id: note.id,
        user_id: userId,
        storage_path: storagePath,
        file_name: file.name,
        mime_type: file.type || null,
        size_bytes: file.size,
      })
      .select('id, storage_path, file_name, mime_type, size_bytes, created_at')
      .single()

    if (insertError) {
      setAttachError(insertError.message)
    } else {
      // Read current list from ref (avoids stale closure on the callback dep).
      // Uploads are sequential (button disabled during upload) so ref is current.
      const next = [...attachmentsRef.current, newRow]
      setAttachments(next)
      onAttachmentsChangeRef.current?.(next)
    }
    setUploading(false)
  }, [userId, note?.id])

  // advanced-use-latest: read current list from ref so this callback stays
  // stable (no attachments dep) while always operating on fresh state.
  const handleDeleteAttachment = useCallback(async (attachment) => {
    // Capture current list before optimistic removal for rollback.
    const prev = attachmentsRef.current
    const next = prev.filter(a => a.id !== attachment.id)
    setAttachments(next)
    onAttachmentsChangeRef.current?.(next)

    // async-parallel: remove from storage and DB simultaneously
    const [{ error: storageError }, { error: dbError }] = await Promise.all([
      supabase.storage.from('attachments').remove([attachment.storage_path]),
      supabase.from('note_attachments').delete().eq('id', attachment.id),
    ])

    if (storageError || dbError) {
      // Rollback: restore the removed attachment in its original order
      const restored = [...prev].toSorted(
        (a, b) => new Date(a.created_at) - new Date(b.created_at)
      )
      setAttachments(restored)
      onAttachmentsChangeRef.current?.(restored)
      setAttachError((storageError ?? dbError).message)
    }
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setBusy(true)

    try {
      // Shared editors can only update title + content; they cannot change
      // ownership, pin state, or anything else.
      const payload = sharePermission === 'edit'
        ? {
            title:      title.trim(),
            content:    content.trim() || null,
            updated_at: new Date().toISOString(),
          }
        : {
            user_id:    userId,
            title:      title.trim(),
            content:    content.trim() || null,
            pinned,
            updated_at: new Date().toISOString(),
          }

      if (note) {
        if (sharePermission === 'edit') {
          // Shared editor: update only, no tag operations
          const { data, error: upsertError } = await supabase
            .from('notes')
            .update(payload)
            .eq('id', note.id)
            .select('id, title, content, pinned, archived_at, created_at, updated_at')
            .single()

          if (upsertError) throw upsertError

          onSave({ ...data, tags: note.tags ?? [], note_attachments: attachments })
        } else {
          // Owner: run note update AND note_tags delete in parallel (async-parallel)
          const [{ data, error: upsertError }] = await Promise.all([
            supabase
              .from('notes')
              .update(payload)
              .eq('id', note.id)
              .select('id, title, content, pinned, archived_at, created_at, updated_at')
              .single(),
            supabase.from('note_tags').delete().eq('note_id', note.id),
          ])

          if (upsertError) throw upsertError

          if (selectedTags.length > 0) {
            const { error: tagError } = await supabase
              .from('note_tags')
              .insert(selectedTags.map(t => ({ note_id: data.id, tag_id: t.id })))
            if (tagError) throw tagError
          }

          // Pass note_attachments so the note card reflects the current state
          // immediately without waiting for a refetch.
          onSave({ ...data, tags: selectedTags, note_attachments: attachments })
        }
      } else {
        // Create — insert note first to get the id, then insert note_tags
        const { data, error: insertError } = await supabase
          .from('notes')
          .insert(payload)
          .select('id, title, content, pinned, archived_at, created_at, updated_at')
          .single()

        if (insertError) throw insertError

        if (selectedTags.length > 0) {
          const { error: tagError } = await supabase
            .from('note_tags')
            .insert(selectedTags.map(t => ({ note_id: data.id, tag_id: t.id })))
          if (tagError) throw tagError
        }

        onSave({ ...data, tags: selectedTags, note_attachments: [] })
      }
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="editor-overlay">
      <form className="editor-form" onSubmit={handleSubmit} noValidate>
        <h2>{note ? 'Edit note' : 'New note'}</h2>

        <label className="field-label" htmlFor="note-title">Title</label>
        <input
          id="note-title"
          className="field-input"
          type="text"
          required
          maxLength={200}
          value={title}
          onChange={e => setTitle(e.target.value)}
          autoFocus
        />

        <label className="field-label" htmlFor="note-content">Content</label>
        <textarea
          id="note-content"
          className="field-input field-textarea"
          rows={6}
          value={content}
          onChange={e => setContent(e.target.value)}
        />

        {/* Pin and Tags are hidden for shared editors — those are owner-only fields */}
        {sharePermission !== 'edit' && (
          <>
            <div className="field-checkbox">
              <input
                id="note-pinned"
                type="checkbox"
                checked={pinned}
                onChange={e => setPinned(e.target.checked)}
              />
              <label htmlFor="note-pinned">Pin this note</label>
            </div>

            <label className="field-label">Tags</label>
            <TagInput
              selectedTags={selectedTags}
              allTags={allTags}
              userId={userId}
              onChange={setSelectedTags}
              onTagCreated={newTag => setAllTags(curr => [...curr, newTag].toSorted((a, b) => a.name.localeCompare(b.name)))}
              onTagDeleted={deletedTag => {
                setAllTags(curr => curr.filter(t => t.id !== deletedTag.id))
                setSelectedTags(curr => curr.filter(t => t.id !== deletedTag.id))
                onTagDeleted?.(deletedTag)
              }}
              onError={msg => setError(msg)}
            />
          </>
        )}

        {/* ─── Attachments ─────────────────────────────────────── */}
        <div className="field-section">
          <span className="field-label">Attachments</span>
          {note?.id ? (
            <>
              {attachments.length > 0 && (
                <ul className="attachment-list">
                  {attachments.map(a => (
                    <AttachmentItem
                      key={a.id}
                      attachment={a}
                      onDelete={sharePermission === 'edit' ? null : handleDeleteAttachment}
                    />
                  ))}
                </ul>
              )}
              {/* Shared editors cannot upload new attachments */}
              {sharePermission !== 'edit' && (
                <AttachmentUploader
                  uploading={uploading}
                  error={attachError}
                  onFileSelected={handleAttach}
                />
              )}
            </>
          ) : (
            <p className="attachment-hint">Save the note first to attach files.</p>
          )}
        </div>

        {error && <p className="auth-error" role="alert">{error}</p>}

        <div className="editor-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !title.trim()}>
            {busy ? 'Saving…' : note ? 'Save changes' : 'Create note'}
          </button>
        </div>
      </form>
    </div>
  )
}
