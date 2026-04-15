import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

// ─── ShareRow ──────────────────────────────────────────────────────────────
// Renders a single existing share with permission selector and revoke button.
// Defined at module scope to avoid inline-component rerender issues.
function ShareRow({ share, onPermissionChange, onRevoke }) {
  const [revoking, setRevoking] = useState(false)

  async function handleRevoke() {
    if (revoking) return
    setRevoking(true)
    const succeeded = await onRevoke(share.id)
    if (!succeeded) setRevoking(false)
  }

  return (
    <li className="share-row">
      <span className="share-row-email">{share.shared_with_email}</span>
      <select
        className="share-row-permission-select"
        value={share.permission}
        onChange={e => onPermissionChange(share.id, e.target.value)}
        aria-label={`Permission for ${share.shared_with_email}`}
      >
        <option value="view">View only</option>
        <option value="edit">Can edit</option>
      </select>
      <button
        type="button"
        className="btn-danger share-row-revoke"
        onClick={handleRevoke}
        disabled={revoking}
        aria-label={`Revoke access for ${share.shared_with_email}`}
      >
        {revoking ? '…' : 'Revoke'}
      </button>
    </li>
  )
}

// ─── DocumentSharePanel ────────────────────────────────────────────────────
/**
 * Overlay that lets the document owner share a document by email and manage
 * existing shares. Write access is guarded by RLS on document_shares.
 *
 * @param {{
 *   documentId:    number,
 *   documentTitle: string,
 *   userEmail:     string,
 *   onClose:       () => void
 * }} props
 */
export function DocumentSharePanel({ documentId, documentTitle, userEmail, onClose }) {
  const [shares, setShares]               = useState([])
  const [loadingShares, setLoadingShares] = useState(true)
  const [email, setEmail]                 = useState('')
  const [permission, setPermission]       = useState('view')
  const [busy, setBusy]                   = useState(false)
  const [error, setError]                 = useState(null)
  const emailInputRef = useRef(null)

  // Load existing shares on mount
  useEffect(() => {
    let cancelled = false
    supabase
      .from('document_shares')
      .select('id, shared_with_email, permission')
      .eq('document_id', documentId)
      .order('created_at')
      .then(({ data }) => {
        if (!cancelled && data) setShares(data)
        if (!cancelled) setLoadingShares(false)
      })
    return () => { cancelled = true }
  }, [documentId])

  // Realtime: keep share list in sync across tabs / devices
  useEffect(() => {
    const channel = supabase
      .channel(`doc-share-panel-${documentId}-${Math.random().toString(36).slice(2, 8)}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'document_shares',
          filter: `document_id=eq.${documentId}`,
        },
        ({ eventType, new: newRow, old: oldRow }) => {
          if (eventType === 'INSERT') {
            setShares(curr => {
              if (curr.some(s => s.id === newRow.id)) return curr
              return [...curr, {
                id:                newRow.id,
                shared_with_email: newRow.shared_with_email,
                permission:        newRow.permission,
              }]
            })
          } else if (eventType === 'UPDATE') {
            setShares(curr =>
              curr.map(s => s.id === newRow.id
                ? { ...s, permission: newRow.permission }
                : s
              )
            )
          } else if (eventType === 'DELETE') {
            setShares(curr => curr.filter(s => s.id !== oldRow.id))
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [documentId])

  // Close on Escape
  useEffect(() => {
    function handleKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  async function handleShare(e) {
    e.preventDefault()
    setError(null)

    const trimmedEmail = email.trim().toLowerCase()
    if (!trimmedEmail) return

    if (trimmedEmail === userEmail.toLowerCase()) {
      setError("You can't share a document with yourself.")
      return
    }

    if (shares.some(s => s.shared_with_email.toLowerCase() === trimmedEmail)) {
      setError('This document is already shared with that user.')
      return
    }

    setBusy(true)

    const { data: users, error: rpcError } = await supabase
      .rpc('find_user_by_email', { lookup_email: trimmedEmail })

    if (rpcError) {
      setError('Could not look up user. Please try again.')
      setBusy(false)
      return
    }

    if (!users || users.length === 0) {
      setError('No account found for that email address.')
      setBusy(false)
      return
    }

    const recipient = users[0]

    const { data: newShare, error: insertError } = await supabase
      .from('document_shares')
      .insert({
        document_id:        documentId,
        owner_id:           (await supabase.auth.getUser()).data.user.id,
        shared_with_email:  trimmedEmail,
        shared_with_id:     recipient.id,
        permission,
      })
      .select('id, shared_with_email, permission')
      .single()

    if (insertError) {
      if (insertError.code === '23505') {
        setError('This document is already shared with that user.')
      } else {
        setError(insertError.message)
      }
    } else {
      setShares(curr => [...curr, newShare])
      setEmail('')
      emailInputRef.current?.focus()
    }

    setBusy(false)
  }

  async function handlePermissionChange(shareId, newPermission) {
    const { error: updateError } = await supabase
      .from('document_shares')
      .update({ permission: newPermission })
      .eq('id', shareId)

    if (updateError) {
      setError('Failed to update permission. Please try again.')
    } else {
      setShares(curr =>
        curr.map(s => s.id === shareId ? { ...s, permission: newPermission } : s)
      )
    }
  }

  async function handleRevoke(shareId) {
    const { error: deleteError } = await supabase
      .from('document_shares')
      .delete()
      .eq('id', shareId)

    if (deleteError) {
      setError('Failed to revoke access. Please try again.')
      return false
    } else {
      setShares(curr => curr.filter(s => s.id !== shareId))
      return true
    }
  }

  return (
    <div
      className="preview-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Share "${documentTitle}"`}
    >
      <div
        className="editor-form share-panel"
        onClick={e => e.stopPropagation()}
      >
        <h2>Share &ldquo;{documentTitle}&rdquo;</h2>

        {/* ── Add new share ─────────────────────────────────────── */}
        <form onSubmit={handleShare} noValidate>
          <label className="field-label" htmlFor="doc-share-email">Share with (email)</label>
          <input
            id="doc-share-email"
            ref={emailInputRef}
            className="field-input"
            type="email"
            placeholder="colleague@example.com"
            value={email}
            onChange={e => { setEmail(e.target.value); setError(null) }}
            autoFocus
            autoComplete="off"
          />

          <label className="field-label" htmlFor="doc-share-permission">Permission</label>
          <select
            id="doc-share-permission"
            className="field-input"
            value={permission}
            onChange={e => setPermission(e.target.value)}
          >
            <option value="view">View only</option>
            <option value="edit">Can edit</option>
          </select>

          {error && <p className="auth-error" role="alert">{error}</p>}

          <div className="editor-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
              disabled={busy}
            >
              Close
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={busy || !email.trim()}
            >
              {busy ? 'Sharing…' : 'Share'}
            </button>
          </div>
        </form>

        {/* ── Existing shares ───────────────────────────────────── */}
        <div className="share-existing">
          <h3 className="share-existing-heading">Shared with</h3>
          {loadingShares ? (
            <p className="notes-status">Loading…</p>
          ) : shares.length === 0 ? (
            <p className="notes-status">Not shared with anyone yet.</p>
          ) : (
            <ul className="share-list">
              {shares.map(share => (
                <ShareRow
                  key={share.id}
                  share={share}
                  onPermissionChange={handlePermissionChange}
                  onRevoke={handleRevoke}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
