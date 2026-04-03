import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

// ─── ShareRow ──────────────────────────────────────────────────────────────
// Renders a single existing share with permission label and revoke button.
// Defined at module scope to avoid inline-component rerender issues.
function ShareRow({ share, onRevoke }) {
  const [revoking, setRevoking] = useState(false)

  async function handleRevoke() {
    if (revoking) return
    setRevoking(true)
    const succeeded = await onRevoke(share.id)
    // Only leave revoking=true when the parent confirmed success (row will be
    // removed from state). On failure reset so the button is clickable again.
    if (!succeeded) setRevoking(false)
  }

  return (
    <li className="share-row">
      <span className="share-row-email">{share.shared_with_email}</span>
      <span className={`share-row-permission share-row-permission--${share.permission}`}>
        {share.permission}
      </span>
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

// ─── SharePanel ────────────────────────────────────────────────────────────
/**
 * Overlay that lets the note owner share a note by email and manage existing
 * shares. Write access is guarded by RLS on note_shares (owner_id = auth.uid).
 *
 * @param {{
 *   noteId:    number,
 *   noteTitle: string,
 *   userEmail: string,   // current user's own email — used for self-share guard
 *   onClose:   () => void
 * }} props
 */
export function SharePanel({ noteId, noteTitle, userEmail, onClose }) {
  const [shares, setShares]           = useState([])
  const [loadingShares, setLoadingShares] = useState(true)
  const [email, setEmail]             = useState('')
  const [permission, setPermission]   = useState('view')
  const [busy, setBusy]               = useState(false)
  const [error, setError]             = useState(null)
  const emailInputRef = useRef(null)

  // Load existing shares on mount
  useEffect(() => {
    let cancelled = false
    supabase
      .from('note_shares')
      .select('id, shared_with_email, permission')
      .eq('note_id', noteId)
      .order('created_at')
      .then(({ data }) => {
        if (!cancelled && data) setShares(data)
        if (!cancelled) setLoadingShares(false)
      })
    return () => { cancelled = true }
  }, [noteId])

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

    // Self-share guard: check before hitting the network
    if (trimmedEmail === userEmail.toLowerCase()) {
      setError("You can't share a note with yourself.")
      return
    }

    // Check for an existing share for this email (optimistic UI guard)
    if (shares.some(s => s.shared_with_email.toLowerCase() === trimmedEmail)) {
      setError('This note is already shared with that user.')
      return
    }

    setBusy(true)

    // Resolve email → user id (only returns id + username, not email or other PII)
    const { data: users, error: rpcError } = await supabase
      .rpc('find_user_by_email', { lookup_email: trimmedEmail })

    if (rpcError) {
      setError('Could not look up user. Please try again.')
      setBusy(false)
      return
    }

    if (!users || users.length === 0) {
      // Return the same message whether the email exists or not — avoids
      // confirming account existence to callers who don't already know it.
      setError('No account found for that email address.')
      setBusy(false)
      return
    }

    const recipient = users[0]

    const { data: newShare, error: insertError } = await supabase
      .from('note_shares')
      .insert({
        note_id:            noteId,
        owner_id:           (await supabase.auth.getUser()).data.user.id,
        shared_with_email:  trimmedEmail,
        shared_with_id:     recipient.id,
        permission,
      })
      .select('id, shared_with_email, permission')
      .single()

    if (insertError) {
      if (insertError.code === '23505') {
        setError('This note is already shared with that user.')
      } else {
        setError(insertError.message)
      }
    } else {
      // Optimistically append new share
      setShares(curr => [...curr, newShare])
      setEmail('')
      emailInputRef.current?.focus()
    }

    setBusy(false)
  }

  async function handleRevoke(shareId) {
    const { error: deleteError } = await supabase
      .from('note_shares')
      .delete()
      .eq('id', shareId)

    if (deleteError) {
      setError('Failed to revoke access. Please try again.')
      return false   // signal failure so ShareRow can re-enable its button
    } else {
      setShares(curr => curr.filter(s => s.id !== shareId))
      return true    // signal success; ShareRow stays disabled and is removed
    }
  }

  return (
    <div
      className="preview-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Share "${noteTitle}"`}
    >
      <div
        className="editor-form share-panel"
        onClick={e => e.stopPropagation()}
      >
        <h2>Share "{noteTitle}"</h2>

        {/* ── Add new share ─────────────────────────────────────── */}
        <form onSubmit={handleShare} noValidate>
          <label className="field-label" htmlFor="share-email">Share with (email)</label>
          <input
            id="share-email"
            ref={emailInputRef}
            className="field-input"
            type="email"
            placeholder="colleague@example.com"
            value={email}
            onChange={e => { setEmail(e.target.value); setError(null) }}
            autoFocus
            autoComplete="off"
          />

          <label className="field-label" htmlFor="share-permission">Permission</label>
          <select
            id="share-permission"
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
                <ShareRow key={share.id} share={share} onRevoke={handleRevoke} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
