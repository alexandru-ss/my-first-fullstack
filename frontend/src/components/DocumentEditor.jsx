import { memo, useCallback, useEffect, useDeferredValue, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import * as Y from 'yjs'
import { fromUint8Array, toUint8Array } from 'js-base64'
import { supabase } from '../lib/supabase'
import { SupabaseBroadcastProvider, userColor } from '../lib/SupabaseBroadcastProvider'

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

// ── Presence bar: colored avatar circles for connected peers ────────────────
const PresenceBar = memo(function PresenceBar({ users }) {
  if (!users || users.length === 0) return null
  return (
    <div className="presence-bar">
      {users.map(u => (
        <span
          key={u.clientId}
          className="presence-avatar"
          style={{ background: u.color }}
          title={u.name}
        >
          {u.avatarUrl
            ? <img src={u.avatarUrl} alt={u.name} className="presence-avatar-img" />
            : (u.name || '?')[0].toUpperCase()}
        </span>
      ))}
    </div>
  )
})

// ── Remote cursor overlay: colored line highlights with name labels ──────────
// Uses a hidden mirror <div> to account for word-wrap when calculating the
// vertical offset of each remote cursor.
const CursorOverlay = memo(function CursorOverlay({ users, body, scrollTop, textareaEl }) {
  if (!users || users.length === 0 || !textareaEl) return null

  // Build a mirror div that replicates the textarea's layout exactly
  const cs = getComputedStyle(textareaEl)
  const mirrorStyle = {
    position: 'absolute',
    visibility: 'hidden',
    top: 0,
    left: 0,
    width: cs.width,
    padding: cs.padding,
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing,
    wordSpacing: cs.wordSpacing,
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
    overflowWrap: 'break-word',
    boxSizing: cs.boxSizing,
    border: cs.border,
    overflow: 'hidden',
    height: 'auto',
    pointerEvents: 'none',
  }

  // Measure each user's cursor position using the mirror
  const lineHeight = parseFloat(cs.lineHeight)
  // If lineHeight is unitless (e.g. 1.65 not 23px), compute from fontSize
  const computedLineHeight = lineHeight > 10 ? lineHeight : parseFloat(cs.fontSize) * lineHeight

  const positions = users.map(u => {
    const idx = Math.min(u.cursorIndex ?? 0, body.length)
    return { ...u, idx }
  })

  return (
    <div className="cursor-overlay">
      {/* Hidden mirror to measure real line offsets with word-wrap */}
      <CursorMirror
        mirrorStyle={mirrorStyle}
        body={body}
        positions={positions}
        scrollTop={scrollTop}
        lineHeight={computedLineHeight}
      />
    </div>
  )
})

// Separate component so the mirror div exists in the DOM for measurement
function CursorMirror({ mirrorStyle, body, positions, scrollTop, lineHeight }) {
  const mirrorRef = useRef(null)
  const [offsets, setOffsets] = useState([])

  useEffect(() => {
    const mirror = mirrorRef.current
    if (!mirror) return

    const results = positions.map(pos => {
      // Clear and rebuild mirror content: text up to cursor + probe span
      mirror.textContent = ''
      const before = document.createTextNode(body.slice(0, pos.idx))
      const probe = document.createElement('span')
      probe.textContent = body[pos.idx] || '\u200b' // zero-width space if at end
      const after = document.createTextNode(body.slice(pos.idx + 1))
      mirror.appendChild(before)
      mirror.appendChild(probe)
      mirror.appendChild(after)

      return {
        top: probe.offsetTop,
        clientId: pos.clientId,
        name: pos.name,
        color: pos.color,
      }
    })

    setOffsets(results)
  }, [body, positions, mirrorRef]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div ref={mirrorRef} style={mirrorStyle} aria-hidden="true" />
      {offsets.map(o => (
        <div
          key={o.clientId}
          className="cursor-highlight"
          style={{
            top: o.top - scrollTop,
            height: lineHeight,
            borderLeftColor: o.color,
            backgroundColor: o.color + '18',
          }}
        >
          <span className="cursor-label" style={{ background: o.color }}>
            {o.name}
          </span>
        </div>
      ))}
    </>
  )
}

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
 * @param {{ userId: string, userEmail: string, displayName: string, avatarUrl: string | null, onOpenShare: (doc: object) => void }} props
 */
export function DocumentEditorRoute({ userId, userEmail, displayName, avatarUrl, onOpenShare }) {
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
      userEmail={userEmail}
      displayName={displayName}
      avatarUrl={avatarUrl}
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
 *   userEmail: string,
 *   displayName: string,
 *   avatarUrl: string | null,
 *   document: object | null,
 *   navigate: (path: string, opts?: object) => void,
 *   sharePermission: string | null,
 *   onOpenShare: ((doc: object) => void) | null,
 * }} props
 */
