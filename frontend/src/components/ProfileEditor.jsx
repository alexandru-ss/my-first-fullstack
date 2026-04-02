import { useEffect, useTransition, useState } from 'react'
import { supabase } from '../lib/supabase'

const MAX_FILE_BYTES = 2 * 1024 * 1024 // 2 MB

export function ProfileEditor({ userId, displayName, currentAvatarUrl, onSave, onAvatarSaved, onCancel }) {
  const [fullName, setFullName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Avatar upload state
  const [previewUrl, setPreviewUrl] = useState(null)
  const [uploadError, setUploadError] = useState(null)
  // rerender-usetransition-loading: useTransition instead of manual isUploading boolean
  const [isUploading, startTransition] = useTransition()

  // rerender-derived-state-no-effect: derive initials during render, not in state
  const initials = (displayName || '?').slice(0, 2).toUpperCase()

  // rerender-dependencies: primitive string dep so field resets on open
  useEffect(() => {
    setFullName(displayName ?? '')
    setError(null)
  }, [displayName])

  // rerender-move-effect-to-event: upload is triggered by user action — handle
  // it entirely in the event handler, never in a useEffect.
  function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (!file) return

    // Validate before touching the network — never after
    if (!file.type.startsWith('image/')) {
      setUploadError('File must be an image (JPEG, PNG, WebP, etc.)')
      return
    }
    if (file.size > MAX_FILE_BYTES) {
      setUploadError('File must be under 2 MB')
      return
    }

    setUploadError(null)
    // Show local preview immediately — no waiting on Storage
    setPreviewUrl(URL.createObjectURL(file))

    startTransition(async () => {
      // Path is always <userId>/avatar.png — fixed per user so upsert overwrites
      const path = `${userId}/avatar.png`

      const { error: storageError } = await supabase.storage
        .from('avatars')
        .upload(path, file, { upsert: true })

      if (storageError) {
        setPreviewUrl(null) // revert local preview
        setUploadError(storageError.message)
        return
      }

      // Store only the path — never the signed URL — in the database
      const { error: dbError } = await supabase
        .from('users')
        .update({ avatar_path: path })
        .eq('id', userId)

      if (dbError) {
        setPreviewUrl(null)
        setUploadError(dbError.message)
        return
      }

      // Notify App.jsx — it will regenerate the signed URL via its effect
      onAvatarSaved(path)
    })
  }

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

  const displayedAvatar = previewUrl ?? currentAvatarUrl

  return (
    <div className="editor-overlay">
      <form className="editor-form" onSubmit={handleSubmit} noValidate>
        <h2>Profile</h2>

        {/* ── Avatar ── */}
        <div className="avatar-upload-wrapper">
          <div className="avatar-upload-area">
            <div className="avatar-circle avatar-circle--lg">
              {isUploading && (
                <div className="avatar-spinner-overlay" aria-hidden="true">
                  <span className="spinner" />
                </div>
              )}
              {displayedAvatar
                ? <img src={displayedAvatar} alt="Profile picture" />
                : <span className="avatar-initials">{initials}</span>}
            </div>
            <label
              className="avatar-camera-btn"
              aria-label="Upload profile picture"
              title="Upload profile picture"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                <circle cx="12" cy="13" r="4"/>
              </svg>
              <input
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                disabled={isUploading}
                style={{ display: 'none' }}
              />
            </label>
          </div>
          {uploadError && <p className="auth-error" role="alert">{uploadError}</p>}
        </div>

        {/* ── Display name ── */}
        <label className="field-label" htmlFor="profile-name">Display name</label>
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
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy || isUploading}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || isUploading}>
            {busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}