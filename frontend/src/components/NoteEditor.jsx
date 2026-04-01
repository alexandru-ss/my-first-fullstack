import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// rerender-no-inline-components: TagInput defined at module scope
function TagInput({ selectedTags, allTags, userId, onChange, onTagCreated, onError }) {
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
              <li
                key={tag.id}
                className="tag-dropdown-item"
                onMouseDown={() => handleSelect(tag)}
                role="option"
              >
                {tag.name}
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
export function NoteEditor({ userId, note, onSave, onCancel }) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [pinned, setPinned] = useState(false)
  const [selectedTags, setSelectedTags] = useState([])
  const [allTags, setAllTags] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

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

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setBusy(true)

    try {
      const payload = {
        user_id: userId,
        title: title.trim(),
        content: content.trim() || null,
        pinned,
        updated_at: new Date().toISOString(),
      }

      if (note) {
        // Edit — run note update AND note_tags delete in parallel (async-parallel)
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

        onSave({ ...data, tags: selectedTags })
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

        onSave({ ...data, tags: selectedTags })
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
          onError={msg => setError(msg)}
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
