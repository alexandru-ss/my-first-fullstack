import { memo, useCallback, useEffect, useDeferredValue, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
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

  // rerender-use-ref-transient-values: clear JS-applied inline styles when
  // crossing the mobile breakpoint so the CSS media query takes control.
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 768px)')
    function handleChange() {
      const container = containerRef.current
      if (!container || !mql.matches) return
      const editor = container.children[0]
      const preview = container.children[2]
      if (editor) editor.style.flexBasis = ''
      if (preview) preview.style.flexBasis = ''
    }
    mql.addEventListener('change', handleChange)
    handleChange()
    return () => mql.removeEventListener('change', handleChange)
  }, [])

  const onMouseDown = useCallback((e) => {
    e.preventDefault()
    // Disable drag-resize on narrow viewports
    if (window.matchMedia('(max-width: 768px)').matches) return
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
 * Route wrapper that reads the document ID from the URL, fetches the document
 * (or renders a blank editor for /documents/new), and passes it to DocumentEditor.
 *
 * @param {{ userId: string }} props
 */
export function DocumentEditorRoute({ userId }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const isNew = id === 'new'
  const [doc, setDoc] = useState(null)
  const [loading, setLoading] = useState(!isNew)
  const [fetchError, setFetchError] = useState(null)

  useEffect(() => {
    if (isNew) {
      setDoc(null)
      setLoading(false)
      setFetchError(null)
      return
    }

    // Reset state when id changes (e.g. after creating a new doc and navigating to its real ID)
    setLoading(true)
    setDoc(null)
    setFetchError(null)

    let cancelled = false

    supabase
      .from('documents')
      .select('id, title, body, created_at, updated_at')
      .eq('id', id)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          setFetchError(error.message)
        } else {
          setDoc(data)
        }
        setLoading(false)
      })

    return () => { cancelled = true }
  }, [id, isNew])

  if (loading) return <p className="notes-status">Loading document…</p>
  if (fetchError) return <p className="notes-status notes-error">{fetchError}</p>

  return (
    <DocumentEditor
      key={id}
      userId={userId}
      document={doc}
      navigate={navigate}
    />
  )
}

/**
 * Split-pane Markdown editor with live GFM preview and auto-save.
 *
 * @param {{
 *   userId: string,
 *   document: object | null,
 *   navigate: (path: string, opts?: object) => void,
 * }} props
 */
export function DocumentEditor({ userId, document: doc, navigate }) {
  const [title, setTitle] = useState(doc?.title ?? '')
  const [body, setBody] = useState(doc?.body ?? '')
  // After first auto-save of a new doc, store its id so subsequent saves are updates.
  // Use a ref so the async save callback always reads the latest value, even if a
  // prior save's setDocId hasn't triggered a re-render yet (avoids duplicate inserts).
  const [docId, setDocId] = useState(doc?.id ?? null)
  const docIdRef = useRef(docId)
  const [saveStatus, setSaveStatus] = useState('idle') // idle | saving | saved | error
  const [error, setError] = useState(null)
  const textareaRef = useRef(null)

  // rerender-use-deferred-value: let React prioritise the textarea input;
  // the preview re-renders only when the scheduler is idle.
  const deferredBody = useDeferredValue(body)

  const { containerRef, onMouseDown } = useSplitPane()

  // ── Auto-save (debounced 1.5 s after typing stops) ──────────────────────
  // Track what's already persisted so we can skip no-op saves.
  // StrictMode-safe: on mount the values equal the DB values → skip.
  const savedTitle = useRef(title)
  const savedBody = useRef(body)

  useEffect(() => {
    // Nothing changed from what's saved → skip (also handles initial mount)
    if (title === savedTitle.current && body === savedBody.current) {
      return
    }

    let cancelled = false

    const timer = setTimeout(async () => {
      if (cancelled) return
      setSaveStatus('saving')
      setError(null)

      const currentDocId = docIdRef.current

      if (currentDocId) {
        // Update existing
        const { error: updateErr } = await supabase
          .from('documents')
          .update({ title: title || 'Untitled', body })
          .eq('id', currentDocId)
          .select()
          .single()

        if (cancelled) return
        if (updateErr) {
          setSaveStatus('error')
          setError(updateErr.message)
          return
        }
        savedTitle.current = title
        savedBody.current = body
        setSaveStatus('saved')
      } else {
        // Create new
        const { data, error: insertErr } = await supabase
          .from('documents')
          .insert({ user_id: userId, title: title || 'Untitled', body })
          .select()
          .single()

        if (cancelled) return
        if (insertErr) {
          setSaveStatus('error')
          setError(insertErr.message)
          return
        }
        docIdRef.current = data.id
        setDocId(data.id)
        savedTitle.current = title
        savedBody.current = body
        // Replace /documents/new with the real ID so the URL is shareable
        // and Back doesn't revisit the blank "new" route.
        navigate(`/documents/${data.id}`, { replace: true })
        setSaveStatus('saved')
      }
    }, 0)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
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
    <div className="doc-editor-shell">
      {/* ── Header row ──────────────────────────────────────────────────── */}
      <div className="doc-editor-header">
        <Link className="btn-secondary" to="/documents">
          ← Back
        </Link>
        <input
          className="doc-title-input"
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
        <div className="doc-editor-pane">
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

        <div className="doc-editor-pane doc-editor-pane--preview">
          <Preview markdown={deferredBody} />
        </div>
      </div>
    </div>
  )
}
