import { useState } from 'react'
import { supabase } from '../lib/supabase'

// rerender-no-inline-components: ErrorMessage defined at module scope
function ErrorMessage({ message }) {
  if (!message) return null
  return <p className="auth-error" role="alert">{message}</p>
}

export function AuthForm() {
  const [mode, setMode] = useState('signin') // 'signin' | 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [successMsg, setSuccessMsg] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSuccessMsg(null)
    setBusy(true)

    try {
      if (mode === 'signup') {
        const { error: signUpError } = await supabase.auth.signUp({ email, password })
        if (signUpError) throw signUpError
        setSuccessMsg('Account created! Check your email to confirm, or sign in directly if email confirmations are disabled.')
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
        if (signInError) throw signInError
        // onAuthStateChange in useAuth() will update session automatically
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // rerender-move-effect-to-event: clear messages when toggling mode, not in an effect
  function toggleMode() {
    setMode(curr => curr === 'signin' ? 'signup' : 'signin')
    setError(null)
    setSuccessMsg(null)
  }

  return (
    <div className="auth-container">
      <h1 className="auth-title">Notes</h1>
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <h2>{mode === 'signin' ? 'Sign in' : 'Create account'}</h2>

        <label className="field-label" htmlFor="auth-email">Email</label>
        <input
          id="auth-email"
          className="field-input"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={e => setEmail(e.target.value)}
        />

        <label className="field-label" htmlFor="auth-password">Password</label>
        <input
          id="auth-password"
          className="field-input"
          type="password"
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          required
          minLength={6}
          value={password}
          onChange={e => setPassword(e.target.value)}
        />

        <ErrorMessage message={error} />

        {successMsg && <p className="auth-success">{successMsg}</p>}

        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <p className="auth-switch">
        {mode === 'signin' ? "Don't have an account?" : 'Already have an account?'}
        {' '}
        <button className="btn-link" onClick={toggleMode}>
          {mode === 'signin' ? 'Sign up' : 'Sign in'}
        </button>
      </p>
    </div>
  )
}
