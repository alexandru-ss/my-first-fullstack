import { useState } from 'react'
import { supabase } from '../lib/supabase'

/**
 * Placeholder editor for documents — title + raw Markdown body in a textarea.
 *
 * @param {{
 *   userId: string,
 *   document: object | null,
 *   onSave: (savedDoc: object) => void,
 *   onCancel: () => void,
 * }} props
 */
export function DocumentEditor({ userId, document: doc, onSave, onCancel }) {
  const [title, setTitle] = useState(doc?.title ?? '')
  const [body, setBody] = useState(doc?.body ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const isCreate = doc === null

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)

    if (isCreate) {
      const { data, error: insertErr } = await supabase
        .from('documents')
        .insert({ user_id: userId, title: title || 'Untitled', body })
        .select()
        .single()

      if (insertErr) {
        setError(insertErr.message)
        setBusy(false)
        return
      }
      onSave(data)
    } else {
      const { data, error: updateErr } = await supabase
        .from('documents')
        .update({ title, body })
        .eq('id', doc.id)
        .select()
        .single()

      if (updateErr) {
        setError(updateErr.message)
        setBusy(false)
        return
      }
      onSave(data)
    }
  }

  return (
    <div className="editor-overlay" onMouseDown={onCancel}>
      {/* stopPropagation prevents the backdrop click from closing */}
      <form
        className="editor-form doc-editor-form"
        onSubmit={handleSubmit}
        onMouseDown={e => e.stopPropagation()}
      >
        <h2>{isCreate ? 'New document' : 'Edit document'}</h2>

        <input
          className="field-input"
          type="text"
          placeholder="Title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          autoFocus
        />

        <textarea
          className="field-input doc-body-textarea"
          placeholder="Write Markdown here…"
          value={body}
          onChange={e => setBody(e.target.value)}
          rows={16}
        />

        {error && <p className="field-error">{error}</p>}

        <div className="editor-actions">
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : isCreate ? 'Create document' : 'Save changes'}
          </button>
          <button className="btn-secondary" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
