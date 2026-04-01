import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export function ProfileEditor({ userId, displayName, onSave, onCancel }) {
  const [fullName, setFullName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // rerender-dependencies: primitive string dep so field resets on open
  useEffect(() => {
    setFullName(displayName ?? '')
    setError(null)
  }, [displayName])

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setBusy(true)

    try {
      const { error: updateError } = await supabase
        .from('users')
        .update({ username: fullName.trim() })
        .eq('id', userId)

      if (updateError) throw updateError

      onSave(fullName.trim())
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="editor-overlay">
      <form className="editor-form" onSubmit={handleSubmit} noValidate>
        <h2>Profile</h2>

        <label className="field-label" htmlFor="profile-name">Full Name</label>
        <input
          id="profile-name"
          className="field-input"
          type="text"
          maxLength={100}
          value={fullName}
          onChange={e => setFullName(e.target.value)}
          autoFocus
        />

        {error && <p className="auth-error" role="alert">{error}</p>}

        <div className="editor-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}