export function DocumentEditor({ userId, userEmail, displayName, avatarUrl, document: doc, navigate, sharePermission, onOpenShare }) {
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
  const ydocReadyRef = useRef(false)

  // ── Awareness (presence + remote cursors) ───────────────────────────────
  const [remoteUsers, setRemoteUsers] = useState([])
  const [textareaScrollTop, setTextareaScrollTop] = useState(0)
  const presenceThrottleRef = useRef(0)
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

      // Extract Yjs state + plain text atomically for persistence.
      // When ydocReady is false (legacy doc before no-peers/sync), fall back
      // to the React body state so a title-only save doesn't overwrite
      // the existing body with the still-empty Y.Doc content.
      const ydoc = ydocRef.current
      const ydocReady = ydoc && ydocReadyRef.current
      const bodyText = ydocReady ? ydoc.getText('content').toString() : body
      const yjsPayload = ydocReady ? fromUint8Array(Y.encodeStateAsUpdate(ydoc)) : undefined

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

  // ── Realtime: title + body-fallback sync via postgres_changes ─────────────
  // Title is synced here for all users.
  // Body/Yjs state is synced here as a reliable fallback for shared users who
  // may have missed incremental Yjs broadcast events (broadcast is at-most-once).
  // Y.applyUpdate is CRDT-idempotent: it is a no-op when the local doc already
  // contains all operations in newRow.yjs_state, so calling it on every owner
  // save is safe.
  useEffect(() => {
    if (!docId) return

    let destroyed = false
    let channel = null
    let retryTimer = null
    let retryCount = 0

    const rtChannelName = `doc-editor-rt-${docId}-${Math.random().toString(36).slice(2, 8)}`
    console.log('[DocEditor] [A] Subscribing postgres_changes channel:', rtChannelName, 'isViewOnly=', isViewOnly, 'sharePermission=', sharePermission)

    function handleUpdate({ new: newRow }) {
      if (destroyed) return
      console.log('[DocEditor] [B] postgres_changes UPDATE fired, yjs_state present=', !!newRow.yjs_state, 'title=', newRow.title)
      // ── Title sync ───────────────────────────────────────────────────
      if (isViewOnly) {
        if (newRow.title != null) { savedTitle.current = newRow.title; titleRef.current = newRow.title; setTitle(newRow.title) }
      } else {
        const titleDirty = titleRef.current !== savedTitle.current
        if (!titleDirty && newRow.title != null && newRow.title !== savedTitle.current) {
          savedTitle.current = newRow.title
          titleRef.current   = newRow.title
          setTitle(newRow.title)
        }
      }

      // ── Body/Yjs fallback sync (shared users only) ───────────────────
      if (isViewOnly || (!isViewOnly && sharePermission !== null)) {
        const ydoc = ydocRef.current
        console.log('[DocEditor] [C] Applying yjs_state fallback, ydoc present=', !!ydoc, 'yjs_state present=', !!newRow.yjs_state)
        if (ydoc && newRow.yjs_state) {
          try {
            Y.applyUpdate(ydoc, toUint8Array(newRow.yjs_state), 'remote')
            console.log('[DocEditor] [D] postgres_changes Yjs state applied OK')
          } catch (err) {
            console.error('[DocEditor] [D] postgres_changes Yjs applyUpdate FAILED:', err)
          }
        } else if (isViewOnly && newRow.body != null && newRow.body !== bodyRef.current) {
          console.log('[DocEditor] [C] Applying legacy body fallback (no yjs_state)')
          savedBody.current = newRow.body
          bodyRef.current   = newRow.body
          setBody(newRow.body)
        } else if (!ydoc) {
          console.warn('[DocEditor] [C] ydoc is null — cannot apply Yjs state from postgres_changes')
        }
      }
    }

    function subscribe() {
      channel = supabase
        .channel(rtChannelName)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'documents', filter: `id=eq.${docId}` },
          handleUpdate
        )
        .subscribe((status) => {
          console.log('[DocEditor] [A] postgres_changes channel status:', status, '— channel=', rtChannelName)
          if (destroyed) return
          if (status === 'SUBSCRIBED') {
            retryCount = 0
          } else if (status === 'CHANNEL_ERROR') {
            retryCount++
            const delay = Math.min(1000 * retryCount, 5000)
            console.warn('[DocEditor] postgres_changes CHANNEL_ERROR — will retry in', delay, 'ms (attempt', retryCount, ')')
            clearTimeout(retryTimer)
            retryTimer = setTimeout(() => {
              if (destroyed) return
              console.log('[DocEditor] Retrying postgres_changes subscription for', rtChannelName)
              supabase.removeChannel(channel)
              subscribe()
            }, delay)
          }
        })
    }

    subscribe()

    return () => {
      destroyed = true
      clearTimeout(retryTimer)
      if (channel) supabase.removeChannel(channel)
    }
  }, [docId, isViewOnly, sharePermission]) // eslint-disable-line react-hooks/exhaustive-deps

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
        ydocReadyRef.current = true
        console.log('[DocEditor] [D] Initialized Y.Doc from doc.yjs_state, text length=', ytext.toString().length)
      } catch (err) {
        console.error('[DocEditor] [D] Failed to init Y.Doc from doc.yjs_state:', err)
        // Corrupted state — leave empty; will be seeded via provider or no-peers
      }
    } else {
      console.log('[DocEditor] doc.yjs_state is null/undefined — will seed via broadcast provider')
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
      console.log('[DocEditor] [D] Yjs observer fired, origin=', transaction.origin, 'new text length=', text.length, 'changed=', text !== bodyRef.current)
      if (text === bodyRef.current) return

      // Remote-only update with no pending local body changes: mark as
      // already-persisted so the auto-save doesn't redundantly fire (which
      // would race with the owner's save and could revert the title).
      if (transaction.origin === 'remote' && bodyRef.current === savedBody.current) {
        savedBody.current = text
      }

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
      ydocReadyRef.current = false
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Broadcast provider (requires a persisted docId) ─────────────────────
  useEffect(() => {
    if (!docId || !ydocRef.current) return

    console.log('[DocEditor] [A] Creating BroadcastProvider for docId=', docId)
    const provider = new SupabaseBroadcastProvider(supabase, docId, ydocRef.current)
    providerRef.current = provider

    provider.on('synced', () => {
      // Peer state received — Y.Doc is now up to date from a remote peer
      console.log('[DocEditor] Provider emitted synced — applying Yjs text to React state')
      ydocReadyRef.current = true
      const ytext = ytextRef.current
      if (!ytext) return
      const text = ytext.toString()
      console.log('[DocEditor] [D] After synced, ytext length=', text.length, 'bodyRef=', bodyRef.current.length)
      if (text !== bodyRef.current) {
        savedBody.current = text
        bodyRef.current = text
        setBody(text)
      }
    })

    provider.on('no-peers', () => {
      // No other clients online — if Y.Doc is still empty (legacy doc with
      // no yjs_state), seed it from the plain-text body now.
      console.log('[DocEditor] Provider emitted no-peers')
      const ytext = ytextRef.current
      if (!ytext) return
      if (ytext.toString() === '' && doc?.body) {
        console.log('[DocEditor] Seeding Y.Doc from legacy doc.body')
        ytext.insert(0, doc.body)
        const text = ytext.toString()
        bodyRef.current = text
        setBody(text)
      }
      ydocReadyRef.current = true
    })

    provider.on('title-update', (remoteTitle) => {
      // Instant title sync from a peer — skip if the local user is actively
      // editing the title (dirty check).
      console.log('[DocEditor] Provider emitted title-update, remoteTitle=', remoteTitle)
      const titleDirty = titleRef.current !== savedTitle.current
      if (!titleDirty && remoteTitle != null && remoteTitle !== titleRef.current) {
        savedTitle.current = remoteTitle
        titleRef.current   = remoteTitle
        setTitle(remoteTitle)
      }
    })

    // ── Awareness: announce presence and listen for peers ──────────────
    const presenceName = displayName || userEmail || 'Anonymous'
    provider.setLocalPresence({ userId, name: presenceName, cursorIndex: 0, avatarUrl })

    const handleAwareness = () => {
      const clientId = ydocRef.current?.clientID
      const users = []
      for (const [cid, state] of provider.awareness) {
        if (cid !== clientId) users.push({ clientId: cid, ...state })
      }
      setRemoteUsers(users)
    }
    provider.on('awareness-change', handleAwareness)

    return () => {
      provider.off('awareness-change', handleAwareness)
      provider.destroy()
      providerRef.current = null
      setRemoteUsers([])
    }
  }, [docId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Re-broadcast presence when avatarUrl or displayName changes ────────
  useEffect(() => {
    const provider = providerRef.current
    if (!provider || !userId) return
    provider.setLocalPresence({
      userId,
      name: displayName || userEmail || 'Anonymous',
      cursorIndex: textareaRef.current?.selectionStart ?? 0,
      avatarUrl,
    })
  }, [avatarUrl, displayName]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Page unload safety net ──────────────────────────────────────────────
  useEffect(() => {
    const flushSave = async () => {
      const ydoc = ydocRef.current
      const currentDocId = docIdRef.current
      if (!currentDocId || !ydoc) return
      const currentTitle = titleRef.current
      const ydocReady = ydocReadyRef.current
      const currentBody = ydocReady ? ydoc.getText('content').toString() : bodyRef.current
      if (currentTitle === savedTitle.current && currentBody === savedBody.current) return
      const updatePayload = {
        title: currentTitle || 'Untitled',
        body: currentBody,
      }
      if (ydocReady) {
        updatePayload.yjs_state = fromUint8Array(Y.encodeStateAsUpdate(ydoc))
      }
      await supabase
        .from('documents')
        .update(updatePayload)
        .eq('id', currentDocId)
      savedTitle.current = currentTitle
      savedBody.current = currentBody
    }

    const handleVisChange = () => {
      if (document.visibilityState === 'hidden') flushSave()
    }
    const handleBeforeUnload = (e) => {
      providerRef.current?.sendLeave()
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

    // User is typing — Y.Doc now has intentional content
    ydocReadyRef.current = true
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

  // ── Title input → broadcast instantly ────────────────────────────────────
  function handleTitleChange(e) {
    const newTitle = e.target.value
    setTitle(newTitle)
    providerRef.current?.sendTitle(newTitle)
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

  // ── Broadcast cursor position (throttled) ─────────────────────────────
  function broadcastCursor() {
    const now = Date.now()
    if (now - presenceThrottleRef.current < 200) return
    presenceThrottleRef.current = now
    const provider = providerRef.current
    if (!provider || !userId) return
    const cursorIndex = textareaRef.current?.selectionStart ?? 0
    provider.setLocalPresence({
      userId,
      name: displayName || userEmail || 'Anonymous',
      cursorIndex,
      avatarUrl,
    })
  }

  function handleTextareaScroll(e) {
    setTextareaScrollTop(e.target.scrollTop)
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
            onChange={handleTitleChange}
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
        <PresenceBar users={remoteUsers} />
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
            <div className="doc-editor-textarea-wrapper">
              <textarea
                ref={textareaRef}
                className="doc-editor-textarea"
                placeholder="Write Markdown here…"
                value={body}
                onChange={handleBodyChange}
                onKeyDown={handleKeyDown}
                onSelect={broadcastCursor}
                onClick={broadcastCursor}
                onKeyUp={broadcastCursor}
                onScroll={handleTextareaScroll}
                spellCheck={false}
              />
              <CursorOverlay users={remoteUsers} body={body} scrollTop={textareaScrollTop} textareaEl={textareaRef.current} />
            </div>
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
