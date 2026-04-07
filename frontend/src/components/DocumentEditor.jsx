import { memo, useCallback, useEffect, useDeferredValue, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import * as Y from 'yjs'
import { fromUint8Array, toUint8Array } from 'js-base64'
import { supabase } from '../lib/supabase'
import { SupabaseBroadcastProvider } from '../lib/SupabaseBroadcastProvider'

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

// ── Text diff helper ────────────────────────────────────────────────────────
// Computes a minimal { index, deleteCount, insertText } diff between two
// strings using common-prefix / common-suffix comparison.  Sufficient for
// single-textarea editing (handles typing, paste, cut, and bulk replace).
function computeTextDiff(oldStr, newStr) {
  let start = 0
  while (start < oldStr.length && start < newStr.length && oldStr[start] === newStr[start]) {
    start++
  }
  let oldEnd = oldStr.length
  let newEnd = newStr.length
  while (oldEnd > start && newEnd > start && oldStr[oldEnd - 1] === newStr[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  return {
    index: start,
    deleteCount: oldEnd - start,
    insertText: newStr.slice(start, newEnd),
  }
}

// ── Cursor mapping helper ───────────────────────────────────────────────────
// Maps a cursor position from the old text to the new text using a Y.Text
// event delta (array of { retain, insert, delete } operations).
function mapCursorPosition(delta, pos) {
  let consumed = 0 // characters consumed from old text
  let produced = 0 // characters produced in new text
  for (const op of delta) {
    if (op.retain != null) {
      if (consumed + op.retain >= pos) return produced + (pos - consumed)
      consumed += op.retain
      produced += op.retain
    } else if (op.insert != null) {
      const len = typeof op.insert === 'string' ? op.insert.length : 1
      produced += len
    } else if (op.delete != null) {
      if (consumed + op.delete >= pos) return produced
      consumed += op.delete
    }
  }
  return produced + (pos - consumed)
}

/**
 * Route wrapper that reads the document ID from the URL, fetches the document
 * (or renders a blank editor for /documents/new), and passes it to DocumentEditor.
 * Also checks document_shares to determine the calling user's permission level.
 *
 * @param {{ userId: string, onOpenShare: (doc: object) => void }} props
 */
export function DocumentEditorRoute({ userId, onOpenShare }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const isNew = id === 'new'
  const [doc, setDoc] = useState(null)
  const [sharePermission, setSharePermission] = useState(null)
  const [loading, setLoading] = useState(!isNew)
  const [fetchError, setFetchError] = useState(null)

  useEffect(() => {
    if (isNew) {
      setDoc(null)
      setSharePermission(null)
      setLoading(false)
      setFetchError(null)
      return
    }

    // Reset state when id changes (e.g. after creating a new doc and navigating to its real ID)
    setLoading(true)
    setDoc(null)
    setSharePermission(null)
    setFetchError(null)

    let cancelled = false

    // async-parallel: fetch document + share permission in parallel
    Promise.all([
      supabase
        .from('documents')
        .select('id, user_id, title, body, yjs_state, created_at, updated_at')
        .eq('id', id)
        .single(),
      supabase
        .from('document_shares')
        .select('permission')
        .eq('document_id', id)
        .eq('shared_with_id', userId)
        .maybeSingle(),
    ]).then(([docResult, shareResult]) => {
      if (cancelled) return
      if (docResult.error) {
        setFetchError(docResult.error.message)
      } else {
        setDoc(docResult.data)
        // If the caller is the owner, sharePermission stays null (full access).
        // Otherwise use the share record's permission ('view' or 'edit').
        if (docResult.data.user_id !== userId && shareResult.data) {
          setSharePermission(shareResult.data.permission)
        }
      }
      setLoading(false)
    })

    return () => { cancelled = true }
  }, [id, isNew, userId])

  if (loading) return <p className="notes-status">Loading document…</p>
  if (fetchError) return <p className="notes-status notes-error">{fetchError}</p>

  const isOwner = !doc || doc.user_id === userId

  return (
    <DocumentEditor
      key={id}
      userId={userId}
      document={doc}
      navigate={navigate}
      sharePermission={isOwner ? null : sharePermission}
      onOpenShare={isOwner ? onOpenShare : null}
    />
  )
}

/**
 * Split-pane Markdown editor with live GFM preview and auto-save.
 * Supports three modes based on sharePermission:
 *   - null (owner): full editor + Share button
 *   - 'edit': full editor, no Share button
 *   - 'view': read-only full-width preview, no editor pane
 *
 * @param {{
 *   userId: string,
 *   document: object | null,
 *   navigate: (path: string, opts?: object) => void,
 *   sharePermission: string | null,
 *   onOpenShare: ((doc: object) => void) | null,
 * }} props
 */
export function DocumentEditor({ userId, document: doc, navigate, sharePermission, onOpenShare }) {
  const isViewOnly = sharePermission === 'view'
  const canEdit = sharePermission === null || sharePermission === 'edit'

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

  // ── Yjs CRDT state ─────────────────────────────────────────────────────
  const ydocRef = useRef(null)
  const ytextRef = useRef(null)
  const providerRef = useRef(null)

  // ── Auto-save (debounced 1.5 s after typing stops) ──────────────────────
  // Track what's already persisted so we can skip no-op saves.
  // StrictMode-safe: on mount the values equal the DB values → skip.
  const savedTitle = useRef(title)
  const savedBody = useRef(body)

  useEffect(() => {
    // View-only mode: never auto-save
    if (isViewOnly) return
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

      // Extract Yjs state + plain text atomically for persistence
      const ydoc = ydocRef.current
      const bodyText = ydoc ? ydoc.getText('content').toString() : body
      const yjsPayload = ydoc ? fromUint8Array(Y.encodeStateAsUpdate(ydoc)) : undefined

      if (currentDocId) {
        // Update existing
        const { error: updateErr } = await supabase
          .from('documents')
          .update({
            title: title || 'Untitled',
            body: bodyText,
            ...(yjsPayload != null && { yjs_state: yjsPayload }),
          })
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
        savedBody.current = bodyText
        setSaveStatus('saved')
      } else {
        // Create new
        const { data, error: insertErr } = await supabase
          .from('documents')
          .insert({
            user_id: userId,
            title: title || 'Untitled',
            body: bodyText,
            ...(yjsPayload != null && { yjs_state: yjsPayload }),
          })
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
        savedBody.current = bodyText
        // Replace /documents/new with the real ID so the URL is shareable
        // and Back doesn't revisit the blank "new" route.
        navigate(`/documents/${data.id}`, { replace: true })
        setSaveStatus('saved')
      }
    }, 1500)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [title, body, isViewOnly]) // eslint-disable-line react-hooks/exhaustive-deps

  // Clear "Saved" indicator after 2 s
  useEffect(() => {
    if (saveStatus !== 'saved') return
    const timer = setTimeout(() => setSaveStatus('idle'), 2000)
    return () => clearTimeout(timer)
  }, [saveStatus])

  // Refs to track current local values without adding them to the effect
  // dependency array (which would tear down the channel on every keystroke).
  const titleRef = useRef(title)
  const bodyRef  = useRef(body)
  titleRef.current = title
  bodyRef.current  = body

  // ── Realtime: title sync via postgres_changes ───────────────────────────
  // Body is now synced via Yjs Broadcast — only title uses DB-level Realtime.
  useEffect(() => {
    if (!docId) return

    const channel = supabase
      .channel(`doc-editor-rt-${docId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'documents', filter: `id=eq.${docId}` },
        ({ new: newRow }) => {
          if (isViewOnly) {
            if (newRow.title != null) { savedTitle.current = newRow.title; titleRef.current = newRow.title; setTitle(newRow.title) }
            return
          }
          const titleDirty = titleRef.current !== savedTitle.current
          if (!titleDirty && newRow.title != null && newRow.title !== savedTitle.current) {
            savedTitle.current = newRow.title
            titleRef.current   = newRow.title
            setTitle(newRow.title)
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [docId, isViewOnly])

  // ── Yjs CRDT: initialise document and observe changes ───────────────────
  useEffect(() => {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ydocRef.current = ydoc
    ytextRef.current = ytext

    // Initialise from persisted Yjs state (both clients load the same CRDT
    // structure → incremental updates merge correctly).
    // When yjs_state is NULL (legacy doc), we do NOT seed here — seeding
    // happens later via the provider's sync protocol so that only one client
    // creates the CRDT history and the other receives it as a full state
    // merge, avoiding incompatible duplicate insertions.
    if (doc?.yjs_state) {
      try {
        Y.applyUpdate(ydoc, toUint8Array(doc.yjs_state))
      } catch {
        // Corrupted state — leave empty; will be seeded via provider or no-peers
      }
    }

    // Sync React state with the Yjs content
    const initialText = ytext.toString()
    if (initialText && initialText !== bodyRef.current) {
      savedBody.current = initialText
      bodyRef.current = initialText
      setBody(initialText)
    }

    // Observe Y.Text changes (remote peer edits or local programmatic edits)
    const observer = (event, transaction) => {
      // Skip updates that originated from the local textarea handler —
      // handleBodyChange already called setBody for those.
      if (transaction.origin === 'textarea-input') return
      const text = ytext.toString()
      if (text === bodyRef.current) return

      // Best-effort cursor preservation for remote edits
      const ta = textareaRef.current
      let adjStart, adjEnd
      if (ta && transaction.origin === 'remote') {
        adjStart = mapCursorPosition(event.delta, ta.selectionStart)
        adjEnd   = mapCursorPosition(event.delta, ta.selectionEnd)
      }

      bodyRef.current = text
      setBody(text)

      if (adjStart != null && ta) {
        requestAnimationFrame(() => {
          ta.selectionStart = adjStart
          ta.selectionEnd   = adjEnd
        })
      }
    }
    ytext.observe(observer)

    return () => {
      ytext.unobserve(observer)
      ydoc.destroy()
      ydocRef.current = null
      ytextRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Broadcast provider (requires a persisted docId) ─────────────────────
  useEffect(() => {
    if (!docId || !ydocRef.current) return
    const provider = new SupabaseBroadcastProvider(supabase, docId, ydocRef.current)
    providerRef.current = provider

    provider.on('synced', () => {
      // Peer state received — Y.Doc is now up to date from a remote peer
      const ytext = ytextRef.current
      if (!ytext) return
      const text = ytext.toString()
      if (text !== bodyRef.current) {
        savedBody.current = text
        bodyRef.current = text
        setBody(text)
      }
    })

    provider.on('no-peers', () => {
      // No other clients online — if Y.Doc is still empty (legacy doc with
      // no yjs_state), seed it from the plain-text body now.
      const ytext = ytextRef.current
      if (!ytext) return
      if (ytext.toString() === '' && doc?.body) {
        ytext.insert(0, doc.body)
        const text = ytext.toString()
        bodyRef.current = text
        setBody(text)
      }
    })

    return () => {
      provider.destroy()
      providerRef.current = null
    }
  }, [docId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Page unload safety net ──────────────────────────────────────────────
  useEffect(() => {
    const flushSave = async () => {
      const ydoc = ydocRef.current
      const currentDocId = docIdRef.current
      if (!currentDocId || !ydoc) return
      const currentTitle = titleRef.current
      const currentBody = ydoc.getText('content').toString()
      if (currentTitle === savedTitle.current && currentBody === savedBody.current) return
      const yjsPayload = fromUint8Array(Y.encodeStateAsUpdate(ydoc))
      await supabase
        .from('documents')
        .update({
          title: currentTitle || 'Untitled',
          body: currentBody,
          yjs_state: yjsPayload,
        })
        .eq('id', currentDocId)
      savedTitle.current = currentTitle
      savedBody.current = currentBody
    }

    const handleVisChange = () => {
      if (document.visibilityState === 'hidden') flushSave()
    }
    const handleBeforeUnload = (e) => {
      const dirty =
        titleRef.current !== savedTitle.current ||
        bodyRef.current !== savedBody.current
      if (dirty) { e.preventDefault(); e.returnValue = '' }
    }

    if (!isViewOnly) {
      document.addEventListener('visibilitychange', handleVisChange)
      window.addEventListener('beforeunload', handleBeforeUnload)
    }
    return () => {
      document.removeEventListener('visibilitychange', handleVisChange)
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [isViewOnly]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Textarea input → Yjs (diff-based) ──────────────────────────────────
  function handleBodyChange(e) {
    const newValue = e.target.value
    const ytext = ytextRef.current
    if (!ytext) { setBody(newValue); return }

    const oldValue = ytext.toString()
    if (newValue === oldValue) return

    const { index, deleteCount, insertText } = computeTextDiff(oldValue, newValue)
    ydocRef.current.transact(() => {
      if (deleteCount > 0) ytext.delete(index, deleteCount)
      if (insertText) ytext.insert(index, insertText)
    }, 'textarea-input')

    bodyRef.current = ytext.toString()
    setBody(bodyRef.current)
  }

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
        {canEdit ? (
          <input
            className="doc-title-input"
            type="text"
            placeholder="Document title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            autoFocus
          />
        ) : (
          <h1 className="doc-title-readonly">{title || 'Untitled'}</h1>
        )}
        {onOpenShare && docId && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onOpenShare({ id: docId, title })}
          >
            Share
          </button>
        )}
        {canEdit && (
          <span className={`doc-save-status doc-save-status--${saveStatus}`}>
            {saveStatus === 'saving' && 'Saving…'}
            {saveStatus === 'saved' && 'Saved'}
            {saveStatus === 'error' && 'Save failed'}
          </span>
        )}
      </div>

      {error && <p className="field-error doc-editor-error">{error}</p>}

      {/* ── View-only: full-width preview ──────────────────────────── */}
      {isViewOnly ? (
        <div className="doc-editor-split doc-editor-split--readonly">
          <div className="doc-editor-pane doc-editor-pane--preview doc-editor-pane--preview-only">
            <Preview markdown={body} />
          </div>
        </div>
      ) : (
        /* ── Split pane (owner or edit permission) ─────────────────── */
        <div className="doc-editor-split" ref={containerRef}>
          <div className="doc-editor-pane">
            <textarea
              ref={textareaRef}
              className="doc-editor-textarea"
              placeholder="Write Markdown here…"
              value={body}
              onChange={handleBodyChange}
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
      )}
    </div>
  )
}
