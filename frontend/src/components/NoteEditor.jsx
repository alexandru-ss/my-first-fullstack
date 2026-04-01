import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

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
export function NoteEditor({ userId, note, onSave, onCancel }) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Populate fields when switching into edit mode.
  // rerender-dependencies: intentionally depend only on note?.id (primitive).
  // We want to reset fields when a *different* note is opened, not on every
  // keystroke — so note.title / note.content are deliberately excluded.
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    setTitle(note?.title ?? '')
    setContent(note?.content ?? '')
    setError(null)
  }, [note?.id])
  /* eslint-enable react-hooks/exhaustive-deps */

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setBusy(true)

    try {
      const payload = {
        user_id: userId,
        title: title.trim(),
        content: content.trim() || null,
        updated_at: new Date().toISOString(),
      }

      if (note) {
        // Edit — upsert by id
        const { data, error: upsertError } = await supabase
          .from('notes')
          .update(payload)
          .eq('id', note.id)
          .select('id, title, content, created_at, updated_at')
          .single()

        if (upsertError) throw upsertError
        onSave(data)
      } else {
        // Create
        const { data, error: insertError } = await supabase
          .from('notes')
          .insert(payload)
          .select('id, title, content, created_at, updated_at')
          .single()

        if (insertError) throw insertError
        onSave(data)
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
