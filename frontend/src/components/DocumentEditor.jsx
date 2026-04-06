import { memo, useCallback, useEffect, useDeferredValue, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { supabase } from '../lib/supabase'

// ── Memoized preview ────────────────────────────────────────────────────────
// rerender-no-inline-components + rerender-memo: module-scope memoized component
// so the preview only re-renders when the deferred markdown string changes.
const Preview = memo(function Preview({ markdown }) {
  return (
    <div className="doc-preview">
      {markdown
        ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
        : <p className="doc-preview-empty">Preview will appear here…</p>}
    </div>
  )
})

// ── Resizable split-pane hook ───────────────────────────────────────────────
// rerender-use-ref-transient-values: fraction is a high-frequency transient
// value — store in a ref, mutate DOM directly, zero React re-renders during drag.
function useSplitPane(initialFraction = 0.5) {
  const containerRef = useRef(null)
  const fractionRef = useRef(initialFraction)

  const onMouseDown = useCallback((e) => {
    e.preventDefault()
    const container = containerRef.current
    if (!container) return

    const onMouseMove = (moveEvent) => {
      const rect = container.getBoundingClientRect()
      const fraction = Math.min(Math.max(
        (moveEvent.clientX - rect.left) / rect.width, 0.2
      ), 0.8)
      fractionRef.current = fraction

      // js-batch-dom-css: direct style mutation, no React re-render
      const editor = container.children[0]
      const preview = container.children[2]
      editor.style.flexBasis = `${fraction * 100}%`
      preview.style.flexBasis = `${(1 - fraction) * 100}%`
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  return { containerRef, onMouseDown }
}

// ── Keyboard shortcut helper ────────────────────────────────────────────────
// rerender-move-effect-to-event: interaction logic belongs in event handlers.
function wrapSelection(textarea, before, after) {
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const text = textarea.value
  const selected = text.slice(start, end)

  const newText = text.slice(0, start) + before + selected + after + text.slice(end)

  // Use native setter so React picks up the change via the onChange synthetic event
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype, 'value'
  ).set
  nativeSetter.call(textarea, newText)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))

  // Restore cursor: place it after the inserted prefix (or select the wrapped text)
  requestAnimationFrame(() => {
    textarea.selectionStart = start + before.length
    textarea.selectionEnd = end + before.length
    textarea.focus()
  })
}

/**
 * Split-pane Markdown editor with live GFM preview and auto-save.
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
  // After first auto-save of a new doc, store its id so subsequent saves are updates
  const [docId, setDocId] = useState(doc?.id ?? null)
  const [saveStatus, setSaveStatus] = useState('idle') // idle | saving | saved | error
  const [error, setError] = useState(null)
  const textareaRef = useRef(null)

  // rerender-use-deferred-value: let React prioritise the textarea input;
  // the preview re-renders only when the scheduler is idle.
  const deferredBody = useDeferredValue(body)

  const { containerRef, onMouseDown } = useSplitPane()

  // ── Auto-save (debounced 1.5 s after typing stops) ──────────────────────
  // rerender-split-combined-hooks: auto-save has its own lifecycle.
  const isFirstRender = useRef(true)
  useEffect(() => {
    // Skip auto-save on initial mount (the doc is already in the DB, or blank)
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }

    const timer = setTimeout(async () => {
      setSaveStatus('saving')
      setError(null)

      if (docId) {
        // Update existing
        const { data, error: updateErr } = await supabase
          .from('documents')
          .update({ title: title || 'Untitled', body })
          .eq('id', docId)
          .select()
          .single()

        if (updateErr) {
          setSaveStatus('error')
          setError(updateErr.message)
          return
        }
        setSaveStatus('saved')
        onSave(data)
      } else {
        // Create new
        const { data, error: insertErr } = await supabase
          .from('documents')
          .insert({ user_id: userId, title: title || 'Untitled', body })
          .select()
          .single()

        if (insertErr) {
          setSaveStatus('error')
          setError(insertErr.message)
          return
        }
        setDocId(data.id)
        setSaveStatus('saved')
        onSave(data)
      }
    }, 1500)

    return () => clearTimeout(timer)
  }, [title, body]) // eslint-disable-line react-hooks/exhaustive-deps

  // Clear "Saved" indicator after 2 s
  useEffect(() => {
    if (saveStatus !== 'saved') return
    const timer = setTimeout(() => setSaveStatus('idle'), 2000)
    return () => clearTimeout(timer)
  }, [saveStatus])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  function handleKeyDown(e) {
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return

    if (e.key === 'b') {
      e.preventDefault()
      wrapSelection(textareaRef.current, '**', '**')
    } else if (e.key === 'i') {
      e.preventDefault()
      wrapSelection(textareaRef.current, '_', '_')
    }
  }

  return (
    <div className="editor-overlay doc-editor-overlay" onMouseDown={onCancel}>
      <div
        className="doc-editor-shell"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* ── Header row ──────────────────────────────────────────────── */}
        <div className="doc-editor-header">
          <button className="btn-secondary" type="button" onClick={onCancel}>
            ← Back
          </button>
          <input
            className="field-input doc-title-input"
            type="text"
            placeholder="Document title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            autoFocus
          />
          <span className={`doc-save-status doc-save-status--${saveStatus}`}>
            {saveStatus === 'saving' && 'Saving…'}
            {saveStatus === 'saved' && 'Saved'}
            {saveStatus === 'error' && 'Save failed'}
          </span>
        </div>

        {error && <p className="field-error doc-editor-error">{error}</p>}

        {/* ── Split pane ──────────────────────────────────────────────── */}
        <div className="doc-editor-split" ref={containerRef}>
          <div className="doc-editor-pane" style={{ flexBasis: '50%' }}>
            <textarea
              ref={textareaRef}
              className="doc-editor-textarea"
              placeholder="Write Markdown here…"
              value={body}
              onChange={e => setBody(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
            />
          </div>

          <div
            className="doc-editor-divider"
            onMouseDown={onMouseDown}
            role="separator"
            aria-orientation="vertical"
          />

          <div className="doc-editor-pane doc-editor-pane--preview" style={{ flexBasis: '50%' }}>
            <Preview markdown={deferredBody} />
          </div>
        </div>
      </div>
    </div>
  )
}
